import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createAgentIndexStore } from './store.js'
import { AgentIndexConflictError, sourceIdFor } from './models.js'
import { selectBaseChildRecoveryAction } from './recovery.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
// Vite 5's SSR module graph doesn't recognize the newer `node:sqlite` builtin and tries to
// resolve it as a bare package specifier ("sqlite") instead — createRequire hands resolution to
// Node directly, bypassing Vite's transform for this one import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
const MIGRATIONS = [
  '0001_vf_gate.sql',
  '0002_agent_index.sql',
  '0003_agent_index_bounds.sql',
  '0004_agent_associations.sql',
  '0005_execution_receipts.sql',
  '0006_base_child_intents.sql',
  '0007_agent_membership_owner_pages.sql',
  '0008_base_recovery_evidence.sql',
  '0009_base_recovery_lease_token_digest.sql',
]

function applyMigrations(sqlite, through) {
  for (const filename of MIGRATIONS.slice(0, through)) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'))
  }
}

// ponytail: a hand-rolled D1 double reimplementing SQL semantics in JS would drift from real D1
// behavior (CHECK constraints, transactions) the moment a constraint changes. Node's built-in
// node:sqlite (stdlib, no new dependency) runs the ACTUAL migration SQL and wraps it in the same
// prepare/bind/run/first/all + batch surface D1 exposes — store.js never knows the difference.
// Extends frontend/api/vf/_db.js's "in-memory double" idiom to the one thing that double doesn't
// need: db.batch() transactions (see task brief note on extending it minimally in the test file).
function sqliteD1(sqlite) {
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
    _raw: sqlite, // test-only escape hatch to assert DB-level CHECK/NOT NULL constraints directly
  }
}

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  applyMigrations(sqlite, MIGRATIONS.length)
  return sqliteD1(sqlite)
}

const NETWORK = 'stellar-testnet'
const CREATOR = 'CROUTER1'
const SOURCE_ID = sourceIdFor({ networkId: NETWORK, creatorAddress: CREATOR })
const confirmedBurnEvidence = (burnUnits7 = '10000000') => ({
  burnTxHash: 'a'.repeat(64),
  expectationDigest: 'b'.repeat(64),
  burnUnits7,
})

const membership = (over = {}) => ({
  networkId: NETWORK,
  agentAddress: 'CAGENT1',
  ownerAddress: 'GOWNER1',
  creatorAddress: CREATOR,
  schemaVersion: 1,
  kind: 'deposit',
  creationLedger: 100,
  creationTx: 'tx1',
  grantTxHash: 'grant1',
  runId: `${NETWORK}:${CREATOR}:grant1`,
  runOrdinal: 0,
  provenance: { source: 'router-event' },
  ...over,
})

let db
let store

beforeEach(() => {
  db = fakeD1()
  store = createAgentIndexStore(db, { enableLegacyBaseChildWrites: true })
})

describe('createAgentIndexStore', () => {
  it('exposes exactly the documented repository API', () => {
    expect(Object.keys(store).sort()).toEqual(
      [
        'issueReceiptChallenge',
        'readReceiptChallenge',
        'consumeReceiptChallenge',
        'readExecutionReceipt',
        'readOwnerExecutionReceipts',
        'commitAuthenticatedReceiptMutation',
        'acquireRecoveryLease',
        'releaseRecoveryLease',
        'acquireBaseChildRecoveryLease',
        'readBaseChildRecoveryClaim',
        'renewBaseChildRecoveryLease',
        'releaseBaseChildRecoveryLease',
        'probeReadiness',
        'createBaseChildIntent',
        'advanceBaseChildLifecycle',
        'readBaseChildIntent',
        'readOwnerBaseChildIntents',
        'reserveBaseChildIntentBatch',
        'advanceBaseChildPhase',
        'readBaseChildRecoveryBundle',
        'readPublicBaseChildEvidence',
        'upsertMembership',
        'upsertRunAllocation',
        'readRunAllocation',
        'readOwnerRunAllocations',
        'hasAssociationEvent',
        'commitAssociation',
        'readOwnerMemberships',
        'readOwnerMembershipsPage',
        'readOwnerMaximumCreationLedger',
        'readMembershipsByAgentAddresses',
        'readCoverage',
        'ensureSourceRow',
        'commitSourcePage',
        'recordGap',
        'recordSourceError',
        'recordBackfillAudit',
      ].sort()
    )
  })

  it('keeps legacy unauthoritative Base-child writers off the production repository surface', () => {
    const productionStore = createAgentIndexStore(db)
    expect(productionStore.createBaseChildIntent).toBeUndefined()
    expect(productionStore.advanceBaseChildLifecycle).toBeUndefined()
  })

  it('probes the canonical receipt and Base-child stores before acknowledging readiness', async () => {
    await expect(store.probeReadiness()).resolves.toEqual({
      writable: true,
      schemaVersion: 1,
      stores: {
        executionReceipts: true,
        baseChildIntents: true,
        baseRecoveryEvidence: true,
      },
    })
  })

  it.each([
    'execution_receipts',
    'base_child_intents',
    'base_child_intent_batches',
    'base_child_intent_batch_items',
    'base_child_phase_events',
    'base_child_phase_projection',
    'base_child_recovery_leases',
  ])('fails readiness when canonical table %s is missing', async (table) => {
    db._raw.exec(`DROP TABLE ${table}`)
    await expect(store.probeReadiness()).rejects.toThrow()
  })
})

