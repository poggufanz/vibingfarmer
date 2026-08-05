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
const SESSION = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const MANDATE_ID = '7d8f94a2c16b4e6488bf07b81234abcd';
const APPROVAL = 'canonical-approval-fixture';
const APPROVAL_DIGEST = createHash('sha256').update(APPROVAL).digest('hex');
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
    'sessionprivatekey', 'capabilityhash', 'sessionkeyenvelope', 'session_key_envelope',
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') expect(forbidden.has(key.toLowerCase())).toBe(false);
    expectNoAuthorityLeak(value[key], seen);
  }
  expect(JSON.stringify(value)).not.toContain(SESSION_PRIVATE_KEY);
  expect(JSON.stringify(value)).not.toContain(CAPABILITY_HASH);
}

const implementations = [
  {
    name: 'memory',
    open(clock) {
      return {
        stores: createMandateStoresV3({
          nowSeconds: () => clock.value,
          leaseToken: () => `lease-${clock.value}`,
        }),
        close() {},
      };
    },
  },
  {
    name: 'SQLite',
    open(clock) {
      const path = join(mkdtempSync(join(tmpdir(), 'vf-mandate-parity-')), 'relayer.db');
      const stores = createSqliteStores(path, {
        sessionKeyCipher: cipher(),
        nowSeconds: () => clock.value,
        leaseToken: () => `lease-${clock.value}`,
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
      expect(Object.keys(internal)).not.toContain('sessionPrivateKey');
      expect(Object.keys(internal)).not.toContain('capabilityHash');
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

  it.each([
    ['approval digest', { approvalDigest: 'cc'.repeat(32) }],
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
      expect(stores.mandateActivations.listRecoverable({ nowSeconds: clock.value }))
        .toEqual([expect.objectContaining({ mandateId: MANDATE_ID, status: 'pending' })]);
      expect(stores.mandatesV3.size).toBe(1);
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
        bindingHash: BINDING_HASH,
        validUntilSeconds: VALID_UNTIL_SECONDS,
      });
      expect(stores.mandatesV3.get(identity())).toMatchObject({
        serializedApproval: APPROVAL,
        approvalDigest: APPROVAL_DIGEST,
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
    ['non-integer activation time', { activatedAt: NOW_SECONDS + 0.5 }],
    ['unsafe activation time', { activatedAt: Number.MAX_SAFE_INTEGER + 1 }],
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
      })).toThrow(/hash|activation|time|canonical|safe|submitted/i);
      expect(stores.mandateActivations.get(identity()).status).toBe('submitted');
      expect(stores.mandatesV3.status(identity()).status).toBe('pending_activation');
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
      expect(stores.mandateActivations.finishUncertain({
        ...identity(), leaseToken: claimed.leaseToken,
      })).toMatchObject({
        mandate: { status: 'activation_uncertain' }, work: { status: 'uncertain' },
      });
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
      expect(Object.keys(internal)).not.toContain('capabilityHash');
      expect(Object.getOwnPropertyDescriptor(internal, 'capabilityHash')?.enumerable).toBe(false);
      expectNoAuthorityLeak(revoked);
    } finally {
      close();
    }
  });

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
    } finally {
      close();
    }
  });

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
