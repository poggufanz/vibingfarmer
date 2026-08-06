// Task 7 RED — Iris polling with raw-message authority, unique matching, typed terminal errors,
// and bounded retries. REPLACES the legacy toy fixtures (`0xdead`, `0x1`) that locked the
// first-element authority bug: pollAttestation used to read only body.messages[0] and trust its
// status without parsing or matching raw bytes.
// Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/task-7-test-design.md
//
// Mock seam: ONLY the HTTP boundary (injected fetchImpl, plus injected sleepFn). The real
// parser/matcher (relayer/src/cctp/messageV2.mjs) must be exercised — never stubbed. Decoded
// Iris fields are never authority: expectations and results are built from raw literals only.
//
// RED status: iris.mjs does not yet inject fetchImpl/sleepFn, does not require an expectation,
// and messageV2.mjs does not exist — every failure below must be one of those missing behaviors,
// never a fixture typo (the fixture self-check in messageV2.test.mjs covers the literals).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollAttestation } from '../../src/cctp/iris.mjs';

// ---------------------------------------------------------------------------
// Literal fixtures (duplicated by design: hand-authored literals, never imported
// from production and never shared via a helper module outside the three Task 7 files)
// ---------------------------------------------------------------------------

const FAST_1000 = '000003e8';
const STANDARD_2000 = '000007d0';

const ZERO32 = '0000000000000000000000000000000000000000000000000000000000000000';
const NONCE_FORWARD = '1111111111111111111111111111111111111111111111111111111111111111';
const NONCE_REVERSE = '9999999999999999999999999999999999999999999999999999999999999999';

const STELLAR_TOKEN_MESSENGER =
  'da6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8';
const STELLAR_USDC =
  '5045cd5ec0729a768fd5ad02505852df4f028dce830e5ac52209ba48483b2f01';
const STELLAR_FORWARDER =
  '3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e';
const BASE_TOKEN_MESSENGER =
  '0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa';
const BASE_USDC =
  '000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e';
const BASE_KERNEL =
  '0000000000000000000000000123456789abcdef0123456789abcdef01234567';
const BASE_EXIT_SWEEPER =
  '0000000000000000000000005451a6dc234d07f3c80752e3c0e798913e53de6d';
const STELLAR_BRIDGE_AGENT =
  'abababababababababababababababababababababababababababababababab';

const AMOUNT_1_USDC_6DP =
  '00000000000000000000000000000000000000000000000000000000000f4240';
const AMOUNT_1234567 =
  '000000000000000000000000000000000000000000000000000000000012d687';
const FEE_1000 =
  '00000000000000000000000000000000000000000000000000000000000003e8';
const FEE_100 =
  '0000000000000000000000000000000000000000000000000000000000000064';
const EXPIRATION_0X12345678 =
  '0000000000000000000000000000000000000000000000000000000012345678';

const REVERSE_HOOK =
  '0000000000000000000000000000000000000000000000000000000000000038' +
  '4743584d5a434456595441414e42524153554757533547444b52475351574e4d35' +
  '58485642344a4937505845435a594b4247354f5454524b';

const FORWARD_MESSAGE = `0x${[
  '00000001',
  '0000001b',
  '00000006',
  NONCE_FORWARD,
  STELLAR_TOKEN_MESSENGER,
  BASE_TOKEN_MESSENGER,
  ZERO32,
  STANDARD_2000,
  STANDARD_2000,
  '00000001',
  STELLAR_USDC,
  BASE_KERNEL,
  AMOUNT_1_USDC_6DP,
  STELLAR_BRIDGE_AGENT,
  ZERO32,
  ZERO32,
  ZERO32,
].join('')}`;