describe('consumeReceiptChallenge', () => {
  it('atomically lets exactly one caller consume an unexpired challenge', async () => {
    const challenge = {
      challengeId: 'challenge-consume-once',
      networkId: NETWORK,
      owner: 'GOWNER1',
      agent: 'CAGENT1',
      requestDigest: 'a'.repeat(64),
      expiresAt: 2_000,
      createdAt: 1_000,
    }
    await store.issueReceiptChallenge(challenge)
    const results = await Promise.all([
      store.consumeReceiptChallenge({ challenge, consumeToken: 'token-a', now: 1_500 }),
      store.consumeReceiptChallenge({ challenge, consumeToken: 'token-b', now: 1_500 }),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    await expect(
      store.readReceiptChallenge({ challengeId: challenge.challengeId })
    ).resolves.toMatchObject({ consumedAt: 1_500 })
  })
})

describe('probeReadiness schema contract', () => {
  it.each([
    'execution_phase_attempts',
    'execution_receipt_challenges',
    'execution_recovery_leases',
  ])('requires the canonical execution-receipt table %s', async (table) => {
    db._raw.exec(`DROP TABLE ${table}`)
    await expect(store.probeReadiness()).rejects.toThrow()
  })

  it('requires the canonical Base-child lifecycle store', async () => {
    db._raw.exec('DROP TABLE base_child_lifecycle_events')
    await expect(store.probeReadiness()).rejects.toThrow()
  })
})

describe('upsertMembership / readOwnerMemberships', () => {
  it('inserts then reads back a membership scoped to (networkId, owner)', async () => {
    await store.upsertMembership(membership())
    const rows = await store.readOwnerMemberships({ networkId: NETWORK, owner: 'GOWNER1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      address: 'CAGENT1',
      owner: 'GOWNER1',
      kind: 'deposit',
      creator: CREATOR,
    })
    expect(rows[0].provenance).toEqual({ source: 'router-event' })
  })
  it('upserts on (network_id, agent_address) conflict instead of duplicating', async () => {
    await store.upsertMembership(membership())
    await store.upsertMembership(
      membership({ provenance: { source: 'router-event', updated: true } })
    )
    const rows = await store.readOwnerMemberships({ networkId: NETWORK, owner: 'GOWNER1' })
    expect(rows).toHaveLength(1)
    expect(rows[0].provenance).toEqual({ source: 'router-event', updated: true })
  })
  it.each([
    ['ownerAddress', 'GOTHER'],
    ['creatorAddress', 'COTHER'],
    ['creationLedger', 999],
    ['creationTx', 'tx-other'],
    ['grantTxHash', 'grant-other'],
    ['runId', 'run-other'],
    ['runOrdinal', 2],
  ])('rejects immutable membership conflict in %s', async (field, value) => {
    const original = membership()
    await store.upsertMembership(original)
    const before = db._raw
      .prepare('SELECT * FROM agent_memberships WHERE network_id = ? AND agent_address = ?')
      .get(original.networkId, original.agentAddress)

    await expect(store.upsertMembership({ ...original, [field]: value })).rejects.toThrow(
      AgentIndexConflictError
    )

    expect(
      db._raw
        .prepare('SELECT * FROM agent_memberships WHERE network_id = ? AND agent_address = ?')
        .get(original.networkId, original.agentAddress)
    ).toEqual(before)
    expect(
      await store.readOwnerMemberships({
        networkId: NETWORK,
        owner: original.ownerAddress,
      })
    ).toMatchObject([{ address: original.agentAddress, runOrdinal: original.runOrdinal }])
  })
  it('uses the owner-creation index for the owner page query', () => {
    const plan = db._raw
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM agent_memberships WHERE network_id = ? AND owner_address = ?
         ORDER BY creation_ledger ASC, agent_address ASC`
      )
      .all(NETWORK, 'GOWNER1')
    expect(plan.map((step) => step.detail).join('\n')).toContain(
      'idx_agent_memberships_owner_creation'
    )
  })
  it('never returns another owner or another network', async () => {
    await store.upsertMembership(membership())
    await store.upsertMembership(membership({ agentAddress: 'CAGENT2', ownerAddress: 'GOWNER2' }))
    await store.upsertMembership(membership({ agentAddress: 'CAGENT3', networkId: 'base-sepolia' }))
    const rows = await store.readOwnerMemberships({ networkId: NETWORK, owner: 'GOWNER1' })
    expect(rows.map((r) => r.address)).toEqual(['CAGENT1'])
  })
  it('rejects an invalid agent_kind at the SQL layer (CHECK constraint), not just in JS', () => {
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO agent_memberships
             (network_id, agent_address, owner_address, creator_address, schema_version, agent_kind,
              creation_ledger, creation_tx, provenance)
           VALUES ('n','a','o','c',1,'legacy',1,'tx','{}')`
        )
        .run()
    ).toThrow(/CHECK/)
  })
  it('rejects a NULL creation_tx at the SQL layer (NOT NULL proof field)', () => {
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO agent_memberships
             (network_id, agent_address, owner_address, creator_address, schema_version, agent_kind,
              creation_ledger, creation_tx, provenance)
           VALUES ('n','a','o','c',1,'deposit',1,NULL,'{}')`
        )
        .run()
    ).toThrow(/NOT NULL/)
  })
})

describe('readOwnerMembershipsPage', () => {
  async function seedOwnerRows(count, { ledgerFor = (ordinal) => ordinal + 1 } = {}) {
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const suffix = String(ordinal).padStart(4, '0')
      await store.upsertMembership(
        membership({
          agentAddress: `CAGENT${suffix}`,
          creationLedger: ledgerFor(ordinal),
          creationTx: `tx-${suffix}`,
          grantTxHash: `grant-${suffix}`,
          runId: `run-${suffix}`,
          runOrdinal: ordinal,
        })
      )
    }
  }

  it.each([
    [201, 200],
    [501, 500],
  ])('returns a stable bounded page for %i owner rows at limit %i', async (count, limit) => {
    await seedOwnerRows(count)
    const first = await store.readOwnerMembershipsPage({
      networkId: NETWORK,
      owner: 'GOWNER1',
      limit,
      afterLedger: -1,
      afterAddress: '',
      snapshotThroughLedger: count + 10,
    })
    expect(first.rows).toHaveLength(limit)
    expect(first.hasMore).toBe(true)
    expect(first.rows.map((row) => row.address)).toEqual(
      Array.from({ length: limit }, (_, ordinal) => `CAGENT${String(ordinal).padStart(4, '0')}`)
    )

    const boundary = first.rows.at(-1)
    const second = await store.readOwnerMembershipsPage({
      networkId: NETWORK,
      owner: 'GOWNER1',
      limit,
      afterLedger: boundary.createdLedger,
      afterAddress: boundary.address,
      snapshotThroughLedger: count + 10,
    })
    expect(second.rows.map((row) => row.address)).toEqual([
      `CAGENT${String(limit).padStart(4, '0')}`,
    ])
    expect(second.hasMore).toBe(false)
  })

  it('uses the address as the exclusive boundary for rows created in the same ledger', async () => {
    await seedOwnerRows(3, { ledgerFor: () => 77 })
    const page = await store.readOwnerMembershipsPage({
      networkId: NETWORK,
      owner: 'GOWNER1',
      limit: 2,
      afterLedger: 77,
      afterAddress: 'CAGENT0000',
      snapshotThroughLedger: 77,
    })
    expect(page).toMatchObject({ hasMore: false })
    expect(page.rows.map((row) => [row.createdLedger, row.address])).toEqual([
      [77, 'CAGENT0001'],
      [77, 'CAGENT0002'],
    ])
  })

  it('uses one look-ahead row for hasMore without returning it', async () => {
    await seedOwnerRows(3)
    const page = await store.readOwnerMembershipsPage({
      networkId: NETWORK,
      owner: 'GOWNER1',
      limit: 2,
      afterLedger: -1,
      afterAddress: '',
      snapshotThroughLedger: 3,
    })
    expect(page.rows.map((row) => row.address)).toEqual(['CAGENT0000', 'CAGENT0001'])
    expect(page.hasMore).toBe(true)
  })

  it('reads the owner maximum creation ledger without loading its memberships', async () => {
    await seedOwnerRows(3, { ledgerFor: (ordinal) => [10, 99, 42][ordinal] })
    await store.upsertMembership(
      membership({ agentAddress: 'COTHER', ownerAddress: 'GOWNER2', creationLedger: 500 })
    )
    await expect(
      store.readOwnerMaximumCreationLedger({ networkId: NETWORK, owner: 'GOWNER1' })
    ).resolves.toBe(99)
  })
})

describe('upsertRunAllocation', () => {
  const allocation = (over = {}) => ({
    id: 'alloc-1',
    networkId: NETWORK,
    runId: 'run-1',
    ownerAddress: 'GOWNER1',
    bridgeAgentAddress: 'CAGENT1',
    baseChildAddress: null,
    token: 'USDC',
    units: '1000000',
    decimals: 6,
    proxyTarget: null,
    jobId: null,
    txId: null,
    executionStatus: 'queued',
    custodyLocation: 'agent',
    ...over,
  })

  it('inserts a row readable via readCoverage-adjacent DB state (round trip via raw select)', async () => {
    await store.upsertRunAllocation(allocation())
    const row = db._raw.prepare('SELECT * FROM agent_run_allocations WHERE id = ?').get('alloc-1')
    expect(row.units).toBe('1000000')
    expect(typeof row.units).toBe('string') // decimal string, never SQLite INTEGER
    expect(row.execution_status).toBe('queued')
    expect(row.custody_location).toBe('agent')
    expect(row.created_at).toBe(row.updated_at)
  })
  it('preserves created_at and advances updated_at on a later upsert', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000_000_000)
      await store.upsertRunAllocation(allocation())
      const before = db._raw
        .prepare('SELECT * FROM agent_run_allocations WHERE id = ?')
        .get('alloc-1')
      vi.setSystemTime(1_000_000_010_000) // +10s
      await store.upsertRunAllocation(allocation({ executionStatus: 'accepted' }))
      const after = db._raw
        .prepare('SELECT * FROM agent_run_allocations WHERE id = ?')
        .get('alloc-1')
      expect(after.created_at).toBe(before.created_at)
      expect(after.updated_at).toBeGreaterThan(before.updated_at)
      expect(after.execution_status).toBe('accepted')
    } finally {
      vi.useRealTimers()
    }
  })
  it('rejects an invalid custody_location at the SQL layer', () => {
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO agent_run_allocations
             (id, network_id, run_id, owner_address, bridge_agent_address, token, units, decimals,
              execution_status, custody_location, created_at, updated_at)
           VALUES ('a','n','r','o','b','USDC','1',6,'queued','cold-wallet',1,1)`
        )
        .run()
    ).toThrow(/CHECK/)
  })
  it('rejects an invalid execution_status at the SQL layer', () => {
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO agent_run_allocations
             (id, network_id, run_id, owner_address, bridge_agent_address, token, units, decimals,
              execution_status, custody_location, created_at, updated_at)
           VALUES ('a','n','r','o','b','USDC','1',6,'done','agent',1,1)`
        )
        .run()
    ).toThrow(/CHECK/)
  })
})

describe('durable relayer associations', () => {
  const association = (over = {}) => ({
    allocationId: 'run-1:bridge:aave-v3',
    networkId: NETWORK,
    runId: 'run-1',
    ownerAddress: 'GOWNER1',
    bridgeAgentAddress: 'CAGENT1',
    poolAddress: '0xpool',
    amount: { token: 'USDC', units: '1000000', decimals: 6 },
    proxyTarget: 'aave-v3',
    baseJobId: 'job-1',
    txHash: null,
    executionStatus: 'accepted',
    custodyLocation: 'in-transit',
    grantTxHash: 'grant-1',
    kernelAddress: '0xkernel',
    mandateBindingId: 'binding-1',
    mandateBindingHash: 'binding-hash-1',
    associationSource: 'relayer-attested',
    reportedAt: 1000,
    scopeCheckedAt: 999,
    ...over,
  })

  it('atomically records the latest association and its exact idempotency tuple', async () => {
    const result = await store.commitAssociation({
      association: association(),
      idempotencyKey: '["stellar-testnet","run-1","run-1:bridge:aave-v3","accepted",null]',
    })

    expect(result).toEqual({ written: 1, duplicates: 0 })
    expect(
      await store.readRunAllocation({
        networkId: NETWORK,
        allocationId: 'run-1:bridge:aave-v3',
      })
    ).toMatchObject(association())
    expect(
      await store.hasAssociationEvent({
        idempotencyKey: '["stellar-testnet","run-1","run-1:bridge:aave-v3","accepted",null]',
      })
    ).toBe(true)
    expect(
      await store.readOwnerRunAllocations({ networkId: NETWORK, owner: 'GOWNER1' })
    ).toHaveLength(1)
  })

  it('rolls back the association row if the duplicate event key makes the batch fail', async () => {
    const key = 'same-key'
    await store.commitAssociation({ association: association(), idempotencyKey: key })
    await expect(
      store.commitAssociation({
        association: association({
          allocationId: 'run-1:bridge:moonwell',
          poolAddress: '0xother',
          proxyTarget: 'moonwell',
        }),
        idempotencyKey: key,
      })
    ).rejects.toThrow()
    expect(
      await store.readRunAllocation({
        networkId: NETWORK,
        allocationId: 'run-1:bridge:moonwell',
      })
    ).toBeNull()
  })

  it('rejects an out-of-order pre-read loser without journaling evidence it did not apply', async () => {
    const acceptedKey = 'late-accepted-key'
    expect(
      await store.readRunAllocation({
        networkId: NETWORK,
        allocationId: 'run-1:bridge:aave-v3',
      })
    ).toBeNull()
    expect(
      await store.readRunAllocation({
        networkId: NETWORK,
        allocationId: 'run-1:bridge:aave-v3',
      })
    ).toBeNull()
    await store.commitAssociation({
      association: association({
        executionStatus: 'deposited',
        custodyLocation: 'base-proxy',
        txHash: '0xdeposit',
      }),
      idempotencyKey: 'terminal-key',
    })
    await expect(
      store.commitAssociation({
        association: association({
          amount: { token: 'USDC', units: '2', decimals: 6 },
          baseJobId: 'changed-job',
          grantTxHash: 'changed-grant',
          executionStatus: 'accepted',
          custodyLocation: 'unknown',
          txHash: null,
        }),
        idempotencyKey: acceptedKey,
      })
    ).rejects.toThrow(/conflict|rejected/i)

    expect(
      await store.readRunAllocation({
        networkId: NETWORK,
        allocationId: 'run-1:bridge:aave-v3',
      })
    ).toMatchObject({
      amount: { token: 'USDC', units: '1000000', decimals: 6 },
      baseJobId: 'job-1',
      grantTxHash: 'grant-1',
      executionStatus: 'deposited',
      custodyLocation: 'base-proxy',
      txHash: '0xdeposit',
    })
    expect(await store.hasAssociationEvent({ idempotencyKey: acceptedKey })).toBe(false)
  })

  it('returns a true same-tuple race as idempotent without applying or journaling twice', async () => {
    const key = 'same-tuple-race'
    expect(
      await store.commitAssociation({ association: association(), idempotencyKey: key })
    ).toEqual({ written: 1, duplicates: 0 })
    expect(
      await store.commitAssociation({ association: association(), idempotencyKey: key })
    ).toEqual({ written: 0, duplicates: 1 })
    expect(
      db._raw
        .prepare('SELECT COUNT(*) AS n FROM agent_association_events WHERE idempotency_key = ?')
        .get(key).n
    ).toBe(1)
  })

  it('allows a later lifecycle phase to replace the prior phase transaction hash', async () => {
    await store.commitAssociation({
      association: association({
        executionStatus: 'minted',
        custodyLocation: 'agent',
        txHash: '0xmint',
      }),
      idempotencyKey: 'minted-key',
    })
    await store.commitAssociation({
      association: association({
        executionStatus: 'deposited',
        custodyLocation: 'base-proxy',
        txHash: '0xdeposit',
      }),
      idempotencyKey: 'deposited-key',
    })

    expect(
      await store.readRunAllocation({
        networkId: NETWORK,
        allocationId: 'run-1:bridge:aave-v3',
      })
    ).toMatchObject({
      executionStatus: 'deposited',
      custodyLocation: 'base-proxy',
      txHash: '0xdeposit',
    })
  })

  it('does not let an advanced failed/null callback erase an observed mint transaction', async () => {
    await store.commitAssociation({
      association: association({
        executionStatus: 'minted',
        custodyLocation: 'agent',
        txHash: '0xmint',
      }),
      idempotencyKey: 'mint-observed-key',
    })
    await expect(
      store.commitAssociation({
        association: association({
          executionStatus: 'failed',
          custodyLocation: 'unknown',
          txHash: null,
        }),
        idempotencyKey: 'failed-without-evidence-key',
      })
    ).rejects.toThrow(/conflict|rejected/i)
    expect(
      await store.readRunAllocation({
        networkId: NETWORK,
        allocationId: 'run-1:bridge:aave-v3',
      })
    ).toMatchObject({
      executionStatus: 'minted',
      custodyLocation: 'agent',
      txHash: '0xmint',
    })
    expect(await store.hasAssociationEvent({ idempotencyKey: 'failed-without-evidence-key' })).toBe(
      false
    )
  })

  it('keeps a historical row association-unknown when no relayer proof exists', async () => {
    await store.upsertRunAllocation({
      id: 'legacy-allocation',
      networkId: NETWORK,
      runId: 'legacy-run',
      ownerAddress: 'GOWNER1',
      bridgeAgentAddress: 'CAGENT1',
      baseChildAddress: null,
      token: 'USDC',
      units: '1',
      decimals: 6,
      proxyTarget: null,
      jobId: null,
      txId: null,
      executionStatus: 'queued',
      custodyLocation: 'unknown',
    })
    const rows = await store.readOwnerRunAllocations({ networkId: NETWORK, owner: 'GOWNER1' })
    expect(rows[0]).toMatchObject({
      allocationId: 'legacy-allocation',
      associationSource: null,
      reportedAt: null,
      scopeCheckedAt: null,
    })
  })
})

describe('commitSourcePage', () => {
  it('creates the source row and writes memberships atomically on the first page', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'cursor-1',
      memberships: [membership()],
    })
    const { sources, gaps } = await store.readCoverage({ networkId: NETWORK })
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      sourceId: SOURCE_ID,
      indexedFromLedger: 100,
      indexedThroughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'cursor-1',
      status: 'ok',
    })
    expect(gaps).toEqual([])
    const owned = await store.readOwnerMemberships({ networkId: NETWORK, owner: 'GOWNER1' })
    expect(owned).toHaveLength(1)
  })

  it('advances indexed_through_ledger on a contiguous second page and keeps indexed_from_ledger fixed', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
    })
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 151,
      throughLedger: 200,
      finalizedThroughLedger: 198,
      cursor: 'c2',
      memberships: [],
    })
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources[0].indexedFromLedger).toBe(100)
    expect(sources[0].indexedThroughLedger).toBe(200)
    expect(sources[0].cursor).toBe('c2')
  })

  it('rolls back cursor advancement when a page conflicts with immutable membership identity', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [membership()],
    })

    await expect(
      store.commitSourcePage({
        sourceId: SOURCE_ID,
        fromLedger: 151,
        throughLedger: 200,
        finalizedThroughLedger: 198,
        cursor: 'c2',
        memberships: [membership({ creationTx: 'tx-conflict' })],
      })
    ).rejects.toThrow(AgentIndexConflictError)

    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources[0]).toMatchObject({ indexedThroughLedger: 150, cursor: 'c1' })
    expect(
      await store.readOwnerMemberships({ networkId: NETWORK, owner: 'GOWNER1' })
    ).toMatchObject([{ address: 'CAGENT1', createdTxHash: 'tx1' }])
  })

  it('rejects a non-contiguous page and leaves prior coverage state untouched', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
    })
    await expect(
      store.commitSourcePage({
        sourceId: SOURCE_ID,
        fromLedger: 160, // skips 151..159 without recording a gap first
        throughLedger: 200,
        finalizedThroughLedger: 198,
        cursor: 'c2',
        memberships: [],
      })
    ).rejects.toThrow(/contiguous|non-contiguous/i)
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources[0].indexedThroughLedger).toBe(150)
    expect(sources[0].cursor).toBe('c1')
  })

  it('rejects an invalid membership before touching the DB at all — no partial write to roll back', async () => {
    await expect(
      store.commitSourcePage({
        sourceId: SOURCE_ID,
        fromLedger: 100,
        throughLedger: 150,
        finalizedThroughLedger: 148,
        cursor: 'c1',
        memberships: [
          membership({ agentAddress: 'CAGENT-GOOD' }),
          membership({ agentAddress: 'CAGENT-BAD', kind: 'legacy' }),
        ],
      })
    ).rejects.toThrow(/kind/)
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources).toEqual([]) // rejected during shaping, before any statement was built
    const owned = await store.readOwnerMemberships({ networkId: NETWORK, owner: 'GOWNER1' })
    expect(owned).toEqual([])
  })

  it('rolls back the ENTIRE db.batch() — cursor advance AND already-valid memberships — when a later statement fails a DB-only CHECK', async () => {
    // toMembershipRow/JS pre-validation intentionally does not duplicate every DB constraint —
    // finalized_through_ledger's *lower* bound depends on indexed_from_ledger, i.e. on state
    // already read from the DB, so it is enforced by the migration's CHECK only (see store.js).
    // This drives a genuine SQL-layer failure inside db.batch() with otherwise well-formed
    // memberships in the page, proving the transaction is really all-or-nothing — not just that
    // JS validation ran first.
    await expect(
      store.commitSourcePage({
        sourceId: SOURCE_ID,
        fromLedger: 100,
        throughLedger: 150,
        finalizedThroughLedger: -50, // violates CHECK(finalized_through_ledger >= indexed_from_ledger - 1)
        cursor: 'c1',
        memberships: [
          membership({ agentAddress: 'CAGENT-GOOD-1' }),
          membership({ agentAddress: 'CAGENT-GOOD-2' }),
        ],
      })
    ).rejects.toThrow(/CHECK/)
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources).toEqual([]) // the source row's own INSERT was in the same failed transaction
    const owned = await store.readOwnerMemberships({ networkId: NETWORK, owner: 'GOWNER1' })
    expect(owned).toEqual([]) // neither otherwise-valid membership survived the rollback
  })

  it('resumes past a recorded gap by committing an empty page spanning it — the documented continuation protocol', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
    })
    // The hole is unindexable (e.g. an RPC gap) — record it explicitly...
    await store.recordGap({
      sourceId: SOURCE_ID,
      networkId: NETWORK,
      fromLedger: 151,
      throughLedger: 159,
      reason: 'rpc-timeout',
    })
    // ...then commit a page spanning the same range with no memberships to actually advance the
    // cursor. recordGap alone never moves indexed_through_ledger — this empty page is what does.
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 151,
      throughLedger: 159,
      finalizedThroughLedger: 159,
      cursor: 'c1-gap',
      memberships: [],
    })
    // Normal indexing resumes past the hole without being wedged.
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 160,
      throughLedger: 200,
      finalizedThroughLedger: 198,
      cursor: 'c2',
      memberships: [],
    })
    const { sources, gaps } = await store.readCoverage({ networkId: NETWORK })
    expect(sources[0].indexedThroughLedger).toBe(200)
    expect(gaps).toHaveLength(1) // the gap stays on record even though the cursor moved past it
    expect(gaps[0]).toMatchObject({
      sourceId: SOURCE_ID,
      fromLedger: 151,
      throughLedger: 159,
      status: 'open',
    })
  })

  it('rejects a membership whose networkId/creatorAddress does not match the source', async () => {
    await expect(
      store.commitSourcePage({
        sourceId: SOURCE_ID,
        fromLedger: 100,
        throughLedger: 150,
        finalizedThroughLedger: 148,
        cursor: 'c1',
        memberships: [membership({ creatorAddress: 'CROUTER-OTHER' })],
      })
    ).rejects.toThrow()
  })

  it('persists provider identity + reported bounds (Spec-missing 5) and updates them on a later page', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
      providerId: 'soroban-rpc',
      endpointClass: 'live',
      reportedOldestLedger: 1,
      reportedLatestLedger: 500,
    })
    let { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources[0]).toMatchObject({
      providerId: 'soroban-rpc',
      endpointClass: 'live',
      reportedOldestLedger: 1,
      reportedLatestLedger: 500,
    })
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 151,
      throughLedger: 200,
      finalizedThroughLedger: 198,
      cursor: 'c2',
      memberships: [],
      providerId: 'soroban-rpc',
      endpointClass: 'live',
      reportedOldestLedger: 1,
      reportedLatestLedger: 600,
    })
    ;({ sources } = await store.readCoverage({ networkId: NETWORK }))
    expect(sources[0].reportedLatestLedger).toBe(600)
  })

  it('leaves provider bounds NULL (never a guessed value) when the caller omits them', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
    })
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources[0]).toMatchObject({
      providerId: null,
      endpointClass: null,
      reportedOldestLedger: null,
      reportedLatestLedger: null,
    })
  })
})

describe('ensureSourceRow', () => {
  it('seeds the "nothing indexed yet" sentinel row for a brand-new source', async () => {
    await store.ensureSourceRow({
      sourceId: SOURCE_ID,
      networkId: NETWORK,
      creatorAddress: CREATOR,
      fromLedger: 500,
    })
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      indexedFromLedger: 500,
      indexedThroughLedger: 499,
      finalizedThroughLedger: 499,
      status: 'ok',
    })
  })

  it('is a no-op when the source row already exists — never regresses an already-advanced cursor', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
    })
    await store.ensureSourceRow({
      sourceId: SOURCE_ID,
      networkId: NETWORK,
      creatorAddress: CREATOR,
      fromLedger: 100,
    })
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources).toHaveLength(1)
    expect(sources[0].indexedThroughLedger).toBe(150) // untouched, not reset to the sentinel
  })

  it('lets a subsequent recordGap satisfy its FK even on a source that has never committed a real page', async () => {
    await store.ensureSourceRow({
      sourceId: SOURCE_ID,
      networkId: NETWORK,
      creatorAddress: CREATOR,
      fromLedger: 100,
    })
    await store.recordGap({
      sourceId: SOURCE_ID,
      networkId: NETWORK,
      fromLedger: 100,
      throughLedger: 199,
      reason: 'below-oldest-available-ledger',
    })
    const { gaps } = await store.readCoverage({ networkId: NETWORK })
    expect(gaps).toHaveLength(1)
  })
})

describe('recordSourceError', () => {
  it('marks the source status=error with a last_error trail WITHOUT moving the cursor, even on a first-ever page', async () => {
    await store.recordSourceError({
      sourceId: SOURCE_ID,
      networkId: NETWORK,
      creatorAddress: CREATOR,
      fromLedger: 100,
      message: 'schema drift',
    })
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      status: 'error',
      indexedThroughLedger: 99,
      lastErrorMessage: 'schema drift',
    })
    expect(sources[0].lastErrorAt).not.toBeNull()
  })

  it('marks an existing source status=error without advancing indexed_through_ledger', async () => {
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
    })
    await store.recordSourceError({
      sourceId: SOURCE_ID,
      networkId: NETWORK,
      creatorAddress: CREATOR,
      fromLedger: 151,
      message: 'schema drift again',
    })
    const { sources } = await store.readCoverage({ networkId: NETWORK })
    expect(sources[0]).toMatchObject({
      status: 'error',
      indexedThroughLedger: 150,
      lastErrorMessage: 'schema drift again',
    })
  })
})

describe('readMembershipsByAgentAddresses', () => {
  it('returns only the requested (network, address) rows', async () => {
    await store.upsertMembership(membership())
    await store.upsertMembership(membership({ agentAddress: 'CAGENT2', ownerAddress: 'GOWNER2' }))
    await store.upsertMembership(
      membership({ agentAddress: 'CAGENT-OTHER-NET', networkId: 'base-sepolia' })
    )
    const rows = await store.readMembershipsByAgentAddresses({
      networkId: NETWORK,
      agentAddresses: ['CAGENT1', 'CAGENT2', 'CAGENT-NEVER-WRITTEN'],
    })
    expect(rows.map((r) => r.address).sort()).toEqual(['CAGENT1', 'CAGENT2'])
  })

  it('returns [] for an empty address list without touching the DB', async () => {
    expect(
      await store.readMembershipsByAgentAddresses({ networkId: NETWORK, agentAddresses: [] })
    ).toEqual([])
  })
})

describe('recordGap', () => {
  it('inserts an explicit inclusive gap and readCoverage surfaces it as open', async () => {
    // A gap belongs to a registered source (agent_index_gaps.source_id is a real FK) — the
    // indexer always commits at least one page for a source before it can report a gap in it.
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
    })
    await store.recordGap({
      sourceId: SOURCE_ID,
      networkId: NETWORK,
      fromLedger: 151,
      throughLedger: 159,
      reason: 'rpc-timeout',
    })
    const { gaps } = await store.readCoverage({ networkId: NETWORK })
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({
      sourceId: SOURCE_ID,
      fromLedger: 151,
      throughLedger: 159,
      status: 'open',
    })
  })
  it('rejects throughLedger < fromLedger at the SQL layer', () => {
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO agent_index_gaps (source_id, network_id, from_ledger, through_ledger, reason, status, opened_at)
           VALUES ('s','n',20,10,'x','open',1)`
        )
        .run()
    ).toThrow(/CHECK/)
  })
})

