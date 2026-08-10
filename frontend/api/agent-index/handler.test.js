import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { nativeToScVal, Keypair, StrKey } from '@stellar/stellar-sdk'
import { symbolScVal, addrScVal } from '../../src/stellar/scval.js'
import { createAgentIndexStore as createProductionAgentIndexStore } from './store.js'
import { validateBaseChildIntentBatch, MAX_BASE_CHILD_BATCH_SIZE } from './associations.js'
import { createOwnerReadCursorCodec } from './readCursor.js'
import {
  handleIngest,
  handleRead,
  handleBackfillCommit,
  handleAssociationReport,
  handleReceiptChallenge,
  handleReceiptWrite,
  handleBaseChildIntent,
  handleBaseChildLifecycle,
  handleBaseChildIntentBatch,
  handleBaseChildEvidenceWrite,
  handleBaseChildEvidenceRead,
  handleReporterReadiness,
  handleRecoveryRequest,
  handleBaseRecoveryRequest,
  handleBaseRecoveryClaim,
  handleBaseRecoveryRenew,
  handleBaseRecoveryRelease,
  LIVE_MANIFEST,
} from './handler.js'
import { selectBaseChildRecoveryAction } from './recovery.js'
import {
  issueReceiptChallenge,
  receiptProofMessage,
  receiptRequestDigest,
} from './executionReceipts.js'
import { AGENT_CREATORS } from '../../src/stellar/agentCreatorManifest.js'
import { appendPhase, createAllocationReceipt } from '../../src/strategy/allocationReceipt.js'
import { aggregateOwnerPositions, readOwnerMoney } from '../../src/money/readOwnerMoney.js'
import { BASE_POOL_CATALOG } from '../../src/config.js'

// Historical read-path fixtures seed pre-Task-9 rows through the explicitly test/offline-only
// compatibility writers. Production route construction uses the default, writer-free surface.
const createAgentIndexStore = (db) =>
  createProductionAgentIndexStore(db, { enableLegacyBaseChildWrites: true })

// ── same in-memory-D1 helper as store.test.js / indexer.test.js ──
const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

