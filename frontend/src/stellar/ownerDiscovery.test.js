import { describe, it, expect, vi } from 'vitest'
import { discoverOwnerScopes, DEFAULT_NETWORK_ID } from './ownerDiscovery.js'

const OWNER = 'GOWNER234567234567234567234567234567234567234567234567AB'
const NETWORK = DEFAULT_NETWORK_ID

function client(overrides = {}) {
  return {
    status: 'partial',
    networkId: NETWORK,
    owner: OWNER,
    agents: [],
    coverage: {
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
    },
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

function seams({ clientResult = client(), cache = [], rpc = [], registry = [], scopes = {} } = {}) {
  return {
    server: {},
    fetchClient: vi.fn(async () => clientResult),
    loadCache: () => cache.map((agentAddress) => ({ agentAddress })),
    fetchRpcEvents: async () => rpc.map((agent) => ({ agent })),
    queryRegistry: async () => registry,
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
      clientResult: { status: 'unavailable', networkId: NETWORK, owner: OWNER, agents: [], coverage: null },
      cache: ['CAGENT1'],
      scopes: { CAGENT1: scope() },
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.status).toBe('partial')
    expect(d.agents).toHaveLength(1)
  })

  it('reports unavailable, never `complete + []`, when the API is down and no hint exists', async () => {
    const s = seams({
      clientResult: { status: 'unavailable', networkId: NETWORK, owner: OWNER, agents: [], coverage: null },
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
    })
    const d = await discoverOwnerScopes({ owner: OWNER, ...s })
    expect(d.hints).toEqual({ localCacheCount: 1, rpcEventCount: 1, registryCount: 1 })
  })

  it('returns unavailable with no owner, never guessing a demo/view-as address', async () => {
    const d = await discoverOwnerScopes({ owner: null })
    expect(d).toEqual({
      status: 'unavailable',
      networkId: DEFAULT_NETWORK_ID,
      owner: null,
      agents: [],
      coverage: null,
      hints: { localCacheCount: 0, rpcEventCount: 0, registryCount: 0 },
    })
  })

  it('never references a demo agent fallback', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./ownerDiscovery.js', import.meta.url), 'utf8')
    )
    expect(src).not.toMatch(/SOROBAN_DEMO_AGENT/)
  })
})
