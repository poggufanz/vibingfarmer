// relayer/src/sqliteStores.mjs — persistent drop-ins for store.mjs / server.mjs's jobs Map /
// mandateStore.mjs, backed by node:sqlite (built-in, no native npm dep — Docker/ARM friendly).
// One DB file, three tables. Mandate rows hold session private keys: the DB file must live on a
// root-only volume (see deploy/docker-compose.yml) and rows are deleted on expiry, mirroring
// mandateStore.mjs's lazy-evict + sweep semantics so server.mjs behavior is unchanged.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAssociationOutbox } from './associationOutbox.mjs';

const HOUR_MS = 60 * 60 * 1000;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const V3_IMMUTABLE_FIELDS = [
  'approvalDigest', 'serializedApproval', 'sessionPrivateKey', 'sessionKeyAddress',
  'capabilityHash', 'stellarOwner', 'kernelAddress', 'relayerOrigin', 'validUntilSeconds',
  'bindingId', 'bindingHash', 'permissionId',
];

export const MANDATE_V3_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mandates_v3 (
    mandate_id TEXT PRIMARY KEY,
    approval_digest TEXT NOT NULL,
    serialized_approval TEXT,
    stellar_owner TEXT,
    kernel_address TEXT,
    session_key_address TEXT,
    relayer_origin TEXT,
    valid_until_seconds INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending_activation','active','activation_uncertain','revoked')),
    binding_id TEXT,
    binding_hash TEXT,
    permission_id TEXT,
    session_key_envelope TEXT,
    capability_hash TEXT,
    activation_user_op_hash TEXT,
    activation_tx_hash TEXT,
    activated_at INTEGER,
    quarantine_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mandate_activation_work (
    mandate_id TEXT PRIMARY KEY,
    stellar_owner TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','submitting','submitted','done','uncertain')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at INTEGER,
    user_op_hash TEXT,
    tx_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (mandate_id) REFERENCES mandates_v3(mandate_id)
  );
`;

export function mandateSessionAad(record) {
  return JSON.stringify([
    'vf-mandate-session-v1',
    record.mandateId,
    record.approvalDigest,
    record.stellarOwner,
    String(record.kernelAddress || '').toLowerCase(),
    String(record.sessionKeyAddress || '').toLowerCase(),
    record.validUntilSeconds,
    record.bindingId,
  ]);
}

export function createSqliteStores(path, {
  ttlMs = HOUR_MS,
  now = () => Date.now(),
  nowSeconds = () => Math.floor(Date.now() / 1000),
  leaseToken = randomUUID,
  sessionKeyCipher,
  outboxMaxAttempts = 5,
} = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS relay_records (exec_id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, job TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS association_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      identity_key TEXT NOT NULL,
      child_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      report_digest TEXT NOT NULL,
      report_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','leased','delivered','dead')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER,
      UNIQUE(identity_key, sequence)
    );
    CREATE TABLE IF NOT EXISTS farm_execution_work (
      job_id TEXT PRIMARY KEY,
      burn_tx_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending','running','done','uncertain')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_token TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_association_outbox_delivery
      ON association_outbox (status, available_at, lease_expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_association_outbox_child
      ON association_outbox (child_id, sequence);
    ${MANDATE_V3_SCHEMA}
  `);

  const associationOutbox = createAssociationOutbox(db, {
    maxAttempts: outboxMaxAttempts,
    now,
  });

  const store = {
    get(execId) {
      const row = db.prepare('SELECT record FROM relay_records WHERE exec_id = ?').get(execId);
      return row ? JSON.parse(row.record) : null;
    },
    set(execId, record) {
      const rec = { ...record, updatedAt: now() };
      db.prepare('INSERT INTO relay_records (exec_id, record) VALUES (?, ?) ON CONFLICT(exec_id) DO UPDATE SET record = excluded.record')
        .run(execId, JSON.stringify(rec));
      return rec;
    },
    has(execId) {
      return !!db.prepare('SELECT 1 FROM relay_records WHERE exec_id = ?').get(execId);
    },
    all() {
      const rows = db.prepare('SELECT exec_id, record FROM relay_records').all();
      return Object.fromEntries(rows.map((r) => [r.exec_id, JSON.parse(r.record)]));
    },
  };

  const jobs = {
    get(jobId) {
      const row = db.prepare('SELECT job FROM jobs WHERE job_id = ?').get(jobId);
      return row ? JSON.parse(row.job) : undefined;
    },
    set(jobId, job) {
      db.prepare('INSERT INTO jobs (job_id, job) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET job = excluded.job')
        .run(jobId, JSON.stringify(job));
    },
  };

  function writeJob(jobId, job) {
    db.prepare('INSERT INTO jobs (job_id, job) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET job = excluded.job')
      .run(jobId, JSON.stringify(job));
  }

  function workRecord(row) {
    if (!row) return null;
    return {
      jobId: row.job_id,
      burnTxHash: row.burn_tx_hash,
      status: row.status,
      attempts: row.attempts,
      leaseToken: row.lease_token ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
    };
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function checkedWork(jobId, status, token) {
    const row = db.prepare('SELECT * FROM farm_execution_work WHERE job_id = ?').get(jobId);
    if (!row || row.status !== status || (token != null && row.lease_token !== token)) {
      throw new Error('farm execution lease is stale or uncertain');
    }
    return row;
  }

  const farmExecutions = {
    get(jobId) {
      return workRecord(db.prepare('SELECT * FROM farm_execution_work WHERE job_id = ?').get(jobId));
    },
    attach({ jobId, burnTxHash, job, reports }) {
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM farm_execution_work WHERE job_id = ?').get(jobId);
        if (existing) {
          if (existing.burn_tx_hash !== burnTxHash) {
            throw new Error('farm execution already has a different burn hash');
          }
          return { duplicate: true, work: workRecord(existing) };
        }
        const burnOwner = db.prepare('SELECT job_id FROM farm_execution_work WHERE burn_tx_hash = ?').get(burnTxHash);
        if (burnOwner && burnOwner.job_id !== jobId) {
          throw new Error('burn hash is already attached to another farm execution');
        }
        if (!db.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get(jobId)) {
          throw new Error('farm execution job is missing');
        }
        associationOutbox.enqueue(reports, { transaction: false });
        writeJob(jobId, job);
        const timestamp = now();
        db.prepare(`
          INSERT INTO farm_execution_work
            (job_id, burn_tx_hash, status, attempts, lease_token, lease_expires_at, created_at, updated_at)
          VALUES (?, ?, 'pending', 0, NULL, NULL, ?, ?)
        `).run(jobId, burnTxHash, timestamp, timestamp);
        return {
          duplicate: false,
          work: workRecord(db.prepare('SELECT * FROM farm_execution_work WHERE job_id = ?').get(jobId)),
        };
      });
    },
    claim({ jobId, now: claimNow = now(), leaseMs = 30_000 }) {
      if (!Number.isSafeInteger(claimNow) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new Error('farm execution lease requires safe integer time and positive duration');
      }
      const token = randomUUID();
      return workRecord(db.prepare(`
        UPDATE farm_execution_work
        SET status = 'running', attempts = attempts + 1, lease_token = ?,
            lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND status = 'pending'
        RETURNING *
      `).get(token, claimNow + leaseMs, claimNow, jobId));
    },
    renew({ jobId, leaseToken, now: renewNow = now(), leaseMs = 30_000 }) {
      if (!jobId || !leaseToken) {
        throw new Error('farm execution renewal requires jobId and leaseToken');
      }
      if (!Number.isSafeInteger(renewNow) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new Error('farm execution lease requires safe integer time and positive duration');
      }
      const result = db.prepare(`
        UPDATE farm_execution_work
        SET lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running' AND lease_token = ?
      `).run(renewNow + leaseMs, renewNow, jobId, leaseToken);
      if (result.changes !== 1) {
        throw new Error('farm execution lease is stale or uncertain');
      }
      return this.get(jobId);
    },
    listRecoverable({ now: recoveryNow = now() } = {}) {
      return db.prepare(`
        SELECT * FROM farm_execution_work
        WHERE status = 'pending'
           OR (status = 'running' AND lease_expires_at <= ?)
        ORDER BY created_at ASC, job_id ASC
      `).all(recoveryNow).map(workRecord);
    },
    checkpoint({ jobId, leaseToken, job, reports = [], now: checkpointNow = now() }) {
      return transaction(() => {
        checkedWork(jobId, 'running', leaseToken);
        if (reports.length > 0) associationOutbox.enqueue(reports, { transaction: false });
        writeJob(jobId, job);
        db.prepare('UPDATE farm_execution_work SET updated_at = ? WHERE job_id = ?')
          .run(checkpointNow, jobId);
        return this.get(jobId);
      });
    },
    finish({ jobId, leaseToken, job, reports = [], status = 'done', now: finishNow = now() }) {
      if (!['done', 'uncertain'].includes(status)) throw new Error('invalid farm execution terminal status');
      return transaction(() => {
        checkedWork(jobId, 'running', leaseToken);
        if (reports.length > 0) associationOutbox.enqueue(reports, { transaction: false });
        writeJob(jobId, job);
        db.prepare(`
          UPDATE farm_execution_work
          SET status = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ?
        `).run(status, finishNow, jobId);
        return this.get(jobId);
      });
    },
    reconcileUncertain({ jobId, job, reports = [], now: reconcileNow = now() }) {
      return transaction(() => {
        const row = checkedWork(jobId, 'running');
        if (row.lease_expires_at == null || row.lease_expires_at > reconcileNow) {
          throw new Error('farm execution lease has not expired');
        }
        if (reports.length > 0) associationOutbox.enqueue(reports, { transaction: false });
        writeJob(jobId, job);
        db.prepare(`
          UPDATE farm_execution_work
          SET status = 'uncertain', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ?
        `).run(reconcileNow, jobId);
        return this.get(jobId);
      });
    },
  };

  function requireSessionKeyCipher() {
    if (typeof sessionKeyCipher?.seal !== 'function' || typeof sessionKeyCipher?.open !== 'function') {
      throw new Error('session key cipher is required for mandate persistence');
    }
    return sessionKeyCipher;
  }

  function normalizeMandate(record) {
    if (!record || typeof record.mandateId !== 'string' || !record.mandateId) {
      throw new Error('mandate ID is required');
    }
    if (typeof record.capabilityHash !== 'string' || !record.capabilityHash) {
      throw new Error('capability hash is required');
    }
    if (!Number.isSafeInteger(record.validUntilSeconds) || record.validUntilSeconds <= 0) {
      throw new Error('mandate expiry is invalid');
    }
    if (typeof record.sessionPrivateKey !== 'string' || !record.sessionPrivateKey
      || typeof record.sessionKeyAddress !== 'string' || !record.sessionKeyAddress
      || typeof record.stellarOwner !== 'string' || !record.stellarOwner
      || typeof record.kernelAddress !== 'string' || !record.kernelAddress) {
      throw new Error('mandate identity or session authority is invalid');
    }
    return {
      ...record,
      kernelAddress: record.kernelAddress.toLowerCase(),
      sessionKeyAddress: record.sessionKeyAddress.toLowerCase(),
      status: 'pending_activation',
    };
  }

  function mandateRow(mandateId) {
    return db.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?').get(mandateId);
  }

  function identityRow({ mandateId, stellarOwner, kernelAddress }) {
    return db.prepare(`
      SELECT * FROM mandates_v3
      WHERE mandate_id = ? AND stellar_owner = ? AND kernel_address = ?
    `).get(mandateId, stellarOwner, String(kernelAddress || '').toLowerCase());
  }

  function rowAad(row) {
    return mandateSessionAad({
      mandateId: row.mandate_id,
      approvalDigest: row.approval_digest,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      sessionKeyAddress: row.session_key_address,
      validUntilSeconds: row.valid_until_seconds,
      bindingId: row.binding_id,
    });
  }

  function publicMandate(row, status = row?.status) {
    if (!row) return { status: 'missing' };
    return {
      mandateId: row.mandate_id,
      approvalDigest: row.approval_digest,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      sessionKeyAddress: row.session_key_address ?? null,
      relayerOrigin: row.relayer_origin ?? null,
      validUntilSeconds: row.valid_until_seconds ?? null,
      status,
      bindingId: row.binding_id ?? null,
      bindingHash: row.binding_hash ?? null,
      permissionId: row.permission_id ?? null,
      activationUserOpHash: row.activation_user_op_hash ?? null,
      activationTxHash: row.activation_tx_hash ?? null,
      activatedAt: row.activated_at ?? null,
      quarantineReason: row.quarantine_reason ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function internalMandate(row, { allowSession = true } = {}) {
    if (!row) return null;
    const result = {
      mandateId: row.mandate_id,
      approvalDigest: row.approval_digest,
      serializedApproval: row.serialized_approval ?? undefined,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      sessionKeyAddress: row.session_key_address ?? null,
      relayerOrigin: row.relayer_origin ?? null,
      validUntilSeconds: row.valid_until_seconds ?? null,
      status: row.status,
      bindingId: row.binding_id ?? null,
      bindingHash: row.binding_hash ?? null,
      permissionId: row.permission_id ?? null,
      activationUserOpHash: row.activation_user_op_hash ?? null,
      activationTxHash: row.activation_tx_hash ?? null,
      activatedAt: row.activated_at ?? null,
      quarantineReason: row.quarantine_reason ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (allowSession && row.session_key_envelope) {
      const cipher = requireSessionKeyCipher();
      const opened = cipher.open(row.session_key_envelope, rowAad(row));
      Object.defineProperty(result, 'sessionPrivateKey', {
        value: opened.plaintext,
        enumerable: false,
      });
      if (opened.needsRotation) {
        const replacement = cipher.seal(opened.plaintext, rowAad(row));
        db.prepare(`
          UPDATE mandates_v3 SET session_key_envelope = ?, updated_at = ? WHERE mandate_id = ?
        `).run(replacement, nowSeconds(), row.mandate_id);
      }
    }
    if (row.capability_hash) {
      Object.defineProperty(result, 'capabilityHash', {
        value: row.capability_hash,
        enumerable: false,
      });
    }
    return result;
  }

  function activationWork(row) {
    if (!row) return null;
    return {
      mandateId: row.mandate_id,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      status: row.status,
      attempts: row.attempts,
      leaseToken: row.lease_token ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
      userOpHash: row.user_op_hash ?? null,
      txHash: row.tx_hash ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function activationRow(identity) {
    if (!identityRow(identity)) return null;
    return db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
      .get(identity.mandateId);
  }

  function safeNow(value) {
    const result = value ?? nowSeconds();
    if (!Number.isSafeInteger(result)) throw new Error('activation time is invalid');
    return result;
  }

  function assertLive(row, at) {
    if (!Number.isSafeInteger(row.valid_until_seconds) || at >= row.valid_until_seconds) {
      throw new Error('mandate expiry has been reached');
    }
  }

  function assertLease(row, token, at) {
    if (!row?.lease_token || row.lease_token !== token) throw new Error('stale activation lease token');
    if (!Number.isSafeInteger(row.lease_expires_at) || at >= row.lease_expires_at) {
      throw new Error('activation lease has expired');
    }
  }

  function conflict(existingRow, incoming) {
    const existing = {
      approvalDigest: existingRow.approval_digest,
      serializedApproval: existingRow.serialized_approval,
      sessionPrivateKey: internalMandate(existingRow).sessionPrivateKey,
      sessionKeyAddress: existingRow.session_key_address,
      capabilityHash: existingRow.capability_hash,
      stellarOwner: existingRow.stellar_owner,
      kernelAddress: existingRow.kernel_address,
      relayerOrigin: existingRow.relayer_origin,
      validUntilSeconds: existingRow.valid_until_seconds,
      bindingId: existingRow.binding_id,
      bindingHash: existingRow.binding_hash,
      permissionId: existingRow.permission_id,
    };
    return V3_IMMUTABLE_FIELDS.some((field) => existing[field] !== incoming[field]);
  }

  let leaseCounter = 0;
  const mandatesV3 = {
    get(identity) {
      const row = identityRow(identity);
      if (!row) return null;
      const expired = Number.isSafeInteger(row.valid_until_seconds)
        && nowSeconds() >= row.valid_until_seconds;
      if (expired && row.session_key_envelope) {
        db.prepare('UPDATE mandates_v3 SET session_key_envelope = NULL, updated_at = ? WHERE mandate_id = ?')
          .run(nowSeconds(), row.mandate_id);
        row.session_key_envelope = null;
      }
      return internalMandate(row, { allowSession: !expired && row.status !== 'revoked' });
    },
    status(identity) {
      const row = identityRow(identity);
      if (!row) return { status: 'missing' };
      const status = Number.isSafeInteger(row.valid_until_seconds)
        && nowSeconds() >= row.valid_until_seconds ? 'expired' : row.status;
      return publicMandate(row, status);
    },
    revoke(identity) {
      return transaction(() => {
        const row = identityRow(identity);
        if (!row) return null;
        const at = safeNow();
        db.prepare(`
          UPDATE mandates_v3
          SET status = 'revoked', session_key_envelope = NULL, updated_at = ?
          WHERE mandate_id = ?
        `).run(at, row.mandate_id);
        db.prepare('DELETE FROM mandate_activation_work WHERE mandate_id = ?').run(row.mandate_id);
        return publicMandate(mandateRow(row.mandate_id));
      });
    },
    get size() {
      return db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n;
    },
  };

  const mandateActivations = {
    enqueue({ record }) {
      const incoming = normalizeMandate(record);
      const existing = mandateRow(incoming.mandateId);
      if (existing) {
        if (conflict(existing, incoming)) throw new Error('immutable mandate conflict');
        return {
          duplicate: true,
          mandate: publicMandate(existing),
          work: activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(incoming.mandateId)),
        };
      }
      const at = safeNow();
      if (at >= incoming.validUntilSeconds) throw new Error('mandate expiry has been reached');
      const envelope = requireSessionKeyCipher().seal(incoming.sessionPrivateKey, mandateSessionAad(incoming));
      return transaction(() => {
        db.prepare(`
          INSERT INTO mandates_v3 (
            mandate_id, approval_digest, serialized_approval, stellar_owner, kernel_address,
            session_key_address, relayer_origin, valid_until_seconds, status, binding_id,
            binding_hash, permission_id, session_key_envelope, capability_hash,
            activation_user_op_hash, activation_tx_hash, activated_at, quarantine_reason,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_activation', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          incoming.mandateId, incoming.approvalDigest, incoming.serializedApproval,
          incoming.stellarOwner, incoming.kernelAddress, incoming.sessionKeyAddress,
          incoming.relayerOrigin ?? null, incoming.validUntilSeconds, incoming.bindingId ?? null,
          incoming.bindingHash ?? null, incoming.permissionId ?? null, envelope,
          incoming.capabilityHash, at, at,
        );
        db.prepare(`
          INSERT INTO mandate_activation_work (
            mandate_id, stellar_owner, kernel_address, status, attempts, lease_token,
            lease_expires_at, user_op_hash, tx_hash, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)
        `).run(incoming.mandateId, incoming.stellarOwner, incoming.kernelAddress, at, at);
        return {
          duplicate: false,
          mandate: publicMandate(mandateRow(incoming.mandateId)),
          work: activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(incoming.mandateId)),
        };
      });
    },
    get(identity) {
      return activationWork(activationRow(identity));
    },
    claim({ nowSeconds: atValue, leaseSeconds = 30, ...identity }) {
      const mandate = identityRow(identity);
      if (!mandate) return null;
      const at = safeNow(atValue);
      assertLive(mandate, at);
      if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
        throw new Error('activation lease duration is invalid');
      }
      leaseCounter += 1;
      const token = `${leaseToken()}-${leaseCounter}`;
      const row = db.prepare(`
        UPDATE mandate_activation_work
        SET status = 'running', attempts = attempts + 1, lease_token = ?,
            lease_expires_at = ?, updated_at = ?
        WHERE mandate_id = ? AND status = 'pending'
        RETURNING *
      `).get(token, at + leaseSeconds, at, mandate.mandate_id);
      return activationWork(row);
    },
    checkpoint({ leaseToken: token, status, userOpHash, nowSeconds: atValue, ...identity }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        const work = activationRow(identity);
        if (!mandate || !work) throw new Error('activation work is missing');
        const at = safeNow(atValue);
        assertLive(mandate, at);
        assertLease(work, token, at);
        if (status === 'submitting') {
          if (work.status !== 'running') throw new Error('invalid activation transition');
        } else if (status === 'submitted') {
          if (work.status !== 'submitting') throw new Error('invalid activation transition to submitted');
          if (!HASH_RE.test(userOpHash || '')) throw new Error('submitted user operation hash is invalid');
        } else {
          throw new Error('invalid activation checkpoint state');
        }
        db.prepare(`
          UPDATE mandate_activation_work
          SET status = ?, user_op_hash = CASE WHEN ? = 'submitted' THEN ? ELSE user_op_hash END,
              updated_at = ? WHERE mandate_id = ?
        `).run(status, status, userOpHash ?? null, at, mandate.mandate_id);
        return activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
          .get(mandate.mandate_id));
      });
    },
    finishActive({
      leaseToken: token, userOpHash, txHash, activatedAt, nowSeconds: atValue, ...identity
    }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        const work = activationRow(identity);
        if (!mandate || !work) throw new Error('stale or terminal activation lease');
        const at = safeNow(atValue);
        assertLive(mandate, at);
        assertLease(work, token, at);
        if (work.status !== 'submitted') throw new Error('activation must be submitted before finish');
        if (!HASH_RE.test(userOpHash || '') || userOpHash !== work.user_op_hash) {
          throw new Error('submitted user operation hash disagreement');
        }
        if (!HASH_RE.test(txHash || '')) throw new Error('activation transaction hash is not canonical');
        if (!Number.isSafeInteger(activatedAt) || activatedAt <= 0) {
          throw new Error('activation time is invalid');
        }
        db.prepare(`
          UPDATE mandates_v3
          SET status = 'active', activation_user_op_hash = ?, activation_tx_hash = ?,
              activated_at = ?, updated_at = ? WHERE mandate_id = ?
        `).run(userOpHash, txHash, activatedAt, at, mandate.mandate_id);
        db.prepare(`
          UPDATE mandate_activation_work
          SET status = 'done', tx_hash = ?, lease_token = NULL, lease_expires_at = NULL,
              updated_at = ? WHERE mandate_id = ?
        `).run(txHash, at, mandate.mandate_id);
        return {
          mandate: publicMandate(mandateRow(mandate.mandate_id)),
          work: activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(mandate.mandate_id)),
        };
      });
    },
    finishUncertain({ leaseToken: token, nowSeconds: atValue, ...identity }) {
      return transaction(() => {
        const mandate = identityRow(identity);
        const work = activationRow(identity);
        if (!mandate || !work) throw new Error('stale or terminal activation lease');
        const at = safeNow(atValue);
        assertLive(mandate, at);
        assertLease(work, token, at);
        if (work.status !== 'submitting' && work.status !== 'submitted') {
          throw new Error('activation must cross the submitting or submitted fence');
        }
        db.prepare(`UPDATE mandates_v3 SET status = 'activation_uncertain', updated_at = ? WHERE mandate_id = ?`)
          .run(at, mandate.mandate_id);
        db.prepare(`
          UPDATE mandate_activation_work
          SET status = 'uncertain', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE mandate_id = ?
        `).run(at, mandate.mandate_id);
        return {
          mandate: publicMandate(mandateRow(mandate.mandate_id)),
          work: activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(mandate.mandate_id)),
        };
      });
    },
    listRecoverable({ nowSeconds: atValue } = {}) {
      const at = safeNow(atValue);
      return db.prepare(`
        SELECT * FROM mandate_activation_work
        WHERE status = 'pending' OR (status = 'running' AND lease_expires_at <= ?)
        ORDER BY created_at, mandate_id
      `).all(at).map(activationWork);
    },
    reconcileExpired({ nowSeconds: atValue } = {}) {
      const at = safeNow(atValue);
      return transaction(() => {
        const rows = db.prepare(`
          SELECT * FROM mandate_activation_work
          WHERE status IN ('running','submitting','submitted') AND lease_expires_at <= ?
          ORDER BY created_at, mandate_id
        `).all(at);
        const result = [];
        for (const row of rows) {
          const next = row.status === 'running' ? 'pending' : 'uncertain';
          db.prepare(`
            UPDATE mandate_activation_work
            SET status = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE mandate_id = ?
          `).run(next, at, row.mandate_id);
          if (next === 'uncertain') {
            db.prepare(`
              UPDATE mandates_v3 SET status = 'activation_uncertain', updated_at = ?
              WHERE mandate_id = ?
            `).run(at, row.mandate_id);
          }
          result.push(activationWork(db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
            .get(row.mandate_id)));
        }
        return result;
      });
    },
  };

  function legacyMandateTables() {
    return db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('mandates','mandates_v2')
      ORDER BY name
    `).all().map(({ name }) => name);
  }

  function probe() {
    return transaction(() => {
      db.prepare('UPDATE jobs SET job = job WHERE 0').run();
      db.prepare('SELECT id FROM association_outbox WHERE 0').all();
      db.prepare('SELECT job_id FROM farm_execution_work WHERE 0').all();
      db.prepare('SELECT mandate_id FROM mandates_v3 WHERE 0').all();
      db.prepare('SELECT mandate_id FROM mandate_activation_work WHERE 0').all();
      return { writable: true, legacyMandateTables: legacyMandateTables() };
    });
  }

  const legacyFailClosed = Object.freeze({
    set() { throw new Error('legacy plaintext mandate store is disabled'); },
    get() { return undefined; },
    status() { return { status: 'missing', valid: false }; },
    delete() { return false; },
    sweep() { return 0; },
    size: 0,
  });

  return {
    db,
    store,
    jobs,
    mandates: legacyFailClosed,
    mandatesV2: legacyFailClosed,
    mandatesV3,
    mandateActivations,
    associationOutbox,
    farmExecutions,
    probe,
  };
}
