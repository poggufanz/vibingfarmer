// D1 repository for the durable agent owner-membership + source-coverage index
// (migrations/0002_agent_index.sql). This is the ONLY module that issues SQL against the
// agent_index_sources / agent_index_gaps / agent_memberships / agent_run_allocations /
// agent_backfill_audits tables — Tasks 3-7 go through createAgentIndexStore(db), never raw SQL.
import {
  toMembershipRow,
  parseMembershipRow,
  toRunAllocationRow,
  toGapRow,
  parseGapRow,
  toBackfillAuditRow,
  parseBackfillAuditRow,
  parseSourceRow,
  nowSeconds,
} from './models.js'
import {
  AGENT_CREATOR_MANIFEST_HASH,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_SCHEMA_VERSION,
} from '../../src/stellar/agentCreatorManifest.js'

function parseSourceId(sourceId) {
  if (typeof sourceId !== 'string' || !sourceId) throw new Error('sourceId must be a non-empty string')
  const idx = sourceId.indexOf(':')
  if (idx < 0) throw new Error(`sourceId must be "networkId:creatorAddress", got ${sourceId}`)
  return { networkId: sourceId.slice(0, idx), creatorAddress: sourceId.slice(idx + 1) }
}

const MEMBERSHIP_UPSERT_SQL = `
  INSERT INTO agent_memberships
    (network_id, agent_address, owner_address, creator_address, schema_version,
     agent_kind, creation_ledger, creation_tx, grant_tx_hash, run_id, run_ordinal, provenance)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(network_id, agent_address) DO UPDATE SET
    owner_address = excluded.owner_address,
    creator_address = excluded.creator_address,
    schema_version = excluded.schema_version,
    agent_kind = excluded.agent_kind,
    creation_ledger = excluded.creation_ledger,
    creation_tx = excluded.creation_tx,
    grant_tx_hash = excluded.grant_tx_hash,
    run_id = excluded.run_id,
    run_ordinal = excluded.run_ordinal,
    provenance = excluded.provenance
`

/** D1 repository. `db` is a Cloudflare D1 binding (prepare/bind/run/first/all + batch) — or, in
 * tests, an in-memory double with the same surface (see store.test.js). */
