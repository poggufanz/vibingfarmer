import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSqliteStores } from '../src/sqliteStores.mjs';
import { startBaseEvidenceOutboxWorker } from '../src/baseEvidenceOutbox.mjs';
import { AgentIndexEvidenceConflictError } from '../src/agentIndexReporter.mjs';
import { AgentIndexReporterRetryableError } from '../src/agentIndexReporter.mjs';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'vf-evidence-')), 'relayer.db');
const identity = {
  networkId: 'stellar-testnet', bindingId: 'binding-42',
  executionId: 'run-42:exec:run-42:bridge:aave-v3',
  allocationId: 'run-42:bridge:aave-v3', childId: 'child-42',
};
const base = {
  chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
  caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
  assets: '1000000', minShares: '900000',
};
const checkpoint = (status, extra = {}, observedAt = 2_000_000_000_000) => ({
  identity, phase: 'base_deposit', status, evidence: { ...base, ...extra }, observedAt,
});

describe('SQLite Base evidence outbox', () => {
  it('persists full-identity recovery versions and deterministic event IDs across reopen', () => {
    const path = freshPath();
    const first = createSqliteStores(path, { now: () => 1000 });
    first.baseEvidenceOutbox.seed(identity, 0);
    const submitting = first.baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    const submitted = first.baseEvidenceOutbox.enqueue(checkpoint('submitted', {
      userOpHash: `0x${'a'.repeat(64)}`,
    }, 2_000_000_000_001));
    expect([submitting.expectedRecoveryVersion, submitted.expectedRecoveryVersion]).toEqual([0, 1]);
    expect([submitting.resultingRecoveryVersion, submitted.resultingRecoveryVersion]).toEqual([1, 2]);
    expect(submitting.eventId).toMatch(/^[0-9a-f]{64}$/);
    first.db.close();

    const second = createSqliteStores(path, { now: () => 2000 });
    expect(second.baseEvidenceOutbox.status(identity)).toMatchObject({
      complete: false, blocked: false, recoveryVersion: 2,
      events: [
        { state: 'submitting', expectedRecoveryVersion: 0, deliveryStatus: 'pending' },
        { state: 'submitted', expectedRecoveryVersion: 1, deliveryStatus: 'pending' },
      ],
    });
  });

  it('makes exact replay a no-op and rejects changed evidence at the same semantic checkpoint', () => {
    const { baseEvidenceOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    baseEvidenceOutbox.seed(identity, 0);
    const first = baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    expect(baseEvidenceOutbox.enqueue(checkpoint('submitting'))).toEqual({ ...first, duplicate: true });
    expect(() => baseEvidenceOutbox.enqueue(checkpoint('submitting', {}, 2_000_000_000_001)))
      .toThrow(/conflict|immutable/i);
    expect(() => baseEvidenceOutbox.enqueue(checkpoint('submitting', { assets: '1000001' })))
      .toThrow(/conflict|immutable/i);
    expect(baseEvidenceOutbox.status(identity).recoveryVersion).toBe(1);
  });

  it('leases strictly in version order per full identity while another identity proceeds', () => {
    const path = freshPath();
    const first = createSqliteStores(path, { now: () => 1000 });
    const second = createSqliteStores(path, { now: () => 1000 });
    first.baseEvidenceOutbox.seed(identity, 0);
    first.baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    first.baseEvidenceOutbox.enqueue(checkpoint('submitted', { userOpHash: `0x${'a'.repeat(64)}` }, 2001));
    const leased = first.baseEvidenceOutbox.leaseNext({ now: 1000, leaseMs: 100 });
    expect(leased.expectedRecoveryVersion).toBe(0);
    expect(second.baseEvidenceOutbox.leaseNext({ now: 1000, leaseMs: 100 })).toBeNull();
    first.baseEvidenceOutbox.markDelivered({ id: leased.id, leaseToken: leased.leaseToken, now: 1001 });
    expect(second.baseEvidenceOutbox.leaseNext({ now: 1001, leaseMs: 100 }).expectedRecoveryVersion).toBe(1);
  });

  it('marks a D1 409 conflict durably and invokes the owning-job block transition once', async () => {
    const stores = createSqliteStores(freshPath(), { now: () => 1000 });
    const { baseEvidenceOutbox } = stores;
    stores.jobs.set('job-42', { status: 'done', steps: [] });
    baseEvidenceOutbox.seed(identity, 0, { jobId: 'job-42' });
    baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    const onConflict = vi.fn((leased) => stores.farmExecutions.blockEvidenceConflict(
      { identity: leased.identity, now: 1000 }, { transaction: false },
    ));
    const worker = startBaseEvidenceOutboxWorker({
      outbox: baseEvidenceOutbox,
      reporter: { reportBaseEvidence: vi.fn(async () => { throw new AgentIndexEvidenceConflictError('conflict'); }) },
      onConflict,
      autoStart: false,
      now: () => 1000,
    });
    await expect(worker.drain()).resolves.toBe(1);
    expect(baseEvidenceOutbox.status(identity)).toMatchObject({ blocked: true, complete: false });
    expect(onConflict).toHaveBeenCalledOnce();
    expect(stores.jobs.get('job-42')).toMatchObject({ status: 'blocked', evidenceConflict: true });
    worker.stop();
  });

  it('rejects bare child status and never exposes evidence bodies, hashes, leases, or diagnostics', () => {
    const { baseEvidenceOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    baseEvidenceOutbox.seed(identity, 0);
    baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    baseEvidenceOutbox.enqueue(checkpoint('submitted', { userOpHash: `0x${'a'.repeat(64)}` }));
    expect(() => baseEvidenceOutbox.status(identity.childId)).toThrow(/identity/i);
    const serialized = JSON.stringify(baseEvidenceOutbox.status(identity));
    expect(serialized).not.toContain('userOpHash');
    expect(serialized).not.toContain('lease');
    expect(serialized).not.toContain('report');
  });

  it('isolates colliding child/allocation IDs by every identity component', () => {
    const { baseEvidenceOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    const identities = [
      identity,
      { ...identity, networkId: 'stellar-mainnet' },
      { ...identity, bindingId: 'binding-other' },
      { ...identity, executionId: `run-other:exec:${identity.allocationId}` },
      {
        ...identity, allocationId: 'run-42:bridge:blend-v2',
        executionId: 'run-42:exec:run-42:bridge:blend-v2',
      },
      { ...identity, childId: 'child-other' },
    ];
    identities.forEach((candidate, index) => {
      baseEvidenceOutbox.seed(candidate, index);
      baseEvidenceOutbox.enqueue({ ...checkpoint('submitting'), identity: candidate });
    });
    identities.forEach((candidate, index) => {
      expect(baseEvidenceOutbox.status(candidate)).toMatchObject({ recoveryVersion: index + 1 });
      expect(baseEvidenceOutbox.status(candidate).events).toHaveLength(1);
    });
  });

  it('allows unknown reconciliation only when every previously known hash and intent fact agrees', () => {
    const { baseEvidenceOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    const userOpHash = `0x${'a'.repeat(64)}`;
    const transactionHash = `0x${'b'.repeat(64)}`;
    baseEvidenceOutbox.seed(identity, 0);
    baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    baseEvidenceOutbox.enqueue(checkpoint('submitted', { userOpHash }, 2001));
    baseEvidenceOutbox.enqueue(checkpoint('unknown', {
      userOpHash, transactionHash, reasonCode: 'deposit_event_missing',
    }, 2002));
    expect(() => baseEvidenceOutbox.enqueue(checkpoint('confirmed', {
      userOpHash: `0x${'c'.repeat(64)}`, transactionHash,
      event: {
        address: base.yieldRouterAddress, topic0: `0x${'d'.repeat(64)}`, logIndex: '1',
        caller: base.caller, poolAddress: base.poolAddress, assets: base.assets, shares: '912345',
      },
    }, 2003))).toThrow(/hash|reconcil|conflict/i);
    expect(baseEvidenceOutbox.enqueue(checkpoint('confirmed', {
      userOpHash, transactionHash,
      event: {
        address: base.yieldRouterAddress, topic0: `0x${'d'.repeat(64)}`, logIndex: '1',
        caller: base.caller, poolAddress: base.poolAddress, assets: base.assets, shares: '912345',
      },
    }, 2003))).toMatchObject({ expectedRecoveryVersion: 3, state: 'confirmed' });

    const unresolvedIdentity = {
      ...identity,
      executionId: 'run-unresolved:exec:run-unresolved:bridge:aave-v3',
      allocationId: 'run-unresolved:bridge:aave-v3',
    };
    baseEvidenceOutbox.seed(unresolvedIdentity, 0);
    baseEvidenceOutbox.enqueue({
      ...checkpoint('unknown', { burnTxHash: 'burn', reasonCode: 'burn_unresolved' }, 2004),
      identity: unresolvedIdentity, phase: 'cctp_burn',
    });
    expect(() => baseEvidenceOutbox.enqueue({
      ...checkpoint('confirmed', { messageDigest: 'message' }, 2005),
      identity: unresolvedIdentity, phase: 'cctp_attestation',
    })).toThrow(/transition|order/i);
  });

  it('uses bounded backoff, survives reopen, and dead-letters without a sixth lease', async () => {
    const path = freshPath();
    const first = createSqliteStores(path, { now: () => 1000, outboxMaxAttempts: 2 });
    first.baseEvidenceOutbox.seed(identity, 0);
    first.baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    const worker = startBaseEvidenceOutboxWorker({
      outbox: first.baseEvidenceOutbox,
      reporter: { reportBaseEvidence: vi.fn(async () => { throw new AgentIndexReporterRetryableError('down'); }) },
      autoStart: false, now: () => 1000,
    });
    await worker.drain();
    expect(first.baseEvidenceOutbox.status(identity).events[0]).toMatchObject({
      deliveryStatus: 'pending', attempts: 1,
    });
    worker.stop();
    first.db.close();

    const second = createSqliteStores(path, { now: () => 2000, outboxMaxAttempts: 2 });
    const retryWorker = startBaseEvidenceOutboxWorker({
      outbox: second.baseEvidenceOutbox,
      reporter: { reportBaseEvidence: vi.fn(async () => { throw new AgentIndexReporterRetryableError('down'); }) },
      autoStart: false, now: () => 2000,
    });
    await retryWorker.drain();
    expect(second.baseEvidenceOutbox.status(identity).events[0]).toMatchObject({
      deliveryStatus: 'dead', attempts: 2,
    });
    expect(second.baseEvidenceOutbox.leaseNext({ now: 9999, leaseMs: 10 })).toBeNull();
    retryWorker.stop();
  });

  it('requires the exact active lease token and reports complete only after terminal delivery', () => {
    const { baseEvidenceOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    baseEvidenceOutbox.seed(identity, 0);
    baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    baseEvidenceOutbox.enqueue(checkpoint('failed', {
      userOpHash: null, transactionHash: null, reasonCode: 'pre_submit_validation',
    }, 2001));
    const first = baseEvidenceOutbox.leaseNext({ now: 1000, leaseMs: 100 });
    expect(() => baseEvidenceOutbox.markDelivered({ id: first.id, leaseToken: 'foreign', now: 1001 }))
      .toThrow(/lease/i);
    baseEvidenceOutbox.markDelivered({ id: first.id, leaseToken: first.leaseToken, now: 1001 });
    expect(baseEvidenceOutbox.status(identity).complete).toBe(false);
    const terminal = baseEvidenceOutbox.leaseNext({ now: 1001, leaseMs: 100 });
    baseEvidenceOutbox.markDelivered({ id: terminal.id, leaseToken: terminal.leaseToken, now: 1002 });
    expect(baseEvidenceOutbox.status(identity)).toMatchObject({ complete: true, blocked: false });
  });

  it('never reports evidence complete before the latest delivered phase is base_deposit', () => {
    const { baseEvidenceOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    baseEvidenceOutbox.seed(identity, 0);
    baseEvidenceOutbox.enqueue({
      identity, phase: 'cctp_burn', status: 'confirmed', observedAt: 1000,
      evidence: {
        burnTxHash: 'a'.repeat(64), expectationDigest: 'b'.repeat(64), burnUnits7: '1000',
      },
    });
    const leased = baseEvidenceOutbox.leaseNext({ now: 1000, leaseMs: 100 });
    baseEvidenceOutbox.markDelivered({ id: leased.id, leaseToken: leased.leaseToken, now: 1001 });
    expect(baseEvidenceOutbox.status(identity)).toMatchObject({
      complete: false, latestPhase: 'cctp_burn', latestState: 'confirmed',
    });
  });

  it('does not let public callers forge a non-owning enqueue transaction', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 1000 });
    stores.baseEvidenceOutbox.seed(identity, 0);
    stores.db.exec('BEGIN IMMEDIATE');
    expect(() => stores.baseEvidenceOutbox.enqueue(
      checkpoint('submitting'), { transaction: false },
    )).toThrow(/transaction/i);
    stores.db.exec('ROLLBACK');
    expect(stores.baseEvidenceOutbox.status(identity)).toMatchObject({
      recoveryVersion: 0, events: [],
    });
  });
});
