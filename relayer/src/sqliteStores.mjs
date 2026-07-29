// relayer/src/sqliteStores.mjs — persistent drop-ins for store.mjs / server.mjs's jobs Map /
// mandateStore.mjs, backed by node:sqlite (built-in, no native npm dep — Docker/ARM friendly).
// One DB file, three tables. Mandate rows hold session private keys: the DB file must live on a
// root-only volume (see deploy/docker-compose.yml) and rows are deleted on expiry, mirroring
// mandateStore.mjs's lazy-evict + sweep semantics so server.mjs behavior is unchanged.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createAssociationOutbox } from './associationOutbox.mjs';

const HOUR_MS = 60 * 60 * 1000;

export function createSqliteStores(path, {
  ttlMs = HOUR_MS,
  now = () => Date.now(),
  outboxMaxAttempts = 5,
} = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_records (exec_id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, job TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mandates (approval TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mandates_v2 (
      serialized_approval TEXT NOT NULL,
      stellar_owner TEXT NOT NULL,
      kernel_address TEXT NOT NULL,
      session_private_key TEXT NOT NULL,
      session_key_address TEXT NOT NULL,
      relayer_origin TEXT,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      binding_id TEXT,
      binding_hash TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (serialized_approval, stellar_owner, kernel_address)
    );
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
    CREATE INDEX IF NOT EXISTS idx_association_outbox_delivery
      ON association_outbox (status, available_at, lease_expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_association_outbox_child
      ON association_outbox (child_id, sequence);
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

  const mandates = {
    // expiresAt (ms epoch), when given, overrides the now()+ttlMs default — same contract as
    // mandateStore.mjs's set(), so httpRouter's handleMandate works unchanged against either store.
    set(key, value, expiresAt) {
      db.prepare('INSERT INTO mandates (approval, session_key, expires_at) VALUES (?, ?, ?) ON CONFLICT(approval) DO UPDATE SET session_key = excluded.session_key, expires_at = excluded.expires_at')
        .run(key, value, expiresAt ?? now() + ttlMs);
    },
    get(key) {
      const row = db.prepare('SELECT session_key, expires_at FROM mandates WHERE approval = ?').get(key);
      if (!row) return undefined;
      if (now() >= row.expires_at) {
        db.prepare('DELETE FROM mandates WHERE approval = ?').run(key);
        return undefined;
      }
      return row.session_key;
    },
    // Reuse-check lookup for GET /mandate/valid: same shape + semantics as mandateStore.mjs's
    // status() — reports validity + expiry WITHOUT ever handing back the session key.
    status(key) {
      const row = db.prepare('SELECT expires_at FROM mandates WHERE approval = ?').get(key);
      if (!row) return { valid: false };
      if (now() >= row.expires_at) {
        db.prepare('DELETE FROM mandates WHERE approval = ?').run(key);
        return { valid: false };
      }
      return { valid: true, expiresAt: row.expires_at };
    },
    delete(key) {
      return db.prepare('DELETE FROM mandates WHERE approval = ?').run(key).changes > 0;
    },
    sweep() {
      return db.prepare('DELETE FROM mandates WHERE expires_at <= ?').run(now()).changes;
    },
    get size() {
      return db.prepare('SELECT COUNT(*) AS n FROM mandates').get().n;
    },
  };

  // VF Wallet Task 7: owner/kernel-bound sibling of `mandates` above, same method shapes and
  // same status()/expired-vs-missing distinction as mandateStore.mjs's createMandateStoreV2 (JS
  // parity) — see that module for the full contract doc. `mandates` above is left completely
  // untouched: legacy rows stay queryable there for rollback, but nothing in this file's
  // consumers (httpRouter.mjs) reads from it going forward.
  function mandatesV2Row(serializedApproval, stellarOwner, kernelAddress) {
    return db.prepare(
      'SELECT * FROM mandates_v2 WHERE serialized_approval = ? AND stellar_owner = ? AND kernel_address = ?',
    ).get(serializedApproval, stellarOwner, kernelAddress);
  }
  function deleteMandateV2Row(serializedApproval, stellarOwner, kernelAddress) {
    return db.prepare(
      'DELETE FROM mandates_v2 WHERE serialized_approval = ? AND stellar_owner = ? AND kernel_address = ?',
    ).run(serializedApproval, stellarOwner, kernelAddress);
  }
  function rowToRecordV2(row) {
    return {
      serializedApproval: row.serialized_approval,
      sessionPrivateKey: row.session_private_key,
      sessionKeyAddress: row.session_key_address,
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      relayerOrigin: row.relayer_origin,
      expiresAt: row.expires_at,
      status: row.status,
      bindingId: row.binding_id,
      bindingHash: row.binding_hash,
      createdAt: row.created_at,
    };
  }
  function statusShapeV2(row, status) {
    return {
      stellarOwner: row.stellar_owner,
      kernelAddress: row.kernel_address,
      sessionKeyAddress: row.session_key_address,
      relayerOrigin: row.relayer_origin ?? null,
      expiresAt: row.expires_at,
      status,
      bindingId: row.binding_id ?? null,
      bindingHash: row.binding_hash ?? null,
    };
  }
  const MISSING_STATUS_V2 = {
    stellarOwner: null, kernelAddress: null, sessionKeyAddress: null, relayerOrigin: null,
    expiresAt: null, status: 'missing', bindingId: null, bindingHash: null,
  };

  const mandatesV2 = {
    // record is the full Step-1 shape — expiresAt an ms-epoch number, same convention as `mandates`.
    set(record) {
      const {
        serializedApproval, sessionPrivateKey, sessionKeyAddress, stellarOwner, kernelAddress,
        relayerOrigin, expiresAt, status, bindingId, bindingHash, createdAt,
      } = record;
      db.prepare(`
        INSERT INTO mandates_v2 (
          serialized_approval, stellar_owner, kernel_address, session_private_key, session_key_address,
          relayer_origin, expires_at, status, binding_id, binding_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(serialized_approval, stellar_owner, kernel_address) DO UPDATE SET
          session_private_key = excluded.session_private_key,
          session_key_address = excluded.session_key_address,
          relayer_origin = excluded.relayer_origin,
          expires_at = excluded.expires_at,
          status = excluded.status,
          binding_id = excluded.binding_id,
          binding_hash = excluded.binding_hash,
          created_at = excluded.created_at
      `).run(
        serializedApproval, stellarOwner, kernelAddress, sessionPrivateKey, sessionKeyAddress,
        relayerOrigin ?? null, expiresAt, status ?? 'active', bindingId ?? null, bindingHash ?? null,
        createdAt ?? now(),
      );
    },
    // Full record INCLUDING sessionPrivateKey — internal use only. Never expose in an HTTP response.
    get({ serializedApproval, stellarOwner, kernelAddress }) {
      const row = mandatesV2Row(serializedApproval, stellarOwner, kernelAddress);
      if (!row) return undefined;
      if (now() >= row.expires_at) {
        deleteMandateV2Row(serializedApproval, stellarOwner, kernelAddress);
        return undefined;
      }
      return rowToRecordV2(row);
    },
    // Distinguishes 'expired' (row found, past its window) from 'missing' (no such triple) —
    // same posture as mandateStore.mjs's createMandateStoreV2. Never returns sessionPrivateKey.
    status({ serializedApproval, stellarOwner, kernelAddress }) {
      const row = mandatesV2Row(serializedApproval, stellarOwner, kernelAddress);
      if (!row) return { ...MISSING_STATUS_V2 };
      if (now() >= row.expires_at) {
        deleteMandateV2Row(serializedApproval, stellarOwner, kernelAddress);
        return statusShapeV2(row, 'expired');
      }
      return statusShapeV2(row, row.status === 'revoked' ? 'revoked' : 'active');
    },
    delete({ serializedApproval, stellarOwner, kernelAddress }) {
      return deleteMandateV2Row(serializedApproval, stellarOwner, kernelAddress).changes > 0;
    },
    sweep() {
      return db.prepare('DELETE FROM mandates_v2 WHERE expires_at <= ?').run(now()).changes;
    },
    get size() {
      return db.prepare('SELECT COUNT(*) AS n FROM mandates_v2').get().n;
    },
  };

  return { db, store, jobs, mandates, mandatesV2, associationOutbox };
}
