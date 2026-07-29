import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStores } from '../src/sqliteStores.mjs';
import { startAssociationOutboxWorker } from '../src/associationOutbox.mjs';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'vf-outbox-')), 'relayer.db');
const identity = {
  networkId: 'stellar-testnet',
  owner: `G${'A'.repeat(55)}`,
  bindingId: 'binding-42',
  allocationId: 'run-42:bridge:aave-v3',
  childId: 'job-42',
};
const lifecycle = (sequence, executionStatus = 'accepted') => ({
  identity,
  expectedSequence: sequence - 1,
  lifecycle: {
    sequence,
    status: executionStatus === 'deposited' ? 'confirmed' : executionStatus === 'failed' ? 'failed' : 'submitted',
    evidence: { executionStatus, txHash: sequence > 1 ? `0xtx${sequence}` : null },
    observedAt: 2_000_000_000_000 + sequence,
  },
});

describe('SQLite association lifecycle outbox', () => {
  // Defect caught: process-local report tails lost accepted/minted/deposited evidence on restart.
  it('persists immutable lifecycle reports and resumes them after reopening the same DB', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const inserted = first.associationOutbox.enqueue(lifecycle(1));
    expect(inserted).toMatchObject({ duplicate: false, status: 'pending', attempts: 0 });
    first.db.close();

    const second = createSqliteStores(path);
    const leased = second.associationOutbox.leaseNext({ now: 2_000_000_000_100, leaseMs: 1000 });
    expect(leased).toMatchObject({ report: lifecycle(1), status: 'leased', attempts: 1 });
  });

  // Defect caught: retrying an identity with changed lifecycle evidence could overwrite the report chosen for delivery.
  it('makes exact duplicates idempotent and conflicting identity/sequence evidence fail closed', () => {
    const { associationOutbox } = createSqliteStores(freshPath());
    expect(associationOutbox.enqueue(lifecycle(1)).duplicate).toBe(false);
    expect(associationOutbox.enqueue(lifecycle(1))).toMatchObject({ duplicate: true, status: 'pending' });
    expect(() => associationOutbox.enqueue({
      ...lifecycle(1),
      lifecycle: { ...lifecycle(1).lifecycle, evidence: { executionStatus: 'accepted', txHash: 'changed' } },
    })).toThrow(/conflict|immutable/i);
  });

  // Defect caught: lifecycle rows could be enqueued with gaps or regressions that D1 CAS can never accept.
  it('rejects out-of-order lifecycle sequences before durable enqueue', () => {
    const { associationOutbox } = createSqliteStores(freshPath());
    associationOutbox.enqueue(lifecycle(1));
    expect(() => associationOutbox.enqueue(lifecycle(3, 'deposited'))).toThrow(/sequence|order/i);
    expect(() => associationOutbox.enqueue(lifecycle(0))).toThrow(/sequence|order/i);
    expect(associationOutbox.enqueue(lifecycle(2, 'minted'))).toMatchObject({ status: 'pending' });
  });

  // Defect caught: two workers could concurrently deliver the same row under unrelated leases.
  it('leases a row to only one concurrent store instance until the bounded lease expires', () => {
    const path = freshPath();
    const first = createSqliteStores(path, { now: () => 1000 });
    const second = createSqliteStores(path, { now: () => 1000 });
    first.associationOutbox.enqueue(lifecycle(1));
    const leaseA = first.associationOutbox.leaseNext({ now: 1000, leaseMs: 100 });
    const leaseB = second.associationOutbox.leaseNext({ now: 1000, leaseMs: 100 });
    expect(leaseA).toMatchObject({ status: 'leased', attempts: 1 });
    expect(leaseB).toBeNull();
    expect(second.associationOutbox.leaseNext({ now: 1100, leaseMs: 100 })).toMatchObject({
      id: leaseA.id,
      attempts: 2,
    });
  });

  // Defect caught: reporter non-2xx responses were discarded instead of retained for bounded retry.
  it('retains failures, retries finitely, and dead-letters after the configured attempt bound', () => {
    const { associationOutbox } = createSqliteStores(freshPath(), {
      now: () => 1000,
      outboxMaxAttempts: 2,
    });
    associationOutbox.enqueue(lifecycle(1));
    const first = associationOutbox.leaseNext({ now: 1000, leaseMs: 100 });
    expect(associationOutbox.markRetry({
      id: first.id, leaseToken: first.leaseToken, error: 'HTTP 503', now: 1001, retryAt: 1002,
    })).toMatchObject({ status: 'pending', attempts: 1 });
    const second = associationOutbox.leaseNext({ now: 1002, leaseMs: 100 });
    expect(associationOutbox.markRetry({
      id: second.id, leaseToken: second.leaseToken, error: 'HTTP 503', now: 1003, retryAt: 1004,
    })).toMatchObject({ status: 'dead', attempts: 2 });
    expect(associationOutbox.leaseNext({ now: 9999, leaseMs: 100 })).toBeNull();
    expect(associationOutbox.status('job-42')).toEqual([
      { sequence: 1, status: 'dead', attempts: 2 },
    ]);
  });

  // Defect caught: worker delivery used to consume a failed HTTP report as though it were analytics.
  it('keeps a reporter non-success durable and visible for retry', async () => {
    const { associationOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    associationOutbox.enqueue(lifecycle(1));
    const worker = startAssociationOutboxWorker({
      outbox: associationOutbox,
      reporter: { reportLifecycle: vi.fn(async () => { throw new Error('HTTP 503'); }) },
      intervalMs: 60_000,
      now: () => 1000,
    });
    await vi.waitFor(() => expect(associationOutbox.status('job-42')).toEqual([
      { sequence: 1, status: 'pending', attempts: 1 },
    ]));
    worker.stop();
  });

  // Defect caught: a stale or foreign lease token could falsely mark uncertain delivery as complete.
  it('requires the exact active lease token for delivered, retry, or dead transitions', () => {
    const { associationOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    associationOutbox.enqueue(lifecycle(1));
    const lease = associationOutbox.leaseNext({ now: 1000, leaseMs: 100 });
    expect(() => associationOutbox.markDelivered({ id: lease.id, leaseToken: 'foreign', now: 1001 }))
      .toThrow(/lease/i);
    expect(associationOutbox.markDelivered({ id: lease.id, leaseToken: lease.leaseToken, now: 1001 }))
      .toMatchObject({ status: 'delivered', attempts: 1 });
  });
});
