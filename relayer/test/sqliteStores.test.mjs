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

  it('mandates: set() honors an explicit expiresAt, instead of the flat ttlMs default', () => {
    let t = 1_000;
    const { mandates } = createSqliteStores(freshPath(), { ttlMs: 100, now: () => t });
    mandates.set('appr', '0xkey', t + 50_000); // caller-supplied expiry far past ttlMs
    t = 1_101; // would have evicted under the default 100ms ttl
    expect(mandates.get('appr')).toBe('0xkey'); // still alive — explicit expiresAt wins
  });

  it('mandates: status() reports {valid, expiresAt} without ever returning the session key', () => {
    let t = 1_000;
    const { mandates } = createSqliteStores(freshPath(), { now: () => t });
    mandates.set('appr', '0xsecret-session-key', t + 1000);
    const status = mandates.status('appr');
    expect(status).toEqual({ valid: true, expiresAt: t + 1000 });
    expect(JSON.stringify(status)).not.toContain('0xsecret-session-key'); // explicit key-leak guard
    t += 1000; // expiresAt is inclusive
    expect(mandates.status('appr')).toEqual({ valid: false });
    expect(mandates.status('never-registered')).toEqual({ valid: false });
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

  // VF Wallet Task 7: mandates_v2 — parity with mandateStore.mjs's createMandateStoreV2 (same
  // method shapes, same key-triple, same status()/expired-vs-missing distinction). A NEW table
  // beside the legacy `mandates` table above — that one is untouched, still exercised by the
  // tests above it, and stays queryable for rollback.
  describe('mandatesV2', () => {
    const rec = (over = {}) => ({
      serializedApproval: 'approval-1',
      sessionPrivateKey: '0xsecret-session-key',
      sessionKeyAddress: '0xSessionKey',
      stellarOwner: 'GOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      kernelAddress: '0xKernelA',
      relayerOrigin: 'https://relayer.example',
      expiresAt: 2_000_000,
      status: 'active',
      bindingId: 'binding-1',
      bindingHash: 'hash-1',
      createdAt: 1_000_000,
      ...over,
    });

    it('round-trips the full record, keyed on approval+owner+kernel together', () => {
      const { mandatesV2 } = createSqliteStores(freshPath(), { now: () => 1_500_000 });
      mandatesV2.set(rec());
      expect(mandatesV2.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }))
        .toEqual(rec());
      expect(mandatesV2.size).toBe(1);
    });

    it('the same approval under a different kernel or a different owner is a distinct row', () => {
      const { mandatesV2 } = createSqliteStores(freshPath(), { now: () => 1_500_000 });
      mandatesV2.set(rec());
      expect(mandatesV2.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelB' }))
        .toBeUndefined();
      expect(mandatesV2.get({ serializedApproval: 'approval-1', stellarOwner: 'GOTHERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', kernelAddress: '0xKernelA' }))
        .toBeUndefined();
    });

    it('get() lazily evicts once expiresAt has passed', () => {
      let t = 1_500_000;
      const { mandatesV2 } = createSqliteStores(freshPath(), { now: () => t });
      mandatesV2.set(rec());
      t = 2_000_000; // expiresAt is inclusive
      expect(mandatesV2.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }))
        .toBeUndefined();
      expect(mandatesV2.size).toBe(0);
    });

    it('status() reports the canonical shape WITHOUT sessionPrivateKey', () => {
      const { mandatesV2 } = createSqliteStores(freshPath(), { now: () => 1_500_000 });
      mandatesV2.set(rec());
      const status = mandatesV2.status({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' });
      expect(status).toEqual({
        stellarOwner: rec().stellarOwner,
        kernelAddress: '0xKernelA',
        sessionKeyAddress: '0xSessionKey',
        relayerOrigin: 'https://relayer.example',
        expiresAt: 2_000_000,
        status: 'active',
        bindingId: 'binding-1',
        bindingHash: 'hash-1',
      });
      expect(JSON.stringify(status)).not.toContain('0xsecret-session-key');
    });

    it('status() distinguishes "expired" (row found, past window) from "missing" (no such triple)', () => {
      let t = 1_500_000;
      const { mandatesV2 } = createSqliteStores(freshPath(), { now: () => t });
      mandatesV2.set(rec());
      t = 2_000_000;
      expect(mandatesV2.status({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }).status)
        .toBe('expired');
      expect(mandatesV2.status({ serializedApproval: 'never-registered', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }))
        .toEqual({
          stellarOwner: null, kernelAddress: null, sessionKeyAddress: null, relayerOrigin: null,
          expiresAt: null, status: 'missing', bindingId: null, bindingHash: null,
        });
    });

    it('delete() removes the exact triple only', () => {
      const { mandatesV2 } = createSqliteStores(freshPath(), { now: () => 1_500_000 });
      mandatesV2.set(rec());
      mandatesV2.set(rec({ kernelAddress: '0xKernelB' }));
      expect(mandatesV2.delete({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' })).toBe(true);
      expect(mandatesV2.delete({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' })).toBe(false);
      expect(mandatesV2.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelB' })).toBeDefined();
      expect(mandatesV2.size).toBe(1);
    });

    it('sweep drops every expired row and returns the removed count', () => {
      let t = 1_000_000;
      const { mandatesV2 } = createSqliteStores(freshPath(), { now: () => t });
      mandatesV2.set(rec({ kernelAddress: '0xKernelA', expiresAt: 1_100_000 }));
      mandatesV2.set(rec({ kernelAddress: '0xKernelB', expiresAt: 9_000_000 }));
      t = 1_200_000;
      expect(mandatesV2.sweep()).toBe(1);
      expect(mandatesV2.size).toBe(1);
    });

    it('SURVIVES REOPEN: mandatesV2 rows persist across a new createSqliteStores on the same file', () => {
      const path = freshPath();
      const first = createSqliteStores(path, { now: () => 1_500_000 });
      first.mandatesV2.set(rec());
      first.db.close();
      const second = createSqliteStores(path, { now: () => 1_500_000 });
      expect(second.mandatesV2.get({ serializedApproval: 'approval-1', stellarOwner: rec().stellarOwner, kernelAddress: '0xKernelA' }))
        .toEqual(rec());
    });
  });
});
