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
const digests = {
  burn: 'a'.repeat(64), expectation: 'b'.repeat(64), message: 'c'.repeat(64),
  attestation: 'd'.repeat(64), mint: `0x${'e'.repeat(64)}`,
  userOp: `0x${'f'.repeat(64)}`, transaction: `0x${'1'.repeat(64)}`,
};
const confirmedEvent = {
  address: base.yieldRouterAddress, topic0: `0x${'2'.repeat(64)}`, logIndex: '1',
  caller: base.caller, poolAddress: base.poolAddress, assets: base.assets, shares: '912345',
};
const supportedEvidence = [
  ['cctp_burn:confirmed', 'cctp_burn', 'confirmed', {
    burnTxHash: digests.burn, expectationDigest: digests.expectation, burnUnits7: '10000000',
  }],
  ['cctp_burn:unknown', 'cctp_burn', 'unknown', {
    burnTxHash: digests.burn, expectationDigest: digests.expectation,
    burnUnits7: '10000000', reasonCode: 'burn_unresolved',
  }],
  ['cctp_attestation:confirmed', 'cctp_attestation', 'confirmed', {
    burnTxHash: digests.burn, expectationDigest: digests.expectation,
    messageDigest: digests.message, attestationDigest: digests.attestation, evidenceVersion: '1',
  }],
  ['cctp_mint:submitted', 'cctp_mint', 'submitted', {
    burnTxHash: digests.burn, expectationDigest: digests.expectation,
    messageDigest: digests.message, attestationDigest: digests.attestation,
    evidenceVersion: '1', mintTxHash: digests.mint,
  }],
  ['cctp_mint:confirmed', 'cctp_mint', 'confirmed', {
    burnTxHash: digests.burn, expectationDigest: digests.expectation,
    messageDigest: digests.message, attestationDigest: digests.attestation,
    evidenceVersion: '1', mintTxHash: digests.mint,
  }],
  ['base_deposit:submitting', 'base_deposit', 'submitting', { ...base }],
  ['base_deposit:submitted', 'base_deposit', 'submitted', {
    ...base, userOpHash: digests.userOp,
  }],
  ['base_deposit:confirmed', 'base_deposit', 'confirmed', {
    ...base, userOpHash: digests.userOp, transactionHash: digests.transaction,
    event: confirmedEvent,
  }],
  ...['failed', 'unknown', 'blocked'].map((state) => [
    `base_deposit:${state}`, 'base_deposit', state,
    {
      ...base, userOpHash: null, transactionHash: null,
      reasonCode: state === 'blocked' ? 'mandate_held_after_mint' : 'pre_submit_validation',
    },
  ]),
];
const directCheckpoint = (phase, status, evidence) => ({
  identity, phase, status, evidence: structuredClone(evidence), observedAt: 2_000_000_000_000,
});
const durableSnapshot = ({ db }) => ({
  heads: db.prepare('SELECT * FROM base_evidence_heads ORDER BY network_id,binding_id,execution_id,allocation_id,child_id').all(),
  events: db.prepare('SELECT * FROM base_evidence_outbox ORDER BY id').all(),
});

