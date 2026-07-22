// frontend/src/stellar/agentCache.test.js — agent reuse cache: persistence, on-chain scope
// validation (expiry / revoked / cap headroom / rolling window), pruning, and run-local exclusion.
import { describe, test, expect, beforeEach } from 'vitest'
import {
  cacheKeyFor,
  loadCachedAgents,
  saveCachedAgent,
  scopeHeadroom,
  isScopeReusable,
  takeReusableAgent,
  EXPIRY_MARGIN_SECONDS,
} from './agentCache.js'

const NOW = 1_800_000_000
const OWNER = 'GOWNER'
const VAULT = 'CVAULT'
const NET = 'Test Net'

// Deterministic injectable storage — the module falls back to an in-memory store when
// localStorage is absent (node env), but tests want per-test isolation.
const makeStorage = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

const entry = (over = {}) => ({
  agentAddress: 'CAGENT1',
  secret: 'SSECRET1',
  signerPub: 'GSIGNER1',
  cap: '500000000',
  expiry: NOW + 3600,
  createdAt: 1,
  ...over,
})

const scope = (over = {}) => ({
  owner: OWNER,
  vault: VAULT,
  token: 'CTOKEN',
  cap_per_period: 500000000n,
  period_duration: 86400n,
  spent_in_period: 0n,
  period_start: 0n,
  expiry: BigInt(NOW + 3600),
  revoked: false,
  ...over,
})

// agent_account v3 renamed the AgentScope field vault -> target. Both generations are live on
// testnet (dual-support), so scope_of() may come back shaped either way.
const scopeV3 = (over = {}) => ({
  owner: OWNER,
  target: VAULT,
  token: 'CTOKEN',
  cap_per_period: 500000000n,
  period_duration: 86400n,
  spent_in_period: 0n,
  period_start: 0n,
  expiry: BigInt(NOW + 3600),
  revoked: false,
  ...over,
})

let storage
beforeEach(() => {
  storage = makeStorage()
})

describe('cache persistence', () => {
  test('save/load round-trips per (network, owner, vault) bucket', () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toHaveLength(1)
    // Different owner/vault buckets stay isolated.
    expect(loadCachedAgents({ owner: 'GOTHER', vault: VAULT, network: NET, storage })).toEqual([])
    expect(loadCachedAgents({ owner: OWNER, vault: 'COTHER', network: NET, storage })).toEqual([])
    expect(cacheKeyFor({ owner: OWNER, vault: VAULT, network: NET })).toBe(
      `${NET}|${OWNER}|${VAULT}`
    )
  })

  test('re-saving the same agentAddress replaces instead of duplicating', () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    saveCachedAgent({
      owner: OWNER,
      vault: VAULT,
      network: NET,
      entry: entry({ secret: 'SNEW' }),
      storage,
    })
    const list = loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })
    expect(list).toHaveLength(1)
    expect(list[0].secret).toBe('SNEW')
  })

  test('corrupt stored JSON degrades to an empty cache, never a throw', () => {
    storage.setItem('vf.agentCache.v1', '{not json')
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toEqual([])
  })
})

describe('scopeHeadroom (rolling window)', () => {
  test('full cap when the window never started (period_start 0)', () => {
    expect(scopeHeadroom(scope({ spent_in_period: 400000000n }), NOW)).toBe(500000000n)
  })
  test('cap minus spent inside a live window', () => {
    const s = scope({ period_start: BigInt(NOW - 100), spent_in_period: 400000000n })
    expect(scopeHeadroom(s, NOW)).toBe(100000000n)
  })
  test('spent resets once the window elapsed - cap headroom restored', () => {
    const s = scope({
      period_start: BigInt(NOW - 86401),
      spent_in_period: 500000000n, // fully drained…
    })
    expect(scopeHeadroom(s, NOW)).toBe(500000000n) // …but the period rolled
  })
})

