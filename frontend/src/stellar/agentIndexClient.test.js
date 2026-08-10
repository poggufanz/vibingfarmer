import { describe, it, expect, vi } from 'vitest'
import { fetchOwnerAgentIndex } from './agentIndexClient.js'
import {
  AGENT_CREATOR_MANIFEST_HASH,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_INDEX_FINALITY_LEDGERS,
} from './agentCreatorManifest.js'

const OWNER = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY'
const NETWORK = 'stellar-testnet'

function goodCoverage(overrides = {}) {
  return {
    manifestVersion: AGENT_CREATOR_MANIFEST_VERSION,
    manifestHash: AGENT_CREATOR_MANIFEST_HASH,
    schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
    indexedFromLedger: 1,
    indexedThroughLedger: 100,
    finalizedThroughLedger: 98,
    contiguous: true,
    gaps: [],
    historicalBackfill: 'verified',
    requiredFinalityLedgers: AGENT_INDEX_FINALITY_LEDGERS,
    checkedAt: 123,
    ...overrides,
  }
}

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({ ok, status, json: async () => body }))
}

function indexedAgent(ordinal, overrides = {}) {
  return {
    address: `CAGENT${String(ordinal).padStart(4, '0')}`,
    kind: 'deposit',
    creator: 'CCREATOR',
    createdLedger: ordinal,
    createdTxHash: `tx-${ordinal}`,
    runId: `run-${ordinal}`,
    runOrdinal: ordinal - 1,
    grantTxHash: `grant-${ordinal}`,
    association: 'unknown',
    baseChildren: [],
    ...overrides,
  }
}

function pagedBody({
  agents,
  hasMore,
  nextCursor = hasMore ? 'next-page' : null,
  snapshotThroughLedger = 98,
  coverageStatus = 'complete',
  owner = OWNER,
  networkId = NETWORK,
  coverage = goodCoverage(),
}) {
  return {
    version: 1,
    networkId,
    owner,
    status: 'partial',
    agents,
    coverage,
    pagination: { hasMore, nextCursor, snapshotThroughLedger, coverageStatus },
  }
}

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

function cursorFrom(url) {
  return new URL(url, 'https://vf.invalid').searchParams.get('cursor')
}

function deeplyNestedJson(depth) {
  const root = {}
  let node = root
  for (let index = 0; index < depth; index += 1) {
    node.child = {}
    node = node.child
  }
  return root
}

function nestedWideJson(depth, width) {
  let child = 0
  for (let level = 0; level < depth; level += 1) {
    const parent = Array(width).fill(0)
    parent[0] = child
    child = parent
  }
  return child
}

function bodyWithThrowingOwner() {
  const body = pagedBody({ agents: [indexedAgent(2)], hasMore: false })
  Object.defineProperty(body, 'owner', {
    enumerable: true,
    get() {
      throw new Error('body owner accessor must not run')
    },
  })
  return body
}

function bodyWithThrowingPagination() {
  const body = pagedBody({ agents: [indexedAgent(2)], hasMore: false })
  Object.defineProperty(body.pagination, 'hasMore', {
    enumerable: true,
    get() {
      throw new Error('pagination accessor must not run')
    },
  })
  return body
}

function bodyWithThrowingAgentIterator() {
  const body = pagedBody({ agents: [indexedAgent(2)], hasMore: false })
  body.agents[Symbol.iterator] = () => ({
    next() {
      throw new Error('agents iterator must not run')
    },
  })
  return body
}

function legacyCompleteBody(coverage) {
  return {
    version: 1,
    networkId: NETWORK,
    owner: OWNER,
    status: 'complete',
    agents: [indexedAgent(1)],
    coverage,
  }
}

