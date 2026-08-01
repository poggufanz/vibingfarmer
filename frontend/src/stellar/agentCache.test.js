// frontend/src/stellar/agentCache.test.js — agent reuse cache: persistence, on-chain scope
// validation (expiry / revoked / cap headroom / rolling window), pruning, and run-local exclusion.
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'

const readContractMock = vi.fn()
vi.mock('./client.js', () => ({
  readContract: (...a) => readContractMock(...a),
}))

import {
  cacheKeyFor,
  loadCachedAgents,
  saveCachedAgent,
  scopeHeadroom,
  isScopeReusable,
  takeReusableAgent,
  readAgentSigner,
  computeScopeFingerprint,
  inspectReusableAgents,
  inspectAgentsV4,
  EXPIRY_MARGIN_SECONDS,
} from './agentCache.js'

const NOW = 1_800_000_000
const OWNER = 'GOWNER'
const VAULT = 'CVAULT'
const VAULT_2 = 'CVAULT2'
const NET = 'Test Net'

// Local hex helper for test fixtures/assertions only — mirrors agentCache.js's own private
// `bytesToHex` (not exported), never imported from production code.
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

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
  readContractMock.mockReset()
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

describe('readAgentSigner', () => {
  test('reads the agent scope_of contract via the "signer" method', async () => {
    readContractMock.mockResolvedValue(new Uint8Array(32).fill(9))
    const out = await readAgentSigner('CAGENT1', { server: {} })
    expect(readContractMock).toHaveBeenCalledWith({
      contract: 'CAGENT1',
      method: 'signer',
      args: [],
      server: {},
    })
    expect(out).toEqual(new Uint8Array(32).fill(9))
  })

  test('an RPC/decode failure returns null, never throws', async () => {
    readContractMock.mockRejectedValue(new Error('rpc down'))
    expect(await readAgentSigner('CAGENT1', { server: {} })).toBeNull()
  })
})

describe('computeScopeFingerprint', () => {
  const ingredients = {
    owner: OWNER,
    target: VAULT,
    token: 'CTOKEN',
    signer: new Uint8Array(32).fill(1),
    kind: 0,
    cap: 500000000n,
    spentInPeriod: 0n,
    periodStart: 0n,
    periodDuration: 86400n,
    expiry: BigInt(NOW + 3600),
    revoked: false,
  }

  test('is deterministic for identical ingredients', () => {
    expect(computeScopeFingerprint(ingredients)).toBe(computeScopeFingerprint({ ...ingredients }))
  })

  test.each([
    ['owner', { owner: 'GOTHER' }],
    ['target', { target: 'COTHER' }],
    ['token', { token: 'COTHERTOKEN' }],
    ['signer', { signer: new Uint8Array(32).fill(2) }],
    ['kind', { kind: 1 }],
    ['cap', { cap: 1n }],
    ['spentInPeriod', { spentInPeriod: 1n }],
    ['periodStart', { periodStart: 1n }],
    ['periodDuration', { periodDuration: 1n }],
    ['expiry', { expiry: 1n }],
    ['revoked', { revoked: true }],
  ])('changes when %s changes', (_label, over) => {
    expect(computeScopeFingerprint({ ...ingredients, ...over })).not.toBe(
      computeScopeFingerprint(ingredients)
    )
  })

  test('is a 0x-prefixed sha256 hex string', () => {
    expect(computeScopeFingerprint(ingredients)).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('inspectReusableAgents (non-mutating)', () => {
  const args = (over = {}) => ({
    owner: OWNER,
    vault: VAULT,
    network: NET,
    nowSec: NOW,
    storage,
    ...over,
  })

  test('returns [] when the cache is empty, no RPC calls made', async () => {
    const rows = await inspectReusableAgents(args({ readScope: async () => scope() }))
    expect(rows).toEqual([])
  })

  test('returns one row per cached entry with scope + signer + scopeFingerprint', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const readScope = vi.fn(async () => scope())
    const readSigner = vi.fn(async () => new Uint8Array(32).fill(4))
    const rows = await inspectReusableAgents(args({ readScope, readSigner }))
    expect(rows).toHaveLength(1)
    expect(rows[0].agentAddress).toBe('CAGENT1')
    expect(rows[0].entry.secret).toBe('SSECRET1')
    expect(rows[0].scope).toEqual(scope())
    expect(rows[0].signer).toEqual(new Uint8Array(32).fill(4))
    expect(rows[0].scopeFingerprint).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('scopeFingerprint is null when the scope read fails (never fabricate one)', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const rows = await inspectReusableAgents(
      args({ readScope: async () => null, readSigner: async () => new Uint8Array(32) })
    )
    expect(rows[0].scope).toBeNull()
    expect(rows[0].scopeFingerprint).toBeNull()
  })

  test('NEVER prunes or mutates the cache, even for a revoked/expired/null scope', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    await inspectReusableAgents(
      args({ readScope: async () => scope({ revoked: true }), readSigner: async () => null })
    )
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toHaveLength(1)
    await inspectReusableAgents(args({ readScope: async () => null, readSigner: async () => null }))
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toHaveLength(1)
  })

  test('NEVER assigns/excludes - two consecutive calls both see the same agent', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    const readScope = async () => scope()
    const readSigner = async () => new Uint8Array(32)
    const first = await inspectReusableAgents(args({ readScope, readSigner }))
    const second = await inspectReusableAgents(args({ readScope, readSigner }))
    expect(first.map((r) => r.agentAddress)).toEqual(['CAGENT1'])
    expect(second.map((r) => r.agentAddress)).toEqual(['CAGENT1'])
  })

  test('inspects every cached entry, not just the first reusable one', async () => {
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(), storage })
    saveCachedAgent({
      owner: OWNER,
      vault: VAULT,
      network: NET,
      entry: entry({ agentAddress: 'CAGENT2', secret: 'SSECRET2' }),
      storage,
    })
    const rows = await inspectReusableAgents(
      args({ readScope: async () => scope(), readSigner: async () => new Uint8Array(32) })
    )
    expect(rows.map((r) => r.agentAddress).sort()).toEqual(['CAGENT1', 'CAGENT2'])
  })
})

