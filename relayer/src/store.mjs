// Idempotency store: execId -> relay record. File-backed for local/dev; the shape is a plain
// JSON object so swapping to Cloudflare D1 in production is a storage-layer change only — D1
// needs the Workers runtime bindings this plain-Node relayer does not have, so the file store
// is the honest dev implementation here, not a stand-in placeholder for something unfinished.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function readAll(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeAll(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function createFileStore(path) {
  return {
    get(execId) {
      return readAll(path)[execId] ?? null;
    },
    set(execId, record) {
      const all = readAll(path);
      all[execId] = { ...record, updatedAt: Date.now() };
      writeAll(path, all);
      return all[execId];
    },
    has(execId) {
      return Object.prototype.hasOwnProperty.call(readAll(path), execId);
    },
    all() {
      return readAll(path);
    },
  };
}

/** In-memory store for tests — same interface as createFileStore, no disk I/O. */
export function createMemoryStore() {
  const data = new Map();
  return {
    get(execId) { return data.has(execId) ? data.get(execId) : null; },
    set(execId, record) { const rec = { ...record, updatedAt: Date.now() }; data.set(execId, rec); return rec; },
    has(execId) { return data.has(execId); },
    all() { return Object.fromEntries(data); },
  };
}
