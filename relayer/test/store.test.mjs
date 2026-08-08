// Task 8 RED — checkpointed CCTP relay-work store contract.
// Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/task-8-test-design.md
//   "Store contract and record shape", "CAS rules", "State transitions",
//   "Lease-expiry reconciliation", "Store RED matrix", legacy-record policy.
//
// ONE behavioral contract suite runs against BOTH createMemoryStore and createFileStore
// (the file store is reopened for every durability assertion). The legacy generic
// get/set/has/all tests that used to live here are VICTIMS of the contract change: the
// watcher store is no longer a schemaless KV — generic `set` must never be a watcher
// mutation path, and legacy `{status:'pending'/'minted'}` rows are unrecoverable.
//
// Every expected digest below is a hand-calculated literal derived independently with
// `node -e "crypto.createHash('sha256')..."` over the exact fixture bytes / canonical
// JSON (see the header comment of each constant). The production canonicalizer/digest
// helper is NEVER called to build an expected value.
//
// Pinned error codes (stable, never prose):
//   RELAY_VALIDATION       malformed domain/hash/expectation/reason-code rejected before write
//   RELAY_ENQUEUE_CONFLICT immutable-intent conflict on enqueue; existing row left UNCHANGED
//   RELAY_CAS_CONFLICT     stale/wrong/expired lease token, wrong source state, terminal
//                          transition attempt, mint-hash disagreement, evidence mutation
//                          after the submit fence (zero-row CAS)

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, createMemoryStore } from '../src/store.mjs';

// ---------------------------------------------------------------------------
// Literal fixtures (hand-authored; digests hand-calculated, see below)
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000; // ms timestamps, matching file-store Date.now() behavior

const ZERO32 = '00'.repeat(32);

// Canonical JSON-safe expectation (task-8 design "One JSON-safe expectation schema"),
// fixed key order: version, direction, sourceDomain, destinationDomain, sender,
// recipient, destinationCaller, burnToken, mintRecipient, messageSender, amount,
// burnUnits7, maxFee, minFinalityThreshold, hookData.
const FORWARD_EXPECTATION = {
  version: 1,
  direction: 'stellar-to-base',
  sourceDomain: 27,
  destinationDomain: 6,
  sender: '0xda6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8',
  recipient: '0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  destinationCaller: `0x${ZERO32}`,
  burnToken: '0x5045cd5ec0729a768fd5ad02505852df4f028dce830e5ac52209ba48483b2f01',
  mintRecipient: '0x0000000000000000000000000123456789abcdef0123456789abcdef01234567',
  messageSender: '0xabababababababababababababababababababababababababababababababab',
  amount: '1000000',
  burnUnits7: '10000000',
  maxFee: '0',
  minFinalityThreshold: 2000,
  hookData: '0x',
};

// sha256 over UTF-8 of:
//   'vf-cctp-expectation-v1\0' + '{"version":1,"direction":"stellar-to-base",...,"hookData":"0x"}'
// (the exact canonical JSON with the fixed key order above). Derived with:
//   node -e 'const c=require("crypto");const j=JSON.stringify({...});console.log(c.createHash("sha256").update("vf-cctp-expectation-v1\0"+j,"utf8").digest("hex"))'
const FORWARD_EXPECTATION_DIGEST =
  '11168b4892206a45bb692ff36133a2571db05d6192a257edeafb247cfa8a8a98';

const REVERSE_HOOK =
  '0000000000000000000000000000000000000000000000000000000000000038' +
  '4743584d5a434456595441414e42524153554757533547444b52475351574e4d35' +
  '58485642344a4937505845435a594b4247354f5454524b';

const REVERSE_EXPECTATION = {
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
  hookData: `0x${REVERSE_HOOK}`,
};

// sha256 over UTF-8 of 'vf-cctp-expectation-v1\0' + canonical reverse expectation JSON.
const REVERSE_EXPECTATION_DIGEST =
  'b520b25d0f960eef4edda77137065bb666a46fa8b1cf79fa8d6bc159978e5cd0';

// Hash forms (task-8 "Hash forms"): forward burn = 64 hex no 0x, Base mint = 0x+64;
// reverse inverted. All lowercase canonical.
const BURN_FORWARD = 'aa'.repeat(32);
const MINT_BASE = `0x${'bb'.repeat(32)}`;
const BURN_REVERSE = `0x${'cc'.repeat(32)}`;
const MINT_STELLAR = 'dd'.repeat(32);

