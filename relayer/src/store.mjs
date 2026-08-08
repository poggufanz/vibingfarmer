// Checkpointed CCTP relay-work store (Task 8). One behavioral CAS contract with two local
// backends (memory + file) — the SQLite implementation lives in sqliteStores.mjs (`cctpRelays`)
// and reuses the validation/transition helpers exported here so all three behave identically.
//
// Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/task-8-test-design.md
//   "Store contract and record shape", "CAS rules", "State transitions",
//   "Lease-expiry reconciliation", "Store RED matrix", legacy-record policy.
//
// There is NO generic set/has/all mutation path: every state change is a compare-and-transition
// guarded by (execId, expected source state, lease token, unexpired lease) inside one synchronous
// critical section (memory) or one load->mutate->atomic-rename cycle (file).
//
// File-store durability: each mutation writes a COMPLETE temporary sibling, fsyncs and closes
// it, then atomically renames it over the live file. That is crash-safe single-process local
// durability ONLY — it is not multi-process mutual exclusion (task-8 plan mismatch #11). Two
// store instances in one process observe each other's latest state because every operation
// reloads from disk inside its critical section. Production and configured durable development
// use the SQLite store (cctpRelays) instead.
//
// Legacy policy (fail closed): pre-Task-8 `{status:'pending'/'minted'}` rows carry no immutable
// expectation and no strict confirmation evidence, so they can never be re-driven or trusted as
// minted. The file store converts them ONCE at open to durable terminal
// `blocked`/`legacy_record_unrecoverable` records (mint hashes dropped) and persists the
// conversion — never silently upgrading them into a safe state.

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// States, reason codes, and typed errors
// ---------------------------------------------------------------------------

export const RELAY_CLAIMABLE_STATES = Object.freeze([
  'attestation_pending', 'attested', 'mint_submitted',
]);
export const RELAY_TERMINAL_STATES = Object.freeze(['minted', 'blocked', 'uncertain']);
export const RELAY_ALL_STATES = Object.freeze([
  'attestation_pending', 'attested', 'mint_submitting', 'mint_submitted',
  ...RELAY_TERMINAL_STATES,
]);

export const RELAY_BLOCKED_REASONS = Object.freeze([
  'message_mismatch', 'message_ambiguous', 'attested_evidence_changed',
  'destination_reverted', 'legacy_record_unrecoverable',
]);
export const RELAY_UNCERTAIN_REASONS = Object.freeze([
  'submission_unknown', 'submitted_checkpoint_failed', 'submission_lease_expired',
]);

export function relayError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const validationError = (detail) => relayError('RELAY_VALIDATION', `relay intent is invalid (${detail})`);
const casConflict = (detail) => relayError('RELAY_CAS_CONFLICT', `relay transition conflicts with the durable record (${detail})`);

// ---------------------------------------------------------------------------
// Canonical expectation schema + digest (task-8 "One JSON-safe expectation schema")
// ---------------------------------------------------------------------------

const EXPECTATION_KEY_ORDER = Object.freeze([
  'version', 'direction', 'sourceDomain', 'destinationDomain', 'sender', 'recipient',
  'destinationCaller', 'burnToken', 'mintRecipient', 'messageSender', 'amount',
  'burnUnits7', 'maxFee', 'minFinalityThreshold', 'hookData',
]);
const EXPECTATION_DIGEST_DOMAIN = 'vf-cctp-expectation-v1';

const STELLAR_DOMAIN = 27;
const BASE_DOMAIN = 6;
const DIRECTION_DOMAINS = Object.freeze({
  'stellar-to-base': Object.freeze({ sourceDomain: STELLAR_DOMAIN, destinationDomain: BASE_DOMAIN }),
  'base-to-stellar': Object.freeze({ sourceDomain: BASE_DOMAIN, destinationDomain: STELLAR_DOMAIN }),
});

