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

describe('fetchOwnerAgentIndex', () => {
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
