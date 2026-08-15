// Task 7 RED — strict raw CCTP v2 parser (`parseCctpV2Message`) and unique burn matcher
// (`assertCctpV2BurnMatches`) for relayer/src/cctp/messageV2.mjs (module does not exist yet).
// Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/task-7-test-design.md
//
// Fixture rules (per design): messages are hand-authored exact-width field hex joined in wire
// order; mutations use replaceBytes(message, byteOffset, literalReplacement) with independently
// written literal offsets from the design's wire table. NOTHING is imported from production,
// expected values are never computed with the module under test, and no expectation calls
// Number(...) — all parsed integers are exact BigInt literals.

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Shared literal fields (literal values, not produced by the module under test)
// ---------------------------------------------------------------------------

const FAST_1000 = '000003e8';
const STANDARD_2000 = '000007d0';
const UNSUPPORTED_1500 = '000005dc';
const BELOW_FAST_500 = '000001f4';

const ZERO32 = '0000000000000000000000000000000000000000000000000000000000000000';
const NONCE_FORWARD = '1111111111111111111111111111111111111111111111111111111111111111';
const NONCE_REVERSE = '9999999999999999999999999999999999999999999999999999999999999999';

// Literal raw bytes decoded once from the tracked Stellar deployment StrKeys.
const STELLAR_TOKEN_MESSENGER =
  'da6f9ee0786c812344d82817ef19b648b4af120f8bd10bf658e6b99eacff24b8';
const STELLAR_USDC =
  '5045cd5ec0729a768fd5ad02505852df4f028dce830e5ac52209ba48483b2f01';
const STELLAR_FORWARDER =
  '3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e';

// EVM addresses are literal 12-byte-left-padded words.
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
const FEE_1001 =
  '00000000000000000000000000000000000000000000000000000000000003e9';
const FEE_100 =
  '0000000000000000000000000000000000000000000000000000000000000064';
const FEE_1 =
  '0000000000000000000000000000000000000000000000000000000000000001';
const EXPIRATION_0X12345678 =
  '0000000000000000000000000000000000000000000000000000000012345678';

// Independently hand-derived precision literals (design "Precision fixture").
const AMOUNT_OVER_SAFE_INTEGER =
  '0000000000000000000000000000000000000000000000000020000000000001'; // 2^53 + 1
const MAX_FEE_OVER_U64 =
  '0000000000000000000000000000000000000000000000010000000000000005'; // 2^64 + 5
const FEE_OVER_U64 =
  '0000000000000000000000000000000000000000000000010000000000000004'; // 2^64 + 4
const EXPIRATION_OVER_U96 =
  '0000000000000000000000000000000000000001000000000000000000000003'; // 2^96 + 3

// 88-byte Stellar-forwarder hook: 32-byte word ending in u32 length 56, then 56 literal ASCII
// bytes for GCXMZCDVYTAANBRASUGWS5GDKRGSQWNM5XHVB4JI7PXECZYKBG5OTTRK.
const REVERSE_HOOK =
  '0000000000000000000000000000000000000000000000000000000000000038' +
  '4743584d5a434456595441414e42524153554757533547444b52475351574e4d35' +
  '58485642344a4937505845435a594b4247354f5454524b';

// ---------------------------------------------------------------------------
// Exact fixtures (design "Exact forward fixture" / "Exact reverse fixture")
// ---------------------------------------------------------------------------

const FORWARD_MESSAGE = `0x${[
  '00000001', // header version 1
  '0000001b', // source 27
  '00000006', // destination 6
  NONCE_FORWARD,
  STELLAR_TOKEN_MESSENGER,
  BASE_TOKEN_MESSENGER,
  ZERO32, // destination caller
  STANDARD_2000, // min finality 2000
  STANDARD_2000, // executed 2000
  '00000001', // body version 1
  STELLAR_USDC,
  BASE_KERNEL,
  AMOUNT_1_USDC_6DP,
  STELLAR_BRIDGE_AGENT,
  ZERO32, // max fee
  ZERO32, // fee executed
  ZERO32, // expiration block
].join('')}`;

