// Validated, snapshot-bound fetch client for GET /api/agent-index. It follows every authenticated
// owner page before reporting complete, while preserving proven rows as partial when a later page
// fails. It performs no on-chain reads and never substitutes browser/RPC hints.
import {
  AGENT_CREATOR_MANIFEST_HASH,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_INDEX_FINALITY_LEDGERS,
} from './agentCreatorManifest.js'

const AGENT_INDEX_PATH = '/api/agent-index'
const LEGACY_DEFAULT_READ_LIMIT = 200
const MAX_SERVER_PAGE_SIZE = 500
const MAX_CANONICAL_DEPTH = 64
const MAX_CANONICAL_NODES_PER_PAGE = 20_000
const MAX_CANONICAL_CHARS_PER_PAGE = 2_000_000
const NULL_HINTS = {
  localCacheCount: null,
  rpcEventCount: null,
  registryCount: null,
  vaultVerifiedCount: null,
  unverifiedCandidateCount: null,
}

function result(status, networkId, owner, agents, coverage) {
  return {
    status,
    networkId: networkId ?? null,
    owner: owner ?? null,
    agents,
    coverage,
    hints: { ...NULL_HINTS },
  }
}

function unavailableResult(networkId, owner) {
  return result('unavailable', networkId, owner, [], null)
}

function interruptedResult({ networkId, owner, agents, coverage, acceptedPages }) {
  return acceptedPages > 0
    ? result('partial', networkId, owner, agents, coverage)
    : unavailableResult(networkId, owner)
}

function strictJsonRecord(value, requiredKeys, optionalKeys = []) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const required = new Set(requiredKeys)
    const allowed = new Set([...requiredKeys, ...optionalKeys])
    const fields = Object.create(null)
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      fields[key] = descriptor.value
      required.delete(key)
    }
    return required.size === 0 ? fields : null
  } catch {
    return null
  }
}

function parseResponseEnvelope(body, owner, networkId) {
  const fields = strictJsonRecord(
    body,
    ['version', 'networkId', 'owner', 'status', 'agents', 'coverage'],
    ['pagination']
  )
  if (
    !fields ||
    fields.version !== 1 ||
    fields.networkId !== networkId ||
    fields.owner !== owner ||
    (fields.status !== 'complete' && fields.status !== 'partial') ||
    !Array.isArray(fields.agents) ||
    !fields.coverage ||
    typeof fields.coverage !== 'object' ||
    Array.isArray(fields.coverage)
  ) {
    return null
  }
  return {
    status: fields.status,
    agents: fields.agents,
    coverage: fields.coverage,
    paginationPresent: Object.hasOwn(fields, 'pagination'),
    pagination: fields.pagination,
  }
}

function manifestIsTrusted(coverage) {
  return (
    coverage.manifestHash === AGENT_CREATOR_MANIFEST_HASH &&
    coverage.manifestVersion === AGENT_CREATOR_MANIFEST_VERSION &&
    coverage.schemaVersion === AGENT_INDEX_SCHEMA_VERSION &&
    Number.isSafeInteger(coverage.requiredFinalityLedgers) &&
    coverage.requiredFinalityLedgers >= AGENT_INDEX_FINALITY_LEDGERS
  )
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function coverageIsTrusted(coverage) {
  const { indexedFromLedger, finalizedThroughLedger, indexedThroughLedger } = coverage
  return (
    coverage.contiguous === true &&
    Array.isArray(coverage.gaps) &&
    coverage.gaps.length === 0 &&
    coverage.historicalBackfill === 'verified' &&
    isNonNegativeSafeInteger(indexedFromLedger) &&
    isNonNegativeSafeInteger(finalizedThroughLedger) &&
    isNonNegativeSafeInteger(indexedThroughLedger) &&
    indexedFromLedger <= finalizedThroughLedger &&
    finalizedThroughLedger <= indexedThroughLedger
  )
}

function canonicalBudget(observer) {
  return { nodes: 0, chars: 0, observer: typeof observer === 'function' ? observer : null }
}

function reserveCanonicalNodes(budget, count) {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > MAX_CANONICAL_NODES_PER_PAGE - budget.nodes
  ) {
    return false
  }
  budget.nodes += count
  return true
}

function denseDataArrayLength(value, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength) return null
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) return null
  for (const key of ownKeys) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)) return null
    const index = Number(key)
    if (index >= value.length) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
  }
  return value.length
}

function reserveObjectKeys(value, budget, { omitRootKey, root }) {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null

  let childCount = 0
  let projectedKeyChars = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    if (root && key === omitRootKey) continue
    childCount += 1
    projectedKeyChars += key.length
    if (
      childCount > MAX_CANONICAL_NODES_PER_PAGE - budget.nodes ||
      projectedKeyChars > MAX_CANONICAL_CHARS_PER_PAGE - budget.chars
    ) {
      return null
    }
  }
  if (!reserveCanonicalNodes(budget, childCount)) return null

  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) return null
  const keys = ownKeys.filter((key) => !(root && key === omitRootKey))
  if (keys.length !== childCount) return null
  return keys.sort()
}

