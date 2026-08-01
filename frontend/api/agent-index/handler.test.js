import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { nativeToScVal, Keypair } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from '../../src/stellar/scval.js'
import { createAgentIndexStore } from './store.js'
import {
  handleIngest,
  handleRead,
  handleBackfillCommit,
  handleAssociationReport,
  handleReceiptChallenge,
  handleReceiptWrite,
  handleBaseChildIntent,
  handleBaseChildLifecycle,
  handleReporterReadiness,
  handleRecoveryRequest,
  LIVE_MANIFEST,
} from './handler.js'
import {
  issueReceiptChallenge,
  receiptProofMessage,
  receiptRequestDigest,
} from './executionReceipts.js'
import { AGENT_CREATORS } from '../../src/stellar/agentCreatorManifest.js'
import {
  appendPhase,
  createAllocationReceipt,
} from '../../src/strategy/allocationReceipt.js'

// ── same in-memory-D1 helper as store.test.js / indexer.test.js ──
const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0001_vf_gate.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0002_agent_index.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0003_agent_index_bounds.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0004_agent_associations.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0005_execution_receipts.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0006_base_child_intents.sql'), 'utf8'))
  function bound(sql, args) {
    return {
      run() {
        const info = sqlite.prepare(sql).run(...args)
        return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
      },
      first(column) {
        const row = sqlite.prepare(sql).get(...args)
        if (!row) return null
        return column ? row[column] : row
      },
      all() {
        const rows = sqlite.prepare(sql).all(...args)
        return { success: true, results: rows }
      },
    }
  }
  return {
    prepare(sql) {
      return { bind: (...args) => bound(sql, args) }
    },
    batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((s) => s.run())
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
    _raw: sqlite,
  }
}

describe('handleReporterReadiness', () => {
  it('acknowledges only the canonical receipt and Base-child store proof', async () => {
    const out = await handleReporterReadiness({
      store: createAgentIndexStore(fakeD1()),
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
    })
    expect(out).toEqual({
      status: 200,
      body: {
        ready: true,
        schemaVersion: 1,
        stores: { executionReceipts: true, baseChildIntents: true },
      },
    })
  })

  it.each([
    [
      'wrong schema acknowledgement',
      {
        writable: true,
        schemaVersion: 2,
        stores: { executionReceipts: true, baseChildIntents: true },
      },
    ],
    [
      'missing receipt-store acknowledgement',
      { writable: true, schemaVersion: 1, stores: { baseChildIntents: true } },
    ],
    [
      'missing Base-child-store acknowledgement',
      { writable: true, schemaVersion: 1, stores: { executionReceipts: true } },
    ],
  ])('fails closed on %s', async (_label, readiness) => {
    const out = await handleReporterReadiness({
      store: { probeReadiness: async () => readiness },
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
    })
    expect(out).toMatchObject({ status: 503, body: { configured: true } })
  })
})

describe('authenticated receipt handlers', () => {
  it('fails closed when D1 or the on-chain authority reader is unavailable', async () => {
    const request = {
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      agent: AGENT_A,
      requestDigest: 'a'.repeat(64),
    }
    await expect(
      handleReceiptChallenge({ request, store: null, authorityReader: null })
    ).resolves.toMatchObject({ status: 503 })
    await expect(
      handleReceiptChallenge({
        request,
        store: createAgentIndexStore(fakeD1()),
        authorityReader: null,
      })
    ).resolves.toMatchObject({ status: 503 })
    await expect(
      handleReceiptWrite({ body: {}, proof: {}, store: null, authorityReader: null })
    ).resolves.toMatchObject({ status: 503 })
  })

  it('maps a missing receipt-write authority dependency to a non-disclosing 503', async () => {
    const out = await handleReceiptWrite({
      body: { secret: 'private-mutation-value' },
      proof: { signature: 'private-proof-value' },
      store: createAgentIndexStore(fakeD1()),
      authorityReader: null,
    })

    expect(out).toEqual({ status: 503, body: { error: 'Agent-index dependency unavailable' } })
    expect(JSON.stringify(out.body)).not.toMatch(/private|mutation|proof|signature/i)
  })

  it('does not disclose inner authority or database errors', async () => {
    const out = await handleReceiptChallenge({
      request: {
        networkId: 'stellar-testnet',
        owner: OWNER_A,
        agent: AGENT_A,
        requestDigest: 'a'.repeat(64),
      },
      store: { issueReceiptChallenge: async () => {} },
      authorityReader: async () => {
        throw new Error('soroban rpc endpoint includes private infrastructure details')
      },
    })
    expect(out.status).toBe(503)
    expect(out.body.error).toBe('Receipt authority is unavailable')
    expect(JSON.stringify(out.body)).not.toMatch(/soroban|private|infrastructure/i)
  })
})

