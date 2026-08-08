// Task 8 RED — checkpointed CCTP watcher state machine.
// Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/task-8-test-design.md
//   "Crash-window RED matrix", "Watcher behavior cases 1-10", "sweepStuck classification".
//
// REPLACES the 4 legacy tests + 1 Task 7 guard that lived here. All five are victims of the
// contract change: they exercised the old write-`pending`-then-`minted` watcher against the
// schemaless KV store with combined send+confirm seams (`mintBaseFn`/`mintAndForwardStellarFn`)
// and toy evidence (`0xmsg`). The Task 7 guard (an expectation must reach Iris) SURVIVES in
// strengthened form: the expectation is now mandatory, immutable, durable, and revalidated.
//
// External fakes are BOUNDARY fakes only: poll (Iris), submit/confirm destination seams.
// They read the REAL memory/file store at call time. The split destination seams
// (submitMintBase/confirmMintBase, submitMintAndForwardStellar/confirmMintAndForwardStellar)
// are owned by a parallel Task 8 agent; here they are injected watcher-boundary deps.
//
// Pinned seam error codes the watcher must classify (thrown by the injected seams):
//   CCTP_MINT_REVERTED / STELLAR_TX_FAILED       definitive destination failure -> blocked
//   CCTP_MINT_CONFIRMATION_RETRYABLE / STELLAR_TX_TIMEOUT (or any other throw) -> stay mint_submitted
// Pinned watcher result shapes (outward, redacted — invariant 8):
//   {status:'minted', mintTxHash}  {status:'already-minted', mintTxHash}
//   {status:'in-progress'}         joined/held concurrent or leased work — never mint evidence
//   {status:'attestation_pending'} recoverable poll timeout
//   {status:'mint_submitted', mintTxHash}  confirmation pending on the checkpointed hash
//   {status:'blocked', reasonCode}  {status:'uncertain', reasonCode}

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatcher } from '../../src/cctp/watcher.mjs';
import { createMemoryStore, createFileStore } from '../../src/store.mjs';
import { pollAttestation } from '../../src/cctp/iris.mjs';

// ---------------------------------------------------------------------------
// Literal fixtures (hand-authored; duplicated from the Task 7 suites by design —
// never imported from production, never shared via a helper module)
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const DOMAINS = { stellar: 27, base: 6 };
const IRIS_URL = 'https://iris.example';

const STANDARD_2000 = '000007d0';
const ZERO32 = '00'.repeat(32);
const NONCE_FORWARD = '11'.repeat(32);
const NONCE_OTHER = '99'.repeat(32);

const STELLAR_TOKEN_MESSENGER =
  'da6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8';
const STELLAR_USDC = '5045cd5ec0729a768fd5ad02505852df4f028dce830e5ac52209ba48483b2f01';
const BASE_TOKEN_MESSENGER =
  '0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa';
const BASE_KERNEL = '0000000000000000000000000123456789abcdef0123456789abcdef01234567';
const STELLAR_BRIDGE_AGENT = 'ab'.repeat(32);
const AMOUNT_1_USDC_6DP =
  '00000000000000000000000000000000000000000000000000000000000f4240';
const AMOUNT_1234567 =
  '000000000000000000000000000000000000000000000000000000000012d687';

// Real Task 7 forward fixture (376 bytes).
const FORWARD_MESSAGE = `0x${[
  '00000001', '0000001b', '00000006',
  NONCE_FORWARD,
  STELLAR_TOKEN_MESSENGER,
  BASE_TOKEN_MESSENGER,
  ZERO32,
  STANDARD_2000, STANDARD_2000, '00000001',
  STELLAR_USDC,
  BASE_KERNEL,
  AMOUNT_1_USDC_6DP,
  STELLAR_BRIDGE_AGENT,
  ZERO32, ZERO32, ZERO32,
].join('')}`;

// Same message with a different nonce (byte offset 12) — still matches the expectation.
const FORWARD_MESSAGE_OTHER_NONCE = `${FORWARD_MESSAGE.slice(0, 2 + 12 * 2)}${NONCE_OTHER}${
  FORWARD_MESSAGE.slice(2 + (12 + 32) * 2)}`;

// Same message with a wrong amount (byte offset 216) — no longer matches the expectation.
const WRONG_AMOUNT_MESSAGE = `${FORWARD_MESSAGE.slice(0, 2 + 216 * 2)}${AMOUNT_1234567}${
  FORWARD_MESSAGE.slice(2 + (216 + 32) * 2)}`;

const FORWARD_EXPECTATION = {
  version: 1,
  direction: 'stellar-to-base',
  sourceDomain: 27,
  destinationDomain: 6,
  sender: `0x${STELLAR_TOKEN_MESSENGER}`,
  recipient: `0x${BASE_TOKEN_MESSENGER}`,
  destinationCaller: `0x${ZERO32}`,
  burnToken: `0x${STELLAR_USDC}`,
  mintRecipient: `0x${BASE_KERNEL}`,
  messageSender: `0x${STELLAR_BRIDGE_AGENT}`,
  amount: '1000000',
  burnUnits7: '10000000',
  maxFee: '0',
  minFinalityThreshold: 2000,
  hookData: '0x',
};

const REVERSE_HOOK =
  '0000000000000000000000000000000000000000000000000000000000000038' +
  '4743584d5a434456595441414e42524153554757533547444b52475351574e4d35' +
  '58485642344a4937505845435a594b4247354f5454524b';
const STELLAR_FORWARDER = '3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e';
const BASE_USDC = '000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e';
const BASE_EXIT_SWEEPER = '0000000000000000000000005451a6dc234d07f3c80752e3c0e798913e53de6d';
const NONCE_REVERSE = '99'.repeat(32);
const FAST_1000 = '000003e8';
const FEE_1000 = '00000000000000000000000000000000000000000000000000000000000003e8';
const FEE_100 = '0000000000000000000000000000000000000000000000000000000000000064';
const EXPIRATION_0X12345678 =
  '0000000000000000000000000000000000000000000000000000000012345678';

const REVERSE_MESSAGE = `0x${[
  '00000001', '00000006', '0000001b',
  NONCE_REVERSE,
  BASE_TOKEN_MESSENGER,
  STELLAR_TOKEN_MESSENGER,
  STELLAR_FORWARDER,
  FAST_1000, STANDARD_2000, '00000001',
  BASE_USDC,
  STELLAR_FORWARDER,
  AMOUNT_1234567,
  BASE_EXIT_SWEEPER,
  FEE_1000, FEE_100, EXPIRATION_0X12345678,
  REVERSE_HOOK,
].join('')}`;