function fakeD1({ includeRecoveryEvidence = true } = {}) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0001_vf_gate.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0002_agent_index.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0003_agent_index_bounds.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0004_agent_associations.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0005_execution_receipts.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0006_base_child_intents.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0007_agent_membership_owner_pages.sql'), 'utf8'))
  if (includeRecoveryEvidence) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0008_base_recovery_evidence.sql'), 'utf8'))
  }
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
        stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
      },
    })
  })

  it.each([
    [
      'wrong schema acknowledgement',
      {
        writable: true,
        schemaVersion: 2,
        stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
      },
    ],
    [
      'missing receipt-store acknowledgement',
      {
        writable: true,
        schemaVersion: 1,
        stores: { baseChildIntents: true, baseRecoveryEvidence: true },
      },
    ],
    [
      'missing Base-child-store acknowledgement',
      {
        writable: true,
        schemaVersion: 1,
        stores: { executionReceipts: true, baseRecoveryEvidence: true },
      },
    ],
    [
      'missing recovery-evidence acknowledgement',
      {
        writable: true,
        schemaVersion: 1,
        stores: { executionReceipts: true, baseChildIntents: true },
      },
    ],
  ])('fails closed on %s', async (_label, readiness) => {
    const out = await handleReporterReadiness({
      store: { probeReadiness: async () => readiness },
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
    })
    expect(out).toMatchObject({ status: 503, body: { configured: true } })
  })

  it('maps a 0007-only database to a non-disclosing 503', async () => {
    const out = await handleReporterReadiness({
      store: createAgentIndexStore(fakeD1({ includeRecoveryEvidence: false })),
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
    })
    expect(out).toEqual({
      status: 503,
      body: { error: 'Base child store unavailable', configured: true },
    })
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
const AGENT_B = 'CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW'
const ORPHAN_AGENT = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'
const CURSOR_SECRET = 'handler-owner-cursor-secret-with-at-least-32-bytes'

describe('authenticated Base child handlers', () => {
  const secret = 'server-reporter-secret'
  const child = (overrides = {}) => ({
    version: 1,
    networkId: 'stellar-testnet',
    owner: OWNER_A,
    agent: AGENT_A,
    bindingId: 'binding-42',
    executionId: 'run-42:exec:run-42:bridge:aave-v3',
    allocationId: 'run-42:bridge:aave-v3',
    childId: 'job-42',
    intent: {
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress: `0x${'11'.repeat(20)}`,
      proxyTarget: 'aave-v3',
      minShares: '0',
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
    executionId: 'run-42:exec:run-42:bridge:aave-v3',
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

describe('Task 9 authoritative batch and public evidence handlers', () => {
  const secret = 'server-reporter-secret'
  const pool = `0x${'11'.repeat(20)}`
  const kernel = `0x${'22'.repeat(20)}`
  const entryPoint = '0x0000000071727de22e5e9d8baf0edac6f37da032'
  const messenger = `C${'D'.repeat(55)}`
  const token = `C${'E'.repeat(55)}`
  const liveCreator = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
  const identity = {
    networkId: 'stellar-testnet',
    bindingId: 'binding-batch-42',
    executionId: 'run-batch-42:exec:allocation-1',
    allocationId: 'allocation-1',
    childId: 'job-batch-42',
  }
  const child = (ordinal = 1) => ({
    version: 1,
    networkId: 'stellar-testnet',
    owner: OWNER_A,
    agent: AGENT_A,
    bindingId: 'binding-batch-42',
    executionId: `run-batch-42:exec:allocation-${ordinal}`,
    allocationId: `allocation-${ordinal}`,
    childId: 'job-batch-42',
    intent: {
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress: pool,
      proxyTarget: 'aave-v3',
      minShares: '0',
      runId: 'run-batch-42',
      grantTxHash: 'grant-batch-42',
      kernelAddress: kernel,
      bindingHash: 'binding-hash-batch-42',
      baseJobId: 'job-batch-42',
    },
    lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 2_000_000_000_000 },
  })
  const batch = () => ({
    idempotencyKey: 'batch-key-42',
    burnUnits7: '20000000',
    children: [child(1), child(2)],
  })
  const deps = (overrides = {}) => ({
    configuredNetworkId: 'stellar-testnet',
    secret,
    providedSecret: secret,
    poolTargets: new Map([[pool, 'aave-v3']]),
    scopeRequirements: {
      messenger,
      token,
      destinationDomain: 6,
      reportToken: 'USDC',
      reportDecimals: 6,
      scopeDecimals: 7,
    },
    authorityReader: vi.fn(async () => ({
      scope: {
        owner: OWNER_A,
        kind: 1,
        target: messenger,
        token,
        destination_domain: 6,
        mint_recipient: kernel.slice(2).padStart(64, '0'),
        expiry: 2_100_000_000,
        revoked: false,
        cap_per_period: '30000000',
        spent_in_period: '0',
        period_start: 2_000_000_000,
        period_duration: 3600,
      },
      ledgerSequence: 123456,
      ledgerCloseSeconds: 2_000_000_001,
    })),
    ...overrides,
  })

  async function readyStoreFixture({ membership = {}, omitMembership = false } = {}) {
    const database = fakeD1()
    const store = createAgentIndexStore(database)
    if (!omitMembership) {
      await store.upsertMembership({
        networkId: 'stellar-testnet',
        agentAddress: AGENT_A,
        ownerAddress: OWNER_A,
        creatorAddress: liveCreator,
        schemaVersion: 1,
        kind: 'bridge',
        creationLedger: 123,
        creationTx: 'creation-tx',
        grantTxHash: 'grant-batch-42',
        runId: 'run-batch-42',
        runOrdinal: 0,
        provenance: { source: 'router-event', generation: 'agent-v3-bridge' },
        ...membership,
      })
    }
    return { store, database }
  }

  async function readyStore() {
    return (await readyStoreFixture()).store
  }

  it('gates the batch before authority/store work and returns the exact ordered 201 ack', async () => {
    const store = await readyStore()
    const authorityReader = vi.fn()
    await expect(
      handleBaseChildIntentBatch({
        batch: batch(),
        store,
        ...deps({ providedSecret: 'wrong', authorityReader }),
      })
    ).resolves.toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    })
    expect(authorityReader).not.toHaveBeenCalled()

    const accepted = await handleBaseChildIntentBatch({ batch: batch(), store, ...deps() })
    expect(accepted).toMatchObject({
      status: 201,
      body: {
        acknowledged: true,
        schemaVersion: 1,
        idempotencyKey: 'batch-key-42',
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        children: [
          { identity, recoveryVersion: 0 },
          {
            identity: {
              ...identity,
              executionId: 'run-batch-42:exec:allocation-2',
              allocationId: 'allocation-2',
            },
            recoveryVersion: 0,
          },
        ],
        written: 2,
        duplicates: 0,
      },
    })
    expect(JSON.stringify(accepted.body)).not.toMatch(/scope|secret|owner|authorization/i)
  })

  const rejectionMatrix = [
    ['empty batch', (incoming) => (incoming.children = []), {}, /contain 1-/i, 400],
    ['non-array batch', (incoming) => (incoming.children = {}), {}, /contain 1-/i, 400],
    [
      'oversized batch',
      (incoming) => {
        incoming.children = Array.from({ length: MAX_BASE_CHILD_BATCH_SIZE + 1 }, (_, index) =>
          child(index + 1)
        )
      },
      {},
      /contain 1-/i,
      400,
    ],
    [
      'mixed owner',
      (incoming) => (incoming.children[1].owner = 'GFOREIGNOWNER'),
      {},
      /mixed immutable context/i,
      400,
    ],
    [
      'mixed agent',
      (incoming) => (incoming.children[1].agent = 'CFOREIGNAGENT'),
      {},
      /mixed immutable context/i,
      400,
    ],
    [
      'mixed run with canonical execution identity',
      (incoming) => {
        incoming.children[1].intent.runId = 'run-other'
        incoming.children[1].executionId = 'run-other:exec:allocation-2'
      },
      {},
      /mixed immutable context/i,
      400,
    ],
    [
      'mixed grant',
      (incoming) => (incoming.children[1].intent.grantTxHash = 'grant-other'),
      {},
      /mixed immutable context/i,
      400,
    ],
    [
      'mixed kernel',
      (incoming) => (incoming.children[1].intent.kernelAddress = `0x${'33'.repeat(20)}`),
      {},
      /mixed immutable context/i,
      400,
    ],
    [
      'mixed outer binding',
      (incoming) => (incoming.children[1].bindingId = 'binding-other'),
      {},
      /mixed immutable context/i,
      400,
    ],
    [
      'mixed binding hash',
      (incoming) => (incoming.children[1].intent.bindingHash = 'binding-hash-other'),
      {},
      /mixed immutable context/i,
      400,
    ],
    [
      'mixed Base job',
      (incoming) => {
        incoming.children[1].childId = 'job-other'
        incoming.children[1].intent.baseJobId = 'job-other'
      },
      {},
      /mixed immutable context/i,
      400,
    ],
    [
      'noncanonical execution mapping',
      (incoming) => (incoming.children[1].executionId = 'run-batch-42:exec:allocation-wrong'),
      {},
      /executionId/i,
      400,
    ],
    [
      'duplicate allocation/full identity',
      (incoming) => (incoming.children[1] = structuredClone(incoming.children[0])),
      {},
      /duplicate Base child allocation\/full identity/i,
      400,
    ],
    [
      'unallowlisted pool',
      (incoming) => (incoming.children[1].intent.poolAddress = `0x${'99'.repeat(20)}`),
      {},
      /pool\/proxy target/i,
      400,
    ],
    [
      'proxy target spoofing',
      (incoming) => (incoming.children[1].intent.proxyTarget = 'moonwell'),
      {},
      /pool\/proxy target/i,
      400,
    ],
    ['missing membership', () => {}, { omitMembership: true }, /live reviewed grant/i, 400],
    [
      'membership owner mismatch',
      () => {},
      { membership: { ownerAddress: 'GFOREIGNOWNER' } },
      /live reviewed grant/i,
      400,
    ],
    [
      'wrong membership creator',
      () => {},
      { membership: { creatorAddress: `C${'F'.repeat(55)}` } },
      /live reviewed grant/i,
      400,
    ],
    [
      'wrong membership provenance source',
      () => {},
      { membership: { provenance: { source: 'registry-event', generation: 'agent-v3-bridge' } } },
      /live reviewed grant/i,
      400,
    ],
    [
      'wrong membership provenance generation',
      () => {},
      { membership: { provenance: { source: 'router-event', generation: 'agent-v2' } } },
      /live reviewed grant/i,
      400,
    ],
    [
      'wrong membership schema',
      () => {},
      { membership: { schemaVersion: 2 } },
      /live reviewed grant/i,
      400,
    ],
    [
      'wrong membership run',
      () => {},
      { membership: { runId: 'run-other' } },
      /live reviewed grant/i,
      400,
    ],
    [
      'wrong membership grant',
      () => {},
      { membership: { grantTxHash: 'grant-other' } },
      /live reviewed grant/i,
      400,
    ],
    [
      'wrong scope owner',
      () => {},
      { scope: { owner: 'GFOREIGNOWNER' } },
      /does not authorize/i,
      400,
    ],
    ['wrong scope kind', () => {}, { scope: { kind: 2 } }, /does not authorize/i, 400],
    [
      'wrong messenger',
      () => {},
      { scope: { target: `C${'F'.repeat(55)}` } },
      /does not authorize/i,
      400,
    ],
    [
      'wrong token',
      () => {},
      { scope: { token: `C${'F'.repeat(55)}` } },
      /does not authorize/i,
      400,
    ],
    ['wrong destination domain', () => {}, { scope: { destination_domain: 7 } }, /authorize/i, 400],
    [
      'wrong mint recipient',
      () => {},
      { scope: { mint_recipient: 'f'.repeat(64) } },
      /does not authorize/i,
      400,
    ],
    ['expired scope', () => {}, { scope: { expiry: 2_000_000_001 } }, /authorize/i, 400],
    ['revoked scope', () => {}, { scope: { revoked: true } }, /authorize/i, 400],
    [
      'zero period duration',
      () => {},
      { scope: { period_duration: 0 } },
      /duration.*invalid/i,
      400,
    ],
    ['negative spent', () => {}, { scope: { spent_in_period: '-1' } }, /spent.*invalid/i, 400],
    ['negative cap', () => {}, { scope: { cap_per_period: '-1' } }, /cap.*invalid/i, 400],
    [
      'spent above cap',
      () => {},
      { scope: { spent_in_period: '30000001' } },
      /spent exceeds cap/i,
      400,
    ],
    [
      'missing ledger sequence',
      () => {},
      { omitSnapshotField: 'ledgerSequence' },
      /snapshot/i,
      503,
    ],
    [
      'missing ledger close time',
      () => {},
      { omitSnapshotField: 'ledgerCloseSeconds' },
      /snapshot/i,
      503,
    ],
    ['missing live scope', () => {}, { omitSnapshotField: 'scope' }, /snapshot/i, 503],
    [
      'non-integer ledger close time',
      () => {},
      { snapshot: { ledgerSequence: 123456, ledgerCloseSeconds: '2000000001' } },
      /snapshot/i,
      503,
    ],
    ['zero ledger sequence', () => {}, { snapshot: { ledgerSequence: 0 } }, /snapshot/i, 503],
    [
      'negative ledger close time',
      () => {},
      { snapshot: { ledgerCloseSeconds: -1 } },
      /snapshot/i,
      503,
    ],
    [
      'non-integral reverse conversion',
      (incoming) => (incoming.burnUnits7 = '20000001'),
      {},
      /six decimals/i,
      400,
    ],
    [
      'child sum mismatch',
      (incoming) => (incoming.burnUnits7 = '20000010'),
      {},
      /sum.*burnUnits7/i,
      400,
    ],
    [
      'aggregate above remaining headroom',
      () => {},
      { scope: { cap_per_period: '19999999' } },
      /exceeds scope headroom/i,
      400,
    ],
    [
      'number-based burn precision',
      (incoming) => (incoming.burnUnits7 = 9_007_199_254_740_992),
      {},
      /unsigned integer string/i,
      400,
    ],
    [
      'number-based child-unit precision',
      (incoming) => (incoming.children[1].intent.units = 9_007_199_254_740_992),
      {},
      /units.*exact integer string/i,
      400,
    ],
    [
      'number-based minimum-shares precision',
      (incoming) => (incoming.children[1].intent.minShares = 9_007_199_254_740_992),
      {},
      /safe integers.*exact string/i,
      400,
    ],
  ]

  it.each(rejectionMatrix)(
    'rejects complete matrix case %s through the real SQLite handler at its named guard',
    async (_label, mutate, options, expectedGuard, expectedStatus) => {
      const { store, database } = await readyStoreFixture(options)
      const incoming = batch()
      mutate(incoming)
      const baseDependencies = deps()
      const baseSnapshot = await baseDependencies.authorityReader()
      const authoritySnapshot = {
        ...baseSnapshot,
        ...(options.snapshot ?? {}),
        scope: { ...baseSnapshot.scope, ...(options.scope ?? {}) },
      }
      if (options.omitSnapshotField) delete authoritySnapshot[options.omitSnapshotField]
      const authorityReader = vi.fn(async () => authoritySnapshot)
      const validationArgs = {
        batch: incoming,
        store,
        authorityReader,
        poolTargets: baseDependencies.poolTargets,
        scopeRequirements: baseDependencies.scopeRequirements,
        supportedNetworkId: 'stellar-testnet',
      }

      await expect(validateBaseChildIntentBatch(validationArgs)).rejects.toThrow(expectedGuard)
      const out = await handleBaseChildIntentBatch({
        batch: incoming,
        store,
        ...deps({ authorityReader }),
      })

      expect(out).toEqual(
        expectedStatus === 503
          ? { status: 503, body: { error: 'Agent-index dependency unavailable' } }
          : { status: 400, body: { error: 'Invalid agent-index request' } }
      )
      for (const table of [
        'base_child_intent_batches',
        'base_child_intent_batch_items',
        'base_child_intents',
        'base_child_lifecycle_events',
        'base_child_phase_events',
      ]) {
        expect(database._raw.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count).toBe(0)
      }
    }
  )

  it('classifies changed content under an existing idempotency key as 409 with zero new rows', async () => {
    const { store, database } = await readyStoreFixture()
    const accepted = await handleBaseChildIntentBatch({ batch: batch(), store, ...deps() })
    expect(accepted.status).toBe(201)
    const before = Object.fromEntries(
      [
        'base_child_intent_batches',
        'base_child_intent_batch_items',
        'base_child_intents',
        'base_child_lifecycle_events',
        'base_child_phase_events',
      ].map((table) => [
        table,
        database._raw.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count,
      ])
    )
    const changed = batch()
    changed.children[1].intent.minShares = '1'

    await expect(handleBaseChildIntentBatch({ batch: changed, store, ...deps() })).resolves.toEqual(
      { status: 409, body: { error: 'Agent-index mutation conflict' } }
    )
    for (const [table, count] of Object.entries(before)) {
      expect(database._raw.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count).toBe(count)
    }
  })

  it('writes evidence with CAS and publicly returns only allowlisted chain facts', async () => {
    const store = await readyStore()
    await handleBaseChildIntentBatch({ batch: batch(), store, ...deps() })
    const report = {
      schemaVersion: 1,
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'a'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: {
          burnTxHash: 'a'.repeat(64),
          expectationDigest: 'b'.repeat(64),
          burnUnits7: '9007199254740993000000',
        },
        observedAt: 2_000_000_000_100,
      },
    }
    await expect(
      handleBaseChildEvidenceWrite({ request: report, store, ...deps() })
    ).resolves.toMatchObject({
      status: 201,
      body: {
        acknowledged: true,
        identity,
        eventId: 'a'.repeat(64),
        recoveryVersion: 1,
        evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        reportDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
    const bundle = await store.readBaseChildRecoveryBundle(identity)
    bundle.intent.internalDiagnostic = 'database-secret'
    bundle.phases[0].evidence = {
      ...bundle.phases[0].evidence,
      nested: { sessionPrivateKey: 'private-key' },
      leaseToken: 'lease-secret',
    }
    const readStore = { readPublicBaseChildEvidence: vi.fn(async () => bundle) }
    const out = await handleBaseChildEvidenceRead({ identity, store: readStore })
    expect(Object.keys(out.body).sort()).toEqual(
      [
        'schemaVersion',
        'identity',
        'owner',
        'agent',
        'recoverable',
        'recoveryVersion',
        'intent',
        'phases',
        'events',
      ].sort()
    )
    expect(out).toMatchObject({
      status: 200,
      body: {
        schemaVersion: 1,
        identity,
        owner: OWNER_A,
        agent: AGENT_A,
        recoverable: true,
        recoveryVersion: 1,
        intent: expect.objectContaining({
          runId: 'run-batch-42',
          grantTxHash: 'grant-batch-42',
          bindingHash: 'binding-hash-batch-42',
          baseJobId: identity.childId,
        }),
        phases: [
          {
            identity,
            phase: 'cctp_burn',
            state: 'confirmed',
            eventId: 'a'.repeat(64),
            recoveryVersion: 1,
            observedAt: 2_000_000_000_100,
            evidence: { burnTxHash: 'a'.repeat(64) },
          },
        ],
        events: [
          {
            identity,
            owner: OWNER_A,
            agent: AGENT_A,
            eventId: 'a'.repeat(64),
            recoveryVersion: 1,
            phase: 'cctp_burn',
            state: 'confirmed',
            observedAt: 2_000_000_000_100,
            evidence: { burnTxHash: 'a'.repeat(64) },
          },
        ],
      },
    })
    expect(JSON.stringify(out.body)).not.toMatch(
      /private|secret|lease|diagnostic|sessionPrivateKey/i
    )
  })

  it('accepts the relayer burn submitted fence before confirmation and keeps polling attestation', async () => {
    const store = await readyStore()
    const directChild = {
      ...child(1),
      intent: {
        ...child(1).intent,
        grantTxHash: 'a'.repeat(64),
        bindingHash: 'b'.repeat(64),
      },
    }
    await store.createBaseChildIntent({
      child: directChild,
      intentDigest: 'c'.repeat(64),
      idempotencyKey: 'burn-submitted-fence-intent',
    })
    const submittedEvidence = {
      burnTxHash: 'a'.repeat(64),
      expectationDigest: 'b'.repeat(64),
      burnUnits7: '1000000',
    }
    const submitted = {
      schemaVersion: 1,
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'b'.repeat(64),
        phase: 'cctp_burn',
        state: 'submitted',
        evidence: submittedEvidence,
        observedAt: 2_000_000_000_200,
      },
    }
    await expect(
      handleBaseChildEvidenceWrite({ request: submitted, store, ...deps() })
    ).resolves.toMatchObject({
      status: 201,
      body: { recoveryVersion: 1, identity },
    })
    const confirmed = {
      ...submitted,
      expectedRecoveryVersion: 1,
      event: {
        ...submitted.event,
        eventId: 'c'.repeat(64),
        state: 'confirmed',
        evidence: {
          ...submittedEvidence,
          messageDigest: `0x${'c'.repeat(64)}`,
          nonce: `0x${'d'.repeat(64)}`,
        },
        observedAt: 2_000_000_000_201,
      },
    }
    await expect(
      handleBaseChildEvidenceWrite({ request: confirmed, store, ...deps() })
    ).resolves.toMatchObject({
      status: 201,
      body: { recoveryVersion: 2, identity },
    })
    const out = await handleBaseChildEvidenceRead({
      identity,
      configuredNetworkId: 'stellar-testnet',
      store,
    })
    expect(selectBaseChildRecoveryAction(out.body)).toEqual({
      action: 'poll-attestation',
      phase: 'cctp_attestation',
      reasonCode: 'base-attestation-pending',
    })
    const attestationFacts = {
      burnTxHash: 'a'.repeat(64),
      expectationDigest: 'b'.repeat(64),
      messageDigest: `0x${'c'.repeat(64)}`,
      nonce: `0x${'d'.repeat(64)}`,
    }
    await expect(
      handleBaseChildEvidenceWrite({
        request: {
          schemaVersion: 1,
          identity,
          expectedRecoveryVersion: 2,
          event: {
            eventId: 'd'.repeat(64),
            phase: 'cctp_attestation',
            state: 'failed',
            evidence: { ...attestationFacts, reasonCode: 'attestation_retryable' },
            observedAt: 2_000_000_000_202,
          },
        },
        store,
        ...deps(),
      })
    ).resolves.toMatchObject({ status: 201, body: { recoveryVersion: 3, identity } })
    await expect(
      handleBaseChildEvidenceWrite({
        request: {
          schemaVersion: 1,
          identity,
          expectedRecoveryVersion: 3,
          event: {
            eventId: 'e'.repeat(64),
            phase: 'cctp_attestation',
            state: 'confirmed',
            evidence: {
              ...attestationFacts,
              attestationDigest: `0x${'f'.repeat(64)}`,
              evidenceVersion: '4',
            },
            observedAt: 2_000_000_000_203,
          },
        },
        store,
        ...deps(),
      })
    ).resolves.toMatchObject({ status: 201, body: { recoveryVersion: 4, identity } })
    const confirmedAttestation = await handleBaseChildEvidenceRead({
      identity,
      configuredNetworkId: 'stellar-testnet',
      store,
    })
    expect(selectBaseChildRecoveryAction(confirmedAttestation.body)).toEqual({
      action: 'submit-mint',
      phase: 'cctp_mint',
      reasonCode: 'base-attestation-confirmed',
    })
  })

  it('carries the nested reconcile handle through a real report and public selector bundle', async () => {
    const store = await readyStore()
    const child = {
      version: 1,
      networkId: 'stellar-testnet',
      owner: OWNER_A,
      agent: AGENT_A,
      bindingId: 'binding-nested-42',
      executionId: 'run-nested-42:exec:allocation-nested-1',
      allocationId: 'allocation-nested-1',
      childId: 'job-nested-42',
      intent: {
        token: 'USDC',
        units: '1000000',
        decimals: 6,
        poolAddress: pool,
        proxyTarget: 'aave-v3',
        minShares: '900000',
        runId: 'run-nested-42',
        grantTxHash: '66'.repeat(32),
        kernelAddress: kernel,
        bindingHash: 'dd'.repeat(32),
        baseJobId: 'job-nested-42',
      },
      lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 2_000_000_000_000 },
    }
    await store.createBaseChildIntent({
      child,
      intentDigest: 'ee'.repeat(32),
      idempotencyKey: 'nested-handle-intent',
    })
    const childIdentity = {
      networkId: child.networkId,
      bindingId: child.bindingId,
      executionId: child.executionId,
      allocationId: child.allocationId,
      childId: child.childId,
    }
    const handle = {
      entryPoint,
      sender: kernel,
      nonce: '17',
      startBlock: '4321',
    }
    const common = {
      chainId: '84532',
      yieldRouterAddress: `0x${'44'.repeat(20)}`,
      caller: kernel,
      poolAddress: pool,
      assets: '1000000',
      minShares: '900000',
    }
    const events = [
      {
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: {
          burnTxHash: 'aa'.repeat(32),
          expectationDigest: 'bb'.repeat(32),
          burnUnits7: '1000000',
          messageDigest: `0x${'cc'.repeat(32)}`,
          nonce: `0x${'dd'.repeat(32)}`,
        },
      },
      {
        phase: 'cctp_attestation',
        state: 'confirmed',
        evidence: {
          burnTxHash: 'aa'.repeat(32),
          expectationDigest: 'bb'.repeat(32),
          messageDigest: `0x${'cc'.repeat(32)}`,
          attestationDigest: `0x${'ee'.repeat(32)}`,
          nonce: `0x${'dd'.repeat(32)}`,
          evidenceVersion: '2',
        },
      },
      {
        phase: 'cctp_mint',
        state: 'confirmed',
        evidence: {
          burnTxHash: 'aa'.repeat(32),
          expectationDigest: 'bb'.repeat(32),
          messageDigest: `0x${'cc'.repeat(32)}`,
          attestationDigest: `0x${'ee'.repeat(32)}`,
          nonce: `0x${'dd'.repeat(32)}`,
          evidenceVersion: '3',
          mintTxHash: `0x${'ff'.repeat(32)}`,
        },
      },
      {
        phase: 'base_deposit',
        state: 'submitting',
        evidence: { ...common, reconcileHandle: handle },
      },
    ]
    for (const [index, event] of events.entries()) {
      const request = {
        schemaVersion: 1,
        identity: childIdentity,
        expectedRecoveryVersion: index,
        event: {
          eventId: `${String(index + 1).padStart(64, '0')}`,
          ...event,
          observedAt: 2_000_000_000_100 + index,
        },
      }
      const reportOut = await handleBaseChildEvidenceWrite({ request, store, ...deps() })
      await expect(Promise.resolve(reportOut)).resolves.toMatchObject({
        status: 201,
        body: { recoveryVersion: index + 1, identity: childIdentity },
      })
    }
    const out = await handleBaseChildEvidenceRead({
      identity: childIdentity,
      configuredNetworkId: 'stellar-testnet',
      store,
    })
    expect(out.status).toBe(200)
    const publicHandle = out.body.phases.at(-1).evidence.reconcileHandle
    expect(publicHandle).toEqual(handle)
    expect(out.body.phases.at(-1).evidence).not.toHaveProperty('entryPoint')
    expect(selectBaseChildRecoveryAction(out.body)).toEqual({
      action: 'poll-base-deposit',
      phase: 'base_deposit',
      reasonCode: 'base-deposit-pending',
    })
  })

  it('requires all five public identity fields and maps unknown exact tuples to 404', async () => {
    const store = { readPublicBaseChildEvidence: vi.fn(async () => null) }
    for (const field of Object.keys(identity)) {
      const invalid = { ...identity }
      delete invalid[field]
      await expect(
        handleBaseChildEvidenceRead({ identity: invalid, store })
      ).resolves.toMatchObject({ status: 400 })
    }
    await expect(handleBaseChildEvidenceRead({ identity, store })).resolves.toEqual({
      status: 404,
      body: { error: 'Base child evidence not found' },
    })
  })

  it('rejects extra evidence fields before the store and changed event replay as 409', async () => {
    const store = { advanceBaseChildPhase: vi.fn() }
    const request = {
      schemaVersion: 1,
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'a'.repeat(64),
        phase: 'cctp_burn',
        state: 'submitting',
        evidence: {},
        observedAt: 1,
      },
      serializedApproval: 'private',
    }
    await expect(
      handleBaseChildEvidenceWrite({ request, store, ...deps() })
    ).resolves.toMatchObject({ status: 400 })
    expect(store.advanceBaseChildPhase).not.toHaveBeenCalled()
  })

  it('rejects unknown and sensitive nested evidence before calling the store', async () => {
    const store = { advanceBaseChildPhase: vi.fn() }
    const request = {
      schemaVersion: 1,
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'e'.repeat(64),
        phase: 'cctp_burn',
        state: 'unknown',
        evidence: { endpoint: 'https://rpc.invalid', authorization: 'Bearer secret' },
        observedAt: 1,
      },
    }
    await expect(
      handleBaseChildEvidenceWrite({ request, store, ...deps() })
    ).resolves.toMatchObject({ status: 400 })
    expect(store.advanceBaseChildPhase).not.toHaveBeenCalled()
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
    expect(bad.error).toBe('AGENT_INDEX_SOURCE_UNAVAILABLE')

    const rows = await store.readOwnerMemberships({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
    })
    expect(rows).toHaveLength(1)
  })

  it('collapses provider ingest failures to a stable code without echoing provider text', async () => {
    const poison = 'T16_PROVIDER_SECRET_RPC_BODY_COOKIE'
    const out = await handleIngest({
      secret: 'topsecret',
      providedSecret: 'topsecret',
      store: createAgentIndexStore(fakeD1()),
      sources: [ROUTER_V1],
      eventSourceFor: async () => {
        throw new Error(poison)
      },
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })

    expect(out.status).toBe(200)
    expect(JSON.stringify(out.body)).not.toContain(poison)
    expect(out.body.results).toEqual([
      expect.objectContaining({ ok: false, error: 'AGENT_INDEX_SOURCE_UNAVAILABLE' }),
    ])
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
    const rec1 = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_A,
      ledger: ROUTER_V1.coverageStartLedger + 1,
      txHash: 'TX1',
    })
    const rec2 = deployedRecord({
      owner: OWNER_A,
      agent: AGENT_B,
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
      cursorCodec: createOwnerReadCursorCodec({ secret: CURSOR_SECRET, now: () => Date.now() }),
    })
    expect(out.body.agents).toHaveLength(1)
  })
})