const REVERSE_MESSAGE = `0x${[
  '00000001',
  '00000006',
  '0000001b',
  NONCE_REVERSE,
  BASE_TOKEN_MESSENGER,
  STELLAR_TOKEN_MESSENGER,
  STELLAR_FORWARDER,
  FAST_1000,
  STANDARD_2000,
  '00000001',
  BASE_USDC,
  STELLAR_FORWARDER,
  AMOUNT_1234567,
  BASE_EXIT_SWEEPER,
  FEE_1000,
  FEE_100,
  EXPIRATION_0X12345678,
  REVERSE_HOOK,
].join('')}`;

// Same-schema expectations as messageV2.test.mjs (canonical JSON-safe shape from
// task-8-test-design.md "One JSON-safe expectation schema").
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

const EXPECTED_FORWARD_PARSED = {
  headerVersion: 1n,
  sourceDomain: 27n,
  destinationDomain: 6n,
  nonce: `0x${NONCE_FORWARD}`,
  sender: `0x${STELLAR_TOKEN_MESSENGER}`,
  recipient: `0x${BASE_TOKEN_MESSENGER}`,
  destinationCaller: `0x${ZERO32}`,
  minFinalityThreshold: 2000n,
  finalityThresholdExecuted: 2000n,
  bodyVersion: 1n,
  burnToken: `0x${STELLAR_USDC}`,
  mintRecipient: `0x${BASE_KERNEL}`,
  amount: 1000000n,
  messageSender: `0x${STELLAR_BRIDGE_AGENT}`,
  maxFee: 0n,
  feeExecuted: 0n,
  expirationBlock: 0n,
  hookData: '0x',
};

const EXPECTED_REVERSE_PARSED = {
  headerVersion: 1n,
  sourceDomain: 6n,
  destinationDomain: 27n,
  nonce: `0x${NONCE_REVERSE}`,
  sender: `0x${BASE_TOKEN_MESSENGER}`,
  recipient: `0x${STELLAR_TOKEN_MESSENGER}`,
  destinationCaller: `0x${STELLAR_FORWARDER}`,
  minFinalityThreshold: 1000n,
  finalityThresholdExecuted: 2000n,
  bodyVersion: 1n,
  burnToken: `0x${BASE_USDC}`,
  mintRecipient: `0x${STELLAR_FORWARDER}`,
  amount: 1234567n,
  messageSender: `0x${BASE_EXIT_SWEEPER}`,
  maxFee: 1000n,
  feeExecuted: 100n,
  expirationBlock: 305419896n,
  hookData: `0x${REVERSE_HOOK}`,
};

// A well-formed forward message whose amount does not match the forward expectation.
const WRONG_AMOUNT_MESSAGE = (() => {
  const offset = 216; // literal byte offset of amount from the design's wire table
  const head = FORWARD_MESSAGE.slice(0, 2 + offset * 2);
  const tail = FORWARD_MESSAGE.slice(2 + (offset + AMOUNT_1234567.length / 2) * 2);
  return head + AMOUNT_1234567 + tail;
})();

// A second forward message matching the expectation, differing only in nonce (byte 12).
const FORWARD_MESSAGE_OTHER_NONCE = (() => {
  const offset = 12;
  const head = FORWARD_MESSAGE.slice(0, 2 + offset * 2);
  const tail = FORWARD_MESSAGE.slice(2 + (offset + NONCE_REVERSE.length / 2) * 2);
  return head + NONCE_REVERSE + tail;
})();

const TX_HASH = `0x${'ab'.repeat(32)}`;

// Iris decoded-field blocks used to prove decoded fields are never authority.
const DECODED_CLAIMS_MATCH = {
  sourceDomain: '27',
  destinationDomain: '6',
  nonce: `0x${NONCE_FORWARD}`,
  sender: `0x${STELLAR_TOKEN_MESSENGER}`,
  recipient: `0x${BASE_TOKEN_MESSENGER}`,
  destinationCaller: `0x${ZERO32}`,
  minFinalityThreshold: '2000',
  finalityThresholdExecuted: '2000',
  decodedMessageBody: {
    burnToken: `0x${STELLAR_USDC}`,
    mintRecipient: `0x${BASE_KERNEL}`,
    amount: '1000000',
    messageSender: `0x${STELLAR_BRIDGE_AGENT}`,
    maxFee: '0',
    feeExecuted: '0',
    expirationBlock: '0',
    hookData: '0x',
  },
};