const REVERSE_EXPECTATION = {
  version: 1,
  direction: 'base-to-stellar',
  sourceDomain: 6,
  destinationDomain: 27,
  sender: `0x${BASE_TOKEN_MESSENGER}`,
  recipient: `0x${STELLAR_TOKEN_MESSENGER}`,
  destinationCaller: `0x${STELLAR_FORWARDER}`,
  burnToken: `0x${BASE_USDC}`,
  mintRecipient: `0x${STELLAR_FORWARDER}`,
  messageSender: `0x${BASE_EXIT_SWEEPER}`,
  amount: '1234567',
  burnUnits7: null,
  maxFee: '1000',
  minFinalityThreshold: 1000,
  hookData: `0x${REVERSE_HOOK}`,
};

// Hash forms: forward burn = 64 hex no 0x, Base mint = 0x+64; reverse inverted.
const BURN_FORWARD = 'aa'.repeat(32);
const MINT_BASE = `0x${'bb'.repeat(32)}`;
const BURN_REVERSE = `0x${'cc'.repeat(32)}`;
const MINT_STELLAR = 'dd'.repeat(32);

// Evidence: '0xaabb' digest pinned by the task-8 design; message digest hand-calculated via
// sha256 over the decoded FORWARD_MESSAGE bytes (never via production helpers):
//   node -e 'console.log(require("crypto").createHash("sha256").update(Buffer.from("<hex>","hex")).digest("hex"))'
const ATTESTATION = '0xaabb';
const ATTESTATION_DIGEST = 'd798d1fac6bd4bb1c11f50312760351013379a0ab6f0a8c0af8a506b96b2525a';
const NEW_ATTESTATION = '0xccdd';
const FORWARD_MESSAGE_DIGEST =
  'dd776b9dccecbfa20754c4c81cf41878d20a6f5f0abae660b1d797f265091f28';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const codedError = (code) => Object.assign(new Error(`fake ${code}`), { code });

function tracedStore(store, trace) {
  const OPS = new Set([
    'enqueue', 'claim', 'renew', 'recordAttested', 'markMintSubmitting', 'markMintSubmitted',
    'finishMinted', 'finishBlocked', 'finishUncertain', 'release', 'reconcileExpired',
  ]);
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        if (OPS.has(prop)) return (...args) => { trace.push(prop); return value.apply(target, args); };
        return value.bind(target);
      }
      return value;
    },
  });
}

