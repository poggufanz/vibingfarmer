// Polls Circle's Iris attestation API (V2) until a burn's message+attestation are ready.
//
// Task 7 hardening: raw-message authority. Iris decoded fields are NEVER used for selection and
// never exposed — every complete candidate's raw `message` bytes are validated against the
// immutable expectation with the real strict matcher (messageV2.mjs), and ALL matches are
// collected: exactly one complete raw match returns, two or more are terminal ambiguity, an
// all-complete response with zero matches is terminal mismatch, and any pending candidate keeps
// the poll open (fail-closed uniqueness). Only not-ready/transient outcomes retry; typed
// terminal mismatch/ambiguity errors are never swallowed.

import { assertCctpV2BurnMatches } from './messageV2.mjs';

// Standard finality (minFinalityThreshold >= 2000) attestation on testnet can take ~13-19 min,
// so the default poll window must cover it: 300 x 5s = 25 min. Callers can override for Fast finality.
const DEFAULT_MAX_ATTEMPTS = 300;
const DEFAULT_INTERVAL_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cctpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// A candidate is complete only with a terminal status, a real attestation, and raw message
// bytes present. Anything else (pending status, literal 'PENDING' attestation, missing fields,
// unknown shapes) is potentially pending — fail closed and keep polling.
function isCompleteCandidate(candidate) {
  return Boolean(candidate)
    && candidate.status === 'complete'
    && Boolean(candidate.attestation) && candidate.attestation !== 'PENDING'
    && typeof candidate.message === 'string' && candidate.message.length > 0;
}

// Pure per-response selector. Returns { kind: 'match', match } or { kind: 'not-ready' };
// throws CCTP_MESSAGE_AMBIGUOUS / CCTP_MESSAGE_MISMATCH for terminal wrong evidence.
function selectUniqueMatch(candidates, expectation) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { kind: 'not-ready' };
  const matches = [];
  let hasPending = false;
  for (const candidate of candidates) {
    if (!isCompleteCandidate(candidate)) {
      hasPending = true;
      continue;
    }
    try {
      const parsed = assertCctpV2BurnMatches(candidate.message, expectation);
      matches.push({ message: candidate.message, attestation: candidate.attestation, parsed });
    } catch {
      // Complete-but-wrong evidence (malformed bytes or field mismatch) is never authority; it
      // only becomes terminal once no potentially pending candidate remains.
    }
  }
  if (matches.length > 1) {
    throw cctpError('CCTP_MESSAGE_AMBIGUOUS', `Iris returned ${matches.length} complete messages matching the expectation`);
  }
  if (hasPending) return { kind: 'not-ready' };
  if (matches.length === 1) return { kind: 'match', match: matches[0] };
  throw cctpError('CCTP_MESSAGE_MISMATCH', 'every Iris message is complete and none matches the expectation');
}

/**
 * Polls GET {irisUrl}/v2/messages/{sourceDomain}?transactionHash={txHash} until exactly one
 * complete candidate's raw message matches the immutable expectation. Requires `expectation`
 * (throws CCTP_EXPECTATION_REQUIRED before any network I/O without one). Resilient to non-JSON
 * bodies and transient fetch errors (keeps polling instead of throwing). Resolves with exactly
 * { message, attestation, parsed } — the raw message string, its own attestation, and the real
 * parsed object. Throws typed CCTP_MESSAGE_MISMATCH / CCTP_MESSAGE_AMBIGUOUS (terminal) or
 * CCTP_ATTESTATION_TIMEOUT (poll budget exhausted).
 */
export async function pollAttestation({
  irisUrl, sourceDomain, txHash, expectation,
  fetchImpl = fetch, sleepFn = sleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS, intervalMs = DEFAULT_INTERVAL_MS,
}) {
  if (expectation === undefined || expectation === null) {
    throw cctpError('CCTP_EXPECTATION_REQUIRED', 'pollAttestation requires an immutable burn expectation');
  }
  const url = `${irisUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let body = null;
    try {
      const res = await fetchImpl(url);
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      // transient network/HTTP error or non-JSON body — keep polling until maxAttempts
    }
    const selection = selectUniqueMatch(body?.messages, expectation);
    if (selection.kind === 'match') return selection.match;
    if (attempt + 1 < maxAttempts) await sleepFn(intervalMs);
  }
  throw cctpError(
    'CCTP_ATTESTATION_TIMEOUT',
    `pollAttestation: attestation not complete in time for ${txHash} (domain ${sourceDomain})`,
  );
}