describe('handleRead — authenticated snapshot pages', () => {
  it('keeps the first truncated page partial while exposing the complete underlying coverage proof', async () => {
    const store = createAgentIndexStore(fakeD1())
    const now = Date.now()
    const finalizedThroughLedger = ROUTER_V1.coverageStartLedger + 10
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: [
            deployedRecord({
              owner: OWNER_A,
              agent: AGENT_A,
              ledger: ROUTER_V1.coverageStartLedger + 1,
              txHash: 'TX-PAGE-1',
            }),
            deployedRecord({
              owner: OWNER_A,
              agent: AGENT_B,
              ledger: ROUTER_V1.coverageStartLedger + 2,
              txHash: 'TX-PAGE-2',
            }),
          ],
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
          latestAvailableLedger: finalizedThroughLedger + 2,
        }),
      finalizedLedgerFor: async () => finalizedThroughLedger,
      now,
    })
    const manifest = { ...LIVE_MANIFEST, creators: [ROUTER_V1] }
    const cursorCodec = createOwnerReadCursorCodec({
      secret: CURSOR_SECRET,
      now: () => now,
      ttlMs: 60_000,
    })
    const first = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      manifest,
      now,
      limit: 1,
      cursorCodec,
    })

    expect(first).toMatchObject({
      status: 200,
      body: {
        status: 'partial',
        pagination: {
          hasMore: true,
          snapshotThroughLedger: finalizedThroughLedger,
          coverageStatus: 'complete',
        },
      },
    })
    expect(first.body.agents.map((agent) => agent.address)).toEqual([AGENT_A])
    expect(first.body.pagination.nextCursor).toEqual(expect.any(String))
    await expect(
      cursorCodec.decode(first.body.pagination.nextCursor, {
        networkId: ROUTER_V1.networkId,
        owner: OWNER_A,
        manifestHash: manifest.hash,
        snapshotThroughLedger: finalizedThroughLedger,
      })
    ).resolves.toMatchObject({
      afterLedger: ROUTER_V1.coverageStartLedger + 1,
      afterAddress: AGENT_A,
      expiresAt: now + 60_000,
    })

    const second = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      manifest,
      now,
      limit: 1,
      cursor: first.body.pagination.nextCursor,
      cursorCodec,
    })
    expect(second.body).toMatchObject({
      status: 'partial',
      pagination: {
        hasMore: false,
        nextCursor: null,
        snapshotThroughLedger: finalizedThroughLedger,
        coverageStatus: 'complete',
      },
    })
    expect(second.body.agents.map((agent) => agent.address)).toEqual([AGENT_B])
  })

  it('fails closed when a truncated first page cannot be signed with a cursor secret', async () => {
    const store = createAgentIndexStore(fakeD1())
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: [
            deployedRecord({
              owner: OWNER_A,
              agent: AGENT_A,
              ledger: ROUTER_V1.coverageStartLedger + 1,
              txHash: 'TX-MISSING-SECRET-1',
            }),
            deployedRecord({
              owner: OWNER_A,
              agent: AGENT_B,
              ledger: ROUTER_V1.coverageStartLedger + 2,
              txHash: 'TX-MISSING-SECRET-2',
            }),
          ],
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
        }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
      now: 2_000_000_000_000,
    })
    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      now: 2_000_000_000_000,
      limit: 1,
      cursorCodec: null,
    })
    expect(out).toMatchObject({ status: 200, body: { status: 'unavailable', agents: [] } })
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

  it.each([
    ['the legacy association reader', { readOwnerBaseChildIntents: async () => [] }],
    ['the authoritative Base-child reader', { readOwnerRunAllocations: async () => [] }],
  ])('returns unavailable when the store lacks %s', async (_label, availableReader) => {
    const skewedStore = {
      readOwnerMemberships: async () => [],
      readCoverage: async () => ({ sources: [], gaps: [], backfillAudits: [] }),
      ...availableReader,
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

  it('returns a stable backfill error code when a provider/store failure contains poison text', async () => {
    const poison = 'T16_PROVIDER_SECRET_BACKFILL_BODY'
    const out = await handleBackfillCommit({
      secret: 's',
      providedSecret: 's',
      store: {
        upsertMembership: async () => {
          throw new Error(poison)
        },
      },
      audit: {
        auditId: 'audit-poison',
        networkId: ROUTER_V1.networkId,
        fromLedger: 1,
        throughLedger: 1,
        directSetupCutoffLedger: 1,
        creatorManifestVersion: 'v1',
        sources: [],
        candidates: [{}],
        verifiedAgents: [{}],
        rejectedCandidates: [],
        unresolvedCandidates: [],
        verdict: 'partial',
        completedAt: 1700000000,
      },
    })

    expect(out.status).toBe(400)
    expect(JSON.stringify(out.body)).not.toContain(poison)
    expect(out.body).toEqual({ error: 'AGENT_INDEX_BACKFILL_FAILED' })
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

  it('does not echo provider/store text from an association write failure', async () => {
    const poison = 'T16_PROVIDER_SECRET_ASSOCIATION_BODY'
    const pool = BASE_POOL_CATALOG[0]
    const report = {
      ...association,
      allocations: [{
        ...association.allocations[0],
        poolAddress: pool.address,
        proxyTarget: pool.proxyTarget,
        custody: { location: 'unknown' },
      }],
    }
    const existing = {
      ownerAddress: report.owner,
      runId: report.runId,
      bridgeAgentAddress: report.bridgeAgent,
      poolAddress: pool.address,
      proxyTarget: pool.proxyTarget,
      amount: report.allocations[0].amount,
      grantTxHash: report.grantTxHash,
      baseJobId: report.baseJobId,
      kernelAddress: report.kernelAddress,
      mandateBindingId: report.mandateBindingId,
      mandateBindingHash: report.mandateBindingHash,
      associationSource: 'relayer-attested',
      executionStatus: report.allocations[0].executionStatus,
      txHash: null,
      custodyLocation: 'unknown',
    }
    const out = await handleAssociationReport({
      secret: 's',
      providedSecret: 's',
      idempotencyKey: JSON.stringify([
        report.networkId,
        report.runId,
        report.allocations[0].allocationId,
        report.allocations[0].executionStatus,
        null,
      ]),
      store: {
        readRunAllocation: async () => existing,
        hasAssociationEvent: async () => false,
        commitAssociation: async () => {
          throw new Error(poison)
        },
      },
      report,
      scopeReader: vi.fn(),
      poolTargets: new Map([[pool.address.toLowerCase(), pool.proxyTarget]]),
      scopeRequirements: {
        reportToken: 'USDC',
        reportDecimals: 6,
        scopeDecimals: 7,
        token: 'CTOKEN',
        messenger: 'CMESSENGER',
        destinationDomain: 6,
      },
    })

    expect(out.status).toBe(400)
    expect(JSON.stringify(out.body)).not.toContain(poison)
    expect(out.body).toEqual({ error: 'AGENT_INDEX_ASSOCIATION_FAILED' })
  })
})

describe('handleRead — Base association envelope', () => {
  function generatedAgentAddress(ordinal) {
    const raw = new Uint8Array(32)
    new DataView(raw.buffer).setUint32(28, ordinal)
    return StrKey.encodeContract(raw)
  }

  async function seedMembership({ store, agent, ledger }) {
    await store.upsertMembership({
      networkId: ROUTER_V1.networkId,
      agentAddress: agent,
      ownerAddress: OWNER_A,
      creatorAddress: ROUTER_V1.address,
      schemaVersion: 1,
      kind: 'bridge',
      creationLedger: ledger,
      creationTx: `tx-${ledger}`,
      grantTxHash: `grant-${ledger}`,
      runId: `run-${ledger}`,
      runOrdinal: 0,
      provenance: { source: 'router-event' },
    })
  }

  function canonicalLegacyAssociation({ agent, now, suffix }) {
    return {
      allocationId: `run-${suffix}:bridge:aave-v3`,
      networkId: ROUTER_V1.networkId,
      runId: `run-${suffix}`,
      ownerAddress: OWNER_A,
      bridgeAgentAddress: agent,
      poolAddress: BASE_POOL_CATALOG[0].address,
      amount: { token: 'USDC', units: '1000000', decimals: 6 },
      proxyTarget: 'aave-v3',
      baseJobId: `job-${suffix}`,
      txHash: `0xdeposit-${suffix}`,
      executionStatus: 'deposited',
      custodyLocation: 'base-proxy',
      grantTxHash: `grant-${suffix}`,
      kernelAddress: `0x${'14'.repeat(20)}`,
      mandateBindingId: `binding-${suffix}`,
      mandateBindingHash: `binding-hash-${suffix}`,
      associationSource: 'relayer-attested',
      reportedAt: now - 100,
      scopeCheckedAt: now - 100,
    }
  }

  async function writeConfirmedBaseChild({ store, agent, now, suffix }) {
    const runId = `run-${suffix}`
    const allocationId = `${runId}:bridge:aave-v3`
    const childId = `job-${suffix}`
    const bindingId = `binding-${suffix}`
    const intent = await handleBaseChildIntent({
      child: {
        version: 1,
        networkId: ROUTER_V1.networkId,
        owner: OWNER_A,
        agent,
        bindingId,
        executionId: `${runId}:exec:${allocationId}`,
        allocationId,
        childId,
        intent: {
          token: 'USDC',
          units: '1000000',
          decimals: 6,
          poolAddress: BASE_POOL_CATALOG[0].address,
          proxyTarget: 'aave-v3',
          minShares: '0',
          bindingHash: `binding-hash-${suffix}`,
          runId,
          grantTxHash: `grant-${suffix}`,
          kernelAddress: `0x${'14'.repeat(20)}`,
          baseJobId: childId,
        },
        lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: now - 200 },
      },
      configuredNetworkId: ROUTER_V1.networkId,
      store,
      secret: 'reporter',
      providedSecret: 'reporter',
    })
    expect(intent.status).toBe(201)

    const lifecycle = await handleBaseChildLifecycle({
      request: {
        identity: {
          networkId: ROUTER_V1.networkId,
          owner: OWNER_A,
          bindingId,
          executionId: `${runId}:exec:${allocationId}`,
          allocationId,
          childId,
        },
        expectedSequence: 0,
        lifecycle: {
          sequence: 1,
          status: 'confirmed',
          evidence: {
            executionStatus: 'deposited',
            custodyLocation: 'base-proxy',
            txHash: `0xdeposit-${suffix}`,
          },
          observedAt: now - 100,
        },
      },
      configuredNetworkId: ROUTER_V1.networkId,
      store,
      secret: 'reporter',
      providedSecret: 'reporter',
    })
    expect(lifecycle.status).toBe(200)
  }

  // Defect caught: a durable authoritative child without an indexed membership became complete known zero.
  it('fails closed through owner money when a Base child is visible before its membership', async () => {
    const store = createAgentIndexStore(fakeD1())
    const now = Date.now()
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: [],
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
        }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })
    await writeConfirmedBaseChild({ store, agent: AGENT_A, now, suffix: 'orphan' })

    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      manifest: { ...LIVE_MANIFEST, creators: [ROUTER_V1] },
      now,
    })
    const reads = await readOwnerMoney({
      owner: OWNER_A,
      discovery: out.body,
      stellar: {
        readVaultShares: async () => 0n,
        readTokenBalance: async () => 0n,
        readPricePerShare: async () => 10_000_000n,
        readSupplyAprBps: async () => null,
      },
      base: {
        loadIndexedBasePositions: async () => ({ status: 'known', accounts: [] }),
      },
      associationDelivery: { events: [] },
      now,
    })

    expect({
      envelopeStatus: out.body.status,
      envelopeAgents: out.body.agents,
      moneyStatus: reads.status,
      completeBaseTotalUnits: reads.completeBaseTotalUnits,
      overallTotalUnits: reads.overallTotalUnits,
    }).toEqual({
      envelopeStatus: 'unavailable',
      envelopeAgents: [],
      moneyStatus: 'unavailable',
      completeBaseTotalUnits: null,
      overallTotalUnits: null,
    })
  })

  // Defect caught: joining all owner associations against one page made every truncated page unavailable.
  it('joins Base associations only for memberships on the current page', async () => {
    const store = createAgentIndexStore(fakeD1())
    const now = Date.now()
    const limitedAgent = 'CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW'
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: [
            deployedRecord({
              owner: OWNER_A,
              agent: AGENT_A,
              ledger: ROUTER_V1.coverageStartLedger + 1,
              txHash: 'TX-LIMIT-FIRST',
            }),
            deployedRecord({
              owner: OWNER_A,
              agent: limitedAgent,
              ledger: ROUTER_V1.coverageStartLedger + 2,
              txHash: 'TX-LIMIT-SECOND',
            }),
          ],
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
        }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })
    await writeConfirmedBaseChild({ store, agent: limitedAgent, now, suffix: 'limited' })

    await expect(
      store.readOwnerMemberships({ networkId: ROUTER_V1.networkId, owner: OWNER_A })
    ).resolves.toHaveLength(2)
    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      manifest: { ...LIVE_MANIFEST, creators: [ROUTER_V1] },
      now,
      limit: 1,
      cursorCodec: createOwnerReadCursorCodec({ secret: CURSOR_SECRET, now: () => now }),
    })
    expect(out).toMatchObject({
      status: 200,
      body: {
        status: 'partial',
        agents: [{ address: AGENT_A, association: 'unknown' }],
        pagination: { hasMore: true, coverageStatus: 'complete' },
      },
    })
  })

  it.each([
    [99, [100]],
    [100, [100, 2]],
    [101, [100, 3]],
  ])(
    'keeps every targeted membership query within 100 total D1 binds for %i associations',
    async (count, expectedParameterCounts) => {
      const store = createAgentIndexStore(fakeD1())
      const now = Date.now()
      const finalizedThroughLedger = ROUTER_V1.coverageStartLedger + 200
      await handleIngest({
        secret: 's',
        providedSecret: 's',
        store,
        sources: [ROUTER_V1],
        eventSourceFor: async () =>
          fakeEventSource({
            events: [],
            oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
            latestAvailableLedger: finalizedThroughLedger + 2,
          }),
        finalizedLedgerFor: async () => finalizedThroughLedger,
      })

      for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        const agent = generatedAgentAddress(ordinal)
        await seedMembership({
          store,
          agent,
          ledger: ROUTER_V1.coverageStartLedger + ordinal,
        })
        await store.commitAssociation({
          association: canonicalLegacyAssociation({
            agent,
            now,
            suffix: `bind-budget-${count}-${ordinal}`,
          }),
          idempotencyKey: `bind-budget-${count}-${ordinal}`,
        })
      }

      const targetedRead = store.readMembershipsByAgentAddresses
      const effectiveParameterCounts = []
      store.readMembershipsByAgentAddresses = async (request) => {
        const parameterCount = 1 + request.agentAddresses.length
        effectiveParameterCounts.push(parameterCount)
        if (parameterCount > 100) throw new Error('D1 bind parameter limit exceeded')
        return targetedRead(request)
      }

      const out = await handleRead({
        networkId: ROUTER_V1.networkId,
        owner: OWNER_A,
        store,
        manifest: { ...LIVE_MANIFEST, creators: [ROUTER_V1] },
        now,
        limit: 500,
      })
      expect(out).toMatchObject({
        status: 200,
        body: { status: 'complete', pagination: { hasMore: false } },
      })
      expect(out.body.agents).toHaveLength(count)
      expect(effectiveParameterCounts).toEqual(expectedParameterCounts)
      expect(effectiveParameterCounts.every((parameterCount) => parameterCount <= 100)).toBe(true)
    }
  )

  it('fails closed when authoritative and legacy copies of one allocation name agents on different pages', async () => {
    const store = createAgentIndexStore(fakeD1())
    const now = Date.now()
    await seedMembership({ store, agent: AGENT_A, ledger: 10 })
    await seedMembership({ store, agent: AGENT_B, ledger: 11 })
    await writeConfirmedBaseChild({ store, agent: AGENT_A, now, suffix: 'cross-page-conflict' })
    await store.commitAssociation({
      association: canonicalLegacyAssociation({
        agent: AGENT_B,
        now,
        suffix: 'cross-page-conflict',
      }),
      idempotencyKey: 'cross-page-conflict',
    })

    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      now,
      limit: 1,
      cursorCodec: createOwnerReadCursorCodec({ secret: CURSOR_SECRET, now: () => now }),
    })
    expect(out).toMatchObject({ status: 200, body: { status: 'unavailable', agents: [] } })
  })

  it('fails closed on an orphan association even when valid owner memberships span pages', async () => {
    const store = createAgentIndexStore(fakeD1())
    const now = Date.now()
    await seedMembership({ store, agent: AGENT_A, ledger: 10 })
    await seedMembership({ store, agent: AGENT_B, ledger: 11 })
    await writeConfirmedBaseChild({
      store,
      agent: ORPHAN_AGENT,
      now,
      suffix: 'paginated-orphan',
    })

    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      now,
      limit: 1,
      cursorCodec: createOwnerReadCursorCodec({ secret: CURSOR_SECRET, now: () => now }),
    })
    expect(out).toMatchObject({ status: 200, body: { status: 'unavailable', agents: [] } })
  })

  // Defect caught: the expected orphan validation boundary also swallowed unrelated join bugs.
  it('propagates an unexpected join failure instead of disguising it as unavailable', async () => {
    const store = createAgentIndexStore(fakeD1())
    const now = Date.now()
    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: [
            deployedRecord({
              owner: OWNER_A,
              agent: AGENT_A,
              ledger: ROUTER_V1.coverageStartLedger + 1,
              txHash: 'TX-UNEXPECTED-JOIN',
            }),
          ],
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
        }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })
    const unexpected = new TypeError('unexpected join failure')
    let sourceReads = 0
    store.readOwnerRunAllocations = async () => [
      {
        allocationId: 'run-unexpected:bridge:aave-v3',
        networkId: ROUTER_V1.networkId,
        ownerAddress: OWNER_A,
        bridgeAgentAddress: AGENT_A,
        get associationSource() {
          sourceReads += 1
          if (sourceReads === 2) throw unexpected
          return 'relayer-attested'
        },
      },
    ]

    await expect(
      handleRead({
        networkId: ROUTER_V1.networkId,
        owner: OWNER_A,
        store,
        manifest: { ...LIVE_MANIFEST, creators: [ROUTER_V1] },
        now,
      })
    ).rejects.toBe(unexpected)
  })

  it('reads a terminal Base child from the authoritative intent/lifecycle model without a legacy row and includes it once in owner money', async () => {
    const db = fakeD1()
    const store = createAgentIndexStore(db)
    const now = Date.now()
    const poolAddress = BASE_POOL_CATALOG[0].address
    const kernelAddress = `0x${'12'.repeat(20)}`
    const allocationId = 'run-new:bridge:aave-v3'
    const childId = 'job-new'
    const bindingId = 'binding-new'

    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: [
            deployedRecord({
              owner: OWNER_A,
              agent: AGENT_A,
              ledger: ROUTER_V1.coverageStartLedger + 1,
              txHash: 'TX-NEW',
            }),
          ],
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
        }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })

    const child = {
      version: 1,
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      agent: AGENT_A,
      bindingId,
      executionId: `run-new:exec:${allocationId}`,
      allocationId,
      childId,
      intent: {
        token: 'USDC',
        units: '1000000',
        decimals: 6,
        poolAddress,
        proxyTarget: 'aave-v3',
        minShares: '0',
        bindingHash: 'binding-hash-new',
        runId: 'run-new',
        grantTxHash: 'grant-new',
        kernelAddress,
        baseJobId: childId,
      },
      lifecycle: {
        sequence: 0,
        status: 'planned',
        evidence: {},
        observedAt: now - 200,
      },
    }
    await expect(
      handleBaseChildIntent({
        child,
        configuredNetworkId: ROUTER_V1.networkId,
        store,
        secret: 'reporter',
        providedSecret: 'reporter',
      })
    ).resolves.toMatchObject({ status: 201 })
    await expect(
      handleBaseChildLifecycle({
        request: {
          identity: {
            networkId: ROUTER_V1.networkId,
            owner: OWNER_A,
            bindingId,
            executionId: `run-new:exec:${allocationId}`,
            allocationId,
            childId,
          },
          expectedSequence: 0,
          lifecycle: {
            sequence: 1,
            status: 'confirmed',
            evidence: {
              executionStatus: 'deposited',
              custodyLocation: 'base-proxy',
              txHash: '0xdeposit',
            },
            observedAt: now - 100,
          },
        },
        configuredNetworkId: ROUTER_V1.networkId,
        store,
        secret: 'reporter',
        providedSecret: 'reporter',
      })
    ).resolves.toMatchObject({ status: 200 })

    expect(db._raw.prepare('SELECT COUNT(*) AS count FROM agent_run_allocations').get().count).toBe(
      0
    )

    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      manifest: { ...LIVE_MANIFEST, creators: [ROUTER_V1] },
      now,
    })
    expect(out).toMatchObject({ status: 200, body: { status: 'complete' } })
    expect(out.body.agents[0].baseChildren).toEqual([
      expect.objectContaining({
        allocationId,
        baseJobId: childId,
        kernelAddress,
        executionStatus: 'deposited',
        custody: { location: 'base-proxy' },
        associationSource: 'relayer-attested',
      }),
    ])

    const reads = await readOwnerMoney({
      owner: OWNER_A,
      discovery: {
        ...out.body,
        agents: out.body.agents.map((agent) => ({
          ...agent,
          scopeReadStatus: 'ok',
          revoked: false,
          expiry: 0,
          authorized: true,
        })),
      },
      stellar: {
        readVaultShares: async () => 0n,
        readTokenBalance: async () => 0n,
        readPricePerShare: async () => 10_000_000n,
        readSupplyAprBps: async () => null,
      },
      base: {
        loadIndexedBasePositions: async () => ({
          status: 'known',
          accounts: [
            {
              kernelAddress,
              positions: [{ pool: poolAddress, shares: 1_000_000n, assets: 1_000_000n }],
              idleUsdc: 0n,
            },
          ],
        }),
      },
      associationDelivery: { events: [] },
      now,
    })
    expect(reads.baseSubtotalUnits).toBe(10_000_000n)
    expect(reads.overallTotalUnits).toBe(10_000_000n)
    expect(aggregateOwnerPositions(reads).confirmedTotal.amount.units).toBe('10000000')
  })

  it('fails closed when authoritative lifecycle evidence is malformed instead of hiding the child', async () => {
    const store = createAgentIndexStore(fakeD1())
    const now = Date.now()
    const bindingId = 'binding-malformed'
    const allocationId = 'run-malformed:bridge:aave-v3'
    const childId = 'job-malformed'

    await handleIngest({
      secret: 's',
      providedSecret: 's',
      store,
      sources: [ROUTER_V1],
      eventSourceFor: async () =>
        fakeEventSource({
          events: [
            deployedRecord({
              owner: OWNER_A,
              agent: AGENT_A,
              ledger: ROUTER_V1.coverageStartLedger + 1,
              txHash: 'TX-MALFORMED',
            }),
          ],
          oldestAvailableLedger: ROUTER_V1.coverageStartLedger,
        }),
      finalizedLedgerFor: async () => ROUTER_V1.coverageStartLedger + 10,
    })
    await handleBaseChildIntent({
      child: {
        version: 1,
        networkId: ROUTER_V1.networkId,
        owner: OWNER_A,
        agent: AGENT_A,
        bindingId,
        executionId: `run-malformed:exec:${allocationId}`,
        allocationId,
        childId,
        intent: {
          token: 'USDC',
          units: '1000000',
          decimals: 6,
          poolAddress: BASE_POOL_CATALOG[0].address,
          proxyTarget: 'aave-v3',
          minShares: '0',
          bindingHash: 'binding-hash-malformed',
          runId: 'run-malformed',
          grantTxHash: 'grant-malformed',
          kernelAddress: `0x${'13'.repeat(20)}`,
          baseJobId: childId,
        },
        lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: now - 200 },
      },
      configuredNetworkId: ROUTER_V1.networkId,
      store,
      secret: 'reporter',
      providedSecret: 'reporter',
    })
    await handleBaseChildLifecycle({
      request: {
        identity: {
          networkId: ROUTER_V1.networkId,
          owner: OWNER_A,
          bindingId,
          executionId: `run-malformed:exec:${allocationId}`,
          allocationId,
          childId,
        },
        expectedSequence: 0,
        lifecycle: { sequence: 1, status: 'confirmed', evidence: {}, observedAt: now - 100 },
      },
      configuredNetworkId: ROUTER_V1.networkId,
      store,
      secret: 'reporter',
      providedSecret: 'reporter',
    })

    const out = await handleRead({
      networkId: ROUTER_V1.networkId,
      owner: OWNER_A,
      store,
      manifest: { ...LIVE_MANIFEST, creators: [ROUTER_V1] },
      now,
    })
    expect(out).toMatchObject({ status: 200, body: { status: 'unavailable', agents: [] } })
  })

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
  const RECOVERY_AGENT = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'
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