function boundedCanonicalJson(root, budget, { omitRootKey } = {}) {
  const parts = []
  const seen = new WeakSet()
  if (!reserveCanonicalNodes(budget, 1)) return null
  const frames = [{ type: 'value', value: root, depth: 0, root: true }]

  const append = (part) => {
    if (typeof part !== 'string' || part.length > MAX_CANONICAL_CHARS_PER_PAGE - budget.chars) {
      throw new Error('canonical JSON too large')
    }
    budget.chars += part.length
    parts.push(part)
  }

  try {
    while (frames.length > 0) {
      budget.observer?.({
        pendingFrames: frames.length,
        reservedNodes: budget.nodes,
        canonicalChars: budget.chars,
      })
      const frame = frames.at(-1)

      if (frame.type === 'array') {
        if (frame.index === frame.length) {
          append(']')
          frames.pop()
          continue
        }
        if (frame.index > 0) append(',')
        const descriptor = Object.getOwnPropertyDescriptor(frame.value, String(frame.index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
        frame.index += 1
        frames.push({ type: 'value', value: descriptor.value, depth: frame.depth + 1 })
        continue
      }

      if (frame.type === 'object') {
        if (frame.index === frame.keys.length) {
          append('}')
          frames.pop()
          continue
        }
        if (frame.index > 0) append(',')
        const key = frame.keys[frame.index]
        const descriptor = Object.getOwnPropertyDescriptor(frame.value, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
        append(JSON.stringify(key))
        append(':')
        frame.index += 1
        frames.push({ type: 'value', value: descriptor.value, depth: frame.depth + 1 })
        continue
      }

      frames.pop()
      if (frame.depth > MAX_CANONICAL_DEPTH) return null
      const value = frame.value
      if (value === null) {
        append('null')
      } else if (typeof value === 'string' || typeof value === 'boolean') {
        append(JSON.stringify(value))
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null
        append(JSON.stringify(value))
      } else {
        if (typeof value !== 'object' || seen.has(value)) return null
        seen.add(value)
        if (Array.isArray(value)) {
          if (!reserveCanonicalNodes(budget, value.length)) return null
          const length = denseDataArrayLength(value, value.length)
          if (length === null) return null
          append('[')
          frames.push({ type: 'array', value, index: 0, length, depth: frame.depth })
        } else {
          const keys = reserveObjectKeys(value, budget, {
            omitRootKey,
            root: frame.root === true,
          })
          if (keys === null) return null
          append('{')
          frames.push({ type: 'object', value, keys, index: 0, depth: frame.depth })
        }
      }
    }
    return parts.join('')
  } catch {
    return null
  }
}

function coverageIdentity(coverage, budget) {
  // checkedAt is the time of each independent HTTP read, not coverage evidence. The remaining
  // fields must stay identical throughout one snapshot traversal.
  try {
    const checkedAt = Object.getOwnPropertyDescriptor(coverage, 'checkedAt')
    if (
      !checkedAt?.enumerable ||
      !Object.hasOwn(checkedAt, 'value') ||
      !isNonNegativeSafeInteger(checkedAt.value)
    ) {
      return null
    }
    return boundedCanonicalJson(coverage, budget, { omitRootKey: 'checkedAt' })
  } catch {
    return null
  }
}

function parsePagination(pagination) {
  const fields = strictJsonRecord(pagination, [
    'hasMore',
    'nextCursor',
    'snapshotThroughLedger',
    'coverageStatus',
  ])
  if (!fields) return null
  const { hasMore, nextCursor, snapshotThroughLedger, coverageStatus } = fields
  if (
    typeof hasMore !== 'boolean' ||
    !Number.isSafeInteger(snapshotThroughLedger) ||
    snapshotThroughLedger < 0 ||
    !['complete', 'partial', 'unavailable'].includes(coverageStatus) ||
    (hasMore && (typeof nextCursor !== 'string' || !nextCursor)) ||
    (!hasMore && nextCursor !== null)
  ) {
    return null
  }
  return { hasMore, nextCursor, snapshotThroughLedger, coverageStatus }
}

function preparePage(metadataByAddress, pageAgents, budget) {
  try {
    const length = denseDataArrayLength(pageAgents, MAX_SERVER_PAGE_SIZE)
    if (length === null) return null
    const additions = []
    const pageMetadata = new Map()
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(pageAgents, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      const rawAgent = descriptor.value
      if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) return null
      const metadata = boundedCanonicalJson(rawAgent, budget)
      if (metadata === null) return null
      const agent = { ...rawAgent }
      if (typeof agent.address !== 'string' || !agent.address) return null
      const prior = pageMetadata.get(agent.address) ?? metadataByAddress.get(agent.address)
      if (prior !== undefined) {
        if (prior !== metadata) return null
        continue
      }
      pageMetadata.set(agent.address, metadata)
      additions.push(agent)
    }
    return { additions, pageMetadata }
  } catch {
    return null
  }
}

function acceptPage(agents, metadataByAddress, prepared) {
  agents.push(...prepared.additions)
  for (const [address, metadata] of prepared.pageMetadata) {
    metadataByAddress.set(address, metadata)
  }
}

/**
 * Enumerates `GET /api/agent-index?network=<networkId>&owner=<owner>` from page one through the
 * terminal snapshot page. `hints` remains null-filled because ownerDiscovery.js supplies the real
 * browser/RPC hint counts.
 * @param {{owner:string, networkId?:string, limit?:number, fetchImpl?:Function, apiBase?:string,
 *   signal?:AbortSignal}} p
 * @returns {Promise<{status:'complete'|'partial'|'unavailable', networkId:string, owner:string,
 *   agents:Array, coverage:object|null, hints:object}>}
 */
export async function fetchOwnerAgentIndex({
  owner,
  networkId = 'stellar-testnet',
  limit,
  fetchImpl = fetch,
  apiBase = '',
  signal,
  __testCanonicalSchedulerObserver,
} = {}) {
  if (!owner || !networkId) return unavailableResult(networkId, owner)

  let agents = []
  let metadataByAddress = new Map()
  let acceptedPages = 0
  let lastCoverage = null
  let expectedSnapshot = null
  let expectedCoverageIdentity = null
  let expectedCoverageStatus = null
  let cursor = null
  let canComplete = true
  const seenCursors = new Set()

  const interrupted = () =>
    interruptedResult({ networkId, owner, agents, coverage: lastCoverage, acceptedPages })

  while (true) {
    if (signal?.aborted) return interrupted()

    const params = new URLSearchParams({ network: networkId, owner })
    if (limit != null) params.set('limit', String(limit))
    if (cursor !== null) params.set('cursor', cursor)

    let response
    try {
      response = await fetchImpl(`${apiBase}${AGENT_INDEX_PATH}?${params.toString()}`, { signal })
    } catch {
      return interrupted()
    }
    if (signal?.aborted) return interrupted()
    if (!response?.ok) return interrupted()

    let body
    try {
      body = await response.json()
    } catch {
      return interrupted()
    }
    if (signal?.aborted) return interrupted()
    try {
      const envelope = parseResponseEnvelope(body, owner, networkId)
      if (!envelope) return interrupted()
      const { coverage, agents: pageAgents, paginationPresent } = envelope
      const budget = canonicalBudget(__testCanonicalSchedulerObserver)
      const pageCoverageIdentity = coverageIdentity(coverage, budget)
      if (pageCoverageIdentity === null) return interrupted()
      const pagination = paginationPresent ? parsePagination(envelope.pagination) : null
      if (paginationPresent && !pagination) return interrupted()

      // Legacy envelopes are accepted only as first-page terminal responses. A complete legacy
      // page at its request cap could be truncated, so it is never preserved as complete.
      if (!paginationPresent) {
        if (acceptedPages > 0 || cursor !== null) return interrupted()
        const prepared = preparePage(metadataByAddress, pageAgents, budget)
        if (!prepared) return interrupted()
        acceptPage(agents, metadataByAddress, prepared)
        acceptedPages = 1
        lastCoverage = coverage
        const legacyLimit = Number.isInteger(limit) && limit > 0 ? limit : LEGACY_DEFAULT_READ_LIMIT
        const safelyTerminal = pageAgents.length < legacyLimit
        const status =
          envelope.status === 'complete' &&
          safelyTerminal &&
          manifestIsTrusted(coverage) &&
          coverageIsTrusted(coverage)
            ? 'complete'
            : 'partial'
        return result(status, networkId, owner, agents, lastCoverage)
      }

      if (
        acceptedPages > 0 &&
        (pagination.snapshotThroughLedger !== expectedSnapshot ||
          pageCoverageIdentity !== expectedCoverageIdentity ||
          pagination.coverageStatus !== expectedCoverageStatus)
      ) {
        return interrupted()
      }
      if (
        pagination.coverageStatus === 'complete' &&
        pagination.snapshotThroughLedger !== coverage.finalizedThroughLedger
      ) {
        return interrupted()
      }

      const prepared = preparePage(metadataByAddress, pageAgents, budget)
      if (!prepared) return interrupted()
      acceptPage(agents, metadataByAddress, prepared)
      acceptedPages += 1
      lastCoverage = coverage

      if (acceptedPages === 1) {
        expectedSnapshot = pagination.snapshotThroughLedger
        expectedCoverageIdentity = pageCoverageIdentity
        expectedCoverageStatus = pagination.coverageStatus
      }
      canComplete = canComplete && manifestIsTrusted(coverage) && coverageIsTrusted(coverage)

      if (!pagination.hasMore) {
        const status =
          canComplete && pagination.coverageStatus === 'complete' ? 'complete' : 'partial'
        return result(status, networkId, owner, agents, lastCoverage)
      }

      if (seenCursors.has(pagination.nextCursor)) return interrupted()
      seenCursors.add(pagination.nextCursor)
      cursor = pagination.nextCursor
    } catch {
      return interrupted()
    }
  }
}