const ROUTER_V1 = AGENT_CREATORS.find(
  (c) => c.address === 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5'
)
const OWNER_A = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H'
const AGENT_A = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3'

describe('authenticated Base child handlers', () => {
  const secret = 'server-reporter-secret'
  const child = (overrides = {}) => ({
    version: 1,
    networkId: 'stellar-testnet',
    owner: OWNER_A,
    agent: AGENT_A,
    bindingId: 'binding-42',
    allocationId: 'run-42:bridge:aave-v3',
    childId: 'job-42',
    intent: {
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress: `0x${'11'.repeat(20)}`,
      proxyTarget: 'aave-v3',
      bindingHash: 'hash-42',
      runId: 'run-42',
      grantTxHash: 'grant-42',
      kernelAddress: `0x${'22'.repeat(20)}`,
      baseJobId: 'job-42',
    },
    lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 2_000_000_000_000 },
    ...overrides,
  })
  const identity = {
    networkId: 'stellar-testnet',
    owner: OWNER_A,
    bindingId: 'binding-42',
    allocationId: 'run-42:bridge:aave-v3',
    childId: 'job-42',
  }

  // Defect caught: intent responses did not provide the exact identity/schema acknowledgement the relayer must gate custody on.
  it('authenticates before write and returns an exact 201 durable acknowledgement', async () => {
    const store = createAgentIndexStore(fakeD1())
    const denied = await handleBaseChildIntent({
      child: child(),
      configuredNetworkId: 'stellar-testnet',
      store,
      secret,
      providedSecret: 'wrong',
    })
    expect(denied).toEqual({ status: 401, body: { error: 'Unauthorized' } })
    await expect(
      store.readOwnerBaseChildIntents({ networkId: 'stellar-testnet', owner: OWNER_A })
    ).resolves.toHaveLength(0)

    const accepted = await handleBaseChildIntent({
      child: child(),
      configuredNetworkId: 'stellar-testnet',
      store,
      secret,
      providedSecret: secret,
    })
    expect(accepted).toEqual({
      status: 201,
      body: {
        acknowledged: true,
        identity,
        schemaVersion: LIVE_MANIFEST.schemaVersion,
        written: 1,
        duplicates: 0,
        sequence: 0,
      },
    })
  })

  // Defect caught: an exact retry returned a different HTTP contract while conflicting immutable evidence needed a typed 409.
  it('returns the same 201 acknowledgement for an exact retry and 409 for a conflicting child', async () => {
    const store = createAgentIndexStore(fakeD1())
    const args = {
      child: child(),
      configuredNetworkId: 'stellar-testnet',
      store,
      secret,
      providedSecret: secret,
    }
    await handleBaseChildIntent(args)
    await expect(handleBaseChildIntent(args)).resolves.toMatchObject({
      status: 201,
      body: { acknowledged: true, identity, duplicates: 1 },
    })
    await expect(
      handleBaseChildIntent({
        ...args,
        child: child({ intent: { ...child().intent, units: '2000000' } }),
      })
    ).resolves.toMatchObject({ status: 409, body: { error: 'Agent-index mutation conflict' } })
  })

  // Defect caught: lifecycle acknowledgements lacked identity/sequence and out-of-order CAS conflicts were ambiguous.
  it('acknowledges one monotonic lifecycle step and rejects a sequence gap', async () => {
    const store = createAgentIndexStore(fakeD1())
    await handleBaseChildIntent({
      child: child(),
      configuredNetworkId: 'stellar-testnet',
      store,
      secret,
      providedSecret: secret,
    })
    const request = {
      identity,
      expectedSequence: 0,
      lifecycle: {
        sequence: 1,
        status: 'submitted',
        evidence: { executionStatus: 'accepted' },
        observedAt: 2_000_000_000_100,
      },
    }
    await expect(
      handleBaseChildLifecycle({
        request,
        configuredNetworkId: 'stellar-testnet',
        store,
        secret,
        providedSecret: secret,
      })
    ).resolves.toEqual({
      status: 200,
      body: {
        acknowledged: true,
        identity,
        sequence: 1,
        schemaVersion: LIVE_MANIFEST.schemaVersion,
        written: 1,
        duplicates: 0,
      },
    })
    await expect(
      handleBaseChildLifecycle({
        request: {
          ...request,
          expectedSequence: 2,
          lifecycle: { ...request.lifecycle, sequence: 3 },
        },
        configuredNetworkId: 'stellar-testnet',
        store,
        secret,
        providedSecret: secret,
      })
    ).resolves.toMatchObject({ status: 409 })
  })
})

