// Pure HTTP handler factory for the relayer's /api/vf-cross/* surface. No network calls and no
// secrets are read directly here — every side effect (farm-flow construction, mint relaying,
// job/mandate storage, id generation) is injected, so this file is fully unit-testable with fake
// req/res and no real network. CORS + body handling clone the ensureBody/subPath pattern from
// frontend/api/vf/_router.js so a raw node:http request behaves the same as a pre-parsed one
// under test.
//
// Non-custodial invariant: the `/unwind` handler reserves and verifies owner-signed Base
// evidence; only the Task 8 reverse-mint state machine may later submit on Stellar. No
// relayer-side Base burn construction is imported or called from here.
//
// Mandates use only the capability-bound v3 authority and activation stores. Legacy approval-
// bearing v2 routes are deliberately absent from this surface.

import { createHash } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { validateMandateBinding, MAX_CALL_CAP_UNITS } from './base/session.mjs';
import {
  canonicalTxHash,
  canonicalUserOpHash,
} from './base/canonicalMandate.mjs';
import {
  capabilityMatches,
  clearMandateCapabilityCookie,
  hashCapability,
  parseBearerCapability,
  requireCapability,
  requireMandateId,
  serializeMandateCapabilityCookie,
  requireUnwindJobId,
  serializeUnwindCapabilityCookie,
} from './capability.mjs';
import { evaluateBaseMandateStatus } from './mandateStatus.mjs';
import { buildForwardFarmIntent } from './farmIntent.mjs';
import {
  AgentIndexBatchConflictError,
  AgentIndexBatchPermanentError,
} from './agentIndexReporter.mjs';

async function ensureBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.body && typeof req.body === 'object') return;
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    req.body = raw ? JSON.parse(raw) : {};
  } catch {
    req.body = {}; // malformed body -> handler validation rejects it downstream
  }
}

function subPath(req) {
  const pathname = new URL(req.url, 'http://local').pathname;
  const i = pathname.indexOf('/api/vf-cross');
  return (i >= 0 ? pathname.slice(i + '/api/vf-cross'.length) : pathname) || '/';
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function errorMessage(err) {
  return err?.message || String(err);
}

const WIRE_ALLOCATION_FIELDS = new Set(['allocationId', 'poolAddress', 'amount', 'minShares']);
const WIRE_AMOUNT_FIELDS = new Set(['token', 'units', 'decimals']);
const FARM_V2_FIELDS = new Set([
  'requestId', 'mandateId', 'allocations', 'stellarOwner', 'kernelAddress',
  'bridgeAgent', 'runId', 'grantTxHash',
]);
const FARM_ATTACH_V2_FIELDS = new Set(['jobId', 'burnTxHash', 'mandateId']);
const MANDATE_STATUS_FIELDS = new Set(['mandateId', 'stellarOwner', 'kernelAddress']);
const FARM_STATUS_FIELDS = new Set(['mandateId', 'jobId']);
const UNWIND_RESERVE_FIELDS = new Set(['jobId', 'capability', 'kernelAddress', 'recipientHint']);
const UNWIND_ATTACH_FIELDS = new Set(['jobId', 'userOpHash', 'unwindTxHash']);
const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const FARM_LEASE_MS = 30_000;
const FARM_HEARTBEAT_MS = 10_000;
const MANDATE_ACTIVATION_LEASE_SECONDS = 30;
const MANDATE_ACTIVATION_HEARTBEAT_MS = 10_000;
const CAPABILITY_HASH_PATTERN = /^[0-9a-f]{64}$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_EVM_ADDRESS = `0x${'00'.repeat(20)}`;
const MAX_UNWIND_COOKIE_AGE_SECONDS = 24 * 60 * 60;
const UNWIND_EVIDENCE_LEASE_MS = 30_000;
const UNWIND_EVIDENCE_HEARTBEAT_MS = 10_000;
const UNWIND_FACT_FIELDS = Object.freeze([
  'generation', 'chainId', 'entryPointAddress', 'baseExitSweeperAddress', 'usdcAddress',
  'tokenMessengerV2Address', 'messageTransmitterV2Address', 'stellarDomain',
  'stellarTokenMessenger', 'cctpForwarder', 'finalityThreshold',
]);
const UNWIND_STORE_METHODS = Object.freeze([
  'reserve', 'getAuthority', 'status', 'claimEvidence', 'renewEvidence', 'releaseEvidence',
  'attachAndEnqueue', 'finishBlocked', 'finishUncertain', 'reconcileFromCctp',
  'reconcileExpired', 'listForResume',
]);
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;

function unwindFactsReady(facts) {
  return facts && typeof facts === 'object' && !Array.isArray(facts)
    && Object.keys(facts).length === UNWIND_FACT_FIELDS.length
    && UNWIND_FACT_FIELDS.every((field) => Object.hasOwn(facts, field))
    && facts.generation === 'hardened-v2'
    && facts.chainId === 84532
    && facts.stellarDomain === 27
    && facts.finalityThreshold === 1000
    && [
      facts.entryPointAddress, facts.baseExitSweeperAddress, facts.usdcAddress,
      facts.tokenMessengerV2Address, facts.messageTransmitterV2Address,
    ].every((value) => EVM_ADDRESS_PATTERN.test(value) && value === value.toLowerCase()
      && value !== ZERO_EVM_ADDRESS)
    && [facts.stellarTokenMessenger, facts.cctpForwarder]
      .every((value) => BYTES32_PATTERN.test(value) && !/^0x0{64}$/.test(value));
}

function requireExactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).find((field) => !allowed.has(field));
  if (unexpected) throw new Error(`unexpected ${label} field: ${unexpected}`);
}

// Fix loop 2, Fix 1: shared by /farm and /farm/attach (and, transitively, the `_attach` burn-hash
// comparison at handleFarmAttach — both writers of attachedBurnTxHash now go through this same
// guard) so the two entry points cannot drift back to a truthiness-only check. A non-string value
// (number, object, array, boolean) must never reach attachContext.attachedBurnTxHash: it gets
// JSON-persisted into the relayer jobs table, passed to watcher.relayMint as both burnTxHash and
// execId, and compared with !== later — an object can never match itself on retry ({} !== {}).
function isValidBurnTxHash(value) {
  return typeof value === 'string' && value.length > 0;
}

