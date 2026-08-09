// relayer/test/sqliteStores.test.mjs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Keypair } from '@stellar/stellar-sdk';
import { concatHex, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSecretEnvelope, parseSecretKeyring } from '../src/secretEnvelope.mjs';
import {
  createSqliteStores,
  MANDATE_V3_SCHEMA,
  mandateSessionAad,
} from '../src/sqliteStores.mjs';
import * as sqliteStoresModule from '../src/sqliteStores.mjs';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'vf-sqlite-')), 'relayer.db');

const NOW_SECONDS = 2_000_000_000;
const VALID_UNTIL_SECONDS = NOW_SECONDS + 7_200;
const MANDATE_ID = '7d8f94a2c16b4e6488bf07b81234abcd';
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const KERNEL = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const WRONG_SESSION_PRIVATE_KEY = `0x${'66'.repeat(32)}`;
const SECOND_SESSION_PRIVATE_KEY = `0x${'77'.repeat(32)}`;
const SESSION_KEY_DIGEST = 'd796cb759ab4fbd29dbe7a352e38c76d1a8838dd926b2934e2c81b37fbd2a915';
const SESSION = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const APPROVAL = 'canonical-approval-fixture';
const APPROVAL_DIGEST = createHash('sha256').update(APPROVAL).digest('hex');
const POLICY_DIGEST = 'dd'.repeat(32);
const CAPABILITY_HASH = 'aa'.repeat(32);
const PERMISSION_ID = '0x1234abcd';
const BINDING_HASH = createHash('sha256')
  .update(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL_SECONDS}`)
  .digest('hex');
const NORMALIZED_BINDING_HASH = createHash('sha256')
  .update(`${OWNER}|${KERNEL.toLowerCase()}|${SESSION.toLowerCase()}|${VALID_UNTIL_SECONDS}`)
  .digest('hex');
const OFFLINE_ENV = Object.freeze({ RELAYER_OFFLINE_KEY_MIGRATION: '1' });
const TASK4_CONFIG = Object.freeze({
  publicOrigin: 'https://relayer.example',
  base: Object.freeze({
    chain: Object.freeze({ id: 84532 }),
    mandatePolicy: Object.freeze({ parserFixture: true }),
  }),
});

function forwardIntentFixture(overrides = {}) {
  const { request: requestOverrides = {}, ...topOverrides } = overrides;
  const input = {
    jobId: '02'.repeat(16),
    observedAt: 2_000_000_123,
    request: {
      requestId: '01'.repeat(16),
      mandateId: '03'.repeat(16),
      stellarOwner: 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57',
      kernelAddress: `0x${'11'.repeat(20)}`,
      bridgeAgent: 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ',
      runId: 'run-42',
      grantTxHash: 'aa'.repeat(32),
      allocations: [{
        allocationId: 'run-42:bridge:aave-v3',
        poolAddress: '0x389250872044368759d3db5c09b2706a6628d4e0',
        amount: { token: 'USDC', units: '1000000', decimals: 6 },
        minShares: '900000',
      }],
      ...requestOverrides,
    },
    mandate: {
      bindingId: 'binding-v1',
      bindingHash: '44'.repeat(32),
      approvalDigest: '55'.repeat(32),
      policyDigest: '66'.repeat(32),
      permissionId: '0x12345678',
      validUntilSeconds: 2_000_007_200,
      relayerOrigin: 'https://relayer.example',
    },
    deployment: {
      networkId: 'stellar-testnet',
      sourceDomain: 27,
      destinationDomain: 6,
      tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
      baseTokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      stellarUsdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      poolTargets: new Map([['0x389250872044368759d3db5c09b2706a6628d4e0', 'aave-v3']]),
    },
    ...topOverrides,
  };
  return sqliteStoresModule.buildForwardFarmIntent(input);
}

function finishForwardIntent(stores, normalizedIntent = forwardIntentFixture()) {
  stores.farmIntents.createOrGetIntent({ normalizedIntent, now: 2_000_000_123 });
  const claim = stores.farmIntents.claimIntentDelivery({
    jobId: normalizedIntent.intent.jobId, now: 2_000_000_123, leaseMs: 30_000,
  });
  const children = normalizedIntent.batch.children.map((child) => ({
    identity: {
      networkId: child.networkId,
      bindingId: child.bindingId,
      executionId: child.executionId,
      allocationId: child.allocationId,
      childId: child.childId,
    },
    recoveryVersion: 7,
  }));
  const acknowledgement = {
    acknowledged: true,
    schemaVersion: 1,
    idempotencyKey: normalizedIntent.batchIdempotencyKey,
    requestDigest: normalizedIntent.batchDigest,
    children,
    written: children.length,
    duplicates: 0,
  };
  stores.farmIntents.finishAwaitingBurn({
    jobId: normalizedIntent.intent.jobId,
    leaseToken: claim.leaseToken,
    acknowledgement,
    now: 2_000_000_125,
  });
  return { normalizedIntent, acknowledgement };
}

function finishForwardIntentDepositConfirming(stores, normalizedIntent) {
  const { acknowledgement } = finishForwardIntent(stores, normalizedIntent);
  const identity = {
    mandateId: normalizedIntent.intent.mandate.mandateId,
    jobId: normalizedIntent.intent.jobId,
    bindingId: normalizedIntent.intent.mandate.bindingId,
    intentDigest: normalizedIntent.intentDigest,
  };
  stores.farmIntents.attachBurnAtomic({
    identity, burnTxHash: 'bb'.repeat(32), now: 2_000_000_200,
  });
  stores.farmIntents.projectMintEvidenceAtomic({
    identity,
    relay: {
      execId: `forward-farm:${normalizedIntent.intent.jobId}`,
      state: 'minted', burnTxHash: 'bb'.repeat(32),
      expectationDigest: normalizedIntent.expectationDigest,
      messageDigest: 'cc'.repeat(32), attestationDigest: 'dd'.repeat(32),
      evidenceVersion: '1', mintTxHash: `0x${'ee'.repeat(32)}`,
    },
    now: 2_000_000_300,
  });
  stores.farmIntents.advanceProjection({
    identity, from: 'deposit_pending', to: 'deposit_confirming', now: 2_000_000_301,
  });
  return { identity, recoveryIdentity: acknowledgement.children[0].identity };
}

describe('Task 11 forward-farm intent canonicalization', () => {
  // Defect caught: a retry could rebuild a semantically different Agent Index/CCTP intent while
  // retaining the same browser request ID, making the idempotency key authorize different work.
  it('derives the independently checked intent, expectation, and batch digests', () => {
    expect(typeof sqliteStoresModule.buildForwardFarmIntent).toBe('function');
    const result = forwardIntentFixture();

    expect(result.expectationDigest).toBe('c9ca175da9daf8b6879e7ec6f5f13f860e7fe0b4af266b92326bcd47b07303c6');
    expect(result.intentDigest).toBe('c6ee8ca0e171911440402ba173f062dac89ff1110a1477839c16b74973e29bf1');
    expect(result.batchIdempotencyKey).toBe('4f2910192a1ab9f47c21ccfc0ad89b9087a9012d1ce5a3cc7c7d734c49a1a500');
    expect(result.batch.burnUnits7).toBe('10000000');
    expect(result.intent.allocations[0]).toMatchObject({
      ordinal: 0,
      executionId: 'run-42:exec:run-42:bridge:aave-v3',
      childId: '02'.repeat(16),
    });
  });

  // Defect caught: the old jobs/farm_execution_work pair was written only after the remote call
  // and could not recover the stable request, batch timestamp, or expectation after a crash.
  it('persists one immutable intent_pending authority and returns it unchanged after reopen', () => {
    const path = freshPath();
    let stores = createSqliteStores(path, { now: () => 2_000_000_123 });
    expect(stores.farmIntents).toBeTruthy();
    const normalizedIntent = forwardIntentFixture();
    const first = stores.farmIntents.createOrGetIntent({ normalizedIntent, now: 2_000_000_123 });
    expect(first).toMatchObject({
      created: true,
      record: {
        jobId: '02'.repeat(16),
        mandateId: '03'.repeat(16),
        requestId: '01'.repeat(16),
        state: 'intent_pending',
        intentDigest: 'c6ee8ca0e171911440402ba173f062dac89ff1110a1477839c16b74973e29bf1',
        expectationDigest: 'c9ca175da9daf8b6879e7ec6f5f13f860e7fe0b4af266b92326bcd47b07303c6',
        batchIdempotencyKey: '4f2910192a1ab9f47c21ccfc0ad89b9087a9012d1ce5a3cc7c7d734c49a1a500',
      },
    });
    const original = stores.db.prepare('SELECT * FROM farm_intent_work_v2').get();
    stores.db.close();

    stores = createSqliteStores(path, { now: () => 2_000_000_999 });
    const recovered = stores.farmIntents.getByJob({
      mandateId: '03'.repeat(16), jobId: '02'.repeat(16),
    });
    expect(recovered.batch.children[0].lifecycle.observedAt).toBe(2_000_000_123);
    expect(recovered.intent.allocations[0].units).toBe('1000000');
    const retry = stores.farmIntents.createOrGetIntent({ normalizedIntent, now: 2_000_000_999 });
    expect(retry).toMatchObject({ created: false, record: { jobId: '02'.repeat(16) } });
    expect(stores.db.prepare('SELECT * FROM farm_intent_work_v2').get()).toEqual(original);
    stores.db.close();
  });

  // Defect caught: concurrent contenders generate different candidate job IDs; comparing the
  // losing candidate digest directly turns an identical stable request into a false 409.
  it('rebases an identical losing candidate onto the persisted winner job and timestamp', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const second = createSqliteStores(path);
    const winner = forwardIntentFixture();
    const loser = forwardIntentFixture({ jobId: '09'.repeat(16), observedAt: 2_000_000_999 });
    first.farmIntents.createOrGetIntent({ normalizedIntent: winner, now: 2_000_000_123 });
    const joined = second.farmIntents.createOrGetIntent({ normalizedIntent: loser, now: 2_000_000_999 });
    expect(joined).toMatchObject({ created: false, record: { jobId: '02'.repeat(16) } });
    expect(joined.record.batch.children[0].lifecycle.observedAt).toBe(2_000_000_123);
    expect(second.db.prepare('SELECT COUNT(*) AS n FROM farm_intent_work_v2').get().n).toBe(1);
    first.db.close();
    second.db.close();
  });

  // Defect caught: an HTTP 201 could make a job burn-ready before the ordered Task 9 identity
  // acknowledgement and every Base recovery head were durably committed together.
  it('leases exact batch delivery and atomically acknowledges every ordered recovery head', () => {
    const path = freshPath();
    const stores = createSqliteStores(path, {
      now: () => 2_000_000_123,
      leaseToken: () => 'intent-lease-1',
    });
    const normalizedIntent = forwardIntentFixture();
    stores.farmIntents.createOrGetIntent({ normalizedIntent, now: 2_000_000_123 });
    const claim = stores.farmIntents.claimIntentDelivery({
      jobId: '02'.repeat(16), now: 2_000_000_123, leaseMs: 30_000,
    });
    expect(claim).toMatchObject({ leaseToken: 'intent-lease-1', state: 'intent_pending' });
    expect(stores.farmIntents.claimIntentDelivery({
      jobId: '02'.repeat(16), now: 2_000_000_124, leaseMs: 30_000,
    })).toBeNull();
    const child = normalizedIntent.batch.children[0];
    const acknowledgement = {
      acknowledged: true,
      schemaVersion: 1,
      idempotencyKey: normalizedIntent.batchIdempotencyKey,
      requestDigest: normalizedIntent.batchDigest,
      children: [{
        identity: {
          networkId: child.networkId,
          bindingId: child.bindingId,
          executionId: child.executionId,
          allocationId: child.allocationId,
          childId: child.childId,
        },
        recoveryVersion: 7,
      }],
      written: 1,
      duplicates: 0,
    };
    const finished = stores.farmIntents.finishAwaitingBurn({
      jobId: '02'.repeat(16), leaseToken: 'intent-lease-1', acknowledgement, now: 2_000_000_125,
    });
    expect(finished).toMatchObject({ state: 'awaiting_burn', acknowledgement });
    expect(stores.baseEvidenceOutbox.status(acknowledgement.children[0].identity)).toMatchObject({
      recoveryVersion: 7,
      latestPhase: null,
    });
    expect(stores.jobs.get('02'.repeat(16))).toMatchObject({ status: 'awaiting_burn' });
    expect(stores.farmIntents.finishAwaitingBurn({
      jobId: '02'.repeat(16), leaseToken: 'stale', acknowledgement, now: 2_000_000_126,
    })).toMatchObject({ state: 'awaiting_burn' });
    expect(() => stores.farmIntents.finishAwaitingBurn({
      jobId: '02'.repeat(16),
      leaseToken: 'stale',
      acknowledgement: { ...acknowledgement, written: 0, duplicates: 1 },
      now: 2_000_000_126,
    })).toThrow(/conflict/i);
    stores.db.close();
  });

  // Defect caught: burn ownership, CCTP work, child evidence, outboxes, and public state were
  // separate commits, so a crash could leave a canonical burn permanently half-attached.
  it('attaches one burn atomically to CCTP work and every child evidence projection', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 2_000_000_200 });
    const { normalizedIntent, acknowledgement } = finishForwardIntent(stores);
    const identity = {
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
      bindingId: normalizedIntent.intent.mandate.bindingId,
      intentDigest: normalizedIntent.intentDigest,
    };
    const attached = stores.farmIntents.attachBurnAtomic({
      identity,
      burnTxHash: 'bb'.repeat(32),
      now: 2_000_000_200,
    });
    expect(attached).toMatchObject({
      duplicate: false,
      record: {
        state: 'relay_pending',
        burnTxHash: 'bb'.repeat(32),
        relayExecId: `forward-farm:${'02'.repeat(16)}`,
      },
    });
    expect(stores.cctpRelays.get(`forward-farm:${'02'.repeat(16)}`)).toMatchObject({
      state: 'attestation_pending',
      expectationDigest: normalizedIntent.expectationDigest,
      burnTxHash: 'bb'.repeat(32),
    });
    expect(stores.baseEvidenceOutbox.status(acknowledgement.children[0].identity)).toMatchObject({
      recoveryVersion: 8,
      latestPhase: 'cctp_burn',
      latestState: 'submitted',
    });
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM base_evidence_outbox').get().n).toBe(1);
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM association_outbox').get().n).toBe(1);
    expect(stores.jobs.get('02'.repeat(16))).toEqual({
      jobId: '02'.repeat(16),
      requestId: '01'.repeat(16),
      status: 'relay_pending',
      runId: 'run-42',
      allocations: [{
        ordinal: 0,
        allocationId: 'run-42:bridge:aave-v3',
        executionId: 'run-42:exec:run-42:bridge:aave-v3',
        childId: '02'.repeat(16),
      }],
    });
    expect(stores.farmIntents.attachBurnAtomic({
      identity, burnTxHash: 'bb'.repeat(32), now: 2_000_000_999,
    })).toMatchObject({ duplicate: true, record: { state: 'relay_pending' } });
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM base_evidence_outbox').get().n).toBe(1);
    expect(() => stores.farmIntents.attachBurnAtomic({
      identity, burnTxHash: 'cc'.repeat(32), now: 2_000_001_000,
    })).toThrow(/conflict|different/i);
    const second = forwardIntentFixture({
      jobId: '04'.repeat(16),
      request: { requestId: '05'.repeat(16) },
    });
    finishForwardIntent(stores, second);
    expect(() => stores.farmIntents.attachBurnAtomic({
      identity: {
        mandateId: second.intent.mandate.mandateId,
        jobId: second.intent.jobId,
        bindingId: second.intent.mandate.bindingId,
        intentDigest: second.intentDigest,
      },
      burnTxHash: 'bb'.repeat(32),
      now: 2_000_001_001,
    })).toThrow(/belongs|burn|conflict/i);
    stores.db.close();
  });

  it.each(['relay_insert', 'child_event', 'outbox', 'farm_cas', 'job_projection'])(
    'rolls back every burn attachment write when %s fails',
    (fault) => {
      const stores = createSqliteStores(freshPath(), {
        now: () => 2_000_000_200,
        farmIntentFault(point) { if (point === fault) throw new Error(`fault:${point}`); },
      });
      const { normalizedIntent } = finishForwardIntent(stores);
      const identity = {
        mandateId: normalizedIntent.intent.mandate.mandateId,
        jobId: normalizedIntent.intent.jobId,
        bindingId: normalizedIntent.intent.mandate.bindingId,
        intentDigest: normalizedIntent.intentDigest,
      };

      expect(() => stores.farmIntents.attachBurnAtomic({
        identity, burnTxHash: 'bb'.repeat(32), now: 2_000_000_200,
      })).toThrow(`fault:${fault}`);
      expect(stores.farmIntents.getByJob({
        mandateId: identity.mandateId, jobId: identity.jobId,
      })).toMatchObject({ state: 'awaiting_burn', burnTxHash: null, relayExecId: null });
      expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(0);
      expect(stores.db.prepare('SELECT COUNT(*) AS n FROM base_evidence_outbox').get().n).toBe(0);
      expect(stores.db.prepare('SELECT COUNT(*) AS n FROM association_outbox').get().n).toBe(0);
      expect(stores.jobs.get(identity.jobId)).toMatchObject({ status: 'awaiting_burn' });
      stores.db.close();
    },
  );

  it('projects confirmed CCTP evidence to every child and deposit readiness in one transaction', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 2_000_000_300 });
    const { normalizedIntent, acknowledgement } = finishForwardIntent(stores);
    const identity = {
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
      bindingId: normalizedIntent.intent.mandate.bindingId,
      intentDigest: normalizedIntent.intentDigest,
    };
    stores.farmIntents.attachBurnAtomic({ identity, burnTxHash: 'bb'.repeat(32), now: 2_000_000_200 });
    const relay = {
      execId: `forward-farm:${normalizedIntent.intent.jobId}`,
      state: 'minted', burnTxHash: 'bb'.repeat(32),
      expectationDigest: normalizedIntent.expectationDigest,
      messageDigest: 'cc'.repeat(32), attestationDigest: 'dd'.repeat(32),
      evidenceVersion: '1', mintTxHash: `0x${'ee'.repeat(32)}`,
    };

    expect(stores.farmIntents.projectMintEvidenceAtomic({ identity, relay, now: 2_000_000_300 }))
      .toMatchObject({ state: 'deposit_pending' });
    expect(stores.baseEvidenceOutbox.recoveryState(acknowledgement.children[0].identity)).toEqual({
      identity: acknowledgement.children[0].identity,
      recoveryVersion: 11,
      phase: 'cctp_mint',
      state: 'confirmed',
      evidence: {
        burnTxHash: 'bb'.repeat(32), expectationDigest: normalizedIntent.expectationDigest,
        messageDigest: 'cc'.repeat(32), attestationDigest: 'dd'.repeat(32),
        evidenceVersion: '1', mintTxHash: `0x${'ee'.repeat(32)}`,
      },
    });
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM base_evidence_outbox').get().n).toBe(4);
    expect(stores.farmIntents.attachBurnAtomic({
      identity, burnTxHash: 'bb'.repeat(32), now: 2_000_000_999,
    })).toMatchObject({ duplicate: true, record: { state: 'deposit_pending' } });
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM base_evidence_outbox').get().n).toBe(4);
  });

  // Defect caught: startup used legacy farm_execution_work/jobs as runnable truth and replayed
  // whole farm payloads instead of scanning only bounded v2 evidence states.
  it('reconciles only expired intent leases and lists bounded v2 recovery work deterministically', () => {
    const stores = createSqliteStores(freshPath(), {
      leaseToken: () => 'expired-intent-lease',
      now: () => 2_000_000_000,
    });
    const normalizedIntent = forwardIntentFixture();
    stores.farmIntents.createOrGetIntent({ normalizedIntent, now: 100 });
    stores.farmIntents.claimIntentDelivery({ jobId: normalizedIntent.intent.jobId, now: 100, leaseMs: 10 });
    expect(stores.farmIntents.reconcileExpired({ now: 111, limit: 100 })).toEqual([
      expect.objectContaining({ jobId: normalizedIntent.intent.jobId, state: 'intent_pending', leaseToken: null }),
    ]);
    expect(stores.farmIntents.listRecoverable({ now: 111, limit: 1 })).toEqual([
      expect.objectContaining({ jobId: normalizedIntent.intent.jobId, state: 'intent_pending' }),
    ]);
    expect(() => stores.farmIntents.listRecoverable({ now: 111, limit: 0 })).toThrow(/limit/i);
    stores.db.close();
  });

  it('converges an exact terminal projection CAS across two connections without masking conflict', () => {
    const path = freshPath();
    const first = createSqliteStores(path, { now: () => 1000 });
    const second = createSqliteStores(path, { now: () => 2000 });
    const normalizedIntent = forwardIntentFixture();
    first.farmIntents.createOrGetIntent({ normalizedIntent, now: 900 });
    first.db.prepare(`UPDATE farm_intent_work_v2 SET state='deposit_confirming',updated_at=950
      WHERE job_id=?`).run(normalizedIntent.intent.jobId);
    first.jobs.set(normalizedIntent.intent.jobId, {
      jobId: normalizedIntent.intent.jobId, status: 'deposit_confirming',
    });
    const identity = {
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
      bindingId: normalizedIntent.intent.mandate.bindingId,
      intentDigest: normalizedIntent.intentDigest,
    };

    expect(first.farmIntents.advanceProjection({
      identity, from: 'deposit_confirming', to: 'done', now: 1000,
    })).toMatchObject({ state: 'done', reasonCode: null });
    expect(second.farmIntents.advanceProjection({
      identity, from: 'deposit_confirming', to: 'done', now: 2000,
    })).toMatchObject({ state: 'done', reasonCode: null });
    expect(second.db.prepare('SELECT updated_at FROM farm_intent_work_v2 WHERE job_id=?')
      .get(identity.jobId).updated_at).toBe(1000);
    expect(() => second.farmIntents.advanceProjection({
      identity, from: 'deposit_confirming', to: 'blocked',
      reasonCode: 'base_recovery_uncertain', now: 2001,
    })).toThrow(/conflict/i);
    expect(second.jobs.get(identity.jobId)).toMatchObject({ status: 'done' });
    second.db.close();
    first.db.close();
  });

  it('never sanitizes or overwrites a syntactically valid mismatched public projection', () => {
    let stores = createSqliteStores(freshPath(), { now: () => 1_000 });
    let { normalizedIntent } = finishForwardIntent(stores);
    let identity = {
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
      bindingId: normalizedIntent.intent.mandate.bindingId,
      intentDigest: normalizedIntent.intentDigest,
    };
    stores.db.prepare(`UPDATE farm_intent_work_v2
      SET state='deposit_pending',updated_at=999 WHERE job_id=?`).run(identity.jobId);
    const mismatched = { jobId: identity.jobId, status: 'done', reasonCode: 'different' };
    stores.jobs.set(identity.jobId, mismatched);

    expect(() => stores.farmIntents.advanceProjection({
      identity, from: 'deposit_pending', to: 'deposit_confirming', now: 1_000,
    })).toThrow(/projection.*conflict/i);
    expect(stores.farmIntents.getByJob({
      mandateId: identity.mandateId, jobId: identity.jobId,
    })).toMatchObject({ state: 'deposit_pending' });
    expect(stores.jobs.get(identity.jobId)).toEqual(mismatched);
    stores.db.close();

    stores = createSqliteStores(freshPath(), { now: () => 1_000 });
    ({ normalizedIntent } = finishForwardIntent(stores));
    identity = {
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
      bindingId: normalizedIntent.intent.mandate.bindingId,
      intentDigest: normalizedIntent.intentDigest,
    };
    stores.farmIntents.attachBurnAtomic({
      identity, burnTxHash: 'bb'.repeat(32), now: 999,
    });
    stores.jobs.set(identity.jobId, mismatched);
    const beforeEvidence = stores.db.prepare(
      'SELECT COUNT(*) AS n FROM base_evidence_outbox',
    ).get().n;

    expect(() => stores.farmIntents.projectMintEvidenceAtomic({
      identity,
      relay: {
        execId: `forward-farm:${identity.jobId}`, state: 'minted',
        burnTxHash: 'bb'.repeat(32), expectationDigest: normalizedIntent.expectationDigest,
        messageDigest: 'cc'.repeat(32), attestationDigest: 'dd'.repeat(32),
        evidenceVersion: '1', mintTxHash: `0x${'ee'.repeat(32)}`,
      },
      now: 1_000,
    })).toThrow(/projection.*conflict/i);
    expect(stores.farmIntents.getByJob({
      mandateId: identity.mandateId, jobId: identity.jobId,
    })).toMatchObject({ state: 'relay_pending' });
    expect(stores.jobs.get(identity.jobId)).toEqual(mismatched);
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM base_evidence_outbox').get().n)
      .toBe(beforeEvidence);
    stores.db.close();
  });

  it('atomically replaces a malformed public job projection with a sanitized blocked projection', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 1_000 });
    const { normalizedIntent } = finishForwardIntent(stores);
    const identity = {
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
      bindingId: normalizedIntent.intent.mandate.bindingId,
      intentDigest: normalizedIntent.intentDigest,
    };
    stores.db.prepare(`UPDATE farm_intent_work_v2
      SET state='deposit_pending',updated_at=999 WHERE job_id=?`).run(identity.jobId);
    stores.db.prepare(`UPDATE jobs SET job='{\"serializedApproval\":\"must-not-leak\"'
      WHERE job_id=?`).run(identity.jobId);

    expect(stores.farmIntents.advanceProjection({
      identity, from: 'deposit_pending', to: 'deposit_confirming', now: 1_000,
    })).toMatchObject({ state: 'blocked', reasonCode: 'malformed_public_projection' });
    expect(stores.db.prepare(`SELECT state,reason_code FROM farm_intent_work_v2 WHERE job_id=?`)
      .get(identity.jobId)).toEqual({
        state: 'blocked', reason_code: 'malformed_public_projection',
      });
    expect(stores.jobs.get(identity.jobId)).toEqual({
      jobId: identity.jobId, status: 'blocked', reasonCode: 'malformed_public_projection',
    });
    expect(JSON.stringify(stores.jobs.get(identity.jobId))).not.toMatch(/serializedApproval|must-not-leak/);
    stores.db.close();
  });

  it('blocks malformed public JSON before projecting minted CCTP evidence', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 1_000 });
    const { normalizedIntent } = finishForwardIntent(stores);
    const identity = {
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
      bindingId: normalizedIntent.intent.mandate.bindingId,
      intentDigest: normalizedIntent.intentDigest,
    };
    stores.farmIntents.attachBurnAtomic({
      identity, burnTxHash: 'bb'.repeat(32), now: 999,
    });
    const beforeEvidence = stores.db.prepare(
      'SELECT COUNT(*) AS n FROM base_evidence_outbox',
    ).get().n;
    stores.db.prepare(`UPDATE jobs SET job='{\"serializedApproval\":\"must-not-leak\"'
      WHERE job_id=?`).run(identity.jobId);

    expect(stores.farmIntents.projectMintEvidenceAtomic({
      identity,
      relay: {
        execId: `forward-farm:${identity.jobId}`, state: 'minted',
        burnTxHash: 'bb'.repeat(32), expectationDigest: normalizedIntent.expectationDigest,
        messageDigest: 'cc'.repeat(32), attestationDigest: 'dd'.repeat(32),
        evidenceVersion: '1', mintTxHash: `0x${'ee'.repeat(32)}`,
      },
      now: 1_000,
    })).toMatchObject({ state: 'blocked', reasonCode: 'malformed_public_projection' });
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM base_evidence_outbox').get().n)
      .toBe(beforeEvidence);
    expect(stores.jobs.get(identity.jobId)).toEqual({
      jobId: identity.jobId, status: 'blocked', reasonCode: 'malformed_public_projection',
    });
    expect(JSON.stringify(stores.jobs.get(identity.jobId))).not.toMatch(/serializedApproval|must-not-leak/);
    stores.db.close();
  });

  it('atomically refuses a Base submitting claim when revoke wins after the authority snapshot', () => {
    const path = freshPath();
    const first = createSqliteStores(path, {
      sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      now: () => 1_000, leaseToken: () => 'must-not-be-issued',
    });
    const second = createSqliteStores(path, {
      sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      now: () => 2_000, leaseToken: () => 'contender-token',
    });
    first.mandateActivations.enqueue({ record: mandateRecord() });
    first.db.prepare(`UPDATE mandates_v3 SET status='active',updated_at=? WHERE mandate_id=?`)
      .run(NOW_SECONDS, MANDATE_ID);
    const normalizedIntent = forwardIntentFixture({
      request: { mandateId: MANDATE_ID, stellarOwner: OWNER, kernelAddress: KERNEL },
      mandate: {
        bindingId: 'binding-1', bindingHash: BINDING_HASH,
        approvalDigest: APPROVAL_DIGEST, policyDigest: POLICY_DIGEST,
        permissionId: PERMISSION_ID, validUntilSeconds: VALID_UNTIL_SECONDS,
        relayerOrigin: 'https://relayer.example',
      },
    });
    const { recoveryIdentity } = finishForwardIntentDepositConfirming(first, normalizedIntent);
    const authoritySnapshot = {
      mandateId: MANDATE_ID,
      stellarOwner: OWNER,
      kernelAddress: KERNEL.toLowerCase(),
      status: 'active',
      bindingId: 'binding-1',
      bindingHash: BINDING_HASH,
      capabilityHash: CAPABILITY_HASH,
      relayerOrigin: 'https://relayer.example',
      validUntilSeconds: VALID_UNTIL_SECONDS,
      updatedAt: NOW_SECONDS,
    };
    const rogueIdentity = {
      ...recoveryIdentity,
      executionId: `${recoveryIdentity.executionId}:rogue`,
      allocationId: `${recoveryIdentity.allocationId}:rogue`,
    };
    first.baseEvidenceOutbox.seed(rogueIdentity, 0, { jobId: normalizedIntent.intent.jobId });
    expect(first.farmIntents.claimAuthorizedSubmission({
      checkpoint: {
        identity: rogueIdentity, phase: 'base_deposit', status: 'submitting',
        evidence: {
          chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
          caller: KERNEL.toLowerCase(),
          poolAddress: normalizedIntent.intent.allocations[0].poolAddress,
          assets: '1000000', minShares: '900000',
        },
        observedAt: 999,
      },
      authoritySnapshot,
      nowSeconds: NOW_SECONDS,
    })).toEqual({
      claimed: false, ownerToken: null, reasonCode: 'mandate_authority_changed',
    });
    expect(first.baseEvidenceOutbox.recoveryState(rogueIdentity)).toBeNull();
    second.mandatesV3.revoke(mandateIdentity());

    const claim = first.farmIntents.claimAuthorizedSubmission({
      checkpoint: {
        identity: recoveryIdentity, phase: 'base_deposit', status: 'submitting',
        evidence: {
          chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
          caller: KERNEL.toLowerCase(),
          poolAddress: normalizedIntent.intent.allocations[0].poolAddress,
          assets: '1000000', minShares: '900000',
        },
        observedAt: 1_000,
      },
      authoritySnapshot,
      nowSeconds: NOW_SECONDS,
    });

    expect(claim).toEqual({
      claimed: false, ownerToken: null, reasonCode: 'mandate_authority_changed',
    });
    expect(first.baseEvidenceOutbox.recoveryState(recoveryIdentity)).toMatchObject({
      phase: 'cctp_mint', state: 'confirmed',
    });
    expect(JSON.stringify(first.baseEvidenceOutbox.status(recoveryIdentity)))
      .not.toMatch(/must-not-be-issued|capability|session/i);
    second.db.close();
    first.db.close();
  });

  it('holds the mandate write lock through the Base claim and preserves its fence after revoke', () => {
    const path = freshPath();
    let second;
    let identity;
    let concurrentRevokeBlocked = false;
    let concurrentConflictBlocked = false;
    const first = createSqliteStores(path, {
      sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      now: () => 1_000, leaseToken: () => 'authorized-owner',
      farmIntentFault(point) {
        if (point !== 'authorized_claim_after_authority') return;
        second.db.exec('PRAGMA busy_timeout=0');
        expect(() => second.mandatesV3.revoke(mandateIdentity()))
          .toThrow(/temporarily unavailable|locked/i);
        concurrentRevokeBlocked = true;
        expect(() => second.farmIntents.blockEvidenceConflict({
          identity, now: 2_000_000_302,
        })).toThrow(/temporarily unavailable|locked/i);
        concurrentConflictBlocked = true;
      },
    });
    second = createSqliteStores(path, {
      sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      now: () => 2_000, leaseToken: () => 'contender-token',
    });
    first.mandateActivations.enqueue({ record: mandateRecord() });
    first.db.prepare(`UPDATE mandates_v3 SET status='active',updated_at=? WHERE mandate_id=?`)
      .run(NOW_SECONDS, MANDATE_ID);
    const normalizedIntent = forwardIntentFixture({
      request: { mandateId: MANDATE_ID, stellarOwner: OWNER, kernelAddress: KERNEL },
      mandate: {
        bindingId: 'binding-1', bindingHash: BINDING_HASH,
        approvalDigest: APPROVAL_DIGEST, policyDigest: POLICY_DIGEST,
        permissionId: PERMISSION_ID, validUntilSeconds: VALID_UNTIL_SECONDS,
        relayerOrigin: 'https://relayer.example',
      },
    });
    ({ recoveryIdentity: identity } = finishForwardIntentDepositConfirming(
      first, normalizedIntent,
    ));
    const commonEvidence = {
      chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
      caller: KERNEL.toLowerCase(), poolAddress: normalizedIntent.intent.allocations[0].poolAddress,
      assets: '1000000', minShares: '900000',
    };
    const authoritySnapshotTarget = {
      mandateId: MANDATE_ID, stellarOwner: OWNER, kernelAddress: KERNEL.toLowerCase(),
      status: 'active', bindingId: 'binding-1', bindingHash: BINDING_HASH,
      capabilityHash: CAPABILITY_HASH, relayerOrigin: 'https://relayer.example',
      validUntilSeconds: VALID_UNTIL_SECONDS, updatedAt: NOW_SECONDS,
    };
    let capabilityReads = 0;
    const authoritySnapshot = new Proxy(authoritySnapshotTarget, {
      get(target, property, receiver) {
        if (property === 'capabilityHash') {
          capabilityReads += 1;
          return capabilityReads === 1 ? CAPABILITY_HASH : 'bb'.repeat(32);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const claim = first.farmIntents.claimAuthorizedSubmission({
      checkpoint: {
        identity, phase: 'base_deposit', status: 'submitting',
        evidence: commonEvidence, observedAt: 1_000,
      },
      authoritySnapshot,
      nowSeconds: NOW_SECONDS,
    });

    expect(concurrentRevokeBlocked).toBe(true);
    expect(concurrentConflictBlocked).toBe(true);
    expect(capabilityReads).toBe(1);
    expect(claim).toMatchObject({ claimed: true, ownerToken: 'authorized-owner' });
    const claimedHead = second.db.prepare(`SELECT latest_phase,latest_state,submission_owner_token
      FROM base_evidence_heads WHERE network_id=? AND binding_id=? AND execution_id=?
        AND allocation_id=? AND child_id=?`).get(
      identity.networkId, identity.bindingId, identity.executionId,
      identity.allocationId, identity.childId,
    );
    const claimedEvents = second.db.prepare(
      'SELECT COUNT(*) AS count FROM base_evidence_outbox',
    ).get().count;
    expect(claimedHead).toEqual({
      latest_phase: 'base_deposit', latest_state: 'submitting',
      submission_owner_token: 'authorized-owner',
    });
    expect(second.farmIntents.blockEvidenceConflict({
      identity, now: 2_000_000_303,
    })).toEqual({ jobId: normalizedIntent.intent.jobId, status: 'blocked' });
    expect(second.db.prepare(`SELECT latest_phase,latest_state,submission_owner_token
      FROM base_evidence_heads WHERE network_id=? AND binding_id=? AND execution_id=?
        AND allocation_id=? AND child_id=?`).get(
      identity.networkId, identity.bindingId, identity.executionId,
      identity.allocationId, identity.childId,
    )).toEqual(claimedHead);
    expect(second.db.prepare('SELECT COUNT(*) AS count FROM base_evidence_outbox').get().count)
      .toBe(claimedEvents);
    expect(second.farmIntents.getByJob({
      mandateId: MANDATE_ID, jobId: normalizedIntent.intent.jobId,
    })).toMatchObject({ state: 'blocked', reasonCode: 'base_evidence_conflict' });
    expect(second.jobs.get(normalizedIntent.intent.jobId)).toMatchObject({
      status: 'blocked', reasonCode: 'base_evidence_conflict',
    });
    expect(second.mandatesV3.revoke(mandateIdentity())).toMatchObject({ status: 'revoked' });
    expect(second.baseEvidenceOutbox.recoveryState(identity)).toMatchObject({
      phase: 'base_deposit', state: 'submitting',
    });
    expect(JSON.stringify(second.baseEvidenceOutbox.status(identity)))
      .not.toMatch(/authorized-owner|capability|session/i);
    expect(first.baseEvidenceOutbox.enqueueOwned({
      identity, phase: 'base_deposit', status: 'submitted',
      evidence: { ...commonEvidence, userOpHash: `0x${'44'.repeat(32)}` }, observedAt: 1_001,
    }, { ownerToken: claim.ownerToken })).toMatchObject({ state: 'submitted' });
    second.db.close();
    first.db.close();
  });

  it('quarantines legacy active farm rows once and leaves done rows as history only', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 200 });
    for (const [jobId, status] of [['legacy-pending', 'pending'], ['legacy-running', 'running'], ['legacy-done', 'done']]) {
      stores.jobs.set(jobId, { jobId, status, serializedApproval: 'legacy-secret' });
      stores.db.prepare(`INSERT INTO farm_execution_work
        (job_id,burn_tx_hash,status,attempts,lease_token,lease_expires_at,created_at,updated_at)
        VALUES (?,?,?,0,NULL,NULL,100,100)`).run(jobId, `burn-${jobId}`, status);
    }

    expect(stores.farmIntents.quarantineLegacyActive({ now: 200, limit: 100 }))
      .toEqual(['legacy-pending', 'legacy-running']);
    expect(stores.farmIntents.quarantineLegacyActive({ now: 201, limit: 100 })).toEqual([]);
    expect(stores.jobs.get('legacy-pending')).toEqual({
      jobId: 'legacy-pending', status: 'uncertain', reasonCode: 'legacy_record_unrecoverable',
    });
    expect(stores.jobs.get('legacy-running')).not.toHaveProperty('serializedApproval');
    expect(stores.jobs.get('legacy-done')).toMatchObject({ status: 'done' });
    expect(stores.farmIntents.listRecoverable({ now: 201, limit: 100 })).toEqual([]);
    stores.db.close();
  });

  it('never lets more than the limit of retained done history starve a legacy active row', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 500 });
    for (let index = 0; index < 2; index += 1) {
      const jobId = `legacy-done-${String(index).padStart(3, '0')}`;
      stores.jobs.set(jobId, { jobId, status: 'done' });
      stores.db.prepare(`INSERT INTO farm_execution_work
        (job_id,burn_tx_hash,status,attempts,lease_token,lease_expires_at,created_at,updated_at)
        VALUES (?,?, 'done',0,NULL,NULL,?,?)`).run(jobId, `burn-${jobId}`, index, index);
    }
    stores.jobs.set('legacy-active-last', {
      jobId: 'legacy-active-last', status: 'pending', serializedApproval: 'must-scrub',
    });
    stores.db.prepare(`INSERT INTO farm_execution_work
      (job_id,burn_tx_hash,status,attempts,lease_token,lease_expires_at,created_at,updated_at)
      VALUES ('legacy-active-last','burn-active-last','pending',0,NULL,NULL,1000,1000)`).run();

    expect(stores.farmIntents.quarantineLegacyActive({ now: 500, limit: 1 }))
      .toContain('legacy-active-last');
    expect(stores.jobs.get('legacy-active-last')).toEqual({
      jobId: 'legacy-active-last', status: 'uncertain', reasonCode: 'legacy_record_unrecoverable',
    });
    stores.db.close();
  });

  it('scrubs bounded later pages of secret-bearing done history exactly once', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 500 });
    for (let index = 0; index < 3; index += 1) {
      const jobId = `legacy-secret-done-${index}`;
      stores.jobs.set(jobId, { jobId, status: 'done', serializedApproval: `secret-${index}` });
      stores.db.prepare(`INSERT INTO farm_execution_work
        (job_id,burn_tx_hash,status,attempts,lease_token,lease_expires_at,created_at,updated_at)
        VALUES (?,?,'done',0,NULL,NULL,?,?)`).run(jobId, `burn-${index}`, index, index);
    }

    stores.farmIntents.quarantineLegacyActive({ now: 500, limit: 1 });
    stores.farmIntents.quarantineLegacyActive({ now: 501, limit: 1 });
    stores.farmIntents.quarantineLegacyActive({ now: 502, limit: 1 });

    expect(stores.db.prepare(`SELECT COUNT(*) AS n FROM farm_execution_work WHERE status='done'`)
      .get().n).toBe(0);
    for (let index = 0; index < 3; index += 1) {
      expect(stores.jobs.get(`legacy-secret-done-${index}`)).toEqual({
        jobId: `legacy-secret-done-${index}`, status: 'done',
      });
    }
    stores.db.close();
  });

  it('blocks the owning v2 farm projection when Task 10 reports an immutable evidence conflict', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 300 });
    const { normalizedIntent, acknowledgement } = finishForwardIntent(stores);
    stores.baseEvidenceOutbox.enqueue({
      identity: acknowledgement.children[0].identity,
      phase: 'cctp_burn',
      status: 'submitted',
      evidence: {
        burnTxHash: 'bb'.repeat(32),
        expectationDigest: normalizedIntent.expectationDigest,
        burnUnits7: normalizedIntent.expectation.burnUnits7,
      },
      observedAt: 300,
    });
    const leased = stores.baseEvidenceOutbox.leaseNext({ now: 300, leaseMs: 100 });
    const blocked = stores.baseEvidenceOutbox.markConflict({
      id: leased.id,
      leaseToken: leased.leaseToken,
      now: 300,
      block: () => stores.farmIntents.blockEvidenceConflict({
        identity: leased.identity, now: 300,
      }, { transaction: false }),
    });

    expect(blocked).toMatchObject({ deliveryStatus: 'conflict' });
    expect(stores.farmIntents.getByJob({
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
    })).toMatchObject({ state: 'blocked', reasonCode: 'base_evidence_conflict' });
    expect(stores.jobs.get(normalizedIntent.intent.jobId)).toMatchObject({
      status: 'blocked', reasonCode: 'base_evidence_conflict',
    });
    stores.db.close();
  });

  it('rolls back evidence conflict delivery instead of falling back when the v2 owner is terminal', () => {
    const stores = createSqliteStores(freshPath(), { now: () => 300 });
    const { normalizedIntent, acknowledgement } = finishForwardIntent(stores);
    const projectionIdentity = {
      mandateId: normalizedIntent.intent.mandate.mandateId,
      jobId: normalizedIntent.intent.jobId,
      bindingId: normalizedIntent.intent.mandate.bindingId,
      intentDigest: normalizedIntent.intentDigest,
    };
    stores.farmIntents.advanceProjection({
      identity: projectionIdentity, from: 'awaiting_burn', to: 'done', now: 301,
    });
    stores.baseEvidenceOutbox.enqueue({
      identity: acknowledgement.children[0].identity,
      phase: 'cctp_burn', status: 'submitted', observedAt: 302,
      evidence: {
        burnTxHash: 'bb'.repeat(32), expectationDigest: normalizedIntent.expectationDigest,
        burnUnits7: normalizedIntent.expectation.burnUnits7,
      },
    });
    const leased = stores.baseEvidenceOutbox.leaseNext({ now: 303, leaseMs: 100 });

    expect(() => stores.baseEvidenceOutbox.markConflict({
      id: leased.id, leaseToken: leased.leaseToken, now: 304,
      block: () => stores.farmIntents.blockEvidenceConflict(
        { identity: leased.identity }, { transaction: false },
      ),
    })).toThrow(/terminal/i);
    expect(stores.baseEvidenceOutbox.status(leased.identity).events.at(-1))
      .toMatchObject({ deliveryStatus: 'leased' });
    expect(stores.jobs.get(normalizedIntent.intent.jobId)).toMatchObject({ status: 'done' });
    stores.db.close();
  });
});
function cipher(entries = [['active', Buffer.alloc(32, 0x31)]]) {
  return createSecretEnvelope(parseSecretKeyring(
    entries.map(([id, key]) => `${id}:${key.toString('base64')}`).join(','),
  ));
}

function mandateRecord(overrides = {}) {
  return {
    mandateId: MANDATE_ID,
    approvalDigest: APPROVAL_DIGEST,
    policyDigest: POLICY_DIGEST,
    serializedApproval: APPROVAL,
    sessionPrivateKey: SESSION_PRIVATE_KEY,
    sessionKeyAddress: SESSION,
    capabilityHash: CAPABILITY_HASH,
    stellarOwner: OWNER,
    kernelAddress: KERNEL,
    relayerOrigin: 'https://relayer.example',
    validUntilSeconds: VALID_UNTIL_SECONDS,
    status: 'pending_activation',
    bindingId: 'binding-1',
    bindingHash: BINDING_HASH,
    permissionId: PERMISSION_ID,
    ...overrides,
  };
}

const mandateIdentity = () => ({ mandateId: MANDATE_ID, stellarOwner: OWNER, kernelAddress: KERNEL });

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({ name }) => name);
}

function createLegacyV2(path, overrides = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
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
    )
  `);
  const row = {
    serializedApproval: APPROVAL,
    stellarOwner: OWNER,
    kernelAddress: KERNEL,
    sessionPrivateKey: SESSION_PRIVATE_KEY,
    sessionKeyAddress: SESSION,
    relayerOrigin: 'https://relayer.example',
    expiresAt: VALID_UNTIL_SECONDS * 1000,
    status: 'active',
    bindingId: 'binding-1',
    bindingHash: BINDING_HASH,
    createdAt: NOW_SECONDS * 1000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO mandates_v2 (
      serialized_approval, stellar_owner, kernel_address, session_private_key,
      session_key_address, relayer_origin, expires_at, status, binding_id,
      binding_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.serializedApproval, row.stellarOwner, row.kernelAddress, row.sessionPrivateKey,
    row.sessionKeyAddress, row.relayerOrigin, row.expiresAt, row.status, row.bindingId,
    row.bindingHash, row.createdAt,
  );
  db.close();
  return row;
}