const DECODED_CLAIMS_WRONG = {
  sourceDomain: '6',
  destinationDomain: '27',
  nonce: `0x${NONCE_REVERSE}`,
  sender: `0x${BASE_TOKEN_MESSENGER}`,
  recipient: `0x${STELLAR_TOKEN_MESSENGER}`,
  destinationCaller: `0x${STELLAR_FORWARDER}`,
  minFinalityThreshold: '1000',
  finalityThresholdExecuted: '1000',
  decodedMessageBody: {
    burnToken: `0x${BASE_USDC}`,
    mintRecipient: `0x${STELLAR_FORWARDER}`,
    amount: '999999',
    messageSender: `0x${BASE_EXIT_SWEEPER}`,
    maxFee: '1000',
    feeExecuted: '100',
    expirationBlock: '305419896',
    hookData: `0x${REVERSE_HOOK}`,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok = (body) => ({
  ok: true,
  status: 200,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const complete = (message, attestation, extra = {}) => ({ status: 'complete', message, attestation, ...extra });
const PENDING_CANDIDATE = { status: 'pending', attestation: 'PENDING' };

function pollArgs(overrides) {
  return {
    irisUrl: 'https://iris.example',
    sourceDomain: 27,
    txHash: TX_HASH,
    expectation: FORWARD_EXPECTATION,
    maxAttempts: 5,
    intervalMs: 0,
    ...overrides,
  };
}

// Resolves with the rejection reason so tests can pin machine-readable codes, not prose.
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected pollAttestation to reject, but it resolved');
}

beforeEach(() => {
  // Safety net: the injected fetchImpl seam is the ONLY permitted HTTP path. If the current
  // implementation ignores it and falls back to global fetch, this fails fast without network.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('global fetch used — pollAttestation must call the injected fetchImpl')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Raw-message authority and unique selection
// ---------------------------------------------------------------------------

describe('pollAttestation — raw-message authority', () => {
  it('selects the unique raw match among wrong complete candidates, not messages[0] (regression: first-element trust)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({
      messages: [
        complete(WRONG_AMOUNT_MESSAGE, '0xaaaa'),
        complete(FORWARD_MESSAGE, '0xbbbb'),
        complete(REVERSE_MESSAGE, '0xcccc'),
      ],
    }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    expect(result).toEqual({ message: FORWARD_MESSAGE, attestation: '0xbbbb', parsed: EXPECTED_FORWARD_PARSED });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`https://iris.example/v2/messages/27?transactionHash=${TX_HASH}`);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('ignores decoded fields claiming a match at index 0 when the raw bytes are wrong (decoded fields never authority)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({
      messages: [
        complete(WRONG_AMOUNT_MESSAGE, '0xaaaa', { decodedMessage: DECODED_CLAIMS_MATCH }),
        complete(FORWARD_MESSAGE, '0xbbbb'),
      ],
    }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    expect(result).toEqual({ message: FORWARD_MESSAGE, attestation: '0xbbbb', parsed: EXPECTED_FORWARD_PARSED });
  });

  it('still selects a raw matching candidate whose decoded fields are deliberately wrong (decoded fields never veto raw truth)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({
      messages: [complete(FORWARD_MESSAGE, '0xdddd', { decodedMessage: DECODED_CLAIMS_WRONG })],
    }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    expect(result).toEqual({ message: FORWARD_MESSAGE, attestation: '0xdddd', parsed: EXPECTED_FORWARD_PARSED });
  });

  it('returns { message, attestation, parsed } for the reverse leg with the exact domain-6 URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({
      messages: [complete(REVERSE_MESSAGE, '0xaaaa')],
    }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({
      fetchImpl, sleepFn, sourceDomain: 6, expectation: REVERSE_EXPECTATION,
    }));

    expect(result).toEqual({ message: REVERSE_MESSAGE, attestation: '0xaaaa', parsed: EXPECTED_REVERSE_PARSED });
    expect(fetchImpl).toHaveBeenCalledWith(`https://iris.example/v2/messages/6?transactionHash=${TX_HASH}`);
  });
});