// Fix loop 2, Fix 4: mirrors the D1 index's amount.units rule (frontend/api/agent-index/
// associations.js's `/^\d+$/` + `> 0n` check) at the wire seam, so a report that the index will
// always reject can never be dispatched in the first place. Canonical = digits only, no sign, no
// decimal point, no exponent, no surrounding whitespace, no leading '+' — the same shape BigInt()
// would otherwise silently coerce from a number/boolean or (worse) accept as negative.
function isCanonicalDecimalString(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

// Binding attestation for My Money Task 5 (the "binding plan" of the class doc): bindingId is a
// fresh opaque id per registration (from the same genId the caller already injects for jobs);
// bindingHash is a deterministic digest of the binding's identity fields, so two independent
// parties (this relayer and a My Money reporter) can confirm they mean the same binding without
// re-exchanging the approval blob or the session key.
function computeBindingHash({ stellarOwner, kernelAddress, sessionKeyAddress, expiresAt }) {
  return createHash('sha256').update(`${stellarOwner}|${kernelAddress}|${sessionKeyAddress}|${expiresAt}`).digest('hex');
}

// Step 4 revocation copy: deleting this relayer's copy of the key is NOT the same claim as
// "revoked everywhere." The ZeroDev session policy's on-chain timestamp bound is the
// cryptographic worst-case (it lapses at its own expiry regardless of what this relayer does);
// this relayer can only ever delete/disable ITS OWN copy of the key. Tests and UI use this exact
// distinction — never say "revoked" without this qualifier.
const REVOKE_NOTE = 'This relayer deleted its own copy of the session key. The stellarOwner<->kernelAddress binding is an application/relayer association, not a cryptographic one; if a copy of the key exists elsewhere, the on-chain timestamp policy remains the cryptographic worst-case bound until it expires, unless on-chain/module revocation is separately confirmed.';

/**
 * @param {Object} deps
 * @param {(sessionPrivateKey: string) => { farm: Function }} deps.buildFarm - per-request farm
 *   flow factory (constructs orchestrator + createFarmFlow); never persists the key it's given.
 * @param {Map<string, {status:string, steps:Array<object>}>} deps.jobs - jobId -> job record
 * @param {object} deps.mandatesV3 - encrypted mandate authority store.
 * @param {object} deps.mandateActivations - paired activation work/CAS store.
 * @param {(sessionPrivateKey: string) => {activateMandate: Function}} deps.buildMandateActivator
 * @param {() => string} deps.genId
 * @param {string} deps.usdcAddress - canonical Base USDC address, for approval-policy validation
 * @param {string} deps.yieldRouterAddress - deployed YieldRouter address, for approval-policy validation
 * @param {string|null} [deps.relayerOrigin] - this server's own configured public origin. Stored
 *   on every mandate at registration and re-compared on every later operation — "compare relayer
 *   origin to server configuration" (Step 2). null/'' = not configured (open dev posture, no
 *   compare performed), matching the withProxyKeyAuth "empty key = open" convention in server.mjs.
 * @param {boolean} [deps.sanitizeErrors=false] - when true, error job records (returned verbatim by
 *   protected POST /status) carry a generic message and the real error is logged server-side only. Off by
 *   default so local dev / the smoke harness keep full detail; the standalone server turns it ON
 *   unless RELAYER_DEBUG_ERRORS=1 (see server.mjs), so a public deploy never leaks internal error
 *   strings (RPC URLs, addresses) to whoever holds a jobId.
 */
export function createRelayerRouter({
  buildFarm, jobs, genId,
  mandatesV3 = null, mandateActivations = null, buildMandateActivator = null,
  relayerOrigin = null, sanitizeErrors = false, networkId = 'stellar-testnet',
  publicRuntime = null,
  evaluateMandateStatusFn = evaluateBaseMandateStatus,
  mandateStatusConfig = publicRuntime?.mandateStatusConfig ?? null,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  poolTargets = new Map(), agentIndexReporter = null, associationOutbox = null,
  baseEvidenceOutbox = null, farmIntents = null, cctpRelays = null,
  relayForwardMint = null, recoveryLimit = 100, recoveryConcurrency = 4,
  forwardFarmDeployment = null,
  unwindJobs = null, readUnwindEvidence = null, relayReverseMint = null,
  resumeExistingReverse = null,
  unwindPublicClient = null, unwindBundlerClient = null, unwindEvidenceFacts = null,
  unwindCookieMaxAgeSeconds = 3600,
  unwindBurnMaxAgeSeconds = unwindCookieMaxAgeSeconds - 300,
  unwindEvidenceRetryMs = 300_000,
  nowMs = () => Date.now(),
}) {
  const baseExecutionAvailable = publicRuntime?.baseCrossChainAvailable === true;
  const activeMandateActivations = new Map();
  const activeMandateRegistrations = new Map();
  const activeIntentDeliveries = new Map();
  let activeFarmResumeV2 = null;
  let activeUnwindResume = null;
  const baseUnavailable = (res) => sendJson(
    res, 503, { error: 'Base cross-chain execution is unavailable' },
  );
  const unwindAttachStackReady = () => UNWIND_STORE_METHODS.every(
    (method) => typeof unwindJobs?.[method] === 'function',
  )
    && typeof readUnwindEvidence === 'function'
    && typeof relayReverseMint === 'function'
    && typeof unwindPublicClient?.getChainId === 'function'
    && typeof unwindPublicClient?.getTransactionReceipt === 'function'
    && typeof unwindBundlerClient?.getUserOperation === 'function'
    && typeof unwindBundlerClient?.getUserOperationReceipt === 'function'
    && unwindFactsReady(unwindEvidenceFacts);
  // Record a failed job. Client-facing message is generic when sanitizeErrors is on; the real
  // error is always available server-side (console.error) for debugging. Never stores the key.
  // `context` (runId/bridgeAgent/grantTxHash for a farm job; omitted for unwind, which has none)
  // survives onto the error record — a failed job is exactly where My Money's durable index needs
  // that association most (see the "relayer 'failed' != bridge failed" bookkeeping hazard).
  function recordError(jobId, step, err, context = {}) {
    if (sanitizeErrors) {
      console.error(`[relayer] job ${jobId} step ${step} failed:`, err);
      jobs.set(jobId, { ...context, status: 'error', steps: [{ step, status: 'error', message: 'internal error' }] });
    } else {
      jobs.set(jobId, { ...context, status: 'error', steps: [{ step, status: 'error', message: errorMessage(err) }] });
    }
  }
  // Durable mandate window: the client (baseLeg.js) requests a 7-day expiry so a repeat run can
  // reuse the mandate with zero wallet ceremony; this cap just bounds how far out a client may
  // push it (a compromised/buggy client asking for a 10-year key would otherwise be honored).
  const MAX_MANDATE_WINDOW_SECONDS = 30 * 24 * 3600;

  function activationIdentityKey(identity) {
    return `${identity.mandateId}|${identity.stellarOwner}|${String(identity.kernelAddress).toLowerCase()}`;
  }

  function cloneForMandateEvaluation(record) {
    const descriptors = Object.getOwnPropertyDescriptors(record);
    // evaluateBaseMandateStatus's canonical parser consumes a shallow copy. Make the key visible
    // only on this trusted, in-process evaluator object; the durable/public records remain
    // non-enumerable and no HTTP/storage serialization sees this clone.
    if (descriptors.sessionPrivateKey) {
      descriptors.sessionPrivateKey = {
        ...descriptors.sessionPrivateKey,
        enumerable: true,
      };
    }
    return Object.create(Object.getPrototypeOf(record), descriptors);
  }

  function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
  }

  function isImmutableMandateConflict(error) {
    return error?.message === 'immutable mandate conflict';
  }

  function canonicalStoredBinding(record, identity) {
    try {
      requireMandateId(record?.mandateId);
    } catch {
      return null;
    }
    if (!CAPABILITY_HASH_PATTERN.test(record.capabilityHash || '')
      || record.mandateId !== identity.mandateId
      || record.stellarOwner !== identity.stellarOwner
      || String(record.kernelAddress).toLowerCase() !== String(identity.kernelAddress).toLowerCase()
      || typeof record.sessionPrivateKey !== 'string' || !record.sessionPrivateKey) {
      return null;
    }

    const base = {
      serializedApproval: record.serializedApproval,
      sessionPrivateKey: record.sessionPrivateKey,
      sessionKeyAddress: record.sessionKeyAddress,
      stellarOwner: record.stellarOwner,
      kernelAddress: record.kernelAddress,
      permissionId: record.permissionId,
      validUntilSeconds: record.validUntilSeconds,
      expiresAt: record.validUntilSeconds,
      relayerOrigin: record.relayerOrigin,
      config: mandateStatusConfig,
      now: nowSeconds(),
    };
    const parsed = validateMandateBinding(base);
    if (!parsed.ok) return null;

    // The stores normalize EVM addresses for identity matching. Rebuild the binding with the
    // canonical address spellings recovered from the approval/private key so case normalization
    // cannot turn an otherwise immutable binding into a false mismatch.
    const checked = validateMandateBinding({
      ...base,
      kernelAddress: parsed.mandate.accountAddress,
      sessionKeyAddress: parsed.mandate.sessionKeyAddress,
      bindingId: record.bindingId,
      bindingHash: record.bindingHash,
    });
    if (!checked.ok
      || record.approvalDigest !== sha256(record.serializedApproval)
      || record.policyDigest !== checked.mandate.policyDigest
      || record.permissionId !== checked.mandate.permissionId) {
      return null;
    }
    return checked.mandate;
  }

  function startMandateActivationHeartbeat(identity, leaseToken) {
    const timer = setInterval(() => {
      try {
        mandateActivations.renew({
          ...identity,
          leaseToken,
          nowSeconds: nowSeconds(),
          leaseSeconds: MANDATE_ACTIVATION_LEASE_SECONDS,
        });
      } catch {
        // A local revoke, expiry, or terminal CAS owns the durable truth. The worker's next
        // fenced operation observes it and must never resurrect the mandate.
      }
    }, MANDATE_ACTIVATION_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function finishActivationUncertain({
    identity, leaseToken, userOpHash, txHash,
  }) {
    const input = {
      ...identity,
      leaseToken,
      nowSeconds: nowSeconds(),
    };
    if (canonicalUserOpHash(userOpHash)) input.userOpHash = userOpHash;
    if (canonicalTxHash(txHash) && input.userOpHash) input.txHash = txHash;
    try {
      await mandateActivations.finishUncertain(input);
    } catch {
      // Revocation/expiry/another terminal CAS is stronger than this worker's stale result.
    }
  }

  async function runMandateActivation(claimed) {
    if (!baseExecutionAvailable) return;
    const identity = {
      mandateId: claimed.mandateId,
      stellarOwner: claimed.stellarOwner,
      kernelAddress: claimed.kernelAddress,
    };
    const leaseToken = claimed.leaseToken;
    const stopHeartbeat = startMandateActivationHeartbeat(identity, leaseToken);
    let submitting = false;
    let submittedUserOpHash = null;
    let receiptTxHash = null;

    try {
      const stored = await mandatesV3.get(identity);
      if (!canonicalStoredBinding(stored, identity)) {
        await mandatesV3.revoke(identity);
        return;
      }

      await mandateActivations.checkpoint({
        ...identity,
        leaseToken,
        status: 'submitting',
        nowSeconds: nowSeconds(),
      });
      submitting = true;

      const { activateMandate } = buildMandateActivator(stored.sessionPrivateKey);
      const receipt = await activateMandate(stored.serializedApproval, {
        onSubmitted: async (candidateHash) => {
          const hash = canonicalUserOpHash(candidateHash);
          if (!hash) throw new Error('activation submission evidence is invalid');
          // Retain callback evidence before persistence so a callback checkpoint failure can
          // still be fenced uncertain with the only trustworthy hash the worker observed.
          submittedUserOpHash = hash;
          await mandateActivations.checkpoint({
            ...identity,
            leaseToken,
            status: 'submitted',
            userOpHash: hash,
            nowSeconds: nowSeconds(),
          });
        },
      });

      const returnedUserOpHash = canonicalUserOpHash(receipt?.userOpHash);
      if (!returnedUserOpHash || !submittedUserOpHash
        || returnedUserOpHash !== submittedUserOpHash) {
        throw new Error('activation receipt disagrees with submission evidence');
      }
      const returnedTxHash = canonicalTxHash(receipt?.txHash);
      if (!returnedTxHash) throw new Error('activation receipt evidence is invalid');
      receiptTxHash = returnedTxHash;

      const activatedAt = nowSeconds();
      if (!Number.isSafeInteger(activatedAt) || activatedAt <= 0
        || activatedAt >= stored.validUntilSeconds) {
        throw new Error('activation receipt time is outside the mandate window');
      }

      await mandateActivations.renew({
        ...identity,
        leaseToken,
        nowSeconds: nowSeconds(),
        leaseSeconds: MANDATE_ACTIVATION_LEASE_SECONDS,
      });
      const beforeEvaluation = await mandatesV3.get(identity);
      const canonical = canonicalStoredBinding(beforeEvaluation, identity);
      if (!canonical) {
        await mandatesV3.revoke(identity);
        return;
      }
      if (beforeEvaluation.status !== 'pending_activation') return;

      const evaluationRecord = cloneForMandateEvaluation(beforeEvaluation);
      Object.assign(evaluationRecord, {
        kernelAddress: canonical.accountAddress,
        sessionKeyAddress: canonical.sessionKeyAddress,
        activationUserOpHash: submittedUserOpHash,
        activationTxHash: receiptTxHash,
        activatedAt,
      });
      const evidence = await evaluateMandateStatusFn({
        record: evaluationRecord,
        config: mandateStatusConfig,
      });

      await mandateActivations.renew({
        ...identity,
        leaseToken,
        nowSeconds: nowSeconds(),
        leaseSeconds: MANDATE_ACTIVATION_LEASE_SECONDS,
      });
      const afterEvaluation = await mandatesV3.get(identity);
      if (!canonicalStoredBinding(afterEvaluation, identity)) {
        await mandatesV3.revoke(identity);
        return;
      }
      if (afterEvaluation.status !== 'pending_activation') return;

      const terminal = {
        ...identity,
        leaseToken,
        userOpHash: submittedUserOpHash,
        txHash: receiptTxHash,
        activatedAt,
        nowSeconds: nowSeconds(),
      };
      if (evidence?.status === 'active') {
        await mandateActivations.finishActive(terminal);
      } else if (evidence?.status === 'revoked') {
        await mandateActivations.finishRevoked(terminal);
      } else {
        await finishActivationUncertain({
          identity,
          leaseToken,
          userOpHash: submittedUserOpHash,
          txHash: receiptTxHash,
        });
      }
    } catch {
      if (submitting) {
        await finishActivationUncertain({
          identity,
          leaseToken,
          userOpHash: submittedUserOpHash,
          txHash: receiptTxHash,
        });
      }
    } finally {
      stopHeartbeat();
    }
  }

  function dispatchMandateActivation(identity) {
    if (!baseExecutionAvailable) return Promise.resolve(false);
    const key = activationIdentityKey(identity);
    const active = activeMandateActivations.get(key);
    if (active) return active;

    let claimed;
    try {
      claimed = mandateActivations.claim({
        ...identity,
        nowSeconds: nowSeconds(),
        leaseSeconds: MANDATE_ACTIVATION_LEASE_SECONDS,
      });
    } catch {
      return Promise.resolve(false);
    }
    if (!claimed) return Promise.resolve(false);

    const running = Promise.resolve()
      .then(() => runMandateActivation(claimed))
      .finally(() => activeMandateActivations.delete(key));
    activeMandateActivations.set(key, running);
    return running;
  }

  function scheduleMandateActivation(identity) {
    queueMicrotask(() => {
      void dispatchMandateActivation(identity).catch(() => {});
    });
  }

  function registrationResponse(result, capability, at) {
    const mandate = result.mandate;
    return {
      cookie: serializeMandateCapabilityCookie({
        mandateId: mandate.mandateId,
        capability,
        maxAgeSeconds: mandate.validUntilSeconds - at,
      }),
      body: {
        ok: true,
        status: 'pending_activation',
        mandateId: mandate.mandateId,
        bindingId: mandate.bindingId,
        bindingHash: mandate.bindingHash,
        relayerOrigin: mandate.relayerOrigin,
      },
    };
  }

  async function handleMandateV3Locked(body, identity, res) {
    const { mandateId } = identity;
    let existing;
    try {
      existing = await mandatesV3.get(identity);
    } catch {
      return sendJson(res, 500, { error: 'internal error' });
    }
    if (existing && !capabilityMatches(body.capability, existing.capabilityHash)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    let capability;
    if (existing) {
      capability = body.capability;
    } else {
      try {
        capability = requireCapability(body.capability);
      } catch {
        return sendJson(res, 400, { error: 'invalid mandate registration' });
      }
    }

    if (existing) {
      let current;
      try {
        current = await mandatesV3.status(identity);
      } catch {
        return sendJson(res, 500, { error: 'internal error' });
      }
      if (!['pending_activation', 'active'].includes(current.status)) {
        return sendJson(res, 409, { error: 'mandate cannot be activated' });
      }
    }

    const at = nowSeconds();
    if (!Number.isSafeInteger(at)
      || !body.serializedApproval || !body.sessionPrivateKey || !body.sessionKeyAddress
      || !body.stellarOwner || !body.kernelAddress
      || !Number.isSafeInteger(body.expiresAt)
      || body.expiresAt <= at
      || body.expiresAt > at + MAX_MANDATE_WINDOW_SECONDS) {
      return sendJson(res, 400, { error: 'invalid mandate registration' });
    }

    const bindingId = existing?.bindingId ?? genId();
    const validationInput = {
      serializedApproval: body.serializedApproval,
      sessionPrivateKey: body.sessionPrivateKey,
      sessionKeyAddress: body.sessionKeyAddress,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
      validUntilSeconds: body.expiresAt,
      expiresAt: body.expiresAt,
      relayerOrigin,
      config: mandateStatusConfig,
      now: at,
    };
    const parsed = validateMandateBinding(validationInput);
    if (!parsed.ok) {
      return sendJson(res, 400, { error: 'invalid mandate registration' });
    }
    const bindingHash = computeBindingHash({
      stellarOwner: body.stellarOwner,
      kernelAddress: parsed.mandate.accountAddress,
      sessionKeyAddress: parsed.mandate.sessionKeyAddress,
      expiresAt: body.expiresAt,
    });
    const validation = validateMandateBinding({
      ...validationInput,
      sessionKeyAddress: parsed.mandate.sessionKeyAddress,
      kernelAddress: parsed.mandate.accountAddress,
      bindingId,
      bindingHash,
    });
    if (!validation.ok) {
      return sendJson(res, 400, { error: 'invalid mandate registration' });
    }

    const registrationRecord = {
      mandateId,
      approvalDigest: sha256(body.serializedApproval),
      policyDigest: validation.mandate.policyDigest,
      serializedApproval: body.serializedApproval,
      sessionPrivateKey: body.sessionPrivateKey,
      sessionKeyAddress: validation.mandate.sessionKeyAddress,
      capabilityHash: hashCapability(capability),
      stellarOwner: body.stellarOwner,
      kernelAddress: validation.mandate.accountAddress,
      relayerOrigin,
      validUntilSeconds: body.expiresAt,
      bindingId,
      bindingHash,
      permissionId: validation.mandate.permissionId,
    };

    let result;
    try {
      result = await mandateActivations.enqueue({ record: registrationRecord });
    } catch (error) {
      if (existing) {
        return sendJson(
          res,
          isImmutableMandateConflict(error) ? 409 : 500,
          { error: isImmutableMandateConflict(error) ? 'immutable mandate conflict' : 'internal error' },
        );
      }

      // Another router/process may have won the atomic enqueue after this request's pre-read.
      // Re-read and authenticate that durable winner before retrying immutable comparison with
      // its binding ID. A wrong-capability loser never receives state and never becomes a replay.
      let winner;
      let winnerStatus;
      try {
        winner = await mandatesV3.get(identity);
        if (!winner) return sendJson(res, 500, { error: 'internal error' });
        if (!capabilityMatches(capability, winner.capabilityHash)) {
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        winnerStatus = await mandatesV3.status(identity);
      } catch {
        return sendJson(res, 500, { error: 'internal error' });
      }
      if (!['pending_activation', 'active'].includes(winnerStatus.status)) {
        return sendJson(res, 409, { error: 'mandate cannot be activated' });
      }
      try {
        result = await mandateActivations.enqueue({
          record: { ...registrationRecord, bindingId: winner.bindingId },
        });
      } catch (retryError) {
        return sendJson(
          res,
          isImmutableMandateConflict(retryError) ? 409 : 500,
          { error: isImmutableMandateConflict(retryError) ? 'immutable mandate conflict' : 'internal error' },
        );
      }
    }

    if (!['pending_activation', 'active'].includes(result.mandate.status)) {
      return sendJson(res, 409, { error: 'mandate cannot be activated' });
    }
    const response = registrationResponse(result, capability, at);
    res.setHeader('Set-Cookie', response.cookie);
    sendJson(res, 202, response.body);
    if (result.work?.status === 'pending') scheduleMandateActivation(identity);
  }

  async function withMandateRegistrationLock(mandateId, action) {
    const previous = activeMandateRegistrations.get(mandateId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    activeMandateRegistrations.set(mandateId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (activeMandateRegistrations.get(mandateId) === tail) {
        activeMandateRegistrations.delete(mandateId);
      }
    }
  }

  async function handleMandateV3(req, res) {
    const body = req.body || {};
    let mandateId;
    try {
      mandateId = requireMandateId(body.mandateId);
    } catch {
      return sendJson(res, 400, { error: 'invalid mandate registration' });
    }
    const identity = {
      mandateId,
      stellarOwner: body.stellarOwner,
      kernelAddress: body.kernelAddress,
    };
    return withMandateRegistrationLock(
      mandateId,
      () => handleMandateV3Locked(body, identity, res),
    );
  }

  function handleMandate(req, res) {
    if (!baseExecutionAvailable) return baseUnavailable(res);
    if (!mandatesV3 || !mandateActivations || !buildMandateActivator || !mandateStatusConfig) {
      return sendJson(res, 503, { error: 'mandate activation is unavailable' });
    }
    return handleMandateV3(req, res);
  }

  async function resumeMandateActivations() {
    if (!baseExecutionAvailable) return { resumed: [], held: [] };
    if (!mandateActivations) return;
    await mandateActivations.reconcileExpired({ nowSeconds: nowSeconds() });
    const recoverable = await mandateActivations.listRecoverable({ nowSeconds: nowSeconds() });
    await Promise.all(recoverable.map((work) => dispatchMandateActivation({
      mandateId: work.mandateId,
      stellarOwner: work.stellarOwner,
      kernelAddress: work.kernelAddress,
    })));
  }

  // Public permission evidence never contains authority material. A failed fresh read is mapped
  // to one fixed unknown shape so RPC/provider diagnostics cannot cross the HTTP boundary.
  function unknownMandateStatus(reasonCode) {
    return {
      version: 2,
      status: 'unknown',
      reasonCodes: [reasonCode],
      expected: {},
      observed: {},
      checks: {},
    };
  }

  async function evaluateStoredMandate(record) {
    if (!record || !mandateStatusConfig) return unknownMandateStatus(record ? 'STATUS_UNAVAILABLE' : 'MANDATE_MISSING');
    try {
      return await evaluateMandateStatusFn({
        record: cloneForMandateEvaluation(record),
        config: mandateStatusConfig,
      });
    } catch {
      return unknownMandateStatus('STATUS_ERROR');
    }
  }

  function mandateIdentity(body) {
    try {
      return {
        mandateId: requireMandateId(body?.mandateId),
        stellarOwner: body?.stellarOwner,
        kernelAddress: body?.kernelAddress,
      };
    } catch {
      return null;
    }
  }

  async function authenticateMandate(
    req,
    identity,
    { activeOnly = false, loadRecord = true } = {},
  ) {
    const capability = parseBearerCapability(req?.headers?.authorization);
    if (!capability || !identity?.mandateId || !identity?.stellarOwner || !identity?.kernelAddress) {
      return null;
    }
    try {
      const authority = await mandatesV3.authority(identity.mandateId);
      if (!authority || !capabilityMatches(capability, authority.capabilityHash)
        || authority.stellarOwner !== identity.stellarOwner
        || String(authority.kernelAddress).toLowerCase() !== String(identity.kernelAddress).toLowerCase()
        || (activeOnly && authority.status !== 'active')) {
        return null;
      }
      const durable = await mandatesV3.status(identity);
      if (activeOnly && durable.status !== 'active') return null;
      if (!loadRecord) {
        return { authority, capability, durable, identity, record: null };
      }
      const record = await mandatesV3.get(identity);
      if (!record) return null;
      const durableAfterLoad = await mandatesV3.status(identity);
      if (activeOnly && durableAfterLoad.status !== 'active') return null;
      return { authority, capability, durable: durableAfterLoad, identity, record };
    } catch {
      return null;
    }
  }

  async function authenticateMandateAuthority(req, mandateId, { activeOnly = false } = {}) {
    const capability = parseBearerCapability(req?.headers?.authorization);
    if (!capability) return null;
    try {
      const authority = await mandatesV3.authority(mandateId);
      if (!authority || !capabilityMatches(capability, authority.capabilityHash)) return null;
      if (activeOnly && authority.status !== 'active') return null;
      return { authority, capability };
    } catch {
      return null;
    }
  }

  function unauthorized(res) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  async function authenticateBodyMandate(
    req,
    res,
    { activeOnly = false, loadRecord = true } = {},
  ) {
    const identity = mandateIdentity(req.body || {});
    const authenticated = await authenticateMandate(req, identity, { activeOnly, loadRecord });
    if (!authenticated) {
      unauthorized(res);
      return null;
    }
    return authenticated;
  }

  async function handleMandateStatus(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const authenticated = await authenticateBodyMandate(req, res, { loadRecord: false });
    if (!authenticated) return;
    try {
      requireExactFields(req.body || {}, MANDATE_STATUS_FIELDS, 'mandate status');
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
    const { durable } = authenticated;
    if (durable.status !== 'active') return sendJson(res, 200, durable);
    let record;
    try {
      record = await mandatesV3.get(authenticated.identity);
      const durableAfterLoad = await mandatesV3.status(authenticated.identity);
      if (durableAfterLoad.status !== 'active') return sendJson(res, 200, durableAfterLoad);
    } catch {
      return sendJson(res, 200, unknownMandateStatus('STATUS_ERROR'));
    }
    if (!record) return sendJson(res, 200, unknownMandateStatus('STATUS_ERROR'));
    if (!canonicalStoredBinding(record, authenticated.identity)) {
      return sendJson(res, 200, unknownMandateStatus('BINDING_INVALID'));
    }
    return sendJson(res, 200, await evaluateStoredMandate(record));
  }

  async function handleMandateRevoke(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const authenticated = await authenticateBodyMandate(req, res, { loadRecord: false });
    if (!authenticated) return;
    try {
      requireExactFields(req.body || {}, MANDATE_STATUS_FIELDS, 'mandate revoke');
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
    const revoked = await mandatesV3.revoke(authenticated.identity);
    if (!revoked || !['revoked', 'expired'].includes(revoked.status)) return unauthorized(res);
    res.setHeader('Set-Cookie', clearMandateCapabilityCookie({ mandateId: authenticated.identity.mandateId }));
    return sendJson(res, 200, {
      ok: true,
      status: revoked.status,
      scope: 'relayer-key-copy',
      note: REVOKE_NOTE,
    });
  }

  // Wire shape from frontend/src/base/relayerClient.js's toWireAllocations: {allocationId,
  // poolAddress, amount:{token,units,decimals}, minShares}. Internal execution keeps the
  // {pool,amount,minShares} shape orchestrator.mjs/farm.mjs already expect — only this boundary
  // translates. Every allocationId is the reviewed `${runId}:bridge:${proxyTarget}` identity;
  // array position is never part of that identity.
  function parseWireAllocations(allocations, runId) {
    const seen = new Set();
    return allocations.map((a) => {
      requireExactFields(a, WIRE_ALLOCATION_FIELDS, 'allocation');
      requireExactFields(a.amount, WIRE_AMOUNT_FIELDS, 'amount');
      const pool = a.poolAddress;
      const units = a.amount?.units;
      if (!a.allocationId || seen.has(a.allocationId)) throw new Error('invalid or duplicate allocationId');
      seen.add(a.allocationId);
      const proxyTarget = poolTargets instanceof Map
        ? poolTargets.get(String(pool || '').toLowerCase())
        : poolTargets?.[String(pool || '').toLowerCase()];
      if (!proxyTarget) throw new Error('poolAddress is not allowlisted');
      if (a.allocationId !== `${runId}:bridge:${proxyTarget}`) {
        throw new Error('allocationId does not match the reviewed run and canonical proxy target');
      }
      if (!pool || !isCanonicalDecimalString(units) || !isCanonicalDecimalString(a.minShares)
        || a.amount?.token !== 'USDC' || a.amount?.decimals !== 6) {
        throw new Error('invalid allocation');
      }
      // minShares MAY legitimately be '0' (a degenerate but real "accept any share price"
      // deposit — see the report for why); amount.units may not, since a zero/absent burn
      // amount is never a real deposit.
      if (BigInt(units) <= 0n) throw new Error('amount.units must be a positive integer string');
      return {
        allocationId: a.allocationId,
        pool,
        amount: BigInt(units),
        minShares: BigInt(a.minShares),
        reportAmount: { token: 'USDC', units: String(units), decimals: 6 },
        proxyTarget,
      };
    });
  }

  function activeAuthorityMatches(authority, expected, identity) {
    return Boolean(authority && expected && identity
      && authority.status === 'active'
      && authority.mandateId === identity.mandateId
      && authority.mandateId === expected.mandateId
      && authority.stellarOwner === identity.stellarOwner
      && authority.stellarOwner === expected.stellarOwner
      && String(authority.kernelAddress).toLowerCase() === String(identity.kernelAddress).toLowerCase()
      && String(authority.kernelAddress).toLowerCase() === String(expected.kernelAddress).toLowerCase()
      && authority.bindingId === expected.bindingId
      && authority.bindingHash === expected.bindingHash
      && authority.relayerOrigin === (expected.relayerOrigin ?? null)
      && authority.validUntilSeconds === expected.validUntilSeconds
      && CAPABILITY_HASH_PATTERN.test(authority.capabilityHash || '')
      && CAPABILITY_HASH_PATTERN.test(expected.capabilityHash || '')
      && authority.capabilityHash === expected.capabilityHash);
  }

  function privateAuthorizedClaimSnapshot(record) {
    if (!record || record.status !== 'active'
        || !CAPABILITY_HASH_PATTERN.test(record.capabilityHash || '')
        || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) return null;
    const snapshot = {
      mandateId: record.mandateId,
      stellarOwner: record.stellarOwner,
      kernelAddress: String(record.kernelAddress).toLowerCase(),
      status: 'active',
      bindingId: record.bindingId,
      bindingHash: record.bindingHash,
      relayerOrigin: record.relayerOrigin ?? null,
      validUntilSeconds: record.validUntilSeconds,
      updatedAt: record.updatedAt,
    };
    Object.defineProperty(snapshot, 'capabilityHash', {
      value: record.capabilityHash,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return Object.freeze(snapshot);
  }

  function activeDurableMatches(durable, authority) {
    return Boolean(durable && authority
      && durable.status === 'active'
      && durable.mandateId === authority.mandateId
      && durable.stellarOwner === authority.stellarOwner
      && String(durable.kernelAddress).toLowerCase() === String(authority.kernelAddress).toLowerCase()
      && durable.bindingId === authority.bindingId
      && durable.bindingHash === authority.bindingHash
      && durable.relayerOrigin === authority.relayerOrigin
      && durable.validUntilSeconds === authority.validUntilSeconds);
  }

  async function reloadActiveAuthority(identity, expected, capability = null) {
    try {
      const authority = await mandatesV3.authority(identity.mandateId);
      if (!activeAuthorityMatches(authority, expected, identity)
        || (capability && !capabilityMatches(capability, authority.capabilityHash))) {
        return null;
      }
      const durable = await mandatesV3.status(identity);
      if (!activeDurableMatches(durable, authority)) return null;
      return { authority, durable };
    } catch {
      return null;
    }
  }

  async function freshActiveMandateGate(authenticated) {
    const canonical = canonicalStoredBinding(authenticated.record, authenticated.identity);
    if (!canonical) return { error: 'mandate binding is not active' };
    const evidence = await evaluateStoredMandate(authenticated.record);
    if (evidence.status !== 'active') return { error: 'mandate evidence is not active' };
    const reloaded = await reloadActiveAuthority(
      authenticated.identity,
      authenticated.record,
      authenticated.capability,
    );
    if (!reloaded) return { error: 'mandate authority changed during evaluation' };
    return { ...authenticated, ...reloaded, canonical, evidence };
  }

  function publicJob(job, jobId) {
    if (!job) return job;
    const { _attach, associationUncertain = false } = job;
    const expected = Array.isArray(_attach?.associations) ? _attach.associations : [];
    const delivery = associationOutbox?.status
      ? expected.flatMap((association) => {
          try { return associationOutbox.status(association.recoveryIdentity); } catch { return []; }
        })
      : [];
    const contiguous = [];
    let coverageComplete = expected.length > 0;
    coverage: for (const { allocationId, terminalSequence } of expected) {
      if (!Number.isSafeInteger(terminalSequence) || terminalSequence < 1) {
        coverageComplete = false;
        break;
      }
      for (let sequence = 1; sequence <= terminalSequence; sequence += 1) {
        const row = delivery.find((candidate) => (
          candidate.allocationId === allocationId && candidate.sequence === sequence
        ));
        if (!row || row.status !== 'delivered') {
          if (row) contiguous.push(row);
          coverageComplete = false;
          break coverage;
        }
        contiguous.push(row);
      }
    }
    const complete = coverageComplete;
    const uncertain = !complete && expected.length > 0 && (
      associationUncertain === true
      || ['done', 'error', 'uncertain'].includes(job.status)
      || expected.some(({ terminalSequence }) => Number.isSafeInteger(terminalSequence))
      || delivery.some(({ status }) => status === 'dead')
    );
    return {
      jobId,
      status: job.status,
      ...(typeof job.runId === 'string' ? { runId: job.runId } : {}),
      ...(typeof job.bridgeAgent === 'string' ? { bridgeAgent: job.bridgeAgent } : {}),
      ...(typeof job.grantTxHash === 'string' ? { grantTxHash: job.grantTxHash } : {}),
      ...(typeof job.executionStatus === 'string'
        ? { executionStatus: job.executionStatus } : {}),
      ...(typeof job.custodyLocation === 'string'
        ? { custodyLocation: job.custodyLocation } : {}),
      associationDelivery: {
        complete,
        uncertain,
        events: complete
          ? contiguous
          : [...contiguous, ...delivery.filter((row) => row.status === 'dead' && !contiguous.includes(row))],
      },
      evidenceDelivery: (() => {
        const statuses = expected.map((association) => {
          try { return baseEvidenceOutbox?.status?.(association.recoveryIdentity) ?? null; }
          catch { return null; }
        }).filter(Boolean);
        const blocked = statuses.some((entry) => entry.blocked === true);
        const evidenceComplete = statuses.length === expected.length && statuses.length > 0
          && statuses.every((entry) => entry.complete === true);
        return {
          complete: evidenceComplete,
          blocked,
          uncertain: !evidenceComplete && !blocked
            && ['done', 'error', 'uncertain'].includes(job.status),
          children: statuses,
        };
      })(),
    };
  }

  function activeRecordMatchesFarmContext(record, identity, attachContext) {
    const canonical = canonicalStoredBinding(record, identity);
    if (!canonical
      || record.status !== 'active'
      || attachContext.bindingId !== record.bindingId
      || attachContext.bindingHash !== record.bindingHash
      || attachContext.stellarOwner !== record.stellarOwner
      || String(attachContext.kernelAddress).toLowerCase() !== String(record.kernelAddress).toLowerCase()) {
      return null;
    }
    return canonical;
  }

  async function revalidateFarmAuthority(attachContext, { loadRecord = true } = {}) {
    const identity = mandateIdentity(attachContext);
    if (!identity) return { error: 'mandate identity is invalid' };
    let record;
    try {
      record = await mandatesV3.get(identity);
    } catch {
      return { error: 'mandate authority is unavailable' };
    }
    if (!record || record.status !== 'active') return { error: 'mandate authority is not active' };
    let canonical = activeRecordMatchesFarmContext(record, identity, attachContext);
    if (!canonical) return { error: 'mandate binding is invalid' };
    const evidence = await evaluateStoredMandate(record);
    if (evidence.status !== 'active') return { error: 'mandate evidence is not active' };
    const reloaded = await reloadActiveAuthority(identity, record);
    if (!reloaded) return { error: 'mandate authority changed during evaluation' };
    if (!loadRecord) return { identity, record: null, evidence, ...reloaded };

    // The pre-evaluation record is deliberately discarded. Reopen the key only after the
    // post-await authority fence, then check once more so a revoked envelope is never handed to
    // buildFarm merely because an earlier evaluator result was active.
    try {
      record = await mandatesV3.get(identity);
    } catch {
      return { error: 'mandate authority is unavailable' };
    }
    canonical = activeRecordMatchesFarmContext(record, identity, attachContext);
    if (!canonical) return { error: 'mandate binding is invalid' };
    const finalReload = await reloadActiveAuthority(identity, reloaded.authority);
    if (!finalReload || !activeAuthorityMatches(finalReload.authority, record, identity)) {
      return { error: 'mandate authority changed before key use' };
    }
    return { identity, record, evidence, ...finalReload };
  }

  async function deliverClaimedIntent(claimed) {
    let leaseLost = false;
    let renewal = Promise.resolve();
    const renew = () => {
      renewal = renewal.then(() => farmIntents.renewIntentDelivery({
        jobId: claimed.jobId,
        leaseToken: claimed.leaseToken,
        now: Date.now(),
        leaseMs: FARM_LEASE_MS,
      })).catch(() => { leaseLost = true; });
      return renewal;
    };
    const timer = setInterval(() => { void renew(); }, FARM_HEARTBEAT_MS);
    timer.unref?.();
    try {
      const acknowledgement = await agentIndexReporter.commitIntentBatch(claimed.batch);
      await renewal;
      await renew();
      if (leaseLost) throw new Error('farm intent delivery lease is stale');
      return farmIntents.finishAwaitingBurn({
        jobId: claimed.jobId,
        leaseToken: claimed.leaseToken,
        acknowledgement,
        now: Date.now(),
      });
    } finally {
      clearInterval(timer);
    }
  }

  function terminalizeIntentDelivery(record, error) {
    const reasonCode = error instanceof AgentIndexBatchConflictError
      ? 'agent_index_intent_conflict' : 'agent_index_intent_invalid';
    return farmIntents.advanceProjection({
      identity: {
        mandateId: record.mandateId,
        jobId: record.jobId,
        bindingId: record.bindingId,
        intentDigest: record.intentDigest,
      },
      from: 'intent_pending', to: 'blocked', reasonCode, now: Date.now(),
    });
  }

  async function resumeFarmJobs() {
    if (!baseExecutionAvailable) {
      return { resumed: [], held: [], blocked: [], uncertain: [] };
    }
    if (!farmIntents) throw new Error('durable forward farm intent store is unavailable');
    if (activeFarmResumeV2) return activeFarmResumeV2;
    activeFarmResumeV2 = resumeFarmIntentsV2().finally(() => { activeFarmResumeV2 = null; });
    return activeFarmResumeV2;
  }

  async function resumeFarmIntentsV2() {
    if (!Number.isSafeInteger(recoveryLimit) || recoveryLimit < 1 || recoveryLimit > 1_000
        || !Number.isSafeInteger(recoveryConcurrency) || recoveryConcurrency < 1 || recoveryConcurrency > 32) {
      throw new Error('farm recovery bounds are invalid');
    }
    const at = Date.now();
    farmIntents.quarantineLegacyActive?.({ now: at, limit: recoveryLimit });
    farmIntents.reconcileExpired({ now: at, limit: recoveryLimit });
    const work = farmIntents.listRecoverable({ now: at, limit: recoveryLimit });
    const result = { resumed: [], held: [], blocked: [], uncertain: [] };
    let cursor = 0;
    async function process(record) {
      const stopForMalformedProjection = (projected) => {
        if (projected?.state !== 'blocked'
            || projected.reasonCode !== 'malformed_public_projection') return false;
        result.blocked.push(record.jobId);
        return true;
      };
      const identity = {
        mandateId: record.mandateId,
        stellarOwner: record.stellarOwner,
        kernelAddress: record.kernelAddress,
      };
      const projectionIdentity = {
        mandateId: record.mandateId,
        jobId: record.jobId,
        bindingId: record.bindingId,
        intentDigest: record.intentDigest,
      };
      if (record.corrupt === true) {
        farmIntents.advanceProjection({
          identity: projectionIdentity, from: record.state, to: 'blocked',
          reasonCode: 'malformed_recovery_record', now: Date.now(),
        });
        result.blocked.push(record.jobId);
        return;
      }
      if (record.state === 'intent_pending') {
        let mandate;
        try {
          const durable = await mandatesV3.status(identity);
          mandate = durable.status === 'active' ? await mandatesV3.get(identity) : null;
          if (!mandate || !canonicalStoredBinding(mandate, identity)
              || (await evaluateStoredMandate(mandate)).status !== 'active') {
            farmIntents.advanceProjection({
              identity: projectionIdentity,
              from: 'intent_pending',
              to: 'blocked',
              reasonCode: 'mandate_inactive',
              now: Date.now(),
            });
            result.blocked.push(record.jobId);
            return;
          }
          const claimed = farmIntents.claimIntentDelivery({
            jobId: record.jobId, now: Date.now(), leaseMs: FARM_LEASE_MS,
          });
          if (!claimed) {
            result.held.push(record.jobId);
            return;
          }
          try {
            await deliverClaimedIntent(claimed);
            result.resumed.push(record.jobId);
          } catch (error) {
            if (error instanceof AgentIndexBatchConflictError
                || error instanceof AgentIndexBatchPermanentError) {
              terminalizeIntentDelivery(record, error);
              result.blocked.push(record.jobId);
              return;
            }
            try {
              farmIntents.releaseIntentDelivery({
                jobId: record.jobId, leaseToken: claimed.leaseToken, now: Date.now(),
              });
            } catch {}
            result.held.push(record.jobId);
          }
        } catch {
          result.held.push(record.jobId);
        }
        return;
      }
      if (record.state === 'relay_pending') {
        const relay = cctpRelays?.get?.(record.relayExecId);
        if (!relay) {
          farmIntents.advanceProjection({
            identity: projectionIdentity, from: 'relay_pending', to: 'blocked',
            reasonCode: 'cctp_record_missing', now: Date.now(),
          });
          result.blocked.push(record.jobId);
        } else if (relay.state === 'blocked' || relay.state === 'uncertain') {
          const projected = farmIntents.advanceProjection({
            identity: projectionIdentity,
            from: 'relay_pending',
            to: relay.state,
            reasonCode: relay.reasonCode,
            now: Date.now(),
          });
          if (stopForMalformedProjection(projected)) return;
          result[relay.state].push(record.jobId);
        } else if (relay.state === 'minted') {
          record = farmIntents.projectMintEvidenceAtomic({
            identity: projectionIdentity, relay, now: Date.now(),
          });
          if (stopForMalformedProjection(record)) return;
        } else {
          // Task 8 reconciliation owns polling/submission/known-hash confirmation and ran first.
          result.held.push(record.jobId);
          return;
        }
        if (record.state !== 'deposit_pending') return;
      }
      if (record.state === 'deposit_pending' || record.state === 'deposit_confirming') {
        const attachContext = {
          mandateId: record.mandateId,
          stellarOwner: record.stellarOwner,
          kernelAddress: record.kernelAddress,
          bindingId: record.bindingId,
          bindingHash: record.bindingHash,
        };
        let children;
        try {
          children = record.intent.allocations.map((allocation) => {
            const identityWithChild = {
              networkId: record.intent.networkId,
              bindingId: record.bindingId,
              executionId: allocation.executionId,
              allocationId: allocation.allocationId,
              childId: allocation.childId,
            };
            return {
              allocation: {
                identity: identityWithChild,
                caller: record.kernelAddress,
                pool: allocation.poolAddress,
                amount: BigInt(allocation.units),
                minShares: BigInt(allocation.minShares),
              },
              recovery: baseEvidenceOutbox?.recoveryState?.(identityWithChild) ?? null,
            };
          });
        } catch (error) {
          if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) {
            throw error;
          }
          farmIntents.advanceProjection({
            identity: projectionIdentity, from: record.state, to: 'blocked',
            reasonCode: 'malformed_recovery_record', now: Date.now(),
          });
          result.blocked.push(record.jobId);
          return;
        }
        if (children.some(({ recovery }) => !recovery)) {
          farmIntents.advanceProjection({
            identity: projectionIdentity, from: record.state, to: 'blocked',
            reasonCode: 'base_checkpoint_missing', now: Date.now(),
          });
          result.blocked.push(record.jobId);
          return;
        }
        const submittedMismatch = children.some(({ allocation, recovery }) => {
          if (recovery.phase !== 'base_deposit' || recovery.state !== 'submitted') return false;
          const expected = {
            chainId: String(mandateStatusConfig?.base?.chain?.id),
            yieldRouterAddress: String(
              mandateStatusConfig?.base?.mandatePolicy?.yieldRouterAddress,
            ).toLowerCase(),
            caller: allocation.caller,
            poolAddress: allocation.pool,
            assets: allocation.amount.toString(10),
            minShares: allocation.minShares.toString(10),
          };
          return !/^0x[0-9a-f]{64}$/.test(recovery.evidence?.userOpHash || '')
            || Object.entries(expected).some(([field, value]) => recovery.evidence?.[field] !== value);
        });
        if (submittedMismatch) {
          const projected = farmIntents.advanceProjection({
            identity: projectionIdentity, from: record.state, to: 'uncertain',
            reasonCode: 'submitted_evidence_conflict', now: Date.now(),
          });
          if (stopForMalformedProjection(projected)) return;
          result.uncertain.push(record.jobId);
          return;
        }
        let projectionState = record.state;
        if (projectionState === 'deposit_pending') {
          const projected = farmIntents.advanceProjection({
            identity: projectionIdentity, from: 'deposit_pending', to: 'deposit_confirming',
            now: Date.now(),
          });
          if (stopForMalformedProjection(projected)) return;
          projectionState = 'deposit_confirming';
        }
        const depositResults = [];
        let holdLater = false;
        for (const child of children) {
          if (child.recovery.phase === 'base_deposit' && child.recovery.state === 'confirmed') {
            depositResults.push({
              identity: child.allocation.identity,
              allocationId: child.allocation.identity.allocationId,
              pool: child.allocation.pool,
              status: 'fulfilled', executionStatus: 'deposited',
              custody: { location: 'base-proxy' }, recovered: true,
            });
            continue;
          }
          if (holdLater) {
            depositResults.push({
              identity: child.allocation.identity,
              allocationId: child.allocation.identity.allocationId,
              pool: child.allocation.pool,
              status: 'held', executionStatus: 'held',
              reasonCode: 'not_dispatched_after_unknown', custody: { location: 'agent' },
            });
            continue;
          }
          if (child.recovery.phase === 'base_deposit'
              && ['submitting', 'unknown'].includes(child.recovery.state)) {
            holdLater = true;
            depositResults.push({
              identity: child.allocation.identity,
              allocationId: child.allocation.identity.allocationId,
              pool: child.allocation.pool,
              status: 'uncertain', executionStatus: 'unknown',
              reasonCode: `recovery_${child.recovery.state}`, custody: { location: 'agent' },
            });
            continue;
          }

          // Every actionable child gets a new post-await authority reload and a newly
          // reconstructed client. No key survives receipt waits from an earlier child.
          const authority = await revalidateFarmAuthority(attachContext);
          if (authority.error) {
            farmIntents.advanceProjection({
              identity: projectionIdentity, from: projectionState, to: 'blocked',
              reasonCode: 'mandate_inactive', now: Date.now(),
            });
            result.blocked.push(record.jobId);
            return;
          }
          const flow = buildFarm(authority.record.sessionPrivateKey);
          if (typeof flow?.recoverDeposits !== 'function') {
            throw new Error('Base recovery flow is not configured');
          }
          const [entry] = await flow.recoverDeposits({
            approval: authority.record.serializedApproval,
            children: [child],
            onBeforeClaimSubmitting: async () => {
              const refreshed = await revalidateFarmAuthority(attachContext);
              const authoritySnapshot = privateAuthorizedClaimSnapshot(refreshed.record);
              if (refreshed.error || !authoritySnapshot || !activeAuthorityMatches(
                refreshed.authority, authority.record, refreshed.identity,
              )) return false;
              return { authorized: true, authoritySnapshot };
            },
            onClaimSubmitting: async (checkpoint, { authoritySnapshot } = {}) => (
              farmIntents.claimAuthorizedSubmission({
                checkpoint, authoritySnapshot, nowSeconds: nowSeconds(),
              })
            ),
            onCheckpoint: async (checkpoint, ownership) => (ownership?.ownerToken
              ? baseEvidenceOutbox.enqueueOwned(checkpoint, ownership)
              : baseEvidenceOutbox.enqueue(checkpoint)),
          });
          depositResults.push(entry);
          if (entry?.status !== 'fulfilled') {
            holdLater = true;
          }
        }
        const hasUncertain = depositResults.some((entry) => entry?.status === 'uncertain');
        const allFulfilled = depositResults.length === children.length
          && depositResults.every((entry) => entry?.status === 'fulfilled');
        if (allFulfilled) {
          const projected = farmIntents.advanceProjection({
            identity: projectionIdentity, from: projectionState, to: 'done', now: Date.now(),
          });
          if (stopForMalformedProjection(projected)) return;
          result.resumed.push(record.jobId);
        } else if (hasUncertain) {
          const projected = farmIntents.advanceProjection({
            identity: projectionIdentity, from: projectionState, to: 'uncertain',
            reasonCode: 'base_recovery_uncertain', now: Date.now(),
          });
          if (stopForMalformedProjection(projected)) return;
          result.uncertain.push(record.jobId);
        } else {
          result.held.push(record.jobId);
        }
        return;
      }
      result.held.push(record.jobId);
    }
    const workers = Array.from({ length: Math.min(recoveryConcurrency, work.length) }, async () => {
      while (cursor < work.length) {
        const index = cursor;
        cursor += 1;
        await process(work[index]);
      }
    });
    await Promise.all(workers);
    const originalIndex = new Map(work.map(({ jobId }, index) => [jobId, index]));
    for (const values of Object.values(result)) {
      values.sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
    }
    return result;
  }

  async function handleFarm(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const preauthenticated = await authenticateBodyMandate(
      req, res, { activeOnly: true, loadRecord: false },
    );
    if (!preauthenticated) return;
    if (!baseExecutionAvailable) return baseUnavailable(res);
    const authenticated = await authenticateMandate(
      req, preauthenticated.identity, { activeOnly: true, loadRecord: true },
    );
    if (!authenticated) return unauthorized(res);
    if (!farmIntents) {
      return sendJson(res, 503, { error: 'forward farm intent store is unavailable' });
    }
    return handleFarmV2(req, res, authenticated);
  }

  async function handleFarmV2(req, res, authenticated) {
    try {
      requireExactFields(req.body || {}, FARM_V2_FIELDS, 'farm');
    } catch (error) {
      return sendJson(res, 400, { error: errorMessage(error) });
    }
    const gate = await freshActiveMandateGate(authenticated);
    if (gate.error) return sendJson(res, 409, { error: 'Base mandate evidence is not active' });
    if (!forwardFarmDeployment || !agentIndexReporter?.commitIntentBatch) {
      return sendJson(res, 503, { error: 'Base child intent is unavailable' });
    }
    let normalizedIntent;
    try {
      const jobId = genId();
      normalizedIntent = buildForwardFarmIntent({
        jobId,
        observedAt: nowSeconds(),
        request: req.body,
        mandate: gate.record,
        deployment: forwardFarmDeployment,
      });
    } catch {
      return sendJson(res, 400, { error: 'invalid forward farm intent' });
    }
    try {
      const created = farmIntents.createOrGetIntent({ normalizedIntent, now: Date.now() });
      normalizedIntent = {
        intent: created.record.intent,
        expectation: created.record.expectation,
        batch: created.record.batch,
        intentDigest: created.record.intentDigest,
        expectationDigest: created.record.expectationDigest,
        batchIdempotencyKey: created.record.batchIdempotencyKey,
        batchDigest: created.record.batchDigest,
      };
    } catch (error) {
      return sendJson(res, error?.code === 'FARM_INTENT_CONFLICT' ? 409 : 503, {
        error: error?.code === 'FARM_INTENT_CONFLICT'
          ? 'immutable forward farm intent conflict'
          : 'forward farm intent store is unavailable',
      });
    }
    const jobId = normalizedIntent.intent.jobId;
    let record;
    try {
      record = farmIntents.getByJob({ mandateId: req.body.mandateId, jobId });
    } catch {
      return sendJson(res, 503, { error: 'forward farm intent store is unavailable' });
    }
    if (record.state === 'awaiting_burn') {
      return sendJson(res, 201, {
        jobId,
        acknowledged: true,
        status: 'awaiting_burn',
        schemaVersion: record.acknowledgement.schemaVersion,
      });
    }
    if (record.state !== 'intent_pending') {
      return sendJson(res, 409, { error: 'forward farm intent is not burn-ready' });
    }
    let delivery = activeIntentDeliveries.get(jobId);
    if (!delivery) {
      delivery = (async () => {
        const claimed = farmIntents.claimIntentDelivery({
          jobId, now: Date.now(), leaseMs: FARM_LEASE_MS,
        });
        if (!claimed) return null;
        try {
          return await deliverClaimedIntent(claimed);
        } catch (error) {
          if (error instanceof AgentIndexBatchConflictError
              || error instanceof AgentIndexBatchPermanentError) {
            return terminalizeIntentDelivery(claimed, error);
          }
          try {
            farmIntents.releaseIntentDelivery({
              jobId, leaseToken: claimed.leaseToken, now: Date.now(),
            });
          } catch {
            // A stale owner or exact acknowledgement retry decides the durable state.
          }
          throw error;
        }
      })().finally(() => activeIntentDeliveries.delete(jobId));
      activeIntentDeliveries.set(jobId, delivery);
    }
    try {
      record = await delivery;
    } catch {
      return sendJson(res, 503, { error: 'Base child intent is unavailable' });
    }
    if (!record) return sendJson(res, 202, { jobId, acknowledged: false, status: 'intent_pending' });
    if (record.state === 'blocked') {
      return sendJson(res, 409, { error: 'forward farm intent is not burn-ready' });
    }
    return sendJson(res, 201, {
      jobId,
      acknowledged: true,
      status: 'awaiting_burn',
      schemaVersion: record.acknowledgement.schemaVersion,
    });
  }

  async function handleFarmAttach(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (farmIntents) return handleFarmAttachV2(req, res);
    const authenticated = await authenticateBodyMandate(
      req, res, { activeOnly: true, loadRecord: false },
    );
    if (!authenticated) return;
    if (!baseExecutionAvailable) return baseUnavailable(res);
    return sendJson(res, 503, { error: 'forward farm intent store is unavailable' });
  }

  async function handleFarmAttachV2(req, res) {
    const body = req.body || {};
    const preauthenticated = await authenticateMandateAuthority(req, body.mandateId, { activeOnly: false });
    if (!preauthenticated) return unauthorized(res);
    if (!baseExecutionAvailable) return baseUnavailable(res);
    try {
      requireExactFields(body, FARM_ATTACH_V2_FIELDS, 'farm attach');
    } catch (error) {
      return sendJson(res, 400, { error: errorMessage(error) });
    }
    if (!JOB_ID_PATTERN.test(body.jobId || '') || !/^[0-9a-f]{64}$/.test(body.burnTxHash || '')) {
      return sendJson(res, 400, { error: 'invalid farm attachment' });
    }
    let intent;
    try {
      intent = farmIntents.getByJob({ mandateId: body.mandateId, jobId: body.jobId });
    } catch {
      return sendJson(res, 503, { error: 'forward farm intent store is unavailable' });
    }
    if (!intent) return sendJson(res, 404, { error: 'unknown jobId' });
    const identity = {
      mandateId: intent.mandateId,
      stellarOwner: intent.stellarOwner,
      kernelAddress: intent.kernelAddress,
    };
    const authenticated = await authenticateMandate(req, identity, { activeOnly: true, loadRecord: true });
    if (!authenticated) return unauthorized(res);
    const gate = await freshActiveMandateGate(authenticated);
    if (gate.error) return sendJson(res, 409, { error: 'Base mandate evidence is not active' });
    if (gate.record.bindingId !== intent.bindingId
        || gate.record.bindingHash !== intent.bindingHash
        || gate.record.stellarOwner !== intent.stellarOwner
        || String(gate.record.kernelAddress).toLowerCase() !== intent.kernelAddress) {
      return sendJson(res, 409, { error: 'farm attach mandate binding mismatch' });
    }
    let attached;
    try {
      attached = farmIntents.attachBurnAtomic({
        identity: {
          mandateId: intent.mandateId,
          jobId: intent.jobId,
          bindingId: intent.bindingId,
          intentDigest: intent.intentDigest,
        },
        burnTxHash: body.burnTxHash,
        now: Date.now(),
      });
    } catch (error) {
      const conflict = /conflict|different|belongs|burn-ready/i.test(errorMessage(error));
      return sendJson(res, conflict ? 409 : 503, {
        error: conflict ? 'farm attachment conflict' : 'farm attachment unavailable',
      });
    }
    if (!attached.duplicate && typeof relayForwardMint === 'function') {
      const record = attached.record;
      queueMicrotask(() => {
        void Promise.resolve(relayForwardMint({
          execId: record.relayExecId,
          sourceDomain: record.expectation.sourceDomain,
          burnTxHash: record.burnTxHash,
          expectation: record.expectation,
        })).catch(() => {});
      });
    }
    return sendJson(res, 202, {
      jobId: intent.jobId,
      attached: true,
      status: 'relay_pending',
    });
  }

  async function handleStatus(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};
    if (Object.hasOwn(body, 'jobId') && !Object.hasOwn(body, 'mandateId')) {
      if (Object.keys(body).length !== 1) {
        return sendJson(res, 400, { error: 'invalid status request' });
      }
      return handleUnwindStatus(req, res);
    }

    let mandateId;
    try {
      mandateId = requireMandateId(body.mandateId);
    } catch {
      return unauthorized(res);
    }
    const authenticated = await authenticateMandateAuthority(req, mandateId, { activeOnly: true });
    if (!authenticated) return unauthorized(res);
    try {
      requireExactFields(body, FARM_STATUS_FIELDS, 'farm status');
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
    if (typeof body.jobId !== 'string' || !JOB_ID_PATTERN.test(body.jobId)) {
      return sendJson(res, 400, { error: 'invalid jobId' });
    }

    if (farmIntents) {
      let intent;
      try {
        intent = farmIntents.getByJob({ mandateId, jobId: body.jobId });
      } catch {
        return sendJson(res, 503, { error: 'forward farm intent store is unavailable' });
      }
      if (!intent) return sendJson(res, 404, { error: 'unknown jobId' });
      const mandate = authenticated.authority;
      if (intent.mandateId !== mandateId
          || intent.stellarOwner !== mandate.stellarOwner
          || String(intent.kernelAddress).toLowerCase() !== String(mandate.kernelAddress).toLowerCase()
          || intent.bindingId !== mandate.bindingId
          || intent.bindingHash !== mandate.bindingHash) {
        return unauthorized(res);
      }
      const projection = jobs.get(body.jobId);
      if (!projection) return sendJson(res, 503, { error: 'forward farm projection is unavailable' });
      return sendJson(res, 200, publicJob(projection, body.jobId));
    }
    return sendJson(res, 503, { error: 'forward farm intent store is unavailable' });

  }

  function authenticateUnwindAuthority(req, jobId, at) {
    let canonicalJobId;
    try {
      canonicalJobId = requireUnwindJobId(jobId);
    } catch {
      return null;
    }
    const capability = parseBearerCapability(req?.headers?.authorization);
    if (!Number.isSafeInteger(at) || at < 0 || !capability
        || typeof req?.headers?.cookie === 'string'
        || !unwindJobs || typeof unwindJobs.getAuthority !== 'function') return null;
    let authority;
    try {
      authority = unwindJobs.getAuthority(canonicalJobId);
    } catch {
      return null;
    }
    if (!authority || !Number.isSafeInteger(authority.capabilityExpiresAt)
        || authority.capabilityExpiresAt <= at
        || !capabilityMatches(capability, authority.capabilityHash)) return null;
    // The raw bearer is authentication input only. Do not retain or forward it past the
    // timing-safe comparison seam; every downstream RPC/store call receives authority facts.
    return { authority };
  }

  function handleUnwindStatus(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};
    const at = nowMs();
    const authenticated = authenticateUnwindAuthority(req, body.jobId, at);
    if (!authenticated) return unauthorized(res);
    if (typeof unwindJobs.reconcileFromCctp !== 'function') {
      return sendJson(res, 503, { error: 'unwind relay is unavailable' });
    }
    try {
      const projection = unwindJobs.reconcileFromCctp({ jobId: body.jobId, now: at });
      if (!projection) return unauthorized(res);
      return sendJson(res, 200, projection);
    } catch {
      return sendJson(res, 503, { error: 'unwind relay is unavailable' });
    }
  }

  function handleUnwind(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!baseExecutionAvailable) return baseUnavailable(res);
    if (!unwindAttachStackReady()) {
      return sendJson(res, 503, { error: 'unwind relay is unavailable' });
    }
    try {
      requireExactFields(req.body || {}, UNWIND_RESERVE_FIELDS, 'unwind reserve');
      const { jobId, capability, kernelAddress, recipientHint } = req.body;
      requireUnwindJobId(jobId);
      requireCapability(capability);
      if (typeof kernelAddress !== 'string' || !EVM_ADDRESS_PATTERN.test(kernelAddress)) {
        throw new Error('invalid unwind reserve');
      }
      const normalizedKernel = kernelAddress.toLowerCase();
      if (normalizedKernel === ZERO_EVM_ADDRESS
          || (typeof recipientHint !== 'string'
            || (!StrKey.isValidEd25519PublicKey(recipientHint)
              && !StrKey.isValidContract(recipientHint)))) {
        throw new Error('invalid unwind reserve');
      }
      if (!Number.isSafeInteger(unwindCookieMaxAgeSeconds)
          || unwindCookieMaxAgeSeconds <= 0
          || unwindCookieMaxAgeSeconds > MAX_UNWIND_COOKIE_AGE_SECONDS
          || !Number.isSafeInteger(unwindBurnMaxAgeSeconds)
          || unwindBurnMaxAgeSeconds <= 0
          || !Number.isSafeInteger(unwindEvidenceRetryMs)
          || unwindEvidenceRetryMs <= 0
          || unwindBurnMaxAgeSeconds * 1000 + unwindEvidenceRetryMs
            > unwindCookieMaxAgeSeconds * 1000) {
        return sendJson(res, 503, { error: 'unwind relay is unavailable' });
      }
      const at = nowMs();
      const expiresAt = at + unwindBurnMaxAgeSeconds * 1000;
      const capabilityExpiresAt = at + unwindCookieMaxAgeSeconds * 1000;
      if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(expiresAt)
          || !Number.isSafeInteger(capabilityExpiresAt)) {
        return sendJson(res, 503, { error: 'unwind relay is unavailable' });
      }
      const reserveJson = JSON.stringify({
        jobId,
        kernelAddress: normalizedKernel,
        recipientHint,
      });
      const requestDigest = createHash('sha256')
        .update(`vf-unwind-reserve-v1\0${reserveJson}`, 'utf8').digest('hex');
      const reserved = unwindJobs.reserve({
        jobId,
        capabilityHash: hashCapability(capability),
        kernelAddress: normalizedKernel,
        recipientHint,
        requestDigest,
        expiresAt,
        capabilityExpiresAt,
        now: at,
      });
      const remainingCookieSeconds = Math.floor((reserved?.capabilityExpiresAt - at) / 1000);
      if (!Number.isSafeInteger(remainingCookieSeconds)
          || remainingCookieSeconds <= 0
          || remainingCookieSeconds > unwindCookieMaxAgeSeconds) {
        return sendJson(res, 503, { error: 'unwind relay is unavailable' });
      }
      res.setHeader('Set-Cookie', serializeUnwindCapabilityCookie({
        jobId, capability, maxAgeSeconds: remainingCookieSeconds,
      }));
      return sendJson(res, 202, { jobId: reserved.jobId, status: 'awaiting_burn' });
    } catch (error) {
      if (error?.code === 'UNWIND_UNAUTHORIZED') return unauthorized(res);
      if (['UNWIND_CONFLICT', 'UNWIND_CAS_CONFLICT'].includes(error?.code)) {
        return sendJson(res, 409, { error: 'unwind reservation conflict' });
      }
      if (error?.code === 'UNWIND_VALIDATION'
          || /invalid unwind|unexpected unwind/i.test(errorMessage(error))) {
        return sendJson(res, 400, { error: 'invalid unwind reserve' });
      }
      return sendJson(res, 503, { error: 'unwind relay is unavailable' });
    }
  }

  async function handleUnwindAttach(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    let jobId;
    let userOpHash;
    let unwindTxHash;
    try {
      requireExactFields(req.body || {}, UNWIND_ATTACH_FIELDS, 'unwind attach');
      jobId = requireUnwindJobId(req.body.jobId);
      userOpHash = canonicalUserOpHash(req.body.userOpHash);
      unwindTxHash = canonicalTxHash(req.body.unwindTxHash);
      if (!userOpHash || !unwindTxHash) throw new Error('invalid unwind attach');
    } catch {
      return sendJson(res, 400, { error: 'invalid unwind attach' });
    }

    const at = nowMs();
    const authenticated = authenticateUnwindAuthority(req, jobId, at);
    if (!authenticated) return unauthorized(res);
    if (!baseExecutionAvailable) return baseUnavailable(res);
    if (!unwindAttachStackReady()) {
      return sendJson(res, 503, { error: 'unwind relay is unavailable' });
    }

    const authority = authenticated.authority;
    if (authority.userOpHash !== null || authority.unwindTxHash !== null) {
      if (authority.userOpHash !== userOpHash || authority.unwindTxHash !== unwindTxHash) {
        return sendJson(res, 409, { error: 'unwind attachment conflict' });
      }
      try {
        const projection = typeof unwindJobs.reconcileFromCctp === 'function'
          ? unwindJobs.reconcileFromCctp({ jobId, now: at })
          : unwindJobs.status(jobId);
        if (!projection) return unauthorized(res);
        return sendJson(res, 202, projection);
      } catch {
        return sendJson(res, 503, { error: 'unwind relay is unavailable' });
      }
    }

    let claimed;
    try {
      claimed = unwindJobs.claimEvidence({
        jobId,
        userOpHash,
        unwindTxHash,
        now: at,
        leaseMs: UNWIND_EVIDENCE_LEASE_MS,
        retryMs: unwindEvidenceRetryMs,
      });
    } catch (error) {
      if (['UNWIND_CONFLICT', 'UNWIND_CAS_CONFLICT'].includes(error?.code)) {
        return sendJson(res, 409, { error: 'unwind attachment conflict' });
      }
      return sendJson(res, 503, { error: 'unwind relay is unavailable' });
    }
    if (!claimed) return sendJson(res, 409, { error: 'unwind attachment conflict' });

    let stopped = false;
    const heartbeat = setInterval(() => {
      if (stopped) return;
      try {
        unwindJobs.renewEvidence({
          jobId,
          leaseToken: claimed.leaseToken,
          now: nowMs(),
          leaseMs: UNWIND_EVIDENCE_LEASE_MS,
        });
      } catch {
        // The final fenced attach observes the durable lease loss.
      }
    }, UNWIND_EVIDENCE_HEARTBEAT_MS);
    heartbeat.unref?.();
    const stopHeartbeat = () => {
      stopped = true;
      clearInterval(heartbeat);
    };

    try {
      const { proof, expectation } = await readUnwindEvidence({
        publicClient: unwindPublicClient,
        bundlerClient: unwindBundlerClient,
        jobId,
        userOpHash,
        unwindTxHash,
        kernelAddress: authority.kernelAddress,
        recipientHint: authority.recipientHint,
        facts: unwindEvidenceFacts,
      });
      if (proof?.userOpHash !== userOpHash || proof?.unwindTxHash !== unwindTxHash) {
        const mismatch = new Error('unwind evidence identity mismatch');
        mismatch.code = 'UNWIND_EVIDENCE_MISMATCH';
        throw mismatch;
      }
      unwindJobs.renewEvidence({
        jobId,
        leaseToken: claimed.leaseToken,
        now: nowMs(),
        leaseMs: UNWIND_EVIDENCE_LEASE_MS,
      });
      const attached = unwindJobs.attachAndEnqueue({
        jobId,
        proof,
        expectation,
        relayExecId: `unwind:${jobId}`,
        leaseToken: claimed.leaseToken,
        now: nowMs(),
      });
      stopHeartbeat();
      if (!attached.duplicate) {
        queueMicrotask(() => {
          void Promise.resolve(relayReverseMint({
            execId: `unwind:${jobId}`,
            sourceDomain: 6,
            burnTxHash: unwindTxHash,
            expectation,
          })).catch(() => {});
        });
      }
      return sendJson(res, 202, attached.record);
    } catch (error) {
      stopHeartbeat();
      const terminalReason = {
        UNWIND_EVIDENCE_REVERTED: 'destination_reverted',
        UNWIND_EVIDENCE_MISMATCH: 'message_mismatch',
        UNWIND_EVIDENCE_AMBIGUOUS: 'message_ambiguous',
      }[error?.code];
      if (terminalReason && typeof unwindJobs.finishBlocked === 'function') {
        try {
          unwindJobs.finishBlocked({
            jobId,
            leaseToken: claimed.leaseToken,
            reasonCode: terminalReason,
            now: nowMs(),
          });
          return sendJson(res, 409, { error: 'unwind evidence was rejected' });
        } catch {
          return sendJson(res, 503, { error: 'unwind relay is unavailable' });
        }
      }
      try {
        unwindJobs.releaseEvidence({
          jobId,
          leaseToken: claimed.leaseToken,
          now: nowMs(),
        });
      } catch {
        // A stale lease or concurrent terminal transition owns the durable truth.
      }
      if (error?.code === 'UNWIND_EVIDENCE_RETRYABLE') {
        return sendJson(res, 503, { error: 'unwind evidence is not available' });
      }
      if (['UNWIND_CONFLICT', 'UNWIND_CAS_CONFLICT'].includes(error?.code)) {
        return sendJson(res, 409, { error: 'unwind evidence was rejected' });
      }
      return sendJson(res, 503, { error: 'unwind relay is unavailable' });
    }
  }

  async function resumeUnwindJobs({ limit = recoveryLimit } = {}) {
    if (!baseExecutionAvailable && !unwindJobs) {
      return { resumed: [], held: [], blocked: [], uncertain: [], expired: [] };
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > recoveryLimit
        || !Number.isSafeInteger(recoveryConcurrency)
        || recoveryConcurrency < 1 || recoveryConcurrency > 32) {
      throw new Error('unwind recovery bounds are invalid');
    }
    if (!unwindJobs
        || typeof unwindJobs.reconcileExpired !== 'function'
        || typeof unwindJobs.listForResume !== 'function'
        || typeof unwindJobs.reconcileFromCctp !== 'function') {
      throw new Error('durable unwind authority store is unavailable');
    }
    if (!baseExecutionAvailable && typeof resumeExistingReverse !== 'function') {
      throw new Error('existing reverse recovery is unavailable');
    }
    if (activeUnwindResume) return activeUnwindResume;
    activeUnwindResume = (async () => {
      const at = nowMs();
      if (!Number.isSafeInteger(at) || at < 0) throw new Error('unwind recovery time is invalid');
      const expiredRows = unwindJobs.reconcileExpired({ now: at, limit });
      const work = unwindJobs.listForResume({ now: at, limit });
      if (!Array.isArray(expiredRows) || !Array.isArray(work) || work.length > limit) {
        throw new Error('unwind recovery listing is invalid');
      }
      const result = {
        resumed: [], held: [], blocked: [], uncertain: [],
        expired: expiredRows
          .filter(({ status }) => status === 'expired')
          .map(({ jobId }) => jobId),
      };
      let cursor = 0;
      const failures = [];
      const process = async ({ jobId, relayExecId }) => {
        // When Task 17 availability is false, this is the only permitted recovery seam. The
        // store's JOIN has already proved an existing source-domain-6 Task8 row; this call can
        // neither enqueue work nor read Base evidence. Active mode was globally swept first.
        if (!baseExecutionAvailable) await resumeExistingReverse(relayExecId);
        const projection = await unwindJobs.reconcileFromCctp({ jobId, now: at });
        if (!projection || projection.jobId !== jobId) {
          throw new Error('unwind recovery projection is invalid');
        }
        if (projection.status === 'done') result.resumed.push(jobId);
        else if (projection.status === 'blocked') result.blocked.push(jobId);
        else if (projection.status === 'uncertain') result.uncertain.push(jobId);
        else if (projection.status === 'relay_pending' || projection.status === 'relay_running') {
          result.held.push(jobId);
        } else {
          throw new Error('unwind recovery state is invalid');
        }
      };
      const workers = Array.from(
        { length: Math.min(recoveryConcurrency, work.length) },
        async () => {
          while (cursor < work.length) {
            const index = cursor;
            cursor += 1;
            try {
              await process(work[index]);
            } catch (error) {
              // One corrupt/temporarily unavailable projection must not abandon siblings or
              // clear the global non-overlap guard while another bounded worker is still live.
              failures.push({ index, error });
            }
          }
        },
      );
      await Promise.allSettled(workers);
      if (failures.length > 0) {
        failures.sort((left, right) => left.index - right.index);
        throw failures[0].error;
      }
      const order = new Map(work.map(({ jobId }, index) => [jobId, index]));
      for (const key of ['resumed', 'held', 'blocked', 'uncertain']) {
        result[key].sort((left, right) => order.get(left) - order.get(right));
      }
      return result;
    })().finally(() => { activeUnwindResume = null; });
    return activeUnwindResume;
  }

  const relayerRouter = async function relayerRouter(req, res) {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end('');
    }

    const path = subPath(req);
    const parsedUrl = new URL(req.url, 'http://local');
    if (req.method === 'POST'
        && ['/unwind', '/unwind/attach', '/status'].includes(path)
        && parsedUrl.search.length > 0) {
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 400, { error: 'invalid request' });
    }
    await ensureBody(req);

    if (req.method === 'POST' && path === '/mandate') return handleMandate(req, res);
    if (req.method === 'POST' && path === '/mandate/status') return handleMandateStatus(req, res);
    if (req.method === 'POST' && path === '/mandate/revoke') return handleMandateRevoke(req, res);
    if (req.method === 'POST' && path === '/farm') return handleFarm(req, res);
    if (req.method === 'POST' && path === '/farm/attach') return handleFarmAttach(req, res);
    if (req.method === 'POST' && path === '/status') return handleStatus(req, res);
    if (req.method === 'POST' && path === '/unwind') return handleUnwind(req, res);
    if (req.method === 'POST' && path === '/unwind/attach') return handleUnwindAttach(req, res);
    if (req.method === 'GET') {
      if (path === '/config') {
        return sendJson(res, 200, publicRuntime ?? { networkId, readiness: { ready: false } });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  };
  relayerRouter.resumeMandateActivations = resumeMandateActivations;
  relayerRouter.resumeFarmJobs = resumeFarmJobs;
  relayerRouter.resumeUnwindJobs = resumeUnwindJobs;
  return relayerRouter;
}