describe('SQLite Base evidence outbox', () => {
  it.each(supportedEvidence)(
    'accepts the exact local %s evidence contract before durable insertion',
    (_label, phase, status, evidence) => {
      const stores = createSqliteStores(freshPath(), { now: () => 1000 });
      stores.baseEvidenceOutbox.seed(identity, 0);
      expect(stores.baseEvidenceOutbox.enqueue(directCheckpoint(phase, status, evidence)))
        .toMatchObject({ phase, state: status, expectedRecoveryVersion: 0 });
      expect(stores.baseEvidenceOutbox.status(identity)).toMatchObject({ recoveryVersion: 1 });
    },
  );

  it.each([
    ['missing mandatory field', 'cctp_burn', 'confirmed', supportedEvidence[0][3], (evidence) => {
      delete evidence.expectationDigest;
    }],
    ['arbitrary field', 'cctp_burn', 'confirmed', supportedEvidence[0][3], (evidence) => {
      evidence.internal = 'not-allowlisted';
    }],
    ['cross-state field', 'base_deposit', 'submitting', supportedEvidence[5][3], (evidence) => {
      evidence.transactionHash = digests.transaction;
    }],
    ['uppercase address', 'base_deposit', 'submitting', supportedEvidence[5][3], (evidence) => {
      evidence.caller = `0x${'AA'.repeat(20)}`;
    }],
    ['short address', 'base_deposit', 'submitting', supportedEvidence[5][3], (evidence) => {
      evidence.poolAddress = '0x1234';
    }],
    ['noncanonical EVM hash', 'base_deposit', 'submitted', supportedEvidence[6][3], (evidence) => {
      evidence.userOpHash = 'f'.repeat(64);
    }],
    ['uppercase EVM hash', 'base_deposit', 'submitted', supportedEvidence[6][3], (evidence) => {
      evidence.userOpHash = `0x${'AA'.repeat(32)}`;
    }],
    ['prefixed CCTP digest', 'cctp_burn', 'confirmed', supportedEvidence[0][3], (evidence) => {
      evidence.burnTxHash = `0x${digests.burn}`;
    }],
    ['uppercase CCTP digest', 'cctp_burn', 'confirmed', supportedEvidence[0][3], (evidence) => {
      evidence.expectationDigest = 'A'.repeat(64);
    }],
    ['numeric quantity', 'cctp_burn', 'confirmed', supportedEvidence[0][3], (evidence) => {
      evidence.burnUnits7 = 10000000;
    }],
    ['leading-zero quantity', 'base_deposit', 'submitting', supportedEvidence[5][3], (evidence) => {
      evidence.assets = '01000000';
    }],
    ['negative quantity', 'base_deposit', 'submitting', supportedEvidence[5][3], (evidence) => {
      evidence.minShares = '-1';
    }],
    ['missing deposit event field', 'base_deposit', 'confirmed', supportedEvidence[7][3], (evidence) => {
      delete evidence.event.shares;
    }],
    ['extra deposit event field', 'base_deposit', 'confirmed', supportedEvidence[7][3], (evidence) => {
      evidence.event.raw = 'not-allowlisted';
    }],
    ['noncanonical event hash', 'base_deposit', 'confirmed', supportedEvidence[7][3], (evidence) => {
      evidence.event.topic0 = '2'.repeat(64);
    }],
  ])(
    'rejects %s before any local head or event mutation',
    (_label, phase, status, fixture, mutate) => {
      const stores = createSqliteStores(freshPath(), { now: () => 1000 });
      stores.baseEvidenceOutbox.seed(identity, 7);
      const before = durableSnapshot(stores);
      const evidence = structuredClone(fixture);
      mutate(evidence);
      expect(() => stores.baseEvidenceOutbox.enqueue(directCheckpoint(phase, status, evidence)))
        .toThrow(/evidence|field|required|address|hash|digest|decimal|canonical|allowlist/i);
      expect(durableSnapshot(stores)).toEqual(before);
    },
  );

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

  it('grants exactly one durable submission owner across two SQLite connections', () => {
    const path = freshPath();
    const first = createSqliteStores(path, {
      now: () => 1000,
      leaseToken: () => 'owner-first',
    });
    const second = createSqliteStores(path, {
      now: () => 1000,
      leaseToken: () => 'owner-second',
    });
    first.baseEvidenceOutbox.seed(identity, 0);
    first.baseEvidenceOutbox.enqueue(directCheckpoint('cctp_mint', 'confirmed', supportedEvidence[4][3]));

    const submitting = checkpoint('submitting');
    const winners = [
      first.baseEvidenceOutbox.claimSubmission(submitting),
      second.baseEvidenceOutbox.claimSubmission(submitting),
    ];

    expect(winners).toEqual([
      expect.objectContaining({ claimed: true, ownerToken: 'owner-first' }),
      { claimed: false, ownerToken: null },
    ]);
    expect(() => second.baseEvidenceOutbox.enqueueOwned(
      checkpoint('submitted', { userOpHash: digests.userOp }),
      { ownerToken: 'owner-second' },
    )).toThrow(/owner|claim/i);
    expect(first.baseEvidenceOutbox.enqueueOwned(
      checkpoint('submitted', { userOpHash: digests.userOp }),
      { ownerToken: 'owner-first' },
    )).toMatchObject({ state: 'submitted' });
    expect(first.baseEvidenceOutbox.recoveryState(identity)).toMatchObject({
      phase: 'base_deposit', state: 'submitted',
    });
    second.db.close();
    first.db.close();
  });

  it('holds a staggered duplicate submitting claim without changing the winner timestamp or token', () => {
    const path = freshPath();
    const first = createSqliteStores(path, {
      now: () => 1000, leaseToken: () => 'owner-first',
    });
    const second = createSqliteStores(path, {
      now: () => 2000, leaseToken: () => 'owner-second',
    });
    first.baseEvidenceOutbox.seed(identity, 0);
    first.baseEvidenceOutbox.enqueue(directCheckpoint('cctp_mint', 'confirmed', supportedEvidence[4][3]));

    const winnerCheckpoint = { ...checkpoint('submitting'), observedAt: 1000 };
    const winner = first.baseEvidenceOutbox.claimSubmission(winnerCheckpoint);
    const contender = second.baseEvidenceOutbox.claimSubmission({
      ...checkpoint('submitting'), observedAt: 2000,
    });

    expect(winner).toMatchObject({ claimed: true, ownerToken: 'owner-first' });
    expect(contender).toEqual({ claimed: false, ownerToken: null });
    expect(second.baseEvidenceOutbox.recoveryState(identity)).toMatchObject({
      phase: 'base_deposit', state: 'submitting',
    });
    const durable = second.db.prepare(`SELECT report_json FROM base_evidence_outbox
      WHERE phase='base_deposit' AND state='submitting'`).get();
    expect(JSON.parse(durable.report_json).event.observedAt).toBe(winnerCheckpoint.observedAt);
    expect(() => second.baseEvidenceOutbox.enqueueOwned(
      checkpoint('submitted', { userOpHash: digests.userOp }),
      { ownerToken: 'owner-second' },
    )).toThrow(/stale|owner|claim/i);
    second.db.close();
    first.db.close();
  });

  it('exposes the exact latest durable checkpoint only through the internal recovery seam', () => {
    const { baseEvidenceOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    baseEvidenceOutbox.seed(identity, 0);
    baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    baseEvidenceOutbox.enqueue(checkpoint('submitted', { userOpHash: digests.userOp }));

    expect(baseEvidenceOutbox.recoveryState(identity)).toEqual({
      identity,
      recoveryVersion: 2,
      phase: 'base_deposit',
      state: 'submitted',
      evidence: { ...base, userOpHash: digests.userOp },
    });
    expect(JSON.stringify(baseEvidenceOutbox.status(identity))).not.toContain(digests.userOp);
  });

  it('makes exact replay a no-op across observation time and rejects changed immutable evidence', () => {
    const { baseEvidenceOutbox } = createSqliteStores(freshPath(), { now: () => 1000 });
    baseEvidenceOutbox.seed(identity, 0);
    const first = baseEvidenceOutbox.enqueue(checkpoint('submitting'));
    expect(baseEvidenceOutbox.enqueue(checkpoint('submitting'))).toEqual({ ...first, duplicate: true });
    expect(baseEvidenceOutbox.enqueue(checkpoint('submitting', {}, 2_000_000_000_001)))
      .toEqual({ ...first, duplicate: true });
    expect(() => baseEvidenceOutbox.enqueue(checkpoint('submitting', { assets: '1000001' })))
      .toThrow(/conflict|immutable/i);
    expect(baseEvidenceOutbox.status(identity).recoveryVersion).toBe(1);
  });

  it('converges staggered exact confirmation replay while preserving the first observation time', () => {
    const path = freshPath();
    const first = createSqliteStores(path, { now: () => 1000 });
    const second = createSqliteStores(path, { now: () => 2000 });
    first.baseEvidenceOutbox.seed(identity, 0);
    first.baseEvidenceOutbox.enqueue(directCheckpoint('cctp_mint', 'confirmed', supportedEvidence[4][3]));
    first.baseEvidenceOutbox.enqueue({ ...checkpoint('submitting'), observedAt: 1000 });
    first.baseEvidenceOutbox.enqueue({
      ...checkpoint('submitted', { userOpHash: digests.userOp }), observedAt: 1001,
    });
    const confirmed = checkpoint('confirmed', {
      userOpHash: digests.userOp,
      transactionHash: digests.transaction,
      event: confirmedEvent,
    });

    const winner = first.baseEvidenceOutbox.enqueue({ ...confirmed, observedAt: 1002 });
    const replay = second.baseEvidenceOutbox.enqueue({ ...confirmed, observedAt: 2002 });

    expect(winner.duplicate).toBe(false);
    expect(replay).toMatchObject({ duplicate: true, state: 'confirmed' });
    const rows = second.db.prepare(`SELECT report_json FROM base_evidence_outbox
      WHERE phase='base_deposit' AND state='confirmed'`).all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].report_json).event.observedAt).toBe(1002);
    second.db.close();
    first.db.close();
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
      identity: unresolvedIdentity, phase: 'cctp_burn', status: 'unknown', observedAt: 2004,
      evidence: {
        burnTxHash: digests.burn, expectationDigest: digests.expectation,
        burnUnits7: '10000000', reasonCode: 'burn_unresolved',
      },
    });
    expect(() => baseEvidenceOutbox.enqueue({
      identity: unresolvedIdentity, phase: 'cctp_attestation', status: 'confirmed', observedAt: 2005,
      evidence: {
        burnTxHash: digests.burn, expectationDigest: digests.expectation,
        messageDigest: digests.message, attestationDigest: digests.attestation,
        evidenceVersion: '1',
      },
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