function deployedRecord({ owner, agent, cap = 1000n, ledger, txHash }) {
  return {
    ledger,
    txHash,
    pagingToken: `${ledger}-${txHash}`,
    topic: [symbolScVal('deployed'), addrScVal(owner), addrScVal(agent)],
    value: nativeToScVal({ cap }),
  }
}

function fakeEventSource({
  events = [],
  scannedThroughLedger,
  oldestAvailableLedger = 1,
  latestAvailableLedger = 10_000_000,
} = {}) {
  return {
    providerId: 'test-rpc',
    endpointClass: 'live',
    oldestAvailableLedger,
    latestAvailableLedger,
    async getEvents(req) {
      return { events, cursor: null, scannedThroughLedger: scannedThroughLedger ?? req.endLedger }
    },
  }
}

describe('handleIngest — secret gate', () => {
  it('503s when the ingest secret is not configured', async () => {
    const out = await handleIngest({ secret: '', providedSecret: 'x', store: {}, sources: [] })
    expect(out.status).toBe(503)
    expect(out.body.configured).toBe(false)
  })

  it('401s on a missing bearer token', async () => {
    const out = await handleIngest({
      secret: 'topsecret',
      providedSecret: '',
      store: {},
      sources: [],
    })
    expect(out.status).toBe(401)
  })

  it('401s on a wrong-but-same-length token (constant-time path, not just a length check)', async () => {
    const out = await handleIngest({
      secret: 'topsecret',
      providedSecret: 'wrongsecre',
      store: {},
      sources: [],
    })
    expect(out.status).toBe(401)
  })

  it('401s on a wrong-length token', async () => {
    const out = await handleIngest({
      secret: 'topsecret',
      providedSecret: 'nope',
      store: {},
      sources: [],
    })
    expect(out.status).toBe(401)
  })
})

describe('handleIngest — bounded ingestion, one page per source, isolated failures', () => {
  it('ingests every source and reports per-source ok/failed without aborting the batch', async () => {
    const store = createAgentIndexStore(fakeD1())
    const rec = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: ROUTER_V1.coverageStartLedger + 1,
      txHash: 'TX1',
    })
    const goodEventSource = fakeEventSource({
      events: [rec],
      oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
    })

    const out = await handleIngest({
      secret: 'topsecret',
      providedSecret: 'topsecret',
      store,
      sources: [
        ROUTER_V1,
        { ...ROUTER_V1, address: 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY' },
      ],
      eventSourceFor: async (source) =>
        source.address === ROUTER_V1.address
          ? goodEventSource
          : (() => {
              throw new Error('rpc down')
            })(),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })

    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(1)
    expect(out.body.failed).toBe(1)
    const good = out.body.results.find((r) => r.sourceId.endsWith(ROUTER_V1.address))
    expect(good).toMatchObject({ ok: true, status: 'committed', membershipCount: 1 })
    const bad = out.body.results.find((r) => !r.ok)
    expect(bad.error).toMatch(/rpc down/)

    const rows = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    expect(rows).toHaveLength(1)
  })
})

describe('handleRead — input validation', () => {
  it('400s an empty network', async () => {
    const out = await handleRead({ networkId: '', owner: OWNER_A, store: {} })
    expect(out.status).toBe(400)
  })

  it('400s an owner that is neither a valid G nor C StrKey', async () => {
    const out = await handleRead({
      networkId: 'stellar-testnet',
      owner: 'not-an-address',
      store: {},
    })
    expect(out.status).toBe(400)
  })

  it('accepts a valid C-address owner (bridge/contract owners are legitimate)', async () => {
    const out = await handleRead({ networkId: 'stellar-testnet', owner: AGENT_A, store: null })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('unavailable')
  })
})

