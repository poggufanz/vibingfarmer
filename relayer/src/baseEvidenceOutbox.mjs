import { createHash, randomUUID } from 'node:crypto';
import {
  AgentIndexEvidenceConflictError,
  AgentIndexReporterRetryableError,
} from './agentIndexReporter.mjs';

const IDENTITY_FIELDS = ['networkId', 'bindingId', 'executionId', 'allocationId', 'childId'];
const PHASES = new Set(['cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit']);
const STATES = new Set(['submitting', 'submitted', 'confirmed', 'failed', 'unknown', 'blocked']);
const DELIVERY_STATES = new Set(['pending', 'leased', 'delivered', 'dead', 'conflict']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Base evidence contains an unsupported value');
  return encoded;
}

function exactIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('complete Base evidence identity is required');
  }
  const keys = Object.keys(value);
  if (keys.length !== IDENTITY_FIELDS.length
      || keys.some((field) => !IDENTITY_FIELDS.includes(field))) {
    throw new Error('complete five-field Base evidence identity is required');
  }
  const identity = Object.fromEntries(IDENTITY_FIELDS.map((field) => {
    if (typeof value[field] !== 'string' || !value[field]) {
      throw new Error(`identity.${field} is required`);
    }
    return [field, value[field]];
  }));
  const marker = ':exec:';
  const split = identity.executionId.indexOf(marker);
  if (split <= 0 || identity.executionId.slice(split + marker.length) !== identity.allocationId) {
    throw new Error('executionId must match allocationId');
  }
  return identity;
}

function identityValues(identity) {
  return [
    identity.networkId, identity.bindingId, identity.executionId,
    identity.allocationId, identity.childId,
  ];
}

function rejectSensitive(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('Base evidence contains a cycle');
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['secret', 'private', 'sessionkey', 'serializedapproval', 'capability', 'bearer',
      'leasetoken', 'authorization', 'wallet', 'passkey', 'diagnostic', 'endpoint',
      'rawerror', 'receipt'].some((term) => normalized.includes(term))) {
      throw new Error(`sensitive Base evidence property rejected at ${path}.${key}`);
    }
    rejectSensitive(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function validateCheckpoint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Base evidence checkpoint must be an object');
  }
  const allowed = new Set(['identity', 'phase', 'status', 'evidence', 'observedAt']);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new Error('Base evidence checkpoint contains an unexpected field');
  }
  const identity = exactIdentity(input.identity);
  if (!PHASES.has(input.phase) || !STATES.has(input.status)) {
    throw new Error('Base evidence phase/state is invalid');
  }
  if (!input.evidence || typeof input.evidence !== 'object' || Array.isArray(input.evidence)) {
    throw new Error('Base evidence payload must be an object');
  }
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
    throw new Error('Base evidence observedAt must be a non-negative safe integer');
  }
  rejectSensitive(input);
  canonicalJson(input);
  return { ...input, identity };
}

function rowRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    identity: {
      networkId: row.network_id,
      bindingId: row.binding_id,
      executionId: row.execution_id,
      allocationId: row.allocation_id,
      childId: row.child_id,
    },
    expectedRecoveryVersion: row.expected_recovery_version,
    resultingRecoveryVersion: row.resulting_recovery_version,
    phase: row.phase,
    state: row.state,
    report: JSON.parse(row.report_json),
    deliveryStatus: row.delivery_status,
    attempts: row.attempts,
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function allowedTransition(latestPhase, latestState, phase, state) {
  if (!latestPhase) return true;
  if (phase !== latestPhase) {
    const order = ['cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit'];
    return order.indexOf(phase) === order.indexOf(latestPhase) + 1
      && latestState === 'confirmed';
  }
  const transitions = {
    submitting: new Set(['submitted', 'failed', 'unknown']),
    submitted: new Set(['confirmed', 'failed', 'unknown']),
    unknown: new Set(['confirmed']),
  };
  return transitions[latestState]?.has(state) === true;
}