// Evidence fixtures. Digests are SHA-256 over the DECODED BYTES (not the textual 0x form):
//   node -e 'console.log(require("crypto").createHash("sha256").update(Buffer.from("deadbeef","hex")).digest("hex"))'
const MESSAGE_HEX = '0xdeadbeef';
const MESSAGE_DIGEST = '5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953';
const OTHER_MESSAGE_HEX = '0xcafe';
const NONCE_HEX = `0x${'11'.repeat(32)}`;
const OTHER_NONCE_HEX = `0x${'22'.repeat(32)}`;
// '0xaabb' digest is pinned by the task-8 design itself:
const ATTESTATION_HEX = '0xaabb';
const ATTESTATION_DIGEST = 'd798d1fac6bd4bb1c11f50312760351013379a0ab6f0a8c0af8a506b96b2525a';
const NEW_ATTESTATION_HEX = '0xccdd';
const NEW_ATTESTATION_DIGEST = '5a8814ae66ff07179d2c22381da6221f6fe754e6175c47d7d87846080f0a9715';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function throwsCode(fn, code) {
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

const forwardIntent = (execId, overrides = {}) => ({
  execId,
  sourceDomain: 27,
  burnTxHash: BURN_FORWARD,
  expectation: FORWARD_EXPECTATION,
  now: T0,
  ...overrides,
});

function enqueuePending(store, execId = 'exec-1', overrides = {}) {
  return store.enqueue(forwardIntent(execId, overrides));
}

function seedAttested(store, execId = 'exec-1', {
  now = T0, leaseMs = 60_000, burnTxHash = BURN_FORWARD,
  messageHex = MESSAGE_HEX, nonceHex = NONCE_HEX, attestationHex = ATTESTATION_HEX,
} = {}) {
  enqueuePending(store, execId, { now, burnTxHash });
  const claimed = store.claim({ execId, now, leaseMs });
  store.recordAttested({
    execId, leaseToken: claimed.leaseToken, messageHex, nonceHex, attestationHex, now,
  });
  return claimed.leaseToken;
}

function seedSubmitting(store, execId = 'exec-1', { now = T0, leaseMs = 60_000, burnTxHash = BURN_FORWARD } = {}) {
  const token = seedAttested(store, execId, { now, leaseMs, burnTxHash });
  store.markMintSubmitting({ execId, leaseToken: token, now });
  return token;
}

function seedSubmitted(store, execId = 'exec-1', {
  now = T0, leaseMs = 60_000, mintTxHash = MINT_BASE, burnTxHash = BURN_FORWARD,
} = {}) {
  const token = seedSubmitting(store, execId, { now, leaseMs, burnTxHash });
  store.markMintSubmitted({ execId, leaseToken: token, mintTxHash, now });
  return token;
}

function seedMinted(store, execId = 'exec-1', { now = T0, mintTxHash = MINT_BASE, burnTxHash = BURN_FORWARD } = {}) {
  const token = seedSubmitted(store, execId, { now, mintTxHash, burnTxHash });
  store.finishMinted({ execId, leaseToken: token, mintTxHash, now });
}

// The complete durable record shape for a fresh enqueue (task-8 "record shape").
function pendingRecord(execId, now = T0) {
  return {
    execId,
    sourceDomain: 27,
    burnTxHash: BURN_FORWARD,
    expectation: FORWARD_EXPECTATION,
    expectationDigest: FORWARD_EXPECTATION_DIGEST,
    state: 'attestation_pending',
    messageHex: null,
    nonceHex: null,
    messageDigest: null,
    attestationHex: null,
    attestationDigest: null,
    evidenceVersion: 0,
    mintTxHash: null,
    reasonCode: null,
    attempts: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// The behavioral contract, run against both implementations
// ---------------------------------------------------------------------------

function defineRelayStoreContract(label, makeHandle) {
  describe(`relay-work store contract — ${label}`, () => {
    // Regression caught: unconditional set() never validated identity, so a retry with a
    // different amount silently rewrote the intent a mint was later confirmed against.
    it('new enqueue writes exactly one canonical attestation_pending row', () => {
      const h = makeHandle();
      const record = enqueuePending(h.store);
      expect(record).toEqual(pendingRecord('exec-1'));
      const reopened = h.reopen();
      expect(reopened.get('exec-1')).toEqual(pendingRecord('exec-1'));
    });

    // Regression caught: duplicate retries bumped timestamps/reset evidence, breaking
    // "exact retry is idempotent" (invariant 5).
    it('exact enqueue retry returns the existing row with timestamps and evidence unchanged', () => {
      const h = makeHandle();
      const first = enqueuePending(h.store);
      const second = h.store.enqueue(forwardIntent('exec-1', { now: T0 + 999_999 }));
      expect(second).toEqual(first);
      expect(h.reopen().get('exec-1')).toEqual(pendingRecord('exec-1'));
    });

    // Regression caught: a canonicalizer whose digest depends on object key insertion order
    // would split one logical intent into a false conflict.
    it('expectation key insertion order does not change the canonical digest', () => {
      const h = makeHandle();
      const scrambled = {};
      for (const key of Object.keys(FORWARD_EXPECTATION).reverse()) {
        scrambled[key] = FORWARD_EXPECTATION[key];
      }
      const record = h.store.enqueue(forwardIntent('exec-1', { expectation: scrambled }));
      expect(record.expectation).toEqual(FORWARD_EXPECTATION);
      expect(record.expectationDigest).toBe(FORWARD_EXPECTATION_DIGEST);
    });

    // Regression caught (plan mismatch #9): a conflicting retry must REJECT THE CALL and
    // leave the valid row untouched — never mark the existing row blocked or rewrite it.
    it('changed immutable expectation under the same execId conflicts; original row unchanged', () => {
      const h = makeHandle();
      enqueuePending(h.store);
      const changed = { ...FORWARD_EXPECTATION, amount: '2000000', burnUnits7: '20000000' };
      throwsCode(() => h.store.enqueue(forwardIntent('exec-1', { expectation: changed })),
        'RELAY_ENQUEUE_CONFLICT');
      expect(h.reopen().get('exec-1')).toEqual(pendingRecord('exec-1'));
    });

    it('changed sourceDomain or burnTxHash under the same execId conflicts; row unchanged', () => {
      const h = makeHandle();
      enqueuePending(h.store);
      throwsCode(() => h.store.enqueue(forwardIntent('exec-1', { sourceDomain: 6 })),
        'RELAY_ENQUEUE_CONFLICT');
      throwsCode(() => h.store.enqueue(forwardIntent('exec-1', { burnTxHash: 'ee'.repeat(32) })),
        'RELAY_ENQUEUE_CONFLICT');
      expect(h.reopen().get('exec-1')).toEqual(pendingRecord('exec-1'));
    });

    // Regression caught: one burn hash owned by two execution IDs double-mints one burn
    // (invariant 5: a burn hash cannot belong to two execution IDs).
    it('the same burn hash under a different execId conflicts and creates no second row', () => {
      const h = makeHandle();
      enqueuePending(h.store, 'exec-1');
      throwsCode(() => h.store.enqueue(forwardIntent('exec-2')), 'RELAY_ENQUEUE_CONFLICT');
      expect(h.store.get('exec-2')).toBeNull();
      expect(h.reopen().get('exec-1')).toEqual(pendingRecord('exec-1'));
    });

    // Regression caught: malformed identity entered the durable queue and was later
    // submitted/confirmed against (invariant: reject malformed pre-send).
    it('rejects invalid domain, hash form, or expectation before writing any row', () => {
      const h = makeHandle();
      const invalid = [
        forwardIntent('bad-domain', { sourceDomain: 99 }),
        forwardIntent('bad-burn-prefix', { burnTxHash: `0x${BURN_FORWARD}` }), // forward burn has no 0x
        forwardIntent('bad-burn-short', { burnTxHash: 'aa'.repeat(16) }),
        forwardIntent('bad-burn-nonhex', { burnTxHash: 'zz'.repeat(32) }),
        forwardIntent('bad-exp-missing', {
          expectation: (() => { const e = { ...FORWARD_EXPECTATION }; delete e.amount; return e; })(),
        }),
        forwardIntent('bad-exp-extra', { expectation: { ...FORWARD_EXPECTATION, extra: 'x' } }),
        forwardIntent('bad-exp-leading-zero', { expectation: { ...FORWARD_EXPECTATION, amount: '01000000' } }),
        forwardIntent('bad-exp-number', { expectation: { ...FORWARD_EXPECTATION, amount: 1000000 } }),
        forwardIntent('bad-exp-no-burnunits7', {
          expectation: (() => { const e = { ...FORWARD_EXPECTATION }; delete e.burnUnits7; return e; })(),
        }),
        forwardIntent('bad-exp-domain-mix', {
          expectation: { ...FORWARD_EXPECTATION, sourceDomain: 6 },
        }),
        // reverse expectation must carry burnUnits7: null
        {
          execId: 'bad-reverse', sourceDomain: 6, burnTxHash: BURN_REVERSE,
          expectation: { ...REVERSE_EXPECTATION, burnUnits7: '12345670' }, now: T0,
        },
      ];
      for (const intent of invalid) {
        throwsCode(() => h.store.enqueue(intent), 'RELAY_VALIDATION');
        expect(h.store.get(intent.execId)).toBeNull();
      }
      expect(h.reopen().listForSweep({ now: T0, limit: 100 })).toEqual([]);
    });

    // Regression caught: a canonicalizer that uppercases or stores the raw input splits
    // uniqueness — 'AA..AA' and 'aa..aa' are the same burn.
    it('normalizes accepted canonical-width hashes to lowercase before persistence', () => {
      const h = makeHandle();
      const record = h.store.enqueue(forwardIntent('exec-1', { burnTxHash: BURN_FORWARD.toUpperCase() }));
      expect(record.burnTxHash).toBe(BURN_FORWARD);
      throwsCode(() => h.store.enqueue(forwardIntent('exec-2')), 'RELAY_ENQUEUE_CONFLICT');
    });

    // Regression caught: two store instances (two workers) both "claimed" the same row
    // because get/set had no conditional update (invariant 7).
    it('exactly one of two competing store instances wins the claim', () => {
      const h = makeHandle();
      enqueuePending(h.store);
      const first = h.store.claim({ execId: 'exec-1', now: T0, leaseMs: 60_000 });
      expect(first).toMatchObject({
        state: 'attestation_pending', attempts: 1, leaseExpiresAt: T0 + 60_000,
      });
      expect(typeof first.leaseToken).toBe('string');
      expect(first.leaseToken.length).toBeGreaterThan(0);
      const second = h.secondInstance().claim({ execId: 'exec-1', now: T0, leaseMs: 60_000 });
      expect(second).toBeNull();
      expect(h.reopen().get('exec-1').leaseToken).toBe(first.leaseToken);
    });

    it('claim refuses missing rows, unsafe states, and terminals', () => {
      const h = makeHandle();
      expect(h.store.claim({ execId: 'missing', now: T0, leaseMs: 1000 })).toBeNull();
      const submittingToken = seedSubmitting(h.store, 'exec-submitting', { burnTxHash: 'ab'.repeat(32) });
      expect(submittingToken).toBeTruthy();
      expect(h.secondInstance().claim({ execId: 'exec-submitting', now: T0, leaseMs: 60_000 }))
        .toBeNull(); // leased AND mint_submitting is not a claimable safe state
      seedMinted(h.store, 'exec-minted', { burnTxHash: 'ac'.repeat(32) });
      expect(h.store.claim({ execId: 'exec-minted', now: T0, leaseMs: 60_000 })).toBeNull();
    });

    // Regression caught: an unleased mint_submitted row (hash durable, confirmation pending)
    // must be claimable so a later worker can confirm the same hash — pinning the third
    // claimable safe state explicitly.
    it('claim succeeds for an unleased mint_submitted row', () => {
      const h = makeHandle();
      const token = seedSubmitted(h.store, 'exec-1');
      h.store.release({ execId: 'exec-1', leaseToken: token, now: T0 });
      const claimed = h.secondInstance().claim({ execId: 'exec-1', now: T0, leaseMs: 60_000 });
      expect(claimed).toMatchObject({ state: 'mint_submitted', mintTxHash: MINT_BASE });
      expect(typeof claimed.leaseToken).toBe('string');
      expect(claimed.leaseToken).not.toBe(token);
    });

    // Regression caught: any holder of a guessed/stale/expired token could move the row
    // because transitions never compared the lease (invariant 7).
    it('stale, wrong, and expired tokens are rejected on every transition; row unchanged', () => {
      const h = makeHandle();
      const token = seedAttested(h.store, 'exec-1', { now: T0, leaseMs: 1_000 });
      const before = h.store.get('exec-1');
      const expiredNow = T0 + 2_000; // leaseExpiredAt = T0 + 1_000
      const attempts = [
        () => h.store.renew({ execId: 'exec-1', leaseToken: 'wrong', now: T0, leaseMs: 1_000 }),
        () => h.store.renew({ execId: 'exec-1', leaseToken: token, now: expiredNow, leaseMs: 1_000 }),
        () => h.store.recordAttested({
          execId: 'exec-1', leaseToken: 'wrong', messageHex: MESSAGE_HEX, nonceHex: NONCE_HEX,
          attestationHex: ATTESTATION_HEX, now: T0,
        }),
        () => h.store.recordAttested({
          execId: 'exec-1', leaseToken: token, messageHex: MESSAGE_HEX, nonceHex: NONCE_HEX,
          attestationHex: ATTESTATION_HEX, now: expiredNow,
        }),
        () => h.store.markMintSubmitting({ execId: 'exec-1', leaseToken: 'wrong', now: T0 }),
        () => h.store.markMintSubmitting({ execId: 'exec-1', leaseToken: token, now: expiredNow }),
        () => h.store.finishBlocked({
          execId: 'exec-1', leaseToken: 'wrong', reasonCode: 'message_mismatch', now: T0,
        }),
        () => h.store.release({ execId: 'exec-1', leaseToken: 'wrong', now: T0 }),
      ];
      for (const attempt of attempts) throwsCode(attempt, 'RELAY_CAS_CONFLICT');
      expect(h.reopen().get('exec-1')).toEqual(before);
    });

    // Regression caught: skipped/backward transitions (e.g. minted straight from pending)
    // were one unconditional set() away.
    it('transitions from the wrong source state are rejected', () => {
      const h = makeHandle();
      enqueuePending(h.store, 'exec-1');
      const pending = h.store.claim({ execId: 'exec-1', now: T0, leaseMs: 60_000 });
      // cannot submit from attestation_pending (no durable evidence)
      throwsCode(
        () => h.store.markMintSubmitting({ execId: 'exec-1', leaseToken: pending.leaseToken, now: T0 }),
        'RELAY_CAS_CONFLICT',
      );
      // cannot checkpoint a hash before the submit fence
      throwsCode(
        () => h.store.markMintSubmitted({
          execId: 'exec-1', leaseToken: pending.leaseToken, mintTxHash: MINT_BASE, now: T0,
        }),
        'RELAY_CAS_CONFLICT',
      );
      // cannot finish minted from pending
      throwsCode(
        () => h.store.finishMinted({
          execId: 'exec-1', leaseToken: pending.leaseToken, mintTxHash: MINT_BASE, now: T0,
        }),
        'RELAY_CAS_CONFLICT',
      );
      const token = seedAttested(h.store, 'exec-2', { burnTxHash: 'ab'.repeat(32) });
      // cannot mint straight from attested — the submit fence is mandatory
      throwsCode(
        () => h.store.finishMinted({ execId: 'exec-2', leaseToken: token, mintTxHash: MINT_BASE, now: T0 }),
        'RELAY_CAS_CONFLICT',
      );
    });

    // Regression caught: evidence landed field-by-field with unconditional set(), so a crash
    // could persist state 'attested' with a missing nonce or digest (invariant 1).
    it('attested checkpoint is atomic: message, nonce, both digests, and state survive reopen together', () => {
      const h = makeHandle();
      seedAttested(h.store, 'exec-1');
      const reopened = h.reopen().get('exec-1');
      expect(reopened).toMatchObject({
        state: 'attested',
        messageHex: MESSAGE_HEX,
        nonceHex: NONCE_HEX,
        messageDigest: MESSAGE_DIGEST,
        attestationHex: ATTESTATION_HEX,
        attestationDigest: ATTESTATION_DIGEST,
        evidenceVersion: 1,
      });
    });

    // Regression caught: an attestation retry rewrote evidenceVersion/updatedAt, so a
    // duplicate Iris poll looked like fresh evidence.
    it('exact evidence retry is idempotent and leaves evidenceVersion unchanged', () => {
      const h = makeHandle();
      const token = seedAttested(h.store, 'exec-1');
      const before = h.store.get('exec-1');
      const again = h.store.recordAttested({
        execId: 'exec-1', leaseToken: token, messageHex: MESSAGE_HEX, nonceHex: NONCE_HEX,
        attestationHex: ATTESTATION_HEX, now: T0 + 5_000,
      });
      expect(again).toEqual(before);
      expect(again.evidenceVersion).toBe(1);
    });

    // Regression caught (plan mismatch #8): only a new attestation over the EXACT same
    // message may replace attestation fields, only while attested, with a version bump.
    it('a new valid attestation for the same message/nonce increments evidenceVersion atomically', () => {
      const h = makeHandle();
      const token = seedAttested(h.store, 'exec-1');
      const updated = h.store.recordAttested({
        execId: 'exec-1', leaseToken: token, messageHex: MESSAGE_HEX, nonceHex: NONCE_HEX,
        attestationHex: NEW_ATTESTATION_HEX, now: T0 + 5_000,
      });
      expect(updated).toMatchObject({
        state: 'attested',
        messageHex: MESSAGE_HEX,
        nonceHex: NONCE_HEX,
        messageDigest: MESSAGE_DIGEST,
        attestationHex: NEW_ATTESTATION_HEX,
        attestationDigest: NEW_ATTESTATION_DIGEST,
        evidenceVersion: 2,
      });
      const reopened = h.reopen().get('exec-1');
      expect(reopened.evidenceVersion).toBe(2);
      expect(reopened.attestationDigest).toBe(NEW_ATTESTATION_DIGEST);
    });

    it('a changed message or nonce while attested conflicts without partial evidence replacement', () => {
      const h = makeHandle();
      const token = seedAttested(h.store, 'exec-1');
      const before = h.store.get('exec-1');
      throwsCode(() => h.store.recordAttested({
        execId: 'exec-1', leaseToken: token, messageHex: OTHER_MESSAGE_HEX, nonceHex: NONCE_HEX,
        attestationHex: ATTESTATION_HEX, now: T0,
      }), 'RELAY_CAS_CONFLICT');
      throwsCode(() => h.store.recordAttested({
        execId: 'exec-1', leaseToken: token, messageHex: MESSAGE_HEX, nonceHex: OTHER_NONCE_HEX,
        attestationHex: ATTESTATION_HEX, now: T0,
      }), 'RELAY_CAS_CONFLICT');
      expect(h.reopen().get('exec-1')).toEqual(before);
    });

    // Regression caught: evidence could be replaced after the submit fence, so the hash being
    // confirmed no longer matched the attested message (invariant: evidence frozen at fence).
    it('evidence mutation is rejected in mint_submitting, mint_submitted, and every later state', () => {
      const h = makeHandle();
      const submittingToken = seedSubmitting(h.store, 'exec-0');
      const submittingBefore = h.store.get('exec-0');
      throwsCode(() => h.store.recordAttested({
        execId: 'exec-0', leaseToken: submittingToken, messageHex: MESSAGE_HEX, nonceHex: NONCE_HEX,
        attestationHex: NEW_ATTESTATION_HEX, now: T0,
      }), 'RELAY_CAS_CONFLICT');
      expect(h.reopen().get('exec-0')).toEqual(submittingBefore);
      const token = seedSubmitted(h.store, 'exec-1', { burnTxHash: 'ab'.repeat(32) });
      const before = h.store.get('exec-1');
      throwsCode(() => h.store.recordAttested({
        execId: 'exec-1', leaseToken: token, messageHex: MESSAGE_HEX, nonceHex: NONCE_HEX,
        attestationHex: NEW_ATTESTATION_HEX, now: T0,
      }), 'RELAY_CAS_CONFLICT');
      expect(h.reopen().get('exec-1')).toEqual(before);
      const mintedToken = seedSubmitted(h.store, 'exec-2', { burnTxHash: 'ac'.repeat(32) });
      h.store.finishMinted({ execId: 'exec-2', leaseToken: mintedToken, mintTxHash: MINT_BASE, now: T0 });
      const minted = h.store.get('exec-2');
      throwsCode(() => h.store.recordAttested({
        execId: 'exec-2', leaseToken: mintedToken, messageHex: MESSAGE_HEX, nonceHex: NONCE_HEX,
        attestationHex: ATTESTATION_HEX, now: T0,
      }), 'RELAY_CAS_CONFLICT');
      expect(h.reopen().get('exec-2')).toEqual(minted);
    });

    // Regression caught: the watcher submitted with no durable fence, so a crash between send
    // and set() left no trace that a submission had already been attempted (invariant 1/3).
    it('the mint_submitting fence is durable before any caller may submit', () => {
      const h = makeHandle();
      seedSubmitting(h.store, 'exec-1');
      const fenced = h.reopen().get('exec-1');
      expect(fenced.state).toBe('mint_submitting');
      expect(fenced.mintTxHash).toBeNull();
      expect(fenced.messageDigest).toBe(MESSAGE_DIGEST);
    });

    // Regression caught: a malformed destination hash was checkpointed as the recovery
    // identity, making the real submission forever unconfirmable.
    it('a malformed destination hash can never enter mint_submitted', () => {
      const h = makeHandle();
      const token = seedSubmitting(h.store, 'exec-1');
      for (const bad of ['0x123', 'not-a-hash', MINT_BASE.slice(0, -2), `0x${'GG'.repeat(32)}`, MINT_BASE.slice(2)]) {
        throwsCode(
          () => h.store.markMintSubmitted({ execId: 'exec-1', leaseToken: token, mintTxHash: bad, now: T0 }),
          'RELAY_VALIDATION',
        );
      }
      const after = h.reopen().get('exec-1');
      expect(after.state).toBe('mint_submitting');
      expect(after.mintTxHash).toBeNull();
      // a Stellar-shaped hash (no 0x) is malformed for the Base destination
      throwsCode(
        () => h.store.markMintSubmitted({ execId: 'exec-1', leaseToken: token, mintTxHash: MINT_STELLAR, now: T0 }),
        'RELAY_VALIDATION',
      );
    });

    it('accepts the destination hash form for the reverse direction (64 hex, no 0x)', () => {
      const h = makeHandle();
      h.store.enqueue({
        execId: 'exec-rev', sourceDomain: 6, burnTxHash: BURN_REVERSE,
        expectation: REVERSE_EXPECTATION, now: T0,
      });
      expect(h.store.get('exec-rev').expectationDigest).toBe(REVERSE_EXPECTATION_DIGEST);
      const claimed = h.store.claim({ execId: 'exec-rev', now: T0, leaseMs: 60_000 });
      h.store.recordAttested({
        execId: 'exec-rev', leaseToken: claimed.leaseToken, messageHex: MESSAGE_HEX,
        nonceHex: NONCE_HEX, attestationHex: ATTESTATION_HEX, now: T0,
      });
      h.store.markMintSubmitting({ execId: 'exec-rev', leaseToken: claimed.leaseToken, now: T0 });
      throwsCode(
        () => h.store.markMintSubmitted({
          execId: 'exec-rev', leaseToken: claimed.leaseToken, mintTxHash: MINT_BASE, now: T0,
        }),
        'RELAY_VALIDATION',
      ); // 0x-prefixed Base form is malformed for a Stellar destination
      const submitted = h.store.markMintSubmitted({
        execId: 'exec-rev', leaseToken: claimed.leaseToken, mintTxHash: MINT_STELLAR, now: T0,
      });
      expect(submitted).toMatchObject({ state: 'mint_submitted', mintTxHash: MINT_STELLAR });
    });

    // Regression caught: confirmation of a DIFFERENT hash than the checkpointed one marked
    // the row minted — the exact "reverted receipt recorded as minted" class (invariant 2).
    it('finishMinted rejects any hash but the durably checkpointed one', () => {
      const h = makeHandle();
      const token = seedSubmitted(h.store, 'exec-1');
      throwsCode(
        () => h.store.finishMinted({
          execId: 'exec-1', leaseToken: token, mintTxHash: `0x${'ff'.repeat(32)}`, now: T0,
        }),
        'RELAY_CAS_CONFLICT',
      );
      expect(h.store.get('exec-1').state).toBe('mint_submitted');
      const minted = h.store.finishMinted({
        execId: 'exec-1', leaseToken: token, mintTxHash: MINT_BASE, now: T0 + 1_000,
      });
      expect(minted).toMatchObject({
        state: 'minted', mintTxHash: MINT_BASE, leaseToken: null, leaseExpiresAt: null,
      });
      expect(h.reopen().get('exec-1').state).toBe('minted');
    });

    it('finishBlocked/finishUncertain enforce the stable reason-code allowlists', () => {
      const h = makeHandle();
      const token = seedAttested(h.store, 'exec-1');
      throwsCode(
        () => h.store.finishBlocked({ execId: 'exec-1', leaseToken: token, reasonCode: 'some prose', now: T0 }),
        'RELAY_VALIDATION',
      );
      const blocked = h.store.finishBlocked({
        execId: 'exec-1', leaseToken: token, reasonCode: 'message_mismatch', now: T0,
      });
      expect(blocked).toMatchObject({
        state: 'blocked', reasonCode: 'message_mismatch', leaseToken: null,
      });

      const uToken = seedSubmitting(h.store, 'exec-2', { burnTxHash: 'ab'.repeat(32) });
      throwsCode(
        () => h.store.finishUncertain({ execId: 'exec-2', leaseToken: uToken, reasonCode: 'dunno', now: T0 }),
        'RELAY_VALIDATION',
      );
      // best-effort hash retention when the send returned a hash but the checkpoint failed
      const uncertain = h.store.finishUncertain({
        execId: 'exec-2', leaseToken: uToken, mintTxHash: MINT_BASE,
        reasonCode: 'submitted_checkpoint_failed', now: T0,
      });
      expect(uncertain).toMatchObject({
        state: 'uncertain', reasonCode: 'submitted_checkpoint_failed', mintTxHash: MINT_BASE,
      });
      expect(h.reopen().get('exec-2').mintTxHash).toBe(MINT_BASE);
    });

    // Regression caught: terminal rows were rewritten by later retries (any terminal |
    // any retry | unchanged).
    it('terminal records are immutable: claim and every transition reject', () => {
      const h = makeHandle();
      seedMinted(h.store, 'exec-minted');
      const minted = h.store.get('exec-minted');
      expect(h.store.claim({ execId: 'exec-minted', now: T0 + 1, leaseMs: 1000 })).toBeNull();
      throwsCode(() => h.store.finishBlocked({
        execId: 'exec-minted', leaseToken: 'any', reasonCode: 'message_mismatch', now: T0,
      }), 'RELAY_CAS_CONFLICT');
      throwsCode(() => h.store.finishUncertain({
        execId: 'exec-minted', leaseToken: 'any', reasonCode: 'submission_unknown', now: T0,
      }), 'RELAY_CAS_CONFLICT');
      throwsCode(() => h.store.release({ execId: 'exec-minted', leaseToken: 'any', now: T0 }),
        'RELAY_CAS_CONFLICT');
      expect(h.reopen().get('exec-minted')).toEqual(minted);

      const bToken = seedAttested(h.store, 'exec-blocked', { burnTxHash: 'ab'.repeat(32) });
      h.store.finishBlocked({
        execId: 'exec-blocked', leaseToken: bToken, reasonCode: 'message_ambiguous', now: T0,
      });
      const blocked = h.store.get('exec-blocked');
      expect(h.store.claim({ execId: 'exec-blocked', now: T0 + 1, leaseMs: 1000 })).toBeNull();
      throwsCode(() => h.store.markMintSubmitting({ execId: 'exec-blocked', leaseToken: bToken, now: T0 }),
        'RELAY_CAS_CONFLICT');
      expect(h.reopen().get('exec-blocked')).toEqual(blocked);
    });

    // Regression caught: release after a retryable outcome cleared evidence/state, forcing a
    // re-submit; and old tokens stayed valid after release (invariant 7).
    it('release clears the lease but retains state and evidence; the old token dies', () => {
      const h = makeHandle();
      const token = seedAttested(h.store, 'exec-1');
      const released = h.store.release({ execId: 'exec-1', leaseToken: token, now: T0 + 1_000 });
      expect(released).toMatchObject({
        state: 'attested', leaseToken: null, leaseExpiresAt: null,
        messageDigest: MESSAGE_DIGEST, evidenceVersion: 1,
      });
      throwsCode(() => h.store.markMintSubmitting({ execId: 'exec-1', leaseToken: token, now: T0 + 2_000 }),
        'RELAY_CAS_CONFLICT');
      // released rows are claimable again by a fresh worker
      const reclaimed = h.secondInstance().claim({ execId: 'exec-1', now: T0 + 3_000, leaseMs: 60_000 });
      expect(reclaimed).toMatchObject({ state: 'attested', attempts: 2 });
      // release is not allowed from mint_submitting (that row must become uncertain instead)
      const submittingToken = seedSubmitting(h.store, 'exec-2', { burnTxHash: 'ab'.repeat(32) });
      throwsCode(() => h.store.release({ execId: 'exec-2', leaseToken: submittingToken, now: T0 }),
        'RELAY_CAS_CONFLICT');
    });

    // Regression caught: renewing a lease invalidated the token mid-checkpoint, so the
    // worker's own durable write failed after the external send had already happened.
    it('renew extends the lease and never invalidates an in-flight checkpoint by the same token', () => {
      const h = makeHandle();
      enqueuePending(h.store, 'exec-1');
      const claimed = h.store.claim({ execId: 'exec-1', now: T0, leaseMs: 1_000 });
      const renewed = h.store.renew({
        execId: 'exec-1', leaseToken: claimed.leaseToken, now: T0 + 500, leaseMs: 5_000,
      });
      expect(renewed).toMatchObject({
        state: 'attestation_pending',
        leaseToken: claimed.leaseToken,
        leaseExpiresAt: T0 + 500 + 5_000,
      });
      const attested = h.store.recordAttested({
        execId: 'exec-1', leaseToken: claimed.leaseToken, messageHex: MESSAGE_HEX,
        nonceHex: NONCE_HEX, attestationHex: ATTESTATION_HEX, now: T0 + 600,
      });
      expect(attested.state).toBe('attested');
    });

    // Regression caught: an expired lease on mint_submitting was silently re-claimable and
    // re-submitted; the reconciliation table makes it durably uncertain instead.
    it('reconcileExpired applies the lease-expiry table exactly', () => {
      const h = makeHandle();
      // attestation_pending, expired lease -> same state, lease cleared
      enqueuePending(h.store, 'r-pending', { now: T0 });
      h.store.claim({ execId: 'r-pending', now: T0, leaseMs: 10 });
      // attested, expired lease -> same state, lease cleared
      seedAttested(h.store, 'r-attested', { now: T0 + 1, leaseMs: 10, burnTxHash: 'ab'.repeat(32) });
      // mint_submitting, expired lease -> uncertain (submission_lease_expired), lease cleared
      seedSubmitting(h.store, 'r-submitting', { now: T0 + 2, leaseMs: 10, burnTxHash: 'ac'.repeat(32) });
      // mint_submitted, expired lease -> same state, lease cleared
      seedSubmitted(h.store, 'r-submitted', { now: T0 + 3, leaseMs: 10, burnTxHash: 'ad'.repeat(32) });
      // active lease -> untouched, not listed
      seedAttested(h.store, 'r-active', { now: T0 + 4, leaseMs: 60_000, burnTxHash: 'ae'.repeat(32) });
      // terminals -> unchanged, not listed
      seedMinted(h.store, 'r-minted', { now: T0 + 5, burnTxHash: 'af'.repeat(32) });
      const bToken = seedAttested(h.store, 'r-blocked', { now: T0 + 6, burnTxHash: 'a0'.repeat(32) });
      h.store.finishBlocked({ execId: 'r-blocked', leaseToken: bToken, reasonCode: 'message_mismatch', now: T0 + 6 });

      const now = T0 + 1_000; // past the 10ms leases, before the 60s lease
      const reconciled = h.store.reconcileExpired({ now, limit: 100 });
      expect(reconciled.map((r) => r.execId)).toEqual([
        'r-pending', 'r-attested', 'r-submitting', 'r-submitted',
      ]);

      const reopened = h.reopen();
      expect(reopened.get('r-pending')).toMatchObject({ state: 'attestation_pending', leaseToken: null });
      expect(reopened.get('r-attested')).toMatchObject({
        state: 'attested', leaseToken: null, messageDigest: MESSAGE_DIGEST,
      });
      expect(reopened.get('r-submitting')).toMatchObject({
        state: 'uncertain', reasonCode: 'submission_lease_expired', leaseToken: null,
      });
      expect(reopened.get('r-submitted')).toMatchObject({
        state: 'mint_submitted', mintTxHash: MINT_BASE, leaseToken: null,
      });
      expect(reopened.get('r-active').leaseToken).not.toBeNull();
      expect(reopened.get('r-minted').state).toBe('minted');
      expect(reopened.get('r-blocked').state).toBe('blocked');
    });

    // Regression caught: unbounded, insertion-ordered listing made startup recovery
    // non-deterministic; the contract pins (createdAt, execId) order plus limit.
    it('listForSweep is deterministic (createdAt, execId), bounded, and excludes terminals', () => {
      const h = makeHandle();
      enqueuePending(h.store, 'exec-c', { now: T0 + 2 });
      enqueuePending(h.store, 'exec-a', { now: T0, burnTxHash: 'ab'.repeat(32) });
      enqueuePending(h.store, 'exec-b', { now: T0 + 1, burnTxHash: 'ac'.repeat(32) });
      enqueuePending(h.store, 'exec-a2', { now: T0, burnTxHash: 'ad'.repeat(32) }); // createdAt tie -> execId breaks it
      seedMinted(h.store, 'exec-minted', { now: T0 - 1, burnTxHash: 'ae'.repeat(32) });
      const bToken = seedAttested(h.store, 'exec-blocked', { now: T0 - 2, burnTxHash: 'af'.repeat(32) });
      h.store.finishBlocked({ execId: 'exec-blocked', leaseToken: bToken, reasonCode: 'message_mismatch', now: T0 });

      const listed = h.reopen().listForSweep({ now: T0 + 10_000, limit: 100 });
      expect(listed.map((r) => r.execId)).toEqual(['exec-a', 'exec-a2', 'exec-b', 'exec-c']);
      const bounded = h.store.listForSweep({ now: T0 + 10_000, limit: 2 });
      expect(bounded.map((r) => r.execId)).toEqual(['exec-a', 'exec-a2']);
    });

    // Regression caught (invariant 8): outward status leaked raw messages, attestations,
    // lease tokens, and diagnostic prose to API consumers.
    it('statusOf is redacted: no raw message, attestation, lease token, or prose', () => {
      const h = makeHandle();
      const token = seedSubmitted(h.store, 'exec-1');
      expect(token).toBeTruthy();
      const status = h.store.statusOf('exec-1');
      expect(status).toEqual({
        execId: 'exec-1',
        sourceDomain: 27,
        state: 'mint_submitted',
        burnTxHash: BURN_FORWARD,
        mintTxHash: MINT_BASE,
        reasonCode: null,
        attempts: 1,
        createdAt: T0,
        updatedAt: T0,
      });
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain(MESSAGE_HEX.slice(2));
      expect(serialized).not.toContain(ATTESTATION_HEX.slice(2));
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(MESSAGE_DIGEST);
      expect(h.store.statusOf('missing')).toBeNull();
    });
  });
}

defineRelayStoreContract('memory', () => {
  const store = createMemoryStore();
  return { store, reopen: () => store, secondInstance: () => store };
});

defineRelayStoreContract('file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-relay-store-'));
  const path = join(dir, 'store.json');
  return {
    store: createFileStore(path),
    reopen: () => createFileStore(path),
    secondInstance: () => createFileStore(path),
  };
});