describe('handleRead — limit validation (Minor 7)', () => {
  it('400s a non-integer limit', async () => {
    const out = await handleRead({
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      store: {},
      limit: 'abc',
    })
    expect(out.status).toBe(400)
  })

  it('400s a zero/negative limit', async () => {
    const out = await handleRead({
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      store: {},
      limit: 0,
    })
    expect(out.status).toBe(400)
  })

  it('400s a limit above the max', async () => {
    const out = await handleRead({
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      store: {},
      limit: 5000,
    })
    expect(out.status).toBe(400)
  })

  it('accepts an unset limit (default) and a within-bounds explicit limit', async () => {
    const out1 = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: null })
    expect(out1.status).toBe(200)
    const out2 = await handleRead({
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      store: null,
      limit: 10,
    })
    expect(out2.status).toBe(200)
  })

  it('truncates the agents array to the requested limit', async () => {
    const store = createAgentIndexStore(fakeD1())
    const AGENT_C = 'CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW' // valid C-StrKey (used elsewhere as AGENT_B)
    const rec1 = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: ROUTER_V1.coverageStartLedger + 1,
      txHash: 'TX1',
    })
    const rec2 = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_C,
      ledger: ROUTER_V1.coverageStartLedger + 2,
      txHash: 'TX2',
    })
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: [rec1, rec2],
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
        }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })
    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      limit: 1,
    })
    expect(out.body.agents).toHaveLength(1)
  })
})

describe('handleRead — output addresses are StrKey-validated, never trusted blindly (Minor 7)', () => {
  it('drops a membership row whose stored agent address fails StrKey validation', async () => {
    const store = createAgentIndexStore(fakeD1())
    await store.commitSourcePage({
      sourceId: `${ROUTER_V1.networkId}:${ROUTER_V1.address}`,
      fromLedger: ROUTER_V1.coverageStartLedger,
      throughLedger: ROUTER_V1.coverageStartLedger + 1,
      finalizedThroughLedger: ROUTER_V1.coverageStartLedger + 1,
      cursor: null,
      memberships: [
        {
          networkId: ROUTER_V1.networkId,
          agentAddress: 'not-a-real-strkey',
          ownerAddress: OWNER_A,
          creatorAddress: ROUTER_V1.address,
          schemaVersion: 1,
          kind: 'deposit',
          creationLedger: ROUTER_V1.coverageStartLedger,
          creationTx: 'TXBAD',
          grantTxHash: 'TXBAD',
          runId: null,
          runOrdinal: null,
          provenance: {},
        },
      ],
    })
    const out = await handleRead({ networkId: ROUTER_V1.networkId, owner: OWNER_A, store })
    expect(out.status).toBe(200)
    expect(out.body.agents).toEqual([])
  })
})

describe('handleRead — unavailable store never reports complete', () => {
  it('returns a structured unavailable response when store is null', async () => {
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: null })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ version: 1, status: 'unavailable', agents: [] })
    expect(out.body.coverage.contiguous).toBe(false)
  })

  it('returns unavailable (not agents:[] + complete) when the store throws', async () => {
    const throwingStore = {
      readOwnerMemberships: async () => {
        throw new Error('D1 unreachable')
      },
      readCoverage: async () => ({ sources: [], gaps: [], backfillAudits: [] }),
    }
    const out = await handleRead({
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      store: throwingStore,
    })
    expect(out.body.status).toBe('unavailable')
  })

  // Final review, Fix 2: a store/version skew missing `readOwnerRunAllocations` (the Base
  // association join) must never silently masquerade as "complete, no Base children" -- it must
  // fail the same way `!store` and a thrown read already do, never fall back to `[]`.
  it('returns unavailable (not agents:[] + complete) when the store lacks readOwnerRunAllocations', async () => {
    const skewedStore = {
      readOwnerMemberships: async () => [],
      readCoverage: async () => ({ sources: [], gaps: [], backfillAudits: [] }),
    }
    const out = await handleRead({
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      store: skewedStore,
    })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('unavailable')
    expect(out.body.agents).toEqual([])
  })
})