export function createAgentIndexStore(db) {
  function bindMembershipRow(row) {
    return db
      .prepare(MEMBERSHIP_UPSERT_SQL)
      .bind(
        row.network_id,
        row.agent_address,
        row.owner_address,
        row.creator_address,
        row.schema_version,
        row.agent_kind,
        row.creation_ledger,
        row.creation_tx,
        row.grant_tx_hash,
        row.run_id,
        row.run_ordinal,
        row.provenance
      )
  }

  async function upsertMembership(record) {
    const row = toMembershipRow(record)
    await bindMembershipRow(row).run()
  }

  async function upsertRunAllocation(record) {
    const row = toRunAllocationRow(record)
    const now = nowSeconds()
    await db
      .prepare(
        `INSERT INTO agent_run_allocations
           (id, network_id, run_id, owner_address, bridge_agent_address, base_child_address,
            token, units, decimals, proxy_target, job_id, tx_id, execution_status,
            custody_location, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           run_id = excluded.run_id,
           owner_address = excluded.owner_address,
           bridge_agent_address = excluded.bridge_agent_address,
           base_child_address = excluded.base_child_address,
           token = excluded.token,
           units = excluded.units,
           decimals = excluded.decimals,
           proxy_target = excluded.proxy_target,
           job_id = excluded.job_id,
           tx_id = excluded.tx_id,
           execution_status = excluded.execution_status,
           custody_location = excluded.custody_location,
           updated_at = excluded.updated_at`
      )
      .bind(
        row.id,
        row.network_id,
        row.run_id,
        row.owner_address,
        row.bridge_agent_address,
        row.base_child_address,
        row.token,
        row.units,
        row.decimals,
        row.proxy_target,
        row.job_id,
        row.tx_id,
        row.execution_status,
        row.custody_location,
        now,
        now
      )
      .run()
  }

  async function readOwnerMemberships({ networkId, owner }) {
    if (!networkId || !owner) throw new Error('readOwnerMemberships requires networkId and owner')
    const { results } = await db
      .prepare(
        `SELECT * FROM agent_memberships WHERE network_id = ? AND owner_address = ?
         ORDER BY creation_ledger ASC, agent_address ASC`
      )
      .bind(networkId, owner)
      .all()
    return (results ?? []).map(parseMembershipRow)
  }

  async function readCoverage({ networkId }) {
    if (!networkId) throw new Error('readCoverage requires networkId')
    const [sourcesRes, gapsRes, auditsRes] = await Promise.all([
      db.prepare(`SELECT * FROM agent_index_sources WHERE network_id = ? ORDER BY source_id ASC`).bind(networkId).all(),
      db
        .prepare(
          `SELECT * FROM agent_index_gaps WHERE network_id = ? AND status = 'open'
           ORDER BY source_id ASC, from_ledger ASC`
        )
        .bind(networkId)
        .all(),
      db.prepare(`SELECT * FROM agent_backfill_audits WHERE network_id = ? ORDER BY attempted_at DESC`).bind(networkId).all(),
    ])
    return {
      sources: (sourcesRes.results ?? []).map(parseSourceRow),
      gaps: (gapsRes.results ?? []).map(parseGapRow),
      backfillAudits: (auditsRes.results ?? []).map(parseBackfillAuditRow),
    }
  }

  /** One D1 batch/transaction: membership writes + the contiguous cursor advance for `sourceId`
   * either all commit or none commit. `fromLedger` must equal the source's current
   * indexed_through_ledger + 1 (or be the source's very first page) — commitSourcePage never
   * silently advances past unindexed history; contiguity is judged only against
   * indexed_through_ledger, never against agent_index_gaps.
   * To skip over ledgers that are genuinely unavailable (e.g. an RPC hole), a caller must do BOTH:
   * (1) `recordGap` for that range — this only records the hole, it does NOT move the cursor —
   * and (2) `commitSourcePage` a page spanning the same range with `memberships: []` — this is
   * what actually advances indexed_through_ledger past the hole. The gap row stays on record
   * (readCoverage still reports it as open) even after the cursor has moved past it.
   * ponytail: the contiguity check reads current state, then writes, as two steps — safe for the
   * single-writer-per-source usage this app has (one keeper cron per source); a second concurrent
   * writer for the SAME source could race past this check. Upgrade to a WHERE-guarded conditional
   * UPDATE inside the same batch if a second writer per source is ever introduced. */
  async function commitSourcePage({ sourceId, fromLedger, throughLedger, finalizedThroughLedger, cursor, memberships }) {
    const { networkId, creatorAddress } = parseSourceId(sourceId)
    if (!Number.isInteger(fromLedger)) throw new Error('commitSourcePage requires an integer fromLedger')
    if (!Number.isInteger(throughLedger) || throughLedger < fromLedger)
      throw new Error('commitSourcePage requires throughLedger >= fromLedger')
    if (!Number.isInteger(finalizedThroughLedger) || finalizedThroughLedger > throughLedger)
      throw new Error('commitSourcePage requires finalizedThroughLedger <= throughLedger')
    if (cursor !== null && cursor !== undefined && typeof cursor !== 'string')
      throw new Error('commitSourcePage requires cursor to be a string or null')

    const rows = (memberships ?? []).map(toMembershipRow)
    for (const row of rows) {
      if (row.network_id !== networkId)
        throw new Error(`commitSourcePage: membership networkId "${row.network_id}" does not match source "${sourceId}"`)
      if (row.creator_address !== creatorAddress)
        throw new Error(`commitSourcePage: membership creatorAddress "${row.creator_address}" does not match source "${sourceId}"`)
    }

    const existing = await db.prepare(`SELECT * FROM agent_index_sources WHERE source_id = ?`).bind(sourceId).first()
    const expectedFrom = existing ? existing.indexed_through_ledger + 1 : fromLedger
    if (fromLedger !== expectedFrom) {
      throw new Error(
        `commitSourcePage: non-contiguous page for ${sourceId} — expected fromLedger ${expectedFrom}, got ${fromLedger}. ` +
          `If ledgers ${expectedFrom}..${fromLedger - 1} are genuinely unavailable: recordGap for that range AND ` +
          `commitSourcePage a page spanning it (memberships: [] is fine) to actually advance past it — ` +
          `recordGap alone does not move indexed_through_ledger.`
      )
    }
    const indexedFromLedger = existing ? existing.indexed_from_ledger : fromLedger
    const now = nowSeconds()

    const sourceStatement = db
      .prepare(
        `INSERT INTO agent_index_sources
           (source_id, network_id, creator_address, manifest_hash, manifest_version, schema_version,
            indexed_from_ledger, indexed_through_ledger, finalized_through_ledger, cursor,
            status, last_success_at, last_error_at, last_error_message)
         VALUES (?,?,?,?,?,?,?,?,?,?,'ok',?,NULL,NULL)
         ON CONFLICT(source_id) DO UPDATE SET
           manifest_hash = excluded.manifest_hash,
           manifest_version = excluded.manifest_version,
           schema_version = excluded.schema_version,
           indexed_through_ledger = excluded.indexed_through_ledger,
           finalized_through_ledger = excluded.finalized_through_ledger,
           cursor = excluded.cursor,
           status = excluded.status,
           last_success_at = excluded.last_success_at`
      )
      .bind(
        sourceId,
        networkId,
        creatorAddress,
        AGENT_CREATOR_MANIFEST_HASH,
        AGENT_CREATOR_MANIFEST_VERSION,
        AGENT_INDEX_SCHEMA_VERSION,
        indexedFromLedger,
        throughLedger,
        finalizedThroughLedger,
        cursor ?? null,
        now
      )

    // Memberships first, source cursor-advance last: if the source row's own CHECK constraints
    // reject the page (e.g. finalized_through_ledger's lower bound, which depends on state read
    // above and so isn't pre-validated in JS), the memberships that already "succeeded" earlier
    // in this same transaction are rolled back too — genuine all-or-nothing, not just early exit.
    await db.batch([...rows.map((row) => bindMembershipRow(row)), sourceStatement])
  }

  async function recordGap(gap) {
    const row = toGapRow(gap)
    const now = nowSeconds()
    await db
      .prepare(
        `INSERT INTO agent_index_gaps
           (source_id, network_id, from_ledger, through_ledger, reason, status, opened_at, closed_at)
         VALUES (?,?,?,?,?, 'open', ?, NULL)`
      )
      .bind(row.source_id, row.network_id, row.from_ledger, row.through_ledger, row.reason, now)
      .run()
  }

  async function recordBackfillAudit(audit) {
    const row = toBackfillAuditRow(audit)
    const now = nowSeconds()
    await db
      .prepare(
        `INSERT INTO agent_backfill_audits
           (network_id, source_id, attempted_at, method, result, from_ledger, through_ledger, evidence, notes)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .bind(row.network_id, row.source_id, now, row.method, row.result, row.from_ledger, row.through_ledger, row.evidence, row.notes)
      .run()
  }

  return {
    upsertMembership,
    upsertRunAllocation,
    readOwnerMemberships,
    readCoverage,
    commitSourcePage,
    recordGap,
    recordBackfillAudit,
  }
}
