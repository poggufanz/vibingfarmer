// relayer/src/sqliteStores.mjs — persistent drop-ins for store.mjs / server.mjs's jobs Map /
// mandateStore.mjs, backed by node:sqlite (built-in, no native npm dep — Docker/ARM friendly).
// One DB file, three tables. Mandate rows hold session private keys: the DB file must live on a
// root-only volume (see deploy/docker-compose.yml) and rows are deleted on expiry, mirroring
// mandateStore.mjs's lazy-evict + sweep semantics so server.mjs behavior is unchanged.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const HOUR_MS = 60 * 60 * 1000;

export function createSqliteStores(path, { ttlMs = HOUR_MS, now = () => Date.now() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_records (exec_id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, job TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mandates (approval TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);

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
    set(key, value) {
      db.prepare('INSERT INTO mandates (approval, session_key, expires_at) VALUES (?, ?, ?) ON CONFLICT(approval) DO UPDATE SET session_key = excluded.session_key, expires_at = excluded.expires_at')
        .run(key, value, now() + ttlMs);
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

  return { db, store, jobs, mandates };
}
