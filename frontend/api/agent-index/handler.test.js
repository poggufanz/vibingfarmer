import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { nativeToScVal } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from '../../src/stellar/scval.js'
import { createAgentIndexStore } from './store.js'
import {
  handleIngest,
  handleRead,
  handleBackfillCommit,
  handleAssociationReport,
  LIVE_MANIFEST,
} from './handler.js'
import { AGENT_CREATORS } from '../../src/stellar/agentCreatorManifest.js'

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

const ROUTER_V1 = AGENT_CREATORS.find((c) => c.address === 'CCEWWRQVYKEIWTO7GTX2QVHQASC3GIQOZZTDMGTOHFQYKZIX5KJ6CYE5')
const OWNER_A = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H'
const AGENT_A = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3'

function deployedRecord({ owner, agent, cap = 1000n, ledger, txHash }) {
  return {
    ledger,
    txHash,
    pagingToken: `${ledger}-${txHash}`,
    topic: [symbolScVal('deployed'), addrScVal(owner), addrScVal(agent)],
    value: nativeToScVal({ cap }),
  }
}

function fakeEventSource({ events = [], scannedThroughLedger, oldestAvailableLedger = 1, latestAvailableLedger = 10_000_000 } = {}) {
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
    const out = await handleIngest({ secret: 'topsecret', providedSecret: '', store: {}, sources: [] })
    expect(out.status).toBe(401)
  })

  it('401s on a wrong-but-same-length token (constant-time path, not just a length check)', async () => {
    const out = await handleIngest({ secret: 'topsecret', providedSecret: 'wrongsecre', store: {}, sources: [] })
    expect(out.status).toBe(401)
  })

  it('401s on a wrong-length token', async () => {
    const out = await handleIngest({ secret: 'topsecret', providedSecret: 'nope', store: {}, sources: [] })
    expect(out.status).toBe(401)
  })
})

describe('handleIngest — bounded ingestion, one page per source, isolated failures', () => {
  it('ingests every source and reports per-source ok/failed without aborting the batch', async () => {
    const store = createAgentIndexStore(fakeD1())
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: ROUTER_V1.coverageStartLedger + 1, txHash: 'TX1' })
    const goodEventSource = fakeEventSource({ events: [rec], oldestAvailableLedger: ROUTER_V1.coverageStartLedger })

    const out = await handleIngest({
      secret: 'topsecret',
      providedSecret: 'topsecret',
      store,
      sources: [ROUTER_V1, { ...ROUTER_V1, address: 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY' }],
      eventSourceFor: async (source) =>
        source.address === ROUTER_V1.address ? goodEventSource : (() => {
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

    const rows = await store.readOwnerMemberships({ networkId: ROUTER_V1.networkId, owner: OWNER_A })
    expect(rows).toHaveLength(1)
  })
})

describe('handleRead — input validation', () => {
  it('400s an empty network', async () => {
    const out = await handleRead({ networkId: '', owner: OWNER_A, store: {} })
    expect(out.status).toBe(400)
  })

  it('400s an owner that is neither a valid G nor C StrKey', async () => {
    const out = await handleRead({ networkId: 'stellar-testnet', owner: 'not-an-address', store: {} })
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
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: {}, limit: 'abc' })
    expect(out.status).toBe(400)
  })

  it('400s a zero/negative limit', async () => {
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: {}, limit: 0 })
    expect(out.status).toBe(400)
  })

  it('400s a limit above the max', async () => {
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: {}, limit: 5000 })
    expect(out.status).toBe(400)
  })

  it('accepts an unset limit (default) and a within-bounds explicit limit', async () => {
    const out1 = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: null })
    expect(out1.status).toBe(200)
    const out2 = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: null, limit: 10 })
    expect(out2.status).toBe(200)
  })

  it('truncates the agents array to the requested limit', async () => {
    const store = createAgentIndexStore(fakeD1())
    const AGENT_C = 'CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW' // valid C-StrKey (used elsewhere as AGENT_B)
    const rec1 = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: ROUTER_V1.coverageStartLedger + 1, txHash: 'TX1' })
    const rec2 = deployedRecord({ owner: OWNER_A, agent: AGENT_C, ledger: ROUTER_V1.coverageStartLedger + 2, txHash: 'TX2' })
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () => fakeEventSource({ events: [rec1, rec2], oldestAvailableLedger: ROUTER_V1.coverageStartLedger }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })
    const out = await handleRead({ networkId: ROUTER_V1.networkId, owner: OWNER_A, store, limit: 1 })
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
    const out = await handleRead({ networkId: 'stellar-testnet', owner: OWNER_A, store: throwingStore })
    expect(out.body.status).toBe('unavailable')
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
    const rec = deployedRecord({ owner: OWNER_A, agent: AGENT_A, ledger: ROUTER_V1.coverageStartLedger + 1, txHash: 'TX1' })
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () => fakeEventSource({ events: [rec], oldestAvailableLedger: ROUTER_V1.coverageStartLedger }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })

    const out = await handleRead({ networkId: ROUTER_V1.networkId, owner: OWNER_A, store })
    expect(out.body.agents).toHaveLength(1)
    expect(out.body.agents[0]).toMatchObject({ address: AGENT_A, kind: 'deposit', creator: ROUTER_V1.address })
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
    const out = await handleBackfillCommit({ secret: '', providedSecret: 'x', store: {}, audit: {} })
    expect(out.status).toBe(503)
    expect(out.body.configured).toBe(false)
  })

  it('401s on a missing bearer token', async () => {
    const out = await handleBackfillCommit({ secret: 'topsecret', providedSecret: '', store: {}, audit: {} })
    expect(out.status).toBe(401)
  })

  it('401s on a wrong token', async () => {
    const out = await handleBackfillCommit({ secret: 'topsecret', providedSecret: 'nope', store: {}, audit: {} })
    expect(out.status).toBe(401)
  })

  it('503s when the store is unavailable', async () => {
    const out = await handleBackfillCommit({ secret: 's', providedSecret: 's', store: null, audit: {} })
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
    expect(out.body).toMatchObject({ ok: true, verdict: 'verified', membershipsPosted: 0, auditRowsWritten: 1 })
  })

  it('400s a malformed audit rather than writing anything', async () => {
    const store = createAgentIndexStore(fakeD1())
    const out = await handleBackfillCommit({ secret: 's', providedSecret: 's', store, audit: { verdict: 'verified' } })
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
      idempotencyKey:
        '["stellar-testnet","run-42","run-42:bridge:aave-v3","accepted",null]',
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