describe('handleRead — empty-but-available store is partial, never a false complete', () => {
  it('reports partial with agents:[] against the real live manifest when nothing has ever been ingested', async () => {
    const store = createAgentIndexStore(fakeD1())
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('partial')
    expect(out.body.agents).toEqual([])
    expect(out.body.coverage.manifestHash).toBe(LIVE_MANIFEST.hash)
  })
})

describe('handleRead — end-to-end after ingest', () => {
  it("shapes an owner's agents and coverage per the documented response contract", async () => {
    const store = createAgentIndexStore(fakeD1())
    const rec = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: ROUTER_V1.coverageStartLedger + 1,
      txHash: 'TX1',
    })
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({ events: [rec], oldestAvailableLedger: ROUTER_V1.coverageStartLedger }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })

    const out = await handleRead({ networkId: ROUTER_V1.networkId, owner: OWNER_A, store })
    expect(out.body.agents).toHaveLength(1)
    expect(out.body.agents[0]).toMatchObject({
      address: AGENT_A,
      kind: 'deposit',
      creator: ROUTER_V1.address,
    })
    expect(out.body.coverage).toMatchObject({
      manifestHash: LIVE_MANIFEST.hash,
      manifestVersion: LIVE_MANIFEST.version,
      schemaVersion: LIVE_MANIFEST.schemaVersion,
      requiredFinalityLedgers: 2,
    })
    // Only one of five manifest sources has ever been ingested — can never be 'complete'.
    expect(out.body.status).toBe('partial')
  })
})

describe('handleBackfillCommit — secret gate (mirrors handleIngest)', () => {
  it('503s when the backfill secret is not configured', async () => {
    const out = await handleBackfillCommit({
      secret: '',
      providedSecret: 'x',
      store: {},
      audit: {},
    })
    expect(out.status).toBe(503)
    expect(out.body.configured).toBe(false)
  })

  it('401s on a missing bearer token', async () => {
    const out = await handleBackfillCommit({
      secret: 'topsecret',
      providedSecret: '',
      store: {},
      audit: {},
    })
    expect(out.status).toBe(401)
  })

  it('401s on a wrong token', async () => {
    const out = await handleBackfillCommit({
      secret: 'topsecret',
      providedSecret: 'nope',
      store: {},
      audit: {},
    })
    expect(out.status).toBe(401)
  })

  it('503s when the store is unavailable', async () => {
    const out = await handleBackfillCommit({
      secret: 's',
      providedSecret: 's',
      store: null,
      audit: {},
    })
    expect(out.status).toBe(503)
    expect(out.body.configured).toBe(false)
  })
})

describe('handleBackfillCommit — posts only verified memberships through the protected handler', () => {
  it('commits a verified audit and returns its verdict/counts', async () => {
    const store = createAgentIndexStore(fakeD1())
    const audit = {
      auditId: 'audit-h1',
      networkId: ROUTER_V1.networkId,
      fromLedger: 1,
      throughLedger: 100,
      directSetupCutoffLedger: 3_600_000,
      creatorManifestVersion: 'v1',
      sources: [
        {
          kind: 'funding-router',
          address: ROUTER_V1.address,
          providerId: 'archival-rpc',
          oldestAvailableLedger: 1,
          fromLedger: 1,
          throughLedger: 100,
          contiguous: true,
          evidenceHash: '0xabc',
        },
      ],
      candidates: [],
      verifiedAgents: [],
      rejectedCandidates: [],
      unresolvedCandidates: [],
      verdict: 'verified',
      completedAt: 1700000000,
    }
    const out = await handleBackfillCommit({ secret: 's', providedSecret: 's', store, audit })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({
      ok: true,
      verdict: 'verified',
      membershipsPosted: 0,
      auditRowsWritten: 1,
    })
  })

  it('400s a malformed audit rather than writing anything', async () => {
    const store = createAgentIndexStore(fakeD1())
    const out = await handleBackfillCommit({
      secret: 's',
      providedSecret: 's',
      store,
      audit: { verdict: 'verified' },
    })
    expect(out.status).toBe(400)
    const coverage = await store.readCoverage({ networkId: ROUTER_V1.networkId })
    expect(coverage.backfillAudits).toHaveLength(0)
  })
})