describe('fetchOwnerAgentIndex', () => {
  it('enumerates a literal 201-row snapshot in exact page order before returning complete', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => indexedAgent(index + 1))
    const terminalPage = [indexedAgent(201)]
    const signal = new AbortController().signal
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init).toEqual({ signal })
      const cursor = cursorFrom(url)
      if (cursor === null)
        return response(pagedBody({ agents: firstPage, hasMore: true, nextCursor: 'cursor-201' }))
      if (cursor === 'cursor-201')
        return response(pagedBody({ agents: terminalPage, hasMore: false }))
      throw new Error(`unexpected cursor ${cursor}`)
    })

    const res = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl,
      signal,
    })

    expect(res.status).toBe('complete')
    expect(res.agents).toHaveLength(201)
    expect(res.agents.map((agent) => agent.address)).toEqual(
      Array.from({ length: 201 }, (_, index) => `CAGENT${String(index + 1).padStart(4, '0')}`)
    )
  })

  it('allows per-request checkedAt timestamps to change without changing coverage identity', async () => {
    const fetchImpl = vi.fn(async (url) =>
      response(
        cursorFrom(url) === null
          ? pagedBody({
              agents: [indexedAgent(1)],
              hasMore: true,
              nextCursor: 'fresh-check-time',
              coverage: goodCoverage({ checkedAt: 123 }),
            })
          : pagedBody({
              agents: [indexedAgent(2)],
              hasMore: false,
              coverage: goodCoverage({ checkedAt: 124 }),
            })
      )
    )

    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    expect(res.status).toBe('complete')
    expect(res.agents.map((agent) => agent.address)).toEqual(['CAGENT0001', 'CAGENT0002'])
  })

  it('enumerates a literal 501-row snapshot and exact-string-dedupes a replayed row', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => indexedAgent(index + 1))
    const replayedBoundary = { ...firstPage[499], baseChildren: [] }
    const fetchImpl = vi.fn(async (url) => {
      const cursor = cursorFrom(url)
      if (cursor === null)
        return response(pagedBody({ agents: firstPage, hasMore: true, nextCursor: 'cursor-501' }))
      if (cursor === 'cursor-501')
        return response(
          pagedBody({ agents: [replayedBoundary, indexedAgent(501)], hasMore: false })
        )
      throw new Error(`unexpected cursor ${cursor}`)
    })

    const res = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      limit: 500,
      fetchImpl,
    })

    expect(res.status).toBe('complete')
    expect(res.agents).toHaveLength(501)
    expect(res.agents[0].address).toBe('CAGENT0001')
    expect(res.agents[499].address).toBe('CAGENT0500')
    expect(res.agents[500].address).toBe('CAGENT0501')
    expect(new Set(res.agents.map((agent) => agent.address))).toHaveLength(501)
  })

  it('returns the accumulated rows as partial when a continuation cursor repeats', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const cursor = cursorFrom(url)
      return response(
        cursor === null
          ? pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: 'stuck' })
          : pagedBody({ agents: [indexedAgent(2)], hasMore: true, nextCursor: 'stuck' })
      )
    })

    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    expect(res.status).toBe('partial')
    expect(res.agents.map((agent) => agent.address)).toEqual(['CAGENT0001', 'CAGENT0002'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('round-trips an opaque cursor containing every reserved query character', async () => {
    const opaqueCursor = 'a+/=?& %'
    const signal = new AbortController().signal
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init).toEqual({ signal })
      if (cursorFrom(url) === null)
        return response(
          pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: opaqueCursor })
        )
      expect(url).toContain('cursor=a%2B%2F%3D%3F%26+%25')
      expect(cursorFrom(url)).toBe(opaqueCursor)
      return response(pagedBody({ agents: [indexedAgent(2)], hasMore: false }))
    })

    const res = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl,
      signal,
    })

    expect(res.status).toBe('complete')
    expect(res.agents.map((agent) => agent.address)).toEqual(['CAGENT0001', 'CAGENT0002'])
  })

  it('returns partial without replacing proven metadata when a duplicate address conflicts', async () => {
    const original = indexedAgent(1)
    const fetchImpl = vi.fn(async (url) =>
      response(
        cursorFrom(url) === null
          ? pagedBody({ agents: [original], hasMore: true, nextCursor: 'conflict' })
          : pagedBody({
              agents: [{ ...original, createdTxHash: 'different-tx' }],
              hasMore: false,
            })
      )
    )

    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    expect(res.status).toBe('partial')
    expect(res.agents).toEqual([original])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      'snapshot',
      (body) => ({
        ...body,
        pagination: { ...body.pagination, snapshotThroughLedger: 99 },
      }),
    ],
    ['owner', (body) => ({ ...body, owner: 'GOTHEROWNER' })],
    ['network', (body) => ({ ...body, networkId: 'stellar-mainnet' })],
    [
      'manifest',
      (body) => ({
        ...body,
        coverage: { ...body.coverage, manifestHash: 'different-manifest' },
      }),
    ],
    [
      'coverage',
      (body) => ({
        ...body,
        coverage: { ...body.coverage, indexedThroughLedger: 101 },
      }),
    ],
  ])('never completes when a later page changes %s identity', async (_identity, alter) => {
    const fetchImpl = vi.fn(async (url) => {
      if (cursorFrom(url) === null)
        return response(
          pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: 'changed' })
        )
      return response(alter(pagedBody({ agents: [indexedAgent(2)], hasMore: false })))
    })

    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    expect(res.status).toBe('partial')
    expect(res.agents.map((agent) => agent.address)).toEqual(['CAGENT0001'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('returns proven earlier rows as partial when a later page has an HTTP failure', async () => {
    const fetchImpl = vi.fn(async (url) =>
      cursorFrom(url) === null
        ? response(pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: 'later-500' }))
        : response({ error: 'boom' }, { ok: false, status: 500 })
    )

    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    expect(res.status).toBe('partial')
    expect(res.agents.map((agent) => agent.address)).toEqual(['CAGENT0001'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('passes one AbortSignal to every page and never completes an aborted sequence', async () => {
    const signal = new AbortController().signal
    const abortError = new DOMException('owner changed', 'AbortError')
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init).toEqual({ signal })
      if (cursorFrom(url) === null)
        return response(
          pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: 'aborted' })
        )
      throw abortError
    })

    const res = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl,
      signal,
    })

    expect(res.status).toBe('partial')
    expect(res.agents.map((agent) => agent.address)).toEqual(['CAGENT0001'])
  })

  it('returns unavailable when the signal aborts after fetch resolves but before JSON is read', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      return response(pagedBody({ agents: [indexedAgent(1)], hasMore: false }))
    })

    const res = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl,
      signal: controller.signal,
    })

    expect(res.status).toBe('unavailable')
    expect(res.agents).toEqual([])
  })

  it('returns only earlier proven rows when the signal aborts during terminal JSON parsing', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (url) => {
      if (cursorFrom(url) === null)
        return response(
          pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: 'abort-in-json' })
        )
      return {
        ok: true,
        status: 200,
        json: async () => {
          controller.abort()
          return pagedBody({ agents: [indexedAgent(2)], hasMore: false })
        },
      }
    })

    const res = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl,
      signal: controller.signal,
    })

    expect(res.status).toBe('partial')
    expect(res.agents.map((agent) => agent.address)).toEqual(['CAGENT0001'])
  })

  it.each([
    ['boolean indexed tip', { indexedThroughLedger: false }],
    ['string indexed tip', { indexedThroughLedger: '100' }],
    ['unsafe indexed tip', { indexedThroughLedger: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative indexed start', { indexedFromLedger: -1 }],
    ['boolean finalized ledger', { finalizedThroughLedger: false }],
    ['string finalized ledger', { finalizedThroughLedger: '98' }],
    ['indexed start after finalized tip', { indexedFromLedger: 99 }],
    ['finalized tip after indexed tip', { finalizedThroughLedger: 101 }],
    ['unsafe finality margin', { requiredFinalityLedgers: Number.MAX_SAFE_INTEGER + 1 }],
  ])(
    'never completes malformed %s coverage in paginated or legacy envelopes',
    async (_name, patch) => {
      const coverage = goodCoverage(patch)
      const snapshotThroughLedger = Number.isSafeInteger(coverage.finalizedThroughLedger)
        ? coverage.finalizedThroughLedger
        : 98
      const paginated = await fetchOwnerAgentIndex({
        owner: OWNER,
        networkId: NETWORK,
        fetchImpl: fakeFetch(
          pagedBody({
            agents: [indexedAgent(1)],
            hasMore: false,
            coverage,
            snapshotThroughLedger,
          })
        ),
      })
      const legacy = await fetchOwnerAgentIndex({
        owner: OWNER,
        networkId: NETWORK,
        fetchImpl: fakeFetch(legacyCompleteBody(coverage)),
      })

      expect(paginated.status).not.toBe('complete')
      expect(legacy.status).not.toBe('complete')
    }
  )

  it.each([
    [
      'cyclic agent metadata',
      () => {
        const cycle = {}
        cycle.self = cycle
        return indexedAgent(1, { extra: cycle })
      },
    ],
    ['non-JSON agent metadata', () => indexedAgent(1, { extra: 1n })],
    ['non-finite agent metadata', () => indexedAgent(1, { extra: Number.POSITIVE_INFINITY })],
    [
      'accessor agent address',
      () => {
        const agent = indexedAgent(1)
        Object.defineProperty(agent, 'address', {
          enumerable: true,
          get() {
            throw new Error('untrusted getter must not run')
          },
        })
        return agent
      },
    ],
    ['excessive agent nodes', () => indexedAgent(1, { extra: Array(25_000).fill(null) })],
  ])('returns unavailable instead of throwing for first-page %s', async (_name, makeAgent) => {
    const fetchImpl = fakeFetch(
      pagedBody({ agents: [makeAgent()], hasMore: false, coverageStatus: 'complete' })
    )

    const resultPromise = fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    await expect(resultPromise).resolves.toMatchObject({ status: 'unavailable', agents: [] })
  })

  it('returns unavailable instead of overflowing on first-page deeply nested coverage', async () => {
    const fetchImpl = fakeFetch(
      pagedBody({
        agents: [indexedAgent(1)],
        hasMore: false,
        coverage: goodCoverage({ extra: deeplyNestedJson(20_000) }),
      })
    )

    const resultPromise = fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    await expect(resultPromise).resolves.toMatchObject({ status: 'unavailable', agents: [] })
  })

  it('returns unavailable instead of invoking a non-JSON coverage accessor', async () => {
    const coverage = goodCoverage()
    Object.defineProperty(coverage, 'checkedAt', {
      enumerable: true,
      get() {
        throw new Error('untrusted getter must not run')
      },
    })
    const fetchImpl = fakeFetch(pagedBody({ agents: [indexedAgent(1)], hasMore: false, coverage }))

    const resultPromise = fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    await expect(resultPromise).resolves.toMatchObject({ status: 'unavailable', agents: [] })
  })

  it('returns prior rows as partial instead of overflowing on later-page deep metadata', async () => {
    const fetchImpl = vi.fn(async (url) =>
      response(
        cursorFrom(url) === null
          ? pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: 'deep-page' })
          : pagedBody({
              agents: [indexedAgent(2, { extra: deeplyNestedJson(20_000) })],
              hasMore: false,
            })
      )
    )

    const resultPromise = fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })

    await expect(resultPromise).resolves.toMatchObject({
      status: 'partial',
      agents: [{ address: 'CAGENT0001' }],
    })
  })

  it('keeps pending canonical scheduler work proportional to depth for wide boundary JSON', async () => {
    // Agent object depth 0 + 63 nested arrays + primitive leaves reaches the depth-64 boundary.
    // 63 * 400 array entries exceeds the 20,000-node budget while staying far below 2 MB JSON.
    const declaredArrayNodes = 63 * 400
    const serialized = JSON.stringify(
      pagedBody({
        agents: [indexedAgent(1, { extra: nestedWideJson(63, 400) })],
        hasMore: false,
      })
    )
    expect(declaredArrayNodes).toBeGreaterThan(20_000)
    expect(serialized.length).toBeLessThan(2_000_000)
    const body = JSON.parse(serialized)
    const pendingFrames = []

    const res = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl: fakeFetch(body),
      __testCanonicalSchedulerObserver: ({ pendingFrames: pending }) => {
        pendingFrames.push(pending)
      },
    })

    expect(res.status).toBe('unavailable')
    expect(pendingFrames.length).toBeGreaterThan(0)
    expect(Math.max(...pendingFrames)).toBeLessThanOrEqual(66)
  })

  it.each([
    ['throwing body accessor', bodyWithThrowingOwner],
    ['throwing pagination accessor', bodyWithThrowingPagination],
    ['throwing agents iterator', bodyWithThrowingAgentIterator],
  ])('contains first- and later-page %s without rejecting', async (_name, makeInvalidBody) => {
    const firstPagePromise = fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl: fakeFetch(makeInvalidBody()),
    })
    await expect(firstPagePromise).resolves.toMatchObject({ status: 'unavailable', agents: [] })

    const laterFetch = vi.fn(async (url) =>
      response(
        cursorFrom(url) === null
          ? pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: 'invalid-page' })
          : makeInvalidBody()
      )
    )
    const laterPagePromise = fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl: laterFetch,
    })
    await expect(laterPagePromise).resolves.toMatchObject({
      status: 'partial',
      agents: [{ address: 'CAGENT0001' }],
    })
  })

  it('rejects array index accessors without invoking them on first or later pages', async () => {
    let getterCalls = 0
    const makeInvalidBody = () => {
      const body = pagedBody({ agents: [indexedAgent(2)], hasMore: false })
      const row = body.agents[0]
      Object.defineProperty(body.agents, '0', {
        enumerable: true,
        get() {
          getterCalls += 1
          return row
        },
      })
      return body
    }

    const first = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl: fakeFetch(makeInvalidBody()),
    })
    expect(first).toMatchObject({ status: 'unavailable', agents: [] })

    const later = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      fetchImpl: vi.fn(async (url) =>
        response(
          cursorFrom(url) === null
            ? pagedBody({ agents: [indexedAgent(1)], hasMore: true, nextCursor: 'array-accessor' })
            : makeInvalidBody()
        )
      ),
    })
    expect(later).toMatchObject({ status: 'partial', agents: [{ address: 'CAGENT0001' }] })
    expect(getterCalls).toBe(0)
  })

  it('returns a complete response verbatim when owner/network/manifest all validate', async () => {
    const row = {
      address: 'CAGENT1',
      kind: 'deposit',
      creator: 'CCREATOR',
      createdLedger: 10,
      createdTxHash: 'tx1',
      runId: 'run1',
      runOrdinal: 0,
      grantTxHash: 'gtx1',
      association: 'unknown',
      baseChildren: [],
    }
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [row],
      coverage: goodCoverage(),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('complete')
    expect(res.agents).toEqual([row])
    expect(res.coverage.manifestHash).toBe(AGENT_CREATOR_MANIFEST_HASH)
  })

  it('keeps a pagination-less legacy complete envelope partial at the exact request cap', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [indexedAgent(1)],
      coverage: goodCoverage(),
    })

    const res = await fetchOwnerAgentIndex({
      owner: OWNER,
      networkId: NETWORK,
      limit: 1,
      fetchImpl,
    })

    expect(res.status).toBe('partial')
    expect(res.agents.map((agent) => agent.address)).toEqual(['CAGENT0001'])
  })

  it('downgrades complete to partial when the manifest hash does not match this bundle', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage({ manifestHash: '0xstale' }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('partial')
  })

  it('downgrades complete to partial when the manifest version does not match this bundle', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage({ manifestVersion: 'stale-version' }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('partial')
  })

  it('downgrades complete to partial when requiredFinalityLedgers is below the frozen 2-ledger margin', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage({ requiredFinalityLedgers: 1 }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('partial')
  })

  it('leaves an already-partial response partial on a manifest mismatch (nothing to downgrade)', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'partial',
      agents: [],
      coverage: goodCoverage({ manifestVersion: 'stale-version', contiguous: false }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('partial')
  })

  it('returns unavailable when the network request throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    // Fix loop 2, Fix 3: asserted as a literal, not a shared NULL_HINTS test constant that would
    // just mirror the source and drift with it — this is the only thing that actually catches
    // source/test shape drift on this envelope field.
    expect(res).toEqual({
      status: 'unavailable',
      networkId: NETWORK,
      owner: OWNER,
      agents: [],
      coverage: null,
      hints: {
        localCacheCount: null,
        rpcEventCount: null,
        registryCount: null,
        vaultVerifiedCount: null,
        unverifiedCandidateCount: null,
      },
    })
  })

  it('returns the empty-agents unavailable shape for an unrecognized status, never a populated agents array', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'weird-future-status',
      agents: [{ address: 'CAGENT1', kind: 'deposit' }],
      coverage: goodCoverage(),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res).toEqual({
      status: 'unavailable',
      networkId: NETWORK,
      owner: OWNER,
      agents: [],
      coverage: null,
      hints: {
        localCacheCount: null,
        rpcEventCount: null,
        registryCount: null,
        vaultVerifiedCount: null,
        unverifiedCandidateCount: null,
      },
    })
  })

  it('downgrades complete to partial when coverage is not contiguous, even with a valid manifest', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage({ contiguous: false }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('partial')
  })

  it('downgrades complete to partial when coverage has an open gap, even with a valid manifest', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage({ gaps: [{ from: 10, to: 20 }] }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('partial')
  })

  it('downgrades complete to partial when the historical backfill is not verified, even with a valid manifest', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage({ historicalBackfill: 'pending' }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('partial')
  })

  it('downgrades complete to partial when indexedThroughLedger is null (no tip), even with a valid manifest', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage({ indexedThroughLedger: null }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('partial')
  })

  it('returns unavailable on a non-2xx response', async () => {
    const fetchImpl = fakeFetch({ error: 'boom' }, { ok: false, status: 500 })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('unavailable')
  })

  it('returns unavailable when the JSON body fails to parse', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json')
      },
    }))
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('unavailable')
  })

  it('returns unavailable when the response owner does not match the request', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: 'GSOMEONE_ELSE',
      status: 'complete',
      agents: [],
      coverage: goodCoverage(),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('unavailable')
  })

  it('returns unavailable when the response network does not match the request', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: 'stellar-mainnet',
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage(),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('unavailable')
  })

  it('returns unavailable when the schema version is unrecognized', async () => {
    const fetchImpl = fakeFetch({
      version: 2,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: [],
      coverage: goodCoverage(),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('unavailable')
  })

  it('returns unavailable when agents is not an array or coverage is missing', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'complete',
      agents: null,
      coverage: goodCoverage(),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.status).toBe('unavailable')
  })

  it('keeps a bridge association marked unknown as unknown, verbatim', async () => {
    const row = {
      address: 'CBRIDGE1',
      kind: 'unknown',
      creator: 'CCREATOR',
      createdLedger: 10,
      createdTxHash: 'tx1',
      runId: 'run1',
      runOrdinal: 0,
      grantTxHash: 'gtx1',
      association: 'unknown',
      associationSource: null,
      baseChildren: [],
    }
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'partial',
      agents: [row],
      coverage: goodCoverage({ contiguous: false, historicalBackfill: 'pending' }),
    })
    const res = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(res.agents[0].association).toBe('unknown')
  })

  it('passes runOrdinal through unchanged across repeated calls (never recomputed client-side)', async () => {
    const row = {
      address: 'CAGENT1',
      kind: 'deposit',
      creator: 'CCREATOR',
      createdLedger: 10,
      createdTxHash: 'tx1',
      runId: 'run1',
      runOrdinal: 3,
      grantTxHash: 'gtx1',
      baseChildren: [],
    }
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'partial',
      agents: [row],
      coverage: goodCoverage({ contiguous: false }),
    })
    const first = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    const second = await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, fetchImpl })
    expect(first.agents[0].runOrdinal).toBe(3)
    expect(second.agents[0].runOrdinal).toBe(3)
  })

  it('includes limit in the query string when provided', async () => {
    const fetchImpl = fakeFetch({
      version: 1,
      networkId: NETWORK,
      owner: OWNER,
      status: 'partial',
      agents: [],
      coverage: goodCoverage({ contiguous: false }),
    })
    await fetchOwnerAgentIndex({ owner: OWNER, networkId: NETWORK, limit: 50, fetchImpl })
    const calledUrl = fetchImpl.mock.calls[0][0]
    expect(calledUrl).toContain('limit=50')
    expect(calledUrl).toContain(`owner=${OWNER}`)
  })

  it('never falls back to a demo agent address', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./agentIndexClient.js', import.meta.url), 'utf8')
    )
    expect(src).not.toMatch(/SOROBAN_DEMO_AGENT/)
  })
})
