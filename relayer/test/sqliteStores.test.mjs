// relayer/test/sqliteStores.test.mjs
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStores } from '../src/sqliteStores.mjs';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'vf-sqlite-')), 'relayer.db');

describe('sqliteStores', () => {
  it('idempotency store: set/get/has/all round-trip', () => {
    const { store } = createSqliteStores(freshPath());
    expect(store.get('e1')).toBeNull();
    store.set('e1', { status: 'done' });
    expect(store.has('e1')).toBe(true);
    expect(store.get('e1').status).toBe('done');
    expect(Object.keys(store.all())).toEqual(['e1']);
  });

  it('jobs: Map-like get/set with JSON payloads', () => {
    const { jobs } = createSqliteStores(freshPath());
    expect(jobs.get('j1')).toBeUndefined();
    jobs.set('j1', { status: 'pending', steps: [] });
    expect(jobs.get('j1')).toEqual({ status: 'pending', steps: [] });
    jobs.set('j1', { status: 'done', steps: [{ step: 'mint' }] });
    expect(jobs.get('j1').status).toBe('done');
  });

  it('mandates: TTL eviction + sweep, same semantics as mandateStore', () => {
    let t = 1_000;
    const { mandates } = createSqliteStores(freshPath(), { ttlMs: 100, now: () => t });
    mandates.set('appr', '0xkey');
    expect(mandates.get('appr')).toBe('0xkey');
    t = 1_101; // past TTL
    expect(mandates.get('appr')).toBeUndefined(); // lazy eviction on read
    mandates.set('a2', 'k2');
    t = 1_300;
    expect(mandates.sweep()).toBe(1);
    expect(mandates.size).toBe(0);
  });

  it('SURVIVES REOPEN: jobs + mandates persist across a new createSqliteStores on the same file', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    first.jobs.set('j1', { status: 'pending', steps: [] });
    first.mandates.set('appr', '0xkey');
    first.db.close();
    const second = createSqliteStores(path);
    expect(second.jobs.get('j1').status).toBe('pending');
    expect(second.mandates.get('appr')).toBe('0xkey');
  });
});