// ---------------------------------------------------------------------------
// Legacy-record policy (file store only): rows written by the pre-Task-8 watcher are
// `{status:'pending'}` / `{status:'minted'}` JSON with no immutable expectation and no
// strict confirmation evidence. They must NEVER be auto-runnable or trusted as minted.
// Pinned policy (task-8 design offers fail-startup OR convert-once): convert once to
// terminal `legacy_record_unrecoverable`, durably, at open.
// ---------------------------------------------------------------------------

describe('legacy file records fail closed (legacy_record_unrecoverable)', () => {
  function legacyDir() {
    const dir = mkdtempSync(join(tmpdir(), 'vf-relay-legacy-'));
    const path = join(dir, 'store.json');
    writeFileSync(path, JSON.stringify({
      'legacy-pending': { status: 'pending', sourceDomain: 27, burnTxHash: BURN_FORWARD },
      'legacy-minted': { status: 'minted', sourceDomain: 27, burnTxHash: 'ff'.repeat(32), mintTxHash: MINT_BASE },
    }, null, 2));
    return path;
  }

  // Regression caught: a legacy 'pending' row was re-driven by sweepStuck and re-submitted a
  // burn whose evidence could not be revalidated against any immutable expectation.
  it('legacy pending/minted rows convert once to terminal legacy_record_unrecoverable at open', () => {
    const path = legacyDir();
    const store = createFileStore(path);

    for (const execId of ['legacy-pending', 'legacy-minted']) {
      const record = store.get(execId);
      expect(record.state).toBe('blocked');
      expect(record.reasonCode).toBe('legacy_record_unrecoverable');
      // never auto-runnable: not claimable, not sweep-listed
      expect(store.claim({ execId, now: T0, leaseMs: 60_000 })).toBeNull();
    }
    expect(store.listForSweep({ now: T0, limit: 100 })).toEqual([]);
    // never trusted as minted
    expect(store.statusOf('legacy-minted').state).not.toBe('minted');
    expect(store.statusOf('legacy-minted').state).toBe('blocked');

    // the conversion is durable: the on-disk file no longer carries the legacy truth, and a
    // reopened store still fails closed
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('legacy_record_unrecoverable');
    const reopened = createFileStore(path);
    expect(reopened.get('legacy-minted').state).toBe('blocked');
    expect(reopened.statusOf('legacy-minted').mintTxHash).toBeNull();
  });
});