const HEX64_CI_RE = /^[0-9a-fA-F]{64}$/;
const BYTES32_STRICT_RE = /^0x[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const EVEN_HEX_RE = /^0x([0-9a-fA-F]{2})+$/;
const HOOK_DATA_RE = /^0x([0-9a-f]{2})*$/;

function expectDecimalString(value, field) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw validationError(`expectation.${field} must be a canonical unsigned base-10 string`);
  }
  return value;
}

/**
 * Validates an immutable CCTP burn expectation against the single JSON-safe schema and returns
 * the canonical object (fixed key order, exact key set, strict lowercase bytes32 identities,
 * canonical decimal strings, direction-consistent domains and burnUnits7/amount relation).
 * Throws RELAY_VALIDATION on any deviation — a malformed expectation never reaches the queue.
 */
export function canonicalizeExpectation(expectation) {
  if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) {
    throw validationError('expectation object is required');
  }
  const keys = Object.keys(expectation);
  if (keys.length !== EXPECTATION_KEY_ORDER.length
    || !EXPECTATION_KEY_ORDER.every((key) => Object.prototype.hasOwnProperty.call(expectation, key))) {
    throw validationError('expectation must carry exactly the canonical key set');
  }
  if (expectation.version !== 1) throw validationError('expectation.version must be 1');
  const domains = DIRECTION_DOMAINS[expectation.direction];
  if (!domains) throw validationError('expectation.direction is unknown');
  if (expectation.sourceDomain !== domains.sourceDomain
    || expectation.destinationDomain !== domains.destinationDomain) {
    throw validationError('expectation domains do not match its direction');
  }
  for (const field of ['sender', 'recipient', 'destinationCaller', 'burnToken', 'mintRecipient', 'messageSender']) {
    if (typeof expectation[field] !== 'string' || !BYTES32_STRICT_RE.test(expectation[field])) {
      throw validationError(`expectation.${field} must be canonical 0x lowercase bytes32 hex`);
    }
  }
  const amount = expectDecimalString(expectation.amount, 'amount');
  const maxFee = expectDecimalString(expectation.maxFee, 'maxFee');
  if (expectation.minFinalityThreshold !== 1000 && expectation.minFinalityThreshold !== 2000) {
    throw validationError('expectation.minFinalityThreshold must be 1000 or 2000');
  }
  if (typeof expectation.hookData !== 'string' || !HOOK_DATA_RE.test(expectation.hookData)) {
    throw validationError('expectation.hookData must be canonical 0x lowercase even-byte hex');
  }
  let burnUnits7;
  if (expectation.direction === 'stellar-to-base') {
    burnUnits7 = expectDecimalString(expectation.burnUnits7, 'burnUnits7');
    const units = BigInt(burnUnits7);
    if (units % 10n !== 0n || BigInt(amount) !== units / 10n) {
      throw validationError('forward expectation requires amount === burnUnits7 / 10 exactly');
    }
  } else {
    if (expectation.burnUnits7 !== null) {
      throw validationError('reverse expectation requires burnUnits7: null');
    }
    burnUnits7 = null;
  }
  return {
    version: 1,
    direction: expectation.direction,
    sourceDomain: expectation.sourceDomain,
    destinationDomain: expectation.destinationDomain,
    sender: expectation.sender,
    recipient: expectation.recipient,
    destinationCaller: expectation.destinationCaller,
    burnToken: expectation.burnToken,
    mintRecipient: expectation.mintRecipient,
    messageSender: expectation.messageSender,
    amount,
    burnUnits7,
    maxFee,
    minFinalityThreshold: expectation.minFinalityThreshold,
    hookData: expectation.hookData,
  };
}