function failOnce(store, method, error) {
  let armed = true;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === method && typeof value === 'function') {
        return (...args) => {
          if (armed) { armed = false; throw error; }
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function buildWatcher(overrides = {}) {
  const store = overrides.store ?? createMemoryStore();
  const calls = { poll: [], submitBase: [], confirmBase: [], submitStellar: [], confirmStellar: [] };
  const fakes = {
    pollAttestationFn: async (args) => {
      calls.poll.push(args);
      return { message: FORWARD_MESSAGE, attestation: ATTESTATION, parsed: { nonce: '0xjunk' } };
    },
    submitMintBaseFn: async (args) => { calls.submitBase.push(args); return MINT_BASE; },
    confirmMintBaseFn: async (args) => { calls.confirmBase.push(args); return MINT_BASE; },
    submitMintAndForwardStellarFn: async (args) => { calls.submitStellar.push(args); return MINT_STELLAR; },
    confirmMintAndForwardStellarFn: async (args) => { calls.confirmStellar.push(args); return MINT_STELLAR; },
  };
  const watcher = createWatcher({
    store,
    irisUrl: IRIS_URL,
    domains: DOMAINS,
    base: { publicClient: { pub: true }, walletClient: { wal: true }, messageTransmitterAddress: '0xMTV2' },
    stellar: {
      server: { srv: true }, kp: { kp: true }, sourcePub: 'GSRC',
      passphrase: 'Test SDF Network ; September 2015', forwarderAddress: 'CFWD',
    },
    ...fakes,
    ...(overrides.fakes ?? {}),
    ...(overrides.config ?? {}),
  });
  return { store, watcher, calls };
}

const forwardArgs = (execId = 'exec-1', overrides = {}) => ({
  sourceDomain: DOMAINS.stellar, burnTxHash: BURN_FORWARD, execId,
  expectation: FORWARD_EXPECTATION, ...overrides,
});
const reverseArgs = (execId = 'exec-1', overrides = {}) => ({
  sourceDomain: DOMAINS.base, burnTxHash: BURN_REVERSE, execId,
  expectation: REVERSE_EXPECTATION, ...overrides,
});

function seedAttested(store, execId, {
  now = T0, leaseMs = 60_000, releaseLease = true,
  message = FORWARD_MESSAGE, attestation = ATTESTATION, args = forwardArgs(execId),
} = {}) {
  store.enqueue({
    execId, sourceDomain: args.sourceDomain, burnTxHash: args.burnTxHash,
    expectation: args.expectation, now,
  });
  const claimed = store.claim({ execId, now, leaseMs });
  store.recordAttested({
    execId, leaseToken: claimed.leaseToken, messageHex: message,
    nonceHex: `0x${NONCE_FORWARD}`, attestationHex: attestation, now,
  });
  if (releaseLease) store.release({ execId, leaseToken: claimed.leaseToken, now });
  return claimed.leaseToken;
}

function seedSubmitted(store, execId, {
  now = T0, leaseMs = 60_000, releaseLease = true, mintTxHash = MINT_BASE, args = forwardArgs(execId),
} = {}) {
  const token = seedAttested(store, execId, { now, leaseMs, releaseLease: false, args });
  store.markMintSubmitting({ execId, leaseToken: token, now });
  store.markMintSubmitted({ execId, leaseToken: token, mintTxHash, now });
  if (releaseLease) store.release({ execId, leaseToken: token, now });
  return token;
}

// ---------------------------------------------------------------------------
// Pre-enqueue validation (crash matrix row: before-enqueue invalid input -> no row)
// ---------------------------------------------------------------------------

describe('relayMint input validation fails before enqueue', () => {
  // Regression caught (invariant: no permissive legacy path): Iris was polled with no
  // expectation, so any first complete message was trusted (raw-message authority bypass).
  it('a missing expectation rejects before any row, poll, or submit exists', async () => {
    const { store, watcher, calls } = buildWatcher();
    await expect(watcher.relayMint({
      sourceDomain: DOMAINS.stellar, burnTxHash: BURN_FORWARD, execId: 'exec-noexp',
    })).rejects.toMatchObject({ code: 'RELAY_VALIDATION' });
    expect(store.get('exec-noexp')).toBeNull();
    expect(calls.poll).toHaveLength(0);
    expect(calls.submitBase).toHaveLength(0);
    expect(calls.submitStellar).toHaveLength(0);
  });

  it('an unrecognized sourceDomain rejects before enqueue', async () => {
    const { store, watcher, calls } = buildWatcher();
    await expect(watcher.relayMint(forwardArgs('exec-bad', { sourceDomain: 99 })))
      .rejects.toMatchObject({ code: 'RELAY_VALIDATION' });
    expect(store.get('exec-bad')).toBeNull();
    expect(calls.poll).toHaveLength(0);
  });

  it('a malformed burn hash for the direction rejects before enqueue', async () => {
    const { store, watcher, calls } = buildWatcher();
    await expect(watcher.relayMint(forwardArgs('exec-badhash', { burnTxHash: `0x${BURN_FORWARD}` })))
      .rejects.toMatchObject({ code: 'RELAY_VALIDATION' });
    await expect(watcher.relayMint(reverseArgs('exec-badhash2', { burnTxHash: MINT_STELLAR.slice(0, 40) })))
      .rejects.toMatchObject({ code: 'RELAY_VALIDATION' });
    expect(store.get('exec-badhash')).toBeNull();
    expect(store.get('exec-badhash2')).toBeNull();
    expect(calls.poll).toHaveLength(0);
    expect(calls.submitBase).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Watcher behavior case 1 + 3 + 4: forward happy path with exact order and store reads
// ---------------------------------------------------------------------------

describe('forward happy path', () => {
  // Regression caught: the old watcher wrote pending -> polled -> submitted -> overwrote
  // minted, with no attested checkpoint, no submit fence, and no receipt truth.
  it('proves the exact durable order and confirms only the checkpointed hash', async () => {
    const trace = [];
    const realStore = createMemoryStore();
    const store = tracedStore(realStore, trace);
    const observed = {};
    const { watcher, calls } = buildWatcher({
      store,
      fakes: {
        pollAttestationFn: async (args) => {
          trace.push('poll');
          calls.poll.push(args);
          // a junk parsed object on purpose: the watcher must re-run the real assertion
          return { message: FORWARD_MESSAGE, attestation: ATTESTATION, parsed: { nonce: '0xjunk' } };
        },
        submitMintBaseFn: async (args) => {
          trace.push('submit');
          calls.submitBase.push(args);
          observed.atSubmit = JSON.parse(JSON.stringify(realStore.get('exec-1')));
          return MINT_BASE;
        },
        confirmMintBaseFn: async (args) => {
          trace.push('confirm');
          calls.confirmBase.push(args);
          observed.atConfirm = JSON.parse(JSON.stringify(realStore.get('exec-1')));
          return MINT_BASE;
        },
      },
    });

    const result = await watcher.relayMint(forwardArgs('exec-1'));

    expect(result).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    expect(trace).toEqual([
      'enqueue', 'claim', 'poll', 'recordAttested', 'markMintSubmitting',
      'submit', 'markMintSubmitted', 'confirm', 'finishMinted',
    ]);

    // the poll received the immutable expectation, verbatim
    expect(calls.poll).toHaveLength(1);
    expect(calls.poll[0].expectation).toEqual(FORWARD_EXPECTATION);
    expect(calls.poll[0].txHash).toBe(BURN_FORWARD);
    expect(calls.poll[0].sourceDomain).toBe(DOMAINS.stellar);

    // case 3: at submit time the durable row shows attested evidence + crossed fence
    expect(observed.atSubmit).toMatchObject({
      state: 'mint_submitting',
      messageHex: FORWARD_MESSAGE,
      nonceHex: `0x${NONCE_FORWARD}`, // the REAL parsed nonce, not the fake's junk parsed object
      messageDigest: FORWARD_MESSAGE_DIGEST,
      attestationHex: ATTESTATION,
      attestationDigest: ATTESTATION_DIGEST,
      evidenceVersion: 1,
      mintTxHash: null,
    });
    // structural separation: the submit seam never receives a receipt reader
    expect(calls.submitBase[0].publicClient).toBeUndefined();
    expect(calls.submitBase[0].message).toBe(FORWARD_MESSAGE);
    expect(calls.submitBase[0].attestation).toBe(ATTESTATION);

    // case 4: at confirm time the durable row holds the exact checkpointed hash
    expect(observed.atConfirm).toMatchObject({ state: 'mint_submitted', mintTxHash: MINT_BASE });
    // structural separation: the confirm seam receives only the hash — no signer, no evidence
    expect(calls.confirmBase[0].hash).toBe(MINT_BASE);
    expect(calls.confirmBase[0].walletClient).toBeUndefined();
    expect(calls.confirmBase[0].message).toBeUndefined();
    expect(calls.confirmBase[0].attestation).toBeUndefined();

    expect(realStore.get('exec-1')).toMatchObject({
      state: 'minted', mintTxHash: MINT_BASE, leaseToken: null,
    });
  });

  it('orders the store fence before the external submit and the checkpoint before confirm', async () => {
    const order = [];
    const realStore = createMemoryStore();
    const { watcher } = buildWatcher({
      store: realStore,
      fakes: {
        pollAttestationFn: async () => {
          order.push(`poll:${realStore.get('exec-1').state}`);
          return { message: FORWARD_MESSAGE, attestation: ATTESTATION };
        },
        submitMintBaseFn: async () => {
          order.push(`submit:${realStore.get('exec-1').state}`);
          return MINT_BASE;
        },
        confirmMintBaseFn: async () => {
          order.push(`confirm:${realStore.get('exec-1').state}`);
          return MINT_BASE;
        },
      },
    });
    await watcher.relayMint(forwardArgs('exec-1'));
    expect(order).toEqual([
      'poll:attestation_pending',
      'submit:mint_submitting',
      'confirm:mint_submitted',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Watcher behavior case 2: reverse happy path through the Stellar seams
// ---------------------------------------------------------------------------

describe('reverse happy path', () => {
  // Regression caught: mintAndForwardStellar combined send+confirm, so a process loss after
  // sendTransaction left no durable hash and the legacy sweep could rebroadcast.
  it('drives the same state machine through the split Stellar seams', async () => {
    const realStore = createMemoryStore();
    const observed = {};
    const { watcher, calls } = buildWatcher({
      store: realStore,
      fakes: {
        pollAttestationFn: async (args) => {
          calls.poll.push(args);
          return { message: REVERSE_MESSAGE, attestation: ATTESTATION };
        },
        submitMintAndForwardStellarFn: async (args) => {
          calls.submitStellar.push(args);
          observed.atSubmit = JSON.parse(JSON.stringify(realStore.get('exec-rev')));
          return MINT_STELLAR;
        },
        confirmMintAndForwardStellarFn: async (args) => {
          calls.confirmStellar.push(args);
          observed.atConfirm = JSON.parse(JSON.stringify(realStore.get('exec-rev')));
          return MINT_STELLAR;
        },
      },
    });

    const result = await watcher.relayMint(reverseArgs('exec-rev'));

    expect(result).toEqual({ status: 'minted', mintTxHash: MINT_STELLAR });
    expect(calls.poll[0].expectation).toEqual(REVERSE_EXPECTATION);
    expect(calls.submitBase).toHaveLength(0);
    expect(calls.confirmBase).toHaveLength(0);
    expect(calls.submitStellar).toHaveLength(1);
    expect(observed.atSubmit).toMatchObject({
      state: 'mint_submitting',
      nonceHex: `0x${NONCE_REVERSE}`,
      evidenceVersion: 1,
    });
    expect(observed.atConfirm).toMatchObject({ state: 'mint_submitted', mintTxHash: MINT_STELLAR });
    expect(calls.confirmStellar[0].hash).toBe(MINT_STELLAR);
    expect(calls.confirmStellar[0].message).toBeUndefined();
    expect(realStore.get('exec-rev')).toMatchObject({ state: 'minted', mintTxHash: MINT_STELLAR });
  });
});

// ---------------------------------------------------------------------------
// Watcher behavior case 6: typed Iris outcomes -> durable classification
// ---------------------------------------------------------------------------

describe('typed Iris outcomes classify durably without touching destination seams', () => {
  // Regression caught: raw-message mismatch was retryable forever (or worse, minted on a
  // later different message) instead of terminal blocked.
  it('CCTP_MESSAGE_MISMATCH becomes terminal blocked (message_mismatch)', async () => {
    const { store, watcher, calls } = buildWatcher({
      fakes: { pollAttestationFn: async () => { throw codedError('CCTP_MESSAGE_MISMATCH'); } },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'blocked', reasonCode: 'message_mismatch' });
    expect(store.get('exec-1')).toMatchObject({ state: 'blocked', reasonCode: 'message_mismatch' });
    expect(calls.submitBase).toHaveLength(0);
    expect(calls.confirmBase).toHaveLength(0);
  });

  it('CCTP_MESSAGE_AMBIGUOUS becomes terminal blocked (message_ambiguous)', async () => {
    const { store, watcher, calls } = buildWatcher({
      fakes: { pollAttestationFn: async () => { throw codedError('CCTP_MESSAGE_AMBIGUOUS'); } },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'blocked', reasonCode: 'message_ambiguous' });
    expect(store.get('exec-1')).toMatchObject({ state: 'blocked', reasonCode: 'message_ambiguous' });
    expect(calls.submitBase).toHaveLength(0);
  });

  // Regression caught: attestation timeout consumed the row (marked failed) instead of
  // staying safely recoverable.
  it('CCTP_ATTESTATION_TIMEOUT stays attestation_pending, released, and re-pollable', async () => {
    let polls = 0;
    const { store, watcher, calls } = buildWatcher({
      fakes: {
        pollAttestationFn: async () => {
          polls += 1;
          if (polls === 1) throw codedError('CCTP_ATTESTATION_TIMEOUT');
          return { message: FORWARD_MESSAGE, attestation: ATTESTATION };
        },
      },
    });
    const first = await watcher.relayMint(forwardArgs('exec-1'));
    expect(first).toEqual({ status: 'attestation_pending' });
    expect(JSON.stringify(first)).not.toContain(MINT_BASE);
    expect(store.get('exec-1')).toMatchObject({
      state: 'attestation_pending', leaseToken: null, leaseExpiresAt: null,
    });
    expect(calls.submitBase).toHaveLength(0);
    const second = await watcher.relayMint(forwardArgs('exec-1'));
    expect(second).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    expect(polls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Crash-window matrix
// ---------------------------------------------------------------------------

describe('crash windows', () => {
  // Regression caught: unique Iris evidence was submitted even when the durable attested
  // checkpoint failed, so a restart had no validated evidence for the in-flight mint.
  it('recordAttested failure leaves the row pending/held and never submits', async () => {
    const realStore = createMemoryStore();
    const store = failOnce(realStore, 'recordAttested', new Error('disk full'));
    const { watcher, calls } = buildWatcher({ store });
    const result = await watcher.relayMint(forwardArgs('exec-1')).catch((err) => err);
    // outward shape may be a rejection or a non-minted result; the durable truth is pinned:
    if (!(result instanceof Error)) {
      expect(result.status).not.toBe('minted');
      expect(result.status).not.toBe('already-minted');
    }
    expect(calls.submitBase).toHaveLength(0);
    expect(calls.submitStellar).toHaveLength(0);
    expect(['attestation_pending']).toContain(realStore.get('exec-1').state);
    expect(realStore.get('exec-1').messageHex).toBeNull();
  });

  // Regression caught: a reopened attested row was submitted without re-polling, so evidence
  // that changed after the crash was never revalidated.
  it('reopened attested work re-polls and submits only when evidence is identical', async () => {
    const realStore = createMemoryStore();
    seedAttested(realStore, 'exec-1');
    const { watcher, calls } = buildWatcher({ store: realStore });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    expect(calls.poll).toHaveLength(1);
    expect(calls.submitBase).toHaveLength(1);
    // exact same evidence retry stays at evidenceVersion 1 (no false "new evidence")
    expect(realStore.get('exec-1').evidenceVersion).toBe(1);
  });

  it('reopened attested work blocks when the re-polled message differs (nonce change)', async () => {
    const realStore = createMemoryStore();
    seedAttested(realStore, 'exec-1');
    const { watcher, calls } = buildWatcher({
      store: realStore,
      fakes: {
        pollAttestationFn: async () => ({ message: FORWARD_MESSAGE_OTHER_NONCE, attestation: ATTESTATION }),
      },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'blocked', reasonCode: 'attested_evidence_changed' });
    expect(calls.submitBase).toHaveLength(0);
    // the original durable evidence is NOT replaced by the disagreeing candidate
    expect(realStore.get('exec-1')).toMatchObject({
      state: 'blocked',
      reasonCode: 'attested_evidence_changed',
      messageHex: FORWARD_MESSAGE,
      nonceHex: `0x${NONCE_FORWARD}`,
      messageDigest: FORWARD_MESSAGE_DIGEST,
    });
  });

  // Regression caught (case 7): a fresh attestation over the same message was not
  // distinguished from an evidence change.
  it('a new valid attestation for the same message bumps evidenceVersion before the fence', async () => {
    const realStore = createMemoryStore();
    seedAttested(realStore, 'exec-1');
    let versionAtSubmit = null;
    const { watcher } = buildWatcher({
      store: realStore,
      fakes: {
        pollAttestationFn: async () => ({ message: FORWARD_MESSAGE, attestation: NEW_ATTESTATION }),
        submitMintBaseFn: async () => {
          versionAtSubmit = realStore.get('exec-1').evidenceVersion;
          return MINT_BASE;
        },
      },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result.status).toBe('minted');
    expect(versionAtSubmit).toBe(2);
  });

  // Regression caught: an expired lease on mint_submitting was silently reclaimed and the
  // mint re-submitted — a double destination send (invariant 3).
  it('an expired mint_submitting lease reconciles to uncertain and calls no seam', async () => {
    const realStore = createMemoryStore();
    seedAttested(realStore, 'exec-expired', { now: T0, leaseMs: 10, releaseLease: false });
    realStore.markMintSubmitting({
      execId: 'exec-expired',
      leaseToken: realStore.get('exec-expired').leaseToken,
      now: T0,
    });
    const { watcher, calls, store } = buildWatcher({ store: realStore });
    const sweep = await watcher.sweepStuck({ now: T0 + 1_000, limit: 100 });
    expect(sweep.uncertain).toEqual(['exec-expired']);
    expect(sweep.redriven).toEqual([]);
    expect(store.get('exec-expired')).toMatchObject({
      state: 'uncertain', reasonCode: 'submission_lease_expired', leaseToken: null,
    });
    // a reconciled expired mint_submitting row calls NEITHER destination seam
    expect(calls.submitBase).toHaveLength(0);
    expect(calls.submitStellar).toHaveLength(0);
    expect(calls.confirmBase).toHaveLength(0);
    expect(calls.confirmStellar).toHaveLength(0);
    expect(calls.poll).toHaveLength(0);
  });

  // Regression caught: a send error after the fence either vanished (row stuck) or was
  // retried automatically, double-submitting (invariant 3).
  it('a submit throw after the fence becomes uncertain (submission_unknown) and never auto-retries', async () => {
    let submitAttempts = 0;
    const realStore = createMemoryStore();
    const { watcher } = buildWatcher({
      store: realStore,
      fakes: {
        submitMintBaseFn: async () => {
          submitAttempts += 1;
          expect(realStore.get('exec-1').state).toBe('mint_submitting'); // fence crossed first
          throw new Error('base RPC 500');
        },
      },
    });
    const first = await watcher.relayMint(forwardArgs('exec-1'));
    expect(first).toEqual({ status: 'uncertain', reasonCode: 'submission_unknown' });
    expect(realStore.get('exec-1')).toMatchObject({
      state: 'uncertain', reasonCode: 'submission_unknown', mintTxHash: null,
    });
    const second = await watcher.relayMint(forwardArgs('exec-1'));
    expect(second.status).toBe('uncertain');
    expect(submitAttempts).toBe(1); // NO automatic resubmission
  });

  // Regression caught: the send returned a hash but the submitted checkpoint failed; the old
  // code kept the row pending and rebroadcast later (the live 0x69e0856a incident shape).
  it('a failed submitted checkpoint retains the hash best-effort in uncertain and never auto-retries', async () => {
    const realStore = createMemoryStore();
    const store = failOnce(realStore, 'markMintSubmitted', new Error('disk full'));
    let submitAttempts = 0;
    const { watcher } = buildWatcher({
      store,
      fakes: {
        submitMintBaseFn: async () => { submitAttempts += 1; return MINT_BASE; },
      },
    });
    const first = await watcher.relayMint(forwardArgs('exec-1'));
    expect(first).toEqual({ status: 'uncertain', reasonCode: 'submitted_checkpoint_failed' });
    expect(realStore.get('exec-1')).toMatchObject({
      state: 'uncertain', reasonCode: 'submitted_checkpoint_failed', mintTxHash: MINT_BASE,
    });
    const second = await watcher.relayMint(forwardArgs('exec-1'));
    expect(second.status).toBe('uncertain');
    expect(submitAttempts).toBe(1);
  });

  // Regression caught: a reopened mint_submitted row re-polled Iris and re-submitted instead
  // of confirming the already-persisted hash (invariant 4).
  it('reopened mint_submitted confirms the persisted hash only — no poll, no submit', async () => {
    const realStore = createMemoryStore();
    seedSubmitted(realStore, 'exec-1', { mintTxHash: MINT_BASE });
    const { watcher, calls } = buildWatcher({ store: realStore });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    expect(calls.poll).toHaveLength(0);
    expect(calls.submitBase).toHaveLength(0);
    expect(calls.confirmBase).toHaveLength(1);
    expect(calls.confirmBase[0].hash).toBe(MINT_BASE);
    expect(calls.confirmBase[0].message).toBeUndefined();
  });

  // Regression caught: mintBase returned a reverted receipt status and the watcher recorded
  // minted anyway (receipt truth ignored — invariant 2).
  it('an explicit reverted Base receipt becomes blocked (destination_reverted), never minted', async () => {
    const realStore = createMemoryStore();
    const { watcher, calls } = buildWatcher({
      store: realStore,
      fakes: {
        confirmMintBaseFn: async () => { throw codedError('CCTP_MINT_REVERTED'); },
      },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'blocked', reasonCode: 'destination_reverted' });
    expect(realStore.get('exec-1')).toMatchObject({
      state: 'blocked', reasonCode: 'destination_reverted', mintTxHash: MINT_BASE,
    });
    const retry = await watcher.relayMint(forwardArgs('exec-1'));
    expect(retry).toEqual({ status: 'blocked', reasonCode: 'destination_reverted' });
    expect(calls.submitBase).toHaveLength(1); // no repeat submit
    expect(calls.poll).toHaveLength(1);
  });

  it('an explicit Stellar FAILED confirmation becomes blocked (destination_reverted)', async () => {
    const realStore = createMemoryStore();
    const { watcher, calls } = buildWatcher({
      store: realStore,
      fakes: {
        pollAttestationFn: async () => ({ message: REVERSE_MESSAGE, attestation: ATTESTATION }),
        confirmMintAndForwardStellarFn: async () => { throw codedError('STELLAR_TX_FAILED'); },
      },
    });
    const result = await watcher.relayMint(reverseArgs('exec-1'));
    expect(result).toEqual({ status: 'blocked', reasonCode: 'destination_reverted' });
    expect(realStore.get('exec-1').state).toBe('blocked');
    expect(calls.submitStellar).toHaveLength(1); // no repeat submit on retry either
    const retry = await watcher.relayMint(reverseArgs('exec-1'));
    expect(retry.status).toBe('blocked');
    expect(calls.submitStellar).toHaveLength(1);
  });

  // Regression caught: a transient confirmation error with a KNOWN hash was relabeled as
  // failure, throwing away the durable confirmation identity (invariant 4).
  it('a transient confirmation error keeps mint_submitted; resume reconfirms the same hash', async () => {
    let confirms = 0;
    const realStore = createMemoryStore();
    const confirmHashes = [];
    const { watcher, calls } = buildWatcher({
      store: realStore,
      fakes: {
        confirmMintBaseFn: async (args) => {
          confirms += 1;
          confirmHashes.push(args.hash);
          if (confirms === 1) throw codedError('CCTP_MINT_CONFIRMATION_RETRYABLE');
          return args.hash;
        },
      },
    });
    const first = await watcher.relayMint(forwardArgs('exec-1'));
    expect(first).toEqual({ status: 'mint_submitted', mintTxHash: MINT_BASE });
    expect(realStore.get('exec-1')).toMatchObject({
      state: 'mint_submitted', mintTxHash: MINT_BASE, leaseToken: null,
    });
    const second = await watcher.relayMint(forwardArgs('exec-1'));
    expect(second).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    expect(confirmHashes).toEqual([MINT_BASE, MINT_BASE]);
    expect(calls.submitBase).toHaveLength(1); // never re-submitted
    expect(calls.poll).toHaveLength(1); // never re-polled after evidence was durable
  });

  // Regression caught: the receipt succeeded but the minted commit failed; the old watcher
  // lost the row or re-submitted on retry instead of reconfirming the same hash.
  it('a failed minted commit stays mint_submitted; resume reconfirms the same hash', async () => {
    const realStore = createMemoryStore();
    const store = failOnce(realStore, 'finishMinted', new Error('disk full'));
    const confirmHashes = [];
    let submits = 0;
    const { watcher } = buildWatcher({
      store,
      fakes: {
        submitMintBaseFn: async () => { submits += 1; return MINT_BASE; },
        confirmMintBaseFn: async (args) => { confirmHashes.push(args.hash); return args.hash; },
      },
    });
    const first = await watcher.relayMint(forwardArgs('exec-1')).catch((err) => err);
    if (!(first instanceof Error)) {
      expect(first).toEqual({ status: 'mint_submitted', mintTxHash: MINT_BASE });
    }
    expect(realStore.get('exec-1').state).toBe('mint_submitted'); // durable truth
    const second = await watcher.relayMint(forwardArgs('exec-1'));
    expect(second).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    expect(confirmHashes).toEqual([MINT_BASE, MINT_BASE]);
    expect(submits).toBe(1);
  });

  // Regression caught: post-mint retries re-polled/re-confirmed (or worse, re-submitted)
  // instead of answering from the durable terminal record (invariant: terminal stability).
  it('after minted, a duplicate call answers already-minted with no poll/submit/confirm', async () => {
    const { store, watcher, calls } = buildWatcher();
    const first = await watcher.relayMint(forwardArgs('exec-1'));
    expect(first).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    const second = await watcher.relayMint(forwardArgs('exec-1'));
    expect(second).toEqual({ status: 'already-minted', mintTxHash: MINT_BASE });
    expect(calls.poll).toHaveLength(1);
    expect(calls.submitBase).toHaveLength(1);
    expect(calls.confirmBase).toHaveLength(1);
    expect(store.get('exec-1').state).toBe('minted');
  });
});

// ---------------------------------------------------------------------------
// Watcher behavior case 8: immutable-intent conflicts never mutate valid work
// ---------------------------------------------------------------------------

describe('immutable intent conflicts', () => {
  // Regression caught (plan mismatch #9): a conflicting retry marked the valid row blocked,
  // destroying good recovery evidence.
  it('a changed expectation on the same execId conflicts and leaves the valid row untouched', async () => {
    const realStore = createMemoryStore();
    seedAttested(realStore, 'exec-1');
    const before = JSON.parse(JSON.stringify(realStore.get('exec-1')));
    const { watcher, calls } = buildWatcher({ store: realStore });
    await expect(watcher.relayMint(forwardArgs('exec-1', {
      expectation: { ...FORWARD_EXPECTATION, amount: '2000000', burnUnits7: '20000000' },
    }))).rejects.toMatchObject({ code: 'RELAY_ENQUEUE_CONFLICT' });
    expect(calls.poll).toHaveLength(0);
    expect(calls.submitBase).toHaveLength(0);
    expect(realStore.get('exec-1')).toEqual(before);
    expect(realStore.get('exec-1').state).toBe('attested'); // NOT blocked by the conflict
  });

  it('a burn hash reused by another execId conflicts without touching the original row', async () => {
    const realStore = createMemoryStore();
    seedAttested(realStore, 'exec-1');
    const before = JSON.parse(JSON.stringify(realStore.get('exec-1')));
    const { watcher } = buildWatcher({ store: realStore });
    await expect(watcher.relayMint(forwardArgs('exec-2')))
      .rejects.toMatchObject({ code: 'RELAY_ENQUEUE_CONFLICT' });
    expect(realStore.get('exec-2')).toBeNull();
    expect(realStore.get('exec-1')).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Watcher behavior case 9: concurrent identical calls -> one submission
// ---------------------------------------------------------------------------

describe('concurrent identical calls', () => {
  // Regression caught: two in-flight relayMint calls for the same execId both passed the
  // legacy store check and both submitted the destination mint.
  it('cause exactly one external submission; the joiner never looks like mint evidence', async () => {
    let submits = 0;
    let releaseSubmit;
    const gate = new Promise((resolve) => { releaseSubmit = resolve; });
    const { watcher } = buildWatcher({
      fakes: {
        submitMintBaseFn: async () => {
          submits += 1;
          await gate;
          return MINT_BASE;
        },
      },
    });
    const args = forwardArgs('exec-1');
    const first = watcher.relayMint(args);
    // suppress premature unhandled-rejection noise; Promise.all below still observes failures
    first.catch(() => {});
    // bounded wait: lets the first call reach the submit seam before the second joins
    for (let i = 0; i < 10_000 && submits === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const second = watcher.relayMint(args);
    second.catch(() => {});
    releaseSubmit();
    const [r1, r2] = await Promise.all([first, second]);

    expect(submits).toBe(1);
    for (const result of [r1, r2]) {
      if (result.status === 'in-progress') {
        // an explicit non-minted shape the farm flow can never mistake for mint evidence
        expect(result).toEqual({ status: 'in-progress' });
      } else {
        expect(result).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
      }
    }
    expect([r1, r2].some((r) => r.status === 'minted')).toBe(true);
  });

  it('a call against an actively leased row reports in-progress, not mint evidence', async () => {
    const realStore = createMemoryStore();
    realStore.enqueue({
      execId: 'exec-1', sourceDomain: DOMAINS.stellar, burnTxHash: BURN_FORWARD,
      expectation: FORWARD_EXPECTATION, now: T0,
    });
    realStore.claim({ execId: 'exec-1', now: T0, leaseMs: 600_000 }); // held by another worker
    const { watcher, calls } = buildWatcher({ store: realStore });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'in-progress' });
    expect(calls.poll).toHaveLength(0);
    expect(calls.submitBase).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Watcher behavior case 10: terminal byte-stability across duplicate calls and reopen
// ---------------------------------------------------------------------------

describe('terminal byte-stability', () => {
  // Regression caught: duplicate calls after minted rewrote the record (new updatedAt, lost
  // fields), so the durable terminal truth drifted between restarts.
  it('a minted file record is byte-for-byte stable across duplicate calls and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-watcher-term-'));
    const path = join(dir, 'store.json');
    const first = buildWatcher({ store: createFileStore(path) });
    const minted = await first.watcher.relayMint(forwardArgs('exec-1'));
    expect(minted).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    const stableBytes = readFileSync(path, 'utf8');

    const dup = await first.watcher.relayMint(forwardArgs('exec-1'));
    expect(dup).toEqual({ status: 'already-minted', mintTxHash: MINT_BASE });
    expect(readFileSync(path, 'utf8')).toBe(stableBytes);

    const reopened = buildWatcher({ store: createFileStore(path) });
    const third = await reopened.watcher.relayMint(forwardArgs('exec-1'));
    expect(third).toEqual({ status: 'already-minted', mintTxHash: MINT_BASE });
    expect(readFileSync(path, 'utf8')).toBe(stableBytes);
    expect(reopened.calls.poll).toHaveLength(0);
    expect(reopened.calls.submitBase).toHaveLength(0);
    expect(reopened.calls.confirmBase).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lease budget vs long polls (independent-review Important: the 60s default lease
// dies mid-poll on a ~13-25 minute standard-finality attestation, so recordAttested
// CAS-fails after a SUCCESSFUL poll and the row wedges until reconciliation)
// ---------------------------------------------------------------------------

describe('lease budget covers the configured poll budget', () => {
  // Regression caught: a poll that outlives the claim lease made every durable transition
  // after it fail with RELAY_CAS_CONFLICT, stranding a successfully attested row.
  it('claims with a lease sized to the poll budget, so a 20-minute poll still mints', async () => {
    const realStore = createMemoryStore();
    let now = T0;
    let leaseAtPoll;
    const { watcher, calls } = buildWatcher({
      store: realStore,
      config: { nowFn: () => now },
      fakes: {
        pollAttestationFn: async (args) => {
          calls.poll.push(args);
          leaseAtPoll = realStore.get('exec-1').leaseExpiresAt - now;
          now += 20 * 60_000; // a standard-finality poll outlives the 60s default lease
          return { message: FORWARD_MESSAGE, attestation: ATTESTATION };
        },
      },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    expect(realStore.get('exec-1').state).toBe('minted');
    // the claim lease covers the full configured poll budget plus margin, not the bare default
    expect(leaseAtPoll).toBeGreaterThanOrEqual(300 * 5000);
    // the configured poll budget is forwarded to the Iris boundary (no hidden defaults)
    expect(calls.poll[0]).toMatchObject({ maxAttempts: 300, intervalMs: 5000 });
  });

  it('an explicit small poll budget sizes the lease as budget + submit/confirm margin', async () => {
    const realStore = createMemoryStore();
    let now = T0;
    let leaseAtPoll;
    const { watcher, calls } = buildWatcher({
      store: realStore,
      config: { nowFn: () => now, pollMaxAttempts: 2, pollIntervalMs: 1000 },
      fakes: {
        pollAttestationFn: async (args) => {
          calls.poll.push(args);
          leaseAtPoll = realStore.get('exec-1').leaseExpiresAt - now;
          return { message: FORWARD_MESSAGE, attestation: ATTESTATION };
        },
      },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    // 2s poll budget + the 120s submit/confirm margin exceeds the 60s floor
    expect(leaseAtPoll).toBe(2 * 1000 + 120_000);
    expect(calls.poll[0]).toMatchObject({ maxAttempts: 2, intervalMs: 1000 });
  });
});

// ---------------------------------------------------------------------------
// sweepStuck classification (task-8 design's deterministic disjoint arrays)
// ---------------------------------------------------------------------------

describe('sweepStuck classification', () => {
  function seedAll(realStore) {
    // redriven: safe states without an active lease
    realStore.enqueue({
      execId: 'pending-safe', sourceDomain: 27, burnTxHash: BURN_FORWARD,
      expectation: FORWARD_EXPECTATION, now: T0,
    });
    seedAttested(realStore, 'attested-safe', {
      now: T0 + 1, args: forwardArgs('attested-safe', { burnTxHash: 'a1'.repeat(32) }),
    });
    seedSubmitted(realStore, 'submitted-safe', {
      now: T0 + 2, args: forwardArgs('submitted-safe', { burnTxHash: 'a2'.repeat(32) }),
    });
    // held: active leases
    realStore.enqueue({
      execId: 'pending-active-lease', sourceDomain: 27, burnTxHash: 'a3'.repeat(32),
      expectation: FORWARD_EXPECTATION, now: T0 + 3,
    });
    realStore.claim({ execId: 'pending-active-lease', now: T0 + 3, leaseMs: 60_000 });
    seedAttested(realStore, 'submitting-active-lease', {
      now: T0 + 4, leaseMs: 60_000, releaseLease: false,
      args: forwardArgs('submitting-active-lease', { burnTxHash: 'a4'.repeat(32) }),
    });
    realStore.markMintSubmitting({
      execId: 'submitting-active-lease',
      leaseToken: realStore.get('submitting-active-lease').leaseToken, now: T0 + 4,
    });
    // blocked terminal
    const bToken = seedAttested(realStore, 'blocked-id', {
      now: T0 + 5, releaseLease: false,
      args: forwardArgs('blocked-id', { burnTxHash: 'a5'.repeat(32) }),
    });
    realStore.finishBlocked({
      execId: 'blocked-id', leaseToken: bToken, reasonCode: 'message_mismatch', now: T0 + 5,
    });
    // expired mint_submitting -> reconciled uncertain
    seedAttested(realStore, 'submitting-expired', {
      now: T0 + 6, leaseMs: 10, releaseLease: false,
      args: forwardArgs('submitting-expired', { burnTxHash: 'a6'.repeat(32) }),
    });
    realStore.markMintSubmitting({
      execId: 'submitting-expired',
      leaseToken: realStore.get('submitting-expired').leaseToken, now: T0 + 6,
    });
    // uncertain terminal
    const uToken = seedAttested(realStore, 'uncertain-id', {
      now: T0 + 7, releaseLease: false,
      args: forwardArgs('uncertain-id', { burnTxHash: 'a7'.repeat(32) }),
    });
    realStore.markMintSubmitting({ execId: 'uncertain-id', leaseToken: uToken, now: T0 + 7 });
    realStore.finishUncertain({
      execId: 'uncertain-id', leaseToken: uToken, reasonCode: 'submission_unknown', now: T0 + 7,
    });
    // minted terminal: omitted from every bucket
    const mArgs = forwardArgs('minted-id', { burnTxHash: 'a8'.repeat(32) });
    const mToken = seedSubmitted(realStore, 'minted-id', { now: T0 + 8, releaseLease: false, args: mArgs });
    realStore.finishMinted({
      execId: 'minted-id', leaseToken: mToken, mintTxHash: MINT_BASE, now: T0 + 8,
    });
  }

  // Regression caught: the legacy sweep re-drove only 'pending' rows (and could rebroadcast a
  // submitted mint), never classified held/expired/terminal work.
  it('returns deterministic, disjoint redriven/held/blocked/uncertain arrays; minted omitted', async () => {
    const realStore = createMemoryStore();
    seedAll(realStore);
    const { watcher, calls } = buildWatcher({
      store: realStore,
      fakes: {
        pollAttestationFn: async (args) => {
          calls.poll.push(args);
          throw codedError('CCTP_ATTESTATION_TIMEOUT'); // pending/attested stay recoverable
        },
      },
    });
    const sweep = await watcher.sweepStuck({ now: T0 + 1_000, limit: 100 });
    expect(sweep).toEqual({
      redriven: ['pending-safe', 'attested-safe', 'submitted-safe'],
      held: ['pending-active-lease', 'submitting-active-lease'],
      blocked: ['blocked-id'],
      uncertain: ['submitting-expired', 'uncertain-id'],
    });
    // redriven mint_submitted calls confirmation only; redriven pending/attested poll only
    expect(calls.confirmBase.map((c) => c.hash)).toEqual([MINT_BASE]);
    expect(calls.poll.map((p) => p.txHash).sort()).toEqual(['a1'.repeat(32), BURN_FORWARD].sort());
    expect(calls.submitBase).toHaveLength(0);
    expect(calls.submitStellar).toHaveLength(0);
    // the reconciled expired submitting row touched no destination seam and is durably uncertain
    expect(realStore.get('submitting-expired')).toMatchObject({
      state: 'uncertain', reasonCode: 'submission_lease_expired',
    });
    // the confirmed submitted row finished minted
    expect(realStore.get('submitted-safe').state).toBe('minted');
  });

  // Regression caught: one failing row aborted the whole sweep, leaving later rows
  // unclassified at startup.
  it('one row whose redrive hits a transient error does not abort classification of later rows', async () => {
    const realStore = createMemoryStore();
    seedAll(realStore);
    const { watcher } = buildWatcher({
      store: realStore,
      fakes: {
        pollAttestationFn: async (args) => {
          if (args.txHash === BURN_FORWARD) throw new Error('iris 500'); // transient for pending-safe
          throw codedError('CCTP_ATTESTATION_TIMEOUT');
        },
      },
    });
    const sweep = await watcher.sweepStuck({ now: T0 + 1_000, limit: 100 });
    expect(sweep.redriven).toContain('submitted-safe');
    expect(sweep.held).toEqual(['pending-active-lease', 'submitting-active-lease']);
    expect(sweep.uncertain).toEqual(['submitting-expired', 'uncertain-id']);
    expect(realStore.get('pending-safe').state).toBe('attestation_pending');
    expect(realStore.get('submitted-safe').state).toBe('minted');
  });

  it('sweepStuck honors a bounded limit deterministically', async () => {
    const realStore = createMemoryStore();
    seedAll(realStore);
    const { watcher } = buildWatcher({
      store: realStore,
      fakes: { pollAttestationFn: async () => { throw codedError('CCTP_ATTESTATION_TIMEOUT'); } },
    });
    const sweep = await watcher.sweepStuck({ now: T0 + 1_000, limit: 1 });
    expect(sweep.redriven.length + sweep.held.length + sweep.blocked.length + sweep.uncertain.length)
      .toBeLessThanOrEqual(1);
    expect(sweep.redriven).toEqual(['pending-safe']); // (createdAt, execId) order
  });
});

// ---------------------------------------------------------------------------
// Task 7 integration: the REAL pollAttestation + matcher against the literal message
// ---------------------------------------------------------------------------

describe('Task 7 integration (real pollAttestation and matcher)', () => {
  const irisBody = (messages) => async () => ({
    text: async () => JSON.stringify({ messages }),
  });
  const realPoll = (fetchImpl) => (args) => pollAttestation({
    ...args, fetchImpl, sleepFn: async () => {},
  });

  // Regression caught: the watcher persisted Iris DECODED fields (or the poll fake's parsed
  // object) instead of re-validating raw bytes against the immutable expectation.
  it('persists the real parsed nonce and correct byte digests; decoded fields are irrelevant', async () => {
    const fetchImpl = irisBody([{
      status: 'complete',
      message: FORWARD_MESSAGE,
      attestation: ATTESTATION,
      // decoded junk that disagrees with the raw bytes — must be ignored entirely
      decoded: { amount: '999', nonce: '0xdead', sourceDomain: 6 },
    }]);
    const realStore = createMemoryStore();
    const { watcher } = buildWatcher({
      store: realStore,
      fakes: { pollAttestationFn: realPoll(fetchImpl) },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'minted', mintTxHash: MINT_BASE });
    expect(realStore.get('exec-1')).toMatchObject({
      nonceHex: `0x${NONCE_FORWARD}`,
      messageHex: FORWARD_MESSAGE,
      messageDigest: FORWARD_MESSAGE_DIGEST,
      attestationDigest: ATTESTATION_DIGEST,
    });
  });

  // Regression caught: a one-field change in the raw message was submitted anyway because
  // the watcher trusted the poll result without re-running the real assertion.
  it('a one-field change in the raw message blocks before mint_submitting', async () => {
    const fetchImpl = irisBody([{
      status: 'complete', message: WRONG_AMOUNT_MESSAGE, attestation: ATTESTATION,
    }]);
    const realStore = createMemoryStore();
    const { watcher, calls } = buildWatcher({
      store: realStore,
      fakes: { pollAttestationFn: realPoll(fetchImpl) },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'blocked', reasonCode: 'message_mismatch' });
    expect(calls.submitBase).toHaveLength(0);
    // wrong evidence was never persisted as an attested checkpoint
    expect(realStore.get('exec-1')).toMatchObject({ state: 'blocked', messageHex: null });
  });

  // Regression caught: with two complete matches the watcher selected the first and minted
  // against non-unique evidence.
  it('two complete matches are never selected as evidence', async () => {
    const fetchImpl = irisBody([
      { status: 'complete', message: FORWARD_MESSAGE, attestation: ATTESTATION },
      { status: 'complete', message: FORWARD_MESSAGE_OTHER_NONCE, attestation: NEW_ATTESTATION },
    ]);
    const realStore = createMemoryStore();
    const { watcher, calls } = buildWatcher({
      store: realStore,
      fakes: { pollAttestationFn: realPoll(fetchImpl) },
    });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    expect(result).toEqual({ status: 'blocked', reasonCode: 'message_ambiguous' });
    expect(calls.submitBase).toHaveLength(0);
    expect(realStore.get('exec-1')).toMatchObject({ state: 'blocked', messageHex: null });
  });
});

// ---------------------------------------------------------------------------
// Outward redaction (invariant 8)
// ---------------------------------------------------------------------------

describe('outward redaction', () => {
  // Regression caught: outward watcher results leaked raw messages/attestations/lease tokens.
  it('minted and sweep results expose no raw evidence, lease tokens, or endpoints', async () => {
    const realStore = createMemoryStore();
    const { watcher } = buildWatcher({ store: realStore });
    const result = await watcher.relayMint(forwardArgs('exec-1'));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FORWARD_MESSAGE.slice(2, 40));
    expect(serialized).not.toContain(ATTESTATION.slice(2));
    expect(serialized).not.toContain(IRIS_URL);
    const leaseToken = realStore.get('exec-1').leaseToken;
    if (leaseToken) expect(serialized).not.toContain(leaseToken);

    const sweep = await watcher.sweepStuck({ now: T0, limit: 10 });
    const sweepSerialized = JSON.stringify(sweep);
    expect(sweepSerialized).not.toContain(FORWARD_MESSAGE.slice(2, 40));
    expect(sweepSerialized).not.toContain(ATTESTATION.slice(2));
  });
});