// --- inspectAgentsV4 (Task W3b) -----------------------------------------------------------------
// The V4 row supplier for permissionGrantV3.js's injected `inspectAgents`. A DIFFERENT consumer,
// DIFFERENT row shape than inspectReusableAgents above — see agentCache.js's own doc for why the
// two are never unified.

describe('inspectAgentsV4', () => {
  const CODE_BYTES = new Uint8Array(32).fill(0xaa)
  const CODE_HEX = '0x' + toHex(CODE_BYTES)
  const SIGNER_BYTES = new Uint8Array(32).fill(0xbb)
  const SIGNER_PUB = StrKey.encodeEd25519PublicKey(SIGNER_BYTES)

  // A real AgentScope (agent_account/src/types.rs) — full shape for fidelity, even though
  // inspectAgentsV4 only reads target/token/cap_per_period/per_execution_max/expiry/revoked.
  const scopeV4 = (over = {}) => ({
    owner: OWNER,
    target: VAULT,
    token: 'CTOKEN',
    kind: 0,
    mint_recipient: new Uint8Array(32),
    destination_domain: 0,
    cap_per_period: 500000000n,
    period_duration: 86400n,
    spent_in_period: 0n,
    period_start: 0n,
    expiry: BigInt(NOW + 3600),
    revoked: false,
    per_execution_max: 50000000n,
    ...over,
  })

  const args = (over = {}) => ({
    owner: OWNER,
    network: NET,
    storage,
    readScope: async () => scopeV4(),
    readSigner: async () => SIGNER_BYTES,
    readRouterAgentWasmHash: async () => CODE_BYTES,
    ...over,
  })

  const seedOneAgent = (over = {}) =>
    saveCachedAgent({ owner: OWNER, vault: VAULT, network: NET, entry: entry(over), storage })

  test('returns [] and never calls the router or agent readers when the cache is empty', async () => {
    const readRouterAgentWasmHash = vi.fn(async () => CODE_BYTES)
    const readScope = vi.fn(async () => scopeV4())
    const rows = await inspectAgentsV4(args({ readRouterAgentWasmHash, readScope }))
    expect(rows).toEqual([])
    expect(readRouterAgentWasmHash).not.toHaveBeenCalled()
    expect(readScope).not.toHaveBeenCalled()
  })

  test('every field is sourced correctly: target/token/caps/expiry/revoked from scope_of(), signerPub from signer(), code from the ROUTER config() — never the agent', async () => {
    seedOneAgent()
    const rows = await inspectAgentsV4(args())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      agentAddress: 'CAGENT1',
      signerPub: SIGNER_PUB,
      code: CODE_HEX,
      target: VAULT,
      token: 'CTOKEN',
      capPerPeriodUnits: '500000000',
      perExecutionMaxUnits: '50000000',
      expiry: NOW + 3600,
      revoked: false,
    })
  })

  test('reads the router config() ONCE per call, not once per row', async () => {
    seedOneAgent()
    saveCachedAgent({
      owner: OWNER,
      vault: VAULT,
      network: NET,
      entry: entry({ agentAddress: 'CAGENT2', secret: 'SSECRET2' }),
      storage,
    })
    const readRouterAgentWasmHash = vi.fn(async () => CODE_BYTES)
    const rows = await inspectAgentsV4(args({ readRouterAgentWasmHash }))
    expect(rows).toHaveLength(2)
    expect(readRouterAgentWasmHash).toHaveBeenCalledTimes(1)
  })

  test('spans every cached vault for (owner, network), not just one', async () => {
    seedOneAgent()
    saveCachedAgent({
      owner: OWNER,
      vault: VAULT_2,
      network: NET,
      entry: entry({ agentAddress: 'CAGENT2', secret: 'SSECRET2' }),
      storage,
    })
    const readScope = async (agentAddress) =>
      scopeV4({ target: agentAddress === 'CAGENT2' ? VAULT_2 : VAULT })
    const rows = await inspectAgentsV4(args({ readScope }))
    expect(rows.map((r) => r.agentAddress).sort()).toEqual(['CAGENT1', 'CAGENT2'])
    expect(rows.find((r) => r.agentAddress === 'CAGENT2').target).toBe(VAULT_2)
  })

  test('does not mutate or prune the cache — a pure read, even for a failing entry', async () => {
    seedOneAgent()
    await inspectAgentsV4(args({ readScope: async () => null }))
    expect(loadCachedAgents({ owner: OWNER, vault: VAULT, network: NET, storage })).toHaveLength(1)
  })

  test('capPerPeriodUnits/perExecutionMaxUnits are canonical decimal STRINGS, bigint-safe above Number.MAX_SAFE_INTEGER', async () => {
    seedOneAgent()
    // 2^53 + 1 — NOT a round value: Number(9007199254740993n) rounds to 9007199254740992,
    // so a Number()-based implementation would silently emit the WRONG string here.
    const HUGE = 9007199254740993n
    expect(HUGE).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    const rows = await inspectAgentsV4(
      args({ readScope: async () => scopeV4({ cap_per_period: HUGE }) })
    )
    expect(rows[0].capPerPeriodUnits).toBe('9007199254740993')
  })

  test.each([
    ['scope', { readScope: async () => null }],
    ['signer', { readSigner: async () => null }],
  ])('a failed %s read drops the agent from the result — never a partial row', async (_label, over) => {
    seedOneAgent()
    const rows = await inspectAgentsV4(args(over))
    expect(rows).toEqual([])
  })

  test('a row never carries signerPub: undefined — a failed signer read is absent, not present-but-empty', async () => {
    seedOneAgent()
    const rows = await inspectAgentsV4(args({ readSigner: async () => null }))
    expect(rows.some((r) => r.agentAddress === 'CAGENT1')).toBe(false)
    expect(rows.some((r) => 'signerPub' in r && r.signerPub === undefined)).toBe(false)
  })

  test.each([
    ['non-string target', { target: 42 }],
    ['empty token', { token: '' }],
    ['non-boolean revoked', { revoked: 'false' }],
    ['non-BigInt cap_per_period', { cap_per_period: 500000000 }],
    ['negative cap_per_period', { cap_per_period: -1n }],
    ['non-BigInt per_execution_max', { per_execution_max: 50000000 }],
    ['non-BigInt expiry', { expiry: NOW + 3600 }],
  ])('a structurally invalid scope (%s) drops the row, never throws', async (_label, over) => {
    seedOneAgent()
    const rows = await inspectAgentsV4(
      args({ readScope: async () => scopeV4(over) })
    )
    await expect(Promise.resolve(rows)).resolves.toEqual([])
  })

  test('a malformed router wasm-hash resolution throws rather than silently dropping every row', async () => {
    seedOneAgent()
    await expect(
      inspectAgentsV4(args({ readRouterAgentWasmHash: async () => new Uint8Array(16) }))
    ).rejects.toThrow(/32-byte/)
  })

  test('code is read from the injected router reader, never derived from the agent itself', async () => {
    seedOneAgent()
    // Router code and agent signer are deliberately DIFFERENT byte patterns so a row that
    // accidentally sourced `code` from the agent (e.g. from its signer bytes) is distinguishable.
    const rows = await inspectAgentsV4(args())
    expect(rows[0].code).toBe(CODE_HEX)
    expect(rows[0].code).not.toBe('0x' + toHex(SIGNER_BYTES))
  })
})
