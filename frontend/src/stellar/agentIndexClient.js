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

function isRecognizedBody(body, owner, networkId) {
  return (
    body &&
    body.version === 1 &&
    body.networkId === networkId &&
    body.owner === owner &&
    (body.status === 'complete' || body.status === 'partial') &&
    Array.isArray(body.agents) &&
    body.coverage &&
    typeof body.coverage === 'object' &&
    !Array.isArray(body.coverage)
  )
}

function manifestIsTrusted(coverage) {
  return (
    coverage.manifestHash === AGENT_CREATOR_MANIFEST_HASH &&
    coverage.manifestVersion === AGENT_CREATOR_MANIFEST_VERSION &&
    coverage.schemaVersion === AGENT_INDEX_SCHEMA_VERSION &&
    Number.isInteger(coverage.requiredFinalityLedgers) &&
    coverage.requiredFinalityLedgers >= AGENT_INDEX_FINALITY_LEDGERS
  )
}

function coverageIsTrusted(coverage) {
  return (
    coverage.contiguous === true &&
    Array.isArray(coverage.gaps) &&
    coverage.gaps.length === 0 &&
    coverage.historicalBackfill === 'verified' &&
    coverage.indexedThroughLedger != null
  )
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`
}

function coverageIdentity(coverage) {
  // checkedAt is the time of each independent HTTP read, not coverage evidence. The remaining
  // fields must stay identical throughout one snapshot traversal.
  const { checkedAt: _checkedAt, ...identity } = coverage
  return stableJson(identity)
}

function parsePagination(pagination) {
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) return null
  const { hasMore, nextCursor, snapshotThroughLedger, coverageStatus } = pagination
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

function preparePage(metadataByAddress, pageAgents) {
  const additions = []
  const pageMetadata = new Map()
  for (const rawAgent of pageAgents) {
    if (!rawAgent || typeof rawAgent.address !== 'string' || !rawAgent.address) return null
    const agent = { ...rawAgent }
    const metadata = stableJson(agent)
    const prior = pageMetadata.get(agent.address) ?? metadataByAddress.get(agent.address)
    if (prior !== undefined) {
      if (prior !== metadata) return null
      continue
    }
    pageMetadata.set(agent.address, metadata)
    additions.push(agent)
  }
  return { additions, pageMetadata }
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
    if (!response?.ok) return interrupted()

    let body
    try {
      body = await response.json()
    } catch {
      return interrupted()
    }
    if (!isRecognizedBody(body, owner, networkId)) return interrupted()

    const pageCoverageIdentity = coverageIdentity(body.coverage)
    const paginationPresent = Object.hasOwn(body, 'pagination')
    const pagination = paginationPresent ? parsePagination(body.pagination) : null
    if (paginationPresent && !pagination) return interrupted()

    // Legacy envelopes are accepted only as first-page terminal responses. A complete legacy page
    // at its request cap could be truncated, so it is never upgraded or preserved as complete.
    if (!paginationPresent) {
      if (acceptedPages > 0 || cursor !== null) return interrupted()
      const prepared = preparePage(metadataByAddress, body.agents)
      if (!prepared) return interrupted()
      acceptPage(agents, metadataByAddress, prepared)
      acceptedPages = 1
      lastCoverage = body.coverage
      const legacyLimit = Number.isInteger(limit) && limit > 0 ? limit : LEGACY_DEFAULT_READ_LIMIT
      const safelyTerminal = body.agents.length < legacyLimit
      const status =
        body.status === 'complete' &&
        safelyTerminal &&
        manifestIsTrusted(body.coverage) &&
        coverageIsTrusted(body.coverage)
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
      pagination.snapshotThroughLedger !== body.coverage.finalizedThroughLedger
    ) {
      return interrupted()
    }

    const prepared = preparePage(metadataByAddress, body.agents)
    if (!prepared) return interrupted()
    acceptPage(agents, metadataByAddress, prepared)
    acceptedPages += 1
    lastCoverage = body.coverage

    if (acceptedPages === 1) {
      expectedSnapshot = pagination.snapshotThroughLedger
      expectedCoverageIdentity = pageCoverageIdentity
      expectedCoverageStatus = pagination.coverageStatus
    }
    canComplete =
      canComplete && manifestIsTrusted(body.coverage) && coverageIsTrusted(body.coverage)

    if (!pagination.hasMore) {
      const status =
        canComplete && pagination.coverageStatus === 'complete' ? 'complete' : 'partial'
      return result(status, networkId, owner, agents, lastCoverage)
    }

    if (seenCursors.has(pagination.nextCursor)) return interrupted()
    seenCursors.add(pagination.nextCursor)
    cursor = pagination.nextCursor
  }
}
