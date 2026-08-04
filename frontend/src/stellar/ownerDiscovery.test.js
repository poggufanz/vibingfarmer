import { describe, it, expect, vi } from 'vitest'

// A throwing rpcServer() (SDK load failure) must degrade discoverOwnerScopes to "no server", not
// crash it (Fix 4a). Preserve every other real export (readContract etc.) via importOriginal —
// only rpcServer needs to be independently controllable per test.
const rpcServerMock = vi.fn(async () => ({}))
vi.mock('./client.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, rpcServer: (...a) => rpcServerMock(...a) }
})

import { discoverOwnerScopes, DEFAULT_NETWORK_ID } from './ownerDiscovery.js'

const OWNER = 'GOWNER234567234567234567234567234567234567234567234567AB'
const NETWORK = DEFAULT_NETWORK_ID

// The coverage shape here must stay something fetchOwnerAgentIndex could actually PRODUCE for the
// requested status (Fix 4d) — a fixture pairing status:'complete' with contiguous:false/pending
// backfill teaches a wrong mental model, since the real client can never emit that combination.
function client(overrides = {}) {
  const status = overrides.status ?? 'partial'
  const coverage =
    status === 'complete'
      ? {
          manifestVersion: 'v',
          manifestHash: '0xabc',
          schemaVersion: 1,
          indexedFromLedger: 1,
          indexedThroughLedger: 100,
          finalizedThroughLedger: 98,
          contiguous: true,
          gaps: [],
          historicalBackfill: 'verified',
          requiredFinalityLedgers: 2,
          checkedAt: 123,
        }
      : {
          manifestVersion: 'v',
          manifestHash: '0xabc',
          schemaVersion: 1,
          indexedFromLedger: null,
          indexedThroughLedger: null,
          finalizedThroughLedger: null,
          contiguous: false,
          gaps: [],
          historicalBackfill: 'pending',
          requiredFinalityLedgers: 2,
          checkedAt: 0,
        }
  return {
    status,
    networkId: NETWORK,
    owner: OWNER,
    agents: [],
    coverage,
    ...overrides,
  }
}

const scope = ({ owner = OWNER, revoked = false, expiry = 1000 } = {}) => ({
  owner,
  target: 'CVAULT',
  token: 'CTOKEN',
  cap_per_period: '1',
  period_duration: 10,
  expiry,
  revoked,
})

function seams({
  clientResult = client(),
  cache = [],
  rpc = [],
  registry = [],
  vault = [],
  scopes = {},
} = {}) {
  return {
    server: {},
    fetchClient: vi.fn(async () => clientResult),
    loadCache: () => cache.map((agentAddress) => ({ agentAddress })),
    fetchRpcEvents: async () => rpc.map((r) => (typeof r === 'string' ? { agent: r } : r)),
    queryRegistry: async () => registry,
    discoverVaultAgents: async () => vault,
    readScope: async (agent) => (agent in scopes ? scopes[agent] : null),
  }
}