describe('recordBackfillAudit', () => {
  it('inserts an immutable audit row and readCoverage returns it', async () => {
    // agent_backfill_audits.source_id is also a real FK — register the source first.
    await store.commitSourcePage({
      sourceId: SOURCE_ID,
      fromLedger: 100,
      throughLedger: 150,
      finalizedThroughLedger: 148,
      cursor: 'c1',
      memberships: [],
    })
    await store.recordBackfillAudit({
      networkId: NETWORK,
      sourceId: SOURCE_ID,
      method: 'horizon-tx-scan',
      result: 'verified',
      fromLedger: 1,
      throughLedger: 99,
      evidence: { txCount: 12 },
      notes: 'manual review',
    })
    const { backfillAudits } = await store.readCoverage({ networkId: NETWORK })
    expect(backfillAudits).toHaveLength(1)
    expect(backfillAudits[0]).toMatchObject({
      sourceId: SOURCE_ID,
      result: 'verified',
      method: 'horizon-tx-scan',
    })
    expect(backfillAudits[0].evidence).toEqual({ txCount: 12 })
  })
  it('has no UPDATE path in the repository — only recordBackfillAudit (insert) and readCoverage (read)', () => {
    expect(store.updateBackfillAudit).toBeUndefined()
  })
  it('rejects an invalid result at the SQL layer', () => {
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO agent_backfill_audits (network_id, source_id, attempted_at, method, result, from_ledger, through_ledger, evidence)
           VALUES ('n','s',1,'m','pending',1,2,'{}')`
        )
        .run()
    ).toThrow(/CHECK/)
  })
})

describe('migration 0001 tables are untouched', () => {
  it('api_keys still exists and is queryable', () => {
    expect(() => db._raw.prepare('SELECT * FROM api_keys').all()).not.toThrow()
  })
})

describe('migration 0008 Base recovery schema', () => {
  it('exposes execution/recovery columns and durable batch/evidence tables', () => {
    expect(() =>
      db._raw.prepare('SELECT execution_id, recovery_version FROM base_child_intents').all()
    ).not.toThrow()
    for (const table of [
      'base_child_intent_batches',
      'base_child_intent_batch_items',
      'base_child_phase_events',
      'base_child_phase_projection',
      'base_child_recovery_leases',
    ]) {
      expect(() => db._raw.prepare(`SELECT * FROM ${table}`).all()).not.toThrow()
    }
  })

  it('upgrades real legacy rows without inventing execution identity and enforces new identity', () => {
    const sqlite = new DatabaseSync(':memory:')
    applyMigrations(sqlite, 7)
    const insert = sqlite.prepare(
      `INSERT INTO base_child_intents
         (network_id,binding_id,allocation_id,child_id,owner_address,agent_address,
          intent_digest,intent_json,token,units,decimals,lifecycle_sequence,lifecycle_status,
          lifecycle_evidence_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    insert.run(
      NETWORK,
      'legacy-binding',
      'legacy-allocation',
      'legacy-child',
      'GLEGACY',
      'CLEGACY',
      'legacy-digest',
      '{"runId":"legacy-run","minShares":"0"}',
      'USDC',
      '9007199254740993000000',
      6,
      0,
      'planned',
      '{}',
      10,
      10
    )
    sqlite
      .prepare(
        `INSERT INTO base_child_lifecycle_events
           VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        NETWORK,
        'legacy-binding',
        'legacy-allocation',
        'legacy-child',
        0,
        'legacy-planned',
        'planned',
        '{}',
        10
      )

    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0008_base_recovery_evidence.sql'), 'utf8'))
    const legacy = sqlite
      .prepare(
        `SELECT execution_id,recovery_version FROM base_child_intents
         WHERE binding_id='legacy-binding'`
      )
      .get()
    expect(legacy).toEqual({ execution_id: null, recovery_version: 0 })
    expect(
      sqlite.prepare(`SELECT COUNT(*) count FROM base_child_lifecycle_events`).get().count
    ).toBe(1)

    insert.run(
      NETWORK,
      'legacy-binding-2',
      'legacy-allocation-2',
      'legacy-child-2',
      'GLEGACY',
      'CLEGACY',
      'legacy-digest-2',
      '{"runId":"legacy-run-2","minShares":"0"}',
      'USDC',
      '1',
      6,
      0,
      'planned',
      '{}',
      11,
      11
    )
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) count FROM base_child_intents WHERE execution_id IS NULL`)
        .get().count
    ).toBe(2)
    const insertNew = sqlite.prepare(
      `INSERT INTO base_child_intents
         (network_id,binding_id,execution_id,allocation_id,child_id,owner_address,agent_address,
          intent_digest,intent_json,token,units,decimals,lifecycle_sequence,lifecycle_status,
          lifecycle_evidence_json,recovery_version,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    insertNew.run(
      NETWORK,
      'new-binding',
      'new-run:exec:new-allocation',
      'new-allocation',
      'new-child',
      'GNEW',
      'CNEW',
      'new-digest',
      '{"runId":"new-run","minShares":"0"}',
      'USDC',
      '1',
      6,
      0,
      'planned',
      '{}',
      0,
      12,
      12
    )
    expect(() =>
      insertNew.run(
        NETWORK,
        'other-binding',
        'new-run:exec:new-allocation',
        'other-allocation',
        'other-child',
        'GNEW',
        'CNEW',
        'other-digest',
        '{"runId":"other-run","minShares":"0"}',
        'USDC',
        '1',
        6,
        0,
        'planned',
        '{}',
        0,
        13,
        13
      )
    ).toThrow(/unique/i)
    expect(() =>
      sqlite
        .prepare(`UPDATE base_child_intents SET execution_id=? WHERE binding_id='new-binding'`)
        .run('changed')
    ).toThrow(/immutable/i)
  })

  it('keeps recovery events append-only and enforces lease time constraints', async () => {
    const input = {
      idempotencyKey: 'schema-batch',
      burnUnits7: '10000000',
      children: [
        {
          version: 1,
          networkId: NETWORK,
          owner: 'GOWNER1',
          agent: 'CAGENT1',
          bindingId: 'schema-binding',
          executionId: 'schema-run:exec:schema-allocation',
          allocationId: 'schema-allocation',
          childId: 'schema-child',
          intent: {
            token: 'USDC',
            units: '1000000',
            decimals: 6,
            poolAddress: '0x1111111111111111111111111111111111111111',
            proxyTarget: 'aave-v3',
            minShares: '0',
            runId: 'schema-run',
            grantTxHash: 'schema-grant',
            kernelAddress: '0x2222222222222222222222222222222222222222',
            bindingHash: 'schema-hash',
            baseJobId: 'schema-child',
          },
          lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 20 },
        },
      ],
    }
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '9'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    await store.advanceBaseChildPhase({
      identity: {
        networkId: NETWORK,
        bindingId: 'schema-binding',
        executionId: 'schema-run:exec:schema-allocation',
        allocationId: 'schema-allocation',
        childId: 'schema-child',
      },
      expectedRecoveryVersion: 0,
      event: {
        eventId: '8'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence('10000000'),
        observedAt: 21,
      },
    })
    expect(() =>
      db._raw.prepare(`UPDATE base_child_phase_events SET state='failed'`).run()
    ).toThrow(/append-only/i)
    expect(() => db._raw.prepare(`DELETE FROM base_child_phase_events`).run()).toThrow(
      /append-only/i
    )
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO base_child_recovery_leases
             (network_id,binding_id,execution_id,allocation_id,child_id,phase,owner_address,
              action,evidence_version,holder,lease_token,acquired_at,expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          NETWORK,
          'schema-binding',
          'schema-run:exec:schema-allocation',
          'schema-allocation',
          'schema-child',
          'cctp_burn',
          'GOWNER1',
          'reconcile',
          1,
          'worker',
          'lease',
          30,
          30
        )
    ).toThrow(/check/i)
  })
})

describe('Base child intent and lifecycle durability', () => {
  const child = (overrides = {}) => ({
    version: 1,
    networkId: NETWORK,
    owner: 'GOWNER1',
    agent: 'CAGENT1',
    bindingId: 'binding-1',
    executionId: 'run-1:exec:run-1:bridge:aave-v3',
    allocationId: 'run-1:bridge:aave-v3',
    childId: 'job-1',
    intent: {
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress: '0xpool',
      minShares: '0',
      runId: 'run-1',
    },
    lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 1000 },
    ...overrides,
  })
  const identity = {
    networkId: NETWORK,
    owner: 'GOWNER1',
    bindingId: 'binding-1',
    allocationId: 'run-1:bridge:aave-v3',
    childId: 'job-1',
  }

  // Defect caught: immutable child retries must not duplicate rows, while changed intent under the same identity must conflict.
  it('is idempotent for exact intent and fail-closed for conflicting intent', async () => {
    const first = await store.createBaseChildIntent({
      child: child(),
      intentDigest: 'digest-1',
      idempotencyKey: 'intent-key-1',
    })
    expect(first).toEqual({ written: 1, duplicates: 0, sequence: 0 })
    await expect(
      store.createBaseChildIntent({
        child: child(),
        intentDigest: 'digest-1',
        idempotencyKey: 'intent-key-1',
      })
    ).resolves.toEqual({ written: 0, duplicates: 1, sequence: 0 })
    await expect(
      store.createBaseChildIntent({
        child: child({ intent: { ...child().intent, units: '2000000' } }),
        intentDigest: 'digest-2',
        idempotencyKey: 'intent-key-2',
      })
    ).rejects.toThrow(/immutable|conflict/i)
  })

  // Defect caught: concurrent/out-of-order lifecycle delivery must be guarded by the durable expected sequence.
  it('advances exactly one CAS sequence and rejects a stale or skipped sequence', async () => {
    await store.createBaseChildIntent({
      child: child(),
      intentDigest: 'digest-1',
      idempotencyKey: 'intent-key-1',
    })
    const request = {
      identity,
      expectedSequence: 0,
      lifecycle: {
        sequence: 1,
        status: 'submitted',
        evidence: { executionStatus: 'accepted' },
        observedAt: 1001,
      },
      idempotencyKey: 'lifecycle-key-1',
    }
    await expect(store.advanceBaseChildLifecycle(request)).resolves.toEqual({
      written: 1,
      duplicates: 0,
      sequence: 1,
    })
    await expect(
      store.advanceBaseChildLifecycle({
        ...request,
        expectedSequence: 2,
        lifecycle: { ...request.lifecycle, sequence: 3, observedAt: 1003 },
        idempotencyKey: 'lifecycle-key-3',
      })
    ).rejects.toThrow(/sequence|conflict/i)
  })
})

describe('Base recovery lease full-identity CAS store', () => {
  const identity = {
    networkId: NETWORK,
    bindingId: 'lease-binding',
    executionId: 'lease-run:exec:lease-allocation',
    allocationId: 'lease-allocation',
    childId: 'lease-child',
  }
  const child = (overrides = {}) => ({
    version: 1,
    networkId: NETWORK,
    owner: 'GLEASEOWNER',
    agent: 'CLEASEAGENT',
    bindingId: identity.bindingId,
    executionId: identity.executionId,
    allocationId: identity.allocationId,
    childId: identity.childId,
    intent: {
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      poolAddress: '0xpool',
      minShares: '0',
      runId: 'lease-run',
      grantTxHash: 'lease-grant',
      bindingHash: 'lease-binding-hash',
      kernelAddress: '0xkernel',
      baseJobId: identity.childId,
    },
    lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 1000 },
    ...overrides,
  })
  const lease = (overrides = {}) => ({
    identity,
    owner: 'GLEASEOWNER',
    action: 'submit-mint',
    phase: 'cctp_mint',
    evidenceVersion: 0,
    holder: 'tab-a',
    leaseToken: 'aa'.repeat(32),
    now: 2_000_000_000_000,
    ttlMs: 30_000,
    ...overrides,
  })
  async function seed(overrides = {}) {
    await store.reserveBaseChildIntentBatch({
      batch: {
        idempotencyKey: 'lease-batch',
        burnUnits7: '1000000',
        children: [child(overrides)],
      },
      requestDigest: 'a'.repeat(64),
      idempotencyKey: 'lease-batch',
    })
  }

  it('acquires, reopens, reads, and isolates one full-identity Base lease', async () => {
    await seed()
    const first = await store.acquireBaseChildRecoveryLease(lease())
    expect(first).toMatchObject({
      acquired: true,
      leaseToken: 'aa'.repeat(32),
      expiresAt: 2_000_000_030_000,
    })
    const reopened = createAgentIndexStore(db, { enableLegacyBaseChildWrites: true })
    await expect(reopened.readBaseChildRecoveryClaim(lease())).resolves.toMatchObject({
      identity,
      owner: 'GLEASEOWNER',
      agent: 'CLEASEAGENT',
      action: 'submit-mint',
      phase: 'cctp_mint',
      evidenceVersion: 0,
      holder: 'tab-a',
      leaseToken: 'aa'.repeat(32),
    })
  })

  it('persists only a one-way lease-token digest while authenticating the exact raw token', async () => {
    await seed()
    const rawToken = 'aa'.repeat(32)
    await expect(
      store.acquireBaseChildRecoveryLease(lease({ leaseToken: rawToken }))
    ).resolves.toMatchObject({
      acquired: true,
      leaseToken: rawToken,
    })
    const stored = db._raw
      .prepare('SELECT lease_token FROM base_child_recovery_leases')
      .get().lease_token
    expect(stored).toBe(createHash('sha256').update(rawToken).digest('hex'))
    expect(stored).not.toBe(rawToken)
    expect(
      JSON.stringify(db._raw.prepare('SELECT * FROM base_child_recovery_leases').all())
    ).not.toContain(rawToken)
    await expect(
      store.readBaseChildRecoveryClaim(lease({ leaseToken: rawToken }))
    ).resolves.toMatchObject({
      leaseToken: rawToken,
    })
    await expect(
      store.readBaseChildRecoveryClaim(lease({ leaseToken: 'bb'.repeat(32) }))
    ).resolves.toBeNull()
  })

  it('invalidates legacy raw-token leases when migration 0009 activates digest storage', async () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      applyMigrations(sqlite, 8)
      const legacyStore = createAgentIndexStore(sqliteD1(sqlite), {
        enableLegacyBaseChildWrites: true,
      })
      await legacyStore.reserveBaseChildIntentBatch({
        batch: {
          idempotencyKey: 'legacy-raw-token-batch',
          burnUnits7: '1000000',
          children: [child()],
        },
        requestDigest: 'f'.repeat(64),
        idempotencyKey: 'legacy-raw-token-batch',
      })
      await legacyStore.acquireBaseChildRecoveryLease(lease())
      const rawLegacyToken = 'ef'.repeat(32)
      sqlite.prepare('UPDATE base_child_recovery_leases SET lease_token = ?').run(rawLegacyToken)
      expect(
        JSON.stringify(sqlite.prepare('SELECT * FROM base_child_recovery_leases').all())
      ).toContain(rawLegacyToken)

      sqlite.exec(
        readFileSync(join(MIGRATIONS_DIR, '0009_base_recovery_lease_token_digest.sql'), 'utf8')
      )

      expect(
        sqlite.prepare('SELECT COUNT(*) AS count FROM base_child_recovery_leases').get().count
      ).toBe(0)
      expect(
        JSON.stringify(sqlite.prepare('SELECT * FROM base_child_recovery_leases').all())
      ).not.toContain(rawLegacyToken)
    } finally {
      sqlite.close()
    }
  })

  it('does not let a different holder reuse the live token and preserves lease bytes', async () => {
    await seed()
    await expect(store.acquireBaseChildRecoveryLease(lease())).resolves.toMatchObject({
      acquired: true,
    })
    const selectLease = () =>
      db._raw
        .prepare(
          `SELECT network_id,binding_id,execution_id,allocation_id,child_id,phase,owner_address,
                  action,evidence_version,holder,lease_token,acquired_at,expires_at
             FROM base_child_recovery_leases
            WHERE network_id = ? AND binding_id = ? AND execution_id = ?
              AND allocation_id = ? AND child_id = ? AND phase = ?`
        )
        .get(
          identity.networkId,
          identity.bindingId,
          identity.executionId,
          identity.allocationId,
          identity.childId,
          'cctp_mint'
        )
    const before = selectLease()
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({ holder: 'tab-b', now: 2_000_000_000_001, ttlMs: 90_000 })
      )
    ).resolves.toMatchObject({ acquired: false, code: 'lease-conflict' })
    expect(selectLease()).toEqual(before)
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({
          action: 'poll-mint',
          holder: 'tab-b',
          leaseToken: 'bb'.repeat(32),
          now: 2_000_000_030_000,
        })
      )
    ).resolves.toMatchObject({ acquired: false, code: 'lease-conflict' })
    expect(selectLease()).toEqual(before)

    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({ holder: 'tab-a', now: 2_000_000_000_001, ttlMs: 90_000 })
      )
    ).resolves.toMatchObject({ acquired: true, expiresAt: 2_000_000_090_001 })
    expect(selectLease()).toMatchObject({
      holder: 'tab-a',
      lease_token: createHash('sha256').update('aa'.repeat(32)).digest('hex'),
      acquired_at: 2_000_000_000_001,
      expires_at: 2_000_000_090_001,
    })
  })

  it('permits exactly one live token, treats expiry equality as reclaimable, and rejects stale versions', async () => {
    await seed()
    await expect(store.acquireBaseChildRecoveryLease(lease())).resolves.toMatchObject({
      acquired: true,
    })
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({ holder: 'tab-b', leaseToken: 'bb'.repeat(32), now: 2_000_000_000_001 })
      )
    ).resolves.toMatchObject({ acquired: false })
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({ holder: 'tab-b', leaseToken: 'bb'.repeat(32), now: 2_000_000_030_000 - 1 })
      )
    ).resolves.toMatchObject({ acquired: false })
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({ holder: 'tab-b', leaseToken: 'bb'.repeat(32), now: 2_000_000_030_000 })
      )
    ).resolves.toMatchObject({ acquired: true })
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({
          evidenceVersion: 1,
          holder: 'tab-c',
          leaseToken: 'cc'.repeat(32),
          now: 2_000_000_040_000,
        })
      )
    ).resolves.toMatchObject({ acquired: false, code: 'version-conflict' })
  })

  it('reads/renews/releases only the exact identity, action, version, holder, and token', async () => {
    await seed()
    await store.acquireBaseChildRecoveryLease(lease())
    await expect(
      store.readBaseChildRecoveryClaim({ ...lease(), leaseToken: 'bb'.repeat(32) })
    ).resolves.toBeNull()
    await expect(
      store.readBaseChildRecoveryClaim({
        ...lease(),
        identity: { ...identity, executionId: 'other-run:exec:lease-allocation' },
      })
    ).resolves.toBeNull()
    await expect(
      store.renewBaseChildRecoveryLease({ ...lease(), now: 2_000_000_000_010, ttlMs: 30_000 })
    ).resolves.toMatchObject({ renewed: true, expiresAt: 2_000_000_030_010 })
    await expect(
      store.renewBaseChildRecoveryLease({
        ...lease(),
        leaseToken: 'bb'.repeat(32),
        now: 2_000_000_000_020,
        ttlMs: 30_000,
      })
    ).resolves.toMatchObject({ renewed: false })
    await expect(
      store.releaseBaseChildRecoveryLease({ ...lease(), leaseToken: 'bb'.repeat(32) })
    ).resolves.toMatchObject({ released: false })
    await expect(store.releaseBaseChildRecoveryLease(lease())).resolves.toMatchObject({
      released: true,
    })
    await expect(store.readBaseChildRecoveryClaim(lease())).resolves.toBeNull()
  })

  it('replaces a stale-version row only after the child CAS advances, without waiting for expiry', async () => {
    await seed()
    await store.acquireBaseChildRecoveryLease(lease())
    await store.advanceBaseChildPhase({
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'c'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence(),
        observedAt: 2_000_000_000_001,
      },
    })
    await expect(
      store.readBaseChildRecoveryClaim({
        ...lease({ evidenceVersion: 0, leaseToken: 'aa'.repeat(32), now: 2_000_000_000_002 }),
        includeVersionConflict: true,
      })
    ).resolves.toMatchObject({ conflict: 'version', currentVersion: 1 })
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({
          evidenceVersion: 1,
          holder: 'tab-b',
          leaseToken: 'bb'.repeat(32),
          now: 2_000_000_000_002,
        })
      )
    ).resolves.toMatchObject({ acquired: true })
    await expect(
      store.readBaseChildRecoveryClaim(
        lease({ evidenceVersion: 0, leaseToken: 'aa'.repeat(32), now: 2_000_000_000_002 })
      )
    ).resolves.toBeNull()
  })

  it('keeps the stale lease row byte-for-byte intact when replacement insert fails', async () => {
    await seed()
    await store.acquireBaseChildRecoveryLease(lease())
    await store.advanceBaseChildPhase({
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'd'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence(),
        observedAt: 2_000_000_000_001,
      },
    })
    const before = db._raw
      .prepare(
        `SELECT network_id,binding_id,execution_id,allocation_id,child_id,phase,owner_address,
                action,evidence_version,holder,lease_token,acquired_at,expires_at
           FROM base_child_recovery_leases`
      )
      .all()
    db._raw.exec(`
      CREATE TRIGGER task14_abort_recovery_replacement
      BEFORE INSERT ON base_child_recovery_leases
      WHEN NEW.evidence_version = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected recovery replacement failure');
      END;
    `)
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({
          evidenceVersion: 1,
          holder: 'tab-b',
          leaseToken: 'bb'.repeat(32),
          now: 2_000_000_000_002,
        })
      )
    ).rejects.toThrow(/replacement failure/i)
    expect(
      db._raw
        .prepare(
          `SELECT network_id,binding_id,execution_id,allocation_id,child_id,phase,owner_address,
                  action,evidence_version,holder,lease_token,acquired_at,expires_at
             FROM base_child_recovery_leases`
        )
        .all()
    ).toEqual(before)
  })

  it('keeps same-child collisions independent and refuses orphan identities', async () => {
    await seed()
    const collision = {
      ...identity,
      bindingId: 'lease-binding-2',
      executionId: 'lease-run-2:exec:lease-allocation-2',
      allocationId: 'lease-allocation-2',
    }
    await store.reserveBaseChildIntentBatch({
      batch: {
        idempotencyKey: 'lease-batch-2',
        burnUnits7: '1000000',
        children: [
          child({
            ...collision,
            intent: {
              ...child().intent,
              runId: 'lease-run-2',
              baseJobId: collision.childId,
            },
          }),
        ],
      },
      requestDigest: 'b'.repeat(64),
      idempotencyKey: 'lease-batch-2',
    })
    await expect(store.acquireBaseChildRecoveryLease(lease())).resolves.toMatchObject({
      acquired: true,
    })
    await expect(
      store.acquireBaseChildRecoveryLease(
        lease({ identity: collision, holder: 'tab-b', leaseToken: 'bb'.repeat(32) })
      )
    ).resolves.toMatchObject({ acquired: true })
    const orphan = {
      ...identity,
      allocationId: 'missing-allocation',
      executionId: 'lease-run:exec:missing-allocation',
    }
    await expect(
      store.acquireBaseChildRecoveryLease(lease({ identity: orphan, leaseToken: 'cc'.repeat(32) }))
    ).resolves.toMatchObject({ acquired: false })
  })
})

describe('Task 9 authoritative Base child recovery store', () => {
  const child = (ordinal = 1, overrides = {}) => {
    const allocationId = `allocation-${ordinal}`
    return {
      version: 1,
      networkId: NETWORK,
      owner: 'GOWNER1',
      agent: 'CAGENT1',
      bindingId: 'binding-batch-1',
      executionId: `run-batch-1:exec:${allocationId}`,
      allocationId,
      childId: `job-${ordinal}`,
      intent: {
        token: 'USDC',
        units: '1000000',
        decimals: 6,
        poolAddress: '0x1111111111111111111111111111111111111111',
        proxyTarget: 'aave-v3',
        minShares: '0',
        runId: 'run-batch-1',
        grantTxHash: 'grant-batch-1',
        kernelAddress: '0x2222222222222222222222222222222222222222',
        bindingHash: 'binding-hash-batch-1',
        baseJobId: 'job-batch-1',
      },
      lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt: 2000 },
      ...overrides,
    }
  }
  const batch = (overrides = {}) => ({
    idempotencyKey: 'batch-key-1',
    burnUnits7: '30000000',
    children: [child(1), child(2), child(3)],
    ...overrides,
  })
  const identity = {
    networkId: NETWORK,
    bindingId: 'binding-batch-1',
    executionId: 'run-batch-1:exec:allocation-1',
    allocationId: 'allocation-1',
    childId: 'job-1',
  }

  it('atomically reserves one ordered batch and makes an exact retry a no-op', async () => {
    const input = batch()
    await expect(
      store.reserveBaseChildIntentBatch({
        batch: input,
        requestDigest: '1'.repeat(64),
        idempotencyKey: input.idempotencyKey,
      })
    ).resolves.toMatchObject({ written: 3, duplicates: 0 })
    expect(
      db._raw.prepare('SELECT COUNT(*) count FROM base_child_intent_batches').get().count
    ).toBe(1)
    expect(
      db._raw.prepare('SELECT COUNT(*) count FROM base_child_intent_batch_items').get().count
    ).toBe(3)
    expect(db._raw.prepare('SELECT COUNT(*) count FROM base_child_intents').get().count).toBe(3)
    expect(
      db._raw.prepare('SELECT COUNT(*) count FROM base_child_lifecycle_events').get().count
    ).toBe(3)
    await expect(
      store.reserveBaseChildIntentBatch({
        batch: input,
        requestDigest: '1'.repeat(64),
        idempotencyKey: input.idempotencyKey,
      })
    ).resolves.toMatchObject({ written: 0, duplicates: 3 })
    expect(
      db._raw.prepare('SELECT COUNT(*) count FROM base_child_lifecycle_events').get().count
    ).toBe(3)
  })

  it('concurrently resolves exact reservations across two real SQLite connections as one write and one retry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vf-task9-exact-'))
    const databasePath = join(directory, 'agent-index.sqlite')
    const sqliteA = new DatabaseSync(databasePath)
    const sqliteB = new DatabaseSync(databasePath)
    try {
      sqliteA.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
      applyMigrations(sqliteA, MIGRATIONS.length)
      sqliteB.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
      const storeA = createAgentIndexStore(sqliteD1(sqliteA))
      const storeB = createAgentIndexStore(sqliteD1(sqliteB))
      const input = batch({ idempotencyKey: 'concurrent-exact' })
      const reservation = {
        batch: input,
        requestDigest: 'd'.repeat(64),
        idempotencyKey: input.idempotencyKey,
      }

      const outcomes = await Promise.all([
        storeA.reserveBaseChildIntentBatch(reservation),
        storeB.reserveBaseChildIntentBatch(reservation),
      ])

      expect(outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ written: 3, duplicates: 0 }),
          expect.objectContaining({ written: 0, duplicates: 3 }),
        ])
      )
      expect(
        sqliteA
          .prepare(`SELECT COUNT(*) count FROM base_child_intent_batches WHERE idempotency_key=?`)
          .get(input.idempotencyKey).count
      ).toBe(1)
      expect(
        sqliteA
          .prepare(
            `SELECT COUNT(*) count FROM base_child_intent_batch_items WHERE idempotency_key=?`
          )
          .get(input.idempotencyKey).count
      ).toBe(3)
    } finally {
      sqliteB.close()
      sqliteA.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('concurrently resolves conflicting reservations across two real SQLite connections all-or-none', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vf-task9-conflict-'))
    const databasePath = join(directory, 'agent-index.sqlite')
    const sqliteA = new DatabaseSync(databasePath)
    const sqliteB = new DatabaseSync(databasePath)
    try {
      sqliteA.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
      applyMigrations(sqliteA, MIGRATIONS.length)
      sqliteB.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
      const storeA = createAgentIndexStore(sqliteD1(sqliteA))
      const storeB = createAgentIndexStore(sqliteD1(sqliteB))
      const exact = batch({ idempotencyKey: 'concurrent-conflict' })
      const changed = { ...exact, burnUnits7: '30000010' }

      const outcomes = await Promise.allSettled([
        storeA.reserveBaseChildIntentBatch({
          batch: exact,
          requestDigest: 'e'.repeat(64),
          idempotencyKey: exact.idempotencyKey,
        }),
        storeB.reserveBaseChildIntentBatch({
          batch: changed,
          requestDigest: 'f'.repeat(64),
          idempotencyKey: changed.idempotencyKey,
        }),
      ])

      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect(outcomes.find(({ status }) => status === 'fulfilled').value).toMatchObject({
        written: 3,
        duplicates: 0,
      })
      expect(outcomes.find(({ status }) => status === 'rejected').reason).toBeInstanceOf(
        AgentIndexConflictError
      )
      expect(
        sqliteA
          .prepare(`SELECT COUNT(*) count FROM base_child_intent_batches WHERE idempotency_key=?`)
          .get(exact.idempotencyKey).count
      ).toBe(1)
      expect(
        sqliteA
          .prepare(
            `SELECT COUNT(*) count FROM base_child_intent_batch_items WHERE idempotency_key=?`
          )
          .get(exact.idempotencyKey).count
      ).toBe(3)
    } finally {
      sqliteB.close()
      sqliteA.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects changed content under one key without changing the original batch', async () => {
    const input = batch()
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '1'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    await expect(
      store.reserveBaseChildIntentBatch({
        batch: { ...input, burnUnits7: '30000010' },
        requestDigest: '2'.repeat(64),
        idempotencyKey: input.idempotencyKey,
      })
    ).rejects.toBeInstanceOf(AgentIndexConflictError)
    expect(
      db._raw.prepare('SELECT burn_units_7 FROM base_child_intent_batches').get().burn_units_7
    ).toBe('30000000')
  })

  it('rolls back every new row when a later child conflicts', async () => {
    const prior = child(2, { bindingId: 'other-binding' })
    await store.reserveBaseChildIntentBatch({
      batch: { idempotencyKey: 'prior-key', burnUnits7: '10000000', children: [prior] },
      requestDigest: '3'.repeat(64),
      idempotencyKey: 'prior-key',
    })
    await expect(
      store.reserveBaseChildIntentBatch({
        batch: batch(),
        requestDigest: '1'.repeat(64),
        idempotencyKey: 'batch-key-1',
      })
    ).rejects.toBeInstanceOf(AgentIndexConflictError)
    expect(
      db._raw
        .prepare(
          "SELECT COUNT(*) count FROM base_child_intent_batches WHERE idempotency_key='batch-key-1'"
        )
        .get().count
    ).toBe(0)
    expect(
      db._raw
        .prepare("SELECT COUNT(*) count FROM base_child_intents WHERE binding_id='binding-batch-1'")
        .get().count
    ).toBe(0)
  })

  it('rolls back receipt, children, events, and items when the final batch statement aborts', async () => {
    db._raw.exec(`
      CREATE TRIGGER task9_abort_last_item
      BEFORE INSERT ON base_child_intent_batch_items
      WHEN NEW.ordinal = 2
      BEGIN
        SELECT RAISE(ABORT, 'injected final item failure');
      END;
    `)
    const input = batch({ idempotencyKey: 'last-statement-failure' })
    await expect(
      store.reserveBaseChildIntentBatch({
        batch: input,
        requestDigest: '7'.repeat(64),
        idempotencyKey: input.idempotencyKey,
      })
    ).rejects.toThrow(/store failed/i)
    for (const table of [
      'base_child_intent_batches',
      'base_child_intent_batch_items',
      'base_child_intents',
      'base_child_lifecycle_events',
    ]) {
      expect(db._raw.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count).toBe(0)
    }
  })

  it('makes durable batch receipts and items append-only', async () => {
    const input = batch({ idempotencyKey: 'immutable-batch' })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: 'a'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    expect(() =>
      db._raw
        .prepare(`UPDATE base_child_intent_batches SET burn_units_7='1' WHERE idempotency_key=?`)
        .run(input.idempotencyKey)
    ).toThrow(/append-only/i)
    expect(() =>
      db._raw
        .prepare(`DELETE FROM base_child_intent_batches WHERE idempotency_key=?`)
        .run(input.idempotencyKey)
    ).toThrow(/append-only/i)
    expect(() =>
      db._raw
        .prepare(
          `UPDATE base_child_intent_batch_items SET intent_digest=?
           WHERE idempotency_key=? AND ordinal=0`
        )
        .run('changed', input.idempotencyKey)
    ).toThrow(/append-only/i)
    expect(() =>
      db._raw
        .prepare(`DELETE FROM base_child_intent_batch_items WHERE idempotency_key=? AND ordinal=0`)
        .run(input.idempotencyKey)
    ).toThrow(/append-only/i)
    await expect(
      store.reserveBaseChildIntentBatch({
        batch: input,
        requestDigest: 'a'.repeat(64),
        idempotencyKey: input.idempotencyKey,
      })
    ).resolves.toMatchObject({ written: 0, duplicates: 3 })
  })

  it('rejects a batch item whose child facts do not match its parent batch context', async () => {
    const first = batch({
      idempotencyKey: 'parent-batch-a',
      children: [child(1)],
      burnUnits7: '10000000',
    })
    const foreignChild = child(9, {
      owner: 'GOWNER2',
      agent: 'CAGENT2',
      bindingId: 'foreign-binding',
      executionId: 'foreign-run:exec:foreign-allocation',
      allocationId: 'foreign-allocation',
      childId: 'foreign-child',
      intent: {
        ...child(9).intent,
        runId: 'foreign-run',
        grantTxHash: 'foreign-grant',
        bindingHash: 'foreign-binding-hash',
        baseJobId: 'foreign-child',
      },
    })
    const second = {
      idempotencyKey: 'parent-batch-b',
      burnUnits7: '10000000',
      children: [foreignChild],
    }
    await store.reserveBaseChildIntentBatch({
      batch: first,
      requestDigest: 'b'.repeat(64),
      idempotencyKey: first.idempotencyKey,
    })
    await store.reserveBaseChildIntentBatch({
      batch: second,
      requestDigest: 'c'.repeat(64),
      idempotencyKey: second.idempotencyKey,
    })
    const foreignItem = db._raw
      .prepare(
        `SELECT network_id,binding_id,execution_id,allocation_id,child_id,
                owner_address,agent_address,intent_digest
         FROM base_child_intent_batch_items WHERE idempotency_key=?`
      )
      .get(second.idempotencyKey)
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO base_child_intent_batch_items
             (idempotency_key,ordinal,network_id,binding_id,execution_id,allocation_id,
              child_id,owner_address,agent_address,intent_digest)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(first.idempotencyKey, 1, ...Object.values(foreignItem))
    ).toThrow(/batch item facts/i)
    expect(
      db._raw
        .prepare(`SELECT COUNT(*) count FROM base_child_intent_batch_items WHERE idempotency_key=?`)
        .get(first.idempotencyKey).count
    ).toBe(1)
  })

  it('rejects a valid common-context child item outside its parent receipt ordinal range', async () => {
    const first = batch({
      idempotencyKey: 'ordinal-parent-a',
      children: [child(1)],
      burnUnits7: '10000000',
    })
    const second = batch({
      idempotencyKey: 'ordinal-parent-b',
      children: [child(9)],
      burnUnits7: '10000000',
    })
    await store.reserveBaseChildIntentBatch({
      batch: first,
      requestDigest: '1'.repeat(64),
      idempotencyKey: first.idempotencyKey,
    })
    await store.reserveBaseChildIntentBatch({
      batch: second,
      requestDigest: '2'.repeat(64),
      idempotencyKey: second.idempotencyKey,
    })
    const siblingItem = db._raw
      .prepare(
        `SELECT network_id,binding_id,execution_id,allocation_id,child_id,
                owner_address,agent_address,intent_digest
         FROM base_child_intent_batch_items WHERE idempotency_key=?`
      )
      .get(second.idempotencyKey)
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO base_child_intent_batch_items
             (idempotency_key,ordinal,network_id,binding_id,execution_id,allocation_id,
              child_id,owner_address,agent_address,intent_digest)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(first.idempotencyKey, 1, ...Object.values(siblingItem))
    ).toThrow(/batch item facts/i)
  })

  it('advances evidence with full-identity CAS and exact replay', async () => {
    const input = batch({ children: [child(1)], burnUnits7: '10000000' })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '1'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    const request = {
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'a'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence('10000000'),
        observedAt: 2100,
      },
    }
    await expect(store.advanceBaseChildPhase(request)).resolves.toMatchObject({
      written: 1,
      duplicates: 0,
      recoveryVersion: 1,
      eventId: 'a'.repeat(64),
    })
    await expect(store.advanceBaseChildPhase(request)).resolves.toMatchObject({
      written: 0,
      duplicates: 1,
      recoveryVersion: 1,
    })
    await expect(
      store.advanceBaseChildPhase({
        ...request,
        event: { ...request.event, evidence: confirmedBurnEvidence('10000001') },
      })
    ).rejects.toBeInstanceOf(AgentIndexConflictError)
    await expect(
      store.advanceBaseChildPhase({
        ...request,
        event: {
          ...request.event,
          eventId: 'b'.repeat(64),
          evidence: confirmedBurnEvidence('10000001'),
        },
      })
    ).rejects.toBeInstanceOf(AgentIndexConflictError)
    await expect(
      store.advanceBaseChildPhase({
        ...request,
        identity: { ...identity, executionId: 'run-batch-1:exec:allocation-2' },
        event: { ...request.event, eventId: 'c'.repeat(64) },
      })
    ).rejects.toBeInstanceOf(AgentIndexConflictError)
  })

  it.each([
    ['state', (request) => ({ ...request, event: { ...request.event, state: 'submitted' } })],
    ['observed time', (request) => ({ ...request, event: { ...request.event, observedAt: 2101 } })],
    [
      'phase',
      (request) => ({
        ...request,
        event: { ...request.event, phase: 'cctp_attestation', evidence: {} },
      }),
    ],
    [
      'evidence',
      (request) => ({
        ...request,
        event: { ...request.event, evidence: confirmedBurnEvidence('10000001') },
      }),
    ],
    [
      'network identity',
      (request) => ({ ...request, identity: { ...request.identity, networkId: 'other-network' } }),
    ],
    [
      'binding identity',
      (request) => ({ ...request, identity: { ...request.identity, bindingId: 'other-binding' } }),
    ],
    [
      'execution identity',
      (request) => ({
        ...request,
        identity: { ...request.identity, executionId: 'run-batch-1:exec:allocation-2' },
      }),
    ],
    [
      'allocation identity',
      (request) => ({
        ...request,
        identity: { ...request.identity, allocationId: 'allocation-2' },
      }),
    ],
    [
      'child identity',
      (request) => ({ ...request, identity: { ...request.identity, childId: 'job-2' } }),
    ],
  ])('rejects a same-event-id replay with changed %s', async (_label, mutate) => {
    const input = batch({
      idempotencyKey: `same-event-${_label.replaceAll(' ', '-')}`,
      children: [child(1)],
      burnUnits7: '10000000',
    })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '8'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    const request = {
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: '9'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence('10000000'),
        observedAt: 2100,
      },
    }
    await store.advanceBaseChildPhase(request)

    await expect(store.advanceBaseChildPhase(mutate(request))).rejects.toBeInstanceOf(
      AgentIndexConflictError
    )
    expect(db._raw.prepare(`SELECT COUNT(*) count FROM base_child_phase_events`).get().count).toBe(
      1
    )
    expect(
      db._raw.prepare(`SELECT recovery_version FROM base_child_intents`).get().recovery_version
    ).toBe(1)
  })

  it.each([
    ['owner', 'owner_address', 'GOWNER-OTHER'],
    ['agent', 'agent_address', 'CAGENT-OTHER'],
  ])(
    'rejects a same-event-id replay whose existing event has an %s-only subject mutation',
    async (_label, column, changedValue) => {
      const input = batch({
        idempotencyKey: `same-event-subject-${_label}`,
        children: [child(1)],
        burnUnits7: '10000000',
      })
      await store.reserveBaseChildIntentBatch({
        batch: input,
        requestDigest: 'a'.repeat(64),
        idempotencyKey: input.idempotencyKey,
      })
      const request = {
        identity,
        expectedRecoveryVersion: 0,
        event: {
          eventId: 'b'.repeat(64),
          phase: 'cctp_burn',
          state: 'confirmed',
          evidence: confirmedBurnEvidence('10000000'),
          observedAt: 2100,
        },
      }
      await store.advanceBaseChildPhase(request)
      const beforeEvent = db._raw
        .prepare(`SELECT * FROM base_child_phase_events WHERE event_id=?`)
        .get(request.event.eventId)
      const beforeProjection = db._raw.prepare(`SELECT * FROM base_child_phase_projection`).get()
      const beforeIntent = db._raw
        .prepare(
          `SELECT recovery_version,updated_at FROM base_child_intents
           WHERE network_id=? AND binding_id=? AND allocation_id=? AND child_id=?`
        )
        .get(identity.networkId, identity.bindingId, identity.allocationId, identity.childId)

      const realPrepare = db.prepare
      db.prepare = (sql) => {
        const statement = realPrepare.call(db, sql)
        if (!sql.includes('SELECT * FROM base_child_phase_events WHERE event_id = ?')) {
          return statement
        }
        return {
          bind(...args) {
            const bound = statement.bind(...args)
            return {
              ...bound,
              first() {
                const row = bound.first()
                return row ? { ...row, [column]: changedValue } : row
              },
            }
          },
        }
      }
      try {
        await expect(store.advanceBaseChildPhase(request)).rejects.toBeInstanceOf(
          AgentIndexConflictError
        )
      } finally {
        db.prepare = realPrepare
      }

      expect(
        db._raw
          .prepare(`SELECT * FROM base_child_phase_events WHERE event_id=?`)
          .get(request.event.eventId)
      ).toEqual(beforeEvent)
      expect(db._raw.prepare(`SELECT * FROM base_child_phase_projection`).get()).toEqual(
        beforeProjection
      )
      expect(
        db._raw
          .prepare(
            `SELECT recovery_version,updated_at FROM base_child_intents
             WHERE network_id=? AND binding_id=? AND allocation_id=? AND child_id=?`
          )
          .get(identity.networkId, identity.bindingId, identity.allocationId, identity.childId)
      ).toEqual(beforeIntent)
    }
  )

  it.each([
    ['owner', 'GOWNER-OTHER', 'CAGENT1'],
    ['agent', 'GOWNER1', 'CAGENT-OTHER'],
  ])('rejects phase-event SQL with a mismatched parent %s fact', async (_label, owner, agent) => {
    const input = batch({
      idempotencyKey: `event-parent-${_label}`,
      children: [child(1)],
      burnUnits7: '10000000',
    })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '0'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    expect(() =>
      db._raw
        .prepare(
          `INSERT INTO base_child_phase_events
             (event_id,network_id,binding_id,execution_id,allocation_id,child_id,
              owner_address,agent_address,recovery_version,phase,state,evidence_digest,
              evidence_json,observed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          _label.repeat(64).slice(0, 64),
          identity.networkId,
          identity.bindingId,
          identity.executionId,
          identity.allocationId,
          identity.childId,
          owner,
          agent,
          1,
          'cctp_burn',
          'submitting',
          'a'.repeat(64),
          '{}',
          2100
        )
    ).toThrow(/CAS conflict/i)
    expect(db._raw.prepare(`SELECT COUNT(*) count FROM base_child_phase_events`).get().count).toBe(
      0
    )
  })

  it('enforces explicit phase order and confirmed non-regression', async () => {
    const input = batch({
      idempotencyKey: 'phase-order-batch',
      children: [child(1)],
      burnUnits7: '10000000',
    })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '4'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    await expect(
      store.advanceBaseChildPhase({
        identity,
        expectedRecoveryVersion: 0,
        event: {
          eventId: '1'.repeat(64),
          phase: 'cctp_mint',
          state: 'submitted',
          evidence: {
            burnTxHash: 'a'.repeat(64),
            expectationDigest: 'b'.repeat(64),
            messageDigest: `0x${'c'.repeat(64)}`,
            attestationDigest: `0x${'d'.repeat(64)}`,
            nonce: `0x${'f'.repeat(64)}`,
            evidenceVersion: '1',
            mintTxHash: `0x${'e'.repeat(64)}`,
          },
          observedAt: 2200,
        },
      })
    ).rejects.toBeInstanceOf(AgentIndexConflictError)
    await store.advanceBaseChildPhase({
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: '2'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence('10000000'),
        observedAt: 2201,
      },
    })
    await expect(
      store.advanceBaseChildPhase({
        identity,
        expectedRecoveryVersion: 1,
        event: {
          eventId: '3'.repeat(64),
          phase: 'cctp_burn',
          state: 'unknown',
          evidence: {
            ...confirmedBurnEvidence('10000000'),
            reasonCode: 'observation_ambiguous',
          },
          observedAt: 2202,
        },
      })
    ).rejects.toBeInstanceOf(AgentIndexConflictError)
    expect((await store.readBaseChildRecoveryBundle(identity)).recoveryVersion).toBe(1)
  })

  it('allows a retryable attestation failure to confirm later without changing immutable facts', async () => {
    const input = batch({
      idempotencyKey: 'attestation-failed-retry-batch',
      children: [child(1)],
      burnUnits7: '10000000',
    })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '7'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    await store.advanceBaseChildPhase({
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: '8'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence('10000000'),
        observedAt: 2400,
      },
    })
    const attestationFacts = {
      burnTxHash: 'a'.repeat(64),
      expectationDigest: 'b'.repeat(64),
      messageDigest: `0x${'c'.repeat(64)}`,
      nonce: `0x${'d'.repeat(64)}`,
    }
    await store.advanceBaseChildPhase({
      identity,
      expectedRecoveryVersion: 1,
      event: {
        eventId: '9'.repeat(64),
        phase: 'cctp_attestation',
        state: 'failed',
        evidence: { ...attestationFacts, reasonCode: 'attestation_retryable' },
        observedAt: 2401,
      },
    })
    await expect(
      store.advanceBaseChildPhase({
        identity,
        expectedRecoveryVersion: 2,
        event: {
          eventId: 'a'.repeat(64),
          phase: 'cctp_attestation',
          state: 'confirmed',
          evidence: {
            ...attestationFacts,
            attestationDigest: `0x${'e'.repeat(64)}`,
            evidenceVersion: '3',
          },
          observedAt: 2402,
        },
      })
    ).resolves.toMatchObject({ recoveryVersion: 3, written: 1 })
  })

  it('rolls back the event and version when the projection write aborts', async () => {
    const input = batch({
      idempotencyKey: 'projection-failure-batch',
      children: [child(1)],
      burnUnits7: '10000000',
    })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '5'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    db._raw.exec(`
      CREATE TRIGGER task9_abort_projection
      BEFORE INSERT ON base_child_phase_projection
      BEGIN
        SELECT RAISE(ABORT, 'injected projection failure');
      END;
    `)
    await expect(
      store.advanceBaseChildPhase({
        identity,
        expectedRecoveryVersion: 0,
        event: {
          eventId: '6'.repeat(64),
          phase: 'cctp_burn',
          state: 'confirmed',
          evidence: confirmedBurnEvidence('10000000'),
          observedAt: 2300,
        },
      })
    ).rejects.toThrow(/store failed/i)
    expect(db._raw.prepare(`SELECT COUNT(*) count FROM base_child_phase_events`).get().count).toBe(
      0
    )
    expect(
      db._raw.prepare(`SELECT recovery_version FROM base_child_intents`).get().recovery_version
    ).toBe(0)
  })

  it('rejects non-allowlisted evidence before any phase SQL mutation', async () => {
    const input = batch({
      idempotencyKey: 'invalid-evidence-batch',
      children: [child(1)],
      burnUnits7: '10000000',
    })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '6'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    await expect(
      store.advanceBaseChildPhase({
        identity,
        expectedRecoveryVersion: 0,
        event: {
          eventId: '7'.repeat(64),
          phase: 'cctp_burn',
          state: 'unknown',
          evidence: { holder: 'other-worker', endpoint: 'https://rpc.invalid' },
          observedAt: 2300,
        },
      })
    ).rejects.toThrow(/evidence/i)
    expect(db._raw.prepare(`SELECT COUNT(*) count FROM base_child_phase_events`).get().count).toBe(
      0
    )
    expect(
      db._raw.prepare(`SELECT recovery_version FROM base_child_intents`).get().recovery_version
    ).toBe(0)
  })

  it('reads recovery evidence only by the exact five-part identity', async () => {
    const input = batch({ children: [child(1)], burnUnits7: '10000000' })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '1'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    await store.advanceBaseChildPhase({
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'a'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence('9007199254740993000000'),
        observedAt: 2100,
      },
    })
    await expect(store.readBaseChildRecoveryBundle(identity)).resolves.toMatchObject({
      schemaVersion: 1,
      identity,
      owner: 'GOWNER1',
      agent: 'CAGENT1',
      recoverable: true,
      recoveryVersion: 1,
      intent: child(1).intent,
      events: [
        {
          eventId: 'a'.repeat(64),
          evidence: confirmedBurnEvidence('9007199254740993000000'),
        },
      ],
    })
    const bundle = await store.readBaseChildRecoveryBundle(identity)
    expect(bundle.intent).not.toHaveProperty('version')
    expect(bundle.intent).not.toHaveProperty('owner')
    expect(bundle.intent).not.toHaveProperty('agent')
    for (const [field, value] of [
      ['networkId', 'other-network'],
      ['bindingId', 'other-binding'],
      ['executionId', 'run-batch-1:exec:allocation-2'],
      ['allocationId', 'allocation-2'],
      ['childId', 'job-2'],
    ]) {
      await expect(
        store.readBaseChildRecoveryBundle({ ...identity, [field]: value })
      ).resolves.toBeNull()
    }
  })

  it('feeds a real persisted D1 bundle into the Base selector without storage-only fields', async () => {
    const selectorIdentity = {
      networkId: NETWORK,
      bindingId: '0123456789abcdef0123456789abcdef',
      executionId: 'run-selector:exec:allocation-selector',
      allocationId: 'allocation-selector',
      childId: 'abcdef0123456789abcdef0123456789',
    }
    const selectorChild = child(1, {
      ...selectorIdentity,
      intent: {
        ...child(1).intent,
        runId: 'run-selector',
        grantTxHash: '6'.repeat(64),
        bindingHash: 'd'.repeat(64),
        baseJobId: selectorIdentity.childId,
        minShares: '900000',
      },
    })
    const input = batch({ children: [selectorChild], burnUnits7: '10000000' })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '1'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    const burnEvidence = {
      burnTxHash: 'a'.repeat(64),
      expectationDigest: 'b'.repeat(64),
      burnUnits7: '10000000',
      messageDigest: `0x${'c'.repeat(64)}`,
      nonce: `0x${'d'.repeat(64)}`,
    }
    await store.advanceBaseChildPhase({
      identity: selectorIdentity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'a'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: burnEvidence,
        observedAt: 2100,
      },
    })
    await store.advanceBaseChildPhase({
      identity: selectorIdentity,
      expectedRecoveryVersion: 1,
      event: {
        eventId: 'b'.repeat(64),
        phase: 'cctp_attestation',
        state: 'confirmed',
        evidence: {
          burnTxHash: burnEvidence.burnTxHash,
          expectationDigest: burnEvidence.expectationDigest,
          messageDigest: burnEvidence.messageDigest,
          nonce: burnEvidence.nonce,
          attestationDigest: `0x${'e'.repeat(64)}`,
          evidenceVersion: '1',
        },
        observedAt: 2200,
      },
    })
    const bundle = await store.readBaseChildRecoveryBundle(selectorIdentity)
    expect(bundle.events.every((entry) => !Object.hasOwn(entry, 'evidenceDigest'))).toBe(true)
    expect(bundle.phases.every((entry) => !Object.hasOwn(entry, 'evidenceDigest'))).toBe(true)
    expect(selectBaseChildRecoveryAction(bundle)).toEqual({
      action: 'submit-mint',
      phase: 'cctp_mint',
      reasonCode: 'base-attestation-confirmed',
    })
  })

  it('rejects persisted Base evidence whose JSON no longer matches its durable digest', async () => {
    const input = batch({ children: [child(1)], burnUnits7: '10000000' })
    await store.reserveBaseChildIntentBatch({
      batch: input,
      requestDigest: '1'.repeat(64),
      idempotencyKey: input.idempotencyKey,
    })
    await store.advanceBaseChildPhase({
      identity,
      expectedRecoveryVersion: 0,
      event: {
        eventId: 'a'.repeat(64),
        phase: 'cctp_burn',
        state: 'confirmed',
        evidence: confirmedBurnEvidence(),
        observedAt: 2100,
      },
    })
    db._raw.exec(`
      DROP TRIGGER base_child_phase_events_no_update;
      UPDATE base_child_phase_events SET evidence_json = '{"burnUnits7":"1"}';
      UPDATE base_child_phase_projection SET evidence_json = '{"burnUnits7":"1"}';
    `)
    await expect(store.readBaseChildRecoveryBundle(identity)).rejects.toThrow(/digest|evidence/i)
  })
})