// ---------------------------------------------------------------------------
// Terminal outcomes: ambiguity and mismatch (typed codes; one fetch, no sleep)
// ---------------------------------------------------------------------------

describe('pollAttestation — terminal ambiguity and mismatch', () => {
  it('throws CCTP_MESSAGE_AMBIGUOUS for two byte-identical matching raw messages with different attestations (catches first-match return)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({
      messages: [complete(FORWARD_MESSAGE, '0xaaaa'), complete(FORWARD_MESSAGE, '0xbbbb')],
    }));
    const sleepFn = vi.fn(async () => {});

    const err = await rejection(pollAttestation(pollArgs({ fetchImpl, sleepFn })));

    expect(err.code).toBe('CCTP_MESSAGE_AMBIGUOUS');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('throws CCTP_MESSAGE_AMBIGUOUS for two different raw messages both satisfying the expectation (only nonce differs)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({
      messages: [complete(FORWARD_MESSAGE, '0xaaaa'), complete(FORWARD_MESSAGE_OTHER_NONCE, '0xbbbb')],
    }));
    const sleepFn = vi.fn(async () => {});

    const err = await rejection(pollAttestation(pollArgs({ fetchImpl, sleepFn })));

    expect(err.code).toBe('CCTP_MESSAGE_AMBIGUOUS');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('throws CCTP_MESSAGE_MISMATCH immediately when every candidate is complete, non-pending, well-formed, and unrelated (catches polling past terminal wrong evidence)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({
      messages: [complete(WRONG_AMOUNT_MESSAGE, '0xaaaa'), complete(REVERSE_MESSAGE, '0xbbbb')],
    }));
    const sleepFn = vi.fn(async () => {});

    const err = await rejection(pollAttestation(pollArgs({ fetchImpl, sleepFn })));

    expect(err.code).toBe('CCTP_MESSAGE_MISMATCH');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('throws CCTP_MESSAGE_MISMATCH (not a transient timeout) for complete malformed raw messages with no pending candidate (malformed bytes are wrong evidence)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok({
      messages: [complete('0xdead', '0xaaaa'), complete('0xbeef', '0xbbbb')],
    }));
    const sleepFn = vi.fn(async () => {});

    const err = await rejection(pollAttestation(pollArgs({ fetchImpl, sleepFn })));

    expect(err.code).toBe('CCTP_MESSAGE_MISMATCH');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Retry classification: pending/transient outcomes keep polling within budget
// ---------------------------------------------------------------------------

