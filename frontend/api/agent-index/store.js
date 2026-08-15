// D1 repository for the durable agent owner-membership + source-coverage index
// (migrations/0002_agent_index.sql). This is the ONLY module that issues SQL against the
// agent_index_sources / agent_index_gaps / agent_memberships / agent_run_allocations /
// agent_backfill_audits tables — Tasks 3-7 go through createAgentIndexStore(db), never raw SQL.
import { createHash } from 'node:crypto'
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
  toExecutionReceiptRow,
  toPhaseAttemptRow,
  parseExecutionReceiptRow,
  parsePhaseAttemptRow,
  toBaseChildRow,
  parseBaseChildRow,
  baseChildBatchDigest,
  baseChildEvidenceDigest,
  baseChildEvidenceReportDigest,
  baseChildRecoveryIdentity,
  toBaseChildPhaseEventRow,
  parseBaseChildPhaseEventRow,
  parseBaseChildPhaseProjectionRow,
  canonicalJson,
  AgentIndexConflictError,
  AgentIndexStoreError,
  AgentIndexValidationError,
  BASE_CHILD_LIFECYCLE_STATUSES,
  RECEIPT_PHASES,
  BASE_CHILD_RECOVERY_PHASES,
  BASE_RECOVERY_ACTIONS,
  BASE_RECOVERY_PHASES,
  nowSeconds,
} from './models.js'
import {
  AGENT_CREATOR_MANIFEST_HASH,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_SCHEMA_VERSION,
} from '../../src/stellar/agentCreatorManifest.js'

export const D1_TOTAL_BIND_PARAMETER_LIMIT = 100
// Network-scoped address queries reserve one D1 bind for networkId.
export const D1_NETWORK_SCOPED_ADDRESS_CHUNK_SIZE = D1_TOTAL_BIND_PARAMETER_LIMIT - 1
export const MAX_BASE_CHILD_BATCH_SIZE = 16

function baseRecoveryLeaseTokenDigest(token) {
  return createHash('sha256').update(token).digest('hex')
}