function createPrePolicyV3(path, { withRow = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE mandates_v3 (
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
    CREATE TABLE mandate_activation_work (
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
  `);
  if (withRow) {
    db.prepare(`
      INSERT INTO mandates_v3 (
        mandate_id, approval_digest, serialized_approval, stellar_owner, kernel_address,
        session_key_address, relayer_origin, valid_until_seconds, status, binding_id,
        binding_hash, permission_id, session_key_envelope, capability_hash,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_activation', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      MANDATE_ID, APPROVAL_DIGEST, APPROVAL, OWNER, KERNEL.toLowerCase(),
      SESSION.toLowerCase(), 'https://relayer.example', VALID_UNTIL_SECONDS,
      'binding-1', BINDING_HASH, PERMISSION_ID, 'legacy-envelope', CAPABILITY_HASH,
      NOW_SECONDS, NOW_SECONDS,
    );
  }
  db.close();
}

function canonicalLegacyParser(params) {
  if (params.serializedApproval !== APPROVAL) throw new Error('approval is noncanonical');
  const expectedBinding = createHash('sha256')
    .update(`${params.stellarOwner}|${params.kernelAddress}|${params.sessionKeyAddress}|${params.validUntilSeconds}`)
    .digest('hex');
  if (params.bindingId !== 'binding-1' || params.bindingHash !== expectedBinding) {
    throw new Error('binding is noncanonical');
  }
  return {
    accountAddress: params.kernelAddress,
    sessionKeyAddress: params.sessionKeyAddress,
    stellarOwner: params.stellarOwner,
    permissionId: PERMISSION_ID,
    validAfter: 0,
    validUntilSeconds: params.validUntilSeconds,
    cap: 10_000_000_000n,
    policies: [{ type: 'call' }, { type: 'timestamp' }],
    call: { type: 'call' },
    timestamp: { validAfter: 0, validUntil: VALID_UNTIL_SECONDS },
    policyDigest: POLICY_DIGEST,
    policyData: ['0x0000call', '0x0000timestamp'],
  };
}

async function migrationLibrary() {
  return import('../src/mandateMigration.mjs');
}

function migrationOptions(overrides = {}) {
  return {
    env: OFFLINE_ENV,
    config: TASK4_CONFIG,
    parseCanonicalApproval: canonicalLegacyParser,
    ...overrides,
  };
}

function createMigrationVerificationTarget(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(MANDATE_V3_SCHEMA);
  } finally {
    db.close();
  }
}

function observePersistedMandateEnvelopeReads({ transformRow = (row) => row } = {}) {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const state = { reads: 0, envelope: null };
  DatabaseSync.prototype.prepare = function observePrepare(sql) {
    const statement = originalPrepare.call(this, sql);
    if (!/\bfrom\s+[`"']?mandates_v3\b/i.test(String(sql))) return statement;
    for (const method of ['get', 'all']) {
      const originalRead = statement[method].bind(statement);
      statement[method] = (...args) => {
        const result = originalRead(...args);
        const rows = Array.isArray(result) ? result : [result];
        const transformed = rows.map((row) => {
          if (typeof row?.session_key_envelope === 'string') {
            state.reads += 1;
            state.envelope = row.session_key_envelope;
            return transformRow({ ...row });
          }
          return row;
        });
        return Array.isArray(result) ? transformed : transformed[0];
      };
    }
    return statement;
  };
  return {
    state,
    restore() {
      DatabaseSync.prototype.prepare = originalPrepare;
    },
  };
}

function observeMigrationTempStore(path, stage = () => 'unknown') {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const observedConnections = new WeakSet();
  const state = { observations: [] };
  let inspecting = false;
  DatabaseSync.prototype.prepare = function observePrepare(sql) {
    const source = String(sql);
    if (!inspecting && !observedConnections.has(this)
      && /sqlite_master|mandates(?:_v[23])?|mandate_activation_work|mandate_migration_state/i.test(source)) {
      inspecting = true;
      try {
        const main = originalPrepare.call(this, 'PRAGMA database_list').all()
          .find(({ name }) => name === 'main');
        if (main?.file === path) {
          const mode = originalPrepare.call(this, 'PRAGMA temp_store').get()?.temp_store;
          state.observations.push({ mode, firstQuery: source, stage: stage() });
          observedConnections.add(this);
        }
      } finally {
        inspecting = false;
      }
    }
    return originalPrepare.call(this, sql);
  };
  return {
    state,
    restore() {
      DatabaseSync.prototype.prepare = originalPrepare;
    },
  };
}

function migrationVerificationCipher(mode, { persistedEnvelopeWasRead = () => false } = {}) {
  const envelopeCipher = cipher();
  const state = { sealCalls: 0, openCalls: 0, sealedEnvelope: null, openedEnvelopes: [] };
  return {
    state,
    seal(plaintext, aad) {
      state.sealCalls += 1;
      if (mode === 'empty-envelope') state.sealedEnvelope = '';
      else if (mode === 'malformed-envelope') {
        state.sealedEnvelope = 'malformed-envelope-must-not-leak';
      } else if (mode === 'unopenable-envelope') {
        state.sealedEnvelope = envelopeCipher.seal(plaintext, `${aad}:wrong-aad`);
      } else {
        state.sealedEnvelope = envelopeCipher.seal(plaintext, aad);
      }
      return state.sealedEnvelope;
    },
    open(envelope, aad) {
      state.openCalls += 1;
      state.openedEnvelopes.push(envelope);
      if (mode === 'wrong-immediate-plaintext' && state.openCalls === 1) {
        return { plaintext: WRONG_SESSION_PRIVATE_KEY, needsRotation: false };
      }
      if (state.openCalls === 2 && persistedEnvelopeWasRead()) {
        if (mode === 'post-insert-open-failure') {
          throw new Error(`injected post-insert open failure: ${SESSION_PRIVATE_KEY}`);
        }
        if (mode === 'post-insert-wrong-plaintext') {
          return { plaintext: WRONG_SESSION_PRIVATE_KEY, needsRotation: false };
        }
      }
      return envelopeCipher.open(envelope, aad);
    },
  };
}

function expectLosslessMigrationRollback(path, before) {
  expect(sqliteSnapshot(path)).toStrictEqual(before);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = tableNames(db).map((name) => name.toLowerCase());
    expect(tables).toContain('mandates_v2');
    expect(db.prepare(`
      SELECT serialized_approval, session_private_key FROM mandates_v2
    `).get()).toEqual({
      serialized_approval: APPROVAL,
      session_private_key: SESSION_PRIVATE_KEY,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(0);
    expect(db.prepare(`
      SELECT phase, manifest_version, source_digest, target_digest,
             migrated_count, quarantined_count, updated_at
      FROM mandate_migration_state WHERE id = 1
    `).get()).toEqual({
      phase: 'virgin',
      manifest_version: null,
      source_digest: null,
      target_digest: null,
      migrated_count: null,
      quarantined_count: null,
      updated_at: 0,
    });
  } finally {
    db.close();
  }
}

function migrationTargetSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = new Set(tableNames(db).map((name) => name.toLowerCase()));
    return {
      objects: db.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE type IN ('table', 'trigger')
        ORDER BY type, name
      `).all(),
      mandates: names.has('mandates_v3')
        ? db.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all() : null,
      work: names.has('mandate_activation_work')
        ? db.prepare('SELECT * FROM mandate_activation_work ORDER BY mandate_id').all() : null,
      state: names.has('mandate_migration_state')
        ? db.prepare('SELECT * FROM mandate_migration_state ORDER BY id').all() : null,
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all(),
    };
  } finally {
    db.close();
  }
}

function replaceActivationWorkSchema(db, {
  statusCheck = "CHECK (status IN ('pending','running','submitting','submitted','done','uncertain'))",
  attemptsDefault = 'DEFAULT 0',
  foreignKey = 'FOREIGN KEY (mandate_id) REFERENCES mandates_v3(mandate_id)',
} = {}) {
  db.exec('PRAGMA foreign_keys=OFF; DROP TABLE mandate_activation_work;');
  db.exec(`
    CREATE TABLE mandate_activation_work (
      mandate_id TEXT PRIMARY KEY,
      stellar_owner TEXT NOT NULL,
      kernel_address TEXT NOT NULL,
      status TEXT NOT NULL ${statusCheck},
      attempts INTEGER NOT NULL ${attemptsDefault},
      lease_token TEXT,
      lease_expires_at INTEGER,
      user_op_hash TEXT,
      tx_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
      ${foreignKey ? `, ${foreignKey}` : ''}
    )
  `);
}

const CANONICAL_MIGRATION_MARKER_METADATA_CHECK = `CHECK (
  (phase = 'virgin'
    AND manifest_version IS NULL
    AND source_digest IS NULL
    AND target_digest IS NULL
    AND migrated_count IS NULL
    AND quarantined_count IS NULL)
  OR
  (phase IN ('cleanup_pending','completed')
    AND manifest_version = 1
    AND length(source_digest) = 64
    AND source_digest NOT GLOB '*[^0-9a-f]*'
    AND length(target_digest) = 64
    AND target_digest NOT GLOB '*[^0-9a-f]*'
    AND migrated_count >= 0
    AND quarantined_count >= 0)
)`;

const VIRGIN_MIGRATION_MARKER_ROW = [1, 'virgin', null, null, null, null, null, 0];

function boundMigrationMarkerRow({ id = 1, phase = 'cleanup_pending' } = {}) {
  return [id, phase, 1, '11'.repeat(32), '22'.repeat(32), 1, 0, NOW_SECONDS];
}

function replaceMigrationStateSchema(db, {
  idCheck = 'CHECK (id = 1)',
  phaseCheck = "CHECK (phase IN ('virgin','cleanup_pending','completed'))",
  metadataCheck = CANONICAL_MIGRATION_MARKER_METADATA_CHECK,
  rows = [VIRGIN_MIGRATION_MARKER_ROW],
} = {}) {
  db.exec('DROP TABLE mandate_migration_state;');
  db.exec(`
    CREATE TABLE mandate_migration_state (
      id INTEGER PRIMARY KEY ${idCheck},
      phase TEXT NOT NULL ${phaseCheck},
      manifest_version INTEGER,
      source_digest TEXT,
      target_digest TEXT,
      migrated_count INTEGER,
      quarantined_count INTEGER,
      updated_at INTEGER NOT NULL
      ${metadataCheck ? `, ${metadataCheck}` : ''}
    )
  `);
  const insert = db.prepare(`
    INSERT INTO mandate_migration_state (
      id, phase, manifest_version, source_digest, target_digest,
      migrated_count, quarantined_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) insert.run(...row);
}

function createMarkerOnlyLayout(path, {
  phase = 'virgin',
  idCheck = 'CHECK (id = 1)',
  phaseCheck = "CHECK (phase IN ('virgin','cleanup_pending','completed'))",
  metadataCheck = CANONICAL_MIGRATION_MARKER_METADATA_CHECK,
} = {}) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE mandate_migration_state (
        id INTEGER PRIMARY KEY ${idCheck},
        phase TEXT NOT NULL ${phaseCheck},
        manifest_version INTEGER,
        source_digest TEXT,
        target_digest TEXT,
        migrated_count INTEGER,
        quarantined_count INTEGER,
        updated_at INTEGER NOT NULL
        ${metadataCheck ? `, ${metadataCheck}` : ''}
      )
    `);
    const row = phase === 'virgin'
      ? VIRGIN_MIGRATION_MARKER_ROW
      : boundMigrationMarkerRow({ phase });
    db.prepare(`
      INSERT INTO mandate_migration_state (
        id, phase, manifest_version, source_digest, target_digest,
        migrated_count, quarantined_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...row);
  } finally {
    db.close();
  }
}

function insertActivationWork(db, {
  mandateId,
  stellarOwner = OWNER,
  kernelAddress = KERNEL.toLowerCase(),
} = {}) {
  db.prepare(`
    INSERT INTO mandate_activation_work (
      mandate_id, stellar_owner, kernel_address, status, attempts,
      lease_token, lease_expires_at, user_op_hash, tx_hash, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)
  `).run(mandateId, stellarOwner, kernelAddress, NOW_SECONDS, NOW_SECONDS);
}

async function seedPendingMigrationCleanup(path, { sessionKeyCipher = cipher() } = {}) {
  createLegacyV2(path);
  const migration = await migrationLibrary();
  const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
  let seedError;
  try {
    migration.migrateLegacyMandates(path, migrationOptions({
      manifest,
      sessionKeyCipher,
      migrationHooks: {
        afterDestructiveCommit() {
          throw new Error(`seed cleanup interruption: ${SESSION_PRIVATE_KEY}`);
        },
      },
    }));
  } catch (error) {
    seedError = error;
  }
  expect(seedError).toBeInstanceOf(Error);
  expect(seedError.message).toBe('offline mandate migration cleanup is pending');
  return migration;
}

function canonicalMultiRowLegacyParser(params) {
  const expectedBinding = createHash('sha256')
    .update(`${params.stellarOwner}|${params.kernelAddress}|${params.sessionKeyAddress}|${params.validUntilSeconds}`)
    .digest('hex');
  if (!params.bindingId || params.bindingHash !== expectedBinding) {
    throw new Error('binding is noncanonical');
  }
  return {
    accountAddress: params.kernelAddress,
    sessionKeyAddress: params.sessionKeyAddress,
    stellarOwner: params.stellarOwner,
    permissionId: params.serializedApproval === APPROVAL ? PERMISSION_ID : '0x5678abcd',
    validUntilSeconds: params.validUntilSeconds,
    policyDigest: params.serializedApproval === APPROVAL ? POLICY_DIGEST : 'ee'.repeat(32),
  };
}

function expectedPersistedMigrationDestinationDigest(row) {
  if (!['activation_uncertain', 'revoked'].includes(row.status)) {
    throw new Error('test fixture has a non-migration destination status');
  }
  const facts = row.status === 'activation_uncertain'
    ? [
      row.approval_digest,
      row.policy_digest,
      row.stellar_owner,
      row.kernel_address,
      row.session_key_address,
      row.relayer_origin,
      row.valid_until_seconds,
      row.binding_id,
      row.binding_hash,
      row.permission_id,
      row.session_key_digest,
      row.created_at,
      'activation_uncertain',
      null,
      null,
      null,
      null,
      null,
    ]
    : [
      row.approval_digest,
      row.stellar_owner,
      row.kernel_address,
      row.quarantine_reason,
      'revoked',
      null,
      null,
      null,
      null,
      null,
    ];
  return createHash('sha256')
    .update(JSON.stringify([
      'vf-legacy-mandate-destination-v1',
      row.status === 'activation_uncertain' ? 'migrate' : 'revoked',
      facts,
    ]))
    .digest('hex');
}

function expectedMigrationTargetDigest(rows) {
  const identitiesAndDigests = rows
    .map((row) => [row.mandate_id, expectedPersistedMigrationDestinationDigest(row)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify(['vf-mandate-migration-target-v1', identitiesAndDigests]))
    .digest('hex');
}

async function seedBoundPendingMigrationCleanup(path, { sessionKeyCipher = cipher() } = {}) {
  createLegacyV2(path);
  const secondOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
  const secondKernel = `0x${'78'.repeat(20)}`;
  const secondSession = privateKeyToAccount(SECOND_SESSION_PRIVATE_KEY).address;
  createLegacyV2(path, {
    serializedApproval: 'canonical-approval-fixture-two',
    stellarOwner: secondOwner,
    kernelAddress: secondKernel,
    sessionPrivateKey: SECOND_SESSION_PRIVATE_KEY,
    sessionKeyAddress: secondSession,
    bindingId: 'binding-2',
    bindingHash: createHash('sha256')
      .update(`${secondOwner}|${secondKernel}|${secondSession}|${VALID_UNTIL_SECONDS}`)
      .digest('hex'),
    createdAt: (NOW_SECONDS + 1) * 1000,
  });
  const migration = await migrationLibrary();
  const options = migrationOptions({ parseCanonicalApproval: canonicalMultiRowLegacyParser });
  const manifest = migration.createLegacyMandateMigrationManifest(path, options);
  let seedError;
  try {
    migration.migrateLegacyMandates(path, {
      ...options,
      manifest,
      sessionKeyCipher,
      migrationHooks: {
        afterDestructiveCommit() {
          throw new Error(`seed bound cleanup interruption: ${SECOND_SESSION_PRIVATE_KEY}`);
        },
      },
    });
  } catch (error) {
    seedError = error;
  }
  expect(seedError).toBeInstanceOf(Error);
  expect(seedError.message).toBe('offline mandate migration cleanup is pending');
  return { migration, manifest, options };
}

async function seedCompletedMigrationWithBothOutcomes(path) {
  createLegacyV2(path);
  const revokedOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
  const revokedKernel = `0x${'78'.repeat(20)}`;
  const revokedSession = privateKeyToAccount(SECOND_SESSION_PRIVATE_KEY).address;
  createLegacyV2(path, {
    serializedApproval: 'revoked-legacy-approval-fixture',
    stellarOwner: revokedOwner,
    kernelAddress: revokedKernel,
    sessionPrivateKey: SECOND_SESSION_PRIVATE_KEY,
    sessionKeyAddress: revokedSession,
    status: 'revoked',
    bindingId: 'revoked-binding',
    bindingHash: createHash('sha256')
      .update(`${revokedOwner}|${revokedKernel}|${revokedSession}|${VALID_UNTIL_SECONDS}`)
      .digest('hex'),
  });
  const migration = await migrationLibrary();
  const options = migrationOptions({ parseCanonicalApproval: canonicalMultiRowLegacyParser });
  const manifest = migration.createLegacyMandateMigrationManifest(path, options);
  expect(migration.migrateLegacyMandates(path, {
    ...options,
    manifest,
    sessionKeyCipher: cipher(),
  })).toEqual({ migrated: 1, quarantined: 1 });
  return { migration, manifest, options };
}

function addSecondRecoverableMigratedMandate(path) {
  const mandateId = '9e8f94a2c16b4e6488bf07b81234abcd';
  const serializedApproval = 'canonical-approval-fixture-two';
  const stellarOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
  const kernelAddress = `0x${'78'.repeat(20)}`;
  const sessionKeyAddress = privateKeyToAccount(SECOND_SESSION_PRIVATE_KEY).address.toLowerCase();
  const policyDigest = 'ee'.repeat(32);
  const bindingId = 'binding-2';
  const record = {
    mandateId,
    approvalDigest: createHash('sha256').update(serializedApproval).digest('hex'),
    policyDigest,
    serializedApproval,
    stellarOwner,
    kernelAddress,
    sessionKeyAddress,
    relayerOrigin: 'https://relayer.example',
    validUntilSeconds: VALID_UNTIL_SECONDS,
    bindingId,
    bindingHash: createHash('sha256')
      .update(`${stellarOwner}|${kernelAddress}|${sessionKeyAddress}|${VALID_UNTIL_SECONDS}`)
      .digest('hex'),
    permissionId: '0x5678abcd',
  };
  const sessionKeyDigest = createHash('sha256').update(SECOND_SESSION_PRIVATE_KEY).digest('hex');
  const sessionKeyEnvelope = cipher().seal(SECOND_SESSION_PRIVATE_KEY, mandateSessionAad(record));
  const db = new DatabaseSync(path);
  try {
    db.prepare(`
      INSERT INTO mandates_v3 (
        mandate_id, approval_digest, policy_digest, serialized_approval, stellar_owner,
        kernel_address, session_key_address, relayer_origin, valid_until_seconds, status,
        binding_id, binding_hash, permission_id, session_key_envelope, session_key_digest,
        capability_hash, activation_user_op_hash, activation_tx_hash, activated_at,
        quarantine_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activation_uncertain', ?, ?, ?, ?, ?,
                NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      record.mandateId, record.approvalDigest, record.policyDigest, record.serializedApproval,
      record.stellarOwner, record.kernelAddress, record.sessionKeyAddress, record.relayerOrigin,
      record.validUntilSeconds, record.bindingId, record.bindingHash, record.permissionId,
      sessionKeyEnvelope, sessionKeyDigest, NOW_SECONDS, NOW_SECONDS,
    );
  } finally {
    db.close();
  }
}

function startConcurrentEnqueueWorker({ path, record, barrier }) {
  const sqliteUrl = pathToFileURL(join(process.cwd(), 'src/sqliteStores.mjs')).href;
  const envelopeUrl = pathToFileURL(join(process.cwd(), 'src/secretEnvelope.mjs')).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createSqliteStores } = await import(workerData.sqliteUrl);
      const { createSecretEnvelope, parseSecretKeyring } = await import(workerData.envelopeUrl);
      const baseCipher = createSecretEnvelope(parseSecretKeyring(workerData.keyring));
      const barrier = new Int32Array(workerData.barrier);
      const barrierCipher = {
        open: (...args) => baseCipher.open(...args),
        seal(...args) {
          const arrivals = Atomics.add(barrier, 0, 1) + 1;
          Atomics.notify(barrier, 0);
          if (arrivals < 2 && Atomics.wait(barrier, 0, arrivals, 5000) === 'timed-out') {
            throw new Error('concurrent enqueue barrier timed out');
          }
          return baseCipher.seal(...args);
        },
      };
      let stores;
      try {
        stores = createSqliteStores(workerData.path, {
          sessionKeyCipher: barrierCipher,
          nowSeconds: () => workerData.nowSeconds,
        });
        const result = stores.mandateActivations.enqueue({ record: workerData.record });
        parentPort.postMessage({
          outcome: 'ok',
          duplicate: result.duplicate,
          mandateId: result.mandate.mandateId,
          workStatus: result.work?.status ?? null,
        });
      } catch (error) {
        parentPort.postMessage({ outcome: 'error', message: String(error?.message || 'unknown error') });
      } finally {
        stores?.db.close();
      }
    })().catch((error) => {
      parentPort.postMessage({ outcome: 'error', message: String(error?.message || 'worker error') });
    });
  `;
  return new Worker(source, {
    eval: true,
    workerData: {
      path,
      record,
      barrier,
      sqliteUrl,
      envelopeUrl,
      nowSeconds: NOW_SECONDS,
      keyring: `active:${Buffer.alloc(32, 0x31).toString('base64')}`,
    },
  });
}

function boundedWorkerResult(worker, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('concurrent enqueue worker timed out'));
    }, timeoutMs);
    worker.once('message', (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`concurrent enqueue worker exited with code ${code}`));
      }
    });
  });
}

async function runConcurrentEnqueues(path, leftRecord, rightRecord) {
  const initialized = createSqliteStores(path, {
    sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
  });
  initialized.db.close();
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = [leftRecord, rightRecord].map((workerRecord) => (
    startConcurrentEnqueueWorker({ path, record: workerRecord, barrier })
  ));
  try {
    return await Promise.all(workers.map((worker) => boundedWorkerResult(worker)));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

function sqliteSnapshot(path) {
  const db = new DatabaseSync(path);
  try {
    return {
      tables: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      v1: tableNames(db).includes('mandates')
        ? db.prepare(`
            SELECT approval, session_key, typeof(expires_at) AS expires_at_type,
                   CAST(expires_at AS TEXT) AS expires_at
            FROM mandates ORDER BY approval
          `).all() : null,
      v2: tableNames(db).includes('mandates_v2')
        ? db.prepare(`
            SELECT serialized_approval, stellar_owner, kernel_address, session_private_key,
                   session_key_address, relayer_origin, typeof(expires_at) AS expires_at_type,
                   CAST(expires_at AS TEXT) AS expires_at, status, binding_id, binding_hash, created_at
            FROM mandates_v2 ORDER BY serialized_approval, stellar_owner, kernel_address
          `).all()
        : null,
      v3: tableNames(db).includes('mandates_v3')
        ? db.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all() : null,
    };
  } finally {
    db.close();
  }
}

function expectNoPlaintextInFile(path, plaintexts) {
  if (!existsSync(path)) return;
  const bytes = readFileSync(path);
  for (const plaintext of plaintexts) {
    expect(bytes.includes(Buffer.from(plaintext))).toBe(false);
  }
}

function expectNoAuthorityFields(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const forbidden = new Set([
    'sessionprivatekey', 'sessionkeydigest', 'session_key_digest',
    'capabilityhash', 'sessionkeyenvelope', 'session_key_envelope',
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') expect(forbidden.has(key.toLowerCase())).toBe(false);
    expectNoAuthorityFields(value[key], seen);
  }
}

function expectOpaqueMandateId(value, legacyAuthority) {
  expect(typeof value).toBe('string');
  expect(value.length).toBeGreaterThan(0);
  for (const authority of legacyAuthority) {
    expect(value).not.toBe(authority);
    expect(value).not.toContain(authority);
  }
}

const executionIdentity = {
  networkId: 'stellar-testnet',
  owner: `G${'A'.repeat(55)}`,
  bindingId: 'binding-1',
  executionId: 'run-1:exec:run-1:bridge:aave-v3',
  allocationId: 'run-1:bridge:aave-v3',
  childId: 'job-1',
};
const recoveryIdentity = {
  networkId: executionIdentity.networkId,
  bindingId: executionIdentity.bindingId,
  executionId: executionIdentity.executionId,
  allocationId: executionIdentity.allocationId,
  childId: executionIdentity.childId,
};
const depositCheckpoint = (status, evidence, observedAt = 2_000_000_000_100) => ({
  identity: recoveryIdentity,
  phase: 'base_deposit',
  status,
  evidence,
  observedAt,
});

function executionReport(sequence, executionStatus = 'accepted') {
  return {
    identity: executionIdentity,
    expectedSequence: sequence - 1,
    lifecycle: {
      sequence,
      status: executionStatus === 'failed' ? 'failed' : 'submitted',
      evidence: { executionStatus },
      observedAt: 2_000_000_000_000 + sequence,
    },
  };
}

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

  it('SURVIVES REOPEN: jobs persist across a new createSqliteStores on the same file', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    first.jobs.set('j1', { status: 'pending', steps: [] });
    first.db.close();
    const second = createSqliteStores(path);
    expect(second.jobs.get('j1').status).toBe('pending');
    second.db.close();
  });

  describe('durable farm execution work', () => {
    const queuedJob = {
      status: 'queued',
      steps: [],
      runId: 'run-1',
      _attach: { jobId: 'job-1', attachedBurnTxHash: null },
    };
    const attachedJob = {
      ...queuedJob,
      status: 'pending',
      _attach: {
        ...queuedJob._attach,
        attachedBurnTxHash: 'burn-1',
        associations: [{ allocationId: executionIdentity.allocationId, terminalSequence: null }],
      },
    };

    it('atomically commits a farm job checkpoint with its Base evidence head and outbox row', () => {
      const stores = createSqliteStores(freshPath(), { now: () => 1000 });
      stores.jobs.set('job-1', queuedJob);
      stores.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
        evidenceHeads: [{ identity: recoveryIdentity, recoveryVersion: 0 }],
      });
      const claimed = stores.farmExecutions.claim({ jobId: 'job-1', now: 1000, leaseMs: 100 });
      const depositing = { ...attachedJob, status: 'depositing' };
      stores.farmExecutions.checkpoint({
        jobId: 'job-1', leaseToken: claimed.leaseToken, job: depositing,
        baseEvidenceReports: [depositCheckpoint('submitting', {
          chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
          caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
          assets: '1000000', minShares: '900000',
        })],
      });
      expect(stores.jobs.get('job-1')).toEqual(depositing);
      expect(stores.baseEvidenceOutbox.status(recoveryIdentity)).toMatchObject({
        recoveryVersion: 1,
        events: [{ state: 'submitting', expectedRecoveryVersion: 0 }],
      });
    });

    it('rolls back job and evidence together when a stale lease or evidence conflict wins', () => {
      const stores = createSqliteStores(freshPath(), { now: () => 1000 });
      stores.jobs.set('job-1', queuedJob);
      stores.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
        evidenceHeads: [{ identity: recoveryIdentity, recoveryVersion: 0 }],
      });
      const claimed = stores.farmExecutions.claim({ jobId: 'job-1', now: 1000, leaseMs: 100 });
      const report = depositCheckpoint('submitting', {
        chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
        caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
        assets: '1000000', minShares: '900000',
      });
      expect(() => stores.farmExecutions.checkpoint({
        jobId: 'job-1', leaseToken: 'stale', job: { ...attachedJob, status: 'bad' },
        baseEvidenceReports: [report],
      })).toThrow(/lease/i);
      expect(stores.jobs.get('job-1')).toEqual(attachedJob);
      expect(stores.baseEvidenceOutbox.status(recoveryIdentity).events).toEqual([]);

      stores.farmExecutions.checkpoint({
        jobId: 'job-1', leaseToken: claimed.leaseToken,
        job: { ...attachedJob, status: 'depositing' }, baseEvidenceReports: [report],
      });
      expect(() => stores.farmExecutions.checkpoint({
        jobId: 'job-1', leaseToken: claimed.leaseToken,
        job: { ...attachedJob, status: 'corrupt' },
        baseEvidenceReports: [{ ...report, evidence: { ...report.evidence, assets: '1000001' } }],
      })).toThrow(/conflict|immutable/i);
      expect(stores.jobs.get('job-1').status).toBe('depositing');
    });

    it('rejects direct SQL mutation or deletion of immutable Base evidence', () => {
      const stores = createSqliteStores(freshPath(), { now: () => 1000 });
      stores.baseEvidenceOutbox.seed(recoveryIdentity, 0, { jobId: 'job-1' });
      stores.baseEvidenceOutbox.enqueue(depositCheckpoint('submitting', {
        chainId: '84532', yieldRouterAddress: `0x${'11'.repeat(20)}`,
        caller: `0x${'22'.repeat(20)}`, poolAddress: `0x${'33'.repeat(20)}`,
        assets: '1000000', minShares: '900000',
      }));

      for (const statement of [
        "UPDATE base_evidence_outbox SET report_json='{}'",
        "UPDATE base_evidence_outbox SET execution_id='other'",
        'UPDATE base_evidence_outbox SET expected_recovery_version=9',
        'DELETE FROM base_evidence_outbox',
      ]) {
        expect(() => stores.db.exec(statement)).toThrow(/immutable|evidence/i);
      }
      expect(stores.baseEvidenceOutbox.status(recoveryIdentity).events).toHaveLength(1);
    });

    // Defect caught: accepted lifecycle insertion, burn attachment, and executable work were
    // three crash-separated writes instead of one SQLite transaction.
    it('atomically persists burn attachment, accepted reports, and pending work', () => {
      const path = freshPath();
      const first = createSqliteStores(path);
      first.jobs.set('job-1', queuedJob);
      expect(first.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
      })).toMatchObject({ duplicate: false, work: { status: 'pending', attempts: 0 } });
      first.db.close();

      const second = createSqliteStores(path);
      expect(second.jobs.get('job-1')).toEqual(attachedJob);
      expect(second.farmExecutions.get('job-1')).toMatchObject({
        jobId: 'job-1', burnTxHash: 'burn-1', status: 'pending', attempts: 0,
      });
      expect(second.associationOutbox.status(recoveryIdentity)).toEqual([{
        allocationId: executionIdentity.allocationId,
        executionId: executionIdentity.executionId,
        sequence: 1,
        status: 'pending',
        attempts: 0,
      }]);
    });

    // Defect caught: an outbox failure could still consume the burn slot and strand a pending job.
    it('rolls back the job and work row when accepted lifecycle enqueue fails', () => {
      const stores = createSqliteStores(freshPath());
      stores.jobs.set('job-1', queuedJob);
      expect(() => stores.farmExecutions.attach({
        jobId: 'job-1',
        burnTxHash: 'burn-1',
        job: attachedJob,
        reports: [executionReport(2)],
      })).toThrow(/sequence|order/i);
      expect(stores.jobs.get('job-1')).toEqual(queuedJob);
      expect(stores.farmExecutions.get('job-1')).toBeNull();
      expect(stores.associationOutbox.status(recoveryIdentity)).toEqual([]);
    });

    // Defect caught: restart had no durable dispatcher-owned claim, while same-hash retries either
    // did nothing or could start a second external flow.
    it('resumes pending work after reopen and grants only one bounded execution lease', () => {
      const path = freshPath();
      const first = createSqliteStores(path);
      first.jobs.set('job-1', queuedJob);
      first.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
      });
      first.db.close();

      const second = createSqliteStores(path);
      const third = createSqliteStores(path);
      expect(second.farmExecutions.listRecoverable({ now: 1000 })).toEqual([
        expect.objectContaining({ jobId: 'job-1', status: 'pending' }),
      ]);
      const claimed = second.farmExecutions.claim({ jobId: 'job-1', now: 1000, leaseMs: 100 });
      expect(claimed).toMatchObject({ status: 'running', attempts: 1, leaseExpiresAt: 1100 });
      expect(() => third.farmExecutions.renew({
        jobId: 'job-1', leaseToken: 'stale-token', now: 1050, leaseMs: 100,
      })).toThrow(/stale|uncertain/i);
      expect(third.farmExecutions.renew({
        jobId: 'job-1', leaseToken: claimed.leaseToken, now: 1050, leaseMs: 100,
      })).toMatchObject({ status: 'running', attempts: 1, leaseExpiresAt: 1150 });
      expect(third.farmExecutions.claim({ jobId: 'job-1', now: 1000, leaseMs: 100 })).toBeNull();
      expect(third.farmExecutions.attach({
        jobId: 'job-1', burnTxHash: 'burn-1', job: attachedJob, reports: [executionReport(1)],
      })).toMatchObject({ duplicate: true, work: { status: 'running', attempts: 1 } });
      expect(third.associationOutbox.status(recoveryIdentity)).toHaveLength(1);
    });
  });

  describe('encrypted mandate v3 persistence', () => {
    it('safely upgrades the exact empty pre-policy v3 schema and creates migration state', () => {
      const path = freshPath();
      createPrePolicyV3(path);
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        const columns = stores.db.prepare('PRAGMA table_info(mandates_v3)').all()
          .map(({ name }) => name);
        expect(columns).toEqual(expect.arrayContaining(['policy_digest', 'session_key_digest']));
        expect(tableNames(stores.db)).toContain('mandate_migration_state');
        expect(stores.probe()).toMatchObject({ mandateMigrationCleanupPending: false });
        expect(stores.mandateActivations.enqueue({ record: mandateRecord() }))
          .toMatchObject({ duplicate: false, mandate: { policyDigest: POLICY_DIGEST } });
        expect(stores.db.prepare(`
          SELECT policy_digest, session_key_digest FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          policy_digest: POLICY_DIGEST, session_key_digest: SESSION_KEY_DIGEST,
        });
      } finally {
        stores.db.close();
      }
    });

    it.each([
      ['nonempty pre-policy', (path) => createPrePolicyV3(path, { withRow: true })],
      ['incompatible', (path) => {
        const db = new DatabaseSync(path);
        db.exec('CREATE TABLE mandates_v3 (mandate_id TEXT PRIMARY KEY)');
        db.close();
      }],
    ])('fails closed for a %s v3 target instead of guessing or backfilling', (_label, seed) => {
      const path = freshPath();
      seed(path);
      const before = sqliteSnapshot(path);
      let opened;
      try {
        expect(() => {
          opened = createSqliteStores(path, {
            sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
          });
        }).toThrow(/schema|upgrade|incompatible|nonempty|policy|digest/i);
      } finally {
        opened?.db.close();
      }
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('creates only the encrypted mandate schema on a fresh database and never writes the raw key', () => {
      const path = freshPath();
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(tableNames(stores.db)).toEqual(expect.arrayContaining([
          'mandates_v3', 'mandate_activation_work',
        ]));
        expect(tableNames(stores.db)).not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));

        stores.mandateActivations.enqueue({ record: mandateRecord() });
        const raw = stores.db.prepare(`
          SELECT session_key_envelope, session_key_digest, capability_hash, policy_digest,
                 valid_until_seconds
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID);
        expect(raw.session_key_envelope).toMatch(/^v1\.active\./);
        expect(raw.session_key_envelope).not.toContain(SESSION_PRIVATE_KEY);
        expect(raw.session_key_digest).toBe(SESSION_KEY_DIGEST);
        expect(raw.capability_hash).toBe(CAPABILITY_HASH);
        expect(raw.policy_digest).toBe(POLICY_DIGEST);
        expect(raw.valid_until_seconds).toBe(VALID_UNTIL_SECONDS);
        const publicStatus = stores.mandatesV3.status(mandateIdentity());
        expect(publicStatus).toMatchObject({
          mandateId: MANDATE_ID,
          policyDigest: POLICY_DIGEST,
          kernelAddress: KERNEL.toLowerCase(),
          sessionKeyAddress: SESSION.toLowerCase(),
        });
        expectNoAuthorityFields(publicStatus);
        expect(readFileSync(path).includes(Buffer.from(SESSION_PRIVATE_KEY))).toBe(false);
      } finally {
        stores.db.close();
      }
    });

    it('rechecks mandate expiry after acquiring the enqueue write lock', () => {
      const path = freshPath();
      const clock = { value: NOW_SECONDS };
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => clock.value,
      });
      const originalExec = DatabaseSync.prototype.exec;
      let lockedBegins = 0;
      try {
        DatabaseSync.prototype.exec = function advanceClockAfterLock(sql) {
          const result = originalExec.call(this, sql);
          if (this === stores.db && String(sql).trim().toUpperCase() === 'BEGIN IMMEDIATE') {
            lockedBegins += 1;
            clock.value = VALID_UNTIL_SECONDS;
          }
          return result;
        };

        let enqueueError;
        try {
          stores.mandateActivations.enqueue({ record: mandateRecord() });
        } catch (error) {
          enqueueError = error;
        }
        expect(lockedBegins).toBe(1);
        expect(enqueueError).toBeInstanceOf(Error);
        expect(enqueueError.message).toMatch(/mandate|expired|expiry/i);
        expect(enqueueError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(enqueueError.message).not.toContain(SESSION_KEY_DIGEST);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(0);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(0);
      } finally {
        DatabaseSync.prototype.exec = originalExec;
        stores.db.close();
      }
    });

    it('survives reopen and grants exactly one activation lease across competing connections', () => {
      const path = freshPath();
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      first.db.close();

      const second = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      const third = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(second.mandateActivations.listRecoverable({ nowSeconds: NOW_SECONDS }))
          .toEqual([expect.objectContaining({ mandateId: MANDATE_ID, status: 'pending' })]);
        const claimed = second.mandateActivations.claim({
          ...mandateIdentity(), nowSeconds: NOW_SECONDS, leaseSeconds: 30,
        });
        expect(claimed).toMatchObject({ status: 'running', attempts: 1 });
        expect(third.mandateActivations.claim({
          ...mandateIdentity(), nowSeconds: NOW_SECONDS, leaseSeconds: 30,
        })).toBeNull();
      } finally {
        second.db.close();
        third.db.close();
      }
    });

    it('normalizes omitted nullable identity metadata across reopen before duplicate comparison', () => {
      const path = freshPath();
      const omitted = mandateRecord();
      delete omitted.relayerOrigin;
      delete omitted.bindingId;
      delete omitted.permissionId;
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: omitted });
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        for (const duplicateRecord of [
          { ...omitted },
          { ...omitted, relayerOrigin: undefined, bindingId: undefined, permissionId: undefined },
          { ...omitted, relayerOrigin: null, bindingId: null, permissionId: null },
        ]) {
          expect(reopened.mandateActivations.enqueue({ record: duplicateRecord }))
            .toMatchObject({
              duplicate: true,
              mandate: { relayerOrigin: null, bindingId: null, permissionId: null },
              work: { status: 'pending', attempts: 0 },
            });
        }
        expect(() => reopened.mandateActivations.enqueue({
          record: { ...omitted, relayerOrigin: 'https://changed-relayer.example' },
        })).toThrow(/immutable|conflict/i);
        expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
        expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(1);
      } finally {
        reopened.db.close();
      }
    });

    it('rotates an envelope encrypted by a previous key when the mandate is read', () => {
      const path = freshPath();
      const previous = Buffer.alloc(32, 0x42);
      const active = Buffer.alloc(32, 0x43);
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher([['previous', previous]]), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      expect(first.db.prepare('SELECT session_key_envelope FROM mandates_v3 WHERE mandate_id = ?')
        .get(MANDATE_ID).session_key_envelope).toMatch(/^v1\.previous\./);
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher([['active', active], ['previous', previous]]),
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(reopened.mandatesV3.get(mandateIdentity()).sessionPrivateKey)
          .toBe(SESSION_PRIVATE_KEY);
        expect(reopened.db.prepare('SELECT session_key_envelope FROM mandates_v3 WHERE mandate_id = ?')
          .get(MANDATE_ID).session_key_envelope).toMatch(/^v1\.active\./);
      } finally {
        reopened.db.close();
      }
    });

    it.each([false, true])('never returns a session key when a concurrent revoke wins during decrypt (rotation=%s)', (needsRotation) => {
      const path = freshPath();
      const previous = Buffer.alloc(32, 0x42);
      const active = Buffer.alloc(32, 0x43);
      const writer = createSqliteStores(path, {
        sessionKeyCipher: cipher([['previous', previous]]), nowSeconds: () => NOW_SECONDS,
      });
      writer.mandateActivations.enqueue({ record: mandateRecord() });
      writer.db.close();

      const activeCipher = cipher([['active', active], ['previous', previous]]);
      const revoker = createSqliteStores(path, {
        sessionKeyCipher: activeCipher, nowSeconds: () => NOW_SECONDS,
      });
      const racingCipher = Object.freeze({
        seal: (...args) => activeCipher.seal(...args),
        open(...args) {
          const opened = activeCipher.open(...args);
          revoker.mandatesV3.revoke(mandateIdentity());
          return { ...opened, needsRotation };
        },
      });
      const reader = createSqliteStores(path, {
        sessionKeyCipher: racingCipher, nowSeconds: () => NOW_SECONDS,
      });
      try {
        const staleRead = reader.mandatesV3.get(mandateIdentity());
        expect(staleRead.sessionPrivateKey).toBeUndefined();
        expect(staleRead.capabilityHash).toBe(CAPABILITY_HASH);
        expect(reader.mandatesV3.status(mandateIdentity()).status).toBe('revoked');
        expect(reader.db.prepare(`
          SELECT status, session_key_envelope, session_key_digest
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'revoked', session_key_envelope: null, session_key_digest: SESSION_KEY_DIGEST,
        });
        expect(reader.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(0);
      } finally {
        reader.db.close();
        revoker.db.close();
      }
    });

    it('renews an activation lease after reopening the durable store', () => {
      const path = freshPath();
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      const claimed = first.mandateActivations.claim({
        ...mandateIdentity(), nowSeconds: NOW_SECONDS, leaseSeconds: 20,
      });
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS + 5,
      });
      try {
        expect(reopened.mandateActivations.renew({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          nowSeconds: NOW_SECONDS + 5, leaseSeconds: 40,
        })).toMatchObject({
          status: 'running', leaseToken: claimed.leaseToken,
          leaseExpiresAt: NOW_SECONDS + 45, attempts: 1,
        });
      } finally {
        reopened.db.close();
      }
    });

    it('rejects an old lease token after reopen reconciliation and reclaim from a second connection', () => {
      const path = freshPath();
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      const original = first.mandateActivations.claim({
        ...mandateIdentity(), nowSeconds: NOW_SECONDS, leaseSeconds: 10,
      });
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS + 10,
      });
      reopened.mandateActivations.reconcileExpired({ nowSeconds: NOW_SECONDS + 10 });
      const reclaimed = reopened.mandateActivations.claim({
        ...mandateIdentity(), nowSeconds: NOW_SECONDS + 10, leaseSeconds: 20,
      });
      const competitor = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS + 11,
      });
      try {
        expect(reclaimed.leaseToken).not.toBe(original.leaseToken);
        expect(() => competitor.mandateActivations.renew({
          ...mandateIdentity(), leaseToken: original.leaseToken,
          nowSeconds: NOW_SECONDS + 11, leaseSeconds: 20,
        })).toThrow(/stale|lease|token/i);
        expect(competitor.mandateActivations.renew({
          ...mandateIdentity(), leaseToken: reclaimed.leaseToken,
          nowSeconds: NOW_SECONDS + 11, leaseSeconds: 20,
        })).toMatchObject({
          status: 'running', attempts: 2, leaseToken: reclaimed.leaseToken,
          leaseExpiresAt: NOW_SECONDS + 31,
        });
      } finally {
        competitor.db.close();
        reopened.db.close();
      }
    });

    it.each([
      ['identical', mandateRecord(), mandateRecord(), false],
      ['conflicting', mandateRecord(), mandateRecord({ capabilityHash: 'cc'.repeat(32) }), true],
    ])('resolves true concurrent %s enqueues atomically without leaking raw SQLite errors', async (
      _label, leftRecord, rightRecord, shouldConflict,
    ) => {
      const path = freshPath();
      const results = await runConcurrentEnqueues(path, leftRecord, rightRecord);
      const errors = results.filter(({ outcome }) => outcome === 'error');
      const successes = results.filter(({ outcome }) => outcome === 'ok');
      for (const result of results) {
        expect(result.message || '').not.toMatch(/SQLITE_BUSY|database is locked|constraint failed/i);
        expect(JSON.stringify(result)).not.toContain(SESSION_PRIVATE_KEY);
        expect(JSON.stringify(result)).not.toContain(SESSION_KEY_DIGEST);
      }
      if (shouldConflict) {
        expect(successes).toHaveLength(1);
        expect(successes[0]).toMatchObject({ duplicate: false, workStatus: 'pending' });
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/immutable|conflict/i);
      } else {
        expect(errors).toEqual([]);
        expect(successes).toHaveLength(2);
        expect(successes.map(({ duplicate }) => duplicate).sort())
          .toEqual([false, true]);
      }

      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(1);
        expect(stores.mandateActivations.get(mandateIdentity()))
          .toMatchObject({ status: 'pending', attempts: 0 });
      } finally {
        stores.db.close();
      }
    });

    it.each([
      ['mandate ID', 'mandate_id', '8d8f94a2c16b4e6488bf07b81234abcd', { mandateId: '8d8f94a2c16b4e6488bf07b81234abcd' }],
      ['approval digest', 'approval_digest', 'cc'.repeat(32), {}],
      ['owner', 'stellar_owner', Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey(), {
        stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey(),
      }],
      ['kernel', 'kernel_address', '0x1234567890abcdef1234567890abcdef12345678', {
        kernelAddress: '0x1234567890abcdef1234567890abcdef12345678',
      }],
      ['session', 'session_key_address', `0x${'34'.repeat(20)}`, {}],
      ['validUntilSeconds', 'valid_until_seconds', VALID_UNTIL_SECONDS + 1, {}],
      ['binding ID', 'binding_id', 'binding-tampered', {}],
    ])('rejects an envelope after authenticated AAD field %s is tampered', (_label, column, value, identityOverride) => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        stores.db.prepare('DELETE FROM mandate_activation_work WHERE mandate_id = ?').run(MANDATE_ID);
        stores.db.prepare(`UPDATE mandates_v3 SET ${column} = ? WHERE mandate_id = ?`)
          .run(value, MANDATE_ID);
        expect(() => stores.mandatesV3.get({ ...mandateIdentity(), ...identityOverride }))
          .toThrow(/encrypted session key envelope|auth|aad/i);
      } finally {
        stores.db.close();
      }
    });

    it('revocation retains only public status plus internal capability auth and wipes ciphertext and work', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        const revoked = stores.mandatesV3.revoke(mandateIdentity());
        const raw = stores.db.prepare(`
          SELECT status, session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID);
        expect(raw).toEqual({
          status: 'revoked', session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST, capability_hash: CAPABILITY_HASH,
        });
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(0);
        const publicStatus = stores.mandatesV3.status(mandateIdentity());
        expectNoAuthorityFields(revoked);
        expectNoAuthorityFields(publicStatus);
        expect(JSON.stringify(publicStatus)).not.toContain(CAPABILITY_HASH);
      } finally {
        stores.db.close();
      }
    });

    it('expiry wipes the encrypted key but retains only a DB-internal session digest for idempotency', () => {
      const clock = { value: NOW_SECONDS };
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => clock.value,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        clock.value = VALID_UNTIL_SECONDS;
        expect(stores.mandatesV3.status(mandateIdentity()).status).toBe('expired');
        expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
        expect(stores.mandateActivations.get(mandateIdentity())).toBeNull();
        expect(stores.db.prepare(`
          SELECT session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
        expectNoAuthorityFields(stores.mandatesV3.status(mandateIdentity()));
        expectNoAuthorityFields(stores.mandateActivations.get(mandateIdentity()));
      } finally {
        stores.db.close();
      }
    });

    it('rolls back the mandate insert when activation-work enqueue fails on the second write', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.db.exec(`
          CREATE TRIGGER fail_activation_work_enqueue
          BEFORE INSERT ON mandate_activation_work
          BEGIN SELECT RAISE(ABORT, 'injected enqueue second-write failure'); END;
        `);
        expect(() => stores.mandateActivations.enqueue({ record: mandateRecord() }))
          .toThrow(/injected enqueue second-write failure/);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(0);
        expect(stores.db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n)
          .toBe(0);
        expect(stores.mandatesV3.status(mandateIdentity()).status).toBe('missing');
      } finally {
        stores.db.close();
      }
    });

    it('rolls back both terminal writes when finishActive fails on whichever write is second', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        const claimed = stores.mandateActivations.claim({
          ...mandateIdentity(), leaseSeconds: 30,
        });
        stores.mandateActivations.checkpoint({
          ...mandateIdentity(), leaseToken: claimed.leaseToken, status: 'submitting',
        });
        stores.mandateActivations.checkpoint({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          status: 'submitted', userOpHash: `0x${'33'.repeat(32)}`,
        });
        stores.db.exec(`
          CREATE TRIGGER fail_finish_if_mandate_is_second
          BEFORE UPDATE OF status ON mandates_v3
          WHEN NEW.status = 'active' AND (
            SELECT status FROM mandate_activation_work WHERE mandate_id = NEW.mandate_id
          ) = 'done'
          BEGIN SELECT RAISE(ABORT, 'injected finish second-write failure'); END;
          CREATE TRIGGER fail_finish_if_work_is_second
          BEFORE UPDATE OF status ON mandate_activation_work
          WHEN NEW.status = 'done' AND (
            SELECT status FROM mandates_v3 WHERE mandate_id = NEW.mandate_id
          ) = 'active'
          BEGIN SELECT RAISE(ABORT, 'injected finish second-write failure'); END;
        `);

        expect(() => stores.mandateActivations.finishActive({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          userOpHash: `0x${'33'.repeat(32)}`,
          txHash: `0x${'44'.repeat(32)}`,
          activatedAt: NOW_SECONDS + 1,
        })).toThrow(/injected finish second-write failure/);
        expect(stores.mandatesV3.status(mandateIdentity()).status).toBe('pending_activation');
        expect(stores.mandateActivations.get(mandateIdentity()))
          .toMatchObject({ status: 'submitted', leaseToken: claimed.leaseToken });
      } finally {
        stores.db.close();
      }
    });

    it('rolls back both receipt-revoke writes when finishRevoked fails on whichever write is second', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        const claimed = stores.mandateActivations.claim({
          ...mandateIdentity(), leaseSeconds: 30,
        });
        stores.mandateActivations.checkpoint({
          ...mandateIdentity(), leaseToken: claimed.leaseToken, status: 'submitting',
        });
        stores.mandateActivations.checkpoint({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          status: 'submitted', userOpHash: `0x${'33'.repeat(32)}`,
        });
        const beforeMandate = stores.db.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?')
          .get(MANDATE_ID);
        const beforeWork = stores.db.prepare(
          'SELECT * FROM mandate_activation_work WHERE mandate_id = ?',
        ).get(MANDATE_ID);
        stores.db.exec(`
          CREATE TRIGGER fail_receipt_revoke_if_mandate_is_second
          BEFORE UPDATE OF status ON mandates_v3
          WHEN NEW.status = 'revoked' AND NOT EXISTS (
            SELECT 1 FROM mandate_activation_work WHERE mandate_id = NEW.mandate_id
          )
          BEGIN SELECT RAISE(ABORT, 'injected receipt-revoke second-write failure'); END;
          CREATE TRIGGER fail_receipt_revoke_if_work_is_second
          BEFORE DELETE ON mandate_activation_work
          WHEN (SELECT status FROM mandates_v3 WHERE mandate_id = OLD.mandate_id) = 'revoked'
          BEGIN SELECT RAISE(ABORT, 'injected receipt-revoke second-write failure'); END;
        `);

        expect(() => stores.mandateActivations.finishRevoked({
          ...mandateIdentity(), leaseToken: claimed.leaseToken,
          userOpHash: `0x${'33'.repeat(32)}`,
          txHash: `0x${'44'.repeat(32)}`,
          activatedAt: NOW_SECONDS + 1,
        })).toThrow(/injected receipt-revoke second-write failure/);
        expect(stores.db.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?')
          .get(MANDATE_ID)).toEqual(beforeMandate);
        expect(stores.db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
          .get(MANDATE_ID)).toEqual(beforeWork);
        expect(stores.mandatesV3.get(mandateIdentity()).sessionPrivateKey)
          .toBe(SESSION_PRIVATE_KEY);
        expect(stores.mandatesV3.get(mandateIdentity()).capabilityHash)
          .toBe(CAPABILITY_HASH);
      } finally {
        stores.db.close();
      }
    });

    it('rolls back both revoke writes when revoke fails on whichever write is second', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        stores.db.exec(`
          CREATE TRIGGER fail_revoke_if_mandate_is_second
          BEFORE UPDATE OF status ON mandates_v3
          WHEN NEW.status = 'revoked' AND NOT EXISTS (
            SELECT 1 FROM mandate_activation_work WHERE mandate_id = NEW.mandate_id
          )
          BEGIN SELECT RAISE(ABORT, 'injected revoke second-write failure'); END;
          CREATE TRIGGER fail_revoke_if_work_is_second
          BEFORE DELETE ON mandate_activation_work
          WHEN (SELECT status FROM mandates_v3 WHERE mandate_id = OLD.mandate_id) = 'revoked'
          BEGIN SELECT RAISE(ABORT, 'injected revoke second-write failure'); END;
        `);

        expect(() => stores.mandatesV3.revoke(mandateIdentity()))
          .toThrow(/injected revoke second-write failure/);
        expect(stores.mandatesV3.status(mandateIdentity()).status).toBe('pending_activation');
        expect(stores.mandatesV3.get(mandateIdentity()).sessionPrivateKey)
          .toBe(SESSION_PRIVATE_KEY);
        expect(stores.mandateActivations.get(mandateIdentity()).status).toBe('pending');
      } finally {
        stores.db.close();
      }
    });

    it('preserves the Task4 policy digest across reopen in public and internal projections', () => {
      const path = freshPath();
      const first = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      first.mandateActivations.enqueue({ record: mandateRecord() });
      first.db.close();

      const reopened = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(reopened.mandatesV3.status(mandateIdentity()).policyDigest).toBe(POLICY_DIGEST);
        expect(reopened.mandatesV3.get(mandateIdentity()).policyDigest).toBe(POLICY_DIGEST);
      } finally {
        reopened.db.close();
      }
    });

    it('revalidates the target ensemble during probe and rejects a direct target trigger', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.db.exec(`
          CREATE TRIGGER unexpected_probe_target_trigger AFTER UPDATE ON mandates_v3
          BEGIN SELECT 1; END
        `);
        expect(() => stores.probe()).toThrow(/schema|ensemble|trigger|readiness|integrity/i);
      } finally {
        stores.db.close();
      }
    });

    it.each([
      ['an auxiliary trigger that mutates mandates', (db) => db.exec(`
        CREATE TABLE auxiliary_events (id INTEGER PRIMARY KEY);
        CREATE TRIGGER auxiliary_events_mutate_mandates AFTER INSERT ON auxiliary_events
        BEGIN UPDATE mandates_v3 SET updated_at = updated_at; END
      `)],
      ['a view over mandates', (db) => db.exec(`
        CREATE VIEW auxiliary_mandate_view AS
        SELECT mandate_id, status FROM mandates_v3
      `)],
      ['an inbound foreign key to mandates', (db) => db.exec(`
        CREATE TABLE auxiliary_mandate_reference (
          id INTEGER PRIMARY KEY,
          mandate_id TEXT REFERENCES mandates_v3(mandate_id)
        )
      `)],
    ])('rejects %s during runtime probe', (_label, mutateSchema) => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        mutateSchema(stores.db);
        expect(() => stores.probe()).toThrow(
          /schema|ensemble|trigger|view|foreign|dependency|readiness|integrity/i,
        );
      } finally {
        stores.db.close();
      }
    });

    it('allows unrelated auxiliary schema during runtime probe', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.db.exec(`
          CREATE TABLE auxiliary_events (id INTEGER PRIMARY KEY, note TEXT);
          CREATE TABLE auxiliary_audit (event_id INTEGER NOT NULL, note TEXT);
          CREATE VIEW auxiliary_event_view AS SELECT id, note FROM auxiliary_events;
          CREATE TRIGGER auxiliary_event_audit AFTER INSERT ON auxiliary_events
          BEGIN
            INSERT INTO auxiliary_audit (event_id, note) VALUES (NEW.id, NEW.note);
          END
        `);
        expect(stores.probe()).toMatchObject({
          writable: true,
          legacyMandateTables: [],
          mandateMigrationCleanupPending: false,
        });
      } finally {
        stores.db.close();
      }
    });

    it('rejects activation work whose parent identity is NULL during runtime probe', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        stores.db.prepare(`
          UPDATE mandates_v3 SET stellar_owner = NULL, kernel_address = NULL
          WHERE mandate_id = ?
        `).run(MANDATE_ID);
        expect(() => stores.probe()).toThrow(/identity|integrity|schema|readiness/i);
      } finally {
        stores.db.close();
      }
    });

    it('accepts activation work whose non-NULL identity matches its parent', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        stores.mandateActivations.enqueue({ record: mandateRecord() });
        expect(stores.probe()).toMatchObject({
          writable: true,
          legacyMandateTables: [],
          mandateMigrationCleanupPending: false,
        });
      } finally {
        stores.db.close();
      }
    });

    it('enables foreign keys so orphan activation work cannot be inserted', () => {
      const stores = createSqliteStores(freshPath(), {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(stores.db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
        expect(() => stores.db.prepare(`
          INSERT INTO mandate_activation_work (
            mandate_id, stellar_owner, kernel_address, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
        `).run('ffffffffffffffffffffffffffffffff', OWNER, KERNEL.toLowerCase(), NOW_SECONDS, NOW_SECONDS))
          .toThrow(/foreign key/i);
      } finally {
        stores.db.close();
      }
    });
  });

  describe('offline plaintext mandate migration', () => {
    it.each([
      ['absent', undefined],
      ['wrong', { RELAYER_OFFLINE_KEY_MIGRATION: '0' }],
    ])('rejects %s offline flag before manifest inspection or migration mutation', async (_label, env) => {
      const path = freshPath();
      expect(existsSync(path)).toBe(false);
      const migration = await migrationLibrary();
      let parserCalls = 0;
      const parseCanonicalApproval = () => { parserCalls += 1; };
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        env, parseCanonicalApproval,
      })))
        .toThrow(/RELAYER_OFFLINE_KEY_MIGRATION|offline/i);
      expect(existsSync(path)).toBe(false);
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        env, parseCanonicalApproval, sessionKeyCipher: cipher(),
        manifest: { version: 1, sourceDigest: '00', entries: [] },
      }))).toThrow(/RELAYER_OFFLINE_KEY_MIGRATION|offline/i);
      expect(existsSync(path)).toBe(false);
      expect(parserCalls).toBe(0);
    });

    it('uses memory-only SQLite temp storage before every migration connection reads schema or source data', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      let stage = 'manifest';
      const observer = observeMigrationTempStore(path, () => stage);
      let manifest;
      let interrupted;
      let resumed;
      try {
        manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        stage = 'migration';
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher: cipher(),
            migrationHooks: {
              afterDestructiveCommit() {
                throw new Error(`interrupt cleanup after commit ${SESSION_PRIVATE_KEY}`);
              },
            },
          }));
        } catch (error) {
          interrupted = error;
        }
        stage = 'cleanup-resume';
        resumed = migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(),
        }));
      } finally {
        observer.restore();
      }

      expect(manifest.entries).toHaveLength(1);
      expect(interrupted).toBeInstanceOf(Error);
      expect(interrupted.message).toBe('offline mandate migration cleanup is pending');
      expect(interrupted.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(resumed).toMatchObject({ resumedCleanup: true });
      expect(new Set(observer.state.observations.map(({ stage: value }) => value)))
        .toEqual(new Set(['manifest', 'migration', 'cleanup-resume']));
      expect(observer.state.observations.length).toBeGreaterThanOrEqual(3);
      for (const observation of observer.state.observations) {
        expect(observation.mode, `${observation.stage}: ${observation.firstQuery}`).toBe(2);
      }
    });

    describe('migration envelope recoverability', () => {
      it.each([
        ['empty seal output', 'empty-envelope', false, 1],
        ['malformed seal output', 'malformed-envelope', false, 1],
        ['unopenable seal output', 'unopenable-envelope', false, 1],
        ['wrong plaintext on immediate open', 'wrong-immediate-plaintext', false, 1],
        ['open failure on post-insert reread', 'post-insert-open-failure', true, 2],
        ['wrong plaintext on post-insert reread', 'post-insert-wrong-plaintext', true, 2],
      ])('rolls back without deleting plaintext for %s', async (
        _label,
        mode,
        requirePersistedReread,
        expectedOpenCalls,
      ) => {
        const path = freshPath();
        createLegacyV2(path);
        createMigrationVerificationTarget(path);
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        const before = sqliteSnapshot(path);
        const persistedReadObserver = observePersistedMandateEnvelopeReads();
        const sessionKeyCipher = migrationVerificationCipher(mode, {
          persistedEnvelopeWasRead: () => persistedReadObserver.state.reads > 0,
        });
        let migrationError;

        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher,
          }));
        } catch (error) {
          migrationError = error;
        } finally {
          persistedReadObserver.restore();
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(
          /^legacy mandate (?:encryption(?: verification)?|migration verification) failed$/,
        );
        expect(sessionKeyCipher.state.sealCalls).toBe(1);
        expect(sessionKeyCipher.state.openCalls).toBe(expectedOpenCalls);
        if (requirePersistedReread) {
          expect(persistedReadObserver.state.reads).toBeGreaterThanOrEqual(1);
          expect(persistedReadObserver.state.envelope).toBe(sessionKeyCipher.state.sealedEnvelope);
          expect(sessionKeyCipher.state.openedEnvelopes[1]).toBe(persistedReadObserver.state.envelope);
        }
        for (const sensitiveValue of [
          SESSION_PRIVATE_KEY,
          WRONG_SESSION_PRIVATE_KEY,
          SESSION_KEY_DIGEST,
          APPROVAL,
          CAPABILITY_HASH,
          sessionKeyCipher.state.sealedEnvelope,
        ]) {
          if (sensitiveValue) expect(migrationError.message).not.toContain(sensitiveValue);
        }
        expectLosslessMigrationRollback(path, before);
      });
    });

    describe('canonical destination manifest digest', () => {
      it('emits a stable lowercase digest without copying destination authority into the manifest', async () => {
        const path = freshPath();
        createLegacyV2(path);
        const migration = await migrationLibrary();
        const policyDigest = 'ab'.repeat(32);
        const parseCanonicalApproval = (params) => ({
          ...canonicalLegacyParser(params),
          policyDigest,
        });

        const first = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
          parseCanonicalApproval,
        }));
        const second = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
          parseCanonicalApproval,
        }));
        const entry = first.entries[0];

        expect(entry).toMatchObject({
          rowDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          outcome: 'migrate',
          destinationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(second.entries[0].destinationDigest).toBe(entry.destinationDigest);
        expect(first.sourceDigest).toBe(second.sourceDigest);
        expectNoAuthorityFields(first);
        const serializedManifest = JSON.stringify(first);
        for (const forbidden of [
          SESSION_PRIVATE_KEY,
          SESSION_KEY_DIGEST,
          APPROVAL,
          APPROVAL_DIGEST,
          CAPABILITY_HASH,
          'serializedApproval',
          'approvalDigest',
          'sessionKeyEnvelope',
          'session_key_envelope',
        ]) {
          expect(serializedManifest).not.toContain(forbidden);
        }
      });

      it('rejects a canonical destination changed only during the locked rescan before sealing', async () => {
        const path = freshPath();
        createLegacyV2(path);
        const migration = await migrationLibrary();
        const preflightPolicyDigest = 'ab'.repeat(32);
        const lockedPolicyDigest = 'cd'.repeat(32);
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
          parseCanonicalApproval(params) {
            return { ...canonicalLegacyParser(params), policyDigest: preflightPolicyDigest };
          },
        }));
        const stableDestinationDigest = manifest.entries[0].destinationDigest;
        const before = sqliteSnapshot(path);
        let activePolicyDigest = preflightPolicyDigest;
        let parserCalls = 0;
        let afterPreflightCalls = 0;
        let sealCalls = 0;
        const envelopeCipher = cipher();
        let migrationError;

        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            parseCanonicalApproval(params) {
              parserCalls += 1;
              return {
                ...canonicalLegacyParser(params),
                policyDigest: activePolicyDigest,
              };
            },
            migrationHooks: {
              afterPreflight() {
                afterPreflightCalls += 1;
                activePolicyDigest = lockedPolicyDigest;
              },
            },
            sessionKeyCipher: {
              open: (...args) => envelopeCipher.open(...args),
              seal(...args) {
                sealCalls += 1;
                return envelopeCipher.seal(...args);
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/destination|manifest|agreement|stale|changed/i);
        expect(afterPreflightCalls).toBe(1);
        expect(parserCalls).toBeGreaterThanOrEqual(2);
        expect(sealCalls).toBe(0);
        expect(manifest.entries[0].destinationDigest).toBe(stableDestinationDigest);
        for (const sensitiveValue of [
          SESSION_PRIVATE_KEY,
          SESSION_KEY_DIGEST,
          APPROVAL,
          CAPABILITY_HASH,
          preflightPolicyDigest,
          lockedPolicyDigest,
        ]) {
          expect(migrationError.message).not.toContain(sensitiveValue);
        }
        expect(sqliteSnapshot(path)).toStrictEqual(before);
      });
    });

    describe('migration target ensemble validation', () => {
      const topologyCases = [
        ['orphan work table without v3', (path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          db.exec('PRAGMA foreign_keys=OFF; DROP TABLE mandates_v3;');
          db.close();
        }],
        ['clean marker-only layout', (path) => createMarkerOnlyLayout(path, { phase: 'virgin' })],
        ['pending marker-only layout', (path) => createMarkerOnlyLayout(path, {
          phase: 'cleanup_pending',
        })],
        ['malformed pending marker-only layout', (path) => createMarkerOnlyLayout(path, {
          phase: 'cleanup_pending', idCheck: '', phaseCheck: '', metadataCheck: '',
        })],
        ['empty v3 with orphan activation work', (path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          db.exec('PRAGMA foreign_keys=OFF');
          insertActivationWork(db, { mandateId: 'missing-parent' });
          db.close();
        }],
        ['v3 with a hidden generated column', (path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          db.exec(`
            ALTER TABLE mandates_v3
            ADD COLUMN hidden_probe TEXT GENERATED ALWAYS AS (lower(status)) VIRTUAL
          `);
          db.close();
        }],
        ['v3 with an unexpected trigger', (path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          db.exec(`
            CREATE TRIGGER unexpected_mandate_trigger AFTER INSERT ON mandates_v3
            BEGIN SELECT 1; END
          `);
          db.close();
        }],
      ];

      const workMetadataCases = [
        ['missing work status CHECK', { statusCheck: '' }],
        ['altered work status CHECK', {
          statusCheck: "CHECK (status IN ('pending','running','submitting','submitted','done','uncertain','bypass'))",
        }],
        ['missing attempts DEFAULT', { attemptsDefault: '' }],
        ['missing work foreign key', { foreignKey: '' }],
      ];

      const stateInvariantCases = [
        ['missing state CHECK constraints', {
          idCheck: '', phaseCheck: '', metadataCheck: '', rows: [VIRGIN_MIGRATION_MARKER_ROW],
        }],
        ['altered singleton CHECK', {
          idCheck: 'CHECK (id IN (1, 2))', rows: [VIRGIN_MIGRATION_MARKER_ROW],
        }],
        ['missing singleton row', { rows: [] }],
        ['extra marker row', {
          idCheck: 'CHECK (id IN (1, 2))',
          rows: [VIRGIN_MIGRATION_MARKER_ROW, [2, ...VIRGIN_MIGRATION_MARKER_ROW.slice(1)]],
        }],
        ['invalid phase', {
          phaseCheck: "CHECK (phase IN ('virgin','cleanup_pending','completed','malformed'))",
          metadataCheck: `${CANONICAL_MIGRATION_MARKER_METADATA_CHECK.slice(0, -1)}
            OR phase = 'malformed')`,
          rows: [boundMigrationMarkerRow({ phase: 'malformed' })],
        }],
      ];

      async function expectFreshLayoutRejected(setupTarget) {
        const path = freshPath();
        createLegacyV2(path);
        setupTarget(path);
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        const before = migrationTargetSnapshot(path);
        const envelopeCipher = cipher();
        let sealCalls = 0;
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher: {
              open: (...args) => envelopeCipher.open(...args),
              seal(...args) {
                sealCalls += 1;
                return envelopeCipher.seal(...args);
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        }
        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/target|schema|ensemble|marker|integrity|migration/i);
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(migrationError.message).not.toContain(APPROVAL);
        expect(sealCalls).toBe(0);
        expect(migrationTargetSnapshot(path)).toStrictEqual(before);
      }

      it.each(topologyCases)('rejects %s before sealing or mutation', async (_label, setupTarget) => {
        await expectFreshLayoutRejected(setupTarget);
      });

      it.each(workMetadataCases)('rejects %s with otherwise identical columns', async (_label, mutation) => {
        await expectFreshLayoutRejected((path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          replaceActivationWorkSchema(db, mutation);
          db.close();
        });
      });

      it.each(stateInvariantCases)('rejects %s before sealing or mutation', async (_label, mutation) => {
        await expectFreshLayoutRejected((path) => {
          const db = new DatabaseSync(path);
          db.exec(MANDATE_V3_SCHEMA);
          replaceMigrationStateSchema(db, mutation);
          db.close();
        });
      });

      it('accepts the exact empty canonical target ensemble', async () => {
        const path = freshPath();
        createLegacyV2(path);
        const db = new DatabaseSync(path);
        db.exec(MANDATE_V3_SCHEMA);
        db.close();
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        expect(migration.migrateLegacyMandates(path, migrationOptions({
          manifest, sessionKeyCipher: cipher(),
        }))).toMatchObject({ migrated: 1, quarantined: 0 });
      });

      it.each([
        ['orphan work row', ({ db }) => {
          db.exec('PRAGMA foreign_keys=OFF');
          insertActivationWork(db, { mandateId: 'missing-parent' });
        }],
        ['parent identity mismatch', ({ db, mandateId }) => insertActivationWork(db, {
          mandateId,
          stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey(),
        })],
      ])('rejects cleanup resume with %s and keeps the pending marker', async (_label, corrupt) => {
        const path = freshPath();
        const migration = await seedPendingMigrationCleanup(path);
        const db = new DatabaseSync(path);
        const mandateId = db.prepare('SELECT mandate_id FROM mandates_v3').get().mandate_id;
        corrupt({ db, mandateId });
        db.close();
        const before = migrationTargetSnapshot(path);
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({ sessionKeyCipher: cipher() }));
        } catch (error) {
          migrationError = error;
        }
        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/target|schema|ensemble|integrity|foreign|identity/i);
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(migrationTargetSnapshot(path)).toStrictEqual(before);
        expect(before.state).toEqual([
          expect.objectContaining({ id: 1, phase: 'cleanup_pending' }),
        ]);
      });
    });

    describe('migration cleanup marker ordering', () => {
      it.each([
        ['throwing hook', () => { throw new Error(`hook detail ${SESSION_PRIVATE_KEY}`); }],
        ['thenable hook', () => Promise.resolve('must not be awaited')],
      ])('keeps cleanup pending when the synchronous beforeMarkerClear %s interrupts', async (
        _label,
        hookResult,
      ) => {
        const path = freshPath();
        const migration = await seedPendingMigrationCleanup(path);
        let hookArgs;
        let markerAtHook;
        let plaintextPresentAtHook;
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            sessionKeyCipher: cipher(),
            migrationHooks: {
              beforeMarkerClear(...args) {
                hookArgs = args;
                const inspection = new DatabaseSync(path, { readOnly: true });
                markerAtHook = inspection.prepare(`
                  SELECT phase FROM mandate_migration_state WHERE id = 1
                `).get()?.phase;
                inspection.close();
                plaintextPresentAtHook = [path, `${path}-wal`, `${path}-journal`].some((artifact) => (
                  existsSync(artifact)
                  && readFileSync(artifact).includes(Buffer.from(SESSION_PRIVATE_KEY))
                ));
                return hookResult();
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toBe('offline mandate migration cleanup is pending');
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(hookArgs).toEqual([]);
        expect(markerAtHook).toBe('cleanup_pending');
        expect(plaintextPresentAtHook).toBe(false);
        const pending = new DatabaseSync(path, { readOnly: true });
        expect(pending.prepare(`
          SELECT phase FROM mandate_migration_state WHERE id = 1
        `).get()).toEqual({ phase: 'cleanup_pending' });
        pending.close();
        expect(migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(),
        }))).toMatchObject({ resumedCleanup: true });
      });

      it.each([
        ['missing singleton', (db) => db.prepare('DELETE FROM mandate_migration_state WHERE id = 1').run()],
        ['malformed singleton', (db) => {
          db.exec('PRAGMA ignore_check_constraints=ON');
          db.prepare("UPDATE mandate_migration_state SET phase = 'malformed' WHERE id = 1").run();
        }],
      ])('does not report cleanup success when the marker becomes a %s before clear', async (
        _label,
        corruptMarker,
      ) => {
        const path = freshPath();
        const migration = await seedPendingMigrationCleanup(path);
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            sessionKeyCipher: cipher(),
            migrationHooks: {
              beforeMarkerClear() {
                const db = new DatabaseSync(path);
                corruptMarker(db);
                db.close();
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        }
        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toBe('offline mandate migration cleanup is pending');
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        const db = new DatabaseSync(path, { readOnly: true });
        const marker = db.prepare(`
          SELECT phase FROM mandate_migration_state WHERE id = 1
        `).get();
        db.close();
        if (_label === 'missing singleton') expect(marker).toBeUndefined();
        else expect(marker).toEqual({ phase: 'malformed' });
      });
    });

    describe('cleanup resume envelope verification', () => {
      it('rotates every persisted envelope to the active key before completing cleanup', async () => {
        const path = freshPath();
        const previousKey = Buffer.alloc(32, 0x42);
        const activeKey = Buffer.alloc(32, 0x43);
        const previousOnly = cipher([['previous', previousKey]]);
        const { migration, options } = await seedBoundPendingMigrationCleanup(path, {
          sessionKeyCipher: previousOnly,
        });
        const rotatingCipher = cipher([['active', activeKey], ['previous', previousKey]]);

        expect(migration.migrateLegacyMandates(path, {
          ...options,
          sessionKeyCipher: rotatingCipher,
        })).toMatchObject({ resumedCleanup: true });

        const persisted = new DatabaseSync(path, { readOnly: true });
        let migratedRows;
        try {
          migratedRows = persisted.prepare(`
            SELECT mandate_id, serialized_approval, stellar_owner, kernel_address,
                   session_key_envelope
            FROM mandates_v3 ORDER BY mandate_id
          `).all();
          expect(migratedRows).toHaveLength(2);
          expect(migratedRows.every(({ session_key_envelope: envelope }) => (
            typeof envelope === 'string' && envelope.startsWith('v1.active.')
          ))).toBe(true);
          expect(persisted.prepare(`
            SELECT phase FROM mandate_migration_state WHERE id = 1
          `).get()).toEqual({ phase: 'completed' });
        } finally {
          persisted.close();
        }

        const activeOnly = createSqliteStores(path, {
          sessionKeyCipher: cipher([['active', activeKey]]),
          nowSeconds: () => NOW_SECONDS,
        });
        try {
          const expectedKeys = new Map([
            [APPROVAL, SESSION_PRIVATE_KEY],
            ['canonical-approval-fixture-two', SECOND_SESSION_PRIVATE_KEY],
          ]);
          for (const row of migratedRows) {
            const internal = activeOnly.mandatesV3.get({
              mandateId: row.mandate_id,
              stellarOwner: row.stellar_owner,
              kernelAddress: row.kernel_address,
            });
            expect(internal.sessionPrivateKey).toBe(expectedKeys.get(row.serialized_approval));
          }
        } finally {
          activeOnly.db.close();
        }
      });

      it('rolls back cleanup rotation and keeps the pending marker when a replacement cannot be sealed', async () => {
        const path = freshPath();
        const previousKey = Buffer.alloc(32, 0x42);
        const activeKey = Buffer.alloc(32, 0x43);
        const { migration, options } = await seedBoundPendingMigrationCleanup(path, {
          sessionKeyCipher: cipher([['previous', previousKey]]),
        });
        const before = migrationTargetSnapshot(path);
        const baseCipher = cipher([['active', activeKey], ['previous', previousKey]]);
        let sealCalls = 0;
        let cleanupError;
        try {
          migration.migrateLegacyMandates(path, {
            ...options,
            sessionKeyCipher: {
              open: (...args) => baseCipher.open(...args),
              seal(...args) {
                sealCalls += 1;
                if (sealCalls === 2) {
                  throw new Error(`replacement seal exposed ${SECOND_SESSION_PRIVATE_KEY}`);
                }
                return baseCipher.seal(...args);
              },
            },
          });
        } catch (error) {
          cleanupError = error;
        }

        expect(sealCalls).toBe(2);
        expect(cleanupError).toBeInstanceOf(Error);
        expect(cleanupError.message).toBe('offline mandate migration cleanup is pending');
        for (const sensitiveValue of [
          SESSION_PRIVATE_KEY,
          SECOND_SESSION_PRIVATE_KEY,
          ...before.mandates.map(({ session_key_envelope: envelope }) => envelope),
        ]) {
          expect(cleanupError.message).not.toContain(sensitiveValue);
        }
        expect(migrationTargetSnapshot(path)).toStrictEqual(before);
        expect(before.state).toEqual([
          expect.objectContaining({ phase: 'cleanup_pending' }),
        ]);
      });

      it.each([
        ['missing cipher', null],
        ['second envelope open failure', 'throw-second'],
        ['wrong plaintext from second envelope', 'wrong-second'],
      ])('rejects %s before cleanup and leaves the marker pending', async (_label, mode) => {
        const path = freshPath();
        const { migration, options } = await seedBoundPendingMigrationCleanup(path);
        const before = migrationTargetSnapshot(path);
        const targetTables = before.objects
          .filter(({ type }) => type === 'table')
          .map(({ name }) => name.toLowerCase())
          .sort();
        expect(targetTables).toEqual([
          'mandate_activation_work', 'mandate_migration_state', 'mandates_v3',
        ]);
        expect(before.mandates).toHaveLength(2);
        expect(before.mandates.every(({ status }) => status === 'activation_uncertain')).toBe(true);
        expect(before.work).toEqual([]);
        expect(before.state).toEqual([
          expect.objectContaining({ id: 1, phase: 'cleanup_pending' }),
        ]);

        const envelopeCipher = cipher();
        let openCalls = 0;
        const sessionKeyCipher = mode === null ? undefined : {
          seal: (...args) => envelopeCipher.seal(...args),
          open(...args) {
            openCalls += 1;
            if (openCalls === 2 && mode === 'throw-second') {
              throw new Error(`corrupt cleanup envelope ${SECOND_SESSION_PRIVATE_KEY}`);
            }
            if (openCalls === 2 && mode === 'wrong-second') {
              return { plaintext: WRONG_SESSION_PRIVATE_KEY, needsRotation: false };
            }
            return envelopeCipher.open(...args);
          },
        };
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, { ...options, sessionKeyCipher });
        } catch (error) {
          migrationError = error;
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/cipher|encryption|verification|cleanup|migration/i);
        for (const sensitiveValue of [
          SESSION_PRIVATE_KEY,
          SECOND_SESSION_PRIVATE_KEY,
          WRONG_SESSION_PRIVATE_KEY,
          ...before.mandates.map(({ session_key_envelope: envelope }) => envelope),
        ]) {
          expect(migrationError.message).not.toContain(sensitiveValue);
        }
        if (mode !== null) expect(openCalls).toBe(2);
        expect(migrationTargetSnapshot(path)).toStrictEqual(before);
      });

      it('opens every persisted uncertain envelope before a valid cleanup resume succeeds', async () => {
        const path = freshPath();
        const { migration, options } = await seedBoundPendingMigrationCleanup(path);
        const envelopeCipher = cipher();
        let openCalls = 0;
        const openedEnvelopes = new Set();
        expect(migration.migrateLegacyMandates(path, {
          ...options,
          sessionKeyCipher: {
            seal: (...args) => envelopeCipher.seal(...args),
            open(...args) {
              openCalls += 1;
              openedEnvelopes.add(args[0]);
              return envelopeCipher.open(...args);
            },
          },
        })).toMatchObject({ resumedCleanup: true });
        expect(openCalls).toBeGreaterThanOrEqual(2);
        const expectedEnvelopes = new DatabaseSync(path, { readOnly: true });
        const persistedEnvelopes = expectedEnvelopes.prepare(`
          SELECT session_key_envelope FROM mandates_v3 ORDER BY mandate_id
        `).all().map(({ session_key_envelope: envelope }) => envelope);
        expectedEnvelopes.close();
        expect(openedEnvelopes).toEqual(new Set(persistedEnvelopes));
        const db = new DatabaseSync(path, { readOnly: true });
        expect(db.prepare(`
          SELECT phase FROM mandate_migration_state WHERE id = 1
        `).get()).toEqual({ phase: 'completed' });
        db.close();
      });
    });

    describe('persisted destination digest verification', () => {
      it.each([
        ['binding hash', (row) => ({ ...row, binding_hash: 'bb'.repeat(32) })],
        ['relayer origin', (row) => ({ ...row, relayer_origin: 'https://changed.example' })],
        ['policy and permission', (row) => ({
          ...row, policy_digest: 'ab'.repeat(32), permission_id: '0xdeadbeef',
        })],
        ['normalized addresses', (row) => ({
          ...row, kernel_address: `0x${'12'.repeat(20)}`, session_key_address: `0x${'34'.repeat(20)}`,
        })],
        ['expiry', (row) => ({ ...row, valid_until_seconds: VALID_UNTIL_SECONDS + 1 })],
        ['session digest', (row) => ({ ...row, session_key_digest: 'bc'.repeat(32) })],
        ['fixed status and null fields', (row) => ({
          ...row,
          status: 'active',
          capability_hash: CAPABILITY_HASH,
          activation_user_op_hash: '0xunexpected',
          activation_tx_hash: '0xunexpected',
          activated_at: NOW_SECONDS,
          quarantine_reason: 'UNEXPECTED',
        })],
      ])('rolls back when persisted %s diverges from the locked destination', async (
        _label,
        transformRow,
      ) => {
        const path = freshPath();
        createLegacyV2(path);
        createMigrationVerificationTarget(path);
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        const before = sqliteSnapshot(path);
        const persistedReadObserver = observePersistedMandateEnvelopeReads({ transformRow });
        const envelopeCipher = cipher();
        let sealCalls = 0;
        let openCalls = 0;
        let migrationError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher: {
              seal(...args) {
                sealCalls += 1;
                return envelopeCipher.seal(...args);
              },
              open(...args) {
                openCalls += 1;
                return envelopeCipher.open(...args);
              },
            },
          }));
        } catch (error) {
          migrationError = error;
        } finally {
          persistedReadObserver.restore();
        }

        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError.message).toMatch(/destination|verification|migration/i);
        expect(migrationError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(migrationError.message).not.toContain(APPROVAL);
        expect(sealCalls).toBe(1);
        expect(persistedReadObserver.state.reads).toBeGreaterThanOrEqual(1);
        expect(openCalls).toBe(1);
        expectLosslessMigrationRollback(path, before);
      });
    });

    it('passes the full Task4 parser input and migrates a seconds-bound legacy row', async () => {
      const path = freshPath();
      const legacy = createLegacyV2(path);
      const seen = [];
      const migration = await migrationLibrary();
      const parseCanonicalApproval = (params) => {
        seen.push(params);
        return canonicalLegacyParser(params);
      };
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        parseCanonicalApproval,
      }));
      migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), parseCanonicalApproval, manifest,
      }));

      const { permissionId, ...requiredParserInput } = seen[0];
      expect(requiredParserInput).toStrictEqual({
        serializedApproval: APPROVAL,
        sessionPrivateKey: SESSION_PRIVATE_KEY,
        sessionKeyAddress: SESSION,
        stellarOwner: OWNER,
        kernelAddress: KERNEL,
        validUntilSeconds: VALID_UNTIL_SECONDS,
        expiresAt: VALID_UNTIL_SECONDS,
        relayerOrigin: 'https://relayer.example',
        bindingId: 'binding-1',
        bindingHash: BINDING_HASH,
        config: TASK4_CONFIG,
      });
      expect(permissionId).toBeUndefined();
      expect(legacy.expiresAt).toBe(VALID_UNTIL_SECONDS * 1000);

      const db = new DatabaseSync(path);
      try {
        const migrated = db.prepare(`
          SELECT mandate_id, approval_digest, policy_digest, serialized_approval, stellar_owner,
                 relayer_origin, binding_id, valid_until_seconds, binding_hash, status,
                 capability_hash, session_key_envelope, session_key_digest,
                 kernel_address, session_key_address
          FROM mandates_v3
        `).get();
        expect(migrated).toMatchObject({
          approval_digest: APPROVAL_DIGEST,
          policy_digest: POLICY_DIGEST,
          valid_until_seconds: VALID_UNTIL_SECONDS,
          binding_hash: NORMALIZED_BINDING_HASH,
          status: 'activation_uncertain',
          capability_hash: null,
          session_key_digest: SESSION_KEY_DIGEST,
          kernel_address: KERNEL.toLowerCase(),
          session_key_address: SESSION.toLowerCase(),
        });
        expectOpaqueMandateId(migrated.mandate_id, [
          APPROVAL, APPROVAL_DIGEST, OWNER, KERNEL, SESSION, SESSION_PRIVATE_KEY,
          BINDING_HASH, 'binding-1',
        ]);
        expect(migrated.session_key_envelope).toMatch(/^v1\.active\./);
        expect(() => canonicalLegacyParser({
          serializedApproval: migrated.serialized_approval,
          sessionPrivateKey: SESSION_PRIVATE_KEY,
          sessionKeyAddress: migrated.session_key_address,
          stellarOwner: migrated.stellar_owner,
          kernelAddress: migrated.kernel_address,
          validUntilSeconds: migrated.valid_until_seconds,
          expiresAt: migrated.valid_until_seconds,
          relayerOrigin: migrated.relayer_origin,
          bindingId: migrated.binding_id,
          bindingHash: migrated.binding_hash,
          config: TASK4_CONFIG,
        })).not.toThrow();
        expect(tableNames(db)).not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));
      } finally {
        db.close();
      }
    });

    it.each([
      ['REAL expiry', { expiresAt: (VALID_UNTIL_SECONDS * 1000) + 0.5 }],
      ['text expiry', { expiresAt: 'not-an-expiry' }],
      ['unsafe expiry', { expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
      ['non-divisible expiry', { expiresAt: (VALID_UNTIL_SECONDS * 1000) + 1 }],
      ['missing binding ID', { bindingId: null }],
      ['missing binding hash', { bindingHash: null }],
      ['millisecond-derived binding hash', {
        bindingHash: createHash('sha256')
          .update(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL_SECONDS * 1000}`)
          .digest('hex'),
      }],
      ['mismatched binding hash', { bindingHash: 'cc'.repeat(32) }],
    ])('fails losslessly for a v2 row with %s', async (_label, override) => {
      const path = freshPath();
      createLegacyV2(path, override);
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions()))
        .toThrow(/canonical|expiry|binding|safe|integer|legacy/i);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('fails losslessly for an approval-only v1 plaintext row', async () => {
      const path = freshPath();
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE mandates (approval TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO mandates (approval, session_key, expires_at) VALUES (?, ?, ?)')
        .run(APPROVAL, SESSION_PRIVATE_KEY, VALID_UNTIL_SECONDS * 1000);
      db.close();
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions()))
        .toThrow(/v1|identity|binding|legacy/i);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('default migration preflights every row and leaves a valid-first invalid-second database byte-for-byte logical unchanged', async () => {
      const path = freshPath();
      const valid = createLegacyV2(path);
      const invalidKey = `0x${'55'.repeat(32)}`;
      const invalid = createLegacyV2(path, {
        serializedApproval: 'invalid-approval',
        stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey(),
        kernelAddress: '0x1234567890AbcdEF1234567890aBcdef12345678',
        sessionPrivateKey: invalidKey,
        sessionKeyAddress: privateKeyToAccount(invalidKey).address,
      });
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      const envelope = cipher();
      let sealCalls = 0;
      const sessionKeyCipher = Object.freeze({
        seal(...args) {
          sealCalls += 1;
          return envelope.seal(...args);
        },
        open: (...args) => envelope.open(...args),
      });
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher,
      }))).toThrow(/canonical|invalid/i);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
      expect(sqliteSnapshot(path).v2.map((row) => row.session_private_key))
        .toEqual([invalid.sessionPrivateKey, valid.sessionPrivateKey].sort());
    });

    it('migrates a pre-capability active row once as uncertain with encrypted key and no runnable work', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), manifest,
      }));
      const raw = new DatabaseSync(path);
      const migratedId = raw.prepare('SELECT mandate_id FROM mandates_v3').get().mandate_id;
      raw.close();
      const migratedIdentity = { mandateId: migratedId, stellarOwner: OWNER, kernelAddress: KERNEL };
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(stores.mandatesV3.status(migratedIdentity)).toMatchObject({
          status: 'activation_uncertain', policyDigest: POLICY_DIGEST,
        });
        expect(stores.mandateActivations.get(migratedIdentity)).toBeNull();
        const internal = stores.mandatesV3.get(migratedIdentity);
        expect(internal.sessionPrivateKey).toBe(SESSION_PRIVATE_KEY);
        expect(internal.capabilityHash).toBeUndefined();
        expect(internal.policyDigest).toBe(POLICY_DIGEST);
        expect(Reflect.ownKeys(internal)).not.toContain('sessionKeyDigest');
        expect(Reflect.ownKeys(internal)).not.toContain('session_key_digest');
        expect(migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(), manifest,
        }))).toEqual({ alreadyMigrated: true, migrated: 1, quarantined: 0 });
      } finally {
        stores.db.close();
      }
    });

    it('migrates a legitimate legacy revoked row as a non-runnable public tombstone without parsing or retaining authority', async () => {
      const path = freshPath();
      createLegacyV2(path, { status: 'revoked' });
      const migration = await migrationLibrary();
      let parserCalls = 0;
      const parseCanonicalApproval = () => {
        parserCalls += 1;
        throw new Error('revoked authority must never be parsed');
      };
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        parseCanonicalApproval,
      }));
      migration.migrateLegacyMandates(path, migrationOptions({
        parseCanonicalApproval, sessionKeyCipher: cipher(), manifest,
      }));
      expect(parserCalls).toBe(0);

      const db = new DatabaseSync(path);
      try {
        expect(db.prepare('SELECT * FROM mandates_v3').get()).toMatchObject({
          approval_digest: APPROVAL_DIGEST,
          stellar_owner: OWNER,
          kernel_address: KERNEL.toLowerCase(),
          status: 'revoked',
          serialized_approval: null,
          session_key_envelope: null,
          session_key_digest: null,
          session_key_address: null,
          capability_hash: null,
          policy_digest: null,
          valid_until_seconds: null,
          binding_id: null,
          binding_hash: null,
          permission_id: null,
          relayer_origin: null,
        });
        const reason = db.prepare('SELECT quarantine_reason FROM mandates_v3').get().quarantine_reason;
        expect(reason).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
        expect(reason).not.toContain(APPROVAL);
        expect(reason).not.toContain(SESSION_PRIVATE_KEY);
        expect(db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n).toBe(0);
      } finally {
        db.close();
      }
    });

    it.each([
      ['pre-revoked', false],
      ['explicitly quarantined invalid', true],
    ])('drops noncanonical tombstone identity that aliases plaintext authority for a %s row', async (
      _label,
      quarantineInvalid,
    ) => {
      const path = freshPath();
      createLegacyV2(path, {
        stellarOwner: SESSION_PRIVATE_KEY,
        kernelAddress: SESSION_PRIVATE_KEY,
        status: quarantineInvalid ? 'active' : 'revoked',
      });
      const migration = await migrationLibrary();
      const options = migrationOptions({ quarantineInvalid });
      const manifest = migration.createLegacyMandateMigrationManifest(path, options);
      expect(migration.migrateLegacyMandates(path, {
        ...options,
        manifest,
        sessionKeyCipher: cipher(),
      })).toEqual({ migrated: 0, quarantined: 1 });

      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(db.prepare(`
          SELECT stellar_owner, kernel_address, status, serialized_approval,
                 session_key_envelope, session_key_digest, session_key_address,
                 capability_hash, policy_digest, valid_until_seconds, binding_id,
                 binding_hash, permission_id, relayer_origin
          FROM mandates_v3
        `).get()).toEqual({
          stellar_owner: null,
          kernel_address: null,
          status: 'revoked',
          serialized_approval: null,
          session_key_envelope: null,
          session_key_digest: null,
          session_key_address: null,
          capability_hash: null,
          policy_digest: null,
          valid_until_seconds: null,
          binding_id: null,
          binding_hash: null,
          permission_id: null,
          relayer_origin: null,
        });
      } finally {
        db.close();
      }
      for (const artifact of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        expectNoPlaintextInFile(artifact, [SESSION_PRIVATE_KEY]);
      }
    });

    it('rejects a canonical parser result without the immutable Task4 policy digest losslessly', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        parseCanonicalApproval(params) {
          const { policyDigest: _omitted, ...parsed } = canonicalLegacyParser(params);
          return parsed;
        },
      }))).toThrow(/policy.*digest|digest.*policy|canonical/i);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('recognizes and migrates a mixed-case legacy v2 table name', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const rename = new DatabaseSync(path);
      rename.exec('ALTER TABLE mandates_v2 RENAME TO legacy_case_temp; ALTER TABLE legacy_case_temp RENAME TO Mandates_V2;');
      rename.close();
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), manifest,
      }));
      const db = new DatabaseSync(path);
      try {
        expect(tableNames(db).map((name) => name.toLowerCase())).not.toContain('mandates_v2');
        expect(db.prepare('SELECT status, policy_digest FROM mandates_v3').get())
          .toEqual({ status: 'activation_uncertain', policy_digest: POLICY_DIGEST });
      } finally {
        db.close();
      }
    });

    it('recognizes and quarantines a mixed-case approval-only v1 table name', async () => {
      const path = freshPath();
      const legacy = new DatabaseSync(path);
      legacy.exec('CREATE TABLE Mandates (approval TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL)');
      legacy.prepare('INSERT INTO Mandates (approval, session_key, expires_at) VALUES (?, ?, ?)')
        .run(APPROVAL, SESSION_PRIVATE_KEY, VALID_UNTIL_SECONDS * 1000);
      legacy.close();
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        quarantineInvalid: true,
      }));
      expect(manifest.entries).toEqual([expect.objectContaining({ outcome: 'revoked' })]);
      migration.migrateLegacyMandates(path, migrationOptions({
        quarantineInvalid: true, sessionKeyCipher: cipher(), manifest,
      }));
      const db = new DatabaseSync(path);
      try {
        expect(db.prepare('SELECT status, stellar_owner, kernel_address FROM mandates_v3').get())
          .toEqual({ status: 'revoked', stellar_owner: null, kernel_address: null });
        expect(tableNames(db).map((name) => name.toLowerCase())).not.toContain('mandates');
      } finally {
        db.close();
      }
    });

    it('binds the manifest to the exact supported legacy schema and rejects added columns before sealing or mutation', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      const changed = new DatabaseSync(path);
      changed.exec('ALTER TABLE mandates_v2 ADD COLUMN unexpected_authority TEXT');
      changed.prepare('UPDATE mandates_v2 SET unexpected_authority = ?').run('must-not-be-ignored');
      changed.close();
      const before = sqliteSnapshot(path);
      const envelope = cipher();
      let sealCalls = 0;
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        manifest,
        sessionKeyCipher: {
          open: (...args) => envelope.open(...args),
          seal(...args) { sealCalls += 1; return envelope.seal(...args); },
        },
      }))).toThrow(/schema|manifest|stale|changed|legacy/i);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it.each([
      ['a virtual generated column', (db) => db.exec(`
        ALTER TABLE mandates_v2
        ADD COLUMN hidden_authority TEXT GENERATED ALWAYS AS (lower(status)) VIRTUAL
      `)],
      ['an unexpected authority index', (db) => db.exec(`
        CREATE INDEX unexpected_legacy_authority_index
        ON mandates_v2(session_private_key)
      `)],
    ])('rejects legacy v2 with %s before parsing, sealing, or destructive mutation', async (
      _label,
      mutateSchema,
    ) => {
      const path = freshPath();
      createLegacyV2(path);
      const changed = new DatabaseSync(path);
      mutateSchema(changed);
      changed.close();
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      const envelope = cipher();
      let parserCalls = 0;
      let sealCalls = 0;
      let migrationError;
      try {
        migration.migrateLegacyMandates(path, migrationOptions({
          parseCanonicalApproval(params) {
            parserCalls += 1;
            return canonicalLegacyParser(params);
          },
          sessionKeyCipher: {
            open: (...args) => envelope.open(...args),
            seal(...args) {
              sealCalls += 1;
              return envelope.seal(...args);
            },
          },
        }));
      } catch (error) {
        migrationError = error;
      }

      expect(migrationError).toBeInstanceOf(Error);
      expect(migrationError?.message).toMatch(/legacy|schema|manifest|unexpected/i);
      expect(parserCalls).toBe(0);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('refuses to create a migration manifest for an unexpected legacy source schema', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const changed = new DatabaseSync(path);
      changed.exec('ALTER TABLE mandates_v2 ADD COLUMN unexpected_authority TEXT');
      changed.close();
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      expect(() => migration.createLegacyMandateMigrationManifest(path, migrationOptions()))
        .toThrow(/schema|unexpected|legacy/i);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('rejects an incompatible preexisting v3 target schema before sealing or mutating legacy rows', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const target = new DatabaseSync(path);
      target.exec('CREATE TABLE mandates_v3 (mandate_id TEXT PRIMARY KEY)');
      target.close();
      const before = sqliteSnapshot(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      const envelope = cipher();
      let sealCalls = 0;
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        manifest,
        sessionKeyCipher: {
          open: (...args) => envelope.open(...args),
          seal(...args) { sealCalls += 1; return envelope.seal(...args); },
        },
      }))).toThrow(/target|schema|incompatible|v3/i);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(before);
    });

    it('rejects a legacy source changed after preflight when the final locked rescan disagrees', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      const envelope = cipher();
      const addedOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
      const addedKernel = '0x1234567890AbcdEF1234567890aBcdef12345678';
      const addedKey = `0x${'55'.repeat(32)}`;
      const addedSession = privateKeyToAccount(addedKey).address;
      const addedBindingHash = createHash('sha256')
        .update(`${addedOwner}|${addedKernel}|${addedSession}|${VALID_UNTIL_SECONDS}`)
        .digest('hex');
      let afterInjectedMutation;
      let injected = false;
      let sealCalls = 0;
      const measuredCipher = {
        open: (...args) => envelope.open(...args),
        seal(...args) { sealCalls += 1; return envelope.seal(...args); },
      };
      const migrationHooks = {
        afterPreflight() {
          if (!injected) {
            injected = true;
            createLegacyV2(path, {
              serializedApproval: 'added-after-preflight',
              stellarOwner: addedOwner,
              kernelAddress: addedKernel,
              sessionPrivateKey: addedKey,
              sessionKeyAddress: addedSession,
              bindingHash: addedBindingHash,
            });
            afterInjectedMutation = sqliteSnapshot(path);
          }
        },
      };
      let migrationError;
      try {
        migration.migrateLegacyMandates(path, migrationOptions({
          manifest, sessionKeyCipher: measuredCipher, migrationHooks,
        }));
      } catch (error) {
        migrationError = error;
      }
      expect(migrationError).toBeInstanceOf(Error);
      expect(migrationError.message).toMatch(/source|manifest|stale|changed|agreement|legacy/i);
      expect(migrationError?.message).not.toContain(addedKey);
      expect(migrationError?.message).not.toContain('added-after-preflight');
      expect(injected).toBe(true);
      expect(sealCalls).toBe(0);
      expect(sqliteSnapshot(path)).toStrictEqual(afterInjectedMutation);
      const db = new DatabaseSync(path);
      try {
        expect(tableNames(db).map((name) => name.toLowerCase())).toContain('mandates_v2');
        if (tableNames(db).includes('mandates_v3')) {
          expect(db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(0);
        }
      } finally {
        db.close();
      }
    });

    it('holds the write lock while afterLockedRescan runs so a competing legacy write cannot change the migrated snapshot', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
      let hookCalls = 0;
      let competingError;
      const migrationHooks = {
        afterLockedRescan() {
          hookCalls += 1;
          const contender = new DatabaseSync(path);
          try {
            contender.exec('PRAGMA busy_timeout=0');
            contender.prepare(`
              INSERT INTO mandates_v2 (
                serialized_approval, stellar_owner, kernel_address, session_private_key,
                session_key_address, relayer_origin, expires_at, status, binding_id,
                binding_hash, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
            `).run(
              'locked-rescan-contender', OWNER, KERNEL, SESSION_PRIVATE_KEY, SESSION,
              'https://relayer.example', VALID_UNTIL_SECONDS * 1000,
              'binding-contender', 'cc'.repeat(32), NOW_SECONDS * 1000,
            );
          } catch (error) {
            competingError = error;
          } finally {
            contender.close();
          }
        },
      };

      expect(migration.migrateLegacyMandates(path, migrationOptions({
        manifest, sessionKeyCipher: cipher(), migrationHooks,
      }))).toMatchObject({ migrated: 1, quarantined: 0 });
      expect(hookCalls).toBe(1);
      expect(competingError).toBeInstanceOf(Error);
      expect(competingError.message).toMatch(/locked|busy/i);
      expect(competingError.message).not.toContain(SESSION_PRIVATE_KEY);

      const db = new DatabaseSync(path);
      try {
        expect(tableNames(db).map((name) => name.toLowerCase())).not.toContain('mandates_v2');
        expect(db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
        expect(db.prepare('SELECT approval_digest FROM mandates_v3').get().approval_digest)
          .toBe(APPROVAL_DIGEST);
      } finally {
        db.close();
      }
    });

    it('persists canonical source and target bindings while destructive cleanup is pending', async () => {
      const path = freshPath();
      const { manifest } = await seedBoundPendingMigrationCleanup(path);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const marker = db.prepare('SELECT * FROM mandate_migration_state WHERE id = 1').get();
        const migratedRows = db.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all();
        expect(marker).toMatchObject({
          id: 1,
          phase: 'cleanup_pending',
          manifest_version: 1,
          source_digest: manifest.sourceDigest,
          target_digest: expectedMigrationTargetDigest(migratedRows),
          migrated_count: 2,
          quarantined_count: 0,
        });
        expect(marker.source_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(marker.target_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(2);
        expect(tableNames(db).map((name) => name.toLowerCase()))
          .not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));
      } finally {
        db.close();
      }
    });

    it.each([
      ['a deleted migrated row', (db) => db.prepare(`
        DELETE FROM mandates_v3
        WHERE mandate_id = (SELECT mandate_id FROM mandates_v3 ORDER BY mandate_id LIMIT 1)
      `).run()],
      ['a mutated nonsecret destination field', (db) => db.prepare(`
        UPDATE mandates_v3 SET binding_hash = ?
        WHERE mandate_id = (SELECT mandate_id FROM mandates_v3 ORDER BY mandate_id LIMIT 1)
      `).run('bb'.repeat(32))],
    ])('recomputes the pending target aggregate and rejects %s without clearing the marker', async (
      _label,
      corruptTarget,
    ) => {
      const path = freshPath();
      const { migration, options } = await seedBoundPendingMigrationCleanup(path);
      const corrupt = new DatabaseSync(path);
      corruptTarget(corrupt);
      corrupt.close();

      let cleanupError;
      try {
        migration.migrateLegacyMandates(path, {
          ...options,
          sessionKeyCipher: cipher(),
        });
      } catch (error) {
        cleanupError = error;
      }
      expect(cleanupError).toBeInstanceOf(Error);
      expect(cleanupError?.message).toBe('offline mandate migration cleanup is pending');
      expect(cleanupError?.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(cleanupError?.message).not.toContain(SECOND_SESSION_PRIVATE_KEY);
      expect(cleanupError?.message).not.toContain(APPROVAL);

      const pending = new DatabaseSync(path, { readOnly: true });
      try {
        expect(pending.prepare(`
          SELECT phase FROM mandate_migration_state WHERE id = 1
        `).get()).toEqual({ phase: 'cleanup_pending' });
      } finally {
        pending.close();
      }
    });

    it('retains completed migration bindings and returns stored counts without parser or cipher', async () => {
      const path = freshPath();
      const { migration, manifest, options } = await seedBoundPendingMigrationCleanup(path);
      expect(migration.migrateLegacyMandates(path, {
        ...options,
        sessionKeyCipher: cipher(),
      })).toMatchObject({ resumedCleanup: true });

      const completed = new DatabaseSync(path, { readOnly: true });
      try {
        const migratedRows = completed.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all();
        expect(completed.prepare('SELECT * FROM mandate_migration_state WHERE id = 1').get())
          .toMatchObject({
            phase: 'completed',
            manifest_version: 1,
            source_digest: manifest.sourceDigest,
            target_digest: expectedMigrationTargetDigest(migratedRows),
            migrated_count: 2,
            quarantined_count: 0,
          });
      } finally {
        completed.close();
      }

      let parserCalls = 0;
      expect(migration.migrateLegacyMandates(path, migrationOptions({
        parseCanonicalApproval() {
          parserCalls += 1;
          throw new Error(`completed migration must not parse ${SESSION_PRIVATE_KEY}`);
        },
      }))).toEqual({ alreadyMigrated: true, migrated: 2, quarantined: 0 });
      expect(parserCalls).toBe(0);
    });

    it.each([
      ['a deleted migrated row', (db) => db.prepare(`
        DELETE FROM mandates_v3
        WHERE mandate_id = (
          SELECT mandate_id FROM mandates_v3
          WHERE capability_hash IS NULL AND status = 'activation_uncertain'
          ORDER BY mandate_id LIMIT 1
        )
      `).run()],
      ['a mutated migrated destination fact', (db) => db.prepare(`
        UPDATE mandates_v3 SET binding_hash = ?
        WHERE mandate_id = (
          SELECT mandate_id FROM mandates_v3
          WHERE capability_hash IS NULL AND status = 'activation_uncertain'
          ORDER BY mandate_id LIMIT 1
        )
      `).run('bb'.repeat(32))],
      ['an injected capability-null migration-shaped row', (db) => db.prepare(`
        INSERT INTO mandates_v3 (
          mandate_id, approval_digest, policy_digest, serialized_approval, stellar_owner,
          kernel_address, session_key_address, relayer_origin, valid_until_seconds, status,
          binding_id, binding_hash, permission_id, session_key_envelope, session_key_digest,
          capability_hash, activation_user_op_hash, activation_tx_hash, activated_at,
          quarantine_reason, created_at, updated_at
        )
        SELECT ?, approval_digest, policy_digest, serialized_approval, stellar_owner,
               kernel_address, session_key_address, relayer_origin, valid_until_seconds, status,
               binding_id, binding_hash, permission_id, session_key_envelope, session_key_digest,
               NULL, activation_user_op_hash, activation_tx_hash, activated_at,
               quarantine_reason, created_at, updated_at
        FROM mandates_v3
        WHERE capability_hash IS NULL AND status = 'activation_uncertain'
        ORDER BY mandate_id LIMIT 1
      `).run('injected-completed-migration-row')],
    ])('rejects completed-state target tamper from %s without parser or cipher', async (
      _label,
      tamper,
    ) => {
      const path = freshPath();
      const { migration } = await seedCompletedMigrationWithBothOutcomes(path);
      const db = new DatabaseSync(path);
      tamper(db);
      db.close();

      let parserCalls = 0;
      let cipherCalls = 0;
      let replayError;
      try {
        migration.migrateLegacyMandates(path, migrationOptions({
          parseCanonicalApproval() {
            parserCalls += 1;
            throw new Error(`poison completed parser ${SESSION_PRIVATE_KEY}`);
          },
          sessionKeyCipher: {
            seal() {
              cipherCalls += 1;
              throw new Error(`poison completed seal ${SECOND_SESSION_PRIVATE_KEY}`);
            },
            open() {
              cipherCalls += 1;
              throw new Error(`poison completed open ${SECOND_SESSION_PRIVATE_KEY}`);
            },
          },
        }));
      } catch (error) {
        replayError = error;
      }
      expect.soft(replayError).toBeInstanceOf(Error);
      expect.soft(String(replayError?.message || ''))
        .toMatch(/completed|target|aggregate|integrity|migration|marker/i);
      expect(parserCalls).toBe(0);
      expect(cipherCalls).toBe(0);
      for (const sensitiveValue of [SESSION_PRIVATE_KEY, SECOND_SESSION_PRIVATE_KEY, APPROVAL]) {
        expect(String(replayError?.message || '')).not.toContain(sensitiveValue);
      }

      let stores;
      let probeError;
      try {
        stores = createSqliteStores(path, {
          sessionKeyCipher: cipher(),
          nowSeconds: () => NOW_SECONDS,
        });
        stores.probe();
      } catch (error) {
        probeError = error;
      } finally {
        stores?.db.close();
      }
      expect.soft(probeError).toBeInstanceOf(Error);
      expect.soft(String(probeError?.message || ''))
        .toMatch(/completed|target|aggregate|integrity|migration|marker/i);
      for (const sensitiveValue of [SESSION_PRIVATE_KEY, SECOND_SESSION_PRIVATE_KEY, APPROVAL]) {
        expect(String(probeError?.message || '')).not.toContain(sensitiveValue);
      }
    });

    it('keeps completed history valid when a later capability-bound runtime mandate is enqueued', async () => {
      const path = freshPath();
      const { migration } = await seedCompletedMigrationWithBothOutcomes(path);
      const runtimeApproval = 'runtime-approval-after-completed-migration';
      const runtimeMandateId = 'runtime-mandate-after-completed-migration';
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(),
        nowSeconds: () => NOW_SECONDS,
      });
      try {
        expect(stores.mandateActivations.enqueue({
          record: mandateRecord({
            mandateId: runtimeMandateId,
            approvalDigest: createHash('sha256').update(runtimeApproval).digest('hex'),
            policyDigest: '12'.repeat(32),
            serializedApproval: runtimeApproval,
            capabilityHash: '34'.repeat(32),
            bindingId: 'runtime-binding-after-completed-migration',
            bindingHash: '56'.repeat(32),
          }),
        })).toMatchObject({ duplicate: false });
        expect(stores.probe()).toMatchObject({
          writable: true,
          legacyMandateTables: [],
          mandateMigrationCleanupPending: false,
        });
      } finally {
        stores.db.close();
      }

      const completed = new DatabaseSync(path, { readOnly: true });
      try {
        const marker = completed.prepare(`
          SELECT target_digest, migrated_count, quarantined_count
          FROM mandate_migration_state WHERE id = 1 AND phase = 'completed'
        `).get();
        const migrationRows = completed.prepare(`
          SELECT * FROM mandates_v3 WHERE capability_hash IS NULL ORDER BY mandate_id
        `).all();
        const runtimeRows = completed.prepare(`
          SELECT * FROM mandates_v3 WHERE capability_hash IS NOT NULL ORDER BY mandate_id
        `).all();
        expect(migrationRows.map(({ status }) => status).sort())
          .toEqual(['activation_uncertain', 'revoked']);
        expect(migrationRows.filter(({ status }) => status === 'activation_uncertain'))
          .toHaveLength(marker.migrated_count);
        expect(migrationRows.filter(({ status }) => status === 'revoked'))
          .toHaveLength(marker.quarantined_count);
        expect(expectedMigrationTargetDigest(migrationRows)).toBe(marker.target_digest);
        expect(runtimeRows).toHaveLength(1);
        expect(runtimeRows[0]).toMatchObject({
          mandate_id: runtimeMandateId,
          capability_hash: '34'.repeat(32),
          status: 'pending_activation',
        });
      } finally {
        completed.close();
      }

      let parserCalls = 0;
      let cipherCalls = 0;
      expect(migration.migrateLegacyMandates(path, migrationOptions({
        parseCanonicalApproval() {
          parserCalls += 1;
          throw new Error(`runtime replay parser poison ${SESSION_PRIVATE_KEY}`);
        },
        sessionKeyCipher: {
          seal() {
            cipherCalls += 1;
            throw new Error(`runtime replay seal poison ${SECOND_SESSION_PRIVATE_KEY}`);
          },
          open() {
            cipherCalls += 1;
            throw new Error(`runtime replay open poison ${SECOND_SESSION_PRIVATE_KEY}`);
          },
        },
      }))).toEqual({ alreadyMigrated: true, migrated: 1, quarantined: 1 });
      expect(parserCalls).toBe(0);
      expect(cipherCalls).toBe(0);
    });

    it('completes and remembers an empty zero-count legacy migration', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const empty = new DatabaseSync(path);
      empty.exec('DELETE FROM mandates_v2');
      empty.close();
      const migration = await migrationLibrary();
      const options = migrationOptions({ parseCanonicalApproval: canonicalMultiRowLegacyParser });
      const manifest = migration.createLegacyMandateMigrationManifest(path, options);
      expect(manifest.entries).toEqual([]);
      expect(migration.migrateLegacyMandates(path, {
        ...options,
        manifest,
        sessionKeyCipher: cipher(),
      })).toEqual({ migrated: 0, quarantined: 0 });

      const completed = new DatabaseSync(path, { readOnly: true });
      try {
        const migratedRows = completed.prepare('SELECT * FROM mandates_v3 ORDER BY mandate_id').all();
        expect(completed.prepare('SELECT * FROM mandate_migration_state WHERE id = 1').get())
          .toMatchObject({
            phase: 'completed',
            manifest_version: 1,
            source_digest: manifest.sourceDigest,
            target_digest: expectedMigrationTargetDigest(migratedRows),
            migrated_count: 0,
            quarantined_count: 0,
          });
      } finally {
        completed.close();
      }
      expect(migration.migrateLegacyMandates(path, migrationOptions()))
        .toEqual({ alreadyMigrated: true, migrated: 0, quarantined: 0 });
    });

    it('persists cleanup-pending after a destructive commit and resumes cleanup offline with no legacy tables', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const wal = new DatabaseSync(path);
      wal.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      wal.prepare('UPDATE mandates_v2 SET created_at = created_at + 1').run();
      const walPath = `${path}-wal`;
      expect(readFileSync(walPath).includes(Buffer.from(SESSION_PRIVATE_KEY))).toBe(true);
      try {
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions());
        let cleanupError;
        try {
          migration.migrateLegacyMandates(path, migrationOptions({
            manifest,
            sessionKeyCipher: cipher(),
            migrationHooks: {
              afterDestructiveCommit() { throw new Error('raw injected hook detail'); },
            },
          }));
        } catch (error) {
          cleanupError = error;
        }
        expect(cleanupError).toBeInstanceOf(Error);
        expect(cleanupError.message).toBe('offline mandate migration cleanup is pending');
        expect(cleanupError.message).not.toContain('raw injected hook detail');
        expect([path, walPath].some((artifact) => (
          existsSync(artifact)
          && readFileSync(artifact).includes(Buffer.from(SESSION_PRIVATE_KEY))
        ))).toBe(true);

        const pending = createSqliteStores(path, {
          sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
        });
        try {
          expect(pending.probe()).toMatchObject({
            writable: true, mandateMigrationCleanupPending: true,
          });
          expect(tableNames(pending.db).map((name) => name.toLowerCase()))
            .not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));
          expect(pending.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
        } finally {
          pending.db.close();
        }

        expect(migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(),
        }))).toMatchObject({ resumedCleanup: true });
        const ready = createSqliteStores(path, {
          sessionKeyCipher: cipher(), nowSeconds: () => NOW_SECONDS,
        });
        try {
          expect(ready.probe()).toMatchObject({
            writable: true, mandateMigrationCleanupPending: false,
          });
          expect(ready.db.prepare('SELECT COUNT(*) AS n FROM mandates_v3').get().n).toBe(1);
          for (const artifact of [path, walPath, `${path}-shm`, `${path}-journal`]) {
            expectNoPlaintextInFile(artifact, [SESSION_PRIVATE_KEY]);
          }
        } finally {
          ready.db.close();
        }
      } finally {
        wal.close();
      }
    });

    it.each(['incomplete', 'extra', 'deleted', 'changed', 'stale'])('rejects a %s mixed-row quarantine manifest without further mutation', async (kind) => {
      const path = freshPath();
      createLegacyV2(path);
      createLegacyV2(path, {
        serializedApproval: 'invalid-approval',
        stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey(),
        kernelAddress: '0x1234567890AbcdEF1234567890aBcdef12345678',
      });
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        quarantineInvalid: true,
      }));
      expect(manifest.entries).toHaveLength(2);
      let supplied = manifest;
      if (kind === 'incomplete') supplied = { ...manifest, entries: manifest.entries.slice(0, 1) };
      if (kind === 'extra') supplied = {
        ...manifest, entries: [...manifest.entries, { rowDigest: 'ff'.repeat(32), outcome: 'revoked' }],
      };
      if (kind === 'stale') supplied = { ...manifest, sourceDigest: 'ee'.repeat(32) };
      if (kind === 'deleted' || kind === 'changed') {
        const db = new DatabaseSync(path);
        if (kind === 'deleted') {
          db.prepare('DELETE FROM mandates_v2 WHERE serialized_approval = ?').run('invalid-approval');
        } else {
          db.prepare('UPDATE mandates_v2 SET binding_hash = ? WHERE serialized_approval = ?')
            .run('cc'.repeat(32), 'invalid-approval');
        }
        db.close();
      }
      const beforeAttempt = sqliteSnapshot(path);
      expect(() => migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), quarantineInvalid: true, manifest: supplied,
      }))).toThrow(/manifest|complete|extra|stale|changed|row/i);
      expect(sqliteSnapshot(path)).toStrictEqual(beforeAttempt);
    });

    it('uses a complete mixed manifest to encrypt valid work and quarantine invalid data as an allowlisted tombstone', async () => {
      const path = freshPath();
      createLegacyV2(path);
      const invalidOwner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
      const invalidKernel = '0x1234567890AbcdEF1234567890aBcdef12345678';
      const invalidKey = `0x${'55'.repeat(32)}`;
      createLegacyV2(path, {
        serializedApproval: 'invalid-approval',
        stellarOwner: invalidOwner,
        kernelAddress: invalidKernel,
        sessionPrivateKey: invalidKey,
        sessionKeyAddress: privateKeyToAccount(invalidKey).address,
      });
      const migration = await migrationLibrary();
      const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
        quarantineInvalid: true,
      }));
      expect(JSON.stringify(manifest)).not.toContain(SESSION_PRIVATE_KEY);
      expect(JSON.stringify(manifest)).not.toContain(SESSION_KEY_DIGEST);
      expect(JSON.stringify(manifest)).not.toContain(invalidKey);
      expect(JSON.stringify(manifest)).not.toContain(APPROVAL);
      expect(JSON.stringify(manifest)).not.toContain('invalid-approval');
      migration.migrateLegacyMandates(path, migrationOptions({
        sessionKeyCipher: cipher(), quarantineInvalid: true, manifest,
      }));

      const db = new DatabaseSync(path);
      try {
        const rows = db.prepare('SELECT * FROM mandates_v3 ORDER BY status').all();
        const valid = rows.find((row) => row.status === 'activation_uncertain');
        const revoked = rows.find((row) => row.status === 'revoked');
        expect(valid).toMatchObject({
          approval_digest: APPROVAL_DIGEST,
          capability_hash: null,
          policy_digest: POLICY_DIGEST,
          session_key_digest: SESSION_KEY_DIGEST,
          valid_until_seconds: VALID_UNTIL_SECONDS,
        });
        expectOpaqueMandateId(valid.mandate_id, [
          APPROVAL, APPROVAL_DIGEST, OWNER, KERNEL, SESSION, SESSION_PRIVATE_KEY,
        ]);
        expect(valid.session_key_envelope).toMatch(/^v1\.active\./);
        expectOpaqueMandateId(revoked.mandate_id, [
          'invalid-approval', invalidOwner, invalidKernel, invalidKey,
        ]);
        expect(revoked.mandate_id).not.toBe(valid.mandate_id);
        expect(revoked).toMatchObject({
          stellar_owner: invalidOwner,
          kernel_address: invalidKernel.toLowerCase(),
          approval_digest: createHash('sha256').update('invalid-approval').digest('hex'),
          status: 'revoked',
          serialized_approval: null,
          session_key_envelope: null,
          session_key_digest: null,
          session_key_address: null,
          capability_hash: null,
          policy_digest: null,
          valid_until_seconds: null,
          binding_id: null,
          binding_hash: null,
          permission_id: null,
          relayer_origin: null,
        });
        expect(typeof revoked.quarantine_reason).toBe('string');
        expect(revoked.quarantine_reason.length).toBeGreaterThan(0);
        expect(revoked.quarantine_reason).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
        expect(revoked.quarantine_reason).not.toContain('invalid-approval');
        expect(revoked.quarantine_reason).not.toContain(invalidKey);
        expect(revoked.quarantine_reason).not.toContain(SESSION_PRIVATE_KEY);
        expect(db.prepare('SELECT COUNT(*) AS n FROM mandate_activation_work').get().n).toBe(0);
        expect(tableNames(db)).not.toEqual(expect.arrayContaining(['mandates', 'mandates_v2']));
      } finally {
        db.close();
      }
    });

    it('checkpoints and truncates WAL/journal artifacts and vacuums quarantined plaintext', async () => {
      const path = freshPath();
      const invalidKey = `0x${'55'.repeat(32)}`;
      createLegacyV2(path, {
        serializedApproval: 'invalid-approval',
        sessionPrivateKey: invalidKey,
        sessionKeyAddress: privateKeyToAccount(invalidKey).address,
      });
      const wal = new DatabaseSync(path);
      wal.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      wal.prepare('UPDATE mandates_v2 SET binding_id = ?').run('binding-wal-seed');
      const walPath = `${path}-wal`;
      expect(existsSync(walPath)).toBe(true);
      expect(statSync(walPath).size).toBeGreaterThan(0);
      const walBefore = readFileSync(walPath);
      expect(walBefore.includes(Buffer.from('invalid-approval'))).toBe(true);
      expect(walBefore.includes(Buffer.from(invalidKey))).toBe(true);
      try {
        const migration = await migrationLibrary();
        const manifest = migration.createLegacyMandateMigrationManifest(path, migrationOptions({
          quarantineInvalid: true,
        }));
        migration.migrateLegacyMandates(path, migrationOptions({
          sessionKeyCipher: cipher(), quarantineInvalid: true, manifest,
        }));
        expectNoPlaintextInFile(path, ['invalid-approval', invalidKey]);
        for (const liveArtifact of [walPath, `${path}-shm`]) {
          expectNoPlaintextInFile(liveArtifact, ['invalid-approval', invalidKey]);
        }
      } finally {
        wal.close();
      }

      expectNoPlaintextInFile(path, ['invalid-approval', invalidKey]);
      for (const artifact of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        if (existsSync(artifact)) expect(statSync(artifact).size).toBe(0);
        expectNoPlaintextInFile(artifact, ['invalid-approval', invalidKey]);
      }
    });
  });

});

// ---------------------------------------------------------------------------
// Task 8 RED — cctp_relay_work: transactional SQLite implementation of the checkpointed
// CCTP relay-work contract. Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/
// task-8-test-design.md "SQLite RED matrix" (schema, concurrency, CAS, reconciliation).
//
// Pinned wiring: createSqliteStores(path) returns a `cctpRelays` property implementing the
// same store contract as store.test.mjs (enqueue/get/claim/renew/recordAttested/
// markMintSubmitting/markMintSubmitted/finishMinted/finishBlocked/finishUncertain/release/
// listForSweep/reconcileExpired/statusOf). The generic `relay_records` table is NEVER an
// authority fallback for relay work.
//
// All digest literals are hand-calculated (node:crypto over the exact fixture bytes /
// canonical JSON), never via production helpers. See store.test.mjs for derivations.
// ---------------------------------------------------------------------------

const CCTP_T0 = 1_700_000_000_000;
const CCTP_ZERO32 = '00'.repeat(32);

const CCTP_FORWARD_EXPECTATION = {
  version: 1,
  direction: 'stellar-to-base',
  sourceDomain: 27,
  destinationDomain: 6,
  sender: '0xda6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8',
  recipient: '0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  destinationCaller: `0x${CCTP_ZERO32}`,
  burnToken: '0x5045cd5ec0729a768fd5ad02505852df4f028dce830e5ac52209ba48483b2f01',
  mintRecipient: '0x0000000000000000000000000123456789abcdef0123456789abcdef01234567',
  messageSender: '0xabababababababababababababababababababababababababababababababab',
  amount: '1000000',
  burnUnits7: '10000000',
  maxFee: '0',
  minFinalityThreshold: 2000,
  hookData: '0x',
};
// sha256('vf-cctp-expectation-v1\0' + canonical JSON) — hand-calculated, see store.test.mjs.
const CCTP_FORWARD_EXPECTATION_DIGEST =
  '11168b4892206a45bb692ff36133a2571db05d6192a257edeafb247cfa8a8a98';
const CCTP_REVERSE_EXPECTATION_DIGEST =
  'b520b25d0f960eef4edda77137065bb666a46fa8b1cf79fa8d6bc159978e5cd0';

const CCTP_REVERSE_EXPECTATION = {
  version: 1,
  direction: 'base-to-stellar',
  sourceDomain: 6,
  destinationDomain: 27,
  sender: '0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  recipient: '0xda6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8',
  destinationCaller: '0x3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e',
  burnToken: '0x000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e',
  mintRecipient: '0x3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e',
  messageSender: '0x0000000000000000000000005451a6dc234d07f3c80752e3c0e798913e53de6d',
  amount: '1234567',
  burnUnits7: null,
  maxFee: '1000',
  minFinalityThreshold: 1000,
  hookData: `0x${'00'.repeat(24)}00000000000000384743584d5a434456595441414e42524153554757533547444b52475351574e4d3558485642344a4937505845435a594b4247354f5454524b`,
};

const CCTP_BURN_FORWARD = 'aa'.repeat(32);
const CCTP_BURN_REVERSE = `0x${'cc'.repeat(32)}`;
const CCTP_MINT_BASE = `0x${'bb'.repeat(32)}`;
const CCTP_MESSAGE_HEX = '0xdeadbeef';
const CCTP_MESSAGE_DIGEST = '5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953';
const CCTP_NONCE_HEX = `0x${'11'.repeat(32)}`;
const CCTP_ATTESTATION_HEX = '0xaabb';
const CCTP_ATTESTATION_DIGEST =
  'd798d1fac6bd4bb1c11f50312760351013379a0ab6f0a8c0af8a506b96b2525a';
const CCTP_NEW_ATTESTATION_HEX = '0xccdd';
const CCTP_NEW_ATTESTATION_DIGEST =
  '5a8814ae66ff07179d2c22381da6221f6fe754e6175c47d7d87846080f0a9715';

const UNWIND_JOB_ID = '10'.repeat(16);
const UNWIND_CAPABILITY_HASH = '20'.repeat(32);
const UNWIND_KERNEL = `0x${'30'.repeat(20)}`;
const UNWIND_RECIPIENT = 'GCXMZCDVYTAANBRASUGWS5GDKRGSQWNM5XHVB4JI7PXECZYKBG5OTTRK';
// sha256('vf-unwind-reserve-v1\0' + exact canonical reserve JSON), calculated independently.
const UNWIND_REQUEST_DIGEST =
  '861ab14ae726044accae31aa7ae940f1a5e5f3137e034c4ca3e27bd6a4980abe';
const UNWIND_USER_OP_HASH = `0x${'50'.repeat(32)}`;
const UNWIND_JOB_COMMITMENT =
  '0x03ac096b55e45c72290a902df8be9eb3e1c6f0614d7c328aa878097e2662fc86';
const UNWIND_TX_HASH = `0x${'60'.repeat(32)}`;
const UNWIND_ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const UNWIND_BLOCK_HASH = `0x${'70'.repeat(32)}`;
const UNWIND_PROOF = Object.freeze({
  version: 1,
  chainId: 84532,
  userOpHash: UNWIND_USER_OP_HASH,
  jobCommitment: UNWIND_JOB_COMMITMENT,
  unwindTxHash: UNWIND_TX_HASH,
  entryPointAddress: UNWIND_ENTRY_POINT,
  kernelAddress: UNWIND_KERNEL,
  blockNumber: '12345678',
  blockHash: UNWIND_BLOCK_HASH,
  userOpNonce: '9',
  burned: '1234567',
  exited: '1300000',
  skipped: '0',
  maxFee: '1000',
  hookData: CCTP_REVERSE_EXPECTATION.hookData,
  sourceMessageHex: CCTP_MESSAGE_HEX,
  sourceMessageDigest: CCTP_MESSAGE_DIGEST,
  logIndices: Object.freeze({
    messageSent: 4,
    depositForBurn: 5,
    swept: 6,
    userOperationEvent: 7,
  }),
  logDigests: Object.freeze({
    messageSent: '81'.repeat(32),
    depositForBurn: '82'.repeat(32),
    swept: '83'.repeat(32),
    userOperationEvent: '84'.repeat(32),
  }),
});

function unwindJobId(index) {
  return index.toString(16).padStart(32, '0');
}

function unwindReserveInput(index, overrides = {}) {
  const jobId = overrides.jobId ?? unwindJobId(index);
  const kernelAddress = overrides.kernelAddress ?? UNWIND_KERNEL;
  const recipientHint = overrides.recipientHint ?? UNWIND_RECIPIENT;
  const reserveJson = JSON.stringify({ jobId, kernelAddress, recipientHint });
  return {
    jobId,
    capabilityHash: overrides.capabilityHash ?? createHash('sha256')
      .update(`capability-${index}`).digest('hex'),
    kernelAddress,
    recipientHint,
    requestDigest: createHash('sha256')
      .update(`vf-unwind-reserve-v1\0${reserveJson}`).digest('hex'),
    expiresAt: overrides.expiresAt ?? CCTP_T0 + 3_600_000,
    capabilityExpiresAt: overrides.capabilityExpiresAt ?? CCTP_T0 + 4_200_000,
    now: overrides.now ?? CCTP_T0 + index,
  };
}

function unwindProofFor(index, overrides = {}) {
  const byte = (0x90 + index).toString(16).padStart(2, '0');
  return {
    ...UNWIND_PROOF,
    userOpHash: overrides.userOpHash ?? `0x${byte.repeat(32)}`,
    jobCommitment: overrides.jobCommitment ?? keccak256(concatHex([
      '0x76662d756e77696e642d6a6f622d7631', `0x${unwindJobId(index)}`,
    ])),
    unwindTxHash: overrides.unwindTxHash ?? `0x${(0xa0 + index).toString(16).repeat(32)}`,
    burned: overrides.burned ?? UNWIND_PROOF.burned,
    maxFee: overrides.maxFee ?? UNWIND_PROOF.maxFee,
    logDigests: {
      messageSent: byte.repeat(32),
      depositForBurn: (0xb0 + index).toString(16).repeat(32),
      swept: (0xc0 + index).toString(16).repeat(32),
      userOperationEvent: (0xd0 + index).toString(16).repeat(32),
    },
  };
}

function cctpThrowsCode(fn, code) {
  try {
    fn();
  } catch (err) {
    if (err?.code !== code) {
      throw new Error(`expected typed code ${code}, got ${err?.code ?? '(none)'}: ${err?.message}`);
    }
    return err;
  }
  throw new Error(`expected typed code ${code}, but no error was thrown`);
}

const cctpIntent = (execId, overrides = {}) => ({
  execId,
  sourceDomain: 27,
  burnTxHash: CCTP_BURN_FORWARD,
  expectation: CCTP_FORWARD_EXPECTATION,
  now: CCTP_T0,
  ...overrides,
});

const cctpReverseIntent = (execId, overrides = {}) => ({
  execId,
  sourceDomain: 6,
  burnTxHash: CCTP_BURN_REVERSE,
  expectation: CCTP_REVERSE_EXPECTATION,
  now: CCTP_T0,
  ...overrides,
});

function createLegacyUniqueBurnCctpTable(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cctp_relay_work (
      exec_id TEXT PRIMARY KEY,
      source_domain INTEGER NOT NULL,
      burn_tx_hash TEXT NOT NULL UNIQUE,
      expectation_json TEXT NOT NULL,
      expectation_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'attestation_pending','attested','mint_submitting','mint_submitted',
        'minted','blocked','uncertain'
      )),
      message_hex TEXT,
      nonce_hex TEXT,
      message_digest TEXT,
      attestation_hex TEXT,
      attestation_digest TEXT,
      evidence_version INTEGER NOT NULL DEFAULT 0,
      mint_tx_hash TEXT,
      reason_code TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (state <> 'attested' OR (
        message_hex IS NOT NULL AND nonce_hex IS NOT NULL AND message_digest IS NOT NULL
        AND attestation_hex IS NOT NULL AND attestation_digest IS NOT NULL
      )),
      CHECK (state <> 'mint_submitted' OR mint_tx_hash IS NOT NULL),
      CHECK (state <> 'minted' OR mint_tx_hash IS NOT NULL)
    );
    CREATE INDEX idx_cctp_relay_recovery
      ON cctp_relay_work(created_at, exec_id, state, lease_expires_at);
  `);
  db.prepare(`
    INSERT INTO cctp_relay_work (
      exec_id,source_domain,burn_tx_hash,expectation_json,expectation_digest,state,
      message_hex,nonce_hex,message_digest,attestation_hex,attestation_digest,
      evidence_version,mint_tx_hash,reason_code,attempts,lease_token,lease_expires_at,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'legacy-base-active', 6, CCTP_BURN_REVERSE, JSON.stringify(CCTP_REVERSE_EXPECTATION),
    CCTP_REVERSE_EXPECTATION_DIGEST, 'attested', CCTP_MESSAGE_HEX, CCTP_NONCE_HEX,
    CCTP_MESSAGE_DIGEST, CCTP_ATTESTATION_HEX, CCTP_ATTESTATION_DIGEST, 7, null, null,
    3, 'legacy-live-lease', CCTP_T0 + 60_000, CCTP_T0, CCTP_T0 + 1,
  );
  db.prepare(`
    INSERT INTO cctp_relay_work (
      exec_id,source_domain,burn_tx_hash,expectation_json,expectation_digest,state,
      message_hex,nonce_hex,message_digest,attestation_hex,attestation_digest,
      evidence_version,mint_tx_hash,reason_code,attempts,lease_token,lease_expires_at,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'legacy-forward-active', 27, CCTP_BURN_FORWARD, JSON.stringify(CCTP_FORWARD_EXPECTATION),
    CCTP_FORWARD_EXPECTATION_DIGEST, 'attestation_pending', null, null, null, null, null,
    0, null, null, 2, null, null, CCTP_T0 + 2, CCTP_T0 + 2,
  );
  db.close();
}

function createLiteralV1CctpTable(path, { includeBase = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cctp_relay_work (
      exec_id TEXT PRIMARY KEY,
      source_domain INTEGER NOT NULL,
      burn_tx_hash TEXT NOT NULL,
      expectation_json TEXT NOT NULL,
      expectation_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'attestation_pending','attested','mint_submitting','mint_submitted',
        'minted','blocked','uncertain'
      )),
      message_hex TEXT,
      nonce_hex TEXT,
      message_digest TEXT,
      attestation_hex TEXT,
      attestation_digest TEXT,
      evidence_version INTEGER NOT NULL DEFAULT 0,
      mint_tx_hash TEXT,
      reason_code TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (state <> 'attested' OR (
        message_hex IS NOT NULL AND nonce_hex IS NOT NULL AND message_digest IS NOT NULL
        AND attestation_hex IS NOT NULL AND attestation_digest IS NOT NULL
      )),
      CHECK (state <> 'mint_submitted' OR mint_tx_hash IS NOT NULL),
      CHECK (state <> 'minted' OR mint_tx_hash IS NOT NULL)
    );
    CREATE INDEX idx_cctp_relay_recovery
      ON cctp_relay_work(created_at,exec_id,state,lease_expires_at);
    CREATE INDEX idx_cctp_relay_burn ON cctp_relay_work(burn_tx_hash);
    CREATE UNIQUE INDEX idx_cctp_relay_identity
      ON cctp_relay_work(source_domain,burn_tx_hash,expectation_digest);
    CREATE UNIQUE INDEX idx_cctp_relay_forward_burn
      ON cctp_relay_work(source_domain,burn_tx_hash) WHERE source_domain=27;
  `);
  db.prepare(`
    INSERT INTO cctp_relay_work (
      exec_id,source_domain,burn_tx_hash,expectation_json,expectation_digest,state,
      message_hex,nonce_hex,message_digest,attestation_hex,attestation_digest,
      evidence_version,mint_tx_hash,reason_code,attempts,lease_token,lease_expires_at,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'v1-forward', 27, CCTP_BURN_FORWARD, JSON.stringify(CCTP_FORWARD_EXPECTATION),
    CCTP_FORWARD_EXPECTATION_DIGEST, 'attestation_pending', null, null, null, null, null,
    0, null, null, 2, null, null, CCTP_T0, CCTP_T0 + 1,
  );
  if (includeBase) {
    db.prepare(`
      INSERT INTO cctp_relay_work (
        exec_id,source_domain,burn_tx_hash,expectation_json,expectation_digest,state,
        message_hex,nonce_hex,message_digest,attestation_hex,attestation_digest,
        evidence_version,mint_tx_hash,reason_code,attempts,lease_token,lease_expires_at,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      `unwind:${UNWIND_JOB_ID}`, 6, UNWIND_TX_HASH, JSON.stringify(CCTP_REVERSE_EXPECTATION),
      CCTP_REVERSE_EXPECTATION_DIGEST, 'attestation_pending', null, null, null, null, null,
      0, null, null, 0, null, null, CCTP_T0, CCTP_T0 + 2,
    );
  }
  db.close();
}

function cctpSeedAttested(cctpRelays, execId, { now = CCTP_T0, leaseMs = 60_000, burnTxHash = CCTP_BURN_FORWARD } = {}) {
  cctpRelays.enqueue(cctpIntent(execId, { now, burnTxHash }));
  const claimed = cctpRelays.claim({ execId, now, leaseMs });
  cctpRelays.recordAttested({
    execId, leaseToken: claimed.leaseToken, messageHex: CCTP_MESSAGE_HEX,
    nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_ATTESTATION_HEX, now,
  });
  return claimed.leaseToken;
}

function cctpSeedSubmitting(cctpRelays, execId, { now = CCTP_T0, leaseMs = 60_000, burnTxHash = CCTP_BURN_FORWARD } = {}) {
  const token = cctpSeedAttested(cctpRelays, execId, { now, leaseMs, burnTxHash });
  cctpRelays.markMintSubmitting({ execId, leaseToken: token, now });
  return token;
}

function cctpSeedSubmitted(cctpRelays, execId, { now = CCTP_T0, leaseMs = 60_000, burnTxHash = CCTP_BURN_FORWARD } = {}) {
  const token = cctpSeedSubmitting(cctpRelays, execId, { now, leaseMs, burnTxHash });
  cctpRelays.markMintSubmitted({ execId, leaseToken: token, mintTxHash: CCTP_MINT_BASE, now });
  return token;
}

describe('cctpRelays — cctp_relay_work SQLite relay-work store (Task 8 RED)', () => {
  // Regression caught: the store silently operated against a missing/wrong table; schema and
  // readiness must be provable on a fresh DB (SQLite RED matrix rows 1 + 11).
  it('creates the exact cctp_relay_work schema and recovery index on a fresh DB; probe() passes', () => {
    const stores = createSqliteStores(freshPath());
    const table = stores.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cctp_relay_work'",
    ).get();
    expect(table).toBeDefined();
    const columns = stores.db.prepare('PRAGMA table_xinfo(cctp_relay_work)').all()
      .map(({ name }) => name);
    expect(columns).toEqual([
      'exec_id', 'source_domain', 'burn_tx_hash', 'expectation_json', 'expectation_digest',
      'state', 'message_hex', 'nonce_hex', 'message_digest', 'attestation_hex',
      'attestation_digest', 'evidence_version', 'mint_tx_hash', 'reason_code',
      'attempts', 'lease_token', 'lease_expires_at', 'created_at', 'updated_at',
    ]);
    const index = stores.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cctp_relay_recovery'",
    ).get();
    expect(index).toBeDefined();
    const indexFacts = Object.fromEntries(
      stores.db.prepare('PRAGMA index_list(cctp_relay_work)').all()
        .filter(({ name }) => name.startsWith('idx_cctp_relay_'))
        .map(({ name, unique, partial }) => [name, {
          unique,
          partial,
          columns: stores.db.prepare(`PRAGMA index_info("${name}")`).all()
            .map(({ name: column }) => column),
        }]),
    );
    expect(indexFacts.idx_cctp_relay_identity).toEqual({
      unique: 1,
      partial: 0,
      columns: ['source_domain', 'burn_tx_hash', 'expectation_digest'],
    });
    expect(indexFacts.idx_cctp_relay_forward_burn).toEqual({
      unique: 1,
      partial: 1,
      columns: ['source_domain', 'burn_tx_hash'],
    });
    expect(indexFacts.idx_cctp_relay_actionable).toEqual({
      unique: 0,
      partial: 1,
      columns: ['updated_at', 'created_at', 'exec_id'],
    });
    expect(indexFacts.idx_cctp_relay_expiry).toEqual({
      unique: 0,
      partial: 1,
      columns: ['lease_expires_at', 'created_at', 'exec_id'],
    });
    expect(indexFacts.idx_cctp_relay_summary).toEqual({
      unique: 0,
      partial: 1,
      columns: ['created_at', 'exec_id'],
    });
    expect(stores.probe().writable).toBe(true);
    stores.db.close();
  });

  // Task 12 migration trap: CREATE TABLE IF NOT EXISTS cannot remove the table-level UNIQUE
  // autoindex. Rebuild must preserve Task8 evidence while quarantining unauthenticated Base work.
  it('atomically rebuilds the legacy unique-burn table and fail-closes active Base rows', () => {
    const path = freshPath();
    createLegacyUniqueBurnCctpTable(path);

    const stores = createSqliteStores(path, { now: () => CCTP_T0 + 999 });
    expect(stores.cctpRelays.get('legacy-base-active')).toMatchObject({
      state: 'blocked',
      reasonCode: 'legacy_record_unrecoverable',
      messageHex: CCTP_MESSAGE_HEX,
      attestationHex: CCTP_ATTESTATION_HEX,
      evidenceVersion: 7,
      attempts: 3,
      leaseToken: null,
      leaseExpiresAt: null,
      messageDigest: CCTP_MESSAGE_DIGEST,
      attestationDigest: CCTP_ATTESTATION_DIGEST,
      createdAt: CCTP_T0,
      updatedAt: CCTP_T0 + 999,
    });
    expect(stores.cctpRelays.get('legacy-forward-active')).toMatchObject({
      state: 'attestation_pending',
      attempts: 2,
    });
    const oneColumnBurnUnique = stores.db.prepare('PRAGMA index_list(cctp_relay_work)').all()
      .filter(({ unique }) => unique === 1)
      .some(({ name }) => {
        const columns = stores.db.prepare(`PRAGMA index_info("${name}")`).all()
          .map(({ name: column }) => column);
        return columns.length === 1 && columns[0] === 'burn_tx_hash';
      });
    expect(oneColumnBurnUnique).toBe(false);
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(2);
    stores.db.close();
  });

  it.each([
    ['source domain', "source_domain=999"],
    ['burn hash', "burn_tx_hash='not-a-hash'"],
    ['expectation JSON', "expectation_json='{}'"],
    ['expectation digest', "expectation_digest='zz'"],
  ])('quarantines a legacy runnable row with malformed %s during the one-time rebuild', (_label, mutation) => {
    const path = freshPath();
    createLegacyUniqueBurnCctpTable(path);
    const raw = new DatabaseSync(path);
    raw.exec(`UPDATE cctp_relay_work SET ${mutation},updated_at=${CCTP_T0 + 2}
      WHERE exec_id='legacy-forward-active'`);
    raw.close();

    const stores = createSqliteStores(path, { now: () => CCTP_T0 + 999 });
    expect(stores.cctpRelays.get('legacy-forward-active')).toMatchObject({
      state: 'blocked', reasonCode: 'legacy_record_unrecoverable',
      mintTxHash: null, leaseToken: null, updatedAt: CCTP_T0 + 999,
    });
    expect(stores.cctpRelays.listForSweep({ now: CCTP_T0 + 2_000, limit: 100 })
      .map(({ execId }) => execId)).not.toContain('legacy-forward-active');
    expect(stores.probe().writable).toBe(true);
    stores.db.close();
  });

  it('recognizes the literal deployed v1 fingerprint and preserves valid forward authority while hardening it', () => {
    const path = freshPath();
    createLiteralV1CctpTable(path);

    const stores = createSqliteStores(path, { now: () => CCTP_T0 + 999 });
    expect(stores.cctpRelays.get('v1-forward')).toEqual({
      execId: 'v1-forward', sourceDomain: 27, burnTxHash: CCTP_BURN_FORWARD,
      expectation: CCTP_FORWARD_EXPECTATION,
      expectationDigest: CCTP_FORWARD_EXPECTATION_DIGEST,
      state: 'attestation_pending', messageHex: null, nonceHex: null,
      messageDigest: null, attestationHex: null, attestationDigest: null,
      evidenceVersion: 0, mintTxHash: null, reasonCode: null, attempts: 2,
      leaseToken: null, leaseExpiresAt: null, createdAt: CCTP_T0, updatedAt: CCTP_T0 + 1,
    });
    expect(stores.db.prepare('PRAGMA index_info(idx_cctp_relay_recovery)').all()
      .map(({ name }) => name)).toEqual([
      'updated_at', 'created_at', 'exec_id', 'state', 'lease_token',
    ]);
    expect(stores.probe().writable).toBe(true);
    stores.db.close();
  });

  it('quarantines every active Base row from pre-Task12 v1 despite shallow matching unwind linkage', () => {
    const path = freshPath();
    let stores = createSqliteStores(path);
    stores.unwindJobs.reserve(unwindReserveInput(1, {
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      now: CCTP_T0,
    }));
    stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    const proofTrigger = stores.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type='trigger' AND name='unwind_jobs_proof_immutable'
    `).get().sql;
    stores.db.exec('DROP TRIGGER unwind_jobs_proof_immutable');
    stores.db.prepare('UPDATE unwind_jobs SET proof_json=? WHERE job_id=?')
      .run('{}', UNWIND_JOB_ID);
    stores.db.exec(proofTrigger);
    stores.db.exec(`
      DROP INDEX idx_cctp_relay_recovery;
      DROP INDEX idx_cctp_relay_burn;
      DROP INDEX idx_cctp_relay_identity;
      DROP INDEX idx_cctp_relay_forward_burn;
      DROP TABLE cctp_relay_work;
    `);
    stores.db.close();
    createLiteralV1CctpTable(path, { includeBase: true });

    stores = createSqliteStores(path, { now: () => CCTP_T0 + 999 });
    expect(stores.cctpRelays.get(`unwind:${UNWIND_JOB_ID}`)).toMatchObject({
      state: 'blocked', reasonCode: 'legacy_record_unrecoverable',
      mintTxHash: null, leaseToken: null, leaseExpiresAt: null,
    });
    expect(stores.cctpRelays.listForSweep({ now: CCTP_T0 + 2_000, limit: 100 })
      .map(({ execId }) => execId)).not.toContain(`unwind:${UNWIND_JOB_ID}`);
    expect(stores.cctpRelays.get('v1-forward').state).toBe('attestation_pending');
    stores.db.close();
  });

  // Catches a destructive rename/copy sequence that commits or drops the only authoritative
  // table after a mid-migration exception.
  it('rolls back a mid-rebuild failure with the legacy schema and every row byte-exact', () => {
    const path = freshPath();
    createLegacyUniqueBurnCctpTable(path);
    const before = new DatabaseSync(path, { readOnly: true });
    const beforeSql = before.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='cctp_relay_work'",
    ).get().sql;
    const beforeRows = before.prepare('SELECT * FROM cctp_relay_work ORDER BY exec_id').all();
    before.close();

    expect(() => createSqliteStores(path, {
      now: () => CCTP_T0 + 999,
      cctpMigrationFault(phase) {
        if (phase === 'rows_copied') throw new Error('injected CCTP migration failure');
      },
    })).toThrow('injected CCTP migration failure');

    const after = new DatabaseSync(path, { readOnly: true });
    expect(after.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='cctp_relay_work'",
    ).get().sql).toBe(beforeSql);
    expect(after.prepare('SELECT * FROM cctp_relay_work ORDER BY exec_id').all()).toEqual(beforeRows);
    expect(after.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cctp_relay_work_task8_legacy'",
    ).get()).toBeUndefined();
    after.close();
  });

  it('probe() fails closed when the cctp_relay_work table is missing', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    stores.db.exec('DROP TABLE cctp_relay_work');
    expect(() => stores.probe()).toThrow();
    stores.db.close();
  });

  it('probe fails closed when a required CCTP identity index is missing', () => {
    const stores = createSqliteStores(freshPath());
    stores.db.exec('DROP INDEX idx_cctp_relay_identity');
    expect(() => stores.probe()).toThrow(/CCTP relay-work schema/i);
    stores.db.close();
  });

  it('rejects a same-name CCTP index with the wrong uniqueness and ordered columns', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    stores.db.exec(`
      DROP INDEX idx_cctp_relay_identity;
      CREATE INDEX idx_cctp_relay_identity ON cctp_relay_work(exec_id);
    `);
    expect(() => stores.probe()).toThrow(/CCTP relay-work schema/i);
    stores.db.close();
    expect(() => createSqliteStores(path)).toThrow(/CCTP relay-work schema/i);
  });

  it.each([
    ['view', `CREATE VIEW cctp_shadow AS SELECT exec_id FROM cctp_relay_work`],
    ['other-table trigger', `
      CREATE TABLE cctp_aux (id INTEGER PRIMARY KEY);
      CREATE TRIGGER cctp_aux_reader AFTER INSERT ON cctp_aux BEGIN
        SELECT exec_id FROM cctp_relay_work LIMIT 1;
      END
    `],
  ])('rejects an unexpected %s that references relay authority', (_label, ddl) => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    stores.db.exec(ddl);
    stores.db.close();

    expect(() => createSqliteStores(path)).toThrow(/CCTP.*dependency|dependency.*CCTP/i);
  });

  // Regression caught (row 2): JSON/number round-trips that lose precision would split an
  // exact retry into a false conflict; ms timestamps and big decimal strings must survive.
  it('canonical intent and evidence survive close/reopen with no precision loss', () => {
    const path = freshPath();
    const bigExpectation = {
      ...CCTP_FORWARD_EXPECTATION,
      amount: '9007199254740993', // > Number.MAX_SAFE_INTEGER
      burnUnits7: '90071992547409930',
    };
    const first = createSqliteStores(path);
    first.cctpRelays.enqueue({
      ...cctpIntent('exec-big', { expectation: bigExpectation }), now: 1_700_000_000_123,
    });
    const claimed = first.cctpRelays.claim({ execId: 'exec-big', now: 1_700_000_000_124, leaseMs: 60_000 });
    first.cctpRelays.recordAttested({
      execId: 'exec-big', leaseToken: claimed.leaseToken, messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_ATTESTATION_HEX, now: 1_700_000_000_125,
    });
    first.db.close();

    const second = createSqliteStores(path);
    const record = second.cctpRelays.get('exec-big');
    expect(record.expectation).toEqual(bigExpectation);
    expect(record.expectation.amount).toBe('9007199254740993');
    expect(record).toMatchObject({
      state: 'attested',
      messageDigest: CCTP_MESSAGE_DIGEST,
      attestationDigest: CCTP_ATTESTATION_DIGEST,
      evidenceVersion: 1,
      createdAt: 1_700_000_000_123,
      updatedAt: 1_700_000_000_125,
      leaseExpiresAt: 1_700_000_060_124,
    });
    second.db.close();
  });

  // Regression caught (row 3): a naive INSERT threw a raw UNIQUE-constraint error on an exact
  // duplicate retry instead of resolving to the existing row.
  it('two connections enqueueing the same exact intent produce one row and no raw SQLite error', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const second = createSqliteStores(path);
    const a = first.cctpRelays.enqueue(cctpIntent('exec-1'));
    const b = second.cctpRelays.enqueue(cctpIntent('exec-1', { now: CCTP_T0 + 999 }));
    expect(b).toEqual(a);
    const count = first.db.prepare(
      'SELECT COUNT(*) AS n FROM cctp_relay_work WHERE exec_id = ?',
    ).get('exec-1').n;
    expect(count).toBe(1);
    first.db.close();
    second.db.close();
  });

  // Regression caught (row 4): raw SQLITE_BUSY/constraint errors leaked to callers instead of
  // a typed conflict, and the conflicting call mutated the valid row (plan mismatch #9).
  it('two-connection changed-intent and burn-reuse conflicts are typed and leak no SQLite detail', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const second = createSqliteStores(path);
    first.cctpRelays.enqueue(cctpIntent('exec-1'));
    const changed = {
      ...CCTP_FORWARD_EXPECTATION, amount: '2000000', burnUnits7: '20000000',
    };
    const conflict = cctpThrowsCode(
      () => second.cctpRelays.enqueue(cctpIntent('exec-1', { expectation: changed })),
      'RELAY_ENQUEUE_CONFLICT',
    );
    expect(conflict.message).not.toMatch(/SQLITE|constraint|UNIQUE/i);
    const reuse = cctpThrowsCode(
      () => second.cctpRelays.enqueue(cctpIntent('exec-2')),
      'RELAY_ENQUEUE_CONFLICT',
    );
    expect(reuse.message).not.toMatch(/SQLITE|constraint|UNIQUE/i);
    expect(second.cctpRelays.get('exec-2')).toBeNull();
    expect(second.cctpRelays.get('exec-1').expectation).toEqual(CCTP_FORWARD_EXPECTATION);
    first.db.close();
    second.db.close();
  });

  // Task 12: Base reverse bundle transactions are not unique relay identities; the immutable
  // expectation disambiguates separate successful UserOperations in the same transaction.
  it('persists two reverse expectations from one outer bundle but blocks an identical tuple', () => {
    const stores = createSqliteStores(freshPath());
    const first = stores.cctpRelays.enqueue(cctpReverseIntent('reverse-1'));
    const second = stores.cctpRelays.enqueue(cctpReverseIntent('reverse-2', {
      expectation: { ...CCTP_REVERSE_EXPECTATION, amount: '7654321' },
    }));

    expect(first.burnTxHash).toBe(CCTP_BURN_REVERSE);
    expect(second.expectation.amount).toBe('7654321');
    cctpThrowsCode(
      () => stores.cctpRelays.enqueue(cctpReverseIntent('reverse-ambiguous')),
      'RELAY_ENQUEUE_CONFLICT',
    );
    expect(stores.cctpRelays.get('reverse-ambiguous')).toBeNull();
    stores.db.close();
  });

  // Regression caught (row 5): two connections both claimed the same row when claim was a
  // read-then-write instead of one conditional UPDATE.
  it('two connections claiming the same safe row: exactly one lease wins', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    first.cctpRelays.enqueue(cctpIntent('exec-1'));
    const second = createSqliteStores(path);
    const winner = first.cctpRelays.claim({ execId: 'exec-1', now: CCTP_T0, leaseMs: 60_000 });
    expect(winner).toMatchObject({ attempts: 1, leaseExpiresAt: CCTP_T0 + 60_000 });
    expect(typeof winner.leaseToken).toBe('string');
    const loser = second.cctpRelays.claim({ execId: 'exec-1', now: CCTP_T0, leaseMs: 60_000 });
    expect(loser).toBeNull();
    expect(second.cctpRelays.get('exec-1').leaseToken).toBe(winner.leaseToken);
    first.db.close();
    second.db.close();
  });

  // Regression caught (row 6): a stale connection's transition overwrote the winner's
  // checkpoint because the UPDATE did not guard on (state, lease_token, lease_expires_at).
  it('a stale connection transition affects zero rows and throws a typed CAS error', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const second = createSqliteStores(path);
    first.cctpRelays.enqueue(cctpIntent('exec-1'));
    const claimed = first.cctpRelays.claim({ execId: 'exec-1', now: CCTP_T0, leaseMs: 60_000 });
    // the winner advances; the stale connection still holds a made-up/old token
    first.cctpRelays.recordAttested({
      execId: 'exec-1', leaseToken: claimed.leaseToken, messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_ATTESTATION_HEX, now: CCTP_T0,
    });
    cctpThrowsCode(
      () => second.cctpRelays.markMintSubmitting({ execId: 'exec-1', leaseToken: 'stale-token', now: CCTP_T0 }),
      'RELAY_CAS_CONFLICT',
    );
    expect(second.cctpRelays.get('exec-1').state).toBe('attested');
    first.db.close();
    second.db.close();
  });

  // Regression caught (row 7): field-by-field writes let a crash persist half an attested
  // checkpoint; after reopen every multi-field transition must be all-or-none.
  it('attested and submitted checkpoints are all-or-none after close/reopen', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const token = cctpSeedSubmitted(first.cctpRelays, 'exec-1');
    expect(token).toBeTruthy();
    first.db.close();

    const second = createSqliteStores(path);
    const record = second.cctpRelays.get('exec-1');
    expect(record).toMatchObject({
      state: 'mint_submitted',
      messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX,
      messageDigest: CCTP_MESSAGE_DIGEST,
      attestationHex: CCTP_ATTESTATION_HEX,
      attestationDigest: CCTP_ATTESTATION_DIGEST,
      evidenceVersion: 1,
      mintTxHash: CCTP_MINT_BASE,
    });
    // the schema itself refuses a mint_submitted row without a canonical mint hash
    expect(() => second.db.prepare(
      "UPDATE cctp_relay_work SET mint_tx_hash = NULL WHERE exec_id = 'exec-1'",
    ).run()).toThrow();
    expect(second.cctpRelays.get('exec-1').mintTxHash).toBe(CCTP_MINT_BASE);
    second.db.close();
  });

  // Regression caught (row 8): evidence replacement and the version bump were two writes;
  // and evidence stayed mutable after the submit fence.
  it('evidence replacement increments evidence_version in one transaction; frozen after the fence', () => {
    const path = freshPath();
    const first = createSqliteStores(path);
    const token = cctpSeedAttested(first.cctpRelays, 'exec-1');
    first.cctpRelays.recordAttested({
      execId: 'exec-1', leaseToken: token, messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_NEW_ATTESTATION_HEX, now: CCTP_T0 + 1,
    });
    // release the live seed lease so the reopened connection can claim the row (claim only
    // succeeds for an UNLEASED safe state)
    first.cctpRelays.release({ execId: 'exec-1', leaseToken: token, now: CCTP_T0 + 1 });
    first.db.close();

    const second = createSqliteStores(path);
    expect(second.cctpRelays.get('exec-1')).toMatchObject({
      state: 'attested',
      attestationHex: CCTP_NEW_ATTESTATION_HEX,
      attestationDigest: CCTP_NEW_ATTESTATION_DIGEST,
      messageDigest: CCTP_MESSAGE_DIGEST,
      evidenceVersion: 2,
    });
    const live = second.cctpRelays.claim({ execId: 'exec-1', now: CCTP_T0 + 2, leaseMs: 60_000 });
    second.cctpRelays.markMintSubmitting({ execId: 'exec-1', leaseToken: live.leaseToken, now: CCTP_T0 + 2 });
    cctpThrowsCode(() => second.cctpRelays.recordAttested({
      execId: 'exec-1', leaseToken: live.leaseToken, messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX, attestationHex: CCTP_ATTESTATION_HEX, now: CCTP_T0 + 3,
    }), 'RELAY_CAS_CONFLICT');
    second.db.close();
  });

  // Regression caught (row 9): reconciliation ran row-by-row outside a transaction, so a
  // crash left some expired leases cleared and a mint_submitting row still claimable.
  it('reconcileExpired runs as one BEGIN IMMEDIATE transaction and follows the state table', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    const c = stores.cctpRelays;
    c.enqueue(cctpIntent('r-pending', { now: CCTP_T0 }));
    c.claim({ execId: 'r-pending', now: CCTP_T0, leaseMs: 10 });
    cctpSeedAttested(c, 'r-attested', { now: CCTP_T0 + 1, leaseMs: 10, burnTxHash: 'ab'.repeat(32) });
    cctpSeedSubmitting(c, 'r-submitting', { now: CCTP_T0 + 2, leaseMs: 10, burnTxHash: 'ac'.repeat(32) });
    cctpSeedSubmitted(c, 'r-submitted', { now: CCTP_T0 + 3, leaseMs: 10, burnTxHash: 'ad'.repeat(32) });
    const mintedToken = cctpSeedSubmitted(c, 'r-minted', { now: CCTP_T0 + 4, burnTxHash: 'ae'.repeat(32) });
    c.finishMinted({ execId: 'r-minted', leaseToken: mintedToken, mintTxHash: CCTP_MINT_BASE, now: CCTP_T0 + 4 });

    const statements = [];
    const originalExec = stores.db.exec;
    stores.db.exec = (sql) => { statements.push(String(sql)); return originalExec.call(stores.db, sql); };
    let reconciled;
    try {
      reconciled = c.reconcileExpired({ now: CCTP_T0 + 1_000, limit: 100 });
    } finally {
      stores.db.exec = originalExec;
    }
    expect(statements.some((sql) => /BEGIN\s+IMMEDIATE/i.test(sql))).toBe(true);
    expect(reconciled.map((r) => r.execId)).toEqual([
      'r-pending', 'r-attested', 'r-submitting', 'r-submitted',
    ]);
    expect(c.get('r-pending')).toMatchObject({ state: 'attestation_pending', leaseToken: null });
    expect(c.get('r-attested')).toMatchObject({ state: 'attested', leaseToken: null });
    expect(c.get('r-submitting')).toMatchObject({
      state: 'uncertain', reasonCode: 'submission_lease_expired', leaseToken: null,
    });
    expect(c.get('r-submitted')).toMatchObject({ state: 'mint_submitted', leaseToken: null });
    expect(c.get('r-minted').state).toBe('minted');
    stores.db.close();
  });

  // Regression caught (row 10): recovery listing was unbounded/insertion-ordered and included
  // terminal rows, so startup recovery order was unstable (task-8 pins (createdAt, execId)).
  it('listForSweep is index-backed, deterministic, bounded, and excludes terminals', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    const c = stores.cctpRelays;
    c.enqueue(cctpIntent('exec-c', { now: CCTP_T0 + 2, burnTxHash: 'c0'.repeat(32) }));
    c.enqueue(cctpIntent('exec-a', { now: CCTP_T0 }));
    c.enqueue(cctpIntent('exec-b', { now: CCTP_T0 + 1, burnTxHash: 'b0'.repeat(32) }));
    const mintedToken = cctpSeedSubmitted(c, 'exec-minted', { now: CCTP_T0 - 1, burnTxHash: 'ab'.repeat(32) });
    c.finishMinted({ execId: 'exec-minted', leaseToken: mintedToken, mintTxHash: CCTP_MINT_BASE, now: CCTP_T0 });

    const listed = c.listForSweep({ now: CCTP_T0 + 10_000, limit: 100 });
    expect(listed.map((r) => r.execId)).toEqual(['exec-a', 'exec-b', 'exec-c']);
    expect(c.listForSweep({ now: CCTP_T0 + 10_000, limit: 2 }).map((r) => r.execId))
      .toEqual(['exec-a', 'exec-b']);
    const plan = stores.db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM cctp_relay_work
       WHERE state IN ('attestation_pending','attested','mint_submitted')
         AND lease_token IS NULL
       ORDER BY updated_at,created_at,exec_id LIMIT ?`,
    ).all(100).map((row) => row.detail).join(' | ');
    expect(plan).toContain('idx_cctp_relay_actionable');
    expect(plan).not.toContain('TEMP B-TREE');
    stores.db.close();
  });

  it('uses exact partial indexes for expiry and terminal/live-lease summaries', () => {
    const stores = createSqliteStores(freshPath());
    const expiryPlan = stores.db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM cctp_relay_work
      WHERE state IN ('attestation_pending','attested','mint_submitting','mint_submitted')
        AND lease_token IS NOT NULL AND lease_expires_at<=?
      ORDER BY lease_expires_at,created_at,exec_id LIMIT ?
    `).all(CCTP_T0, 100).map((row) => row.detail).join(' | ');
    expect(expiryPlan).toContain('idx_cctp_relay_expiry');
    expect(expiryPlan).not.toContain('TEMP B-TREE');

    const summaryPlan = stores.db.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM cctp_relay_work
      WHERE state IN ('blocked','uncertain') OR lease_token IS NOT NULL
      ORDER BY created_at,exec_id LIMIT ?
    `).all(100).map((row) => row.detail).join(' | ');
    expect(summaryPlan).toContain('idx_cctp_relay_summary');
    expect(summaryPlan).not.toContain('TEMP B-TREE');
    expect(stores.cctpRelays.listSweepSummary({ now: CCTP_T0, limit: 100 })).toEqual([]);
    stores.db.close();
  });

  // Regression caught (row 11): invalid states/digests were storable, so recovery later read
  // rows it could not classify.
  it('invalid state/digest/evidence combinations are rejected by schema and application guards', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    expect(() => stores.db.prepare(`
      INSERT INTO cctp_relay_work (
        exec_id, source_domain, burn_tx_hash, expectation_json, expectation_digest,
        state, created_at, updated_at
      ) VALUES ('raw-1', 27, ?, '{}', ?, 'pending', 1, 1)
    `).run(CCTP_BURN_FORWARD, CCTP_FORWARD_EXPECTATION_DIGEST)).toThrow(); // not a contract state
    expect(() => stores.db.prepare(`
      INSERT INTO cctp_relay_work (
        exec_id, source_domain, burn_tx_hash, expectation_json, expectation_digest,
        state, created_at, updated_at
      ) VALUES ('raw-2', 27, ?, 'not-json', 'zz', 'attested', 1, 1)
    `).run('e0'.repeat(32))).toThrow(); // attested with no evidence columns
    const token = cctpSeedSubmitting(stores.cctpRelays, 'exec-1');
    cctpThrowsCode(
      () => stores.cctpRelays.markMintSubmitted({
        execId: 'exec-1', leaseToken: token, mintTxHash: '0x123', now: CCTP_T0,
      }),
      'RELAY_VALIDATION',
    );
    stores.db.close();
  });

  it.each([
    ['source domain', "source_domain=999"],
    ['burn hash', "burn_tx_hash='not-a-hash'"],
    ['expectation JSON', "expectation_json='{}'"],
    ['expectation digest', "expectation_digest='zz'"],
  ])('never runs a current row with a corrupt canonical %s binding', (_label, mutation) => {
    const stores = createSqliteStores(freshPath());
    stores.cctpRelays.enqueue(cctpIntent('corrupt-runtime'));
    stores.db.exec('PRAGMA ignore_check_constraints=ON');
    stores.db.exec(`UPDATE cctp_relay_work SET ${mutation} WHERE exec_id='corrupt-runtime'`);
    stores.db.exec('PRAGMA ignore_check_constraints=OFF');

    expect(() => stores.cctpRelays.get('corrupt-runtime')).toThrow(/invalid|integrity|canonical/i);
    expect(() => stores.cctpRelays.statusOf('corrupt-runtime')).toThrow(/invalid|integrity|canonical/i);
    expect(() => stores.cctpRelays.listForSweep({ now: CCTP_T0, limit: 10 }))
      .toThrow(/invalid|integrity|canonical/i);
    expect(() => stores.cctpRelays.claim({
      execId: 'corrupt-runtime', now: CCTP_T0, leaseMs: 1_000,
    })).toThrow(/invalid|integrity|canonical/i);
    expect(stores.db.prepare(
      'SELECT lease_token,lease_expires_at,attempts FROM cctp_relay_work WHERE exec_id=?',
    ).get('corrupt-runtime')).toEqual({ lease_token: null, lease_expires_at: null, attempts: 0 });
    stores.db.close();
  });

  // Regression caught (row 12): the watcher used to read generic relay_records rows as truth;
  // a legacy {status:'minted'} blob must never authorize skipping a mint (plan mismatch #10).
  it('the generic relay_records table is never an authority fallback for relay work', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    stores.store.set('legacy-exec', { status: 'minted', mintTxHash: CCTP_MINT_BASE });
    stores.store.set('legacy-pending', { status: 'pending', sourceDomain: 27, burnTxHash: CCTP_BURN_FORWARD });

    expect(stores.cctpRelays.get('legacy-exec')).toBeNull();
    expect(stores.cctpRelays.get('legacy-pending')).toBeNull();
    expect(stores.cctpRelays.statusOf('legacy-exec')).toBeNull();
    expect(stores.cctpRelays.listForSweep({ now: CCTP_T0, limit: 100 })).toEqual([]);
    expect(stores.cctpRelays.claim({ execId: 'legacy-pending', now: CCTP_T0, leaseMs: 1000 })).toBeNull();
    stores.db.close();
  });
});

describe('unwindJobs — dedicated durable unwind authority (Task 12 RED)', () => {
  it('fails readiness when the exact unwind index ensemble is incomplete', () => {
    const stores = createSqliteStores(freshPath());
    try {
      stores.db.exec('DROP INDEX idx_unwind_tx_hash');
      expect(() => stores.probe()).toThrow(/unwind.*schema|schema.*unwind|readiness/i);
    } finally {
      stores.db.close();
    }
  });

  it('atomically adds bounded recovery indexes on reopen without rewriting unwind authority', () => {
    const path = freshPath();
    let stores = createSqliteStores(path);
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    const expected = stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?')
      .get(UNWIND_JOB_ID);
    stores.db.exec('DROP INDEX idx_unwind_expiry; DROP INDEX idx_unwind_resume');
    stores.db.close();

    stores = createSqliteStores(path);
    try {
      expect(stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?').get(UNWIND_JOB_ID))
        .toEqual(expected);
      expect(stores.db.prepare(`
        SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_unwind_resume'
      `).get().sql).toMatch(/WHERE state IN \('relay_pending','relay_running'\)/);
      expect(stores.db.prepare(`
        SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_unwind_expiry'
      `).get().sql).toMatch(/WHERE state='awaiting_burn' OR lease_token IS NOT NULL/);
      expect(stores.probe()).toMatchObject({ writable: true, unwindDurable: true });
    } finally {
      stores.db.close();
    }
  });

  // Catches routing reverse authority through the generic jobs Map or storing a raw capability.
  it('reserves one hash-only awaiting_burn row and returns an exact idempotent retry unchanged', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    const input = {
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    };

    const first = stores.unwindJobs.reserve(input);
    const retry = stores.unwindJobs.reserve({
      ...input,
      expiresAt: CCTP_T0 + 7_200_000,
      capabilityExpiresAt: CCTP_T0 + 7_800_000,
      now: CCTP_T0 + 999,
    });
    expect(retry).toEqual(first);
    expect(first).toEqual({
      jobId: UNWIND_JOB_ID,
      status: 'awaiting_burn',
      createdAt: CCTP_T0,
      updatedAt: CCTP_T0,
    });
    const raw = stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?').get(UNWIND_JOB_ID);
    expect(raw.capability_hash).toBe(UNWIND_CAPABILITY_HASH);
    expect(Object.keys(raw)).not.toContain('capability');
    expect(stores.jobs.get(UNWIND_JOB_ID)).toBeUndefined();
    stores.db.close();
  });

  it('rejects wrong capability and changed immutable reserve binding without changing the original row', () => {
    const stores = createSqliteStores(freshPath());
    const original = unwindReserveInput(1, {
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      now: CCTP_T0,
    });
    stores.unwindJobs.reserve(original);
    const before = stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?').get(UNWIND_JOB_ID);

    cctpThrowsCode(() => stores.unwindJobs.reserve({
      ...original, capabilityHash: 'ff'.repeat(32), now: CCTP_T0 + 1,
    }), 'UNWIND_UNAUTHORIZED');
    cctpThrowsCode(() => stores.unwindJobs.reserve(unwindReserveInput(2, {
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: `0x${'31'.repeat(20)}`,
      now: CCTP_T0 + 1,
    })), 'UNWIND_CONFLICT');
    expect(stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?').get(UNWIND_JOB_ID))
      .toEqual(before);
    stores.db.close();
  });

  it('never persists or projects the raw unwind capability', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    const rawCapability = '0123456789abcdef'.repeat(4);
    const input = unwindReserveInput(1, {
      jobId: UNWIND_JOB_ID,
      capabilityHash: createHash('sha256').update(rawCapability).digest('hex'),
      now: CCTP_T0,
    });
    const projection = stores.unwindJobs.reserve(input);
    const authority = stores.unwindJobs.getAuthority(UNWIND_JOB_ID);
    let rejection;
    try {
      stores.unwindJobs.reserve({ ...input, capabilityHash: 'ff'.repeat(32), now: CCTP_T0 + 1 });
    } catch (error) {
      rejection = error;
    }
    stores.db.close();

    expect(JSON.stringify(projection)).not.toContain(rawCapability);
    expect(JSON.stringify(authority)).not.toContain(rawCapability);
    expect(String(rejection)).not.toContain(rawCapability);
    expect(readFileSync(path).includes(Buffer.from(rawCapability))).toBe(false);
  });

  it('enforces global UserOperation ownership across distinct unwind jobs', () => {
    const stores = createSqliteStores(freshPath());
    const first = unwindReserveInput(1);
    const second = unwindReserveInput(2);
    stores.unwindJobs.reserve(first);
    stores.unwindJobs.reserve(second);
    const firstProof = unwindProofFor(1);
    stores.unwindJobs.attachAndEnqueue({
      jobId: first.jobId, proof: firstProof, expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${first.jobId}`, now: CCTP_T0 + 10,
    });
    const distinctExpectation = { ...CCTP_REVERSE_EXPECTATION, amount: '1234568' };
    cctpThrowsCode(() => stores.unwindJobs.attachAndEnqueue({
      jobId: second.jobId,
      proof: unwindProofFor(2, {
        userOpHash: firstProof.userOpHash, burned: distinctExpectation.amount,
      }),
      expectation: distinctExpectation,
      relayExecId: `unwind:${second.jobId}`,
      now: CCTP_T0 + 11,
    }), 'UNWIND_CONFLICT');
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(1);
    stores.db.close();
  });

  it('rejects a valid receipt proof whose signed UserOperation commits to another job', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve(unwindReserveInput(1, { jobId: UNWIND_JOB_ID }));

    cctpThrowsCode(() => stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: { ...UNWIND_PROOF, jobCommitment: unwindProofFor(2).jobCommitment },
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 10,
    }), 'UNWIND_CONFLICT');
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(0);
    expect(stores.unwindJobs.status(UNWIND_JOB_ID)).toEqual({
      jobId: UNWIND_JOB_ID, status: 'awaiting_burn',
    });
    stores.db.close();
  });

  it('allows distinct UserOperations and expectations in one outer transaction but blocks an identical tuple', () => {
    const stores = createSqliteStores(freshPath());
    const jobs = [unwindReserveInput(1), unwindReserveInput(2), unwindReserveInput(3)];
    jobs.forEach((input) => stores.unwindJobs.reserve(input));
    const sharedTx = `0x${'ab'.repeat(32)}`;
    const firstProof = unwindProofFor(1, { unwindTxHash: sharedTx });
    const secondExpectation = { ...CCTP_REVERSE_EXPECTATION, amount: '1234568' };
    const secondProof = unwindProofFor(2, {
      unwindTxHash: sharedTx, burned: secondExpectation.amount,
    });
    stores.unwindJobs.attachAndEnqueue({
      jobId: jobs[0].jobId, proof: firstProof, expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${jobs[0].jobId}`, now: CCTP_T0 + 10,
    });
    expect(stores.unwindJobs.attachAndEnqueue({
      jobId: jobs[1].jobId, proof: secondProof, expectation: secondExpectation,
      relayExecId: `unwind:${jobs[1].jobId}`, now: CCTP_T0 + 11,
    }).duplicate).toBe(false);
    cctpThrowsCode(() => stores.unwindJobs.attachAndEnqueue({
      jobId: jobs[2].jobId,
      proof: unwindProofFor(3, { unwindTxHash: sharedTx }),
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${jobs[2].jobId}`,
      now: CCTP_T0 + 12,
    }), 'UNWIND_CONFLICT');
    expect(stores.db.prepare('SELECT unwind_tx_hash FROM unwind_jobs WHERE proof_digest IS NOT NULL')
      .all()).toEqual([{ unwind_tx_hash: sharedTx }, { unwind_tx_hash: sharedTx }]);
    stores.db.close();
  });

  it('preserves awaiting, relay, and terminal unwind authority exactly across reopen', () => {
    const path = freshPath();
    const input = unwindReserveInput(1, { jobId: UNWIND_JOB_ID, now: CCTP_T0 });
    let stores = createSqliteStores(path);
    stores.unwindJobs.reserve(input);
    stores.db.close();

    stores = createSqliteStores(path);
    expect(stores.unwindJobs.status(UNWIND_JOB_ID)).toEqual({
      jobId: UNWIND_JOB_ID, status: 'awaiting_burn',
    });
    expect(stores.unwindJobs.getAuthority(UNWIND_JOB_ID)).toMatchObject({
      jobId: UNWIND_JOB_ID, capabilityHash: input.capabilityHash,
    });
    stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    stores.db.close();

    stores = createSqliteStores(path);
    expect(stores.unwindJobs.status(UNWIND_JOB_ID)).toEqual({
      jobId: UNWIND_JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH,
    });
    const execId = `unwind:${UNWIND_JOB_ID}`;
    const claim = stores.cctpRelays.claim({ execId, now: CCTP_T0 + 2, leaseMs: 10_000 });
    stores.cctpRelays.recordAttested({
      execId, leaseToken: claim.leaseToken,
      messageHex: CCTP_MESSAGE_HEX,
      nonceHex: CCTP_NONCE_HEX,
      attestationHex: CCTP_ATTESTATION_HEX,
      now: CCTP_T0 + 3,
    });
    stores.cctpRelays.markMintSubmitting({
      execId, leaseToken: claim.leaseToken, now: CCTP_T0 + 4,
    });
    const mintTxHash = 'aa'.repeat(32);
    stores.cctpRelays.markMintSubmitted({
      execId, leaseToken: claim.leaseToken, mintTxHash, now: CCTP_T0 + 5,
    });
    stores.cctpRelays.finishMinted({
      execId, leaseToken: claim.leaseToken, mintTxHash, now: CCTP_T0 + 6,
    });
    expect(stores.unwindJobs.reconcileFromCctp({
      jobId: UNWIND_JOB_ID, now: CCTP_T0 + 7,
    })).toEqual({
      jobId: UNWIND_JOB_ID, status: 'done', unwindTxHash: UNWIND_TX_HASH, mintTxHash,
    });
    stores.db.close();

    stores = createSqliteStores(path);
    expect(stores.unwindJobs.reconcileFromCctp({
      jobId: UNWIND_JOB_ID, now: CCTP_T0 + 8,
    })).toEqual({
      jobId: UNWIND_JOB_ID, status: 'done', unwindTxHash: UNWIND_TX_HASH, mintTxHash,
    });
    stores.db.close();
  });

  it('lists recoverable unwind rows in stable bounded order while excluding an active lease', () => {
    const stores = createSqliteStores(freshPath());
    const inputs = Array.from({ length: 5 }, (_, index) => unwindReserveInput(index + 1));
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      stores.unwindJobs.reserve(input);
      if (index === 1) {
        stores.unwindJobs.claimEvidence({
          jobId: input.jobId,
          userOpHash: unwindProofFor(index + 1).userOpHash,
          unwindTxHash: unwindProofFor(index + 1).unwindTxHash,
          now: CCTP_T0 + 10, leaseMs: 10_000, retryMs: 20_000,
        });
        continue;
      }
      stores.unwindJobs.attachAndEnqueue({
        jobId: input.jobId,
        proof: unwindProofFor(index + 1),
        expectation: CCTP_REVERSE_EXPECTATION,
        relayExecId: `unwind:${input.jobId}`,
        now: CCTP_T0 + 100 + index,
      });
    }

    const expected = [inputs[0], inputs[2]].map(({ jobId }) => ({
      jobId, relayExecId: `unwind:${jobId}`, state: 'relay_pending',
    }));
    expect(stores.unwindJobs.listForResume({ now: CCTP_T0 + 1_000, limit: 2 }))
      .toEqual(expected);
    expect(stores.unwindJobs.listForResume({ now: CCTP_T0 + 1_000, limit: 2 }))
      .toEqual(expected);
    expect(stores.unwindJobs.listForResume({ now: CCTP_T0 + 1_000, limit: 1 }))
      .toHaveLength(1);
    const plan = stores.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT u.* FROM unwind_jobs AS u INDEXED BY idx_unwind_resume
      JOIN cctp_relay_work AS c
        ON c.exec_id=u.relay_exec_id
       AND c.burn_tx_hash=u.unwind_tx_hash
       AND c.expectation_digest=u.expectation_digest
       AND c.expectation_json=u.expectation_json
      WHERE u.state IN ('relay_pending','relay_running')
        AND u.proof_digest IS NOT NULL
        AND c.source_domain=6
        AND (c.lease_token IS NULL OR c.lease_expires_at<=?)
      ORDER BY u.updated_at,u.created_at,u.job_id LIMIT ?
    `).all(CCTP_T0 + 1_000, 2).map((row) => row.detail).join(' | ');
    expect(plan).toContain('idx_unwind_resume');
    expect(plan).toMatch(/cctp_relay_work.*(exec_id|sqlite_autoindex)/i);
    expect(plan).not.toContain('TEMP B-TREE');
    stores.db.close();
  });

  it('rotates a transient reverse head behind later proof-backed work across bounded pages', () => {
    const stores = createSqliteStores(freshPath());
    const inputs = [1, 2, 3].map((index) => unwindReserveInput(index));
    for (let index = 0; index < inputs.length; index += 1) {
      stores.unwindJobs.reserve(inputs[index]);
      stores.unwindJobs.attachAndEnqueue({
        jobId: inputs[index].jobId,
        proof: unwindProofFor(index + 1),
        expectation: CCTP_REVERSE_EXPECTATION,
        relayExecId: `unwind:${inputs[index].jobId}`,
        now: CCTP_T0 + 100 + index,
      });
    }
    expect(stores.unwindJobs.listForResume({ now: CCTP_T0 + 200, limit: 1 })[0].jobId)
      .toBe(inputs[0].jobId);

    const firstExec = `unwind:${inputs[0].jobId}`;
    const claim = stores.cctpRelays.claim({ execId: firstExec, now: CCTP_T0 + 200, leaseMs: 10 });
    stores.cctpRelays.release({
      execId: firstExec, leaseToken: claim.leaseToken, now: CCTP_T0 + 201,
    });
    expect(stores.unwindJobs.reconcileFromCctp({
      jobId: inputs[0].jobId, now: CCTP_T0 + 201,
    }).status).toBe('relay_pending');

    expect(stores.unwindJobs.listForResume({ now: CCTP_T0 + 202, limit: 1 })[0].jobId)
      .toBe(inputs[1].jobId);
    stores.db.close();
  });

  it('lists only proof-backed reverse rows whose wrapper and Task8 identities still match', () => {
    const stores = createSqliteStores(freshPath());
    const inputs = [1, 2, 3].map((index) => unwindReserveInput(index));
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      stores.unwindJobs.reserve(input);
      stores.unwindJobs.attachAndEnqueue({
        jobId: input.jobId,
        proof: unwindProofFor(index + 1),
        expectation: CCTP_REVERSE_EXPECTATION,
        relayExecId: `unwind:${input.jobId}`,
        now: CCTP_T0 + 10 + index,
      });
    }
    // A generic forward row is never reverse recovery authority.
    stores.cctpRelays.enqueue({
      execId: 'forward-unrelated', sourceDomain: 27,
      burnTxHash: 'f5'.repeat(32), expectation: CCTP_FORWARD_EXPECTATION,
      now: CCTP_T0 + 20,
    });
    // Simulate corrupt/orphan current storage. Recovery listing must fail closed per row,
    // not hand either identity to the existing-only watcher seam.
    stores.db.prepare('DELETE FROM cctp_relay_work WHERE exec_id=?')
      .run(`unwind:${inputs[1].jobId}`);
    stores.db.exec('PRAGMA ignore_check_constraints=ON');
    try {
      stores.db.prepare('UPDATE cctp_relay_work SET source_domain=27 WHERE exec_id=?')
        .run(`unwind:${inputs[2].jobId}`);
    } finally {
      stores.db.exec('PRAGMA ignore_check_constraints=OFF');
    }

    expect(stores.unwindJobs.listForResume({ now: CCTP_T0 + 1_000, limit: 10 }))
      .toEqual([{
        jobId: inputs[0].jobId,
        relayExecId: `unwind:${inputs[0].jobId}`,
        state: 'relay_pending',
      }]);
    stores.db.close();
  });

  it.each(['expired_unreconciled', 'expired_reconciled', 'attached', 'terminal'])(
    'rejects an exact reserve retry after the original authority becomes %s',
    (state) => {
      const stores = createSqliteStores(freshPath());
      const original = {
        jobId: UNWIND_JOB_ID,
        capabilityHash: UNWIND_CAPABILITY_HASH,
        kernelAddress: UNWIND_KERNEL,
        recipientHint: UNWIND_RECIPIENT,
        requestDigest: UNWIND_REQUEST_DIGEST,
        expiresAt: CCTP_T0 + 100,
        capabilityExpiresAt: CCTP_T0 + 10_000,
        now: CCTP_T0,
      };
      stores.unwindJobs.reserve(original);
      if (state === 'expired_reconciled') {
        stores.unwindJobs.reconcileExpired({ now: CCTP_T0 + 101, limit: 1 });
      } else if (state === 'attached') {
        stores.unwindJobs.attachAndEnqueue({
          jobId: UNWIND_JOB_ID,
          proof: UNWIND_PROOF,
          expectation: CCTP_REVERSE_EXPECTATION,
          relayExecId: `unwind:${UNWIND_JOB_ID}`,
          now: CCTP_T0 + 1,
        });
      } else if (state === 'terminal') {
        stores.unwindJobs.finishBlocked({
          jobId: UNWIND_JOB_ID,
          reasonCode: 'message_mismatch',
          now: CCTP_T0 + 1,
        });
      }
      const retryNow = state === 'expired_unreconciled' || state === 'expired_reconciled'
        ? CCTP_T0 + 101 : CCTP_T0 + 2;

      const error = cctpThrowsCode(() => stores.unwindJobs.reserve({
        ...original,
        expiresAt: retryNow + 3_600_000,
        capabilityExpiresAt: retryNow + 4_200_000,
        now: retryNow,
      }), 'UNWIND_CONFLICT');
      expect(error.message).not.toContain(UNWIND_CAPABILITY_HASH);
      expect(stores.db.prepare('SELECT COUNT(*) AS n FROM unwind_jobs').get().n).toBe(1);
      stores.db.close();
    },
  );

  it('does not expire an awaiting reservation while its bounded evidence lease is live', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 100,
      capabilityExpiresAt: CCTP_T0 + 10_000,
      now: CCTP_T0,
    });
    const lease = stores.unwindJobs.claimEvidence({
      jobId: UNWIND_JOB_ID, userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 50, leaseMs: 1_000, retryMs: 5_000,
    });

    expect(stores.unwindJobs.reconcileExpired({ now: CCTP_T0 + 101, limit: 10 }))
      .toEqual([]);
    expect(stores.unwindJobs.getAuthority(UNWIND_JOB_ID)).toMatchObject({
      state: 'awaiting_burn',
    });
    expect(stores.db.prepare('SELECT lease_token FROM unwind_jobs WHERE job_id=?')
      .get(UNWIND_JOB_ID).lease_token).toBe(lease.leaseToken);
    stores.db.close();
  });

  it('uses a bounded partial expiry index without scanning retained terminal unwind history', () => {
    const stores = createSqliteStores(freshPath());
    for (let index = 1; index <= 16; index += 1) {
      const input = unwindReserveInput(index);
      stores.unwindJobs.reserve(input);
      stores.unwindJobs.finishBlocked({
        jobId: input.jobId, reasonCode: 'message_mismatch', now: CCTP_T0 + 100 + index,
      });
    }
    const expired = unwindReserveInput(100, {
      expiresAt: CCTP_T0 + 300,
      capabilityExpiresAt: CCTP_T0 + 600,
    });
    stores.unwindJobs.reserve(expired);

    const plan = stores.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT job_id FROM unwind_jobs INDEXED BY idx_unwind_expiry
      WHERE (state='awaiting_burn' OR lease_token IS NOT NULL)
        AND ((state='awaiting_burn'
              AND ((candidate_user_op_hash IS NULL AND expires_at<=?)
                OR (candidate_user_op_hash IS NOT NULL AND evidence_retry_until<=?))
              AND (lease_token IS NULL OR lease_expires_at<=?))
          OR (lease_token IS NOT NULL AND lease_expires_at<=?))
      ORDER BY created_at,job_id LIMIT ?
    `).all(CCTP_T0 + 301, CCTP_T0 + 301, CCTP_T0 + 301, CCTP_T0 + 301, 1)
      .map((row) => row.detail).join(' | ');
    expect(plan).toContain('idx_unwind_expiry');
    expect(plan).not.toContain('TEMP B-TREE');
    expect(stores.unwindJobs.reconcileExpired({ now: CCTP_T0 + 301, limit: 1 }))
      .toEqual([{ jobId: expired.jobId, status: 'expired' }]);
    stores.db.close();
  });

  it('projects an elapsed unleased reservation to expired on targeted authenticated reconciliation', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 100,
      capabilityExpiresAt: CCTP_T0 + 10_000,
      now: CCTP_T0,
    });

    expect(stores.unwindJobs.reconcileFromCctp({
      jobId: UNWIND_JOB_ID, now: CCTP_T0 + 101,
    })).toEqual({ jobId: UNWIND_JOB_ID, status: 'expired' });
    expect(stores.unwindJobs.status(UNWIND_JOB_ID)).toEqual({
      jobId: UNWIND_JOB_ID, status: 'expired',
    });
    stores.db.close();
  });

  it('lets a pre-expiry evidence claim commit after reservation expiry only while its exact lease is live', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 100,
      capabilityExpiresAt: CCTP_T0 + 10_000,
      now: CCTP_T0,
    });
    const lease = stores.unwindJobs.claimEvidence({
      jobId: UNWIND_JOB_ID, userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 50, leaseMs: 1_000, retryMs: 5_000,
    });

    expect(stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      leaseToken: lease.leaseToken,
      now: CCTP_T0 + 101,
    })).toEqual({
      duplicate: false,
      record: { jobId: UNWIND_JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH },
    });
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(1);
    stores.db.close();
  });

  it('binds an exact receipt candidate before burn expiry and retries it after expiry across reopen', () => {
    const path = freshPath();
    const input = unwindReserveInput(1, {
      expiresAt: CCTP_T0 + 100,
      capabilityExpiresAt: CCTP_T0 + 1_000,
    });
    let stores = createSqliteStores(path);
    stores.unwindJobs.reserve(input);
    const first = stores.unwindJobs.claimEvidence({
      jobId: input.jobId,
      userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 90,
      leaseMs: 30,
      retryMs: 400,
    });
    expect(stores.db.prepare('SELECT COUNT(*) AS count FROM cctp_relay_work').get().count).toBe(0);
    stores.unwindJobs.releaseEvidence({
      jobId: input.jobId, leaseToken: first.leaseToken, now: CCTP_T0 + 110,
    });
    stores.db.close();

    stores = createSqliteStores(path);
    const authority = stores.unwindJobs.getAuthority(input.jobId);
    expect(authority).toMatchObject({ state: 'awaiting_burn' });
    expect(authority.candidateUserOpHash).toBe(UNWIND_USER_OP_HASH);
    expect(authority.candidateUnwindTxHash).toBe(UNWIND_TX_HASH);
    expect(authority.evidenceRetryUntil).toBe(CCTP_T0 + 500);
    expect(stores.unwindJobs.status(input.jobId)).toEqual({
      jobId: input.jobId, status: 'awaiting_burn',
    });
    cctpThrowsCode(() => stores.unwindJobs.claimEvidence({
      jobId: input.jobId,
      userOpHash: `0x${'51'.repeat(32)}`,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 120,
      leaseMs: 30,
      retryMs: 400,
    }), 'UNWIND_CONFLICT');
    cctpThrowsCode(() => stores.unwindJobs.claimEvidence({
      jobId: input.jobId,
      userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: `0x${'61'.repeat(32)}`,
      now: CCTP_T0 + 120,
      leaseMs: 30,
      retryMs: 400,
    }), 'UNWIND_CONFLICT');

    const retry = stores.unwindJobs.claimEvidence({
      jobId: input.jobId,
      userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 120,
      leaseMs: 30,
      retryMs: 400,
    });
    expect(stores.unwindJobs.attachAndEnqueue({
      jobId: input.jobId,
      proof: { ...UNWIND_PROOF, jobCommitment: unwindProofFor(1).jobCommitment },
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${input.jobId}`,
      leaseToken: retry.leaseToken,
      now: CCTP_T0 + 130,
    }).record).toEqual({
      jobId: input.jobId, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH,
    });
    expect(stores.db.prepare('SELECT COUNT(*) AS count FROM cctp_relay_work').get().count).toBe(1);
    stores.db.close();
  });

  it('terminalizes an unproved candidate as submission_unknown after its bounded retry grace', () => {
    const stores = createSqliteStores(freshPath());
    const input = unwindReserveInput(1, {
      expiresAt: CCTP_T0 + 100,
      capabilityExpiresAt: CCTP_T0 + 500,
    });
    stores.unwindJobs.reserve(input);
    const claim = stores.unwindJobs.claimEvidence({
      jobId: input.jobId,
      userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 90,
      leaseMs: 30,
      retryMs: 200,
    });
    stores.unwindJobs.releaseEvidence({
      jobId: input.jobId, leaseToken: claim.leaseToken, now: CCTP_T0 + 110,
    });
    expect(stores.unwindJobs.reconcileExpired({ now: CCTP_T0 + 301, limit: 10 }))
      .toEqual([{
        jobId: input.jobId, status: 'uncertain', reasonCode: 'submission_unknown',
      }]);
    expect(stores.unwindJobs.claimEvidence({
      jobId: input.jobId,
      userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 302,
      leaseMs: 30,
      retryMs: 200,
    })).toBeNull();
    expect(stores.db.prepare('SELECT COUNT(*) AS count FROM cctp_relay_work').get().count).toBe(0);
    expect(JSON.stringify(stores.unwindJobs.status(input.jobId))).not.toContain(UNWIND_TX_HASH);
    stores.db.close();
  });

  it('does not make tentative candidate UserOperations globally unique before proof', () => {
    const stores = createSqliteStores(freshPath());
    const first = unwindReserveInput(1);
    const second = unwindReserveInput(2);
    stores.unwindJobs.reserve(first);
    stores.unwindJobs.reserve(second);
    const left = stores.unwindJobs.claimEvidence({
      jobId: first.jobId,
      userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 10,
      leaseMs: 30,
      retryMs: 200,
    });
    const right = stores.unwindJobs.claimEvidence({
      jobId: second.jobId,
      userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: `0x${'61'.repeat(32)}`,
      now: CCTP_T0 + 11,
      leaseMs: 30,
      retryMs: 200,
    });
    expect([left.jobId, right.jobId]).toEqual([first.jobId, second.jobId]);
    expect(stores.db.prepare(
      'SELECT COUNT(*) AS count FROM unwind_jobs WHERE candidate_user_op_hash=?',
    ).get(UNWIND_USER_OP_HASH).count).toBe(2);
    stores.db.close();
  });

  it('rejects post-expiry attach under an expired evidence lease without Task8 work', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 100,
      capabilityExpiresAt: CCTP_T0 + 10_000,
      now: CCTP_T0,
    });
    const lease = stores.unwindJobs.claimEvidence({
      jobId: UNWIND_JOB_ID, userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 50, leaseMs: 50, retryMs: 5_000,
    });
    cctpThrowsCode(() => stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      leaseToken: lease.leaseToken,
      now: CCTP_T0 + 101,
    }), 'UNWIND_CAS_CONFLICT');
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(0);
    stores.db.close();
  });

  it('rejects release with an evidence lease at or past its durable expiry', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    const lease = stores.unwindJobs.claimEvidence({
      jobId: UNWIND_JOB_ID, userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 1, leaseMs: 100, retryMs: 5_000,
    });

    expect(() => stores.unwindJobs.releaseEvidence({
      jobId: UNWIND_JOB_ID,
      leaseToken: lease.leaseToken,
      now: CCTP_T0 + 101,
    })).toThrow(/lease.*stale|CAS/i);
    expect(stores.db.prepare('SELECT lease_token FROM unwind_jobs WHERE job_id=?')
      .get(UNWIND_JOB_ID).lease_token).toBe(lease.leaseToken);
    stores.db.close();
  });

  it('fences terminal evidence classification and exposes only allowlisted public reasons', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    const lease = stores.unwindJobs.claimEvidence({
      jobId: UNWIND_JOB_ID, userOpHash: UNWIND_USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      now: CCTP_T0 + 1, leaseMs: 1_000, retryMs: 5_000,
    });

    expect(() => stores.unwindJobs.finishBlocked({
      jobId: UNWIND_JOB_ID,
      leaseToken: 'foreign-lease',
      reasonCode: 'message_mismatch',
      now: CCTP_T0 + 2,
    })).toThrow(/lease|CAS/i);
    expect(stores.unwindJobs.finishBlocked({
      jobId: UNWIND_JOB_ID,
      leaseToken: lease.leaseToken,
      reasonCode: 'message_mismatch',
      now: CCTP_T0 + 2,
    })).toEqual({
      jobId: UNWIND_JOB_ID,
      status: 'blocked',
      reasonCode: 'message_mismatch',
    });
    let invalidReason;
    try {
      stores.unwindJobs.finishUncertain({
        jobId: UNWIND_JOB_ID,
        reasonCode: 'not_allowlisted',
        now: CCTP_T0 + 3,
      });
    } catch (error) {
      invalidReason = error;
    }
    expect(invalidReason?.code).toBe('UNWIND_VALIDATION');
    expect(stores.unwindJobs.status(UNWIND_JOB_ID)).toEqual({
      jobId: UNWIND_JOB_ID,
      status: 'blocked',
      reasonCode: 'message_mismatch',
    });
    stores.db.close();
  });

  it('pins the exact unwind index and immutability-trigger ensemble', () => {
    const stores = createSqliteStores(freshPath());
    try {
      const indexes = stores.db.prepare('PRAGMA index_list(unwind_jobs)').all()
        .filter(({ origin }) => origin === 'c')
        .map(({ name, unique, partial }) => ({
          name, unique, partial,
          columns: stores.db.prepare(`PRAGMA index_info(${name})`).all()
            .map(({ name: column }) => column),
        })).sort((left, right) => left.name.localeCompare(right.name));
      expect(indexes).toEqual([
        { name: 'idx_unwind_expiry', unique: 0, partial: 1,
          columns: ['created_at', 'job_id'] },
        { name: 'idx_unwind_recovery', unique: 0, partial: 0,
          columns: [
            'created_at', 'job_id', 'state', 'expires_at',
            'evidence_retry_until', 'lease_expires_at',
          ] },
        { name: 'idx_unwind_relay_exec_id', unique: 1, partial: 0,
          columns: ['relay_exec_id'] },
        { name: 'idx_unwind_resume', unique: 0, partial: 1,
          columns: ['updated_at', 'created_at', 'job_id'] },
        { name: 'idx_unwind_tx_hash', unique: 0, partial: 0,
          columns: ['unwind_tx_hash'] },
        { name: 'idx_unwind_user_op_hash', unique: 1, partial: 0,
          columns: ['user_op_hash'] },
      ]);
      expect(stores.db.prepare(`
        SELECT lower(replace(replace(sql,' ',''),char(10),'')) AS sql
        FROM sqlite_master WHERE type='index' AND name='idx_unwind_resume'
      `).get().sql).toContain(
        "wherestatein('relay_pending','relay_running')andproof_digestisnotnull",
      );
      expect(stores.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='unwind_jobs'
        ORDER BY name
      `).all().map(({ name }) => name)).toEqual([
        'unwind_jobs_candidate_immutable',
        'unwind_jobs_no_delete',
        'unwind_jobs_proof_immutable',
        'unwind_jobs_reserve_immutable',
      ]);
      expect(stores.probe()).toMatchObject({ writable: true });
    } finally {
      stores.db.close();
    }
  });

  it.each([
    ['table', (db) => db.exec('ALTER TABLE unwind_jobs ADD COLUMN shadow TEXT')],
    ['index', (db) => db.exec(`
      DROP INDEX idx_unwind_tx_hash;
      CREATE UNIQUE INDEX idx_unwind_tx_hash ON unwind_jobs(unwind_tx_hash,job_id)
    `)],
    ['trigger', (db) => db.exec(`
      DROP TRIGGER unwind_jobs_no_delete;
      CREATE TRIGGER unwind_jobs_no_delete BEFORE DELETE ON unwind_jobs BEGIN SELECT 1; END
    `)],
  ])('fails closed on a corrupt preexisting unwind %s definition', (_label, corrupt) => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    corrupt(stores.db);
    stores.db.close();

    expect(() => createSqliteStores(path)).toThrow(/unwind.*(?:schema|table|index|trigger)|incompatible/i);
  });

  it('makes reservation and attached proof bindings immutable at the database boundary', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    expect(() => stores.db.prepare('UPDATE unwind_jobs SET kernel_address=? WHERE job_id=?')
      .run(`0x${'99'.repeat(20)}`, UNWIND_JOB_ID)).toThrow(/immutable unwind reservation/i);
    expect(() => stores.db.prepare('DELETE FROM unwind_jobs WHERE job_id=?')
      .run(UNWIND_JOB_ID)).toThrow(/immutable unwind authority/i);

    stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    expect(() => stores.db.prepare('UPDATE unwind_jobs SET proof_digest=? WHERE job_id=?')
      .run('99'.repeat(32), UNWIND_JOB_ID)).toThrow(/immutable unwind proof/i);
    stores.db.close();
  });

  it('rejects a checksum-invalid persisted Stellar recipient even when SQL shape checks pass', () => {
    const path = freshPath();
    const stores = createSqliteStores(path);
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    const trigger = stores.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='trigger' AND name='unwind_jobs_reserve_immutable'
    `).get().sql;
    const invalidRecipient = `G${'A'.repeat(55)}`;
    const reserveJson = JSON.stringify({
      jobId: UNWIND_JOB_ID,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: invalidRecipient,
    });
    const requestDigest = createHash('sha256')
      .update(`vf-unwind-reserve-v1\0${reserveJson}`).digest('hex');
    stores.db.exec('DROP TRIGGER unwind_jobs_reserve_immutable');
    stores.db.prepare(`
      UPDATE unwind_jobs SET recipient_hint=?,reserve_json=?,request_digest=? WHERE job_id=?
    `).run(invalidRecipient, reserveJson, requestDigest, UNWIND_JOB_ID);
    stores.db.exec(trigger);

    expect(() => stores.unwindJobs.status(UNWIND_JOB_ID))
      .toThrow(/recipient|StrKey|unwind.*integrity/i);
    stores.db.close();
  });

  it('recomputes the persisted source-message byte digest during readiness', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    const trigger = stores.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='trigger' AND name='unwind_jobs_proof_immutable'
    `).get().sql;
    const wrongDigest = '99'.repeat(32);
    const wrongProof = { ...UNWIND_PROOF, sourceMessageDigest: wrongDigest };
    const proofJson = JSON.stringify(wrongProof);
    const digest = createHash('sha256')
      .update(`vf-unwind-proof-v1\0${proofJson}`).digest('hex');
    stores.db.exec('DROP TRIGGER unwind_jobs_proof_immutable');
    stores.db.prepare(`
      UPDATE unwind_jobs SET source_message_digest=?,proof_json=?,proof_digest=? WHERE job_id=?
    `).run(wrongDigest, proofJson, digest, UNWIND_JOB_ID);
    stores.db.exec(trigger);

    expect(() => stores.unwindJobs.status(UNWIND_JOB_ID))
      .toThrow(/source.*digest|message.*integrity|unwind.*integrity/i);
    stores.db.close();
  });

  it('reopens from schema fingerprints without scanning lifetime unwind history', () => {
    const path = freshPath();
    let stores = createSqliteStores(path);
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    const columns = stores.db.prepare('PRAGMA table_xinfo(unwind_jobs)').all()
      .map(({ name }) => name);
    const expressions = columns.map((column) => {
      if (column === 'job_id') return "printf('%032x',seq.n)";
      if (column === 'capability_hash') return "printf('%064x',seq.n)";
      return `seed.${column}`;
    });
    stores.db.exec(`
      WITH RECURSIVE seq(n) AS (
        SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<500
      )
      INSERT INTO unwind_jobs (${columns.join(',')})
      SELECT ${expressions.join(',')}
      FROM unwind_jobs AS seed CROSS JOIN seq
      WHERE seed.job_id='${UNWIND_JOB_ID}'
    `);
    stores.db.close();

    // Copied historical rows intentionally retain the seed's reserve_json/request_digest while
    // carrying different job IDs. A lifetime semantic scan would reject startup; bounded lazy
    // validation instead rejects only the selected corrupt authority.
    stores = createSqliteStores(path);
    expect(stores.probe().unwindDurable).toBe(true);
    expect(() => stores.unwindJobs.status('000000000000000000000000000001f4'))
      .toThrow(/reservation.*integrity|binding.*integrity/i);
    expect(stores.unwindJobs.status(UNWIND_JOB_ID)).toEqual({
      jobId: UNWIND_JOB_ID, status: 'awaiting_burn',
    });
    stores.db.close();
  });

  it('rejects an unwind terminal projection that is ahead of Task8 authority', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    stores.db.prepare(`
      UPDATE unwind_jobs SET state='done',mint_tx_hash=?,updated_at=? WHERE job_id=?
    `).run('aa'.repeat(32), CCTP_T0 + 2, UNWIND_JOB_ID);

    expect(() => stores.unwindJobs.status(UNWIND_JOB_ID))
      .toThrow(/Task8|terminal|projection|unwind.*integrity/i);
    stores.db.close();
  });

  it('fails runtime reconciliation closed when the unwind wrapper is ahead of Task8', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    stores.db.prepare(`UPDATE unwind_jobs SET state='relay_running' WHERE job_id=?`)
      .run(UNWIND_JOB_ID);

    cctpThrowsCode(() => stores.unwindJobs.reconcileFromCctp({
      jobId: UNWIND_JOB_ID, now: CCTP_T0 + 2,
    }), 'UNWIND_CONFLICT');
    expect(() => stores.unwindJobs.status(UNWIND_JOB_ID))
      .toThrow(/Task8|projection|integrity/i);
    stores.db.close();
  });

  it('rejects a raw-SQL-corrupt Task8 row before projecting unwind completion', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve(unwindReserveInput(1, {
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      now: CCTP_T0,
    }));
    stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    const before = stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?')
      .get(UNWIND_JOB_ID);

    stores.db.exec('PRAGMA ignore_check_constraints=ON');
    stores.db.prepare(`
      UPDATE cctp_relay_work SET state='minted',mint_tx_hash=?,updated_at=?
      WHERE exec_id=?
    `).run('aa'.repeat(32), CCTP_T0 + 2, `unwind:${UNWIND_JOB_ID}`);
    stores.db.exec('PRAGMA ignore_check_constraints=OFF');

    cctpThrowsCode(() => stores.unwindJobs.reconcileFromCctp({
      jobId: UNWIND_JOB_ID, now: CCTP_T0 + 3,
    }), 'UNWIND_CONFLICT');
    expect(stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?').get(UNWIND_JOB_ID))
      .toEqual(before);
    expect(stores.db.prepare('SELECT state,mint_tx_hash FROM unwind_jobs WHERE job_id=?')
      .get(UNWIND_JOB_ID)).toEqual({ state: 'relay_pending', mint_tx_hash: null });
    stores.db.close();
  });

  it('makes an invented pre-proof mint hash unrepresentable in SQLite', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });

    expect(() => stores.db.prepare(`
      UPDATE unwind_jobs SET state='uncertain',reason_code='submission_unknown',
        mint_tx_hash=?,updated_at=? WHERE job_id=?
    `).run('aa'.repeat(32), CCTP_T0 + 1, UNWIND_JOB_ID)).toThrow(/constraint|check/i);
    expect(stores.unwindJobs.status(UNWIND_JOB_ID)).toEqual({
      jobId: UNWIND_JOB_ID, status: 'awaiting_burn',
    });
    stores.db.close();
  });

  it('retains a known Stellar mint hash when Task8 projects submitted-checkpoint uncertainty', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });
    stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    const mintTxHash = 'dd'.repeat(32);
    const execId = `unwind:${UNWIND_JOB_ID}`;
    const claim = stores.cctpRelays.claim({ execId, now: CCTP_T0 + 2, leaseMs: 10_000 });
    stores.cctpRelays.recordAttested({
      execId, leaseToken: claim.leaseToken,
      messageHex: CCTP_MESSAGE_HEX, nonceHex: CCTP_NONCE_HEX,
      attestationHex: CCTP_ATTESTATION_HEX, now: CCTP_T0 + 2,
    });
    stores.cctpRelays.markMintSubmitting({
      execId, leaseToken: claim.leaseToken, now: CCTP_T0 + 2,
    });
    stores.cctpRelays.finishUncertain({
      execId, leaseToken: claim.leaseToken, mintTxHash,
      reasonCode: 'submitted_checkpoint_failed', now: CCTP_T0 + 2,
    });

    expect(stores.unwindJobs.reconcileFromCctp({
      jobId: UNWIND_JOB_ID, now: CCTP_T0 + 3,
    })).toEqual({
      jobId: UNWIND_JOB_ID,
      status: 'uncertain',
      unwindTxHash: UNWIND_TX_HASH,
      mintTxHash,
      reasonCode: 'submitted_checkpoint_failed',
    });
    expect(stores.unwindJobs.status(UNWIND_JOB_ID)).toEqual({
      jobId: UNWIND_JOB_ID,
      status: 'uncertain',
      unwindTxHash: UNWIND_TX_HASH,
      mintTxHash,
      reasonCode: 'submitted_checkpoint_failed',
    });
    stores.db.close();
  });

  it('atomically commits canonical proof, immutable expectation, and one Task8 relay row', () => {
    const stores = createSqliteStores(freshPath());
    stores.unwindJobs.reserve({
      jobId: UNWIND_JOB_ID,
      capabilityHash: UNWIND_CAPABILITY_HASH,
      kernelAddress: UNWIND_KERNEL,
      recipientHint: UNWIND_RECIPIENT,
      requestDigest: UNWIND_REQUEST_DIGEST,
      expiresAt: CCTP_T0 + 3_600_000,
      capabilityExpiresAt: CCTP_T0 + 4_200_000,
      now: CCTP_T0,
    });

    const first = stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 1,
    });
    const before = stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?')
      .get(UNWIND_JOB_ID);
    const retry = stores.unwindJobs.attachAndEnqueue({
      jobId: UNWIND_JOB_ID,
      proof: UNWIND_PROOF,
      expectation: CCTP_REVERSE_EXPECTATION,
      relayExecId: `unwind:${UNWIND_JOB_ID}`,
      now: CCTP_T0 + 999,
    });

    expect(first).toEqual({
      duplicate: false,
      record: { jobId: UNWIND_JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH },
    });
    expect(retry).toEqual({ duplicate: true, record: first.record });
    expect(stores.db.prepare('SELECT * FROM unwind_jobs WHERE job_id=?').get(UNWIND_JOB_ID))
      .toEqual(before);
    expect(before).toMatchObject({
      user_op_hash: UNWIND_USER_OP_HASH,
      unwind_tx_hash: UNWIND_TX_HASH,
      chain_id: 84532,
      entry_point: UNWIND_ENTRY_POINT,
      block_number: '12345678',
      burned: '1234567',
      proof_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      expectation_digest: CCTP_REVERSE_EXPECTATION_DIGEST,
      relay_exec_id: `unwind:${UNWIND_JOB_ID}`,
    });
    expect(stores.cctpRelays.get(`unwind:${UNWIND_JOB_ID}`)).toMatchObject({
      sourceDomain: 6,
      burnTxHash: UNWIND_TX_HASH,
      expectationDigest: CCTP_REVERSE_EXPECTATION_DIGEST,
      state: 'attestation_pending',
      attempts: 0,
    });
    expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(1);
    stores.db.close();
  });

  it.each(['relay_insert', 'unwind_update'])(
    'rolls back both proof and Task8 enqueue when attach fails after %s',
    (failureStage) => {
      const stores = createSqliteStores(freshPath(), {
        unwindFault(stage) {
          if (stage === failureStage) throw new Error(`injected ${stage}`);
        },
      });
      stores.unwindJobs.reserve({
        jobId: UNWIND_JOB_ID,
        capabilityHash: UNWIND_CAPABILITY_HASH,
        kernelAddress: UNWIND_KERNEL,
        recipientHint: UNWIND_RECIPIENT,
        requestDigest: UNWIND_REQUEST_DIGEST,
        expiresAt: CCTP_T0 + 3_600_000,
        capabilityExpiresAt: CCTP_T0 + 4_200_000,
        now: CCTP_T0,
      });

      expect(() => stores.unwindJobs.attachAndEnqueue({
        jobId: UNWIND_JOB_ID,
        proof: UNWIND_PROOF,
        expectation: CCTP_REVERSE_EXPECTATION,
        relayExecId: `unwind:${UNWIND_JOB_ID}`,
        now: CCTP_T0 + 1,
      })).toThrow(`injected ${failureStage}`);
      expect(stores.db.prepare('SELECT proof_digest,state FROM unwind_jobs WHERE job_id=?')
        .get(UNWIND_JOB_ID)).toEqual({ proof_digest: null, state: 'awaiting_burn' });
      expect(stores.db.prepare('SELECT COUNT(*) AS n FROM cctp_relay_work').get().n).toBe(0);
      stores.db.close();
    },
  );
});
