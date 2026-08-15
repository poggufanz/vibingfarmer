// Strict raw CCTP v2 burn-message parser (`parseCctpV2Message`) and unique-burn matcher
// (`assertCctpV2BurnMatches`). The relayer only ever validates Circle-produced bytes, so this
// module is intentionally read-only: there is no message builder/serializer here.
//
// Wire layout (all big-endian, half-open byte ranges — CCTP v2 Message + BurnMessageV2 body):
//   [0,4)     header version (u32, must be 1)
//   [4,8)     source domain (u32)
//   [8,12)    destination domain (u32)
//   [12,44)   nonce (bytes32)
//   [44,76)   sender (bytes32)
//   [76,108)  recipient (bytes32)
//   [108,140) destination caller (bytes32)
//   [140,144) min finality threshold (u32)
//   [144,148) finality threshold executed (u32)
//   [148,152) burn-body version (u32, must be 1)
//   [152,184) burn token (bytes32)
//   [184,216) mint recipient (bytes32)
//   [216,248) amount (u256)
//   [248,280) message sender (bytes32)
//   [280,312) max fee (u256)
//   [312,344) fee executed (u256)
//   [344,376) expiration block (u256)
//   [376,end) hook data (exact remainder, may be empty)
//
// Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/task-7-test-design.md

import {
  CCTP_V2_WIRE_VERSION, FINALITY_FAST, FINALITY_STANDARD, SUPPORTED_EXECUTED_FINALITIES,
} from './constants.mjs';

const HEADER_VERSION = BigInt(CCTP_V2_WIRE_VERSION);
const BODY_VERSION = BigInt(CCTP_V2_WIRE_VERSION);
const FINALITY_STANDARD_BI = BigInt(FINALITY_STANDARD);
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const BURN_UNITS7_PER_MESSAGE_UNIT = 10n; // Stellar USDC 7dp -> message amount 6dp

// Literal byte offsets from the design's wire table. The fixed envelope is 148 bytes and the
// fixed burn body 228 bytes, so the minimum valid message is exactly 376 bytes.
const OFFSET = Object.freeze({
  headerVersion: 0,
  sourceDomain: 4,
  destinationDomain: 8,
  nonce: 12,
  sender: 44,
  recipient: 76,
  destinationCaller: 108,
  minFinalityThreshold: 140,
  finalityThresholdExecuted: 144,
  bodyVersion: 148,
  burnToken: 152,
  mintRecipient: 184,
  amount: 216,
  messageSender: 248,
  maxFee: 280,
  feeExecuted: 312,
  expirationBlock: 344,
  hookData: 376,
});
const MIN_MESSAGE_BYTES = OFFSET.hookData;

function cctpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const formatError = (detail) => cctpError(
  'CCTP_MESSAGE_FORMAT', `CCTP v2 message must be canonical 0x-prefixed even-length hex (${detail})`,
);

/**
 * Parses a raw CCTP v2 burn message into a flat frozen object. Every integer (including u32
 * fields) is an exact BigInt; every bytes value is lowercase 0x hex; hookData is the exact
 * remainder ('0x' when empty). Purely structural — route/finality/fee policy lives in
 * assertCctpV2BurnMatches. Throws err.code CCTP_MESSAGE_FORMAT / CCTP_MESSAGE_LENGTH /
 * CCTP_MESSAGE_VERSION.
 */
export function parseCctpV2Message(messageHex) {
  if (typeof messageHex !== 'string' || !messageHex.startsWith('0x')) {
    throw formatError('expected a 0x-prefixed hex string');
  }
  const hex = messageHex.slice(2);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw formatError('non-empty even-length hex digits only');
  }
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length < MIN_MESSAGE_BYTES) {
    throw cctpError('CCTP_MESSAGE_LENGTH', `CCTP v2 message is ${bytes.length} bytes; minimum is ${MIN_MESSAGE_BYTES}`);
  }

  const readU32BigInt = (offset) => BigInt(`0x${bytes.subarray(offset, offset + 4).toString('hex')}`);
  const readU256BigInt = (offset) => BigInt(`0x${bytes.subarray(offset, offset + 32).toString('hex')}`);
  const readBytes32 = (offset) => `0x${bytes.subarray(offset, offset + 32).toString('hex')}`;

  const headerVersion = readU32BigInt(OFFSET.headerVersion);
  if (headerVersion !== HEADER_VERSION) {
    throw cctpError('CCTP_MESSAGE_VERSION', `unsupported CCTP header version ${headerVersion}`);
  }
  const bodyVersion = readU32BigInt(OFFSET.bodyVersion);
  if (bodyVersion !== BODY_VERSION) {
    throw cctpError('CCTP_MESSAGE_VERSION', `unsupported CCTP burn-body version ${bodyVersion}`);
  }

  return Object.freeze({
    headerVersion,
    sourceDomain: readU32BigInt(OFFSET.sourceDomain),
    destinationDomain: readU32BigInt(OFFSET.destinationDomain),
    nonce: readBytes32(OFFSET.nonce),
    sender: readBytes32(OFFSET.sender),
    recipient: readBytes32(OFFSET.recipient),
    destinationCaller: readBytes32(OFFSET.destinationCaller),
    minFinalityThreshold: readU32BigInt(OFFSET.minFinalityThreshold),
    finalityThresholdExecuted: readU32BigInt(OFFSET.finalityThresholdExecuted),
    bodyVersion,
    burnToken: readBytes32(OFFSET.burnToken),
    mintRecipient: readBytes32(OFFSET.mintRecipient),
    amount: readU256BigInt(OFFSET.amount),
    messageSender: readBytes32(OFFSET.messageSender),
    maxFee: readU256BigInt(OFFSET.maxFee),
    feeExecuted: readU256BigInt(OFFSET.feeExecuted),
    expirationBlock: readU256BigInt(OFFSET.expirationBlock),
    hookData: `0x${bytes.subarray(OFFSET.hookData).toString('hex')}`,
  });
}