function selectorPhaseEntry(row, parse) {
  let parsed
  try {
    parsed = parse(row)
    if (baseChildEvidenceDigest(parsed.evidence) !== parsed.evidenceDigest) {
      throw new Error('persisted evidence digest mismatch')
    }
  } catch (error) {
    throw new AgentIndexStoreError('Base child recovery evidence integrity check failed', {
      cause: error,
    })
  }
  const { evidenceDigest: _storageDigest, ...entry } = parsed
  return entry
}

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
export function createAgentIndexStore(db, { enableLegacyBaseChildWrites = false } = {}) {
  async function probeReadiness() {
    await db.prepare('UPDATE agent_index_sources SET status = status WHERE 0').bind().run()
    await db
      .prepare(
        `UPDATE execution_receipts
         SET intent_json = intent_json,
             cctp_burn_status = cctp_burn_status,
             cctp_mint_status = cctp_mint_status,
             base_deposit_status = base_deposit_status,
             custody_location = custody_location,
             last_mutation_token = last_mutation_token,
             version = version,
             updated_at = updated_at
         WHERE 0`
      )
      .bind()
      .run()
    await db
      .prepare(
        `SELECT attempt_id, network_id, execution_id, allocation_id, attempt_kind,
                phase, status, evidence_json, request_digest, receipt_version
         FROM execution_phase_attempts WHERE 0`
      )
      .bind()
      .all()
    await db
      .prepare(
        `SELECT idempotency_key, request_digest, burn_units_7, child_count
         FROM base_child_intent_batches WHERE 0`
      )
      .bind()
      .all()
    await db
      .prepare(
        `SELECT idempotency_key, ordinal, network_id, binding_id, execution_id,
                allocation_id, child_id, intent_digest
         FROM base_child_intent_batch_items WHERE 0`
      )
      .bind()
      .all()
    await db
      .prepare(
        `SELECT event_id, network_id, binding_id, execution_id, allocation_id, child_id,
                recovery_version, phase, state, evidence_json
         FROM base_child_phase_events WHERE 0`
      )
      .bind()
      .all()
    await db
      .prepare(
        `SELECT network_id, binding_id, execution_id, allocation_id, child_id, phase,
                owner_address, action, evidence_version, lease_token, acquired_at, expires_at
         FROM base_child_recovery_leases WHERE 0`
      )
      .bind()
      .all()
    await db
      .prepare(
        `SELECT network_id, binding_id, execution_id, allocation_id, child_id, phase,
                latest_event_id, recovery_version, state, evidence_json
         FROM base_child_phase_projection WHERE 0`
      )
      .bind()
      .all()
    await db
      .prepare(
        `SELECT challenge_id, network_id, owner_address, agent_address, request_digest,
                expires_at, consumed_at, consume_token
         FROM execution_receipt_challenges WHERE 0`
      )
      .bind()
      .all()
    await db
      .prepare(
        `SELECT network_id, execution_id, allocation_id, child_id, phase, owner_address,
                holder, lease_token, acquired_at, expires_at
         FROM execution_recovery_leases WHERE 0`
      )
      .bind()
      .all()
    await db
      .prepare(
        `UPDATE base_child_intents
         SET intent_json = intent_json,
             lifecycle_sequence = lifecycle_sequence,
             lifecycle_status = lifecycle_status,
             lifecycle_evidence_json = lifecycle_evidence_json,
             updated_at = updated_at
         WHERE 0`
      )
      .bind()
      .run()
    await db
      .prepare(
        `SELECT network_id, binding_id, allocation_id, child_id, sequence,
                idempotency_key, status, evidence_json, observed_at
         FROM base_child_lifecycle_events WHERE 0`
      )
      .bind()
      .all()
    return {
      writable: true,
      schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
      stores: { executionReceipts: true, baseChildIntents: true, baseRecoveryEvidence: true },
    }
  }

  async function issueReceiptChallenge(challenge) {
    await db
      .prepare(
        `INSERT INTO execution_receipt_challenges
           (challenge_id, network_id, owner_address, agent_address, request_digest,
            expires_at, created_at, consumed_at, consume_token)
         VALUES (?,?,?,?,?,?,?,NULL,NULL)`
      )
      .bind(
        challenge.challengeId,
        challenge.networkId,
        challenge.owner,
        challenge.agent,
        challenge.requestDigest,
        challenge.expiresAt,
        challenge.createdAt
      )
      .run()
  }

  async function readReceiptChallenge({ challengeId }) {
    if (!challengeId) return null
    const row = await db
      .prepare(`SELECT * FROM execution_receipt_challenges WHERE challenge_id = ?`)
      .bind(challengeId)
      .first()
    if (!row) return null
    return {
      challengeId: row.challenge_id,
      networkId: row.network_id,
      owner: row.owner_address,
      agent: row.agent_address,
      requestDigest: row.request_digest,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      consumedAt: row.consumed_at,
    }
  }

  async function consumeReceiptChallenge({ challenge, consumeToken, now }) {
    if (!challenge?.challengeId || !consumeToken || !Number.isInteger(now)) {
      throw new Error('receipt challenge, consume token, and time are required')
    }
    const result = await db
      .prepare(
        `UPDATE execution_receipt_challenges
         SET consumed_at = ?, consume_token = ?
         WHERE challenge_id = ? AND network_id = ? AND owner_address = ? AND agent_address = ?
           AND request_digest = ? AND expires_at = ? AND expires_at > ?
           AND consumed_at IS NULL AND consume_token IS NULL`
      )
      .bind(
        now,
        consumeToken,
        challenge.challengeId,
        challenge.networkId,
        challenge.owner,
        challenge.agent,
        challenge.requestDigest,
        challenge.expiresAt,
        now
      )
      .run()
    return Number(result?.meta?.changes ?? 0) === 1
  }

  async function readExecutionReceipt({ networkId, executionId, allocationId, owner }) {
    if (!networkId || !executionId || !allocationId || !owner) {
      throw new Error('readExecutionReceipt requires networkId, executionId, allocationId, owner')
    }
    const row = await db
      .prepare(
        `SELECT * FROM execution_receipts
         WHERE network_id = ? AND execution_id = ? AND allocation_id = ? AND owner_address = ?`
      )
      .bind(networkId, executionId, allocationId, owner)
      .first()
    if (!row) return null
    const { results } = await db
      .prepare(
        `SELECT * FROM execution_phase_attempts
         WHERE network_id = ? AND execution_id = ? AND allocation_id = ? AND owner_address = ?
         ORDER BY receipt_version ASC, observed_at ASC, attempt_id ASC`
      )
      .bind(networkId, executionId, allocationId, owner)
      .all()
    return parseExecutionReceiptRow(row, (results ?? []).map(parsePhaseAttemptRow))
  }

  async function readOwnerExecutionReceipts({ networkId, owner }) {
    if (!networkId || !owner) {
      throw new Error('readOwnerExecutionReceipts requires networkId and owner')
    }
    const { results } = await db
      .prepare(
        `SELECT * FROM execution_receipts
         WHERE network_id = ? AND owner_address = ?
         ORDER BY updated_at DESC, execution_id ASC, allocation_id ASC`
      )
      .bind(networkId, owner)
      .all()
    return Promise.all(
      (results ?? []).map((row) =>
        readExecutionReceipt({
          networkId: row.network_id,
          executionId: row.execution_id,
          allocationId: row.allocation_id,
          owner: row.owner_address,
        })
      )
    )
  }

  async function commitAuthenticatedReceiptMutation({
    challenge,
    consumeToken,
    now,
    expectedVersion,
    receipt,
    intentDigest,
    attempt,
  }) {
    const row = toExecutionReceiptRow(receipt, intentDigest)
    const attemptRow = toPhaseAttemptRow(attempt)
    const nextVersion = expectedVersion + 1
    async function consumeExactDuplicate() {
      const result = await db
        .prepare(
          `UPDATE execution_receipt_challenges
           SET consumed_at = ?, consume_token = ?
           WHERE challenge_id = ? AND network_id = ? AND owner_address = ? AND agent_address = ?
             AND request_digest = ? AND expires_at = ? AND expires_at > ?
             AND consumed_at IS NULL AND consume_token IS NULL
             AND EXISTS (
               SELECT 1 FROM execution_phase_attempts a
               WHERE a.attempt_id = ? AND a.network_id = ? AND a.execution_id = ?
                 AND a.allocation_id = ? AND a.owner_address = ? AND a.agent_address = ?
                 AND a.request_digest = ?
             )`
        )
        .bind(
          now,
          consumeToken,
          challenge.challengeId,
          row.network_id,
          row.owner_address,
          row.agent_address,
          challenge.requestDigest,
          challenge.expiresAt,
          now,
          attemptRow.attempt_id,
          row.network_id,
          row.execution_id,
          row.allocation_id,
          row.owner_address,
          row.agent_address,
          challenge.requestDigest
        )
        .run()
      return Number(result?.meta?.changes ?? 0) === 1
    }
    if (await consumeExactDuplicate()) {
      return { written: 0, duplicates: 1, version: nextVersion }
    }
    const consume = db
      .prepare(
        `UPDATE execution_receipt_challenges
         SET consumed_at = ?, consume_token = ?
         WHERE challenge_id = ? AND network_id = ? AND owner_address = ? AND agent_address = ?
           AND request_digest = ? AND expires_at = ? AND expires_at > ?
           AND consumed_at IS NULL AND consume_token IS NULL`
      )
      .bind(
        now,
        consumeToken,
        challenge.challengeId,
        row.network_id,
        row.owner_address,
        row.agent_address,
        challenge.requestDigest,
        challenge.expiresAt,
        now
      )
    const projection = db
      .prepare(
        `INSERT INTO execution_receipts
           (network_id, execution_id, allocation_id, receipt_format, owner_address, run_id,
            parent_allocation_id, child_id, worker_address, agent_address, intent_digest,
            intent_json, pull_status, stellar_deposit_status, cctp_burn_status, cctp_mint_status,
            base_deposit_status, custody_location, custody_confirmed, custody_token, custody_units,
            custody_decimals, custody_reason, last_mutation_token, version, created_at, updated_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS (
           SELECT 1 FROM execution_receipt_challenges
           WHERE challenge_id = ? AND consume_token = ? AND consumed_at = ?
         )
           AND (
             (? = 0 AND NOT EXISTS (
               SELECT 1 FROM execution_receipts current
               WHERE current.network_id = ? AND current.execution_id = ?
                 AND current.allocation_id = ?
             ))
             OR EXISTS (
               SELECT 1 FROM execution_receipts current
               WHERE current.network_id = ? AND current.execution_id = ?
                 AND current.allocation_id = ? AND current.version = ?
             )
           )
         ON CONFLICT(network_id, execution_id, allocation_id) DO UPDATE SET
           pull_status = excluded.pull_status,
           stellar_deposit_status = excluded.stellar_deposit_status,
           cctp_burn_status = excluded.cctp_burn_status,
           cctp_mint_status = excluded.cctp_mint_status,
           base_deposit_status = excluded.base_deposit_status,
           custody_location = excluded.custody_location,
           custody_confirmed = excluded.custody_confirmed,
           custody_token = excluded.custody_token,
           custody_units = excluded.custody_units,
           custody_decimals = excluded.custody_decimals,
           custody_reason = excluded.custody_reason,
           last_mutation_token = excluded.last_mutation_token,
           version = excluded.version,
           updated_at = excluded.updated_at
         WHERE execution_receipts.version = ?
           AND execution_receipts.receipt_format = excluded.receipt_format
           AND execution_receipts.owner_address = excluded.owner_address
           AND execution_receipts.run_id = excluded.run_id
           AND execution_receipts.parent_allocation_id IS excluded.parent_allocation_id
           AND execution_receipts.child_id IS excluded.child_id
           AND execution_receipts.worker_address = excluded.worker_address
           AND execution_receipts.agent_address = excluded.agent_address
           AND execution_receipts.intent_digest = excluded.intent_digest
           AND execution_receipts.intent_json = excluded.intent_json
           AND (execution_receipts.pull_status <> 'confirmed' OR excluded.pull_status = 'confirmed')
           AND (execution_receipts.stellar_deposit_status <> 'confirmed'
             OR excluded.stellar_deposit_status = 'confirmed')
           AND (execution_receipts.cctp_burn_status <> 'confirmed'
             OR excluded.cctp_burn_status = 'confirmed')
           AND (execution_receipts.cctp_mint_status <> 'confirmed'
             OR excluded.cctp_mint_status = 'confirmed')
           AND (execution_receipts.base_deposit_status <> 'confirmed'
             OR excluded.base_deposit_status = 'confirmed')
           AND (execution_receipts.custody_confirmed <> 1
             OR excluded.custody_confirmed = 1)
           AND (execution_receipts.custody_confirmed <> 1
             OR execution_receipts.custody_units IS NULL
             OR excluded.custody_units IS NOT NULL)`
      )
      .bind(
        row.network_id,
        row.execution_id,
        row.allocation_id,
        row.receipt_format,
        row.owner_address,
        row.run_id,
        row.parent_allocation_id,
        row.child_id,
        row.worker_address,
        row.agent_address,
        row.intent_digest,
        row.intent_json,
        row.pull_status,
        row.stellar_deposit_status,
        row.cctp_burn_status,
        row.cctp_mint_status,
        row.base_deposit_status,
        row.custody_location,
        row.custody_confirmed,
        row.custody_token,
        row.custody_units,
        row.custody_decimals,
        row.custody_reason,
        consumeToken,
        nextVersion,
        now,
        now,
        challenge.challengeId,
        consumeToken,
        now,
        expectedVersion,
        row.network_id,
        row.execution_id,
        row.allocation_id,
        row.network_id,
        row.execution_id,
        row.allocation_id,
        expectedVersion,
        expectedVersion
      )
    // `receipt_version` is NOT NULL. Its scalar subquery resolves only after both the challenge
    // consume and CAS projection succeeded earlier in this same D1 batch. A loser resolves NULL,
    // raises a constraint error, and rolls back all three statements.
    const evidence = db
      .prepare(
        `INSERT INTO execution_phase_attempts
           (attempt_id, network_id, execution_id, allocation_id, owner_address, agent_address,
            attempt_kind, phase, status, evidence_json, request_digest, observed_at, receipt_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,(
           SELECT r.version FROM execution_receipts r
           WHERE r.network_id = ? AND r.execution_id = ? AND r.allocation_id = ?
             AND r.owner_address = ? AND r.agent_address = ? AND r.version = ?
             AND r.last_mutation_token = ?
             AND EXISTS (
               SELECT 1 FROM execution_receipt_challenges c
               WHERE c.challenge_id = ? AND c.consume_token = ? AND c.consumed_at = ?
             )
         ))`
      )
      .bind(
        attemptRow.attempt_id,
        row.network_id,
        row.execution_id,
        row.allocation_id,
        row.owner_address,
        row.agent_address,
        attemptRow.attempt_kind,
        attemptRow.phase,
        attemptRow.status,
        attemptRow.evidence_json,
        challenge.requestDigest,
        attemptRow.observed_at,
        row.network_id,
        row.execution_id,
        row.allocation_id,
        row.owner_address,
        row.agent_address,
        nextVersion,
        consumeToken,
        challenge.challengeId,
        consumeToken,
        now
      )
    try {
      const results = await db.batch([consume, projection, evidence])
      if (results.some((result) => Number(result?.meta?.changes ?? 0) !== 1)) {
        throw new Error('receipt atomic mutation did not change every guarded row')
      }
      return { written: 1, duplicates: 0, version: nextVersion }
    } catch (error) {
      if (await consumeExactDuplicate()) {
        return { written: 0, duplicates: 1, version: nextVersion }
      }
      let current
      let challengeState
      let collidingAttempt
      try {
        ;[current, challengeState, collidingAttempt] = await Promise.all([
          db
            .prepare(
              `SELECT * FROM execution_receipts
               WHERE network_id = ? AND execution_id = ? AND allocation_id = ?`
            )
            .bind(row.network_id, row.execution_id, row.allocation_id)
            .first(),
          readReceiptChallenge({ challengeId: challenge.challengeId }),
          db
            .prepare(`SELECT * FROM execution_phase_attempts WHERE attempt_id = ?`)
            .bind(attemptRow.attempt_id)
            .first(),
        ])
      } catch (probeError) {
        throw new AgentIndexStoreError('Execution receipt store failed', { cause: probeError })
      }
      const immutableConflict =
        current &&
        (current.receipt_format !== row.receipt_format ||
          current.owner_address !== row.owner_address ||
          current.run_id !== row.run_id ||
          current.parent_allocation_id !== row.parent_allocation_id ||
          current.child_id !== row.child_id ||
          current.worker_address !== row.worker_address ||
          current.agent_address !== row.agent_address ||
          current.intent_digest !== row.intent_digest ||
          current.intent_json !== row.intent_json)
      const versionConflict =
        (expectedVersion === 0 && current != null) ||
        (expectedVersion > 0 && current?.version !== expectedVersion)
      const phaseColumns = {
        pull: 'pull_status',
        stellar_deposit: 'stellar_deposit_status',
        cctp_burn: 'cctp_burn_status',
        cctp_mint: 'cctp_mint_status',
        base_deposit: 'base_deposit_status',
      }
      const confirmedRegression = Object.entries(phaseColumns).some(
        ([phase, column]) =>
          current?.[column] === 'confirmed' && receipt.phases?.[phase] !== 'confirmed'
      )
      const custodyRegression =
        current?.custody_confirmed === 1 &&
        (row.custody_confirmed !== 1 ||
          (current.custody_units != null && row.custody_units == null))
      if (
        immutableConflict ||
        versionConflict ||
        confirmedRegression ||
        custodyRegression ||
        challengeState?.consumedAt != null ||
        collidingAttempt
      ) {
        const message = custodyRegression
          ? 'confirmed custody evidence cannot be erased'
          : confirmedRegression
            ? 'confirmed receipt evidence cannot be downgraded'
            : 'receipt version, immutable intent, challenge, or attempt conflict'
        throw new AgentIndexConflictError(message, { cause: error })
      }
      throw new AgentIndexStoreError('Execution receipt store failed', { cause: error })
    }
  }

  async function acquireRecoveryLease({
    networkId,
    owner,
    executionId,
    allocationId,
    childId = '',
    phase,
    holder,
    leaseToken,
    now,
    ttlMs = 60_000,
  }) {
    if (![networkId, owner, executionId, allocationId, phase, holder, leaseToken].every(Boolean)) {
      throw new Error('recovery lease identity and holder are required')
    }
    if (!RECEIPT_PHASES.includes(phase)) throw new Error('invalid recovery lease phase')
    if (!Number.isInteger(now) || !Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('invalid recovery lease time')
    }
    const result = await db
      .prepare(
        `INSERT INTO execution_recovery_leases
           (network_id, execution_id, allocation_id, child_id, phase, owner_address,
            holder, lease_token, acquired_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(network_id, execution_id, allocation_id, child_id, phase) DO UPDATE SET
           holder = excluded.holder,
           lease_token = excluded.lease_token,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at
         WHERE execution_recovery_leases.owner_address = excluded.owner_address
           AND (execution_recovery_leases.expires_at <= ?
             OR execution_recovery_leases.lease_token = excluded.lease_token)`
      )
      .bind(
        networkId,
        executionId,
        allocationId,
        childId ?? '',
        phase,
        owner,
        holder,
        leaseToken,
        now,
        now + ttlMs,
        now
      )
      .run()
    return {
      acquired: Number(result?.meta?.changes ?? 0) === 1,
      leaseToken,
      expiresAt: now + ttlMs,
    }
  }

  async function releaseRecoveryLease({
    networkId,
    executionId,
    allocationId,
    childId = '',
    phase,
    leaseToken,
  }) {
    const result = await db
      .prepare(
        `DELETE FROM execution_recovery_leases
         WHERE network_id = ? AND execution_id = ? AND allocation_id = ? AND child_id = ?
           AND phase = ? AND lease_token = ?`
      )
      .bind(networkId, executionId, allocationId, childId ?? '', phase, leaseToken)
      .run()
    return { released: Number(result?.meta?.changes ?? 0) === 1 }
  }

  const BASE_RECOVERY_ACTION_PHASE = Object.freeze({
    'poll-attestation': 'cctp_attestation',
    'submit-mint': 'cctp_mint',
    'poll-mint': 'cctp_mint',
    'submit-base-deposit': 'base_deposit',
    'poll-base-deposit': 'base_deposit',
  })

  function validateBaseLeaseInput(lease, { requireHolder = true, requireTtl = false } = {}) {
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
      throw new AgentIndexValidationError('Base recovery lease is required')
    }
    const action = lease.action
    const phase = lease.phase
    if (!BASE_RECOVERY_ACTIONS.includes(action) || !BASE_RECOVERY_ACTION_PHASE[action]) {
      throw new AgentIndexValidationError('Base recovery lease action is not claimable')
    }
    if (BASE_RECOVERY_ACTION_PHASE[action] !== phase || !BASE_RECOVERY_PHASES.includes(phase)) {
      throw new AgentIndexValidationError('Base recovery lease phase does not match action')
    }
    if (
      !lease.identity ||
      typeof lease.identity !== 'object' ||
      !lease.identity.networkId ||
      !lease.identity.bindingId ||
      !lease.identity.executionId ||
      !lease.identity.allocationId ||
      !lease.identity.childId
    ) {
      throw new AgentIndexValidationError('Base recovery lease identity is required')
    }
    if (typeof lease.leaseToken !== 'string' || !/^[0-9a-f]{64}$/.test(lease.leaseToken)) {
      throw new AgentIndexValidationError('Base recovery lease token is invalid')
    }
    if (!Number.isSafeInteger(lease.evidenceVersion) || lease.evidenceVersion < 0) {
      throw new AgentIndexValidationError('Base recovery lease evidence version is invalid')
    }
    if (!Number.isSafeInteger(lease.now) || lease.now < 0) {
      throw new AgentIndexValidationError('Base recovery lease time is invalid')
    }
    if (
      requireHolder &&
      (typeof lease.holder !== 'string' || !lease.holder || lease.holder.length > 128)
    ) {
      throw new AgentIndexValidationError('Base recovery lease holder is required')
    }
    if (requireTtl && (!Number.isSafeInteger(lease.ttlMs) || lease.ttlMs <= 0)) {
      throw new AgentIndexValidationError('Base recovery lease TTL is invalid')
    }
  }

  async function readBaseChildLeaseIntent(identity, owner) {
    const row = await db
      .prepare(
        `SELECT recovery_version, owner_address, agent_address
           FROM base_child_intents
          WHERE network_id = ? AND binding_id = ? AND execution_id = ?
            AND allocation_id = ? AND child_id = ?${owner ? ' AND owner_address = ?' : ''}`
      )
      .bind(
        identity.networkId,
        identity.bindingId,
        identity.executionId,
        identity.allocationId,
        identity.childId,
        ...(owner ? [owner] : [])
      )
      .first()
    return row ?? null
  }

  async function acquireBaseChildRecoveryLease(lease) {
    validateBaseLeaseInput(lease, { requireHolder: true, requireTtl: true })
    if (typeof lease.owner !== 'string' || !lease.owner) {
      throw new AgentIndexValidationError('Base recovery lease owner is required')
    }
    const intent = await readBaseChildLeaseIntent(lease.identity, lease.owner)
    if (!intent) return { acquired: false, code: 'identity-conflict' }
    if (intent.recovery_version !== lease.evidenceVersion) {
      return { acquired: false, code: 'version-conflict', currentVersion: intent.recovery_version }
    }
    const expiresAt = lease.now + lease.ttlMs
    const leaseTokenDigest = baseRecoveryLeaseTokenDigest(lease.leaseToken)
    // The schema intentionally makes action/evidence_version immutable on UPDATE.  Once the
    // authoritative child version advances, remove only the stale row for this exact identity and
    // phase; the following INSERT then records the new immutable claim facts.  Live same-version
    // rows are never touched here, so a failed claim leaves every byte/timestamp unchanged.
    const staleLeaseDelete = db
      .prepare(
        `DELETE FROM base_child_recovery_leases
          WHERE network_id = ? AND binding_id = ? AND execution_id = ?
            AND allocation_id = ? AND child_id = ? AND phase = ?
            AND evidence_version < ?
            AND EXISTS (
              SELECT 1 FROM base_child_intents i
               WHERE i.network_id = ? AND i.binding_id = ? AND i.execution_id = ?
                 AND i.allocation_id = ? AND i.child_id = ? AND i.owner_address = ?
                 AND i.recovery_version = ?
            )`
      )
      .bind(
        lease.identity.networkId,
        lease.identity.bindingId,
        lease.identity.executionId,
        lease.identity.allocationId,
        lease.identity.childId,
        lease.phase,
        lease.evidenceVersion,
        lease.identity.networkId,
        lease.identity.bindingId,
        lease.identity.executionId,
        lease.identity.allocationId,
        lease.identity.childId,
        lease.owner,
        lease.evidenceVersion
      )
    const leaseUpsert = db
      .prepare(
        `INSERT INTO base_child_recovery_leases
           (network_id, binding_id, execution_id, allocation_id, child_id, phase,
            owner_address, action, evidence_version, holder, lease_token, acquired_at, expires_at)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
           FROM base_child_intents
          WHERE network_id = ? AND binding_id = ? AND execution_id = ?
            AND allocation_id = ? AND child_id = ? AND owner_address = ?
            AND recovery_version = ?
         ON CONFLICT(network_id, binding_id, allocation_id, child_id, phase) DO UPDATE SET
           holder = excluded.holder,
           lease_token = excluded.lease_token,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at
         WHERE base_child_recovery_leases.network_id = excluded.network_id
           AND base_child_recovery_leases.binding_id = excluded.binding_id
           AND base_child_recovery_leases.execution_id = excluded.execution_id
           AND base_child_recovery_leases.allocation_id = excluded.allocation_id
           AND base_child_recovery_leases.child_id = excluded.child_id
           AND base_child_recovery_leases.phase = excluded.phase
           AND base_child_recovery_leases.owner_address = excluded.owner_address
           AND base_child_recovery_leases.action = excluded.action
           AND base_child_recovery_leases.evidence_version = excluded.evidence_version
           AND (base_child_recovery_leases.expires_at <= ?
             OR (base_child_recovery_leases.lease_token = excluded.lease_token
                 AND base_child_recovery_leases.holder = excluded.holder)
             OR base_child_recovery_leases.evidence_version <
                (SELECT recovery_version FROM base_child_intents
                   WHERE network_id = excluded.network_id AND binding_id = excluded.binding_id
                     AND execution_id = excluded.execution_id AND allocation_id = excluded.allocation_id
                     AND child_id = excluded.child_id AND owner_address = excluded.owner_address))`
      )
      .bind(
        lease.identity.networkId,
        lease.identity.bindingId,
        lease.identity.executionId,
        lease.identity.allocationId,
        lease.identity.childId,
        lease.phase,
        lease.owner,
        lease.action,
        lease.evidenceVersion,
        lease.holder,
        leaseTokenDigest,
        lease.now,
        expiresAt,
        lease.identity.networkId,
        lease.identity.bindingId,
        lease.identity.executionId,
        lease.identity.allocationId,
        lease.identity.childId,
        lease.owner,
        lease.evidenceVersion,
        lease.now
      )
    const [, result] = await db.batch([staleLeaseDelete, leaseUpsert])
    const acquired = Number(result?.meta?.changes ?? 0) === 1
    return {
      acquired,
      leaseToken: lease.leaseToken,
      expiresAt,
      ...(acquired ? {} : { code: 'lease-conflict' }),
    }
  }

  async function readBaseChildRecoveryClaim({
    identity,
    action,
    phase,
    evidenceVersion,
    leaseToken,
    now,
    includeVersionConflict = false,
  }) {
    validateBaseLeaseInput(
      {
        identity,
        action,
        phase: phase ?? BASE_RECOVERY_ACTION_PHASE[action],
        evidenceVersion,
        leaseToken,
        now,
      },
      { requireHolder: false, requireTtl: false }
    )
    const selectedPhase = phase ?? BASE_RECOVERY_ACTION_PHASE[action]
    const leaseTokenDigest = baseRecoveryLeaseTokenDigest(leaseToken)
    const row = await db
      .prepare(
        `SELECT l.network_id, l.binding_id, l.execution_id, l.allocation_id, l.child_id,
                l.phase, l.owner_address, i.agent_address, l.action, l.evidence_version, l.holder,
                l.lease_token, l.acquired_at, l.expires_at, i.recovery_version AS current_recovery_version
           FROM base_child_recovery_leases l
           JOIN base_child_intents i
             ON i.network_id = l.network_id AND i.binding_id = l.binding_id
            AND i.execution_id = l.execution_id AND i.allocation_id = l.allocation_id
            AND i.child_id = l.child_id AND i.owner_address = l.owner_address
          WHERE l.network_id = ? AND l.binding_id = ? AND l.execution_id = ?
            AND l.allocation_id = ? AND l.child_id = ? AND l.phase = ?
            AND l.action = ? AND l.evidence_version = ? AND l.lease_token = ?
            AND l.expires_at > ?`
      )
      .bind(
        identity.networkId,
        identity.bindingId,
        identity.executionId,
        identity.allocationId,
        identity.childId,
        selectedPhase,
        action,
        evidenceVersion,
        leaseTokenDigest,
        now
      )
      .first()
    if (!row) return null
    if (row.current_recovery_version !== evidenceVersion) {
      return includeVersionConflict
        ? { conflict: 'version', currentVersion: row.current_recovery_version }
        : null
    }
    return {
      identity: {
        networkId: row.network_id,
        bindingId: row.binding_id,
        executionId: row.execution_id,
        allocationId: row.allocation_id,
        childId: row.child_id,
      },
      owner: row.owner_address,
      agent: row.agent_address,
      action: row.action,
      phase: row.phase,
      evidenceVersion: row.evidence_version,
      holder: row.holder,
      leaseToken,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
    }
  }

  async function renewBaseChildRecoveryLease({
    identity,
    action,
    phase,
    evidenceVersion,
    holder,
    leaseToken,
    now,
    ttlMs,
  }) {
    validateBaseLeaseInput(
      {
        identity,
        action,
        phase: phase ?? BASE_RECOVERY_ACTION_PHASE[action],
        evidenceVersion,
        holder,
        leaseToken,
        now,
        ttlMs,
      },
      { requireHolder: true, requireTtl: true }
    )
    const selectedPhase = phase ?? BASE_RECOVERY_ACTION_PHASE[action]
    const expiresAt = now + ttlMs
    const leaseTokenDigest = baseRecoveryLeaseTokenDigest(leaseToken)
    const intent = await readBaseChildLeaseIntent(identity)
    if (!intent) return { renewed: false, expiresAt }
    const owner = intent.owner_address
    const result = await db
      .prepare(
        `UPDATE base_child_recovery_leases
            SET expires_at = ?
          WHERE network_id = ? AND binding_id = ? AND execution_id = ?
            AND allocation_id = ? AND child_id = ? AND phase = ?
            AND owner_address = ? AND action = ? AND evidence_version = ?
            AND holder = ? AND lease_token = ? AND expires_at > ?
            AND EXISTS (
              SELECT 1 FROM base_child_intents i
               WHERE i.network_id = ? AND i.binding_id = ? AND i.execution_id = ?
                 AND i.allocation_id = ? AND i.child_id = ? AND i.owner_address = ?
                 AND i.recovery_version = ?
            )`
      )
      .bind(
        expiresAt,
        identity.networkId,
        identity.bindingId,
        identity.executionId,
        identity.allocationId,
        identity.childId,
        selectedPhase,
        owner,
        action,
        evidenceVersion,
        holder,
        leaseTokenDigest,
        now,
        identity.networkId,
        identity.bindingId,
        identity.executionId,
        identity.allocationId,
        identity.childId,
        owner,
        evidenceVersion
      )
      .run()
    return { renewed: Number(result?.meta?.changes ?? 0) === 1, expiresAt }
  }

  async function releaseBaseChildRecoveryLease({
    identity,
    action,
    phase,
    evidenceVersion,
    leaseToken,
  }) {
    validateBaseLeaseInput(
      {
        identity,
        action,
        phase: phase ?? BASE_RECOVERY_ACTION_PHASE[action],
        evidenceVersion,
        leaseToken,
        now: 0,
      },
      { requireHolder: false, requireTtl: false }
    )
    const selectedPhase = phase ?? BASE_RECOVERY_ACTION_PHASE[action]
    const leaseTokenDigest = baseRecoveryLeaseTokenDigest(leaseToken)
    const result = await db
      .prepare(
        `DELETE FROM base_child_recovery_leases
          WHERE network_id = ? AND binding_id = ? AND execution_id = ?
            AND allocation_id = ? AND child_id = ? AND phase = ?
            AND action = ? AND evidence_version = ? AND lease_token = ?`
      )
      .bind(
        identity.networkId,
        identity.bindingId,
        identity.executionId,
        identity.allocationId,
        identity.childId,
        selectedPhase,
        action,
        evidenceVersion,
        leaseTokenDigest
      )
      .run()
    return { released: Number(result?.meta?.changes ?? 0) === 1 }
  }

  async function readBaseChildIntent({ networkId, bindingId, allocationId, childId, owner }) {
    const row = await db
      .prepare(
        `SELECT * FROM base_child_intents
         WHERE network_id = ? AND binding_id = ? AND allocation_id = ? AND child_id = ?
           AND owner_address = ?`
      )
      .bind(networkId, bindingId, allocationId, childId, owner)
      .first()
    return parseBaseChildRow(row)
  }

  async function readOwnerBaseChildIntents({ networkId, owner }) {
    if (!networkId || !owner)
      throw new Error('readOwnerBaseChildIntents requires networkId and owner')
    const { results } = await db
      .prepare(
        `SELECT * FROM base_child_intents
         WHERE network_id = ? AND owner_address = ?
         ORDER BY created_at ASC, binding_id ASC, allocation_id ASC, child_id ASC`
      )
      .bind(networkId, owner)
      .all()
    return (results ?? []).map(parseBaseChildRow)
  }

  async function readBaseChildIntentBatch(idempotencyKey) {
    const receipt = await db
      .prepare(`SELECT * FROM base_child_intent_batches WHERE idempotency_key = ?`)
      .bind(idempotencyKey)
      .first()
    if (!receipt) return null
    const { results } = await db
      .prepare(
        `SELECT * FROM base_child_intent_batch_items
         WHERE idempotency_key = ? ORDER BY ordinal ASC`
      )
      .bind(idempotencyKey)
      .all()
    return { receipt, items: results ?? [] }
  }

  function exactBatch(existing, { batch, requestDigest, idempotencyKey }) {
    if (!existing || existing.receipt.idempotency_key !== idempotencyKey) return false
    if (
      existing.receipt.request_digest !== requestDigest ||
      existing.receipt.burn_units_7 !== batch.burnUnits7 ||
      existing.receipt.child_count !== batch.children.length ||
      existing.items.length !== batch.children.length
    ) {
      return false
    }
    return batch.children.every((child, ordinal) => {
      const item = existing.items[ordinal]
      const row = toBaseChildRow(child, baseChildBatchDigest(child.intent))
      return (
        item?.ordinal === ordinal &&
        item.network_id === row.network_id &&
        item.binding_id === row.binding_id &&
        item.execution_id === row.execution_id &&
        item.allocation_id === row.allocation_id &&
        item.child_id === row.child_id &&
        item.owner_address === row.owner_address &&
        item.agent_address === row.agent_address &&
        item.intent_digest === row.intent_digest
      )
    })
  }

  async function reserveBaseChildIntentBatch({ batch, requestDigest, idempotencyKey }) {
    if (
      !batch ||
      batch.idempotencyKey !== idempotencyKey ||
      !idempotencyKey ||
      !/^[0-9a-f]{64}$/.test(requestDigest ?? '') ||
      !Array.isArray(batch.children) ||
      batch.children.length === 0 ||
      batch.children.length > MAX_BASE_CHILD_BATCH_SIZE ||
      !/^(?:[1-9]\d*)$/.test(batch.burnUnits7 ?? '')
    ) {
      throw new AgentIndexValidationError('Invalid Base child intent batch')
    }
    const existing = await readBaseChildIntentBatch(idempotencyKey)
    if (existing) {
      if (!exactBatch(existing, { batch, requestDigest, idempotencyKey })) {
        throw new AgentIndexConflictError('Base child batch idempotency conflict')
      }
      const children = await Promise.all(
        batch.children.map(async (child) => {
          const identity = baseChildRecoveryIdentity(child)
          const bundle = await readBaseChildRecoveryBundle(identity)
          return { identity, recoveryVersion: bundle.recoveryVersion }
        })
      )
      return { written: 0, duplicates: batch.children.length, children }
    }

    const rows = batch.children.map((child) =>
      toBaseChildRow(child, baseChildBatchDigest(child.intent))
    )
    const first = rows[0]
    const firstIntent = batch.children[0].intent
    const createdAt = Math.min(...rows.map((row) => row.observed_at))
    const statements = [
      db
        .prepare(
          `INSERT INTO base_child_intent_batches
             (idempotency_key, request_digest, network_id, owner_address, agent_address,
              binding_id, run_id, grant_tx_hash, kernel_address, binding_hash, base_job_id,
              burn_units_7, child_count, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          idempotencyKey,
          requestDigest,
          first.network_id,
          first.owner_address,
          first.agent_address,
          first.binding_id,
          firstIntent.runId,
          firstIntent.grantTxHash,
          firstIntent.kernelAddress,
          firstIntent.bindingHash,
          firstIntent.baseJobId,
          batch.burnUnits7,
          rows.length,
          createdAt
        ),
    ]
    rows.forEach((row, ordinal) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO base_child_intents
               (network_id, binding_id, execution_id, allocation_id, child_id,
                owner_address, agent_address, intent_digest, intent_json, token, units, decimals,
                lifecycle_sequence, lifecycle_status, lifecycle_evidence_json, recovery_version,
                created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            row.network_id,
            row.binding_id,
            row.execution_id,
            row.allocation_id,
            row.child_id,
            row.owner_address,
            row.agent_address,
            row.intent_digest,
            row.intent_json,
            row.token,
            row.units,
            row.decimals,
            row.lifecycle_sequence,
            row.lifecycle_status,
            row.lifecycle_evidence_json,
            0,
            row.observed_at,
            row.observed_at
          ),
        db
          .prepare(
            `INSERT INTO base_child_lifecycle_events
               (network_id, binding_id, allocation_id, child_id, sequence, idempotency_key,
                status, evidence_json, observed_at)
             VALUES (?,?,?,?,0,?,?,?,?)`
          )
          .bind(
            row.network_id,
            row.binding_id,
            row.allocation_id,
            row.child_id,
            `${idempotencyKey}:${ordinal}:planned`,
            row.lifecycle_status,
            row.lifecycle_evidence_json,
            row.observed_at
          ),
        db
          .prepare(
            `INSERT INTO base_child_intent_batch_items
               (idempotency_key, ordinal, network_id, binding_id, execution_id, allocation_id,
                child_id, owner_address, agent_address, intent_digest)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            idempotencyKey,
            ordinal,
            row.network_id,
            row.binding_id,
            row.execution_id,
            row.allocation_id,
            row.child_id,
            row.owner_address,
            row.agent_address,
            row.intent_digest
          )
      )
    })
    try {
      await db.batch(statements)
      return {
        written: rows.length,
        duplicates: 0,
        children: batch.children.map((child) => ({
          identity: baseChildRecoveryIdentity(child),
          recoveryVersion: 0,
        })),
      }
    } catch (error) {
      const raced = await readBaseChildIntentBatch(idempotencyKey)
      if (exactBatch(raced, { batch, requestDigest, idempotencyKey })) {
        const children = await Promise.all(
          batch.children.map(async (child) => {
            const identity = baseChildRecoveryIdentity(child)
            const bundle = await readBaseChildRecoveryBundle(identity)
            return { identity, recoveryVersion: bundle.recoveryVersion }
          })
        )
        return { written: 0, duplicates: rows.length, children }
      }
      const message = String(error?.message ?? error)
      if (/constraint|unique|immutable|conflict/i.test(message)) {
        throw new AgentIndexConflictError('Base child batch conflict', { cause: error })
      }
      throw new AgentIndexStoreError('Base child batch store failed', { cause: error })
    }
  }

  async function readBaseChildRecoveryBundle(identity) {
    let normalized
    try {
      normalized = baseChildRecoveryIdentity(identity)
    } catch (error) {
      throw new AgentIndexValidationError('Invalid Base child recovery identity', { cause: error })
    }
    const args = [
      normalized.networkId,
      normalized.bindingId,
      normalized.executionId,
      normalized.allocationId,
      normalized.childId,
    ]
    const row = await db
      .prepare(
        `SELECT * FROM base_child_intents
         WHERE network_id = ? AND binding_id = ? AND execution_id = ?
           AND allocation_id = ? AND child_id = ?`
      )
      .bind(...args)
      .first()
    if (!row) return null
    const [{ results: projectionRows }, { results: eventRows }] = await Promise.all([
      db
        .prepare(
          `SELECT * FROM base_child_phase_projection
           WHERE network_id = ? AND binding_id = ? AND execution_id = ?
             AND allocation_id = ? AND child_id = ?
           ORDER BY CASE phase
             WHEN 'cctp_burn' THEN 0 WHEN 'cctp_attestation' THEN 1
             WHEN 'cctp_mint' THEN 2 WHEN 'base_deposit' THEN 3 END ASC`
        )
        .bind(...args)
        .all(),
      db
        .prepare(
          `SELECT * FROM base_child_phase_events
           WHERE network_id = ? AND binding_id = ? AND execution_id = ?
             AND allocation_id = ? AND child_id = ?
           ORDER BY recovery_version ASC, event_id ASC`
        )
        .bind(...args)
        .all(),
    ])
    const parsedIntent = parseBaseChildRow(row)
    // The selector consumes one closed internal bundle.  Do not hand it the richer SQL row
    // wrapper (`version`, lifecycle, owner, and timestamps): those are storage details and would
    // make an otherwise valid bundle fail the exact-intent allowlist.  Subjects remain top-level
    // immutable facts so the browser proof and reporter claim can bind them independently.
    return {
      schemaVersion: 1,
      identity: normalized,
      owner: parsedIntent.owner,
      agent: parsedIntent.agent,
      recoverable: parsedIntent.recoverable,
      recoveryVersion: parsedIntent.recoveryVersion,
      intent: parsedIntent.intent,
      phases: (projectionRows ?? []).map((entry) =>
        selectorPhaseEntry(entry, parseBaseChildPhaseProjectionRow)
      ),
      events: (eventRows ?? []).map((entry) =>
        selectorPhaseEntry(entry, parseBaseChildPhaseEventRow)
      ),
    }
  }

  function exactPhaseEvent(row, eventRow) {
    return (
      row?.event_id === eventRow.event_id &&
      row.network_id === eventRow.network_id &&
      row.binding_id === eventRow.binding_id &&
      row.execution_id === eventRow.execution_id &&
      row.allocation_id === eventRow.allocation_id &&
      row.child_id === eventRow.child_id &&
      row.owner_address === eventRow.owner_address &&
      row.agent_address === eventRow.agent_address &&
      row.recovery_version === eventRow.recovery_version &&
      row.phase === eventRow.phase &&
      row.state === eventRow.state &&
      row.evidence_digest === eventRow.evidence_digest &&
      row.evidence_json === eventRow.evidence_json &&
      row.observed_at === eventRow.observed_at
    )
  }

  function allowPhaseTransition(projections, eventRow) {
    const phaseIndex = BASE_CHILD_RECOVERY_PHASES.indexOf(eventRow.phase)
    const current = projections.find((entry) => entry.phase === eventRow.phase)
    for (let index = 0; index < phaseIndex; index += 1) {
      const predecessor = projections.find(
        (entry) => entry.phase === BASE_CHILD_RECOVERY_PHASES[index]
      )
      if (predecessor?.state !== 'confirmed') return false
    }
    if (!current) return true
    if (current.state === 'confirmed') return false
    const allowed = {
      submitting: new Set(['submitted', 'confirmed', 'failed', 'unknown', 'blocked']),
      submitted: new Set(['confirmed', 'failed', 'unknown', 'blocked']),
      unknown: new Set(['confirmed']),
      failed: eventRow.phase === 'cctp_attestation' ? new Set(['confirmed']) : new Set(),
      blocked: new Set(),
    }
    if (!allowed[current.state]?.has(eventRow.state)) return false
    const previousHandle = current.evidence?.reconcileHandle
    const nextEvidence = JSON.parse(eventRow.evidence_json)
    const nextHandle = nextEvidence.reconcileHandle
    if (
      (previousHandle == null) !== (nextHandle == null) ||
      (previousHandle != null && canonicalJson(previousHandle) !== canonicalJson(nextHandle))
    )
      return false
    if (
      ['unknown', 'failed'].includes(current.state) &&
      eventRow.state === 'confirmed' &&
      (current.phase === 'cctp_attestation' || current.state === 'unknown')
    ) {
      const previous = current.evidence ?? {}
      const next = nextEvidence
      const immutableFields = [
        'burnTxHash',
        'expectationDigest',
        'messageDigest',
        'nonce',
        'attestationDigest',
        'mintTxHash',
        'userOpHash',
        'transactionHash',
        'reconcileHandle',
      ]
      for (const key of immutableFields) {
        if (
          Object.prototype.hasOwnProperty.call(previous, key) &&
          next[key] !== undefined &&
          (typeof previous[key] === 'object' || typeof next[key] === 'object'
            ? canonicalJson(previous[key]) !== canonicalJson(next[key])
            : next[key] !== previous[key])
        )
          return false
      }
    }
    return true
  }

  async function advanceBaseChildPhase({ identity, expectedRecoveryVersion, event }) {
    const existingEvent = await db
      .prepare(`SELECT * FROM base_child_phase_events WHERE event_id = ?`)
      .bind(event?.eventId ?? '')
      .first()
    const bundle = await readBaseChildRecoveryBundle(identity)
    if (!bundle || !bundle.recoverable) {
      throw new AgentIndexConflictError('Base child recovery identity conflict')
    }
    let eventRow
    try {
      eventRow = toBaseChildPhaseEventRow(
        { identity, expectedRecoveryVersion, event },
        { owner: bundle.owner, agent: bundle.agent }
      )
    } catch (error) {
      if (existingEvent) {
        throw new AgentIndexConflictError('Base child phase event conflict', { cause: error })
      }
      throw new AgentIndexValidationError('Invalid Base child phase evidence', { cause: error })
    }
    if (existingEvent) {
      if (!exactPhaseEvent(existingEvent, eventRow)) {
        throw new AgentIndexConflictError('Base child phase event conflict')
      }
      return {
        written: 0,
        duplicates: 1,
        eventId: eventRow.event_id,
        recoveryVersion: eventRow.recovery_version,
        evidenceDigest: eventRow.evidence_digest,
        reportDigest: baseChildEvidenceReportDigest({ identity, expectedRecoveryVersion, event }),
      }
    }
    if (
      bundle.recoveryVersion !== expectedRecoveryVersion ||
      !allowPhaseTransition(bundle.phases, eventRow)
    ) {
      throw new AgentIndexConflictError('Base child phase sequence conflict')
    }
    const identityArgs = [
      eventRow.network_id,
      eventRow.binding_id,
      eventRow.execution_id,
      eventRow.allocation_id,
      eventRow.child_id,
    ]
    const statements = [
      db
        .prepare(
          `INSERT INTO base_child_phase_events
             (event_id, network_id, binding_id, execution_id, allocation_id, child_id,
              owner_address, agent_address, recovery_version, phase, state, evidence_digest,
              evidence_json, observed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          eventRow.event_id,
          ...identityArgs,
          eventRow.owner_address,
          eventRow.agent_address,
          eventRow.recovery_version,
          eventRow.phase,
          eventRow.state,
          eventRow.evidence_digest,
          eventRow.evidence_json,
          eventRow.observed_at
        ),
      db
        .prepare(
          `UPDATE base_child_intents SET recovery_version = ?, updated_at = ?
           WHERE network_id = ? AND binding_id = ? AND execution_id = ?
             AND allocation_id = ? AND child_id = ? AND recovery_version = ?`
        )
        .bind(
          eventRow.recovery_version,
          eventRow.observed_at,
          ...identityArgs,
          expectedRecoveryVersion
        ),
      db
        .prepare(
          `INSERT INTO base_child_phase_projection
             (network_id, binding_id, execution_id, allocation_id, child_id, phase,
              latest_event_id, recovery_version, state, evidence_digest, evidence_json, observed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(network_id, binding_id, allocation_id, child_id, phase) DO UPDATE SET
             latest_event_id = excluded.latest_event_id,
             recovery_version = excluded.recovery_version,
             state = excluded.state,
             evidence_digest = excluded.evidence_digest,
             evidence_json = excluded.evidence_json,
             observed_at = excluded.observed_at`
        )
        .bind(
          ...identityArgs,
          eventRow.phase,
          eventRow.event_id,
          eventRow.recovery_version,
          eventRow.state,
          eventRow.evidence_digest,
          eventRow.evidence_json,
          eventRow.observed_at
        ),
    ]
    try {
      await db.batch(statements)
      return {
        written: 1,
        duplicates: 0,
        eventId: eventRow.event_id,
        recoveryVersion: eventRow.recovery_version,
        evidenceDigest: eventRow.evidence_digest,
        reportDigest: baseChildEvidenceReportDigest({ identity, expectedRecoveryVersion, event }),
      }
    } catch (error) {
      const raced = await db
        .prepare(`SELECT * FROM base_child_phase_events WHERE event_id = ?`)
        .bind(eventRow.event_id)
        .first()
      if (exactPhaseEvent(raced, eventRow)) {
        return {
          written: 0,
          duplicates: 1,
          eventId: eventRow.event_id,
          recoveryVersion: eventRow.recovery_version,
          evidenceDigest: eventRow.evidence_digest,
          reportDigest: baseChildEvidenceReportDigest({ identity, expectedRecoveryVersion, event }),
        }
      }
      const message = String(error?.message ?? error)
      if (/constraint|unique|CAS|conflict/i.test(message)) {
        throw new AgentIndexConflictError('Base child phase evidence conflict', { cause: error })
      }
      throw new AgentIndexStoreError('Base child phase evidence store failed', { cause: error })
    }
  }

  async function createBaseChildIntent({ child, intentDigest, idempotencyKey }) {
    const row = toBaseChildRow(child, intentDigest)
    const now = row.observed_at
    const insertIntent = db
      .prepare(
        `INSERT INTO base_child_intents
           (network_id, binding_id, execution_id, allocation_id, child_id, owner_address, agent_address,
            intent_digest, intent_json, token, units, decimals, lifecycle_sequence,
            lifecycle_status, lifecycle_evidence_json, recovery_version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(network_id, binding_id, allocation_id, child_id) DO NOTHING`
      )
      .bind(
        row.network_id,
        row.binding_id,
        row.execution_id,
        row.allocation_id,
        row.child_id,
        row.owner_address,
        row.agent_address,
        row.intent_digest,
        row.intent_json,
        row.token,
        row.units,
        row.decimals,
        row.lifecycle_sequence,
        row.lifecycle_status,
        row.lifecycle_evidence_json,
        0,
        now,
        now
      )
    const insertEvent = db
      .prepare(
        `INSERT INTO base_child_lifecycle_events
           (network_id, binding_id, allocation_id, child_id, sequence, idempotency_key,
            status, evidence_json, observed_at)
         VALUES (?,?,?,?,(
           SELECT lifecycle_sequence FROM base_child_intents
           WHERE network_id = ? AND binding_id = ? AND allocation_id = ? AND child_id = ?
             AND owner_address = ? AND agent_address = ? AND intent_digest = ? AND intent_json = ?
             AND lifecycle_sequence = 0 AND lifecycle_status = ?
             AND lifecycle_evidence_json = ?
         ),?,?,?,?)`
      )
      .bind(
        row.network_id,
        row.binding_id,
        row.allocation_id,
        row.child_id,
        row.network_id,
        row.binding_id,
        row.allocation_id,
        row.child_id,
        row.owner_address,
        row.agent_address,
        row.intent_digest,
        row.intent_json,
        row.lifecycle_status,
        row.lifecycle_evidence_json,
        idempotencyKey,
        row.lifecycle_status,
        row.lifecycle_evidence_json,
        row.observed_at
      )
    try {
      const results = await db.batch([insertIntent, insertEvent])
      if (Number(results?.[1]?.meta?.changes ?? 0) !== 1) throw new Error('child event not written')
      return { written: 1, duplicates: 0, sequence: 0 }
    } catch (error) {
      const existing = await readBaseChildIntent({
        networkId: row.network_id,
        bindingId: row.binding_id,
        allocationId: row.allocation_id,
        childId: row.child_id,
        owner: row.owner_address,
      })
      if (
        existing?.intentDigest === row.intent_digest &&
        existing.agent === row.agent_address &&
        canonicalJson(existing.intent) === row.intent_json &&
        existing.lifecycle.sequence === 0 &&
        existing.lifecycle.status === row.lifecycle_status &&
        canonicalJson(existing.lifecycle.evidence) === row.lifecycle_evidence_json
      ) {
        return { written: 0, duplicates: 1, sequence: 0 }
      }
      if (existing) {
        throw new AgentIndexConflictError('immutable Base child intent conflict', { cause: error })
      }
      throw new AgentIndexStoreError('Base child intent store failed', { cause: error })
    }
  }

  async function advanceBaseChildLifecycle({
    identity,
    expectedSequence,
    lifecycle,
    idempotencyKey,
  }) {
    if (!Number.isInteger(expectedSequence) || lifecycle?.sequence !== expectedSequence + 1) {
      throw new AgentIndexValidationError('Base child lifecycle sequence must advance by one')
    }
    if (!BASE_CHILD_LIFECYCLE_STATUSES.includes(lifecycle.status)) {
      throw new AgentIndexValidationError('invalid Base child lifecycle status')
    }
    const evidenceJson = canonicalJson(lifecycle.evidence ?? {})
    if (!Number.isInteger(lifecycle.observedAt))
      throw new AgentIndexValidationError('lifecycle.observedAt must be integer')
    const update = db
      .prepare(
        `UPDATE base_child_intents
         SET lifecycle_sequence = ?, lifecycle_status = ?, lifecycle_evidence_json = ?, updated_at = ?
         WHERE network_id = ? AND binding_id = ? AND allocation_id = ? AND child_id = ?
           AND owner_address = ? AND lifecycle_sequence = ?
           AND (lifecycle_status <> 'confirmed' OR ? = 'confirmed')`
      )
      .bind(
        lifecycle.sequence,
        lifecycle.status,
        evidenceJson,
        lifecycle.observedAt,
        identity.networkId,
        identity.bindingId,
        identity.allocationId,
        identity.childId,
        identity.owner,
        expectedSequence,
        lifecycle.status
      )
    const event = db
      .prepare(
        `INSERT INTO base_child_lifecycle_events
           (network_id, binding_id, allocation_id, child_id, sequence, idempotency_key,
            status, evidence_json, observed_at)
         VALUES (?,?,?,?,(
           SELECT lifecycle_sequence FROM base_child_intents
           WHERE network_id = ? AND binding_id = ? AND allocation_id = ? AND child_id = ?
             AND owner_address = ? AND lifecycle_sequence = ? AND lifecycle_status = ?
             AND lifecycle_evidence_json = ?
         ),?,?,?,?)`
      )
      .bind(
        identity.networkId,
        identity.bindingId,
        identity.allocationId,
        identity.childId,
        identity.networkId,
        identity.bindingId,
        identity.allocationId,
        identity.childId,
        identity.owner,
        lifecycle.sequence,
        lifecycle.status,
        evidenceJson,
        idempotencyKey,
        lifecycle.status,
        evidenceJson,
        lifecycle.observedAt
      )
    try {
      const results = await db.batch([update, event])
      if (results.some((result) => Number(result?.meta?.changes ?? 0) !== 1)) {
        throw new Error('Base child lifecycle atomic guard failed')
      }
      return { written: 1, duplicates: 0, sequence: lifecycle.sequence }
    } catch (error) {
      let existingEvent
      let projection
      try {
        ;[existingEvent, projection] = await Promise.all([
          db
            .prepare(
              `SELECT * FROM base_child_lifecycle_events
               WHERE idempotency_key = ?`
            )
            .bind(idempotencyKey)
            .first(),
          readBaseChildIntent({
            networkId: identity.networkId,
            bindingId: identity.bindingId,
            allocationId: identity.allocationId,
            childId: identity.childId,
            owner: identity.owner,
          }),
        ])
      } catch (probeError) {
        throw new AgentIndexStoreError('Base child lifecycle store failed', { cause: probeError })
      }
      const exactEvent =
        existingEvent?.network_id === identity.networkId &&
        existingEvent.binding_id === identity.bindingId &&
        existingEvent.allocation_id === identity.allocationId &&
        existingEvent.child_id === identity.childId &&
        existingEvent.sequence === lifecycle.sequence &&
        existingEvent.status === lifecycle.status &&
        existingEvent.evidence_json === evidenceJson &&
        existingEvent.observed_at === lifecycle.observedAt
      if (exactEvent && projection && projection.lifecycle.sequence >= lifecycle.sequence) {
        return { written: 0, duplicates: 1, sequence: lifecycle.sequence }
      }
      if (
        existingEvent ||
        !projection ||
        projection.lifecycle.sequence !== expectedSequence ||
        (projection.lifecycle.status === 'confirmed' && lifecycle.status !== 'confirmed')
      ) {
        throw new AgentIndexConflictError('Base child lifecycle sequence conflict', {
          cause: error,
        })
      }
      throw new AgentIndexStoreError('Base child lifecycle store failed', { cause: error })
    }
  }

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
    try {
      await bindMembershipRow(row).run()
    } catch (error) {
      if (
        String(error?.message ?? error).includes('immutable agent membership identity conflict')
      ) {
        throw new AgentIndexConflictError('immutable agent membership identity conflict', {
          cause: error,
        })
      }
      throw error
    }
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

  async function readOwnerMembershipsPage({
    networkId,
    owner,
    limit,
    afterLedger,
    afterAddress,
    snapshotThroughLedger,
  }) {
    if (!networkId || !owner) {
      throw new Error('readOwnerMembershipsPage requires networkId and owner')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('readOwnerMembershipsPage requires limit from 1 to 500')
    }
    if (
      !Number.isSafeInteger(afterLedger) ||
      afterLedger < -1 ||
      typeof afterAddress !== 'string'
    ) {
      throw new Error('readOwnerMembershipsPage requires a valid keyset boundary')
    }
    if (!Number.isSafeInteger(snapshotThroughLedger) || snapshotThroughLedger < 0) {
      throw new Error('readOwnerMembershipsPage requires snapshotThroughLedger')
    }
    const { results } = await db
      .prepare(
        `SELECT * FROM agent_memberships
         WHERE network_id = ? AND owner_address = ?
           AND creation_ledger <= ?
           AND (creation_ledger > ? OR (creation_ledger = ? AND agent_address > ?))
         ORDER BY creation_ledger ASC, agent_address ASC
         LIMIT ?`
      )
      .bind(
        networkId,
        owner,
        snapshotThroughLedger,
        afterLedger,
        afterLedger,
        afterAddress,
        limit + 1
      )
      .all()
    const rows = results ?? []
    return { rows: rows.slice(0, limit).map(parseMembershipRow), hasMore: rows.length > limit }
  }

  async function readOwnerMaximumCreationLedger({ networkId, owner }) {
    if (!networkId || !owner) {
      throw new Error('readOwnerMaximumCreationLedger requires networkId and owner')
    }
    const row = await db
      .prepare(
        `SELECT MAX(creation_ledger) AS maximum_creation_ledger
         FROM agent_memberships WHERE network_id = ? AND owner_address = ?`
      )
      .bind(networkId, owner)
      .first()
    return row?.maximum_creation_ledger == null ? null : Number(row.maximum_creation_ledger)
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
    try {
      await db.batch([...rows.map((row) => bindMembershipRow(row)), sourceStatement])
    } catch (error) {
      if (
        String(error?.message ?? error).includes('immutable agent membership identity conflict')
      ) {
        throw new AgentIndexConflictError('immutable agent membership identity conflict', {
          cause: error,
        })
      }
      throw error
    }
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
    probeReadiness,
    issueReceiptChallenge,
    readReceiptChallenge,
    consumeReceiptChallenge,
    readExecutionReceipt,
    readOwnerExecutionReceipts,
    commitAuthenticatedReceiptMutation,
    acquireRecoveryLease,
    releaseRecoveryLease,
    acquireBaseChildRecoveryLease,
    readBaseChildRecoveryClaim,
    renewBaseChildRecoveryLease,
    releaseBaseChildRecoveryLease,
    ...(enableLegacyBaseChildWrites ? { createBaseChildIntent, advanceBaseChildLifecycle } : {}),
    readBaseChildIntent,
    readOwnerBaseChildIntents,
    reserveBaseChildIntentBatch,
    advanceBaseChildPhase,
    readBaseChildRecoveryBundle,
    readPublicBaseChildEvidence: readBaseChildRecoveryBundle,
    upsertMembership,
    upsertRunAllocation,
    readRunAllocation,
    readOwnerRunAllocations,
    hasAssociationEvent,
    commitAssociation,
    readOwnerMemberships,
    readOwnerMembershipsPage,
    readOwnerMaximumCreationLedger,
    readMembershipsByAgentAddresses,
    readCoverage,
    ensureSourceRow,
    commitSourcePage,
    recordGap,
    recordSourceError,
    recordBackfillAudit,
  }
}