export function createBaseEvidenceOutbox(db, {
  maxAttempts = 5,
  now = () => Date.now(),
  leaseToken = randomUUID,
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('Base evidence maxAttempts must be positive');
  }

  function seed(identityInput, recoveryVersion = 0, { jobId = null } = {}) {
    const identity = exactIdentity(identityInput);
    if (!Number.isSafeInteger(recoveryVersion) || recoveryVersion < 0) {
      throw new Error('starting recovery version is invalid');
    }
    const at = now();
    const existing = db.prepare(`
      SELECT * FROM base_evidence_heads
      WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?
    `).get(...identityValues(identity));
    if (existing) {
      if (existing.next_recovery_version !== recoveryVersion || existing.job_id !== jobId) {
        throw new Error('immutable Base evidence head conflict');
      }
      return { duplicate: true, recoveryVersion: existing.next_recovery_version };
    }
    db.prepare(`
      INSERT INTO base_evidence_heads
        (network_id,binding_id,execution_id,allocation_id,child_id,job_id,
         next_recovery_version,latest_phase,latest_state,updated_at)
      VALUES (?,?,?,?,?,?,?,NULL,NULL,?)
    `).run(...identityValues(identity), jobId, recoveryVersion, at);
    return { duplicate: false, recoveryVersion };
  }

  function enqueue(input, { transaction = true } = {}) {
    const checkpoint = validateCheckpoint(input);
    const values = identityValues(checkpoint.identity);
    if (transaction) db.exec('BEGIN IMMEDIATE');
    try {
      const head = db.prepare(`
        SELECT * FROM base_evidence_heads
        WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?
      `).get(...values);
      if (!head) throw new Error('Base evidence identity has not been seeded');
      const semantic = db.prepare(`
        SELECT * FROM base_evidence_outbox
        WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?
          AND phase=? AND state=? ORDER BY expected_recovery_version DESC LIMIT 1
      `).get(...values, checkpoint.phase, checkpoint.status);
      if (semantic) {
        const original = rowRecord(semantic);
        const originalCheckpoint = {
          identity: original.identity,
          phase: original.phase,
          status: original.state,
          evidence: original.report.event.evidence,
          observedAt: original.report.event.observedAt,
        };
        if (canonicalJson(originalCheckpoint) !== canonicalJson(checkpoint)) {
          throw new Error('immutable Base evidence checkpoint conflict');
        }
        if (transaction) db.exec('COMMIT');
        return { ...original, duplicate: true };
      }
      if (!allowedTransition(head.latest_phase, head.latest_state, checkpoint.phase, checkpoint.status)) {
        throw new Error('Base evidence phase/state transition is out of order');
      }
      if (head.latest_phase === checkpoint.phase && head.latest_state === 'unknown'
          && checkpoint.status === 'confirmed') {
        const previous = db.prepare(`
          SELECT report_json FROM base_evidence_outbox
          WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?
          ORDER BY expected_recovery_version DESC LIMIT 1
        `).get(...values);
        const known = previous ? JSON.parse(previous.report_json).event.evidence : {};
        const immutableKnown = [
          'chainId', 'yieldRouterAddress', 'caller', 'poolAddress', 'assets', 'minShares',
          'userOpHash', 'transactionHash',
        ];
        if (immutableKnown.some((field) => (
          known[field] !== undefined && known[field] !== null
            && checkpoint.evidence[field] !== known[field]
        ))) {
          throw new Error('unknown reconciliation conflicts with known hash or intent evidence');
        }
      }
      const expectedRecoveryVersion = head.next_recovery_version;
      const eventId = createHash('sha256').update(canonicalJson([
        checkpoint.identity, expectedRecoveryVersion, checkpoint.phase, checkpoint.status,
      ])).digest('hex');
      const evidenceDigest = createHash('sha256')
        .update(canonicalJson(checkpoint.evidence)).digest('hex');
      const report = {
        schemaVersion: 1,
        identity: checkpoint.identity,
        expectedRecoveryVersion,
        event: {
          eventId,
          phase: checkpoint.phase,
          state: checkpoint.status,
          evidence: checkpoint.evidence,
          observedAt: checkpoint.observedAt,
        },
      };
      const reportJson = canonicalJson(report);
      const at = now();
      const info = db.prepare(`
        INSERT INTO base_evidence_outbox
          (event_id,network_id,binding_id,execution_id,allocation_id,child_id,
           expected_recovery_version,resulting_recovery_version,phase,state,evidence_digest,
           report_json,delivery_status,attempts,available_at,lease_token,lease_expires_at,
           last_error_code,created_at,updated_at,delivered_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,NULL,NULL,NULL,?,?,NULL)
      `).run(
        eventId, ...values, expectedRecoveryVersion, expectedRecoveryVersion + 1,
        checkpoint.phase, checkpoint.status, evidenceDigest, reportJson, at, at, at,
      );
      const changed = db.prepare(`
        UPDATE base_evidence_heads SET next_recovery_version=?,latest_phase=?,latest_state=?,updated_at=?
        WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?
          AND next_recovery_version=?
      `).run(
        expectedRecoveryVersion + 1, checkpoint.phase, checkpoint.status, at,
        ...values, expectedRecoveryVersion,
      );
      if (changed.changes !== 1) throw new Error('Base evidence recovery head CAS conflict');
      const row = db.prepare('SELECT * FROM base_evidence_outbox WHERE id=?').get(info.lastInsertRowid);
      if (transaction) db.exec('COMMIT');
      return { ...rowRecord(row), duplicate: false };
    } catch (error) {
      if (transaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  function leaseNext({ now: at = now(), leaseMs = 30_000 } = {}) {
    const token = leaseToken();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE base_evidence_outbox SET delivery_status='dead',lease_token=NULL,
          lease_expires_at=NULL,last_error_code='attempt_limit',updated_at=?
        WHERE delivery_status='leased' AND lease_expires_at<=? AND attempts>=?
      `).run(at, at, maxAttempts);
      const row = db.prepare(`
        UPDATE base_evidence_outbox SET delivery_status='leased',attempts=attempts+1,
          lease_token=?,lease_expires_at=?,updated_at=?
        WHERE id=(
          SELECT candidate.id FROM base_evidence_outbox candidate
          WHERE ((candidate.delivery_status='pending' AND candidate.available_at<=?)
             OR (candidate.delivery_status='leased' AND candidate.lease_expires_at<=?))
            AND candidate.attempts<?
            AND NOT EXISTS (
              SELECT 1 FROM base_evidence_outbox prior
              WHERE prior.network_id=candidate.network_id AND prior.binding_id=candidate.binding_id
                AND prior.execution_id=candidate.execution_id AND prior.allocation_id=candidate.allocation_id
                AND prior.child_id=candidate.child_id
                AND prior.expected_recovery_version<candidate.expected_recovery_version
                AND prior.delivery_status<>'delivered'
            )
          ORDER BY candidate.created_at,candidate.id LIMIT 1
        ) RETURNING *
      `).get(token, at + leaseMs, at, at, at, maxAttempts);
      db.exec('COMMIT');
      return rowRecord(row);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function transition({ id, leaseToken: token, status, at, retryAt = null, reasonCode = null }) {
    if (!DELIVERY_STATES.has(status)) throw new Error('invalid Base evidence delivery status');
    const result = db.prepare(`
      UPDATE base_evidence_outbox SET delivery_status=?,available_at=COALESCE(?,available_at),
        lease_token=NULL,lease_expires_at=NULL,last_error_code=?,updated_at=?,
        delivered_at=CASE WHEN ?='delivered' THEN ? ELSE delivered_at END
      WHERE id=? AND delivery_status='leased' AND lease_token=?
    `).run(status, retryAt, reasonCode, at, status, at, id, token);
    if (result.changes !== 1) throw new Error('Base evidence lease is stale or uncertain');
    return rowRecord(db.prepare('SELECT * FROM base_evidence_outbox WHERE id=?').get(id));
  }

  function markDelivered({ id, leaseToken: token, now: at = now() }) {
    return transition({ id, leaseToken: token, status: 'delivered', at });
  }
  function markRetry({ id, leaseToken: token, now: at = now(), retryAt = at, reasonCode = 'temporary_failure' }) {
    const row = db.prepare(`SELECT attempts FROM base_evidence_outbox
      WHERE id=? AND delivery_status='leased' AND lease_token=?`).get(id, token);
    if (!row) throw new Error('Base evidence lease is stale or uncertain');
    return transition({
      id, leaseToken: token, status: row.attempts >= maxAttempts ? 'dead' : 'pending',
      at, retryAt: row.attempts >= maxAttempts ? null : retryAt, reasonCode,
    });
  }
  function markDead({ id, leaseToken: token, now: at = now(), reasonCode = 'permanent_failure' }) {
    return transition({ id, leaseToken: token, status: 'dead', at, reasonCode });
  }
  function markConflict({ id, leaseToken: token, now: at = now(), block }) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = transition({
        id, leaseToken: token, status: 'conflict', at, reasonCode: 'immutable_conflict',
      });
      block?.(result);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function status(identityInput) {
    const identity = exactIdentity(identityInput);
    const values = identityValues(identity);
    const head = db.prepare(`SELECT * FROM base_evidence_heads
      WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?`)
      .get(...values);
    if (!head) return { complete: false, blocked: false, recoveryVersion: null, events: [] };
    const rows = db.prepare(`SELECT expected_recovery_version,resulting_recovery_version,phase,state,
      delivery_status,attempts FROM base_evidence_outbox
      WHERE network_id=? AND binding_id=? AND execution_id=? AND allocation_id=? AND child_id=?
      ORDER BY expected_recovery_version`).all(...values);
    const blocked = rows.some((row) => row.delivery_status === 'conflict');
    const terminal = ['confirmed', 'failed'].includes(head.latest_state);
    const complete = !blocked && terminal && rows.length > 0
      && rows.every((row) => row.delivery_status === 'delivered');
    return {
      complete,
      blocked,
      recoveryVersion: head.next_recovery_version,
      latestPhase: head.latest_phase,
      latestState: head.latest_state,
      events: rows.map((row) => ({
        allocationId: identity.allocationId,
        executionId: identity.executionId,
        phase: row.phase,
        state: row.state,
        expectedRecoveryVersion: row.expected_recovery_version,
        resultingRecoveryVersion: row.resulting_recovery_version,
        deliveryStatus: row.delivery_status,
        attempts: row.attempts,
      })),
    };
  }

  return Object.freeze({
    seed, enqueue, leaseNext, markDelivered, markRetry, markDead, markConflict, status,
  });
}

export function startBaseEvidenceOutboxWorker({
  outbox,
  reporter,
  onConflict = null,
  intervalMs = 1_000,
  leaseMs = 30_000,
  batchSize = 20,
  now = () => Date.now(),
  autoStart = true,
} = {}) {
  if (!outbox || !reporter?.reportBaseEvidence) {
    throw new Error('Base evidence outbox worker is not configured');
  }
  let draining = false;
  let stopped = false;
  async function drain() {
    if (draining || stopped) return 0;
    draining = true;
    let handled = 0;
    try {
      while (handled < batchSize) {
        const leased = outbox.leaseNext({ now: now(), leaseMs });
        if (!leased) break;
        try {
          await reporter.reportBaseEvidence(leased.report);
          try {
            outbox.markDelivered({ id: leased.id, leaseToken: leased.leaseToken, now: now() });
          } catch {
            // D1 may already have committed. Preserve the leased immutable report for redelivery.
          }
        } catch (error) {
          try {
            if (error instanceof AgentIndexEvidenceConflictError) {
              outbox.markConflict({
                id: leased.id,
                leaseToken: leased.leaseToken,
                now: now(),
                block: () => onConflict?.(leased),
              });
            } else if (error instanceof AgentIndexReporterRetryableError) {
              const delay = Math.min(60_000, 1_000 * (2 ** Math.max(0, leased.attempts - 1)));
              outbox.markRetry({
                id: leased.id, leaseToken: leased.leaseToken, now: now(),
                retryAt: now() + delay, reasonCode: 'temporary_failure',
              });
            } else {
              outbox.markDead({
                id: leased.id, leaseToken: leased.leaseToken, now: now(),
                reasonCode: 'permanent_failure',
              });
            }
          } catch {
            // A foreign/stale lease owns the next durable transition.
          }
        }
        handled += 1;
      }
      return handled;
    } finally {
      draining = false;
    }
  }
  const timer = setInterval(() => { void drain().catch(() => {}); }, intervalMs);
  timer.unref?.();
  if (autoStart) void drain().catch(() => {});
  return Object.freeze({ drain, stop() { stopped = true; clearInterval(timer); } });
}