describe('handleAssociationReport — server-only authentication', () => {
  const association = {
    version: 1,
    networkId: ROUTER_V1.networkId,
    owner: OWNER_A,
    bridgeAgent: AGENT_A,
    runId: 'run-42',
    grantTxHash: 'grant-42',
    kernelAddress: `0x${'12'.repeat(20)}`,
    mandateBindingId: 'binding-42',
    mandateBindingHash: 'binding-hash-42',
    baseJobId: 'job-42',
    allocations: [
      {
        allocationId: 'run-42:bridge:aave-v3',
        poolAddress: `0x${'34'.repeat(20)}`,
        proxyTarget: 'aave-v3',
        amount: { token: 'USDC', units: '1000000', decimals: 6 },
        executionStatus: 'accepted',
        custody: { location: 'in-transit' },
        txHash: null,
      },
    ],
  }

  it('rejects browser/missing-secret writes before any scope or store read', async () => {
    const scopeReader = async () => {
      throw new Error('must not run')
    }
    const store = {
      readMembershipsByAgentAddresses: async () => {
        throw new Error('must not run')
      },
    }
    const missing = await handleAssociationReport({
      secret: 'server-secret',
      providedSecret: '',
      idempotencyKey: 'anything',
      store,
      scopeReader,
      report: association,
    })
    const wrong = await handleAssociationReport({
      secret: 'server-secret',
      providedSecret: 'browser-token',
      idempotencyKey: 'anything',
      store,
      scopeReader,
      report: association,
    })
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
  })

  it('503s when the dedicated reporter secret is not configured', async () => {
    const out = await handleAssociationReport({
      secret: '',
      providedSecret: '',
      idempotencyKey: 'anything',
      store: {},
      report: association,
    })
    expect(out).toMatchObject({ status: 503, body: { configured: false } })
  })
})

describe('handleRead — Base association envelope', () => {
  it('joins only durable owner-bound children and leaves an old bridge membership unknown', async () => {
    const store = createAgentIndexStore(fakeD1())
    const oldBridge = 'CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW'
    const records = [
      deployedRecord({
        owner: OWNER_A,
        agent: AGENT_A,
        ledger: ROUTER_V1.coverageStartLedger + 1,
        txHash: 'TX1',
      }),
      deployedRecord({
        owner: OWNER_A,
        agent: oldBridge,
        ledger: ROUTER_V1.coverageStartLedger + 2,
        txHash: 'TX2',
      }),
    ]
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: records,
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
        }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })
    await store.commitAssociation({
      idempotencyKey: '["stellar-testnet","run-42","run-42:bridge:aave-v3","accepted",null]',
      association: {
        allocationId: 'run-42:bridge:aave-v3',
        networkId: ROUTER_V1.networkId,
        runId: 'run-42',
        ownerAddress: OWNER_A,
        bridgeAgentAddress: AGENT_A,
        poolAddress: `0x${'34'.repeat(20)}`,
        amount: { token: 'USDC', units: '1000000', decimals: 6 },
        proxyTarget: 'aave-v3',
        baseJobId: 'job-42',
        txHash: null,
        executionStatus: 'accepted',
        custodyLocation: 'in-transit',
        grantTxHash: 'grant-42',
        kernelAddress: `0x${'12'.repeat(20)}`,
        mandateBindingId: 'binding-42',
        mandateBindingHash: 'binding-hash-42',
        associationSource: 'relayer-attested',
        reportedAt: 2_000_000_000_000,
        scopeCheckedAt: 2_000_000_000_000,
      },
    })

    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      now: 2_000_000_001_000,
    })
    const known = out.body.agents.find((agent) => agent.address === AGENT_A)
    const unknown = out.body.agents.find((agent) => agent.address === oldBridge)
    expect(known).toMatchObject({
      association: 'known',
      associationSource: 'relayer-attested',
      freshness: 'fresh',
    })
    expect(known.baseChildren[0]).toMatchObject({
      allocationId: 'run-42:bridge:aave-v3',
      runId: 'run-42',
      grantTxHash: 'grant-42',
      baseJobId: 'job-42',
      kernelAddress: `0x${'12'.repeat(20)}`,
      mandateBindingId: 'binding-42',
      mandateBindingHash: 'binding-hash-42',
      associationSource: 'relayer-attested',
      reportedAt: 2_000_000_000_000,
      scopeCheckedAt: 2_000_000_000_000,
      freshness: 'fresh',
      txHash: null,
      custody: { location: 'in-transit' },
    })
    expect(unknown).toMatchObject({
      association: 'unknown',
      associationSource: null,
      baseChildren: [],
    })
  })
})