describe('Base recovery claim handlers', () => {
  const identity = {
    networkId: 'stellar-testnet',
    bindingId: '0123456789abcdef0123456789abcdef',
    executionId: 'run-42:exec:run-42:bridge:aave-v3',
    allocationId: 'run-42:bridge:aave-v3',
    childId: 'abcdef0123456789abcdef0123456789',
  }
  const owner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 44)).publicKey()
  const session = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 45))
  const agent = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'
  const request = {
    executionId: identity.executionId,
    bindingId: identity.bindingId,
    allocationId: identity.allocationId,
    childId: identity.childId,
    expectedRecoveryVersion: 0,
    leaseOwner: 'tab-0123456789abcdef',
  }
  const bundle = {
    schemaVersion: 1,
    identity,
    owner,
    agent,
    recoverable: true,
    recoveryVersion: 0,
    intent: {
      runId: 'run-42',
      grantTxHash: '66'.repeat(32),
      bindingHash: 'dd'.repeat(32),
      baseJobId: identity.childId,
      kernelAddress: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000b2',
      proxyTarget: 'aave-v3',
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      minShares: '900000',
    },
    phases: [],
    events: [],
  }
  const authority = {
    routerOwner: owner,
    scope: { owner, revoked: false, expiry: 2_000_000_100 },
    signer: session.rawPublicKey(),
  }
  const actionBundle = {
    ...bundle,
    recoveryVersion: 2,
    phases: [
      {
        eventId: '1'.repeat(64),
        identity,
        recoveryVersion: 1,
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: {
          burnTxHash: '66'.repeat(32),
          expectationDigest: 'dd'.repeat(32),
          burnUnits7: '1000000',
          messageDigest: `0x${'88'.repeat(32)}`,
          nonce: `0x${'77'.repeat(32)}`,
        },
        observedAt: 2_000_000_000_001,
      },
      {
        eventId: '2'.repeat(64),
        identity,
        recoveryVersion: 2,
        phase: 'cctp_attestation',
        state: 'confirmed',
        evidence: {
          burnTxHash: '66'.repeat(32),
          expectationDigest: 'dd'.repeat(32),
          messageDigest: `0x${'88'.repeat(32)}`,
          attestationDigest: `0x${'99'.repeat(32)}`,
          nonce: `0x${'77'.repeat(32)}`,
          evidenceVersion: 2,
        },
        observedAt: 2_000_000_000_002,
      },
    ],
    events: [
      {
        eventId: '1'.repeat(64),
        identity,
        owner,
        agent,
        recoveryVersion: 1,
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: {
          burnTxHash: '66'.repeat(32),
          expectationDigest: 'dd'.repeat(32),
          burnUnits7: '1000000',
          messageDigest: `0x${'88'.repeat(32)}`,
          nonce: `0x${'77'.repeat(32)}`,
        },
        observedAt: 2_000_000_000_001,
      },
      {
        eventId: '2'.repeat(64),
        identity,
        owner,
        agent,
        recoveryVersion: 2,
        phase: 'cctp_attestation',
        state: 'confirmed',
        evidence: {
          burnTxHash: '66'.repeat(32),
          expectationDigest: 'dd'.repeat(32),
          messageDigest: `0x${'88'.repeat(32)}`,
          attestationDigest: `0x${'99'.repeat(32)}`,
          nonce: `0x${'77'.repeat(32)}`,
          evidenceVersion: 2,
        },
        observedAt: 2_000_000_000_002,
      },
    ],
  }
  async function signedArgs(overrides = {}, bundleValue = bundle) {
    const body = { ...request, ...overrides }
    const challenge = {
      challengeId: 'base-challenge-1',
      networkId: identity.networkId,
      owner,
      agent,
      requestDigest: receiptRequestDigest(body),
      expiresAt: 2_000_000_030_000,
      createdAt: 2_000_000_000_000,
      consumedAt: null,
    }
    const store = {
      readReceiptChallenge: vi.fn(async () => challenge),
      consumeReceiptChallenge: vi.fn(async () => true),
      readBaseChildRecoveryBundle: vi.fn(async () => bundleValue),
      acquireBaseChildRecoveryLease: vi.fn(async (lease) => ({
        acquired: true,
        leaseToken: lease.leaseToken,
        expiresAt: lease.now + lease.ttlMs,
      })),
      readBaseChildRecoveryClaim: vi.fn(async (claim) => ({
        identity: claim.identity,
        owner,
        agent,
        action: claim.action,
        phase: 'cctp_mint',
        evidenceVersion: claim.evidenceVersion,
        holder: 'tab-0123456789abcdef',
        leaseToken: claim.leaseToken,
        acquiredAt: 2_000_000_000_000,
        expiresAt: 2_000_000_030_000,
      })),
      renewBaseChildRecoveryLease: vi.fn(async () => ({
        renewed: true,
        expiresAt: 2_000_000_030_010,
      })),
      releaseBaseChildRecoveryLease: vi.fn(async () => ({ released: true })),
    }
    const signature = session
      .sign(Buffer.from(receiptProofMessage(challenge)))
      .toString('base64url')
    return {
      request: body,
      proof: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, signature },
      store,
      authorityReader: async () => authority,
      now: 2_000_000_000_001,
    }
  }

  it('claims only the exact signed full identity and returns a sanitized no-action result', async () => {
    const args = await signedArgs()
    const out = await handleBaseRecoveryRequest(args)
    expect(out).toEqual({
      status: 200,
      body: {
        ok: true,
        identity,
        action: 'no-movement',
        phase: null,
        reasonCode: 'base-no-movement',
        evidenceVersion: 0,
        lease: null,
      },
    })
    expect(JSON.stringify(out.body)).not.toMatch(/intent|events|private|secret|signature|token/i)
    expect(args.store.acquireBaseChildRecoveryLease).not.toHaveBeenCalled()
  })

  it('rejects an expanded proof envelope before challenge or child reads', async () => {
    const args = await signedArgs()
    args.proof.extra = 'not-signed-protocol'
    const out = await handleBaseRecoveryRequest(args)
    expect(out).toMatchObject({ status: 400 })
    expect(args.store.readReceiptChallenge).not.toHaveBeenCalled()
  })

  it('rejects caller-supplied action/phase and reporter auth before any D1 read', async () => {
    const args = await signedArgs({ action: 'burn', phase: 'cctp_burn' })
    const out = await handleBaseRecoveryRequest(args)
    expect(out).toMatchObject({ status: 400 })
    expect(args.store.readReceiptChallenge).not.toHaveBeenCalled()
    const reporter = await handleBaseRecoveryClaim({
      body: { identity, action: 'submit-mint', evidenceVersion: 0, leaseToken: 'aa'.repeat(32) },
      store: args.store,
      secret: 'reporter-secret',
      providedSecret: 'wrong',
    })
    expect(reporter).toEqual({ status: 401, body: { error: 'Unauthorized' } })
    expect(args.store.readBaseChildRecoveryBundle).not.toHaveBeenCalled()
    const malformedIdentity = await signedArgs({ executionId: 'run-42:exec:other-allocation' })
    const malformed = await handleBaseRecoveryRequest(malformedIdentity)
    expect(malformed).toMatchObject({ status: 400 })
    expect(malformedIdentity.store.readReceiptChallenge).not.toHaveBeenCalled()
  })

  it('returns a 256-bit lease for an actionable Base phase and permits revoked post-burn proof', async () => {
    const args = await signedArgs({ expectedRecoveryVersion: 2 }, actionBundle)
    args.authorityReader = async () => ({
      ...authority,
      scope: { ...authority.scope, revoked: true },
    })
    const out = await handleBaseRecoveryRequest(args)
    expect(out).toMatchObject({
      status: 200,
      body: {
        ok: true,
        identity,
        action: 'submit-mint',
        phase: 'cctp_mint',
        reasonCode: 'base-attestation-confirmed',
        evidenceVersion: 2,
      },
    })
    expect(out.body.lease.leaseToken).toMatch(/^[0-9a-f]{64}$/)
    expect(out.body.lease).not.toHaveProperty('action')
  })

  it('recomputes reporter claim state and keeps renew/release server-only', async () => {
    const args = await signedArgs({ expectedRecoveryVersion: 2 }, actionBundle)
    const body = {
      identity,
      action: 'submit-mint',
      evidenceVersion: 2,
      leaseToken: 'aa'.repeat(32),
    }
    const claim = await handleBaseRecoveryClaim({
      body,
      store: args.store,
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
      now: 2_000_000_000_010,
    })
    expect(claim).toMatchObject({
      status: 200,
      body: { ok: true, identity, action: 'submit-mint', evidenceVersion: 2 },
    })
    expect(claim.body.bundle).toEqual(actionBundle)
    expect(claim.body.lease).not.toHaveProperty('agent')
    const forgedAction = await handleBaseRecoveryClaim({
      body: { ...body, action: 'poll-mint' },
      store: args.store,
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
      now: 2_000_000_000_010,
    })
    expect(forgedAction).toEqual({ status: 404, body: { error: 'Base recovery claim not found' } })
    const renewed = await handleBaseRecoveryRenew({
      body: { ...body, holder: 'tab-0123456789abcdef' },
      store: args.store,
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
      now: 2_000_000_000_010,
      leaseTtlMs: 30_000,
    })
    expect(renewed).toMatchObject({ status: 200, body: { ok: true, action: 'submit-mint' } })
    expect(args.store.renewBaseChildRecoveryLease).toHaveBeenCalledWith(
      expect.objectContaining({
        now: 2_000_000_000_010,
        ttlMs: 30_000,
      })
    )
    await expect(
      handleBaseRecoveryRenew({
        body: { ...body, holder: 'tab-0123456789abcdef', now: 0 },
        store: args.store,
        secret: 'reporter-secret',
        providedSecret: 'reporter-secret',
      })
    ).resolves.toMatchObject({ status: 400 })
    expect(args.store.renewBaseChildRecoveryLease).toHaveBeenCalledOnce()
    await expect(
      handleBaseRecoveryRelease({
        body,
        store: args.store,
        secret: 'reporter-secret',
        providedSecret: 'reporter-secret',
      })
    ).resolves.toEqual({ status: 200, body: { ok: true } })
  })

  it('distinguishes an evidence-version conflict from a missing reporter claim', async () => {
    const args = await signedArgs({ expectedRecoveryVersion: 2 }, actionBundle)
    args.store.readBaseChildRecoveryBundle.mockResolvedValue({
      ...actionBundle,
      recoveryVersion: 3,
    })
    const out = await handleBaseRecoveryClaim({
      body: { identity, action: 'submit-mint', evidenceVersion: 2, leaseToken: 'aa'.repeat(32) },
      store: args.store,
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
      now: 2_000_000_000_010,
    })
    expect(out).toMatchObject({ status: 409, body: { code: 'version-conflict' } })
  })

  it('does not disclose or renew a claim whose immutable bridge agent subject has changed', async () => {
    const args = await signedArgs({ expectedRecoveryVersion: 2 }, actionBundle)
    args.store.readBaseChildRecoveryClaim.mockResolvedValue({
      identity,
      owner,
      agent: 'COTHERAGENT',
      action: 'submit-mint',
      phase: 'cctp_mint',
      evidenceVersion: 2,
      holder: 'tab-0123456789abcdef',
      leaseToken: 'aa'.repeat(32),
      acquiredAt: 2_000_000_000_000,
      expiresAt: 2_000_000_030_000,
    })
    const out = await handleBaseRecoveryClaim({
      body: { identity, action: 'submit-mint', evidenceVersion: 2, leaseToken: 'aa'.repeat(32) },
      store: args.store,
      secret: 'reporter-secret',
      providedSecret: 'reporter-secret',
      now: 2_000_000_000_010,
    })
    expect(out).toEqual({ status: 404, body: { error: 'Base recovery claim not found' } })
  })
})