const REVERSE_MESSAGE = `0x${[
  '00000001', // header version 1
  '00000006', // source 6
  '0000001b', // destination 27
  NONCE_REVERSE,
  BASE_TOKEN_MESSENGER,
  STELLAR_TOKEN_MESSENGER,
  STELLAR_FORWARDER, // destination caller
  FAST_1000, // min finality 1000
  STANDARD_2000, // executed 2000 is allowed for a fast request
  '00000001', // body version 1
  BASE_USDC,
  STELLAR_FORWARDER, // mint recipient
  AMOUNT_1234567,
  BASE_EXIT_SWEEPER,
  FEE_1000,
  FEE_100,
  EXPIRATION_0X12345678,
  REVERSE_HOOK,
].join('')}`;

// ---------------------------------------------------------------------------
// Expected parsed shapes (flat; BigInt for every integer; lowercase 0x bytes)
// ---------------------------------------------------------------------------

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
  expirationBlock: 305419896n, // 0x12345678, written as decimal to avoid Number()
  hookData: `0x${REVERSE_HOOK}`,
};

// ---------------------------------------------------------------------------
// Expectations — the canonical JSON-safe schema from task-8-test-design.md
// ("One JSON-safe expectation schema"). The matcher converts decimal strings
// to BigInt internally; Task 8 must not maintain a sibling normalizer.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Mutates a message at a BYTE offset (independently written literals from the design's wire
// table) with a literal hex replacement of the same field width. Never import parser offsets.
function replaceBytes(message, offset, literalReplacement) {
  const head = message.slice(0, 2 + offset * 2);
  const tail = message.slice(2 + (offset + literalReplacement.length / 2) * 2);
  return head + literalReplacement + tail;
}

// Dynamic import so collection succeeds while the module is absent; each failing test then
// fails for the intended RED reason (module relayer/src/cctp/messageV2.mjs does not exist yet).
async function loadModule() {
  return import('../../src/cctp/messageV2.mjs');
}