const mismatch = (field, detail) => cctpError(
  'CCTP_MESSAGE_MISMATCH', `CCTP v2 burn does not match the expectation (${field}: ${detail})`,
);

function assertField(field, ok, detail = 'value differs') {
  if (!ok) throw mismatch(field, detail);
}

// Expectations are JSON-safe: integers arrive as decimal strings (amounts/fees) or plain
// numbers (domains, finality). Convert defensively — an expectation field we cannot read can
// never authorize a mint, so it is a mismatch, never a crash or a pass.
function expectBigInt(value, field) {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw mismatch(field, 'expectation field must be a non-negative decimal integer');
}

/**
 * Verifies a raw CCTP v2 burn message against the immutable JSON-safe expectation. Parses once,
 * then compares every expected field exactly, plus protocol constraints (executed finality in
 * {1000, 2000} and >= min; feeExecuted <= maxFee) and direction invariants (forward:
 * Stellar->Base is zero-caller, standard-finality-only, zero-fee and derives the 6dp amount from
 * burnUnits7 with an exact divisibility guard; reverse: burnUnits7 must be null and the amount
 * is compared directly). Nonce and expirationBlock are parsed but NOT compared — they are not
 * knowable pre-attestation. Any deviation throws err.code CCTP_MESSAGE_MISMATCH. Returns the
 * parsed message on success.
 */
export function assertCctpV2BurnMatches(messageHex, expectation) {
  const parsed = parseCctpV2Message(messageHex);
  if (!expectation || typeof expectation !== 'object') {
    throw mismatch('expectation', 'an immutable expectation object is required');
  }
  assertField('version', expectation.version === 1, 'unsupported expectation schema version');
  assertField('sourceDomain', parsed.sourceDomain === expectBigInt(expectation.sourceDomain, 'sourceDomain'));
  assertField('destinationDomain', parsed.destinationDomain === expectBigInt(expectation.destinationDomain, 'destinationDomain'));
  for (const field of ['sender', 'recipient', 'destinationCaller', 'burnToken', 'mintRecipient', 'messageSender', 'hookData']) {
    assertField(field, typeof expectation[field] === 'string' && parsed[field] === expectation[field]);
  }
  assertField(
    'minFinalityThreshold',
    parsed.minFinalityThreshold === expectBigInt(expectation.minFinalityThreshold, 'minFinalityThreshold'),
  );

  // Protocol constraints on attester-chosen values (never exactly preselected).
  assertField(
    'finalityThresholdExecuted',
    SUPPORTED_EXECUTED_FINALITIES.includes(parsed.finalityThresholdExecuted),
    `executed finality must be ${FINALITY_FAST} (fast) or ${FINALITY_STANDARD} (standard)`,
  );
  assertField(
    'finalityThresholdExecuted',
    parsed.finalityThresholdExecuted >= parsed.minFinalityThreshold,
    'executed finality below the minimum threshold',
  );
  assertField('maxFee', parsed.maxFee === expectBigInt(expectation.maxFee, 'maxFee'));
  assertField('feeExecuted', parsed.feeExecuted <= parsed.maxFee, 'fee executed exceeds max fee');

  if (expectation.direction === 'stellar-to-base') {
    // Forward leg policy: no destination caller, standard finality only, zero fees — these hold
    // even if the expectation itself tries to loosen them.
    assertField('destinationCaller', parsed.destinationCaller === ZERO_BYTES32, 'forward burns never set a destination caller');
    assertField('minFinalityThreshold', parsed.minFinalityThreshold === FINALITY_STANDARD_BI, 'forward burns are standard-finality only');
    assertField('maxFee', parsed.maxFee === 0n, 'forward burns are zero-fee only');
    assertField('feeExecuted', parsed.feeExecuted === 0n, 'forward burns are zero-fee only');
    const burnUnits7 = expectBigInt(expectation.burnUnits7, 'burnUnits7');
    assertField('burnUnits7', burnUnits7 % BURN_UNITS7_PER_MESSAGE_UNIT === 0n, '7dp burn units must divide exactly into 6dp message units');
    assertField('amount', parsed.amount === burnUnits7 / BURN_UNITS7_PER_MESSAGE_UNIT);
  } else if (expectation.direction === 'base-to-stellar') {
    assertField('burnUnits7', expectation.burnUnits7 === null, 'reverse expectations carry the 6dp amount, not burnUnits7');
    assertField('amount', parsed.amount === expectBigInt(expectation.amount, 'amount'));
  } else {
    throw mismatch('direction', 'unknown expectation direction');
  }

  return parsed;
}