describe('discoverOwnerScopes', () => {
  it('stays partial when the API is partial, even with a confirming hint', async () => {
    const row = { address: 'CAGENT1', kind: 'deposit' }
    const s = seams({
      clientResult: client({ status: 'partial', agents: [row] }),
      cache: ['CAGENT1'],
      scopes: { CAGENT1: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('partial')
    expect(d.agents.map((a) => a.address)).toEqual(['CAGENT1'])
  })

  it('reports partial (not empty) when the API is unavailable but a hint verifies', async () => {
    const s = seams({
      clientResult: {
        status: 'unavailable',
        networkId: NETWORK,
        owner: OWNER,
        agents: [],
        coverage: null,
      },
      cache: ['CAGENT1'],
      scopes: { CAGENT1: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('partial')
    expect(d.agents).toHaveLength(1)
  })

  it('reports unavailable, never `complete + []`, when the API is down and no hint exists', async () => {
    const s = seams({
      clientResult: {
        status: 'unavailable',
        networkId: NETWORK,
        owner: OWNER,
        agents: [],
        coverage: null,
      },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('unavailable')
    expect(d.agents).toEqual([])
  })

  it('keeps revoked and expired agents in the membership list', async () => {
    const rows = [
      { address: 'CREV', kind: 'deposit' },
      { address: 'CEXP', kind: 'deposit' },
    ]
    const s = seams({
      clientResult: client({ agents: rows }),
      scopes: { CREV: scope({ revoked: true }), CEXP: scope({ expiry: 1 }) },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.map((a) => a.address).sort()).toEqual(['CEXP', 'CREV'])
    expect(d.agents.find((a) => a.address === 'CREV').revoked).toBe(true)
    expect(d.agents.find((a) => a.address === 'CEXP').expiry).toBe(1)
  })

  it('quarantines a row whose on-chain scope owner does not match, and downgrades coverage', async () => {
    const rows = [
      { address: 'CGOOD', kind: 'deposit' },
      { address: 'CBAD', kind: 'deposit' },
    ]
    const s = seams({
      clientResult: client({ status: 'complete', agents: rows }),
      scopes: { CGOOD: scope(), CBAD: scope({ owner: 'GSOMEONE_ELSE' }) },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.map((a) => a.address)).toEqual(['CGOOD'])
    expect(d.status).toBe('partial')
  })

  it('tags a per-row scope read failure but keeps the row rather than dropping the whole owner', async () => {
    const rows = [
      { address: 'CGOOD', kind: 'deposit' },
      { address: 'CFAIL', kind: 'deposit' },
    ]
    const s = seams({ clientResult: client({ agents: rows }), scopes: { CGOOD: scope() } }) // CFAIL -> null
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.map((a) => a.address).sort()).toEqual(['CFAIL', 'CGOOD'])
    expect(d.agents.find((a) => a.address === 'CFAIL').scopeReadStatus).toBe('failed')
  })

  it('never admits a hint-only candidate whose scope read fails, and never reports partial on the strength of it alone', async () => {
    // Only a local-cache hint claims CUNVERIFIED — D1 never indexed it (no apiRow) — and the one
    // read that could vouch for it fails. Zero evidence backs membership: it must not become a
    // row, and it must not by itself flip an honest `unavailable` (no other evidence at all) into
    // a false `partial`.
    const s = seams({
      clientResult: {
        status: 'unavailable',
        networkId: NETWORK,
        owner: OWNER,
        agents: [],
        coverage: null,
      },
      cache: ['CUNVERIFIED'], // CUNVERIFIED has no entry in `scopes` -> readScope resolves null
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('unavailable')
    expect(d.agents).toEqual([])
  })

  it('downgrades a complete status when a hint-only candidate cannot be verified, without admitting it as membership', async () => {
    const row = { address: 'CKNOWN', kind: 'deposit' }
    const s = seams({
      clientResult: client({ status: 'complete', agents: [row] }),
      cache: ['CUNVERIFIED'], // hint-only, scope_of read fails -> coverage discrepancy, not a row
      scopes: { CKNOWN: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('partial')
    expect(d.agents.map((a) => a.address)).toEqual(['CKNOWN'])
  })

  // Fix loop 2, Fix 1: the drop-on-failed-read rule only holds for candidates whose ONLY source
  // is local-cache (client-mutable, stale-prone, no chain backing at all). rpc-router-events and
  // registry-events carry an owner topic from chain; vault-discovery has already passed its own
  // owner-matching scope_of read inside discoverAgentsFromVault (events.js:199-203) before ever
  // being returned — a candidate carrying any of those sources must be RETAINED on a failed
  // second read, tagged 'failed', not silently dropped.
  it('retains a vault-only candidate whose scope read fails, and still downgrades a complete status', async () => {
    const s = seams({
      clientResult: client({ status: 'complete', agents: [] }),
      vault: ['CVAULTFAIL'], // no entry in `scopes` -> readScope resolves null
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.map((a) => a.address)).toEqual(['CVAULTFAIL'])
    expect(d.agents[0].scopeReadStatus).toBe('failed')
    expect(d.status).toBe('partial')
  })

  it('retains an rpc-router-events-only candidate whose scope read fails', async () => {
    const s = seams({
      clientResult: client({ agents: [] }),
      rpc: ['CRPCFAIL'], // no entry in `scopes` -> readScope resolves null
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.map((a) => a.address)).toEqual(['CRPCFAIL'])
    expect(d.agents[0].scopeReadStatus).toBe('failed')
  })

  it('still drops a local-cache-only candidate whose scope read fails', async () => {
    const s = seams({
      clientResult: client({ agents: [] }),
      cache: ['CCACHEFAIL'], // no entry in `scopes` -> readScope resolves null
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents).toEqual([])
  })

  it('retains a candidate carrying both local-cache and a chain source on a failed read', async () => {
    const s = seams({
      clientResult: client({ agents: [] }),
      cache: ['CBOTH'],
      rpc: ['CBOTH'],
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.map((a) => a.address)).toEqual(['CBOTH'])
    expect(d.agents[0].discoverySources.sort()).toEqual(['local-cache', 'rpc-router-events'])
  })

  // Fix loop 2, Fix 2: a dropped (still-unverifiable) candidate must leave an enumerable trace in
  // `hints` — a consumer can't otherwise tell whether a `partial` came from one unreadable address
  // or fifty.
  it('counts unverifiable hint-only candidates in hints.unverifiedCandidateCount', async () => {
    const s = seams({
      clientResult: client({ agents: [] }),
      cache: ['CUNVERIFIED1', 'CUNVERIFIED2'],
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.hints.unverifiedCandidateCount).toBe(2)
  })

  it('dedupes the same address seen via the API, cache, RPC events, and registry without losing provenance', async () => {
    const row = { address: 'CAGENT1', kind: 'deposit', runId: 'run1' }
    const s = seams({
      clientResult: client({ agents: [row] }),
      cache: ['CAGENT1'],
      rpc: ['CAGENT1'],
      registry: ['CAGENT1'],
      scopes: { CAGENT1: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents).toHaveLength(1)
    expect(d.agents[0].runId).toBe('run1') // API identity preserved, not overwritten by a hint stub
    expect(d.agents[0].discoverySources.sort()).toEqual([
      'agent-index-api',
      'local-cache',
      'registry-events',
      'rpc-router-events',
    ])
  })

  it('adds a verified hint-only candidate the API missed and downgrades a complete status', async () => {
    const s = seams({
      clientResult: client({ status: 'complete', agents: [] }),
      cache: ['CMISSED'],
      scopes: { CMISSED: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.map((a) => a.address)).toEqual(['CMISSED'])
    expect(d.status).toBe('partial')
  })

  it('never upgrades partial to complete just because every hint verifies', async () => {
    const row = { address: 'CAGENT1', kind: 'deposit' }
    const s = seams({
      clientResult: client({ status: 'partial', agents: [row] }),
      cache: ['CAGENT1'],
      rpc: ['CAGENT1'],
      registry: ['CAGENT1'],
      scopes: { CAGENT1: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('partial')
  })

  it('keeps a bridge association marked unknown as unknown in the envelope', async () => {
    const row = { address: 'CAGENT1', kind: 'unknown', association: 'unknown', baseChildren: [] }
    const s = seams({ clientResult: client({ agents: [row] }), scopes: { CAGENT1: scope() } })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents[0].association).toBe('unknown')
  })

  it('reports hint counts as additive evidence', async () => {
    const s = seams({
      clientResult: client({ agents: [] }),
      cache: ['C1'],
      rpc: ['C2'],
      registry: ['C3'],
      vault: ['C4'],
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.hints).toEqual({
      localCacheCount: 1,
      rpcEventCount: 1,
      registryCount: 1,
      vaultVerifiedCount: 1,
      unverifiedCandidateCount: 1, // C1 is local-cache-only with no scope entry -> dropped, not a row
    })
  })

  it('returns unavailable with no owner, never guessing a demo/view-as address', async () => {
    const d = await discoverOwnerScopes({ owner: null })
    expect(d).toEqual({
      status: 'unavailable',
      networkId: DEFAULT_NETWORK_ID,
      owner: null,
      agents: [],
      coverage: null,
      hints: {
        localCacheCount: 0,
        rpcEventCount: 0,
        registryCount: 0,
        vaultVerifiedCount: 0,
        unverifiedCandidateCount: 0,
      },
    })
  })

  it('adds a verified vault-discovery candidate the API missed and downgrades a complete status', async () => {
    // app.jsx's live positions poll already falls back to discoverAgentsFromVault when router
    // events and the registry both come up empty (app.jsx:845) — the envelope must not be
    // strictly narrower on-chain than the path it supersedes (scopeRehydrate.js:91-93 documents
    // the incident this guards: two agents holding 100 USDC that every withdraw list missed
    // because the union stopped short of this channel).
    const s = seams({
      clientResult: client({ status: 'complete', agents: [] }),
      vault: ['CVAULTFOUND'],
      scopes: { CVAULTFOUND: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.map((a) => a.address)).toEqual(['CVAULTFOUND'])
    expect(d.status).toBe('partial')
  })

  it('degrades gracefully when the vault-discovery channel throws, and never throws out of discoverOwnerScopes', async () => {
    const s = seams({
      clientResult: {
        status: 'unavailable',
        networkId: NETWORK,
        owner: OWNER,
        agents: [],
        coverage: null,
      },
    })
    s.discoverVaultAgents = async () => {
      throw new Error('rpc getEvents failed')
    }
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('unavailable')
    expect(d.agents).toEqual([])
    expect(d.hints.vaultVerifiedCount).toBe(0) // failed channel reports a zero count, not silence
  })

  it('degrades gracefully when rpcServer() itself throws, and never throws out of discoverOwnerScopes', async () => {
    rpcServerMock.mockRejectedValueOnce(new Error('stellar-sdk failed to load'))
    const { server: _omit, ...s } = seams({
      clientResult: {
        status: 'unavailable',
        networkId: NETWORK,
        owner: OWNER,
        agents: [],
        coverage: null,
      },
    }) // omit `server` so the internal `server || await rpcServer()` branch actually runs
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('unavailable')
    expect(d.agents).toEqual([])
  })

  it('never references a demo agent fallback', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./ownerDiscovery.js', import.meta.url), 'utf8')
    )
    expect(src).not.toMatch(/SOROBAN_DEMO_AGENT/)
  })
})

// My Money Task 13, Part B item 6: RouterDeployedEvent's own `cap` (fetchRouterDeployedEvents,
// decodeDeployedEvent) used to be discarded one line after `addCandidate(ev.agent, SOURCE_RPC)` —
// AgentTeam.jsx rendered a permanent "Cap: Unavailable" as a direct result, even on a scope-known
// row this same RPC event proved a cap for. These prove the field actually survives to the
// finished row, for both a scope-known AND a scope-read-failed row (the two branches that push to
// `agents`) — a fix that only touched one branch would still leave the other regressed.
describe('discoverOwnerScopes — cap carried from RouterDeployedEvent onto the agent row', () => {
  it('a scope-known row carries the RPC event cap as a string (never a raw bigint in the envelope)', async () => {
    const s = seams({
      clientResult: client({ status: 'complete', agents: [] }),
      rpc: [{ agent: 'CAGENT1', cap: 5_000_0000000n }],
      scopes: { CAGENT1: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    const row = d.agents.find((a) => a.address === 'CAGENT1')
    expect(row.cap).toBe('50000000000')
    expect(typeof row.cap).toBe('string')
  })

  it('a scope-read-failure row (chain-derived, retained per the CFAIL rule) still carries its cap', async () => {
    const s = seams({
      clientResult: client({ status: 'complete', agents: [] }),
      rpc: [{ agent: 'CAGENT2', cap: 900n }],
      scopes: {}, // readScope returns null for CAGENT2 -> scopeReadStatus:'failed' branch
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    const row = d.agents.find((a) => a.address === 'CAGENT2')
    expect(row.scopeReadStatus).toBe('failed')
    expect(row.cap).toBe('900')
  })

  it('an agent no RouterDeployedEvent ever mentioned carries cap:null, never a fabricated 0', async () => {
    const row = { address: 'CAGENT3', kind: 'deposit' }
    const s = seams({
      clientResult: client({ status: 'complete', agents: [row] }),
      scopes: { CAGENT3: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.find((a) => a.address === 'CAGENT3').cap).toBeNull()
  })

  it('a cap of literal 0 is carried through (falsy but real -- must not collapse to null)', async () => {
    const s = seams({
      clientResult: client({ status: 'complete', agents: [] }),
      rpc: [{ agent: 'CAGENT4', cap: 0n }],
      scopes: { CAGENT4: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.agents.find((a) => a.address === 'CAGENT4').cap).toBe('0')
  })
})

describe('discoverOwnerScopes — bounded, abortable scope hydration', () => {
  function indexedRows(count) {
    return Array.from({ length: count }, (_, index) => ({
      address: `CINDEXED${String(index).padStart(3, '0')}`,
      kind: 'deposit',
      baseChildren: [],
    }))
  }

  async function waitUntil(predicate) {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (predicate()) return
      await Promise.resolve()
    }
    throw new Error('condition was not reached')
  }

  it('caps 501 individual scope RPCs at eight and preserves address order and failed-row fallback', async () => {
    const rows = indexedRows(501)
    let active = 0
    let peak = 0
    const readScope = async (address) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      if (address === rows[250].address) throw new Error('scope RPC failed')
      return scope()
    }

    const result = await discoverOwnerScopes({
      owner: OWNER,
      ...seams({ clientResult: client({ status: 'complete', agents: rows }) }),
      readScope,
    })

    expect(peak).toBe(8)
    expect(result.agents.map((row) => row.address)).toEqual(rows.map((row) => row.address))
    expect(result.agents[250].scopeReadStatus).toBe('failed')
    expect(result.status).toBe('partial')
  })

  it('keeps aggregate Stellar activity at eight when vault verification overlaps other discovery channels', async () => {
    let active = 0
    let peak = 0
    const rpc = async (delay = 0) => {
      active += 1
      peak = Math.max(peak, active)
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      else await Promise.resolve()
      active -= 1
    }
    const s = seams({ clientResult: client({ status: 'complete', agents: [] }) })
    s.fetchRpcEvents = async () => {
      await rpc(5)
      return []
    }
    s.queryRegistry = async () => {
      await rpc(5)
      return []
    }
    s.discoverVaultAgents = async () => {
      await Promise.all(Array.from({ length: 8 }, () => rpc()))
      return []
    }

    await discoverOwnerScopes({ owner: OWNER, ...s })

    expect(peak).toBe(8)
  })

  it('propagates abort and never starts queued scope RPCs for the old owner', async () => {
    const rows = indexedRows(501)
    const controller = new AbortController()
    const started = []
    const gates = Array.from({ length: 8 }, () => {
      let resolve
      const promise = new Promise((res) => {
        resolve = res
      })
      return { promise, resolve }
    })
    const operation = discoverOwnerScopes({
      owner: OWNER,
      ...seams({ clientResult: client({ status: 'complete', agents: rows }) }),
      signal: controller.signal,
      readScope: async (_address, _options) => {
        const call = started.length
        started.push(call)
        if (call < gates.length) await gates[call].promise
        return scope()
      },
    })

    await waitUntil(() => started.length >= 8)
    const reason = new Error('owner switched')
    controller.abort(reason)
    for (const gate of gates) gate.resolve()

    await expect(operation).rejects.toBe(reason)
    expect(started).toHaveLength(8)
  })
})