describe('isScopeReusable', () => {
  const base = { owner: OWNER, vault: VAULT, amount: 100000000n, nowSec: NOW }
  test('accepts a live, unspent, matching scope', () => {
    expect(isScopeReusable({ ...base, scope: scope() })).toBe(true)
  })
  test('accepts a v3 scope (target field) matching vault via fallback', () => {
    expect(isScopeReusable({ ...base, scope: scopeV3() })).toBe(true)
  })
  test('rejects a v3 scope whose target does not match the vault', () => {
    expect(isScopeReusable({ ...base, scope: scopeV3({ target: 'COTHER' }) })).toBe(false)
  })
  test.each([
    ['revoked', scope({ revoked: true })],
    ['expired', scope({ expiry: BigInt(NOW - 1) })],
    ['expiring within the safety margin', scope({ expiry: BigInt(NOW + EXPIRY_MARGIN_SECONDS) })],
    ['owner mismatch', scope({ owner: 'GOTHER' })],
    ['vault mismatch', scope({ vault: 'COTHER' })],
    [
      'cap headroom below the run amount',
      scope({ period_start: BigInt(NOW - 10), spent_in_period: 450000000n }),
    ],
    ['missing (scope read failed)', null],
  ])('rejects: %s', (_label, s) => {
    expect(isScopeReusable({ ...base, scope: s })).toBe(false)
  })
})

describe('takeReusableAgent', () => {
  const takeArgs = (over = {}) => ({
    owner: OWNER,
    vault: VAULT,
    network: NET,
    amount: 100000000n,
    nowSec: NOW,
    storage,
    ...over,
  })

  test('returns a cached agent whose ON-CHAIN scope validates, and keeps it cached', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const taken = await takeReusableAgent(takeArgs({ readScope: async () => scope() }))
    expect(taken?.agentAddress).toBe('CAGENT1')
    expect(taken?.secret).toBe('SSECRET1')
    // Stays cached — its own on-chain cap/expiry invalidates it later; exclude guards this run.
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toHaveLength(1)
  })

  test('returns a cached agent whose ON-CHAIN v3 scope (target field) validates via fallback', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const taken = await takeReusableAgent(takeArgs({ readScope: async () => scopeV3() }))
    expect(taken?.agentAddress).toBe('CAGENT1')
  })

  test('prunes agents that are authoritatively invalid on-chain (revoked / drained)', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const taken = await takeReusableAgent(
      takeArgs({ readScope: async () => scope({ revoked: true }) })
    )
    expect(taken).toBeNull()
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toEqual([])
  })

  test('prunes locally-expired entries WITHOUT an RPC round-trip', async () => {
    saveCachedAgent({
      owner: OWNER,
      vault: VAULT,
      network: NET,
      entry: entry({ expiry: NOW - 10 }),
      storage,
    })
    let rpcCalls = 0
    const taken = await takeReusableAgent(
      takeArgs({
        readScope: async () => {
          rpcCalls++
          return scope()
        },
      })
    )
    expect(taken).toBeNull()
    expect(rpcCalls).toBe(0)
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toEqual([])
  })

  test('keeps (but never reuses) an entry whose scope read failed - no blind cache hits', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const taken = await takeReusableAgent(takeArgs({ readScope: async () => null }))
    expect(taken).toBeNull()
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toHaveLength(1)
  })

  test('exclude prevents one agent from serving two workers of the SAME run', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const exclude = new Set()
    const first = await takeReusableAgent(takeArgs({ exclude, readScope: async () => scope() }))
    exclude.add(first.agentAddress)
    const second = await takeReusableAgent(takeArgs({ exclude, readScope: async () => scope() }))
    expect(first.agentAddress).toBe('CAGENT1')
    expect(second).toBeNull()
  })

  test('a drained agent is rejected for a large run but reusable once its window rolls', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const drained = scope({ period_start: BigInt(NOW - 100), spent_in_period: 500000000n })
    expect(await takeReusableAgent(takeArgs({ readScope: async () => drained }))).toBeNull()
    // Same agent, window elapsed → full headroom again.
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const rolled = scope({ period_start: BigInt(NOW - 86401), spent_in_period: 500000000n })
    const taken = await takeReusableAgent(takeArgs({ readScope: async () => rolled }))
    expect(taken?.agentAddress).toBe('CAGENT1')
  })
})