describe('pollAttestation — retry classification', () => {
  it('waits past an unrelated complete plus a pending candidate, then returns the later match (a pending candidate blocks terminal mismatch)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ messages: [complete(REVERSE_MESSAGE, '0xaaaa'), PENDING_CANDIDATE] }))
      .mockResolvedValueOnce(ok({ messages: [complete(FORWARD_MESSAGE, '0xbbbb')] }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    expect(result).toEqual({ message: FORWARD_MESSAGE, attestation: '0xbbbb', parsed: EXPECTED_FORWARD_PARSED });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through pending-only candidates until a match completes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ messages: [PENDING_CANDIDATE] }))
      .mockResolvedValueOnce(ok({ messages: [PENDING_CANDIDATE, PENDING_CANDIDATE] }))
      .mockResolvedValueOnce(ok({ messages: [complete(FORWARD_MESSAGE, '0xbbbb')] }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    expect(result.message).toBe(FORWARD_MESSAGE);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('treats a complete-status candidate with literal PENDING attestation as not-ready and keeps polling', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ messages: [{ status: 'complete', message: FORWARD_MESSAGE, attestation: 'PENDING' }] }))
      .mockResolvedValueOnce(ok({ messages: [complete(FORWARD_MESSAGE, '0xbbbb')] }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    expect(result.attestation).toBe('0xbbbb');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through an empty messages array (empty can mean not indexed yet)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ messages: [] }))
      .mockResolvedValueOnce(ok({ messages: [complete(FORWARD_MESSAGE, '0xbbbb')] }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    expect(result.message).toBe(FORWARD_MESSAGE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps polling through non-JSON bodies, network throws, and truncated JSON before a match (transient HTTP stays retryable)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok('not json'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok('{"messages":['))
      .mockResolvedValueOnce(ok({ messages: [complete(FORWARD_MESSAGE, '0xbbbb')] }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    expect(result.message).toBe(FORWARD_MESSAGE);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleepFn).toHaveBeenCalledTimes(3);
  });

  it('throws typed CCTP_ATTESTATION_TIMEOUT (not mismatch) when pending forever exhausts maxAttempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ messages: [PENDING_CANDIDATE] }));
    const sleepFn = vi.fn(async () => {});

    const err = await rejection(pollAttestation(pollArgs({ fetchImpl, sleepFn, maxAttempts: 3 })));

    expect(err.code).toBe('CCTP_ATTESTATION_TIMEOUT');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Pending plus one complete match — FAIL-CLOSED decision (design "Pending plus
// one complete match — decision required"): keep polling while ANY candidate
// remains pending, unless two complete matches already prove terminal ambiguity.
// ---------------------------------------------------------------------------

describe('pollAttestation — pending plus one match (fail-closed)', () => {
  it('PINNED DECISION: one complete match plus a pending candidate does NOT return; it keeps polling until the response set settles', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ messages: [complete(FORWARD_MESSAGE, '0xbbbb'), PENDING_CANDIDATE] }))
      .mockResolvedValueOnce(ok({ messages: [complete(FORWARD_MESSAGE, '0xbbbb'), complete(REVERSE_MESSAGE, '0xaaaa')] }));
    const sleepFn = vi.fn(async () => {});

    const result = await pollAttestation(pollArgs({ fetchImpl, sleepFn }));

    // If the implementation returned the single match on attempt one, fetchImpl would show 1 call.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ message: FORWARD_MESSAGE, attestation: '0xbbbb', parsed: EXPECTED_FORWARD_PARSED });
  });

  it('a pending candidate that settles into a SECOND match surfaces CCTP_MESSAGE_AMBIGUOUS instead of returning the first match', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ messages: [complete(FORWARD_MESSAGE, '0xbbbb'), PENDING_CANDIDATE] }))
      .mockResolvedValueOnce(ok({
        messages: [complete(FORWARD_MESSAGE, '0xbbbb'), complete(FORWARD_MESSAGE_OTHER_NONCE, '0xcccc')],
      }));
    const sleepFn = vi.fn(async () => {});

    const err = await rejection(pollAttestation(pollArgs({ fetchImpl, sleepFn })));

    expect(err.code).toBe('CCTP_MESSAGE_AMBIGUOUS');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed expectation requirement (design mismatch #2: no permissive
// no-expectation path — that is the live authority bypass)
// ---------------------------------------------------------------------------

describe('pollAttestation — expectation required', () => {
  it('rejects without an expectation BEFORE any network I/O (regression: watcher calls Iris with no expectation today)', async () => {
    const fetchImpl = vi.fn();
    const sleepFn = vi.fn(async () => {});

    const err = await rejection(pollAttestation({
      irisUrl: 'https://iris.example',
      sourceDomain: 27,
      txHash: TX_HASH,
      fetchImpl,
      sleepFn,
      maxAttempts: 1,
      intervalMs: 0,
    }));

    expect(err.code).toBe('CCTP_EXPECTATION_REQUIRED');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
