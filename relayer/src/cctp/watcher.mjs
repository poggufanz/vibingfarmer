// Checkpointed CCTP watcher (Task 8): a durable state machine per execId —
// attestation_pending -> attested -> mint_submitting -> mint_submitted -> minted, with
// terminal blocked/uncertain — driven through the store's CAS contract (store.mjs /
// sqliteStores.mjs cctpRelays). No generic store.set exists here: every durable change is a
// fenced compare-and-transition guarded by the worker's lease.
//
// Contract: .superpowers/sdd/vf-cross-chain-hardening-plan/task-8-test-design.md
//   "State transitions", "Crash-window RED matrix", "Watcher behavior cases", "sweepStuck".
//
// Load-bearing rules:
// - The immutable expectation is MANDATORY (the Task 7 skeleton bridge is removed): no
//   expectation, no row, no poll (RELAY_VALIDATION before enqueue).
// - The watcher re-runs the REAL assertCctpV2BurnMatches on returned raw evidence before the
//   attested checkpoint — including resumed attested work — and never trusts an injected
//   poll's parsed object or Iris decoded fields.
// - The submit fence (mint_submitting) is durable BEFORE any destination send; the canonical
//   destination hash is durable (mint_submitted) BEFORE any confirmation.
// - mint_submitted resumes by confirming the persisted hash ONLY — never re-polls, never
//   re-submits. A crashed/failed submission becomes uncertain and is never auto-retried.
// - Outward results expose only state, canonical hashes, and stable reason codes
//   (invariant 8): no raw messages/attestations, digests, lease tokens, endpoints, or prose.

import { pollAttestation as defaultPollAttestation } from './iris.mjs';
import { assertCctpV2BurnMatches } from './messageV2.mjs';
import { submitMintBase as defaultSubmitMintBase, confirmMintBase as defaultConfirmMintBase } from './forward.mjs';
import {
  submitMintAndForwardStellar as defaultSubmitMintAndForwardStellar,
  confirmMintAndForwardStellar as defaultConfirmMintAndForwardStellar,
} from './reverse.mjs';
import { normalizeMintTxHash } from '../store.mjs';

const DEFAULT_LEASE_MS = 60_000;
// Mirrors iris.mjs's poll defaults; the claim lease must outlive the worst-case attestation
// poll (~25 min at standard finality) or every post-poll durable transition CAS-fails.
const DEFAULT_POLL_MAX_ATTEMPTS = 300;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
// Submit + confirm headroom on top of the poll budget when sizing the worker lease.
const LEASE_MARGIN_MS = 120_000;

// Poll/assert outcomes that prove the raw evidence is wrong for the immutable intent —
// terminal blocked, never submitted, never retried.
const MESSAGE_MISMATCH_CODES = new Set([
  'CCTP_MESSAGE_MISMATCH', 'CCTP_MESSAGE_FORMAT', 'CCTP_MESSAGE_LENGTH', 'CCTP_MESSAGE_VERSION',
]);

/**
 * @param {Object} config
 * @param {Object} config.store - relay-work store (createMemoryStore/createFileStore/cctpRelays)
 * @param {string} config.irisUrl
 * @param {{stellar:number, base:number}} config.domains - CCTP_DOMAIN
 * @param {Object} config.base - { publicClient, walletClient, messageTransmitterAddress }
 * @param {Object} config.stellar - { server, kp, sourcePub, passphrase, forwarderAddress }
 * @param {number} [config.leaseMs] - minimum worker lease duration (default 60s); the effective
 *   claim lease is `max(leaseMs, pollMaxAttempts * pollIntervalMs + margin)` so a long
 *   standard-finality poll can never outlive the lease and wedge a successfully attested row
 * @param {number} [config.pollMaxAttempts] - Iris poll budget forwarded to pollAttestationFn (default 300)
 * @param {number} [config.pollIntervalMs] - Iris poll interval forwarded to pollAttestationFn (default 5000)
 * @param {Function} [config.nowFn] - millisecond clock (default Date.now)
 * @param {Function} [config.pollAttestationFn]
 * @param {Function} [config.submitMintBaseFn]
 * @param {Function} [config.confirmMintBaseFn]
 * @param {Function} [config.submitMintAndForwardStellarFn]
 * @param {Function} [config.confirmMintAndForwardStellarFn]
 */
