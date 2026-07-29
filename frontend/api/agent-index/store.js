// D1 repository for the durable agent owner-membership + source-coverage index
// (migrations/0002_agent_index.sql). This is the ONLY module that issues SQL against the
// agent_index_sources / agent_index_gaps / agent_memberships / agent_run_allocations /
// agent_backfill_audits tables — Tasks 3-7 go through createAgentIndexStore(db), never raw SQL.
import {
  toMembershipRow,
  parseMembershipRow,
  toRunAllocationRow,
  toAssociationRow,
  parseAssociationRow,
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
  if (typeof sourceId !== 'string' || !sourceId)
    throw new Error('sourceId must be a non-empty string')
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

function sameAssociationEvidence(existing, association) {
  if (!existing) return false
  return (
    existing.allocationId === association.allocationId &&
    existing.networkId === association.networkId &&
    existing.runId === association.runId &&
    existing.ownerAddress === association.ownerAddress &&
    existing.bridgeAgentAddress === association.bridgeAgentAddress &&
    existing.poolAddress?.toLowerCase() === association.poolAddress?.toLowerCase() &&
    existing.amount?.token === association.amount?.token &&
    existing.amount?.units === association.amount?.units &&
    existing.amount?.decimals === association.amount?.decimals &&
    existing.proxyTarget === association.proxyTarget &&
    existing.baseJobId === association.baseJobId &&
    existing.txHash === association.txHash &&
    existing.executionStatus === association.executionStatus &&
    existing.custodyLocation === association.custodyLocation &&
    existing.grantTxHash === association.grantTxHash &&
    existing.kernelAddress?.toLowerCase() === association.kernelAddress?.toLowerCase() &&
    existing.mandateBindingId === association.mandateBindingId &&
    existing.mandateBindingHash === association.mandateBindingHash &&
    existing.associationSource === association.associationSource
  )
}

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

  async function readRunAllocation({ networkId, allocationId }) {
    if (!networkId || !allocationId)
      throw new Error('readRunAllocation requires networkId and allocationId')
    const row = await db
      .prepare(`SELECT * FROM agent_run_allocations WHERE network_id = ? AND id = ?`)
      .bind(networkId, allocationId)
      .first()
    return parseAssociationRow(row)
  }

  async function readOwnerRunAllocations({ networkId, owner }) {
    if (!networkId || !owner)
      throw new Error('readOwnerRunAllocations requires networkId and owner')
    const { results } = await db
      .prepare(
        `SELECT * FROM agent_run_allocations
         WHERE network_id = ? AND owner_address = ?
         ORDER BY created_at ASC, id ASC`
      )
      .bind(networkId, owner)
      .all()
    return (results ?? []).map(parseAssociationRow)
  }

  async function hasAssociationEvent({ idempotencyKey }) {
    if (!idempotencyKey) throw new Error('hasAssociationEvent requires idempotencyKey')
    const row = await db
      .prepare(`SELECT idempotency_key FROM agent_association_events WHERE idempotency_key = ?`)
      .bind(idempotencyKey)
      .first()
    return !!row
  }

  async function commitAssociation({ association, idempotencyKey }) {
    if (!idempotencyKey) throw new Error('commitAssociation requires idempotencyKey')
    const row = toAssociationRow(association)
    const now = nowSeconds()
    const associationStatement = db
      .prepare(
        `INSERT INTO agent_run_allocations
           (id, network_id, run_id, owner_address, bridge_agent_address, base_child_address,
            token, units, decimals, proxy_target, job_id, tx_id, execution_status,
            custody_location, created_at, updated_at, grant_tx_hash, kernel_address,
            mandate_binding_id, mandate_binding_hash, association_source, reported_at,
            scope_checked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           token = excluded.token,
           units = excluded.units,
           decimals = excluded.decimals,
           base_child_address = excluded.base_child_address,
           proxy_target = excluded.proxy_target,
           job_id = excluded.job_id,
           tx_id = excluded.tx_id,
           execution_status = excluded.execution_status,
           custody_location = excluded.custody_location,
           updated_at = excluded.updated_at,
           grant_tx_hash = excluded.grant_tx_hash,
           kernel_address = excluded.kernel_address,
           mandate_binding_id = excluded.mandate_binding_id,
           mandate_binding_hash = excluded.mandate_binding_hash,
           association_source = excluded.association_source,
           reported_at = excluded.reported_at,
           scope_checked_at = excluded.scope_checked_at
         WHERE agent_run_allocations.network_id = excluded.network_id
           AND agent_run_allocations.run_id = excluded.run_id
           AND agent_run_allocations.owner_address = excluded.owner_address
           AND agent_run_allocations.bridge_agent_address = excluded.bridge_agent_address
           AND (
             agent_run_allocations.association_source IS NULL
             OR (
               lower(agent_run_allocations.base_child_address) = lower(excluded.base_child_address)
               AND lower(agent_run_allocations.kernel_address) = lower(excluded.kernel_address)
               AND agent_run_allocations.mandate_binding_id = excluded.mandate_binding_id
               AND agent_run_allocations.mandate_binding_hash = excluded.mandate_binding_hash
               AND agent_run_allocations.token = excluded.token
               AND agent_run_allocations.units = excluded.units
               AND agent_run_allocations.decimals = excluded.decimals
               AND agent_run_allocations.proxy_target = excluded.proxy_target
               AND agent_run_allocations.job_id = excluded.job_id
               AND agent_run_allocations.grant_tx_hash = excluded.grant_tx_hash
               AND (
                 agent_run_allocations.execution_status NOT IN ('deposited', 'held', 'failed')
                 OR agent_run_allocations.execution_status = excluded.execution_status
               )
               AND CASE excluded.execution_status
                 WHEN 'queued' THEN 0
                 WHEN 'accepted' THEN 1
                 WHEN 'burn-confirmed' THEN 2
                 WHEN 'minted' THEN 3
                 WHEN 'deposited' THEN 4
                 WHEN 'held' THEN 5
                 WHEN 'failed' THEN 6
               END >= CASE agent_run_allocations.execution_status
                 WHEN 'queued' THEN 0
                 WHEN 'accepted' THEN 1
                 WHEN 'burn-confirmed' THEN 2
                 WHEN 'minted' THEN 3
                 WHEN 'deposited' THEN 4
                 WHEN 'held' THEN 5
                 WHEN 'failed' THEN 6
               END
               AND (
                 agent_run_allocations.tx_id IS NULL
                 OR agent_run_allocations.tx_id = excluded.tx_id
                 OR (
                   excluded.tx_id IS NOT NULL
                   AND CASE excluded.execution_status
                     WHEN 'queued' THEN 0
                     WHEN 'accepted' THEN 1
                     WHEN 'burn-confirmed' THEN 2
                     WHEN 'minted' THEN 3
                     WHEN 'deposited' THEN 4
                     WHEN 'held' THEN 5
                     WHEN 'failed' THEN 6
                   END > CASE agent_run_allocations.execution_status
                     WHEN 'queued' THEN 0
                     WHEN 'accepted' THEN 1
                     WHEN 'burn-confirmed' THEN 2
                     WHEN 'minted' THEN 3
                     WHEN 'deposited' THEN 4
                     WHEN 'held' THEN 5
                     WHEN 'failed' THEN 6
                   END
                 )
               )
               AND (
                 agent_run_allocations.execution_status NOT IN ('deposited', 'held', 'failed')
                 OR agent_run_allocations.custody_location = 'unknown'
                 OR excluded.custody_location <> 'unknown'
               )
             )
           )`
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
        now,
        row.grant_tx_hash,
        row.kernel_address,
        row.mandate_binding_id,
        row.mandate_binding_hash,
        row.association_source,
        row.reported_at,
        row.scope_checked_at
      )
    const eventStatement = db
      .prepare(
        `INSERT INTO agent_association_events
           (idempotency_key, network_id, run_id, allocation_id, execution_status, tx_hash, reported_at)
         SELECT ?,
           CASE WHEN EXISTS (
             SELECT 1
             FROM agent_run_allocations
             WHERE id = ?
               AND network_id = ?
               AND run_id = ?
               AND owner_address = ?
               AND bridge_agent_address = ?
               AND lower(base_child_address) = lower(?)
               AND token = ?
               AND units = ?
               AND decimals = ?
               AND proxy_target = ?
               AND job_id = ?
               AND tx_id IS ?
               AND execution_status = ?
               AND custody_location = ?
               AND grant_tx_hash = ?
               AND lower(kernel_address) = lower(?)
               AND mandate_binding_id = ?
               AND mandate_binding_hash = ?
               AND association_source = ?
               AND reported_at = ?
               AND scope_checked_at = ?
           ) THEN ? ELSE NULL END,
           ?, ?, ?, ?, ?`
      )
      .bind(
        idempotencyKey,
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
        row.grant_tx_hash,
        row.kernel_address,
        row.mandate_binding_id,
        row.mandate_binding_hash,
        row.association_source,
        row.reported_at,
        row.scope_checked_at,
        row.network_id,
        row.run_id,
        row.id,
        row.execution_status,
        row.tx_id,
        row.reported_at
      )
    try {
      const results = await db.batch([associationStatement, eventStatement])
      const associationChanges = Number(results?.[0]?.meta?.changes ?? 0)
      const eventChanges = Number(results?.[1]?.meta?.changes ?? 0)
      if (associationChanges !== 1 || eventChanges !== 1) {
        throw new Error('association conflict rejected before durable journaling')
      }
      return { written: 1, duplicates: 0 }
    } catch (error) {
      const [eventExists, existing] = await Promise.all([
        hasAssociationEvent({ idempotencyKey }),
        readRunAllocation({ networkId: row.network_id, allocationId: row.id }),
      ])
      if (eventExists && sameAssociationEvidence(existing, association)) {
        return { written: 0, duplicates: 1 }
      }
      throw new Error('association conflict rejected before durable journaling', { cause: error })
    }
  }

  async function readMembershipsByAgentAddresses({ networkId, agentAddresses }) {
    if (!networkId) throw new Error('readMembershipsByAgentAddresses requires networkId')
    if (!Array.isArray(agentAddresses) || agentAddresses.length === 0) return []
    const placeholders = agentAddresses.map(() => '?').join(',')
    const { results } = await db
      .prepare(
        `SELECT * FROM agent_memberships WHERE network_id = ? AND agent_address IN (${placeholders})`
      )
      .bind(networkId, ...agentAddresses)
      .all()
    return (results ?? []).map(parseMembershipRow)
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
      db
        .prepare(`SELECT * FROM agent_index_sources WHERE network_id = ? ORDER BY source_id ASC`)
        .bind(networkId)
        .all(),
      db
        .prepare(
          `SELECT * FROM agent_index_gaps WHERE network_id = ? AND status = 'open'
           ORDER BY source_id ASC, from_ledger ASC`
        )
        .bind(networkId)
        .all(),
      db
        .prepare(
          `SELECT * FROM agent_backfill_audits WHERE network_id = ? ORDER BY attempted_at DESC`
        )
        .bind(networkId)
        .all(),
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
  /** Idempotent no-op if the source row already exists. Inserts the "nothing indexed yet"
   * sentinel row (indexed_through_ledger = indexed_from_ledger - 1, see the migration's own
   * comment) so `agent_index_gaps`' FK against `agent_index_sources` can be satisfied by
   * `recordGap` even on a source's very first-ever page — WITHOUT ever needing to commit
   * substantive page contents (or an empty spanning page) before the gap row exists. This is what
   * lets a caller always run `recordGap` before the corresponding `commitSourcePage`, uniformly,
   * regardless of whether the source has ever been seen before (store.js issue tracked as
   * "gap-branch atomicity ordering" — a crash between the two now always leaves a recorded gap
   * behind a cursor that hasn't moved past it, never the reverse). */
  async function ensureSourceRow({
    sourceId,
    networkId,
    creatorAddress,
    fromLedger,
    providerId = null,
    endpointClass = null,
    reportedOldestLedger = null,
    reportedLatestLedger = null,
  }) {
    if (!Number.isInteger(fromLedger))
      throw new Error('ensureSourceRow requires an integer fromLedger')
    await db
      .prepare(
        `INSERT INTO agent_index_sources
           (source_id, network_id, creator_address, manifest_hash, manifest_version, schema_version,
            indexed_from_ledger, indexed_through_ledger, finalized_through_ledger, cursor,
            provider_id, endpoint_class, reported_oldest_ledger, reported_latest_ledger,
            status, last_success_at, last_error_at, last_error_message)
         VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?, 'ok', NULL, NULL, NULL)
         ON CONFLICT(source_id) DO NOTHING`
      )
      .bind(
        sourceId,
        networkId,
        creatorAddress,
        AGENT_CREATOR_MANIFEST_HASH,
        AGENT_CREATOR_MANIFEST_VERSION,
        AGENT_INDEX_SCHEMA_VERSION,
        fromLedger,
        fromLedger - 1,
        fromLedger - 1,
        providerId,
        endpointClass,
        reportedOldestLedger,
        reportedLatestLedger
      )
      .run()
  }

  /** Fail-closed decode-error path: marks the source `status = 'error'` with a `last_error_*`
   * trail WITHOUT touching `indexed_through_ledger` or `cursor` — the caller never advances past
   * a page it could not fully decode, so the next tick retries the exact same range. Reuses
   * `ensureSourceRow` for the FK-safety a source's very first page needs (same reasoning as the
   * gap path above). */
  async function recordSourceError({ sourceId, networkId, creatorAddress, fromLedger, message }) {
    await ensureSourceRow({ sourceId, networkId, creatorAddress, fromLedger })
    const now = nowSeconds()
    await db
      .prepare(
        `UPDATE agent_index_sources SET status = 'error', last_error_at = ?, last_error_message = ? WHERE source_id = ?`
      )
      .bind(now, String(message ?? ''), sourceId)
      .run()
  }

  async function commitSourcePage({
    sourceId,
    fromLedger,
    throughLedger,
    finalizedThroughLedger,
    cursor,
    memberships,
    providerId = null,
    endpointClass = null,
    reportedOldestLedger = null,
    reportedLatestLedger = null,
  }) {
    const { networkId, creatorAddress } = parseSourceId(sourceId)
    if (!Number.isInteger(fromLedger))
      throw new Error('commitSourcePage requires an integer fromLedger')
    if (!Number.isInteger(throughLedger) || throughLedger < fromLedger)
      throw new Error('commitSourcePage requires throughLedger >= fromLedger')
    if (!Number.isInteger(finalizedThroughLedger) || finalizedThroughLedger > throughLedger)
      throw new Error('commitSourcePage requires finalizedThroughLedger <= throughLedger')
    if (cursor !== null && cursor !== undefined && typeof cursor !== 'string')
      throw new Error('commitSourcePage requires cursor to be a string or null')

    const rows = (memberships ?? []).map(toMembershipRow)
    for (const row of rows) {
      if (row.network_id !== networkId)
        throw new Error(
          `commitSourcePage: membership networkId "${row.network_id}" does not match source "${sourceId}"`
        )
      if (row.creator_address !== creatorAddress)
        throw new Error(
          `commitSourcePage: membership creatorAddress "${row.creator_address}" does not match source "${sourceId}"`
        )
    }

    const existing = await db
      .prepare(`SELECT * FROM agent_index_sources WHERE source_id = ?`)
      .bind(sourceId)
      .first()
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
            provider_id, endpoint_class, reported_oldest_ledger, reported_latest_ledger,
            status, last_success_at, last_error_at, last_error_message)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ok',?,NULL,NULL)
         ON CONFLICT(source_id) DO UPDATE SET
           manifest_hash = excluded.manifest_hash,
           manifest_version = excluded.manifest_version,
           schema_version = excluded.schema_version,
           indexed_through_ledger = excluded.indexed_through_ledger,
           finalized_through_ledger = excluded.finalized_through_ledger,
           cursor = excluded.cursor,
           provider_id = excluded.provider_id,
           endpoint_class = excluded.endpoint_class,
           reported_oldest_ledger = excluded.reported_oldest_ledger,
           reported_latest_ledger = excluded.reported_latest_ledger,
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
        providerId,
        endpointClass,
        reportedOldestLedger,
        reportedLatestLedger,
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
      .bind(
        row.network_id,
        row.source_id,
        now,
        row.method,
        row.result,
        row.from_ledger,
        row.through_ledger,
        row.evidence,
        row.notes
      )
      .run()
  }

  return {
    upsertMembership,
    upsertRunAllocation,
    readRunAllocation,
    readOwnerRunAllocations,
    hasAssociationEvent,
    commitAssociation,
    readOwnerMemberships,
    readMembershipsByAgentAddresses,
    readCoverage,
    ensureSourceRow,
    commitSourcePage,
    recordGap,
    recordSourceError,
    recordBackfillAudit,
  }
}