/** Domain-separated expectation digest: sha256('vf-cctp-expectation-v1' + NUL + canonical JSON). */
export function expectationDigest(canonicalExpectation) {
  return createHash('sha256')
    .update(`${EXPECTATION_DIGEST_DOMAIN}\0${JSON.stringify(canonicalExpectation)}`, 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Hash forms + evidence normalization
// ---------------------------------------------------------------------------

function normalizeSourceDomain(sourceDomain) {
  if (sourceDomain !== STELLAR_DOMAIN && sourceDomain !== BASE_DOMAIN) {
    throw validationError('sourceDomain must be 27 (Stellar) or 6 (Base)');
  }
  return sourceDomain;
}

/** Source burn hash: Stellar -> 64 hex no 0x; Base -> 0x + 64 hex. Canonical width accepted in
 * either case and normalized lowercase before uniqueness checks and persistence. */
export function normalizeBurnTxHash(sourceDomain, burnTxHash) {
  normalizeSourceDomain(sourceDomain);
  if (typeof burnTxHash !== 'string') throw validationError('burnTxHash must be a string');
  if (sourceDomain === STELLAR_DOMAIN) {
    if (!HEX64_CI_RE.test(burnTxHash)) throw validationError('Stellar burn hash must be 64 hex chars, no 0x prefix');
    return burnTxHash.toLowerCase();
  }
  if (!burnTxHash.startsWith('0x') || !HEX64_CI_RE.test(burnTxHash.slice(2))) {
    throw validationError('Base burn hash must be 0x + 64 hex chars');
  }
  return burnTxHash.toLowerCase();
}

/** Destination mint hash: Base -> 0x + 64 hex; Stellar -> 64 hex no 0x (inverse of the burn). */
export function normalizeMintTxHash(sourceDomain, mintTxHash) {
  normalizeSourceDomain(sourceDomain);
  if (typeof mintTxHash !== 'string') throw validationError('mintTxHash must be a string');
  if (sourceDomain === STELLAR_DOMAIN) {
    if (!mintTxHash.startsWith('0x') || !HEX64_CI_RE.test(mintTxHash.slice(2))) {
      throw validationError('Base mint hash must be 0x + 64 hex chars');
    }
    return mintTxHash.toLowerCase();
  }
  if (!HEX64_CI_RE.test(mintTxHash)) throw validationError('Stellar mint hash must be 64 hex chars, no 0x prefix');
  return mintTxHash.toLowerCase();
}

const sha256Bytes = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

/** Raw evidence normalization: strict canonical even-byte hex (lowercased), bytes32 nonce, and
 * non-empty even-byte attestation; digests are SHA-256 over the DECODED bytes, never the text. */
export function normalizeEvidence({ messageHex, nonceHex, attestationHex }) {
  if (typeof messageHex !== 'string' || !EVEN_HEX_RE.test(messageHex)) {
    throw validationError('message must be non-empty 0x even-byte hex');
  }
  const message = messageHex.toLowerCase();
  if (typeof nonceHex !== 'string' || !nonceHex.startsWith('0x') || !HEX64_CI_RE.test(nonceHex.slice(2))) {
    throw validationError('nonce must be 0x + 64 hex chars');
  }
  if (typeof attestationHex !== 'string' || !EVEN_HEX_RE.test(attestationHex)) {
    throw validationError('attestation must be non-empty 0x even-byte hex');
  }
  const attestation = attestationHex.toLowerCase();
  return {
    messageHex: message,
    nonceHex: nonceHex.toLowerCase(),
    messageDigest: sha256Bytes(message.slice(2)),
    attestationHex: attestation,
    attestationDigest: sha256Bytes(attestation.slice(2)),
  };
}

// ---------------------------------------------------------------------------
// Record construction + intent validation
// ---------------------------------------------------------------------------

function requireNow(now) {
  if (!Number.isSafeInteger(now)) throw validationError('now must be a safe-integer millisecond timestamp');
  return now;
}

function requireLeaseArgs({ now, leaseMs }) {
  requireNow(now);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw validationError('leaseMs must be a positive safe integer');
  }
}

/**
 * One enqueue decision against the current durable state (shared by every backend).
 * `existing` is the row under this execId (or null); `hasBurnOwner(burn)` reports whether a
 * DIFFERENT execution id already owns the canonical burn hash (invariant 5).
 *
 * Ordering matters: under an existing execution id, an immutable-identity difference is always
 * RELAY_ENQUEUE_CONFLICT — even when the changed value is itself malformed (a conflicting retry
 * must never be reclassified as input validation, and the valid row stays untouched). For a
 * fresh execution id the intent is fully validated (RELAY_VALIDATION) before any write.
 *
 * Returns { record, changed:false } for an exact idempotent retry, { record, changed:true } for
 * a new attestation_pending row; throws RELAY_VALIDATION / RELAY_ENQUEUE_CONFLICT otherwise.
 */
export function relayEnqueueDecision({
  existing, hasBurnOwner, execId, sourceDomain, burnTxHash, expectation, now,
}) {
  if (typeof execId !== 'string' || execId.length === 0) {
    throw validationError('execId must be a non-empty string');
  }
  normalizeSourceDomain(sourceDomain);
  const canonical = canonicalizeExpectation(expectation);
  const digest = expectationDigest(canonical);
  if (existing) {
    let burn = null;
    try {
      burn = normalizeBurnTxHash(sourceDomain, burnTxHash);
    } catch {
      burn = null; // a malformed burn can never equal the canonical stored one
    }
    if (existing.sourceDomain !== sourceDomain
      || burn === null
      || existing.burnTxHash !== burn
      || existing.expectationDigest !== digest) {
      throw relayError(
        'RELAY_ENQUEUE_CONFLICT',
        'immutable relay intent differs from the durable record for this execution id',
      );
    }
    return { record: existing, changed: false }; // exact retry is idempotent
  }
  if (canonical.sourceDomain !== sourceDomain) {
    throw validationError('expectation sourceDomain must match the intent sourceDomain');
  }
  const burn = normalizeBurnTxHash(sourceDomain, burnTxHash);
  if (hasBurnOwner(burn)) {
    throw relayError(
      'RELAY_ENQUEUE_CONFLICT',
      'burn hash already belongs to a different execution id',
    );
  }
  const record = relayNewPendingRecord({
    execId, sourceDomain, burnTxHash: burn, expectation: canonical, expectationDigest: digest,
  }, now);
  return { record, changed: true };
}

export function relayNewPendingRecord(intent, now) {
  requireNow(now);
  return {
    execId: intent.execId,
    sourceDomain: intent.sourceDomain,
    burnTxHash: intent.burnTxHash,
    expectation: intent.expectation,
    expectationDigest: intent.expectationDigest,
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
// Pure CAS transitions — one record in, next record out (shared by every backend).
// Each returns { next } for an update, { unchanged: true } for an idempotent no-op, or null
// (claim refusal). Typed errors: RELAY_VALIDATION (malformed input) / RELAY_CAS_CONFLICT
// (stale/wrong/expired lease, wrong source state, terminal, hash disagreement).
// ---------------------------------------------------------------------------

function assertLease(current, leaseToken, now) {
  if (!current) throw casConflict('no such execution id');
  if (typeof leaseToken !== 'string' || leaseToken.length === 0
    || current.leaseToken === null || current.leaseToken !== leaseToken) {
    throw casConflict('stale or wrong lease token');
  }
  if (!Number.isSafeInteger(current.leaseExpiresAt) || current.leaseExpiresAt <= now) {
    throw casConflict('lease has expired');
  }
}

export function relayClaim(current, { now, leaseMs, token }) {
  requireLeaseArgs({ now, leaseMs });
  if (!current) return null;
  if (!RELAY_CLAIMABLE_STATES.includes(current.state)) return null;
  if (current.leaseToken !== null) return null; // held — expiry recovery goes through reconcileExpired
  return {
    next: {
      ...current,
      attempts: current.attempts + 1,
      leaseToken: token,
      leaseExpiresAt: now + leaseMs,
      updatedAt: now,
    },
  };
}

export function relayRenew(current, { leaseToken, now, leaseMs }) {
  requireLeaseArgs({ now, leaseMs });
  assertLease(current, leaseToken, now);
  if (RELAY_TERMINAL_STATES.includes(current.state)) throw casConflict('terminal records are immutable');
  // Retains state and token; never invalidates an in-flight checkpoint made by the same token.
  return { next: { ...current, leaseExpiresAt: now + leaseMs, updatedAt: now } };
}

export function relayRecordAttested(current, { leaseToken, messageHex, nonceHex, attestationHex, now }) {
  requireNow(now);
  const evidence = normalizeEvidence({ messageHex, nonceHex, attestationHex });
  assertLease(current, leaseToken, now);
  if (current.state === 'attestation_pending') {
    return {
      next: {
        ...current, ...evidence, state: 'attested', evidenceVersion: 1, updatedAt: now,
      },
    };
  }
  if (current.state !== 'attested') throw casConflict('evidence is frozen once the submit fence is crossed');
  if (evidence.messageHex !== current.messageHex || evidence.nonceHex !== current.nonceHex) {
    throw casConflict('attested message/nonce disagreement');
  }
  if (evidence.attestationHex === current.attestationHex) return { unchanged: true };
  return {
    next: {
      ...current,
      attestationHex: evidence.attestationHex,
      attestationDigest: evidence.attestationDigest,
      evidenceVersion: current.evidenceVersion + 1,
      updatedAt: now,
    },
  };
}

export function relayMarkMintSubmitting(current, { leaseToken, now }) {
  requireNow(now);
  assertLease(current, leaseToken, now);
  if (current.state !== 'attested') throw casConflict('the submit fence requires durable attested evidence');
  return { next: { ...current, state: 'mint_submitting', updatedAt: now } };
}

export function relayMarkMintSubmitted(current, { leaseToken, mintTxHash, now }) {
  requireNow(now);
  if (!current) throw casConflict('no such execution id');
  const hash = normalizeMintTxHash(current.sourceDomain, mintTxHash);
  assertLease(current, leaseToken, now);
  if (current.state !== 'mint_submitting') throw casConflict('a mint hash can only be checkpointed after the submit fence');
  return { next: { ...current, state: 'mint_submitted', mintTxHash: hash, updatedAt: now } };
}

export function relayFinishMinted(current, { leaseToken, mintTxHash, now }) {
  requireNow(now);
  assertLease(current, leaseToken, now);
  if (current.state !== 'mint_submitted') throw casConflict('minted requires a checkpointed submission');
  const hash = normalizeMintTxHash(current.sourceDomain, mintTxHash);
  if (hash !== current.mintTxHash) throw casConflict('cannot confirm a different hash than the checkpointed one');
  return {
    next: {
      ...current, state: 'minted', leaseToken: null, leaseExpiresAt: null, updatedAt: now,
    },
  };
}

export function relayFinishBlocked(current, { leaseToken, reasonCode, now }) {
  requireNow(now);
  if (!RELAY_BLOCKED_REASONS.includes(reasonCode)) throw validationError(`unknown blocked reason code: ${reasonCode}`);
  assertLease(current, leaseToken, now);
  if (RELAY_TERMINAL_STATES.includes(current.state)) throw casConflict('terminal records are immutable');
  return {
    next: {
      ...current, state: 'blocked', reasonCode, leaseToken: null, leaseExpiresAt: null, updatedAt: now,
    },
  };
}

export function relayFinishUncertain(current, { leaseToken, mintTxHash, reasonCode, now }) {
  requireNow(now);
  if (!RELAY_UNCERTAIN_REASONS.includes(reasonCode)) throw validationError(`unknown uncertain reason code: ${reasonCode}`);
  if (!current) throw casConflict('no such execution id');
  const hash = mintTxHash === undefined ? undefined : normalizeMintTxHash(current.sourceDomain, mintTxHash);
  assertLease(current, leaseToken, now);
  if (current.state !== 'mint_submitting' && current.state !== 'mint_submitted') {
    throw casConflict('uncertain requires the submit fence to have been crossed');
  }
  return {
    next: {
      ...current,
      state: 'uncertain',
      reasonCode,
      mintTxHash: hash ?? current.mintTxHash,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    },
  };
}

export function relayRelease(current, { leaseToken, now }) {
  requireNow(now);
  assertLease(current, leaseToken, now);
  if (!RELAY_CLAIMABLE_STATES.includes(current.state)) {
    throw casConflict('only safe pre-fence/checkpointed states can be released');
  }
  return { next: { ...current, leaseToken: null, leaseExpiresAt: null, updatedAt: now } };
}

/** Lease-expiry reconciliation for one record: safe states keep state and clear the lease;
 * mint_submitting becomes durably uncertain (a send may have happened without a durable hash). */
export function relayReconcileExpired(current, now) {
  if (current.state === 'mint_submitting') {
    return {
      ...current,
      state: 'uncertain',
      reasonCode: 'submission_lease_expired',
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    };
  }
  return { ...current, leaseToken: null, leaseExpiresAt: null, updatedAt: now };
}

export const relayByCreated = (a, b) => (
  a.createdAt - b.createdAt || (a.execId < b.execId ? -1 : a.execId > b.execId ? 1 : 0)
);

/** Outward redacted status (invariant 8): state, canonical hashes, stable reason codes only —
 * never raw messages/attestations, digests, lease tokens, endpoints, or prose. */
export function relayStatusOf(record) {
  if (!record) return null;
  return {
    execId: record.execId,
    sourceDomain: record.sourceDomain,
    state: record.state,
    burnTxHash: record.burnTxHash,
    mintTxHash: record.mintTxHash,
    reasonCode: record.reasonCode,
    attempts: record.attempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Backend-agnostic contract: load() returns a fresh mutable {execId: record} map, save(rows)
// persists it. Every operation is one synchronous critical section; mutations are computed
// fully (validation first) and assigned last, then persisted iff anything changed.
// ---------------------------------------------------------------------------

const clone = (record) => structuredClone(record);

function createRelayStore({ load, save, newToken = randomUUID }) {
  function transact(fn) {
    const rows = load();
    const out = fn(rows);
    if (out && out.changed) save(rows);
    return out ? out.result : undefined;
  }

  return {
    enqueue({ execId, sourceDomain, burnTxHash, expectation, now }) {
      return transact((rows) => {
        const decision = relayEnqueueDecision({
          existing: rows[execId] ?? null,
          hasBurnOwner: (burn) => Object.values(rows).some((row) => row.burnTxHash === burn),
          execId,
          sourceDomain,
          burnTxHash,
          expectation,
          now,
        });
        if (decision.changed) rows[execId] = decision.record;
        return { result: clone(decision.record), changed: decision.changed };
      });
    },

    get(execId) {
      const record = load()[execId];
      return record ? clone(record) : null;
    },

    claim({ execId, now, leaseMs }) {
      return transact((rows) => {
        const outcome = relayClaim(rows[execId], { now, leaseMs, token: newToken() });
        if (!outcome) return { result: null, changed: false };
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    renew({ execId, leaseToken, now, leaseMs }) {
      return transact((rows) => {
        const outcome = relayRenew(rows[execId], { leaseToken, now, leaseMs });
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    recordAttested({ execId, leaseToken, messageHex, nonceHex, attestationHex, now }) {
      return transact((rows) => {
        const outcome = relayRecordAttested(rows[execId], {
          leaseToken, messageHex, nonceHex, attestationHex, now,
        });
        if (outcome.unchanged) return { result: clone(rows[execId]), changed: false };
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    markMintSubmitting({ execId, leaseToken, now }) {
      return transact((rows) => {
        const outcome = relayMarkMintSubmitting(rows[execId], { leaseToken, now });
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    markMintSubmitted({ execId, leaseToken, mintTxHash, now }) {
      return transact((rows) => {
        const outcome = relayMarkMintSubmitted(rows[execId], { leaseToken, mintTxHash, now });
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    finishMinted({ execId, leaseToken, mintTxHash, now }) {
      return transact((rows) => {
        const outcome = relayFinishMinted(rows[execId], { leaseToken, mintTxHash, now });
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    finishBlocked({ execId, leaseToken, reasonCode, now }) {
      return transact((rows) => {
        const outcome = relayFinishBlocked(rows[execId], { leaseToken, reasonCode, now });
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    finishUncertain({ execId, leaseToken, mintTxHash, reasonCode, now }) {
      return transact((rows) => {
        const outcome = relayFinishUncertain(rows[execId], { leaseToken, mintTxHash, reasonCode, now });
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    release({ execId, leaseToken, now }) {
      return transact((rows) => {
        const outcome = relayRelease(rows[execId], { leaseToken, now });
        rows[execId] = outcome.next;
        return { result: clone(outcome.next), changed: true };
      });
    },

    listForSweep({ now, limit, includeTerminal = false }) {
      requireNow(now);
      if (!Number.isSafeInteger(limit) || limit <= 0) throw validationError('limit must be a positive safe integer');
      const rows = Object.values(load())
        .filter((record) => (includeTerminal
          ? record.state !== 'minted'
          : !RELAY_TERMINAL_STATES.includes(record.state)))
        .sort(relayByCreated)
        .slice(0, limit);
      return rows.map(clone);
    },

    reconcileExpired({ now, limit }) {
      requireNow(now);
      if (!Number.isSafeInteger(limit) || limit <= 0) throw validationError('limit must be a positive safe integer');
      return transact((rows) => {
        const expired = Object.values(rows)
          .filter((record) => record.leaseToken !== null
            && Number.isSafeInteger(record.leaseExpiresAt)
            && record.leaseExpiresAt <= now
            && !RELAY_TERMINAL_STATES.includes(record.state))
          .sort(relayByCreated)
          .slice(0, limit);
        const reconciled = [];
        for (const record of expired) {
          const next = relayReconcileExpired(record, now);
          rows[record.execId] = next;
          reconciled.push(clone(next));
        }
        return { result: reconciled, changed: reconciled.length > 0 };
      });
    },

    statusOf(execId) {
      return relayStatusOf(load()[execId] ?? null);
    },
  };
}

// ---------------------------------------------------------------------------
// File backend: complete temp sibling + fsync + atomic rename over the live file.
// ---------------------------------------------------------------------------

let tempCounter = 0;

function readAll(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeAllAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  tempCounter += 1;
  const tmp = `${path}.tmp-${process.pid}-${tempCounter}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function isCurrentRelayRecord(row) {
  return Boolean(row) && typeof row === 'object'
    && RELAY_ALL_STATES.includes(row.state)
    && (typeof row.expectationDigest === 'string'
      || row.reasonCode === 'legacy_record_unrecoverable');
}

// Legacy pre-Task-8 rows have no immutable expectation and no strict confirmation evidence, so
// nothing they claim is actionable: keep the honest identity fields, drop any claimed mint hash,
// and park the row in terminal blocked/legacy_record_unrecoverable (durable after conversion).
function legacyConversion(execId, legacy, now) {
  return {
    execId,
    sourceDomain: legacy?.sourceDomain === STELLAR_DOMAIN || legacy?.sourceDomain === BASE_DOMAIN
      ? legacy.sourceDomain
      : null,
    burnTxHash: typeof legacy?.burnTxHash === 'string' ? legacy.burnTxHash : null,
    expectation: null,
    expectationDigest: null,
    state: 'blocked',
    messageHex: null,
    nonceHex: null,
    messageDigest: null,
    attestationHex: null,
    attestationDigest: null,
    evidenceVersion: 0,
    mintTxHash: null,
    reasonCode: 'legacy_record_unrecoverable',
    attempts: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function createFileStore(path) {
  // One-time legacy conversion at open, persisted atomically so a reopened store still fails
  // closed and the on-disk file no longer carries legacy truth.
  const initial = readAll(path);
  let converted = false;
  for (const [execId, row] of Object.entries(initial)) {
    if (!isCurrentRelayRecord(row)) {
      initial[execId] = legacyConversion(execId, row, Date.now());
      converted = true;
    }
  }
  if (converted) writeAllAtomic(path, initial);
  return createRelayStore({ load: () => readAll(path), save: (rows) => writeAllAtomic(path, rows) });
}

/** In-memory store for tests — same CAS contract as createFileStore, no disk I/O. */
export function createMemoryStore() {
  const data = {};
  return createRelayStore({ load: () => data, save: () => {} });
}