export function createWatcher(config) {
  const {
    store, irisUrl, domains, base, stellar,
    leaseMs = DEFAULT_LEASE_MS,
    pollMaxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    nowFn = Date.now,
    pollAttestationFn = defaultPollAttestation,
    submitMintBaseFn = defaultSubmitMintBase,
    confirmMintBaseFn = defaultConfirmMintBase,
    submitMintAndForwardStellarFn = defaultSubmitMintAndForwardStellar,
    confirmMintAndForwardStellarFn = defaultConfirmMintAndForwardStellar,
  } = config;

  // The claim lease must cover the whole worst-case invocation: a standard-finality Iris poll
  // alone is ~25 minutes at the default budget. A lease that dies mid-poll turns every later
  // durable transition into a CAS conflict and wedges the row until reconciliation.
  const effectiveLeaseMs = Math.max(
    leaseMs,
    pollMaxAttempts * pollIntervalMs + LEASE_MARGIN_MS,
  );

  // In-flight dedupe: concurrent identical relayMint calls cause exactly one external
  // submission; a joiner gets an explicit non-minted shape the farm flow can never mistake
  // for confirmed mint evidence.
  const inFlight = new Set();

  const isForward = (record) => record.sourceDomain === domains.stellar;

  function recoveryEvidence(record) {
    return {
      burnTxHash: record.burnTxHash,
      expectationDigest: record.expectationDigest,
      messageDigest: record.messageDigest,
      attestationDigest: record.attestationDigest,
      evidenceVersion: String(record.evidenceVersion),
      mintTxHash: record.mintTxHash,
    };
  }

  // Terminal records answer from durable truth alone — no poll, no submit, no confirm, and no
  // store write (a terminal record is byte-for-byte stable across duplicate calls and reopen).
  function terminalResult(record) {
    if (record.state === 'minted') return { status: 'already-minted', mintTxHash: record.mintTxHash };
    if (record.state === 'blocked') return { status: 'blocked', reasonCode: record.reasonCode };
    if (record.state === 'uncertain') return { status: 'uncertain', reasonCode: record.reasonCode };
    return null;
  }

  function releaseQuietly(execId, leaseToken) {
    try {
      store.release({ execId, leaseToken, now: nowFn() });
    } catch {
      // Not safely releasable (e.g. past the submit fence) — the lease expires and
      // reconcileExpired classifies the row. Never mask the original outcome.
    }
  }

  // Poll Iris with the immutable expectation, re-run the real raw assertion, and checkpoint
  // the evidence. Returns { record } once attested, or { result } for a classified stop.
  async function pollPhase(record, claimed) {
    const { execId } = record;
    const { leaseToken } = claimed;
    let evidence;
    let parsed;
    try {
      evidence = await pollAttestationFn({
        irisUrl, sourceDomain: record.sourceDomain, txHash: record.burnTxHash,
        expectation: record.expectation,
        maxAttempts: pollMaxAttempts, intervalMs: pollIntervalMs,
      });
      // The poll may be an injected fake — the durable checkpoint only ever carries evidence
      // that passes the REAL Task 7 assertion against the immutable expectation.
      parsed = assertCctpV2BurnMatches(evidence?.message, record.expectation);
    } catch (err) {
      const code = err?.code;
      if (code === 'CCTP_MESSAGE_AMBIGUOUS') {
        store.finishBlocked({ execId, leaseToken, reasonCode: 'message_ambiguous', now: nowFn() });
        return { result: { status: 'blocked', reasonCode: 'message_ambiguous' } };
      }
      if (MESSAGE_MISMATCH_CODES.has(code)) {
        store.finishBlocked({ execId, leaseToken, reasonCode: 'message_mismatch', now: nowFn() });
        return { result: { status: 'blocked', reasonCode: 'message_mismatch' } };
      }
      // Timeout/transient (CCTP_ATTESTATION_TIMEOUT, network): stay recoverable — release the
      // lease so a later call re-polls; no destination seam was touched.
      releaseQuietly(execId, leaseToken);
      return { result: { status: 'attestation_pending' } };
    }
    try {
      const attested = store.recordAttested({
        execId, leaseToken,
        messageHex: evidence.message, nonceHex: parsed.nonce, attestationHex: evidence.attestation,
        now: nowFn(),
      });
      return { record: attested };
    } catch (err) {
      // A resumed attested row whose re-polled message/nonce disagrees with the durable
      // evidence is terminal — the original evidence is retained, never partially replaced.
      if (err?.code === 'RELAY_CAS_CONFLICT' && claimed.state === 'attested') {
        store.finishBlocked({ execId, leaseToken, reasonCode: 'attested_evidence_changed', now: nowFn() });
        return { result: { status: 'blocked', reasonCode: 'attested_evidence_changed' } };
      }
      throw err;
    }
  }

  async function submitPhase(record, attested, leaseToken) {
    const { execId } = record;
    // Durable pre-send fence: after this line, a crash is observable as uncertain, never a
    // silent re-submission.
    store.markMintSubmitting({ execId, leaseToken, now: nowFn() });
    let hash;
    try {
      hash = isForward(record)
        ? await submitMintBaseFn({
          walletClient: base.walletClient,
          messageTransmitterAddress: base.messageTransmitterAddress,
          message: attested.messageHex,
          attestation: attested.attestationHex,
        })
        : await submitMintAndForwardStellarFn({
          server: stellar.server, kp: stellar.kp, sourcePub: stellar.sourcePub,
          passphrase: stellar.passphrase, forwarderAddress: stellar.forwarderAddress,
          message: attested.messageHex,
          attestation: attested.attestationHex,
        });
    } catch {
      // Any post-fence send failure (incl. CCTP_MINT_SUBMISSION_AMBIGUOUS): the destination
      // may or may not have received the mint — durably uncertain, never auto-retried.
      store.finishUncertain({ execId, leaseToken, reasonCode: 'submission_unknown', now: nowFn() });
      return { result: { status: 'uncertain', reasonCode: 'submission_unknown' } };
    }
    try {
      const submitted = store.markMintSubmitted({ execId, leaseToken, mintTxHash: hash, now: nowFn() });
      return { record: submitted };
    } catch {
      // The send returned a hash but the durable checkpoint failed: retain the hash
      // best-effort (only if it is canonical for the destination) for operator reconciliation.
      let retained;
      try {
        retained = normalizeMintTxHash(record.sourceDomain, hash);
      } catch {
        retained = undefined;
      }
      store.finishUncertain({
        execId, leaseToken, mintTxHash: retained, reasonCode: 'submitted_checkpoint_failed', now: nowFn(),
      });
      return { result: { status: 'uncertain', reasonCode: 'submitted_checkpoint_failed' } };
    }
  }

  async function confirmPhase(record, submitted, leaseToken) {
    const { execId } = record;
    const hash = submitted.mintTxHash;
    try {
      if (isForward(record)) {
        await confirmMintBaseFn({ publicClient: base.publicClient, hash });
      } else {
        await confirmMintAndForwardStellarFn({ server: stellar.server, hash });
      }
    } catch (err) {
      const code = err?.code;
      if (code === 'CCTP_MINT_REVERTED' || code === 'STELLAR_TX_FAILED') {
        // Definitive destination failure — the durable hash is retained as evidence.
        store.finishBlocked({ execId, leaseToken, reasonCode: 'destination_reverted', now: nowFn() });
        return { status: 'blocked', reasonCode: 'destination_reverted' };
      }
      // Transient/timeout on a KNOWN hash (CCTP_MINT_CONFIRMATION_RETRYABLE,
      // STELLAR_TX_TIMEOUT, or anything else): stay mint_submitted and confirm the same hash
      // later — the confirmation identity is never thrown away.
      releaseQuietly(execId, leaseToken);
      return { status: 'mint_submitted', mintTxHash: hash };
    }
    try {
      store.finishMinted({ execId, leaseToken, mintTxHash: hash, now: nowFn() });
    } catch {
      // The receipt proved the hash but the minted commit failed: stay mint_submitted so a
      // resume reconfirms the same hash (never re-submits).
      releaseQuietly(execId, leaseToken);
      return { status: 'mint_submitted', mintTxHash: hash };
    }
    return { status: 'minted', mintTxHash: hash };
  }

  // Drives one durable record through the state machine. Assumes the record exists and is
  // non-terminal.
  async function drive(execId) {
    const record = store.get(execId);
    if (!record) throw new Error(`relayMint: no durable record for ${execId}`);
    const terminal = terminalResult(record);
    if (terminal) return terminal;

    const claimed = store.claim({ execId, now: nowFn(), leaseMs: effectiveLeaseMs });
    if (!claimed) {
      // Held by another worker (or not safely claimable) — never mint evidence.
      return { status: 'in-progress' };
    }
    const { leaseToken } = claimed;
    try {
      let working = claimed;
      if (claimed.state === 'attestation_pending' || claimed.state === 'attested') {
        // Resumed attested work re-polls and revalidates before any submit fence.
        const polled = await pollPhase(record, claimed);
        if (polled.result) return polled.result;
        working = polled.record;
      }
      if (working.state === 'attested') {
        const submitted = await submitPhase(record, working, leaseToken);
        if (submitted.result) return submitted.result;
        working = submitted.record;
      }
      // mint_submitted: confirm the persisted hash only — no poll, no submit.
      return await confirmPhase(record, working, leaseToken);
    } catch (err) {
      releaseQuietly(execId, leaseToken);
      throw err;
    }
  }

  async function relayMint({ sourceDomain, burnTxHash, execId, expectation }) {
    if (inFlight.has(execId)) return { status: 'in-progress' };
    inFlight.add(execId);
    try {
      // Validation happens inside enqueue: a missing/malformed expectation, domain, or burn
      // hash rejects with RELAY_VALIDATION before any row exists; an exact retry returns the
      // durable row unchanged; an immutable change or burn-hash reuse rejects with
      // RELAY_ENQUEUE_CONFLICT and leaves the valid row untouched.
      const record = store.enqueue({
        execId, sourceDomain, burnTxHash, expectation, now: nowFn(),
      });
      const terminal = terminalResult(record);
      if (terminal) return terminal;
      return await drive(execId);
    } finally {
      inFlight.delete(execId);
    }
  }

  /**
   * Bounded, deterministic startup/stuck recovery. First reconciles expired leases in one
   * store transaction (expired mint_submitting becomes durably uncertain and calls NO seam),
   * then walks every non-minted row in (createdAt, execId) order and classifies into disjoint
   * arrays: terminal blocked/uncertain, actively leased (held), or safely re-driven (redriven —
   * mint_submitted rows confirm their persisted hash only; pending/attested rows re-poll).
   * One row's failure never aborts classification of later rows. Outward shape is execId
   * lists only (invariant 8).
   */
  async function sweepStuck({ now = nowFn(), limit = 100 } = {}) {
    store.reconcileExpired({ now, limit });
    const rows = store.listForSweep({ now, limit, includeTerminal: true });
    const sweep = { redriven: [], held: [], blocked: [], uncertain: [] };
    for (const row of rows) {
      if (row.state === 'blocked') { sweep.blocked.push(row.execId); continue; }
      if (row.state === 'uncertain') { sweep.uncertain.push(row.execId); continue; }
      if (inFlight.has(row.execId)) { sweep.held.push(row.execId); continue; }
      if (row.leaseToken !== null) {
        // Still leased after reconciliation => the lease is active => held, never replayed.
        sweep.held.push(row.execId);
        continue;
      }
      try {
        await drive(row.execId);
        const after = store.get(row.execId);
        if (after?.state === 'blocked') sweep.blocked.push(row.execId);
        else if (after?.state === 'uncertain') sweep.uncertain.push(row.execId);
        else sweep.redriven.push(row.execId);
      } catch {
        // A transient drive failure (store I/O, boundary error) leaves the row recoverable;
        // it was attempted, and later rows still classify.
        sweep.redriven.push(row.execId);
      }
    }
    return sweep;
  }

  function getRecoveryEvidence(execId) {
    const record = store.get(execId);
    if (!record || record.state !== 'minted') {
      throw new Error('confirmed CCTP recovery evidence is unavailable');
    }
    return recoveryEvidence(record);
  }

  return { relayMint, sweepStuck, getRecoveryEvidence };
}
