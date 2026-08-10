import { createHash, randomUUID } from 'node:crypto';

const OUTBOX_STATUSES = new Set(['pending', 'leased', 'delivered', 'dead']);
const LIFECYCLE_STATUSES = new Set(['planned', 'submitted', 'confirmed', 'failed', 'unknown']);
const SAFE_FAILURE_CODES = new Set([
  'delivery_failed', 'reporter_delivery_failed', 'reporter_unavailable', 'lease_expired',
]);
const REQUEST_FIELDS = new Set(['identity', 'expectedSequence', 'lifecycle']);
const IDENTITY_FIELDS = new Set([
  'networkId', 'owner', 'bindingId', 'executionId', 'allocationId', 'childId',
]);
const RECOVERY_IDENTITY_FIELDS = new Set([
  'networkId', 'bindingId', 'executionId', 'allocationId', 'childId',
]);
const LIFECYCLE_FIELDS = new Set(['sequence', 'status', 'evidence', 'observedAt']);

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).find((field) => !fields.has(field));
  if (unexpected) throw new Error(`unexpected ${label} field: ${unexpected}`);
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required`);
  return value;
}

function safeFailureCode(value) {
  return typeof value === 'string'
    && value.length <= 64
    && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value)
    && SAFE_FAILURE_CODES.has(value)
    ? value
    : 'delivery_failed';
}

function rejectSensitive(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`circular outbox report at ${path}`);
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.includes('secret') || normalized.includes('private')
        || normalized.includes('sessionkey') || normalized.includes('serializedapproval')
        || normalized === 'mandate') {
      throw new Error(`secret/private/approval property rejected at ${path}.${key}`);
    }
    rejectSensitive(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('outbox report contains an unsupported value');
  return encoded;
}

function recoveryIdentity(identity) {
  return Object.fromEntries([...RECOVERY_IDENTITY_FIELDS].map((field) => [
    field, requireText(identity?.[field], `identity.${field}`),
  ]));
}

function validateReport(report) {
  exactObject(report, REQUEST_FIELDS, 'lifecycle request');
  exactObject(report.identity, IDENTITY_FIELDS, 'lifecycle identity');
  exactObject(report.lifecycle, LIFECYCLE_FIELDS, 'lifecycle');
  rejectSensitive(report);
  for (const field of IDENTITY_FIELDS) requireText(report.identity[field], `identity.${field}`);
  if (!Number.isSafeInteger(report.expectedSequence) || report.expectedSequence < 0) {
    throw new Error('expectedSequence must be a non-negative safe integer');
  }
  if (report.lifecycle.sequence !== report.expectedSequence + 1 || report.lifecycle.sequence < 1) {
    throw new Error('outbox lifecycle sequence must advance by one');
  }
  if (!LIFECYCLE_STATUSES.has(report.lifecycle.status)) {
    throw new Error('outbox lifecycle status is invalid');
  }
  if (!Number.isSafeInteger(report.lifecycle.observedAt)) {
    throw new Error('outbox lifecycle observedAt must be a safe integer');
  }
  if (!report.lifecycle.evidence || typeof report.lifecycle.evidence !== 'object'
      || Array.isArray(report.lifecycle.evidence)) {
    throw new Error('outbox lifecycle evidence must be an object');
  }
  return report;
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    digest: row.report_digest,
    report: JSON.parse(row.report_json),
    sequence: row.sequence,
    status: row.status,
    attempts: row.attempts,
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
  };
}

export function createAssociationOutbox(db, {
  maxAttempts = 5,
  now = () => Date.now(),
  leaseToken = randomUUID,
  registerTransactionEnqueue = null,
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('outbox maxAttempts must be a positive safe integer');
  }
  const legacyRows = db.prepare('SELECT id,identity_key,report_json FROM association_outbox').all();
  if (legacyRows.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of legacyRows) {
        const report = JSON.parse(row.report_json);
        const nextKey = canonicalJson(recoveryIdentity(report.identity));
        if (row.identity_key !== nextKey) {
          db.prepare('UPDATE association_outbox SET identity_key=? WHERE id=?').run(nextKey, row.id);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error('association outbox legacy identity migration conflict', { cause: error });
    }
  }

  function enqueueInternal(input, { transaction = true } = {}) {
    const reports = Array.isArray(input) ? input : [input];
    if (reports.length === 0) throw new Error('outbox enqueue requires a lifecycle report');
    const prepared = reports.map((report) => {
      validateReport(report);
      const reportJson = canonicalJson(report);
      const digest = createHash('sha256').update(reportJson).digest('hex');
      const identityKey = canonicalJson(recoveryIdentity(report.identity));
      const idempotencyKey = canonicalJson([
        report.identity.networkId,
        report.identity.bindingId,
        report.identity.executionId,
        report.identity.allocationId,
        report.identity.childId,
        report.lifecycle.sequence,
        digest,
      ]);
      return { report, reportJson, digest, identityKey, idempotencyKey };
    });
    const outputs = [];
    if (transaction) db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of prepared) {
        const report = item.report;
        const existing = db.prepare(
          'SELECT * FROM association_outbox WHERE identity_key = ? AND sequence = ?'
        ).get(item.identityKey, report.lifecycle.sequence);
        if (existing) {
          if (existing.report_digest !== item.digest || existing.report_json !== item.reportJson) {
            throw new Error('immutable association outbox conflict');
          }
          outputs.push({ ...rowToRecord(existing), duplicate: true });
          continue;
        }
        const latest = db.prepare(
          'SELECT MAX(sequence) AS sequence FROM association_outbox WHERE identity_key = ?'
        ).get(item.identityKey)?.sequence;
        const expected = latest == null ? 1 : Number(latest) + 1;
        if (report.lifecycle.sequence !== expected || report.expectedSequence !== expected - 1) {
          throw new Error('association outbox lifecycle sequence is out of order');
        }
        const timestamp = now();
        const info = db.prepare(`
          INSERT INTO association_outbox
            (idempotency_key, identity_key, child_id, sequence, report_digest, report_json,
             status, attempts, available_at, lease_token, lease_expires_at, last_error,
             created_at, updated_at, delivered_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL)
        `).run(
          item.idempotencyKey,
          item.identityKey,
          report.identity.childId,
          report.lifecycle.sequence,
          item.digest,
          item.reportJson,
          timestamp,
          timestamp,
          timestamp,
        );
        const row = db.prepare('SELECT * FROM association_outbox WHERE id = ?').get(info.lastInsertRowid);
        outputs.push({ ...rowToRecord(row), duplicate: false });
      }
      if (transaction) db.exec('COMMIT');
    } catch (error) {
      if (transaction) db.exec('ROLLBACK');
      throw error;
    }
    return Array.isArray(input) ? outputs : outputs[0];
  }

  function enqueue(input) {
    return enqueueInternal(input, { transaction: true });
  }

  if (registerTransactionEnqueue != null) {
    if (typeof registerTransactionEnqueue !== 'function') {
      throw new Error('association transaction registration is invalid');
    }
    registerTransactionEnqueue((input) => enqueueInternal(input, { transaction: false }));
  }

  function leaseNext({ now: leaseNow = now(), leaseMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(leaseNow) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Error('outbox lease requires safe integer time and positive duration');
    }
    const token = leaseToken();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE association_outbox
        SET status = 'dead', lease_token = NULL, lease_expires_at = NULL,
            last_error = 'delivery lease expired at attempt limit', updated_at = ?
        WHERE status = 'leased' AND lease_expires_at <= ? AND attempts >= ?
      `).run(leaseNow, leaseNow, maxAttempts);
      const row = db.prepare(`
        UPDATE association_outbox
        SET status = 'leased', attempts = attempts + 1, lease_token = ?,
            lease_expires_at = ?, updated_at = ?
        WHERE id = (
          SELECT candidate.id FROM association_outbox AS candidate
          WHERE (
            (candidate.status = 'pending' AND candidate.available_at <= ?)
            OR (candidate.status = 'leased' AND candidate.lease_expires_at <= ?)
          )
          AND candidate.attempts < ?
          AND NOT EXISTS (
            SELECT 1 FROM association_outbox AS prior
            WHERE prior.identity_key = candidate.identity_key
              AND prior.sequence < candidate.sequence
              AND prior.status <> 'delivered'
          )
          ORDER BY candidate.created_at ASC, candidate.id ASC
          LIMIT 1
        )
        RETURNING *
      `).get(token, leaseNow + leaseMs, leaseNow, leaseNow, leaseNow, maxAttempts);
      db.exec('COMMIT');
      return rowToRecord(row);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function guardedTransition({ id, leaseToken: token, status, timestamp, retryAt = null, error = null }) {
    if (!OUTBOX_STATUSES.has(status)) throw new Error('invalid outbox status');
    const result = db.prepare(`
      UPDATE association_outbox
      SET status = ?, available_at = COALESCE(?, available_at), lease_token = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?,
          delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
      WHERE id = ? AND status = 'leased' AND lease_token = ?
    `).run(status, retryAt, error, timestamp, status, timestamp, id, token);
    if (result.changes !== 1) throw new Error('association outbox lease is stale or uncertain');
    return rowToRecord(db.prepare('SELECT * FROM association_outbox WHERE id = ?').get(id));
  }

  function markDelivered({ id, leaseToken: token, now: timestamp = now() }) {
    return guardedTransition({ id, leaseToken: token, status: 'delivered', timestamp });
  }

  function markRetry({ id, leaseToken: token, error = 'delivery failed', now: timestamp = now(), retryAt = timestamp }) {
    const row = db.prepare(
      'SELECT attempts FROM association_outbox WHERE id = ? AND status = ? AND lease_token = ?'
    ).get(id, 'leased', token);
    if (!row) throw new Error('association outbox lease is stale or uncertain');
    const dead = Number(row.attempts) >= maxAttempts;
    return guardedTransition({
      id,
      leaseToken: token,
      status: dead ? 'dead' : 'pending',
      timestamp,
      retryAt: dead ? null : retryAt,
      error: safeFailureCode(error),
    });
  }

  function markDead({ id, leaseToken: token, error = 'delivery failed', now: timestamp = now() }) {
    return guardedTransition({
      id, leaseToken: token, status: 'dead', timestamp, error: safeFailureCode(error),
    });
  }

  function status(identity) {
    exactObject(identity, RECOVERY_IDENTITY_FIELDS, 'recovery identity');
    const identityKey = canonicalJson(recoveryIdentity(identity));
    return db.prepare(
      'SELECT sequence, status, attempts, report_json FROM association_outbox WHERE identity_key = ? ORDER BY sequence ASC, id ASC'
    ).all(identityKey).map((row) => ({
      allocationId: JSON.parse(row.report_json).identity.allocationId,
      executionId: JSON.parse(row.report_json).identity.executionId,
      sequence: row.sequence,
      status: row.status,
      attempts: row.attempts,
    }));
  }

  return Object.freeze({ enqueue, leaseNext, markDelivered, markRetry, markDead, status });
}

export function startAssociationOutboxWorker({
  outbox,
  reporter,
  intervalMs = 1_000,
  leaseMs = 30_000,
  batchSize = 20,
  now = () => Date.now(),
  autoStart = true,
} = {}) {
  if (!outbox || !reporter?.reportLifecycle) throw new Error('association outbox worker is not configured');
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
          await reporter.reportLifecycle(leased.report);
        } catch (error) {
          const attempt = Math.max(1, leased.attempts);
          const delay = Math.min(60_000, 1_000 * (2 ** (attempt - 1)));
          try {
            outbox.markRetry({
              id: leased.id,
              leaseToken: leased.leaseToken,
              error: 'reporter delivery failed',
              now: now(),
              retryAt: now() + delay,
            });
          } catch {
            // Lease ownership is uncertain. Leave the durable row for expiry reconciliation.
          }
          handled += 1;
          continue;
        }
        try {
          outbox.markDelivered({ id: leased.id, leaseToken: leased.leaseToken, now: now() });
        } catch {
          // The reporter may already have committed. Never turn that acknowledgement into a retry;
          // the immutable row remains leased until bounded expiry reconciliation can inspect it.
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
  return Object.freeze({
    drain,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  });
}
