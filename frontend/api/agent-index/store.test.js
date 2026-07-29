import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createAgentIndexStore } from './store.js'
import { sourceIdFor } from './models.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
// Vite 5's SSR module graph doesn't recognize the newer `node:sqlite` builtin and tries to
// resolve it as a bare package specifier ("sqlite") instead — createRequire hands resolution to
// Node directly, bypassing Vite's transform for this one import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

// ponytail: a hand-rolled D1 double reimplementing SQL semantics in JS would drift from real D1
// behavior (CHECK constraints, transactions) the moment a constraint changes. Node's built-in
// node:sqlite (stdlib, no new dependency) runs the ACTUAL migration SQL and wraps it in the same
// prepare/bind/run/first/all + batch surface D1 exposes — store.js never knows the difference.
// Extends frontend/api/vf/_db.js's "in-memory double" idiom to the one thing that double doesn't
// need: db.batch() transactions (see task brief note on extending it minimally in the test file).
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
    _raw: sqlite, // test-only escape hatch to assert DB-level CHECK/NOT NULL constraints directly
  }
}

const NETWORK = 'stellar-testnet'
const CREATOR = 'CROUTER1'
const SOURCE_ID = sourceIdFor({ networkId: NETWORK, creatorAddress: CREATOR })

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
  store = createAgentIndexStore(db)
})

describe('createAgentIndexStore', () => {
  it('exposes exactly the documented repository API', () => {
    expect(Object.keys(store).sort()).toEqual(
      [
        'issueReceiptChallenge',
        'readReceiptChallenge',
        'readExecutionReceipt',
        'readOwnerExecutionReceipts',
        'commitAuthenticatedReceiptMutation',
        'acquireRecoveryLease',
        'releaseRecoveryLease',
        'probeReadiness',
        'createBaseChildIntent',
        'advanceBaseChildLifecycle',
        'readBaseChildIntent',
        'readOwnerBaseChildIntents',
        'upsertMembership',
        'upsertRunAllocation',
        'readRunAllocation',
        'readOwnerRunAllocations',
        'hasAssociationEvent',
        'commitAssociation',
        'readOwnerMemberships',
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

  it('probes the migrated store through a no-op write statement', async () => {
    await expect(store.probeReadiness()).resolves.toEqual({ writable: true })
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

describe('Base child intent and lifecycle durability', () => {
  const child = (overrides = {}) => ({
    version: 1,
    networkId: NETWORK,
    owner: 'GOWNER1',
    agent: 'CAGENT1',
    bindingId: 'binding-1',
    allocationId: 'run-1:bridge:aave-v3',
    childId: 'job-1',
    intent: { token: 'USDC', units: '1000000', decimals: 6, poolAddress: '0xpool' },
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