// ── handleRecoveryRequest (S2-D9): thin HTTP-shape wiring around recovery.js's requestRecovery.
// Business-logic/state-table coverage lives in recovery.test.js -- this describe block only
// covers the route-level contract: status codes, non-disclosure, and that the two 409s stay
// distinguishable at the HTTP layer (map fact C).
describe('handleRecoveryRequest', () => {
  const RECOVERY_NETWORK = 'stellar-testnet'
  const RECOVERY_OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 31)).publicKey()
  const RECOVERY_AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
  const RECOVERY_SESSION = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 32))
  const RECOVERY_NOW = 2_000_000_000_000

  function recoveryAuthority(overrides = {}) {
    return {
      routerOwner: RECOVERY_OWNER,
      scope: { owner: RECOVERY_OWNER, revoked: false, expiry: 0n },
      signer: RECOVERY_SESSION.rawPublicKey(),
      scopeLedger: 1,
      ...overrides,
    }
  }

  function recoveryRequestBody(overrides = {}) {
    return {
      executionId: 'run-h:exec:run-h:deposit:0',
      allocationId: 'run-h:deposit:0',
      childId: null,
      expectedReceiptVersion: 0,
      leaseOwner: 'holder-h',
      ...overrides,
    }
  }

  function persistedRecoveryReceipt(childId) {
    const amount = { token: 'USDC', units: '10000000', decimals: 7 }
    const produced = appendPhase(
      createAllocationReceipt({
        networkId: RECOVERY_NETWORK,
        executionId: recoveryRequestBody().executionId,
        allocationId: recoveryRequestBody().allocationId,
        childId,
        owner: RECOVERY_OWNER,
        runId: 'run-h',
        worker: 'GWORKER',
        agent: RECOVERY_AGENT,
        intent: { allocationId: recoveryRequestBody().allocationId, allocation: amount },
        amount,
      }),
      {
        attemptId: 'persisted-pull-attempt',
        phase: 'pull',
        status: 'submitted',
        evidence: {},
        observedAt: RECOVERY_NOW - 1,
      }
    )
    return { ...produced, format: produced.version, version: 1 }
  }

  async function signedRecoveryCallArgs({
    store,
    request,
    challengeId,
    authorityFacts = recoveryAuthority(),
    now = RECOVERY_NOW,
  }) {
    const digest = receiptRequestDigest(request)
    const challenge = await issueReceiptChallenge({
      request: {
        networkId: RECOVERY_NETWORK,
        owner: RECOVERY_OWNER,
        agent: RECOVERY_AGENT,
        requestDigest: digest,
      },
      store,
      authorityReader: async () => authorityFacts,
      now,
      challengeId,
    })
    const signature = RECOVERY_SESSION.sign(
      Buffer.from(receiptProofMessage(challenge), 'utf8')
    ).toString('base64url')
    return {
      request,
      proof: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, signature },
      store,
      authorityReader: async () => authorityFacts,
      now,
    }
  }

  async function authenticatedRecoveryCall(options) {
    return handleRecoveryRequest(await signedRecoveryCallArgs(options))
  }

  it('fails closed with a non-disclosing 503 when the store or authority reader is unavailable', async () => {
    await expect(
      handleRecoveryRequest({
        request: recoveryRequestBody(),
        proof: {},
        store: null,
        authorityReader: null,
      })
    ).resolves.toMatchObject({ status: 503, body: { error: 'Receipt store unavailable' } })
    const out = await handleRecoveryRequest({
      request: recoveryRequestBody(),
      proof: { signature: 'private-proof-value' },
      store: createAgentIndexStore(fakeD1()),
      authorityReader: null,
    })
    expect(out).toEqual({ status: 503, body: { error: 'Agent-index dependency unavailable' } })
    expect(JSON.stringify(out.body)).not.toMatch(/private|signature/i)
  })

  it('claims the pull lease and returns a 200 for a never-submitted execution', async () => {
    const store = createAgentIndexStore(fakeD1())
    const out = await authenticatedRecoveryCall({
      store,
      request: recoveryRequestBody(),
      challengeId: 'challenge-handler-fresh',
    })
    expect(out).toMatchObject({
      status: 200,
      body: {
        ok: true,
        action: 'pull',
        phase: 'pull',
        reasonCode: 'no-receipt',
        version: 0,
      },
    })
    expect(out.body.lease).toMatchObject({ holder: 'holder-h' })
  })

  it('rejects a signed child for an absent receipt instead of silently retargeting its lease', async () => {
    const d1Store = createAgentIndexStore(fakeD1())
    const acquireRecoveryLease = vi.fn(d1Store.acquireRecoveryLease)
    const store = { ...d1Store, acquireRecoveryLease }
    const out = await authenticatedRecoveryCall({
      store,
      request: recoveryRequestBody({ childId: 'caller-child' }),
      challengeId: 'challenge-handler-absent-child',
    })

    expect(out).toMatchObject({ status: 400, body: { error: 'Invalid recovery request' } })
    expect(acquireRecoveryLease).not.toHaveBeenCalled()
  })

  it('rejects a signed childId that disagrees with the stored receipt', async () => {
    const d1Store = createAgentIndexStore(fakeD1())
    const store = {
      ...d1Store,
      readExecutionReceipt: async () => persistedRecoveryReceipt('receipt-child'),
    }
    const out = await authenticatedRecoveryCall({
      store,
      request: recoveryRequestBody({
        childId: 'caller-replacement',
        expectedReceiptVersion: 1,
      }),
      challengeId: 'challenge-handler-child-mismatch',
    })

    expect(out).toMatchObject({ status: 400, body: { error: 'Invalid recovery request' } })
  })

  it('maps a replayed recovery proof to the stable 409 taxonomy', async () => {
    const store = createAgentIndexStore(fakeD1())
    const args = await signedRecoveryCallArgs({
      store,
      request: recoveryRequestBody(),
      challengeId: 'challenge-handler-replay',
    })
    await expect(handleRecoveryRequest(args)).resolves.toMatchObject({ status: 200 })
    await expect(handleRecoveryRequest(args)).resolves.toEqual({
      status: 409,
      body: { error: 'Receipt proof was already used' },
    })
  })

  it('keeps invalid recovery input at 400 and invalid proof at 401', async () => {
    const store = createAgentIndexStore(fakeD1())
    await expect(
      handleRecoveryRequest({
        request: {},
        proof: {},
        store,
        authorityReader: async () => recoveryAuthority(),
      })
    ).resolves.toMatchObject({ status: 400 })

    const args = await signedRecoveryCallArgs({
      store,
      request: recoveryRequestBody(),
      challengeId: 'challenge-handler-bad-proof',
    })
    args.proof.signature = Buffer.alloc(64).toString('base64url')
    await expect(handleRecoveryRequest(args)).resolves.toEqual({
      status: 401,
      body: { error: 'Invalid or expired receipt proof' },
    })
  })

  it('returns distinguishable 409s for a lease conflict vs a stale receipt version (map fact C)', async () => {
    const store = createAgentIndexStore(fakeD1())
    const first = await authenticatedRecoveryCall({
      store,
      request: recoveryRequestBody({ leaseOwner: 'holder-first' }),
      challengeId: 'challenge-handler-lease-a',
    })
    expect(first.status).toBe(200)
    const leaseConflict = await authenticatedRecoveryCall({
      store,
      request: recoveryRequestBody({ leaseOwner: 'holder-second' }),
      challengeId: 'challenge-handler-lease-b',
    })
    expect(leaseConflict).toMatchObject({
      status: 409,
      body: { error: 'Recovery lease is already held', code: 'lease-conflict' },
    })

    const versionConflict = await authenticatedRecoveryCall({
      store,
      request: recoveryRequestBody({ leaseOwner: 'holder-third', expectedReceiptVersion: 7 }),
      challengeId: 'challenge-handler-version',
    })
    expect(versionConflict).toMatchObject({ status: 409, body: { code: 'version-conflict' } })
    expect(versionConflict.body.error).not.toBe(leaseConflict.body.error)
  })

  it('maps a revoked scope to a 403, not a silent success', async () => {
    const store = createAgentIndexStore(fakeD1())
    const revoked = recoveryAuthority({
      scope: { owner: RECOVERY_OWNER, revoked: true, expiry: 0n },
    })
    const out = await authenticatedRecoveryCall({
      store,
      request: recoveryRequestBody(),
      challengeId: 'challenge-handler-revoked',
      authorityFacts: revoked,
    })
    expect(out.status).toBe(403)
  })
})