// Returns the thrown error's machine-readable code, or undefined when nothing was thrown, so
// assertions pin stable codes (never prose).
function thrownCode(fn) {
  try {
    fn();
  } catch (err) {
    return err && err.code;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fixture self-check (passes pre-implementation; guards against fixture typos)
// ---------------------------------------------------------------------------

describe('CCTP v2 literal fixtures (self-check)', () => {
  it('forward is exactly 376 bytes and reverse exactly 464 bytes (0x + hex chars)', () => {
    expect(FORWARD_MESSAGE.length).toBe(754);
    expect(REVERSE_MESSAGE.length).toBe(930);
    expect(FORWARD_MESSAGE).toMatch(/^0x[0-9a-f]+$/);
    expect(REVERSE_MESSAGE).toMatch(/^0x[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// Structural parser cases (design "Structural parser cases" table)
// ---------------------------------------------------------------------------

describe('parseCctpV2Message — structural', () => {
  it('parses the exact forward message into the full flat object (catches wrong offsets/endianness)', async () => {
    const { parseCctpV2Message } = await loadModule();
    expect(parseCctpV2Message(FORWARD_MESSAGE)).toEqual(EXPECTED_FORWARD_PARSED);
  });

  it('parses the exact reverse message including the 88-byte hook (catches fixed-length truncation)', async () => {
    const { parseCctpV2Message } = await loadModule();
    expect(parseCctpV2Message(REVERSE_MESSAGE)).toEqual(EXPECTED_REVERSE_PARSED);
  });

  it('accepts uppercase hex digits and normalizes parsed bytes to lowercase (catches case-sensitive decoder)', async () => {
    const { parseCctpV2Message } = await loadModule();
    const upper = `0x${FORWARD_MESSAGE.slice(2).toUpperCase()}`;
    expect(parseCctpV2Message(upper)).toEqual(EXPECTED_FORWARD_PARSED);
  });

  it.each([
    ['null', null],
    ['a Buffer', Buffer.from(FORWARD_MESSAGE.slice(2), 'hex')],
    ['a plain object', { hex: FORWARD_MESSAGE }],
  ])('rejects wrong input type (%s) with CCTP_MESSAGE_FORMAT (catches implicit string coercion)', async (_name, input) => {
    const { parseCctpV2Message } = await loadModule();
    expect(thrownCode(() => parseCctpV2Message(input))).toBe('CCTP_MESSAGE_FORMAT');
  });

  it('rejects a missing 0x prefix with CCTP_MESSAGE_FORMAT (catches accepting noncanonical input)', async () => {
    const { parseCctpV2Message } = await loadModule();
    expect(thrownCode(() => parseCctpV2Message(FORWARD_MESSAGE.slice(2)))).toBe('CCTP_MESSAGE_FORMAT');
  });

  it("rejects the empty message '0x' with CCTP_MESSAGE_FORMAT (catches empty decode)", async () => {
    const { parseCctpV2Message } = await loadModule();
    expect(thrownCode(() => parseCctpV2Message('0x'))).toBe('CCTP_MESSAGE_FORMAT');
  });

  it('rejects an odd nibble count with CCTP_MESSAGE_FORMAT (catches silent nibble truncation)', async () => {
    const { parseCctpV2Message } = await loadModule();
    expect(thrownCode(() => parseCctpV2Message(FORWARD_MESSAGE.slice(0, -1)))).toBe('CCTP_MESSAGE_FORMAT');
  });

  it("rejects a non-hex byte 'gg' with CCTP_MESSAGE_FORMAT (catches Buffer.from permissiveness)", async () => {
    const { parseCctpV2Message } = await loadModule();
    expect(thrownCode(() => parseCctpV2Message(replaceBytes(FORWARD_MESSAGE, 100, 'gg')))).toBe('CCTP_MESSAGE_FORMAT');
  });

  it('rejects a 375-byte message with CCTP_MESSAGE_LENGTH (catches out-of-bounds/default-zero parse)', async () => {
    const { parseCctpV2Message } = await loadModule();
    expect(thrownCode(() => parseCctpV2Message(FORWARD_MESSAGE.slice(0, -2)))).toBe('CCTP_MESSAGE_LENGTH');
  });

  it.each([
    ['header version 0', '00000000'],
    ['header version 2', '00000002'],
  ])('rejects %s with CCTP_MESSAGE_VERSION (catches accepting another envelope)', async (_name, versionWord) => {
    const { parseCctpV2Message } = await loadModule();
    expect(thrownCode(() => parseCctpV2Message(replaceBytes(FORWARD_MESSAGE, 0, versionWord)))).toBe('CCTP_MESSAGE_VERSION');
  });

  it.each([
    ['burn-body version 0', '00000000'],
    ['burn-body version 2', '00000002'],
  ])('rejects %s with CCTP_MESSAGE_VERSION (catches accepting another burn body)', async (_name, versionWord) => {
    const { parseCctpV2Message } = await loadModule();
    expect(thrownCode(() => parseCctpV2Message(replaceBytes(FORWARD_MESSAGE, 148, versionWord)))).toBe('CCTP_MESSAGE_VERSION');
  });

  it('parses the four u256 words above JS safe-integer/u64/u96 ranges as exact BigInts (catches precision loss)', async () => {
    const { parseCctpV2Message } = await loadModule();
    const mutated = replaceBytes(
      replaceBytes(
        replaceBytes(
          replaceBytes(FORWARD_MESSAGE, 216, AMOUNT_OVER_SAFE_INTEGER),
          280, MAX_FEE_OVER_U64,
        ),
        312, FEE_OVER_U64,
      ),
      344, EXPIRATION_OVER_U96,
    );
    const parsed = parseCctpV2Message(mutated);
    expect(parsed.amount).toBe(9007199254740993n);
    expect(parsed.maxFee).toBe(18446744073709551621n);
    expect(parsed.feeExecuted).toBe(18446744073709551620n);
    expect(parsed.expirationBlock).toBe(79228162514264337593543950339n);
  });
});

// ---------------------------------------------------------------------------
// Matcher accept rows (design "Matcher cases" — valid and protocol-allowed rows)
// ---------------------------------------------------------------------------

describe('assertCctpV2BurnMatches — accept rows', () => {
  it('accepts the forward message against the forward expectation (baseline unique match)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    expect(() => assertCctpV2BurnMatches(FORWARD_MESSAGE, FORWARD_EXPECTATION)).not.toThrow();
  });

  it('accepts the reverse message with executed finality 2000 (design: both 1000 and 2000 valid)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    expect(() => assertCctpV2BurnMatches(REVERSE_MESSAGE, REVERSE_EXPECTATION)).not.toThrow();
  });

  it('accepts the reverse message with executed finality 1000 (design: reverse executed 1000 -> accept)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(REVERSE_MESSAGE, 144, FAST_1000);
    expect(() => assertCctpV2BurnMatches(msg, REVERSE_EXPECTATION)).not.toThrow();
  });

  it('accepts the reverse message with fee executed exactly equal to max fee (protocol boundary)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(REVERSE_MESSAGE, 312, FEE_1000);
    expect(() => assertCctpV2BurnMatches(msg, REVERSE_EXPECTATION)).not.toThrow();
  });

  it('accepts a mutated nonce (catches over-strict matcher: nonce is not known pre-attestation; Task 8 persists it)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(FORWARD_MESSAGE, 12, NONCE_REVERSE);
    expect(() => assertCctpV2BurnMatches(msg, FORWARD_EXPECTATION)).not.toThrow();
  });

  it('accepts a mutated expiration block (catches over-strict matcher: expiration is parsed/retained, not compared)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(FORWARD_MESSAGE, 344, EXPIRATION_0X12345678);
    expect(() => assertCctpV2BurnMatches(msg, FORWARD_EXPECTATION)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Matcher one-field mismatch rows (design table; every row must throw a stable
// CCTP_MESSAGE_MISMATCH code, never prose)
// ---------------------------------------------------------------------------

describe('assertCctpV2BurnMatches — one-field mismatch rows', () => {
  const FORWARD_FIELD_MUTATIONS = [
    ['source domain (byte 4)', 4, '00000006'],
    ['destination domain (byte 8)', 8, '0000001b'],
    ['header sender (byte 44)', 44, BASE_KERNEL],
    ['header recipient (byte 76)', 76, BASE_KERNEL],
    ['destination caller (byte 108)', 108, BASE_KERNEL],
    ['burn token (byte 152)', 152, ZERO32],
    ['mint recipient (byte 184)', 184, BASE_EXIT_SWEEPER],
    ['amount (byte 216)', 216, AMOUNT_1234567],
    ['message sender (byte 248)', 248, BASE_KERNEL],
    ['max fee (byte 280)', 280, FEE_100],
    ['minimum finality threshold (byte 140)', 140, FAST_1000],
  ];

  it.each(FORWARD_FIELD_MUTATIONS)(
    'forward %s mutated -> CCTP_MESSAGE_MISMATCH (catches dropped field comparison)',
    async (_name, offset, replacement) => {
      const { assertCctpV2BurnMatches } = await loadModule();
      const msg = replaceBytes(FORWARD_MESSAGE, offset, replacement);
      expect(thrownCode(() => assertCctpV2BurnMatches(msg, FORWARD_EXPECTATION))).toBe('CCTP_MESSAGE_MISMATCH');
    },
  );

  it('forward hook byte appended at byte 376 -> CCTP_MESSAGE_MISMATCH (catches hook comparison skipped when expectation hook is 0x)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    expect(thrownCode(() => assertCctpV2BurnMatches(`${FORWARD_MESSAGE}aa`, FORWARD_EXPECTATION))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  const REVERSE_FIELD_MUTATIONS = [
    ['source domain (byte 4)', 4, '0000001b'],
    ['destination domain (byte 8)', 8, '00000006'],
    ['header sender (byte 44)', 44, BASE_KERNEL],
    ['header recipient (byte 76)', 76, STELLAR_USDC],
    ['destination caller (byte 108)', 108, STELLAR_TOKEN_MESSENGER],
    ['burn token (byte 152)', 152, ZERO32],
    ['mint recipient (byte 184)', 184, STELLAR_TOKEN_MESSENGER],
    ['amount (byte 216)', 216, AMOUNT_1_USDC_6DP],
    ['message sender (byte 248)', 248, BASE_TOKEN_MESSENGER],
    ['max fee (byte 280)', 280, FEE_100],
    ['minimum finality threshold (byte 140)', 140, STANDARD_2000],
  ];

  it.each(REVERSE_FIELD_MUTATIONS)(
    'reverse %s mutated -> CCTP_MESSAGE_MISMATCH (catches dropped field comparison)',
    async (_name, offset, replacement) => {
      const { assertCctpV2BurnMatches } = await loadModule();
      const msg = replaceBytes(REVERSE_MESSAGE, offset, replacement);
      expect(thrownCode(() => assertCctpV2BurnMatches(msg, REVERSE_EXPECTATION))).toBe('CCTP_MESSAGE_MISMATCH');
    },
  );

  it('reverse hook byte changed at byte 463 -> CCTP_MESSAGE_MISMATCH (catches hook bytes not compared)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(REVERSE_MESSAGE, 463, '00');
    expect(thrownCode(() => assertCctpV2BurnMatches(msg, REVERSE_EXPECTATION))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  it('reverse hook byte removed -> CCTP_MESSAGE_MISMATCH (catches prefix-only hook comparison)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = REVERSE_MESSAGE.slice(0, -2);
    expect(thrownCode(() => assertCctpV2BurnMatches(msg, REVERSE_EXPECTATION))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  it.each([
    ['forward', FORWARD_MESSAGE, FORWARD_EXPECTATION, FEE_1],
    ['reverse', REVERSE_MESSAGE, REVERSE_EXPECTATION, FEE_1001],
  ])('%s feeExecuted = maxFee + 1 -> CCTP_MESSAGE_MISMATCH (protocol constraint, even when other fields match)', async (_name, base, expectation, feeWord) => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(base, 312, feeWord);
    expect(thrownCode(() => assertCctpV2BurnMatches(msg, expectation))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  it.each([
    ['forward', FORWARD_MESSAGE, FORWARD_EXPECTATION],
    ['reverse', REVERSE_MESSAGE, REVERSE_EXPECTATION],
  ])('%s executed finality 1500 -> CCTP_MESSAGE_MISMATCH (unsupported-finality: only 1000/2000 exist)', async (_name, base, expectation) => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(base, 144, UNSUPPORTED_1500);
    expect(thrownCode(() => assertCctpV2BurnMatches(msg, expectation))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  it.each([
    ['forward (min 2000, executed 1000)', FORWARD_MESSAGE, FORWARD_EXPECTATION, FAST_1000],
    ['reverse (min 1000, executed 500)', REVERSE_MESSAGE, REVERSE_EXPECTATION, BELOW_FAST_500],
  ])('%s executed finality below minimum -> CCTP_MESSAGE_MISMATCH (catches missing executed>=min check)', async (_name, base, expectation, executedWord) => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(base, 144, executedWord);
    expect(thrownCode(() => assertCctpV2BurnMatches(msg, expectation))).toBe('CCTP_MESSAGE_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// Direction invariants and burnUnits7 guard (design rows: forward-only rejects,
// forward divisibility/exactness guard)
// ---------------------------------------------------------------------------

describe('assertCctpV2BurnMatches — direction invariants and burnUnits7 guard', () => {
  it('forward rejects a nonzero destination caller even if the expectation tries to allow it (direction policy, not field equality)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(FORWARD_MESSAGE, 108, BASE_KERNEL);
    const expectation = { ...FORWARD_EXPECTATION, destinationCaller: `0x${BASE_KERNEL}` };
    expect(thrownCode(() => assertCctpV2BurnMatches(msg, expectation))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  it('forward rejects fast min/executed 1000 even if the expectation asks for it (forward is standard-finality only)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(replaceBytes(FORWARD_MESSAGE, 140, FAST_1000), 144, FAST_1000);
    const expectation = { ...FORWARD_EXPECTATION, minFinalityThreshold: 1000 };
    expect(thrownCode(() => assertCctpV2BurnMatches(msg, expectation))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  it('forward rejects a nonzero max fee even if the expectation carries it (forward is zero-fee only)', async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const msg = replaceBytes(FORWARD_MESSAGE, 280, FEE_100);
    const expectation = { ...FORWARD_EXPECTATION, maxFee: '100' };
    expect(thrownCode(() => assertCctpV2BurnMatches(msg, expectation))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  it("forward rejects burnUnits7 '10000001' before amount comparison (catches divide/truncate: 10000001/10 would truncate to the message amount)", async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const expectation = { ...FORWARD_EXPECTATION, burnUnits7: '10000001' };
    expect(thrownCode(() => assertCctpV2BurnMatches(FORWARD_MESSAGE, expectation))).toBe('CCTP_MESSAGE_MISMATCH');
  });

  it("forward rejects burnUnits7 '10000010' against message amount 1000000 (exact mismatch: derived 1000001 != 1000000)", async () => {
    const { assertCctpV2BurnMatches } = await loadModule();
    const expectation = { ...FORWARD_EXPECTATION, burnUnits7: '10000010', amount: '1000001' };
    expect(thrownCode(() => assertCctpV2BurnMatches(FORWARD_MESSAGE, expectation))).toBe('CCTP_MESSAGE_MISMATCH');
  });
});
