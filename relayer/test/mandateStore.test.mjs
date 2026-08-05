import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createMandateStoresV3 } from '../src/mandateStore.mjs';
import { createSecretEnvelope, parseSecretKeyring } from '../src/secretEnvelope.mjs';
import { createSqliteStores } from '../src/sqliteStores.mjs';

const NOW_SECONDS = 2_000_000_000;
const VALID_UNTIL_SECONDS = NOW_SECONDS + 7_200;
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const KERNEL = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SESSION_KEY_DIGEST = 'd796cb759ab4fbd29dbe7a352e38c76d1a8838dd926b2934e2c81b37fbd2a915';
const SESSION = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const MANDATE_ID = '7d8f94a2c16b4e6488bf07b81234abcd';
const APPROVAL = 'canonical-approval-fixture';
const APPROVAL_DIGEST = createHash('sha256').update(APPROVAL).digest('hex');
const POLICY_DIGEST = 'dd'.repeat(32);
const CAPABILITY_HASH = 'aa'.repeat(32);
const BINDING_HASH = createHash('sha256')
  .update(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL_SECONDS}`)
  .digest('hex');
const USER_OP_HASH = `0x${'33'.repeat(32)}`;
const TX_HASH = `0x${'44'.repeat(32)}`;

function cipher(entries = [['active', Buffer.alloc(32, 0x31)]]) {
  return createSecretEnvelope(parseSecretKeyring(
    entries.map(([id, key]) => `${id}:${key.toString('base64')}`).join(','),
  ));
}

function record(overrides = {}) {
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
    permissionId: '0x1234abcd',
    ...overrides,
  };
}

function identity(overrides = {}) {
  return { mandateId: MANDATE_ID, stellarOwner: OWNER, kernelAddress: KERNEL, ...overrides };
}

function expectNoAuthorityLeak(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const forbidden = new Set([
    'sessionprivatekey', 'sessionkeydigest', 'session_key_digest',
    'capabilityhash', 'sessionkeyenvelope', 'session_key_envelope',
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') expect(forbidden.has(key.toLowerCase())).toBe(false);
    expectNoAuthorityLeak(value[key], seen);
  }
  expect(JSON.stringify(value)).not.toContain(SESSION_PRIVATE_KEY);
  expect(JSON.stringify(value)).not.toContain(SESSION_KEY_DIGEST);
  expect(JSON.stringify(value)).not.toContain(CAPABILITY_HASH);
}

function lifecycleSnapshot(stores) {
  const internal = stores.mandatesV3.get(identity());
  return {
    mandate: stores.mandatesV3.status(identity()),
    work: stores.mandateActivations.get(identity()),
    internal,
    sessionPrivateKey: internal?.sessionPrivateKey,
    capabilityHash: internal?.capabilityHash,
    rawMandate: stores.db?.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?')
      .get(MANDATE_ID),
    rawWork: stores.db?.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
      .get(MANDATE_ID),
  };
}

function expectLifecycleUnchanged(stores, before) {
  expect(stores.mandatesV3.status(identity())).toEqual(before.mandate);
  expect(stores.mandateActivations.get(identity())).toEqual(before.work);
  const internal = stores.mandatesV3.get(identity());
  expect(internal).toEqual(before.internal);
  expect(internal?.sessionPrivateKey).toBe(before.sessionPrivateKey);
  expect(internal?.capabilityHash).toBe(before.capabilityHash);
  if (stores.db) {
    expect(stores.db.prepare('SELECT * FROM mandates_v3 WHERE mandate_id = ?').get(MANDATE_ID))
      .toEqual(before.rawMandate);
    expect(stores.db.prepare('SELECT * FROM mandate_activation_work WHERE mandate_id = ?')
      .get(MANDATE_ID)).toEqual(before.rawWork);
  }

  expect(stores.mandateActivations.enqueue({ record: record() })).toMatchObject({
    duplicate: true,
    mandate: before.mandate,
    work: before.work,
  });
  expect(() => stores.mandateActivations.enqueue({
    record: record({ sessionPrivateKey: `0x${'23'.repeat(32)}` }),
  })).toThrow(/immutable|conflict/i);
  expect(stores.mandatesV3.status(identity())).toEqual(before.mandate);
  expect(stores.mandateActivations.get(identity())).toEqual(before.work);
}

const implementations = [
  {
    name: 'memory',
    open(clock, { leaseToken = () => `lease-${clock.value}` } = {}) {
      return {
        stores: createMandateStoresV3({
          nowSeconds: () => clock.value,
          leaseToken,
        }),
        close() {},
      };
    },
  },
  {
    name: 'SQLite',
    open(clock, { leaseToken = () => `lease-${clock.value}` } = {}) {
      const path = join(mkdtempSync(join(tmpdir(), 'vf-mandate-parity-')), 'relayer.db');
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(),
        nowSeconds: () => clock.value,
        leaseToken,
      });
      return { stores, close: () => stores.db.close() };
    },
  },
];

describe.each(implementations)('$name mandate activation lifecycle parity', ({ open }) => {
  it('atomically enqueues a capability-bound mandate and exposes no authority publicly', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      const queued = stores.mandateActivations.enqueue({ record: record() });

      expect(queued.work).toMatchObject({
        mandateId: MANDATE_ID, status: 'pending', attempts: 0, leaseToken: null,
      });
      expect(stores.mandatesV3.status(identity())).toMatchObject({
        mandateId: MANDATE_ID,
        policyDigest: POLICY_DIGEST,
        kernelAddress: KERNEL.toLowerCase(),
        sessionKeyAddress: SESSION.toLowerCase(),
        validUntilSeconds: VALID_UNTIL_SECONDS,
        status: 'pending_activation',
      });
      expectNoAuthorityLeak(queued);
      expectNoAuthorityLeak(stores.mandatesV3.status(identity()));
      expectNoAuthorityLeak(stores.mandateActivations.get(identity()));

      const internal = stores.mandatesV3.get(identity());
      expect(internal.sessionPrivateKey).toBe(SESSION_PRIVATE_KEY);
      expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
      expect(internal.policyDigest).toBe(POLICY_DIGEST);
      expect(Object.keys(internal)).not.toContain('sessionPrivateKey');
      expect(Object.keys(internal)).not.toContain('capabilityHash');
      expect(Reflect.ownKeys(internal)).not.toContain('sessionKeyDigest');
      expect(Reflect.ownKeys(internal)).not.toContain('session_key_digest');
      expect(Object.getOwnPropertyDescriptor(internal, 'sessionPrivateKey')?.enumerable).toBe(false);
      expect(Object.getOwnPropertyDescriptor(internal, 'capabilityHash')?.enumerable).toBe(false);
    } finally {
      close();
    }
  });

  it('requires a capability hash on every newly enqueued mandate', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      expect(() => stores.mandateActivations.enqueue({
        record: record({ capabilityHash: null }),
      })).toThrow(/capability/i);
    } finally {
      close();
    }
  });

  it('requires the canonical Task4 policy digest on every newly enqueued mandate', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      expect(() => stores.mandateActivations.enqueue({
        record: record({ policyDigest: undefined }),
      })).toThrow(/policy.*digest|digest.*policy/i);
    } finally {
      close();
    }
  });

  it.each([
    ['approval digest', { approvalDigest: 'cc'.repeat(32) }],
    ['policy digest', { policyDigest: 'cc'.repeat(32) }],
    ['capability hash', { capabilityHash: 'cc'.repeat(32) }],
    ['session private key', { sessionPrivateKey: `0x${'23'.repeat(32)}` }],
    ['session address', { sessionKeyAddress: `0x${'34'.repeat(20)}` }],
    ['owner', { stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey() }],
    ['kernel', { kernelAddress: '0x1234567890AbcdEF1234567890aBcdef12345678' }],
    ['binding ID', { bindingId: 'binding-2' }],
    ['binding hash', { bindingHash: 'cc'.repeat(32) }],
    ['relayer origin', { relayerOrigin: 'https://other-relayer.example' }],
    ['permission ID', { permissionId: '0x87654321' }],
    ['expiry', { validUntilSeconds: VALID_UNTIL_SECONDS + 1 }],
  ])('rejects duplicate mandate ID conflict in immutable %s without changing original authority or work', (_label, conflict) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      expect(() => stores.mandateActivations.enqueue({ record: record(conflict) }))
        .toThrow(/conflict|immutable|duplicate/i);
      const internal = stores.mandatesV3.get(identity());
      expect(internal.sessionPrivateKey).toBe(SESSION_PRIVATE_KEY);
      expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
      expect(stores.mandatesV3.status(identity())).toMatchObject({
        approvalDigest: APPROVAL_DIGEST,
        sessionKeyAddress: SESSION.toLowerCase(),
        kernelAddress: KERNEL.toLowerCase(),
        bindingId: 'binding-1',
        bindingHash: BINDING_HASH,
        relayerOrigin: 'https://relayer.example',
        permissionId: '0x1234abcd',
        validUntilSeconds: VALID_UNTIL_SECONDS,
        status: 'pending_activation',
      });
      if (_label === 'policy digest') {
        expect(stores.mandatesV3.status(identity()).policyDigest).toBe(POLICY_DIGEST);
        expect(stores.mandatesV3.get(identity()).policyDigest).toBe(POLICY_DIGEST);
      }
      expect(stores.mandateActivations.get(identity()))
        .toMatchObject({ status: 'pending', attempts: 0, leaseToken: null });
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: NOW_SECONDS })).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('treats an identical enqueue as idempotent without replacing authority or duplicating work', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      const first = stores.mandateActivations.enqueue({ record: record() });
      const duplicate = stores.mandateActivations.enqueue({ record: record() });

      expect(duplicate).toMatchObject({
        duplicate: true,
        mandate: { mandateId: MANDATE_ID, approvalDigest: APPROVAL_DIGEST },
        work: { mandateId: MANDATE_ID, status: 'pending', attempts: 0 },
      });
      expect(duplicate.work.createdAt).toBe(first.work.createdAt);
      expectNoAuthorityLeak(duplicate);
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value }))
        .toEqual([expect.objectContaining({ mandateId: MANDATE_ID, status: 'pending' })]);
      expect(stores.mandatesV3.size).toBe(1);
    } finally {
      close();
    }
  });

  it('canonicalizes omitted, undefined, and null optional metadata before duplicate comparison', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    const omitted = record();
    delete omitted.relayerOrigin;
    delete omitted.bindingId;
    delete omitted.permissionId;
    try {
      stores.mandateActivations.enqueue({ record: omitted });
      for (const duplicateRecord of [
        { ...omitted },
        { ...omitted, relayerOrigin: undefined, bindingId: undefined, permissionId: undefined },
        { ...omitted, relayerOrigin: null, bindingId: null, permissionId: null },
      ]) {
        expect(stores.mandateActivations.enqueue({ record: duplicateRecord })).toMatchObject({
          duplicate: true,
          mandate: { relayerOrigin: null, bindingId: null, permissionId: null },
          work: { status: 'pending', attempts: 0 },
        });
      }
      expect(() => stores.mandateActivations.enqueue({
        record: { ...omitted, permissionId: '0x87654321' },
      })).toThrow(/immutable|conflict/i);
      expect(stores.mandatesV3.size).toBe(1);
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value }))
        .toHaveLength(1);
    } finally {
      close();
    }
  });

  it('persists the caller-provided canonical approval and binding hashes without deriving replacements', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      expect(stores.mandatesV3.status(identity())).toMatchObject({
        approvalDigest: APPROVAL_DIGEST,
        policyDigest: POLICY_DIGEST,
        bindingHash: BINDING_HASH,
        validUntilSeconds: VALID_UNTIL_SECONDS,
      });
      expect(stores.mandatesV3.get(identity())).toMatchObject({
        serializedApproval: APPROVAL,
        approvalDigest: APPROVAL_DIGEST,
        policyDigest: POLICY_DIGEST,
        bindingHash: BINDING_HASH,
      });
    } finally {
      close();
    }
  });

  it.each([
    ['owner', { stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey() }],
    ['kernel', { kernelAddress: '0x1234567890AbcdEF1234567890aBcdef12345678' }],
  ])('isolates get/status/claim/revoke by the full identity when %s is wrong', (_label, wrong) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const wrongIdentity = identity(wrong);
      expect(stores.mandatesV3.get(wrongIdentity)).toBeNull();
      expect(stores.mandatesV3.status(wrongIdentity).status).toBe('missing');
      expect(stores.mandateActivations.get(wrongIdentity)).toBeNull();
      expect(stores.mandateActivations.claim({ ...wrongIdentity, leaseSeconds: 30 })).toBeNull();
      expect(stores.mandatesV3.revoke(wrongIdentity)).toBeNull();
      expect(stores.mandatesV3.status(identity()).status).toBe('pending_activation');
      expect(stores.mandateActivations.get(identity()).status).toBe('pending');
    } finally {
      close();
    }
  });

  it('moves pending -> running -> submitting -> submitted -> done and writes active metadata atomically', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: clock.value, leaseSeconds: 30,
      });
      expect(claimed).toMatchObject({ status: 'running', attempts: 1, leaseExpiresAt: NOW_SECONDS + 30 });

      const submitting = stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting', nowSeconds: clock.value + 1,
      });
      expect(submitting.status).toBe('submitting');
      const submitted = stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
        userOpHash: USER_OP_HASH, nowSeconds: clock.value + 2,
      });
      expect(submitted).toMatchObject({ status: 'submitted', userOpHash: USER_OP_HASH });

      const finished = stores.mandateActivations.finishActive({
        ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
        txHash: TX_HASH, activatedAt: clock.value + 3, nowSeconds: clock.value + 3,
      });
      expect(finished.work).toMatchObject({ status: 'done', leaseToken: null, leaseExpiresAt: null });
      expect(finished.mandate).toMatchObject({
        status: 'active', activationUserOpHash: USER_OP_HASH,
        activationTxHash: TX_HASH, activatedAt: clock.value + 3,
      });
      expect(stores.mandatesV3.status(identity())).toMatchObject(finished.mandate);
      expectNoAuthorityLeak(finished);
    } finally {
      close();
    }
  });

  it.each(['running', 'submitting', 'submitted'])('renews a live %s activation lease without regressing state', (activationStatus) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS, leaseSeconds: 20,
      });
      if (activationStatus !== 'running') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
          nowSeconds: NOW_SECONDS + 1,
        });
      }
      if (activationStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
          userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
        });
      }

      const renewed = stores.mandateActivations.renew({
        ...identity(), leaseToken: claimed.leaseToken,
        nowSeconds: NOW_SECONDS + 5, leaseSeconds: 40,
      });
      expect(renewed).toMatchObject({
        status: activationStatus,
        attempts: 1,
        leaseToken: claimed.leaseToken,
        leaseExpiresAt: NOW_SECONDS + 45,
      });
      if (activationStatus === 'submitted') expect(renewed.userOpHash).toBe(USER_OP_HASH);
    } finally {
      close();
    }
  });

  it('caps a renewed lease at mandate expiry and rejects renewal once the mandate expires', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS,
        leaseSeconds: VALID_UNTIL_SECONDS - NOW_SECONDS,
      });
      expect(stores.mandateActivations.renew({
        ...identity(), leaseToken: claimed.leaseToken,
        nowSeconds: VALID_UNTIL_SECONDS - 10, leaseSeconds: 30,
      })).toMatchObject({
        status: 'running', leaseToken: claimed.leaseToken,
        leaseExpiresAt: VALID_UNTIL_SECONDS,
      });
      expect(() => stores.mandateActivations.renew({
        ...identity(), leaseToken: claimed.leaseToken,
        nowSeconds: VALID_UNTIL_SECONDS, leaseSeconds: 30,
      })).toThrow(/mandate|expired|expiry|lease/i);
      clock.value = VALID_UNTIL_SECONDS;
      expect(stores.mandatesV3.status(identity()).status).toBe('expired');
    } finally {
      close();
    }
  });

  it('wipes authority and deletes running work when renewal observes exact mandate expiry', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS,
        leaseSeconds: VALID_UNTIL_SECONDS - NOW_SECONDS,
      });

      let expiryError;
      try {
        stores.mandateActivations.renew({
          ...identity(), leaseToken: claimed.leaseToken,
          nowSeconds: VALID_UNTIL_SECONDS, leaseSeconds: 30,
        });
      } catch (error) {
        expiryError = error;
      }
      expect(expiryError).toBeInstanceOf(Error);
      expect(expiryError.message).toMatch(/mandate|expired|expiry/i);
      expect(expiryError.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(expiryError.message).not.toContain(SESSION_KEY_DIGEST);
      expect(expiryError.message).not.toContain(CAPABILITY_HASH);

      // Keep the injected wall clock live while inspecting. These assertions can only pass when
      // the rejected renewal itself committed the expiry cleanup rather than a later status read.
      const internal = stores.mandatesV3.get(identity());
      expect(internal.sessionPrivateKey).toBeUndefined();
      expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
      expect(stores.mandateActivations.get(identity())).toBeNull();
      if (stores.db) {
        expect(stores.db.prepare(`
          SELECT session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
        expect(stores.db.prepare(`
          SELECT COUNT(*) AS n FROM mandate_activation_work WHERE mandate_id = ?
        `).get(MANDATE_ID).n).toBe(0);
      }

      clock.value = VALID_UNTIL_SECONDS;
      const publicStatus = stores.mandatesV3.status(identity());
      expect(publicStatus.status).toBe('expired');
      expectNoAuthorityLeak(publicStatus);
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
    } finally {
      close();
    }
  });

  it('wipes authority and fences submitted work uncertain when finish observes exact mandate expiry', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS,
        leaseSeconds: VALID_UNTIL_SECONDS - NOW_SECONDS,
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
        nowSeconds: NOW_SECONDS + 1,
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
        userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
      });

      let expiryError;
      try {
        stores.mandateActivations.finishActive({
          ...identity(), leaseToken: claimed.leaseToken,
          userOpHash: USER_OP_HASH, txHash: TX_HASH,
          activatedAt: VALID_UNTIL_SECONDS - 1,
          nowSeconds: VALID_UNTIL_SECONDS,
        });
      } catch (error) {
        expiryError = error;
      }
      expect(expiryError).toBeInstanceOf(Error);
      expect(expiryError.message).toMatch(/mandate|expired|expiry/i);
      expect(expiryError.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(expiryError.message).not.toContain(SESSION_KEY_DIGEST);
      expect(expiryError.message).not.toContain(CAPABILITY_HASH);

      // The global clock remains pre-expiry so reads cannot perform the transition on behalf of
      // finishActive. The rejected finish must already have crossed the work into uncertainty.
      const internal = stores.mandatesV3.get(identity());
      expect(internal).toMatchObject({ status: 'activation_uncertain' });
      expect(internal.sessionPrivateKey).toBeUndefined();
      expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
      const uncertain = stores.mandateActivations.get(identity());
      expect(uncertain).toMatchObject({
        status: 'uncertain',
        leaseToken: null,
        leaseExpiresAt: null,
        userOpHash: USER_OP_HASH,
        txHash: null,
      });
      expectNoAuthorityLeak(uncertain);
      if (stores.db) {
        expect(stores.db.prepare(`
          SELECT status, session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'activation_uncertain',
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
        expect(stores.db.prepare(`
          SELECT status, lease_token, lease_expires_at, user_op_hash, tx_hash
          FROM mandate_activation_work WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'uncertain',
          lease_token: null,
          lease_expires_at: null,
          user_op_hash: USER_OP_HASH,
          tx_hash: null,
        });
      }

      clock.value = VALID_UNTIL_SECONDS;
      const publicStatus = stores.mandatesV3.status(identity());
      expect(publicStatus.status).toBe('expired');
      expectNoAuthorityLeak(publicStatus);
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
    } finally {
      close();
    }
  });

  it('rejects the old token after an expired running lease is reconciled and reclaimed', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const first = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS, leaseSeconds: 10,
      });
      stores.mandateActivations.reconcileExpired({ nowSeconds: NOW_SECONDS + 10 });
      const reclaimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS + 10, leaseSeconds: 20,
      });
      expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
      expect(() => stores.mandateActivations.renew({
        ...identity(), leaseToken: first.leaseToken,
        nowSeconds: NOW_SECONDS + 11, leaseSeconds: 20,
      })).toThrow(/stale|lease|token/i);
      expect(stores.mandateActivations.renew({
        ...identity(), leaseToken: reclaimed.leaseToken,
        nowSeconds: NOW_SECONDS + 11, leaseSeconds: 20,
      })).toMatchObject({
        status: 'running', attempts: 2, leaseToken: reclaimed.leaseToken,
        leaseExpiresAt: NOW_SECONDS + 31,
      });
    } finally {
      close();
    }
  });

  it('leaves all mandate authority and work unchanged when lease-token generation fails', () => {
    const clock = { value: NOW_SECONDS };
    let calls = 0;
    const { stores, close } = open(clock, {
      leaseToken() {
        calls += 1;
        if (calls === 1) throw new Error('injected lease-token source failure');
        return 'recovered-lease-token';
      },
    });
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const before = lifecycleSnapshot(stores);
      let failure;
      try {
        stores.mandateActivations.claim({
          ...identity(), nowSeconds: NOW_SECONDS, leaseSeconds: 30,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/lease|token|source|injected/i);
      expect(failure.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(failure.message).not.toContain(SESSION_KEY_DIGEST);
      expect(failure.message).not.toContain(CAPABILITY_HASH);
      expectLifecycleUnchanged(stores, before);

      const claimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS, leaseSeconds: 30,
      });
      expect(claimed).toMatchObject({ status: 'running', attempts: 1 });
      expect(typeof claimed.leaseToken).toBe('string');
      expect(claimed.leaseToken.length).toBeGreaterThan(0);
      expectNoAuthorityLeak(claimed);
    } finally {
      close();
    }
  });

  it('issues a distinct nonempty token through 32 lease-expiry reclaim cycles', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock, { leaseToken: () => 'repeated-token' });
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const issued = new Set();
      let previousToken = null;

      for (let cycle = 0; cycle < 32; cycle += 1) {
        const claimedAt = NOW_SECONDS + (cycle * 2);
        clock.value = claimedAt;
        const claimed = stores.mandateActivations.claim({
          ...identity(), nowSeconds: claimedAt, leaseSeconds: 1,
        });
        expect(claimed).toMatchObject({ status: 'running', attempts: cycle + 1 });
        expect(typeof claimed.leaseToken).toBe('string');
        expect(claimed.leaseToken.length).toBeGreaterThan(0);
        expect(issued.has(claimed.leaseToken)).toBe(false);
        if (previousToken !== null) {
          expect(() => stores.mandateActivations.renew({
            ...identity(), leaseToken: previousToken,
            nowSeconds: claimedAt, leaseSeconds: 1,
          })).toThrow(/stale|lease|token/i);
        }
        issued.add(claimed.leaseToken);
        previousToken = claimed.leaseToken;

        clock.value = claimedAt + 1;
        expect(stores.mandateActivations.reconcileExpired({ nowSeconds: clock.value }))
          .toEqual([expect.objectContaining({
            status: 'pending', attempts: cycle + 1,
            leaseToken: null, leaseExpiresAt: null,
          })]);
        expect(stores.mandateActivations.get(identity())).toMatchObject({
          status: 'pending', attempts: cycle + 1,
          leaseToken: null, leaseExpiresAt: null,
        });
      }

      expect(issued.size).toBe(32);
    } finally {
      close();
    }
  });

  it('rejects stale, expired, and wrong-identity activation lease heartbeats', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS, leaseSeconds: 20,
      });
      expect(() => stores.mandateActivations.renew({
        ...identity(), leaseToken: 'stale-token', nowSeconds: NOW_SECONDS + 1, leaseSeconds: 20,
      })).toThrow(/stale|lease|token/i);
      expect(() => stores.mandateActivations.renew({
        ...identity({ stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey() }),
        leaseToken: claimed.leaseToken, nowSeconds: NOW_SECONDS + 1, leaseSeconds: 20,
      })).toThrow(/identity|missing|stale|lease/i);
      expect(() => stores.mandateActivations.renew({
        ...identity(), leaseToken: claimed.leaseToken,
        nowSeconds: claimed.leaseExpiresAt, leaseSeconds: 20,
      })).toThrow(/expired|stale|lease/i);
      expect(stores.mandateActivations.get(identity())).toMatchObject({
        status: 'running', leaseExpiresAt: claimed.leaseExpiresAt,
      });
    } finally {
      close();
    }
  });

  it.each(['done', 'revoked'])('rejects activation lease heartbeats after the mandate is %s', (terminal) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      if (terminal === 'done') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
        });
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitted', userOpHash: USER_OP_HASH,
        });
        stores.mandateActivations.finishActive({
          ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
          txHash: TX_HASH, activatedAt: NOW_SECONDS,
        });
      } else {
        stores.mandatesV3.revoke(identity());
      }
      expect(() => stores.mandateActivations.renew({
        ...identity(), leaseToken: claimed.leaseToken,
        nowSeconds: NOW_SECONDS + 1, leaseSeconds: 30,
      })).toThrow(/terminal|revoked|missing|stale|lease/i);
    } finally {
      close();
    }
  });

  it('rejects stale lease tokens and submitted hash disagreement', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      expect(() => stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: 'stale', status: 'submitting',
      })).toThrow(/stale|lease/i);
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted', userOpHash: USER_OP_HASH,
      });
      expect(() => stores.mandateActivations.finishActive({
        ...identity(), leaseToken: claimed.leaseToken, userOpHash: `0x${'55'.repeat(32)}`,
        txHash: TX_HASH, activatedAt: NOW_SECONDS + 1,
      })).toThrow(/hash|submitted|stale/i);
    } finally {
      close();
    }
  });

  it('rejects a stale worker after another worker has terminalized the activation', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken,
      });
      expect(() => stores.mandateActivations.finishActive({
        ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
        txHash: TX_HASH, activatedAt: clock.value + 1,
      })).toThrow(/stale|terminal|uncertain|lease/i);
      expect(stores.mandatesV3.status(identity()).status).toBe('activation_uncertain');
    } finally {
      close();
    }
  });

  it.each([
    ['running directly to submitted', ({ stores, claimed }) => stores.mandateActivations.checkpoint({
      ...identity(), leaseToken: claimed.leaseToken, status: 'submitted', userOpHash: USER_OP_HASH,
    })],
    ['finishActive before submitted', ({ stores, claimed }) => stores.mandateActivations.finishActive({
      ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
      txHash: TX_HASH, activatedAt: NOW_SECONDS + 1,
    })],
    ['submitted with a noncanonical user-op hash', ({ stores, claimed }) => {
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      return stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted', userOpHash: '0x1234',
      });
    }],
    ['checkpoint at mandate expiry', ({ stores, claimed }) => stores.mandateActivations.checkpoint({
      ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      nowSeconds: VALID_UNTIL_SECONDS,
    })],
  ])('rejects illegal activation transition: %s', (_label, transition) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      expect(() => transition({ stores, claimed })).toThrow(/transition|submitted|expiry|expired|hash|state/i);
      expect(stores.mandatesV3.status(identity()).status).toBe('pending_activation');
    } finally {
      close();
    }
  });

  it.each(['checkpoint', 'finishActive'])('rejects %s exactly at leaseExpiresAt before reconciliation', (operation) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), nowSeconds: NOW_SECONDS, leaseSeconds: 30,
      });
      if (operation === 'finishActive') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken,
          status: 'submitting', nowSeconds: NOW_SECONDS + 1,
        });
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
          userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
        });
        expect(() => stores.mandateActivations.finishActive({
          ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
          txHash: TX_HASH, activatedAt: NOW_SECONDS + 3,
          nowSeconds: claimed.leaseExpiresAt,
        })).toThrow(/lease|expired|stale/i);
        expect(stores.mandateActivations.get(identity()).status).toBe('submitted');
      } else {
        expect(() => stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
          nowSeconds: claimed.leaseExpiresAt,
        })).toThrow(/lease|expired|stale/i);
        expect(stores.mandateActivations.get(identity()).status).toBe('running');
      }
      expect(stores.mandatesV3.status(identity()).status).toBe('pending_activation');
    } finally {
      close();
    }
  });

  it.each([
    ['malformed user-op hash', { userOpHash: '0x1234' }],
    ['malformed transaction hash', { txHash: '0x1234' }],
    ['uppercase transaction hash', { txHash: `0x${'AB'.repeat(32)}` }],
    ['zero activation time', { activatedAt: 0 }],
    ['negative activation time', { activatedAt: -1 }],
    ['non-integer activation time', { activatedAt: NOW_SECONDS + 0.5 }],
    ['unsafe activation time', { activatedAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['activation time exactly at mandate expiry', { activatedAt: VALID_UNTIL_SECONDS }],
    ['post-expiry activation time', { activatedAt: VALID_UNTIL_SECONDS + 1 }],
  ])('rejects finishActive with %s without terminalizing work', (_label, invalid) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted', userOpHash: USER_OP_HASH,
      });
      expect(() => stores.mandateActivations.finishActive({
        ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
        txHash: TX_HASH, activatedAt: NOW_SECONDS + 1, ...invalid,
      })).toThrow(/hash|activation|time|canonical|safe|submitted|expiry|expired/i);
      expect(stores.mandateActivations.get(identity()).status).toBe('submitted');
      expect(stores.mandatesV3.status(identity()).status).toBe('pending_activation');
    } finally {
      close();
    }
  });

  it('accepts a chain activation timestamp slightly ahead of local finish time while still live', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken,
        status: 'submitting', nowSeconds: NOW_SECONDS + 1,
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
        userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
      });
      expect(stores.mandateActivations.finishActive({
        ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
        txHash: TX_HASH, nowSeconds: NOW_SECONDS + 3, activatedAt: NOW_SECONDS + 4,
      })).toMatchObject({
        mandate: { status: 'active', activatedAt: NOW_SECONDS + 4 },
        work: { status: 'done' },
      });
    } finally {
      close();
    }
  });

  it('requeues an expired running lease that never crossed the submission fence', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const first = stores.mandateActivations.claim({
        ...identity(), nowSeconds: clock.value, leaseSeconds: 10,
      });
      clock.value += 10;
      expect(stores.mandateActivations.reconcileExpired({ nowSeconds: clock.value }))
        .toEqual([expect.objectContaining({ mandateId: MANDATE_ID, status: 'pending', attempts: 1 })]);
      expect(stores.mandatesV3.status(identity()).status).toBe('pending_activation');
      const reclaimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 10 });
      expect(reclaimed).toMatchObject({
        status: 'running', attempts: 2,
      });
      expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
      expect(() => stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: first.leaseToken, status: 'submitting',
      })).toThrow(/stale|lease/i);
    } finally {
      close();
    }
  });

  it.each(['submitting', 'submitted'])('marks an expired %s lease uncertain and never requeues it', (fencedStatus) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 10 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      if (fencedStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitted', userOpHash: USER_OP_HASH,
        });
      }
      clock.value += 10;
      expect(stores.mandateActivations.reconcileExpired({ nowSeconds: clock.value }))
        .toEqual([expect.objectContaining({ mandateId: MANDATE_ID, status: 'uncertain' })]);
      expect(stores.mandatesV3.status(identity()).status).toBe('activation_uncertain');
      expect(stores.mandateActivations.claim({ ...identity() })).toBeNull();
    } finally {
      close();
    }
  });

  it('finishes uncertain only after the submission fence', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      expect(() => stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken,
      })).toThrow(/submitting|submitted|fence/i);
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      const finished = stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken,
      });
      expect(finished).toMatchObject({
        mandate: { status: 'activation_uncertain' }, work: { status: 'uncertain' },
      });
      expectNoAuthorityLeak(finished);
    } finally {
      close();
    }
  });

  it.each([
    ['submitting with a returned hash', 'submitting', USER_OP_HASH],
    ['submitted with an omitted hash', 'submitted', undefined],
    ['submitted with the matching hash', 'submitted', USER_OP_HASH],
  ])('finishes uncertain from %s without losing submission evidence', (
    _label, fencedStatus, suppliedUserOpHash,
  ) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      if (fencedStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken,
          status: 'submitted', userOpHash: USER_OP_HASH,
        });
      }

      const request = { ...identity(), leaseToken: claimed.leaseToken };
      if (suppliedUserOpHash !== undefined) request.userOpHash = suppliedUserOpHash;
      const finished = stores.mandateActivations.finishUncertain(request);

      expect(finished).toMatchObject({
        mandate: { status: 'activation_uncertain' },
        work: {
          status: 'uncertain', userOpHash: USER_OP_HASH,
          leaseToken: null, leaseExpiresAt: null,
        },
      });
      expect(stores.mandatesV3.status(identity()).status).toBe('activation_uncertain');
      expect(stores.mandateActivations.get(identity())).toMatchObject({
        status: 'uncertain', userOpHash: USER_OP_HASH,
        leaseToken: null, leaseExpiresAt: null,
      });
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
      expectNoAuthorityLeak(finished);
    } finally {
      close();
    }
  });

  it.each([
    ['a malformed hash from submitting', 'submitting', '0x1234', undefined],
    ['an uppercase hash from submitting', 'submitting', `0x${'AB'.repeat(32)}`, undefined],
    ['a malformed hash from submitted', 'submitted', '0x1234', undefined],
    ['an uppercase hash from submitted', 'submitted', `0x${'AB'.repeat(32)}`, undefined],
    ['a mismatched hash from submitted', 'submitted', `0x${'55'.repeat(32)}`, undefined],
    ['a mismatched hash with transaction evidence from submitted',
      'submitted', `0x${'55'.repeat(32)}`, TX_HASH],
  ])('rejects finishUncertain with %s without changing fenced work', (
    _label, fencedStatus, suppliedUserOpHash, suppliedTxHash,
  ) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      if (fencedStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken,
          status: 'submitted', userOpHash: USER_OP_HASH,
        });
      }
      const before = lifecycleSnapshot(stores);

      expect(() => stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken,
        userOpHash: suppliedUserOpHash, txHash: suppliedTxHash,
      })).toThrow(/hash|canonical|mismatch|submitted/i);
      expectLifecycleUnchanged(stores, before);
    } finally {
      close();
    }
  });

  it.each([
    ['submitting with both hashes returned together', 'submitting', USER_OP_HASH],
    ['submitted with a stored user-op hash', 'submitted', undefined],
    ['submitted with both matching hashes', 'submitted', USER_OP_HASH],
  ])('finishes uncertain from %s while retaining confirmed transaction evidence', (
    _label, fencedStatus, suppliedUserOpHash,
  ) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      if (fencedStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken,
          status: 'submitted', userOpHash: USER_OP_HASH,
        });
      }

      const request = { ...identity(), leaseToken: claimed.leaseToken, txHash: TX_HASH };
      if (suppliedUserOpHash !== undefined) request.userOpHash = suppliedUserOpHash;
      const finished = stores.mandateActivations.finishUncertain(request);

      expect(finished).toMatchObject({
        mandate: { status: 'activation_uncertain' },
        work: {
          status: 'uncertain', userOpHash: USER_OP_HASH, txHash: TX_HASH,
          leaseToken: null, leaseExpiresAt: null,
        },
      });
      expect(stores.mandateActivations.get(identity())).toMatchObject({
        status: 'uncertain', userOpHash: USER_OP_HASH, txHash: TX_HASH,
        leaseToken: null, leaseExpiresAt: null,
      });
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
      expectNoAuthorityLeak(finished);
    } finally {
      close();
    }
  });

  it.each([
    ['a malformed transaction hash from submitting', 'submitting', USER_OP_HASH, '0x1234'],
    ['an uppercase transaction hash from submitting',
      'submitting', USER_OP_HASH, `0x${'AB'.repeat(32)}`],
    ['a transaction hash without a user-op hash', 'submitting', undefined, TX_HASH],
    ['a malformed transaction hash from submitted', 'submitted', undefined, '0x1234'],
    ['an uppercase transaction hash from submitted',
      'submitted', undefined, `0x${'AB'.repeat(32)}`],
  ])('rejects finishUncertain with %s without changing fenced work', (
    _label, fencedStatus, suppliedUserOpHash, suppliedTxHash,
  ) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      if (fencedStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken,
          status: 'submitted', userOpHash: USER_OP_HASH,
        });
      }
      const before = lifecycleSnapshot(stores);
      const request = {
        ...identity(), leaseToken: claimed.leaseToken, txHash: suppliedTxHash,
      };
      if (suppliedUserOpHash !== undefined) request.userOpHash = suppliedUserOpHash;

      expect(() => stores.mandateActivations.finishUncertain(request))
        .toThrow(/hash|canonical|user.?op|transaction|submitted/i);
      expectLifecycleUnchanged(stores, before);
    } finally {
      close();
    }
  });

  it.each([
    ['a missing lease token', () => ({ leaseToken: undefined })],
    ['a stale lease token', () => ({ leaseToken: 'stale-token' })],
    ['an expired lease', ({ claimed }) => ({ nowSeconds: claimed.leaseExpiresAt })],
    ['a wrong mandate ID', () => ({ mandateId: 'ee'.repeat(16) })],
    ['a wrong owner', () => ({
      stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey(),
    })],
    ['a wrong kernel', () => ({ kernelAddress: `0x${'77'.repeat(20)}` })],
  ])('rejects finishUncertain with %s without changing activation state', (
    _label, invalidRequest,
  ) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      const before = lifecycleSnapshot(stores);

      expect(() => stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
        ...invalidRequest({ claimed }),
      })).toThrow(/lease|stale|missing|identity|expiry|expired|mandate/i);
      expectLifecycleUnchanged(stores, before);
    } finally {
      close();
    }
  });

  it('wipes authority and fences submitting work when finishUncertain observes mandate expiry', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), leaseSeconds: VALID_UNTIL_SECONDS - NOW_SECONDS,
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });

      let expiryError;
      try {
        stores.mandateActivations.finishUncertain({
          ...identity(), leaseToken: claimed.leaseToken, userOpHash: USER_OP_HASH,
          nowSeconds: VALID_UNTIL_SECONDS,
        });
      } catch (error) {
        expiryError = error;
      }
      expect(expiryError).toBeInstanceOf(Error);
      expect(expiryError.message).toMatch(/mandate|expired|expiry/i);
      expect(expiryError.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(expiryError.message).not.toContain(SESSION_KEY_DIGEST);
      expect(expiryError.message).not.toContain(CAPABILITY_HASH);

      const internal = stores.mandatesV3.get(identity());
      expect(internal).toMatchObject({
        status: 'activation_uncertain', capabilityHash: CAPABILITY_HASH,
      });
      expect(internal.sessionPrivateKey).toBeUndefined();
      expect(stores.mandateActivations.get(identity())).toMatchObject({
        status: 'uncertain', leaseToken: null, leaseExpiresAt: null,
        userOpHash: null, txHash: null,
      });
      if (stores.db) {
        expect(stores.db.prepare(`
          SELECT status, session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'activation_uncertain',
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
        expect(stores.db.prepare(`
          SELECT status, lease_token, lease_expires_at, user_op_hash, tx_hash
          FROM mandate_activation_work WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'uncertain', lease_token: null, lease_expires_at: null,
          user_op_hash: null, tx_hash: null,
        });
      }

      clock.value = VALID_UNTIL_SECONDS;
      const publicStatus = stores.mandatesV3.status(identity());
      expect(publicStatus.status).toBe('expired');
      expectNoAuthorityLeak(publicStatus);
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
    } finally {
      close();
    }
  });

  it('never overwrites retained transaction evidence on a conflicting repeat', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken,
        userOpHash: USER_OP_HASH, txHash: TX_HASH,
      });
      const beforeMandate = stores.mandatesV3.status(identity());
      const beforeWork = stores.mandateActivations.get(identity());
      expect(beforeWork).toMatchObject({
        status: 'uncertain', userOpHash: USER_OP_HASH, txHash: TX_HASH,
      });

      expect(() => stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken,
        userOpHash: USER_OP_HASH, txHash: `0x${'66'.repeat(32)}`,
      })).toThrow(/hash|conflict|mismatch|stale|terminal|uncertain|lease/i);
      expect(stores.mandatesV3.status(identity())).toEqual(beforeMandate);
      expect(stores.mandateActivations.get(identity())).toEqual(beforeWork);
    } finally {
      close();
    }
  });

  it('atomically revokes a submitted activation while retaining confirmed receipt evidence', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken,
        status: 'submitting', nowSeconds: NOW_SECONDS + 1,
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
        userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
      });

      const finished = stores.mandateActivations.finishRevoked({
        ...identity(), leaseToken: claimed.leaseToken,
        userOpHash: USER_OP_HASH, txHash: TX_HASH,
        activatedAt: NOW_SECONDS + 3, nowSeconds: NOW_SECONDS + 3,
      });
      expect(finished).toMatchObject({
        mandate: {
          status: 'revoked', activationUserOpHash: USER_OP_HASH,
          activationTxHash: TX_HASH, activatedAt: NOW_SECONDS + 3,
        },
      });
      expect(finished.work).toBeNull();
      expect(stores.mandatesV3.status(identity())).toMatchObject({
        status: 'revoked', activationUserOpHash: USER_OP_HASH,
        activationTxHash: TX_HASH, activatedAt: NOW_SECONDS + 3,
      });
      expect(stores.mandateActivations.get(identity())).toBeNull();
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
      const internal = stores.mandatesV3.get(identity());
      expect(internal.sessionPrivateKey).toBeUndefined();
      expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
      expect(Reflect.ownKeys(internal)).not.toContain('sessionKeyDigest');
      expect(Reflect.ownKeys(internal)).not.toContain('session_key_digest');
      expect(JSON.stringify(internal)).not.toContain(SESSION_PRIVATE_KEY);
      expect(JSON.stringify(internal)).not.toContain(SESSION_KEY_DIGEST);
      if (stores.db) {
        expect(stores.db.prepare(`
          SELECT status, activation_user_op_hash, activation_tx_hash, activated_at,
                 session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'revoked',
          activation_user_op_hash: USER_OP_HASH,
          activation_tx_hash: TX_HASH,
          activated_at: NOW_SECONDS + 3,
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
      }
      expect(() => stores.mandateActivations.enqueue({
        record: record({ sessionPrivateKey: `0x${'23'.repeat(32)}` }),
      })).toThrow(/immutable|conflict/i);
      const duplicate = stores.mandateActivations.enqueue({ record: record() });
      expect(duplicate).toMatchObject({
        duplicate: true, mandate: { status: 'revoked' }, work: null,
      });
      expect(stores.mandateActivations.get(identity())).toBeNull();
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
      expectNoAuthorityLeak(finished);
      expectNoAuthorityLeak(duplicate);
    } finally {
      close();
    }
  });

  it('accepts a revoked receipt timestamp slightly ahead of local finish time while still live', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken,
        status: 'submitting', nowSeconds: NOW_SECONDS + 1,
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
        userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
      });

      const finished = stores.mandateActivations.finishRevoked({
        ...identity(), leaseToken: claimed.leaseToken,
        userOpHash: USER_OP_HASH, txHash: TX_HASH,
        nowSeconds: NOW_SECONDS + 3, activatedAt: NOW_SECONDS + 4,
      });
      expect(finished).toMatchObject({
        mandate: {
          status: 'revoked', activationUserOpHash: USER_OP_HASH,
          activationTxHash: TX_HASH, activatedAt: NOW_SECONDS + 4,
        },
        work: null,
      });
      expect(stores.mandateActivations.get(identity())).toBeNull();
      expectNoAuthorityLeak(finished);
    } finally {
      close();
    }
  });

  it.each([
    ['a missing lease token', 'submitted', () => ({ leaseToken: undefined })],
    ['a stale lease token', 'submitted', () => ({ leaseToken: 'stale-token' })],
    ['an expired lease', 'submitted', ({ claimed }) => ({ nowSeconds: claimed.leaseExpiresAt })],
    ['a wrong mandate ID', 'submitted', () => ({ mandateId: 'ee'.repeat(16) })],
    ['a wrong owner', 'submitted', () => ({
      stellarOwner: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey(),
    })],
    ['a wrong kernel', 'submitted', () => ({ kernelAddress: `0x${'77'.repeat(20)}` })],
    ['a missing user-op hash', 'submitted', () => ({ userOpHash: undefined })],
    ['a mismatched user-op hash', 'submitted', () => ({ userOpHash: `0x${'55'.repeat(32)}` })],
    ['a malformed user-op hash', 'submitted', () => ({ userOpHash: '0x1234' })],
    ['an uppercase user-op hash', 'submitted', () => ({ userOpHash: `0x${'AB'.repeat(32)}` })],
    ['a missing transaction hash', 'submitted', () => ({ txHash: undefined })],
    ['a malformed transaction hash', 'submitted', () => ({ txHash: '0x1234' })],
    ['an uppercase transaction hash', 'submitted', () => ({ txHash: `0x${'AB'.repeat(32)}` })],
    ['a running pre-submission state', 'running', () => ({})],
    ['a submitting pre-receipt state', 'submitting', () => ({})],
    ['a missing activation time', 'submitted', () => ({ activatedAt: undefined })],
    ['zero activation time', 'submitted', () => ({ activatedAt: 0 })],
    ['negative activation time', 'submitted', () => ({ activatedAt: -1 })],
    ['non-integer activation time', 'submitted', () => ({ activatedAt: NOW_SECONDS + 0.5 })],
    ['unsafe activation time', 'submitted', () => ({ activatedAt: Number.MAX_SAFE_INTEGER + 1 })],
    ['activation time at mandate expiry', 'submitted', () => ({ activatedAt: VALID_UNTIL_SECONDS })],
    ['activation time after mandate expiry', 'submitted', () => ({ activatedAt: VALID_UNTIL_SECONDS + 1 })],
  ])('rejects finishRevoked with %s without changing activation state', (
    _label, fencedStatus, invalidRequest,
  ) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      if (fencedStatus !== 'running') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken,
          status: 'submitting', nowSeconds: NOW_SECONDS + 1,
        });
      }
      if (fencedStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
          userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
        });
      }
      const before = lifecycleSnapshot(stores);

      expect(() => stores.mandateActivations.finishRevoked({
        ...identity(), leaseToken: claimed.leaseToken,
        userOpHash: USER_OP_HASH, txHash: TX_HASH,
        activatedAt: NOW_SECONDS + 3, nowSeconds: NOW_SECONDS + 3,
        ...invalidRequest({ claimed }),
      })).toThrow(/state|submitted|lease|stale|hash|canonical|activated.?at|timestamp|time|safe|expiry|expired/i);
      expectLifecycleUnchanged(stores, before);
    } finally {
      close();
    }
  });

  it('wipes authority and retains submission evidence when finishRevoked observes mandate expiry', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const claimed = stores.mandateActivations.claim({
        ...identity(), leaseSeconds: VALID_UNTIL_SECONDS - NOW_SECONDS,
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
        nowSeconds: NOW_SECONDS + 1,
      });
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
        userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
      });

      let expiryError;
      try {
        stores.mandateActivations.finishRevoked({
          ...identity(), leaseToken: claimed.leaseToken,
          userOpHash: USER_OP_HASH, txHash: TX_HASH,
          activatedAt: NOW_SECONDS + 3, nowSeconds: VALID_UNTIL_SECONDS,
        });
      } catch (error) {
        expiryError = error;
      }
      expect(expiryError).toBeInstanceOf(Error);
      expect(expiryError.message).toMatch(/mandate|expired|expiry/i);
      expect(expiryError.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(expiryError.message).not.toContain(SESSION_KEY_DIGEST);
      expect(expiryError.message).not.toContain(CAPABILITY_HASH);

      const internal = stores.mandatesV3.get(identity());
      expect(internal).toMatchObject({
        status: 'activation_uncertain', capabilityHash: CAPABILITY_HASH,
      });
      expect(internal.sessionPrivateKey).toBeUndefined();
      expect(stores.mandateActivations.get(identity())).toMatchObject({
        status: 'uncertain', leaseToken: null, leaseExpiresAt: null,
        userOpHash: USER_OP_HASH, txHash: null,
      });
      if (stores.db) {
        expect(stores.db.prepare(`
          SELECT status, session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'activation_uncertain',
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
        expect(stores.db.prepare(`
          SELECT status, lease_token, lease_expires_at, user_op_hash, tx_hash
          FROM mandate_activation_work WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          status: 'uncertain', lease_token: null, lease_expires_at: null,
          user_op_hash: USER_OP_HASH, tx_hash: null,
        });
      }

      clock.value = VALID_UNTIL_SECONDS;
      const publicStatus = stores.mandatesV3.status(identity());
      expect(publicStatus.status).toBe('expired');
      expectNoAuthorityLeak(publicStatus);
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
    } finally {
      close();
    }
  });

  it('revokes atomically, retaining public identity and private capability auth while wiping the key and work', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      const revoked = stores.mandatesV3.revoke(identity());
      expect(revoked).toMatchObject({
        mandateId: MANDATE_ID, approvalDigest: APPROVAL_DIGEST, status: 'revoked',
      });
      expect(stores.mandateActivations.get(identity())).toBeNull();
      const internal = stores.mandatesV3.get(identity());
      expect(internal.sessionPrivateKey).toBeUndefined();
      expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
      expect(Reflect.ownKeys(internal)).not.toContain('sessionKeyDigest');
      expect(Reflect.ownKeys(internal)).not.toContain('session_key_digest');
      expect(Object.keys(internal)).not.toContain('capabilityHash');
      expect(Object.getOwnPropertyDescriptor(internal, 'capabilityHash')?.enumerable).toBe(false);
      expectNoAuthorityLeak(revoked);
    } finally {
      close();
    }
  });

  it.each([
    ['exactly at expiry', VALID_UNTIL_SECONDS],
    ['after expiry', VALID_UNTIL_SECONDS + 1],
  ])('returns derived expired status when revoke is called %s and still wipes authority work', (
    _label, revokeAt,
  ) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      clock.value = revokeAt;

      const revoked = stores.mandatesV3.revoke(identity());
      expect(revoked).toMatchObject({
        mandateId: MANDATE_ID,
        validUntilSeconds: VALID_UNTIL_SECONDS,
        status: 'expired',
      });
      expectNoAuthorityLeak(revoked);
      expect(stores.mandateActivations.get(identity())).toBeNull();

      const internal = stores.mandatesV3.get(identity());
      expect(internal.sessionPrivateKey).toBeUndefined();
      expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
      expect(Reflect.ownKeys(internal)).not.toContain('sessionKeyDigest');
      expect(Reflect.ownKeys(internal)).not.toContain('session_key_digest');
      if (stores.db) {
        expect(stores.db.prepare(`
          SELECT session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
      }

      expect(stores.mandateActivations.enqueue({ record: record() })).toMatchObject({
        duplicate: true,
        mandate: { status: 'expired' },
        work: null,
      });
      expect(() => stores.mandateActivations.enqueue({
        record: record({ sessionPrivateKey: `0x${'23'.repeat(32)}` }),
      })).toThrow(/immutable|conflict/i);
    } finally {
      close();
    }
  });

  it.each(['submitting', 'submitted'])(
    'preserves expired %s activation as uncertain when revoke is the first expiry observer',
    (fencedStatus) => {
      const clock = { value: NOW_SECONDS };
      const { stores, close } = open(clock);
      try {
        stores.mandateActivations.enqueue({ record: record() });
        const claimed = stores.mandateActivations.claim({
          ...identity(),
          leaseSeconds: (VALID_UNTIL_SECONDS - NOW_SECONDS) + 30,
        });
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken,
          status: 'submitting', nowSeconds: NOW_SECONDS + 1,
        });
        if (fencedStatus === 'submitted') {
          stores.mandateActivations.checkpoint({
            ...identity(), leaseToken: claimed.leaseToken,
            status: 'submitted', userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
          });
        }

        clock.value = VALID_UNTIL_SECONDS;
        const expired = stores.mandatesV3.revoke(identity());
        expect(expired).toMatchObject({
          mandateId: MANDATE_ID,
          validUntilSeconds: VALID_UNTIL_SECONDS,
          status: 'expired',
        });
        expectNoAuthorityLeak(expired);
        expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);

        // Move the injected clock back so these assertions observe the durable base state written
        // by revoke itself instead of deriving `expired` again on behalf of the test.
        clock.value = NOW_SECONDS;
        const internal = stores.mandatesV3.get(identity());
        expect(internal).toMatchObject({
          status: 'activation_uncertain',
          capabilityHash: CAPABILITY_HASH,
        });
        expect(internal.sessionPrivateKey).toBeUndefined();
        const work = stores.mandateActivations.get(identity());
        expect(work).toMatchObject({
          status: 'uncertain',
          leaseToken: null,
          leaseExpiresAt: null,
          userOpHash: fencedStatus === 'submitted' ? USER_OP_HASH : null,
          txHash: null,
        });
        expectNoAuthorityLeak(work);

        if (stores.db) {
          expect(stores.db.prepare(`
            SELECT status, session_key_envelope, session_key_digest, capability_hash
            FROM mandates_v3 WHERE mandate_id = ?
          `).get(MANDATE_ID)).toEqual({
            status: 'activation_uncertain',
            session_key_envelope: null,
            session_key_digest: SESSION_KEY_DIGEST,
            capability_hash: CAPABILITY_HASH,
          });
          expect(stores.db.prepare(`
            SELECT status, lease_token, lease_expires_at, user_op_hash, tx_hash
            FROM mandate_activation_work WHERE mandate_id = ?
          `).get(MANDATE_ID)).toEqual({
            status: 'uncertain',
            lease_token: null,
            lease_expires_at: null,
            user_op_hash: fencedStatus === 'submitted' ? USER_OP_HASH : null,
            tx_hash: null,
          });
        }
      } finally {
        close();
      }
    },
  );

  it('reports expiry in seconds without deleting or relabeling the public record active', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      clock.value = VALID_UNTIL_SECONDS;
      expect(stores.mandatesV3.status(identity())).toMatchObject({
        mandateId: MANDATE_ID, validUntilSeconds: VALID_UNTIL_SECONDS, status: 'expired',
      });
      expect(stores.mandatesV3.size).toBe(1);
      expect(stores.mandatesV3.get(identity()).sessionPrivateKey).toBeUndefined();
      expect(stores.mandatesV3.get(identity()).capabilityHash).toBe(CAPABILITY_HASH);
    } finally {
      close();
    }
  });

  it.each(['pending', 'running', 'submitting', 'submitted'])(
    'cleans expired %s activation work exactly even when duplicate enqueue is the first read',
    (activationStatus) => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      let claimed;
      if (activationStatus !== 'pending') {
        claimed = stores.mandateActivations.claim({
          ...identity(), nowSeconds: NOW_SECONDS,
          leaseSeconds: (VALID_UNTIL_SECONDS - NOW_SECONDS) + 30,
        });
      }
      if (activationStatus === 'submitting' || activationStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken,
          status: 'submitting', nowSeconds: NOW_SECONDS + 1,
        });
      }
      if (activationStatus === 'submitted') {
        stores.mandateActivations.checkpoint({
          ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
          userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
        });
      }
      clock.value = VALID_UNTIL_SECONDS;

      const duplicate = stores.mandateActivations.enqueue({ record: record() });
      expect(duplicate).toMatchObject({ duplicate: true, mandate: { status: 'expired' } });
      expectNoAuthorityLeak(duplicate);
      if (activationStatus === 'pending' || activationStatus === 'running') {
        expect(duplicate.work).toBeNull();
      } else {
        expect(duplicate.work).toMatchObject({
          status: 'uncertain', leaseToken: null, leaseExpiresAt: null,
        });
        if (activationStatus === 'submitted') {
          expect(duplicate.work.userOpHash).toBe(USER_OP_HASH);
        }
      }
      expect(stores.mandatesV3.status(identity()).status).toBe('expired');
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
      const internal = stores.mandatesV3.get(identity());
      expect(internal.sessionPrivateKey).toBeUndefined();
      expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
      expect(JSON.stringify(internal)).not.toContain(SESSION_KEY_DIGEST);
      expect(Reflect.ownKeys(internal)).not.toContain('sessionKeyDigest');
      expect(Reflect.ownKeys(internal)).not.toContain('session_key_digest');
      if (stores.db) {
        expect(stores.db.prepare(`
          SELECT session_key_envelope, session_key_digest, capability_hash
          FROM mandates_v3 WHERE mandate_id = ?
        `).get(MANDATE_ID)).toEqual({
          session_key_envelope: null,
          session_key_digest: SESSION_KEY_DIGEST,
          capability_hash: CAPABILITY_HASH,
        });
      }

      const work = stores.mandateActivations.get(identity());
      if (activationStatus === 'pending' || activationStatus === 'running') {
        expect(work).toBeNull();
      } else {
        expect(work).toMatchObject({
          status: 'uncertain', leaseToken: null, leaseExpiresAt: null,
        });
      }
      expectNoAuthorityLeak(work);
      expect(stores.mandateActivations.reconcileExpired({ nowSeconds: clock.value }))
        .toEqual([]);
      expect(stores.mandatesV3.status(identity()).status).toBe('expired');

      let conflictError;
      try {
        stores.mandateActivations.enqueue({
          record: record({ sessionPrivateKey: `0x${'23'.repeat(32)}` }),
        });
      } catch (error) {
        conflictError = error;
      }
      expect(conflictError?.message).toMatch(/immutable|conflict/i);
      expect(conflictError?.message).not.toContain(SESSION_PRIVATE_KEY);
      expect(conflictError?.message).not.toContain(SESSION_KEY_DIGEST);
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
    } finally {
      close();
    }
  });

  it.each(['pending', 'submitted'])(
    'persists expired %s cleanup when a conflicting duplicate is the first read',
    (activationStatus) => {
      const clock = { value: NOW_SECONDS };
      const { stores, close } = open(clock);
      try {
        stores.mandateActivations.enqueue({ record: record() });
        if (activationStatus === 'submitted') {
          const claimed = stores.mandateActivations.claim({
            ...identity(), nowSeconds: NOW_SECONDS,
            leaseSeconds: (VALID_UNTIL_SECONDS - NOW_SECONDS) + 30,
          });
          stores.mandateActivations.checkpoint({
            ...identity(), leaseToken: claimed.leaseToken,
            status: 'submitting', nowSeconds: NOW_SECONDS + 1,
          });
          stores.mandateActivations.checkpoint({
            ...identity(), leaseToken: claimed.leaseToken, status: 'submitted',
            userOpHash: USER_OP_HASH, nowSeconds: NOW_SECONDS + 2,
          });
        }
        clock.value = VALID_UNTIL_SECONDS;

        let conflictError;
        try {
          stores.mandateActivations.enqueue({
            record: record({ sessionPrivateKey: `0x${'23'.repeat(32)}` }),
          });
        } catch (error) {
          conflictError = error;
        }
        expect(conflictError).toBeInstanceOf(Error);
        expect(conflictError.message).toMatch(/immutable|conflict/i);
        expect(conflictError.message).not.toContain(SESSION_PRIVATE_KEY);
        expect(conflictError.message).not.toContain(SESSION_KEY_DIGEST);
        expect(conflictError.message).not.toContain(CAPABILITY_HASH);

        // Move the injected clock back before inspecting. These reads must not be able to perform
        // expiry cleanup on behalf of the rejected conflicting enqueue.
        clock.value = NOW_SECONDS;
        const internal = stores.mandatesV3.get(identity());
        expect(internal.sessionPrivateKey).toBeUndefined();
        expect(internal.capabilityHash).toBe(CAPABILITY_HASH);
        expect(internal.status).toBe(
          activationStatus === 'pending' ? 'pending_activation' : 'activation_uncertain',
        );
        const work = stores.mandateActivations.get(identity());
        if (activationStatus === 'pending') {
          expect(work).toBeNull();
        } else {
          expect(work).toMatchObject({
            status: 'uncertain', leaseToken: null, leaseExpiresAt: null,
            userOpHash: USER_OP_HASH, txHash: null,
          });
        }
        expectNoAuthorityLeak(work);

        if (stores.db) {
          expect(stores.db.prepare(`
            SELECT status, session_key_envelope, session_key_digest, capability_hash
            FROM mandates_v3 WHERE mandate_id = ?
          `).get(MANDATE_ID)).toEqual({
            status: activationStatus === 'pending'
              ? 'pending_activation'
              : 'activation_uncertain',
            session_key_envelope: null,
            session_key_digest: SESSION_KEY_DIGEST,
            capability_hash: CAPABILITY_HASH,
          });
          const rawWork = stores.db.prepare(`
            SELECT status, lease_token, lease_expires_at, user_op_hash, tx_hash
            FROM mandate_activation_work WHERE mandate_id = ?
          `).get(MANDATE_ID);
          if (activationStatus === 'pending') {
            expect(rawWork).toBeUndefined();
          } else {
            expect(rawWork).toEqual({
              status: 'uncertain', lease_token: null, lease_expires_at: null,
              user_op_hash: USER_OP_HASH, tx_hash: null,
            });
          }
        }

        // An identical replay remaining idempotent after the key wipe demonstrates that the
        // internal session digest was retained for duplicate comparison.
        const originalReplay = stores.mandateActivations.enqueue({ record: record() });
        expect(originalReplay).toMatchObject({ duplicate: true });
        expectNoAuthorityLeak(originalReplay);

        clock.value = VALID_UNTIL_SECONDS;
        const publicStatus = stores.mandatesV3.status(identity());
        expect(publicStatus.status).toBe('expired');
        expectNoAuthorityLeak(publicStatus);
        expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value })).toEqual([]);
      } finally {
        close();
      }
    },
  );

  it('never returns terminal or currently leased work as recoverable', () => {
    const clock = { value: NOW_SECONDS };
    const { stores, close } = open(clock);
    try {
      stores.mandateActivations.enqueue({ record: record() });
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value }))
        .toHaveLength(1);
      const claimed = stores.mandateActivations.claim({ ...identity(), leaseSeconds: 30 });
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value }))
        .toEqual([]);
      stores.mandateActivations.checkpoint({
        ...identity(), leaseToken: claimed.leaseToken, status: 'submitting',
      });
      stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken,
      });
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value + 31 }))
        .toEqual([]);
    } finally {
      close();
    }
  });
});
