// Pure HTTP handler factory for the relayer's /api/vf-cross/* surface. No network calls and no
// secrets are read directly here — every side effect (farm-flow construction, mint relaying,
// job/mandate storage, id generation) is injected, so this file is fully unit-testable with fake
// req/res and no real network. CORS + body handling clone the ensureBody/subPath pattern from
// frontend/api/vf/_router.js so a raw node:http request behaves the same as a pre-parsed one
// under test.
//
// Non-custodial invariant: the `/unwind` handler ONLY relays the reverse CCTP mint via the
// injected `relayUnwindMint` — it never dispatches a withdraw. The withdraw + burn are
// owner-signed client-side via BaseExitSweeper.exitAllAndBurn (see
// frontend/src/base/withdrawBatch.js), so no relayer-side burn construction is imported or
// called from here.
//
// Mandate registration uses the capability-bound v3 stores whenever those dependencies are
// composed. The v2 branch remains isolated for the migration slice that still owns the older
// farm/status routes; a v3 registration never consults or mutates mandatesV2.

import { createHash } from 'node:crypto';
import { validateMandateBinding, MAX_CALL_CAP_UNITS } from './base/session.mjs';
import {
  canonicalTxHash,
  canonicalUserOpHash,
} from './base/canonicalMandate.mjs';
import {
  capabilityMatches,
  hashCapability,
  requireCapability,
  requireMandateId,
  serializeMandateCapabilityCookie,
} from './capability.mjs';
import {
  evaluateBaseMandateStatus,
  permissionIdFromSerializedApproval,
} from './mandateStatus.mjs';

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
const FARM_FIELDS = new Set([
  'sourceDomain',
  'serializedApproval',
  'allocations',
  'stellarOwner',
  'kernelAddress',
  'bridgeAgent',
  'runId',
  'grantTxHash',
]);
const FARM_ATTACH_FIELDS = new Set([
  'jobId',
  'burnTxHash',
  'serializedApproval',
  'stellarOwner',
  'kernelAddress',
]);
const FARM_LEASE_MS = 30_000;
const FARM_HEARTBEAT_MS = 10_000;
const MANDATE_ACTIVATION_LEASE_SECONDS = 30;
const MANDATE_ACTIVATION_HEARTBEAT_MS = 10_000;
const CAPABILITY_HASH_PATTERN = /^[0-9a-f]{64}$/;

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
 * @param {(params: { unwindTxHash: string, stellarRecipient: string }) => Promise<{status:string, mintTxHash?:string}>} deps.relayUnwindMint
 * @param {Map<string, {status:string, steps:Array<object>}>} deps.jobs - jobId -> job record
 * @param {object} deps.mandatesV2 - the owner/kernel-bound mandate store (mandateStore.mjs's
 *   createMandateStoreV2 or sqliteStores.mjs's mandatesV2): set/get/status/delete/sweep, all
 *   keyed on {serializedApproval, stellarOwner, kernelAddress} together. get() returns the FULL
 *   record (including sessionPrivateKey) — internal use only; status() never does.
 * @param {object} [deps.mandatesV3] - encrypted mandate authority store.
 * @param {object} [deps.mandateActivations] - paired activation work/CAS store.
 * @param {(sessionPrivateKey: string) => {activateMandate: Function}} [deps.buildMandateActivator]
 * @param {() => string} deps.genId
 * @param {string} deps.usdcAddress - canonical Base USDC address, for approval-policy validation
 * @param {string} deps.yieldRouterAddress - deployed YieldRouter address, for approval-policy validation
 * @param {string|null} [deps.relayerOrigin] - this server's own configured public origin. Stored
 *   on every mandate at registration and re-compared on every later operation — "compare relayer
 *   origin to server configuration" (Step 2). null/'' = not configured (open dev posture, no
 *   compare performed), matching the withProxyKeyAuth "empty key = open" convention in server.mjs.
 * @param {boolean} [deps.sanitizeErrors=false] - when true, error job records (returned verbatim by
 *   GET /status) carry a generic message and the real error is logged server-side only. Off by
 *   default so local dev / the smoke harness keep full detail; the standalone server turns it ON
 *   unless RELAYER_DEBUG_ERRORS=1 (see server.mjs), so a public deploy never leaks internal error
 *   strings (RPC URLs, addresses) to whoever holds a jobId.
 */
export function createRelayerRouter({
  buildFarm, relayUnwindMint, jobs, mandatesV2, genId, usdcAddress, yieldRouterAddress,
  mandatesV3 = null, mandateActivations = null, buildMandateActivator = null,
  relayerOrigin = null, sanitizeErrors = false, networkId = 'stellar-testnet',
  publicRuntime = null,
  evaluateMandateStatusFn = evaluateBaseMandateStatus,
  mandateStatusConfig = publicRuntime?.mandateStatusConfig ?? null,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  poolTargets = new Map(), agentIndexReporter = null, associationOutbox = null,
  farmExecutions = null,
}) {
  const activeFarmJobs = new Set();
  const activeMandateActivations = new Map();
  const activeMandateRegistrations = new Map();
  const memoryFarmWork = new Map();
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

  function handleMandateV2(req, res) {
    const {
      serializedApproval, sessionPrivateKey, sessionKeyAddress, expiresAt, stellarOwner, kernelAddress,
    } = req.body || {};
    if (!serializedApproval || !sessionPrivateKey || !sessionKeyAddress || !stellarOwner || !kernelAddress) {
      return sendJson(res, 400, {
        error: 'serializedApproval, sessionPrivateKey, sessionKeyAddress, expiresAt, stellarOwner and kernelAddress are all required',
      });
    }
    const nowSeconds = Date.now() / 1000;
    if (typeof expiresAt !== 'number' || expiresAt <= nowSeconds || expiresAt > nowSeconds + MAX_MANDATE_WINDOW_SECONDS) {
      return sendJson(res, 400, {
        error: 'expiresAt must be a unix-seconds timestamp in the future, at most 30 days out',
      });
    }

    // Validate BEFORE storing (Step 2): derive+compare the session address, decode+compare the
    // approval's own kernel, validate its embedded call/timestamp policy. Never store a key for a
    // binding that couldn't be spent anyway.
    const check = validateMandateBinding({
      serializedApproval, sessionPrivateKey, sessionKeyAddress, stellarOwner, kernelAddress,
      usdcAddress, yieldRouterAddress, now: Math.floor(nowSeconds),
    });
    if (!check.ok) return sendJson(res, 400, { error: check.reason });

    const bindingId = genId();
    const bindingHash = computeBindingHash({ stellarOwner, kernelAddress, sessionKeyAddress, expiresAt });

    // The key is sent exactly once and lives only in this store for the mandate's lifetime —
    // NEVER logged, NEVER echoed back. expiresAt arrives in unix SECONDS; the store wants ms.
    mandatesV2.set({
      serializedApproval, sessionPrivateKey, sessionKeyAddress, stellarOwner, kernelAddress,
      relayerOrigin, expiresAt: expiresAt * 1000, status: 'active', bindingId, bindingHash,
      createdAt: Date.now(),
    });

    return sendJson(res, 200, { ok: true, relayerOrigin, bindingId, bindingHash });
  }

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
    if (mandatesV3 || mandateActivations || buildMandateActivator) {
      if (!mandatesV3 || !mandateActivations || !buildMandateActivator || !mandateStatusConfig) {
        return sendJson(res, 503, { error: 'mandate activation is unavailable' });
      }
      return handleMandateV3(req, res);
    }
    return handleMandateV2(req, res);
  }

  async function resumeMandateActivations() {
    if (!mandateActivations) return;
    await mandateActivations.reconcileExpired({ nowSeconds: nowSeconds() });
    const recoverable = await mandateActivations.listRecoverable({ nowSeconds: nowSeconds() });
    await Promise.all(recoverable.map((work) => dispatchMandateActivation({
      mandateId: work.mandateId,
      stellarOwner: work.stellarOwner,
      kernelAddress: work.kernelAddress,
    })));
  }

  // Lets the client check whether a previously-registered mandate is still reusable WITHOUT ever
  // getting the session key back. Returns the canonical BaseMandateStatusV2 shape.
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

  async function evaluateStoredMandate(record, allocation) {
    if (!record || !mandateStatusConfig) return unknownMandateStatus(record ? 'STATUS_UNAVAILABLE' : 'MANDATE_MISSING');
    const permissionId = permissionIdFromSerializedApproval(record.serializedApproval);
    if (!permissionId) return unknownMandateStatus('APPROVAL_MALFORMED');
    try {
      return await evaluateMandateStatusFn({
        record: { ...record, permissionId },
        config: mandateStatusConfig,
        allocation,
      });
    } catch {
      return unknownMandateStatus('STATUS_ERROR');
    }
  }

  async function handleMandateValid(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const q = new URL(req.url, 'http://local').searchParams;
    const approval = q.get('approval');
    const stellarOwner = q.get('stellarOwner');
    const kernelAddress = q.get('kernelAddress');
    if (!approval || !stellarOwner || !kernelAddress) {
      return sendJson(res, 400, { error: 'approval, stellarOwner and kernelAddress query params are all required' });
    }
    let allocation;
    try {
      allocation = JSON.parse(q.get('allocation') || 'null');
      if (!allocation) throw new Error('missing allocation');
    } catch {
      return sendJson(res, 400, { error: 'allocation query param must be canonical JSON' });
    }
    const record = mandatesV2.get({ serializedApproval: approval, stellarOwner, kernelAddress });
    return sendJson(res, 200, await evaluateStoredMandate(record, allocation));
  }

  // Design spec §5.5 — Task 7 owns this endpoint. Deletes the exact v2 binding via mandatesV2's
  // existing delete() (owner-authenticated: only the caller who supplies the matching approval +
  // stellarOwner + kernelAddress triple can remove it). Always 200 — deleted:false for a
  // never-registered/already-gone triple avoids leaking whether a binding exists for someone
  // else. Never returns key material.
  function handleMandateRevoke(req, res) {
    const { serializedApproval, stellarOwner, kernelAddress } = req.body || {};
    if (!serializedApproval || !stellarOwner || !kernelAddress) {
      return sendJson(res, 400, { error: 'serializedApproval, stellarOwner and kernelAddress are all required' });
    }
    const deleted = mandatesV2.delete({ serializedApproval, stellarOwner, kernelAddress });
    return sendJson(res, 200, { ok: true, deleted, scope: 'relayer-key-copy', note: REVOKE_NOTE });
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

  function revalidatedMandate({ serializedApproval, stellarOwner, kernelAddress }) {
    const record = mandatesV2.get({ serializedApproval, stellarOwner, kernelAddress });
    if (!record) return { error: 'unknown mandate' };
    if (relayerOrigin && record.relayerOrigin !== relayerOrigin) {
      return { error: 'relayer origin mismatch' };
    }
    const recheck = validateMandateBinding({
      serializedApproval,
      sessionPrivateKey: record.sessionPrivateKey,
      sessionKeyAddress: record.sessionKeyAddress,
      stellarOwner,
      kernelAddress,
      usdcAddress,
      yieldRouterAddress,
      now: Math.floor(Date.now() / 1000),
    });
    return recheck.ok ? { record } : { error: recheck.reason };
  }

  function storedWireAllocations(allocations) {
    return allocations.map((allocation) => ({
      allocationId: allocation.allocationId,
      poolAddress: allocation.pool,
      amount: allocation.reportAmount,
      minShares: allocation.minShares.toString(),
    }));
  }

  function childIdentity(context, allocationId) {
    return {
      networkId: context.networkId,
      owner: context.stellarOwner,
      bindingId: context.bindingId,
      allocationId,
      childId: context.jobId,
    };
  }

  function childIntent({ jobId, record, stellarOwner, bridgeAgent, runId, grantTxHash, kernelAddress, allocation }) {
    return {
      version: 1,
      networkId,
      owner: stellarOwner,
      agent: bridgeAgent,
      bindingId: record.bindingId,
      allocationId: allocation.allocationId,
      childId: jobId,
      intent: {
        token: allocation.reportAmount.token,
        units: allocation.reportAmount.units,
        decimals: allocation.reportAmount.decimals,
        poolAddress: allocation.pool,
        proxyTarget: allocation.proxyTarget,
        runId,
        grantTxHash,
        kernelAddress,
        bindingHash: record.bindingHash,
        baseJobId: jobId,
      },
      lifecycle: {
        sequence: 0,
        status: 'planned',
        evidence: {},
        observedAt: Date.now(),
      },
    };
  }

  function lifecycleStatus(executionStatus) {
    if (executionStatus === 'deposited') return 'confirmed';
    if (executionStatus === 'failed') return 'failed';
    if (executionStatus === 'held' || executionStatus === 'unknown') return 'unknown';
    return 'submitted';
  }

  function lifecycleReports(context, allocations, sequence, executionStatus, custodyLocation, txHash) {
    return allocations.map((allocation) => ({
      identity: childIdentity(context, allocation.allocationId),
      expectedSequence: sequence - 1,
      lifecycle: {
        sequence,
        status: lifecycleStatus(executionStatus),
        evidence: {
          executionStatus,
          custodyLocation,
          txHash: txHash ?? null,
        },
        observedAt: Date.now(),
      },
    }));
  }

  function publicJob(job, jobId) {
    if (!job) return job;
    const { _attach, associationUncertain = false, ...safe } = job;
    const delivery = associationOutbox?.status ? associationOutbox.status(jobId) : [];
    const expected = Array.isArray(_attach?.associations) ? _attach.associations : [];
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
      ...safe,
      associationDelivery: {
        complete,
        uncertain,
        events: complete
          ? contiguous
          : [...contiguous, ...delivery.filter((row) => row.status === 'dead' && !contiguous.includes(row))],
      },
    };
  }

  function associationsWithTerminal(context, terminalSequence) {
    return (context.associations || []).map((association) => ({
      allocationId: association.allocationId,
      terminalSequence,
    }));
  }

  function persistenceUncertain(jobId, job, err) {
    if (sanitizeErrors) {
      console.error(`[relayer] job ${jobId} terminal association persistence failed:`, err);
    }
    jobs.set(jobId, {
      ...job,
      status: 'error',
      associationUncertain: true,
      steps: [
        ...(Array.isArray(job.steps) ? job.steps : []),
        {
          step: 'association-persistence',
          status: 'error',
          message: sanitizeErrors ? 'internal error' : errorMessage(err),
        },
      ],
    });
  }

  function attachWork({ jobId, burnTxHash, job, reports }) {
    if (farmExecutions?.attach) {
      return farmExecutions.attach({ jobId, burnTxHash, job, reports });
    }
    const existing = memoryFarmWork.get(jobId);
    if (existing) {
      if (existing.burnTxHash !== burnTxHash) throw new Error('farm execution already has a different burn hash');
      return { duplicate: true, work: existing };
    }
    associationOutbox.enqueue(reports);
    jobs.set(jobId, job);
    const work = { jobId, burnTxHash, status: 'pending', attempts: 0, leaseToken: null };
    memoryFarmWork.set(jobId, work);
    return { duplicate: false, work };
  }

  function claimWork(jobId) {
    if (farmExecutions?.claim) return farmExecutions.claim({ jobId, leaseMs: FARM_LEASE_MS });
    if (activeFarmJobs.has(jobId)) return null;
    let work = memoryFarmWork.get(jobId);
    const job = jobs.get(jobId);
    if (!work && job?._attach?.attachedBurnTxHash && job.status === 'pending') {
      work = {
        jobId,
        burnTxHash: job._attach.attachedBurnTxHash,
        status: 'pending',
        attempts: 0,
        leaseToken: null,
      };
      memoryFarmWork.set(jobId, work);
    }
    if (!work || work.status !== 'pending') return null;
    const claimed = { ...work, status: 'running', attempts: work.attempts + 1, leaseToken: `memory:${jobId}` };
    memoryFarmWork.set(jobId, claimed);
    return claimed;
  }

  function checkpointWork({ jobId, leaseToken, job, reports }) {
    if (farmExecutions?.checkpoint) {
      return farmExecutions.checkpoint({ jobId, leaseToken, job, reports });
    }
    associationOutbox.enqueue(reports);
    jobs.set(jobId, job);
  }

  function finishWork({ jobId, leaseToken, job, reports }) {
    if (farmExecutions?.finish) {
      return farmExecutions.finish({ jobId, leaseToken, job, reports, status: 'done' });
    }
    associationOutbox.enqueue(reports);
    jobs.set(jobId, job);
    const work = memoryFarmWork.get(jobId);
    if (work) memoryFarmWork.set(jobId, { ...work, status: 'done', leaseToken: null });
  }

  function startFarmLeaseHeartbeat(jobId, leaseToken) {
    if (!farmExecutions?.renew) return () => {};
    const timer = setInterval(() => {
      try {
        farmExecutions.renew({ jobId, leaseToken, leaseMs: FARM_LEASE_MS });
      } catch (err) {
        if (sanitizeErrors) console.error(`[relayer] job ${jobId} lease renewal failed:`, err);
      }
    }, FARM_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function runFarmJobBody(jobId, sessionPrivateKey, farmParams, attachContext, leaseToken) {
    let mintCheckpointed = false;
    const onMintConfirmed = async (mintResult) => {
      if (mintCheckpointed || !mintResult?.mintTxHash) return;
      const reports = lifecycleReports(
        attachContext, farmParams.allocations, 2, 'minted', 'agent', mintResult.mintTxHash,
      );
      const current = jobs.get(jobId) || { status: 'pending', steps: [] };
      checkpointWork({
        jobId,
        leaseToken,
        reports,
        job: {
          ...current,
          status: 'depositing',
          steps: [{ step: 'mint', status: mintResult.status, mintTxHash: mintResult.mintTxHash }],
          _attach: attachContext,
        },
      });
      mintCheckpointed = true;
    };

    let result;
    try {
      const { farm } = buildFarm(sessionPrivateKey);
      result = await farm({ ...farmParams, onMintConfirmed });
      await onMintConfirmed(result.mintResult);
    } catch (err) {
      const current = jobs.get(jobId) || { status: 'pending', steps: [] };
      const observedMintTxHash = current.steps
        ?.find((step) => step.step === 'mint' && step.mintTxHash)?.mintTxHash ?? null;
      const terminalSequence = observedMintTxHash ? 3 : 2;
      const failedContext = {
        ...attachContext,
        associations: associationsWithTerminal(attachContext, terminalSequence),
      };
      const failedJob = {
        runId: farmParams.runId,
        bridgeAgent: farmParams.bridgeAgent,
        grantTxHash: farmParams.grantTxHash,
        _attach: failedContext,
        status: 'error',
        steps: [
          ...(Array.isArray(current.steps) ? current.steps : []),
          { step: 'farm', status: 'error', message: sanitizeErrors ? 'internal error' : errorMessage(err) },
        ],
      };
      if (sanitizeErrors) console.error(`[relayer] job ${jobId} step farm failed:`, err);
      try {
        finishWork({
          jobId,
          leaseToken,
          job: failedJob,
          reports: lifecycleReports(
            failedContext,
            farmParams.allocations,
            terminalSequence,
            'failed',
            observedMintTxHash ? 'agent' : 'unknown',
            observedMintTxHash,
          ),
        });
      } catch (finishError) {
        persistenceUncertain(jobId, failedJob, finishError);
      }
      return;
    }

    const { mintResult, depositResults = [], runId, bridgeAgent, grantTxHash } = result;
    const results = new Map(depositResults.map((deposit) => [deposit?.allocationId, deposit]));
    const terminalReports = farmParams.allocations.map((allocation) => {
      const deposit = results.get(allocation.allocationId);
      const executionStatus = deposit?.executionStatus || 'unknown';
      const custodyLocation = deposit?.custody?.location || 'unknown';
      const txHash = deposit?.txHash
        ?? (custodyLocation === 'agent' ? mintResult.mintTxHash : null)
        ?? null;
      return lifecycleReports(
        attachContext, [allocation], 3, executionStatus, custodyLocation, txHash,
      )[0];
    });
    const terminalContext = {
      ...attachContext,
      associations: associationsWithTerminal(attachContext, 3),
    };
    const doneJob = {
        status: 'done',
        runId, bridgeAgent, grantTxHash,
        _attach: terminalContext,
        steps: [
          { step: 'mint', status: mintResult.status, mintTxHash: mintResult.mintTxHash },
          { step: 'deposits', results: depositResults },
        ],
    };
    try {
      finishWork({ jobId, leaseToken, job: doneJob, reports: terminalReports });
    } catch (err) {
      persistenceUncertain(jobId, doneJob, err);
    }
  }

  async function runFarmJob(jobId, sessionPrivateKey, farmParams, attachContext, leaseToken) {
    const stopHeartbeat = startFarmLeaseHeartbeat(jobId, leaseToken);
    try {
      return await runFarmJobBody(
        jobId,
        sessionPrivateKey,
        farmParams,
        attachContext,
        leaseToken,
      );
    } finally {
      stopHeartbeat();
    }
  }

  function dispatchFarmWork(jobId) {
    if (activeFarmJobs.has(jobId)) return false;
    const job = jobs.get(jobId);
    const attachContext = job?._attach;
    if (!job || !attachContext?.attachedBurnTxHash) return false;
    const claimed = claimWork(jobId);
    if (!claimed) return false;
    const mandate = revalidatedMandate({
      serializedApproval: attachContext.serializedApproval,
      stellarOwner: attachContext.stellarOwner,
      kernelAddress: attachContext.kernelAddress,
    });
    let parsedAllocations;
    try {
      if (mandate.error) throw new Error(mandate.error);
      parsedAllocations = parseWireAllocations(attachContext.allocations, job.runId);
    } catch (err) {
      const terminalContext = {
        ...attachContext,
        associations: associationsWithTerminal(attachContext, 2),
      };
      const failedJob = {
        ...job,
        status: 'error',
        _attach: terminalContext,
        steps: [{ step: 'farm', status: 'error', message: sanitizeErrors ? 'internal error' : errorMessage(err) }],
      };
      try {
        finishWork({
          jobId,
          leaseToken: claimed.leaseToken,
          job: failedJob,
          reports: lifecycleReports(terminalContext, [], 2, 'failed', 'unknown', null),
        });
      } catch (finishError) {
        persistenceUncertain(jobId, failedJob, finishError);
      }
      return false;
    }
    activeFarmJobs.add(jobId);
    void runFarmJob(jobId, mandate.record.sessionPrivateKey, {
      burnTxHash: attachContext.attachedBurnTxHash,
      execId: attachContext.attachedBurnTxHash,
      approval: attachContext.serializedApproval,
      allocations: parsedAllocations,
      runId: job.runId,
      bridgeAgent: job.bridgeAgent,
      grantTxHash: job.grantTxHash,
    }, attachContext, claimed.leaseToken).finally(() => activeFarmJobs.delete(jobId));
    return true;
  }

  function reconcileExpiredWork(work) {
    const job = jobs.get(work.jobId);
    const context = job?._attach;
    if (!job || !context || !farmExecutions?.reconcileUncertain) return;
    let allocations;
    try {
      allocations = parseWireAllocations(context.allocations, job.runId);
    } catch {
      return;
    }
    const mintTxHash = job.steps?.find((step) => step.step === 'mint')?.mintTxHash ?? null;
    const terminalSequence = mintTxHash ? 3 : 2;
    const terminalContext = {
      ...context,
      associations: associationsWithTerminal(context, terminalSequence),
    };
    const uncertainJob = { ...job, status: 'uncertain', _attach: terminalContext };
    farmExecutions.reconcileUncertain({
      jobId: work.jobId,
      job: uncertainJob,
      reports: lifecycleReports(
        terminalContext,
        allocations,
        terminalSequence,
        'unknown',
        mintTxHash ? 'agent' : 'unknown',
        mintTxHash,
      ),
    });
  }

  async function resumeFarmJobs() {
    if (farmExecutions?.listRecoverable) {
      for (const work of farmExecutions.listRecoverable()) {
        if (work.status === 'running') {
          if (!activeFarmJobs.has(work.jobId)) reconcileExpiredWork(work);
        }
        else dispatchFarmWork(work.jobId);
      }
      return;
    }
    if (typeof jobs?.entries === 'function') {
      for (const [jobId, job] of jobs.entries()) {
        if (job?.status === 'pending' && job?._attach?.attachedBurnTxHash) dispatchFarmWork(jobId);
      }
    }
  }

  async function handleFarm(req, res) {
    try {
      requireExactFields(req.body || {}, FARM_FIELDS, 'farm');
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
    const {
      serializedApproval, allocations, stellarOwner, kernelAddress,
      bridgeAgent = null, runId = null, grantTxHash = null,
    } = req.body || {};
    if (!serializedApproval || !stellarOwner || !kernelAddress
      || !Array.isArray(allocations) || allocations.length === 0) {
      return sendJson(res, 400, {
        error: 'serializedApproval, stellarOwner, kernelAddress and allocations are all required',
      });
    }

    // Exact-bound lookup — approval alone is never enough. The same full validation runs again
    // on /farm/attach before a queued job can gain a burn hash.
    const mandate = revalidatedMandate({ serializedApproval, stellarOwner, kernelAddress });
    if (mandate.error) return sendJson(res, 400, { error: mandate.error });
    const { record } = mandate;
    if (!bridgeAgent || !runId || !grantTxHash) {
      return sendJson(res, 400, {
        error: 'bridgeAgent, runId and grantTxHash are required for exact farm association',
      });
    }

    let parsedAllocations;
    try {
      parsedAllocations = parseWireAllocations(allocations, runId);
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
    const overCap = parsedAllocations.find((a) => a.amount > MAX_CALL_CAP_UNITS);
    if (overCap) return sendJson(res, 400, { error: 'allocation exceeds the 10,000 USDC per-call cap' });

    // This is the last relayer-side seam before the browser is acknowledged and allowed to burn.
    // Verify every exact durable allocation and prepare its exact approve+deposit operation.
    const mandateEvidence = [];
    for (const allocation of storedWireAllocations(parsedAllocations)) {
      const evidence = await evaluateStoredMandate(record, allocation);
      if (evidence.status !== 'active') {
        return sendJson(res, 409, { error: 'Base mandate evidence is not active', evidence });
      }
      mandateEvidence.push(evidence);
    }

    const jobId = genId();
    if (!agentIndexReporter?.commitIntent || !associationOutbox?.enqueue) {
      return sendJson(res, 503, { error: 'Base child intent is unavailable' });
    }
    const intents = parsedAllocations.map((allocation) => childIntent({
      jobId, record, stellarOwner, bridgeAgent, runId, grantTxHash, kernelAddress, allocation,
    }));
    let acknowledgements;
    try {
      acknowledgements = [];
      for (const intent of intents) acknowledgements.push(await agentIndexReporter.commitIntent(intent));
    } catch {
      return sendJson(res, 503, { error: 'Base child intent is unavailable' });
    }
    const job = {
      status: 'queued',
      steps: [],
      runId,
      bridgeAgent,
      grantTxHash,
      _attach: {
        serializedApproval,
        stellarOwner,
        kernelAddress,
        bindingId: record.bindingId,
        bindingHash: record.bindingHash,
        networkId,
        jobId,
        allocations: storedWireAllocations(parsedAllocations),
        mandateEvidence,
        associations: parsedAllocations.map(({ allocationId }) => ({
          allocationId,
          terminalSequence: null,
        })),
        attachedBurnTxHash: null,
      },
    };
    jobs.set(jobId, job);
    return sendJson(res, 201, {
      jobId,
      acknowledged: true,
      schemaVersion: acknowledgements[0]?.schemaVersion,
    });
  }

  function handleFarmAttach(req, res) {
    try {
      requireExactFields(req.body || {}, FARM_ATTACH_FIELDS, 'farm attach');
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
    const { jobId, burnTxHash, serializedApproval, stellarOwner, kernelAddress } = req.body || {};
    if (!jobId || !isValidBurnTxHash(burnTxHash) || !serializedApproval || !stellarOwner || !kernelAddress) {
      return sendJson(res, 400, {
        error: 'jobId, burnTxHash, serializedApproval, stellarOwner and kernelAddress are required',
      });
    }
    const job = jobs.get(jobId);
    if (!job) return sendJson(res, 404, { error: 'unknown jobId' });
    const context = job._attach;
    if (!context) return sendJson(res, 409, { error: 'job does not accept a burn attachment' });
    if (
      context.serializedApproval !== serializedApproval
      || context.stellarOwner !== stellarOwner
      || context.kernelAddress !== kernelAddress
    ) {
      return sendJson(res, 400, { error: 'farm attach approval, owner, or kernel mismatch' });
    }
    const mandate = revalidatedMandate({ serializedApproval, stellarOwner, kernelAddress });
    if (mandate.error) return sendJson(res, 400, { error: mandate.error });
    const { record } = mandate;
    if (
      record.bindingId !== context.bindingId
      || record.bindingHash !== context.bindingHash
    ) {
      return sendJson(res, 400, { error: 'farm attach mandate binding mismatch' });
    }
    if (context.attachedBurnTxHash) {
      if (context.attachedBurnTxHash !== burnTxHash) {
        return sendJson(res, 409, { error: 'farm job already has a different burn hash' });
      }
      const work = farmExecutions?.get?.(jobId);
      if (!work || work.status === 'pending') dispatchFarmWork(jobId);
      else if (
        work.status === 'running'
        && !activeFarmJobs.has(jobId)
        && work.leaseExpiresAt <= Date.now()
      ) {
        try {
          reconcileExpiredWork(work);
        } catch {
          // The durable running row remains observable and will be retried at startup.
        }
      }
      return sendJson(res, 200, { jobId, attached: true, status: job.status });
    }
    if (job.status !== 'queued') {
      return sendJson(res, 409, { error: 'farm job is not waiting for a burn hash' });
    }
    let parsedAllocations;
    try {
      parsedAllocations = parseWireAllocations(context.allocations, job.runId);
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
    try {
      const attachContext = { ...job._attach, attachedBurnTxHash: burnTxHash };
      const attachedJob = {
        ...job,
        status: 'pending',
        steps: [],
        _attach: attachContext,
      };
      attachWork({
        jobId,
        burnTxHash,
        job: attachedJob,
        reports: lifecycleReports(
          attachContext, parsedAllocations, 1, 'accepted', 'in-transit', burnTxHash,
        ),
      });
      dispatchFarmWork(jobId);
    } catch {
      return sendJson(res, 503, { error: 'Base child lifecycle outbox is unavailable' });
    }
    return sendJson(res, 200, { jobId, attached: true, status: 'pending' });
  }

  function handleStatus(res, jobId) {
    const job = jobs.get(jobId);
    if (!job) return sendJson(res, 404, { error: 'unknown jobId' });
    return sendJson(res, 200, publicJob(job, jobId));
  }

  async function runUnwindJob(jobId, unwindTxHash, stellarRecipient) {
    try {
      const mintResult = await relayUnwindMint({ unwindTxHash, stellarRecipient });
      jobs.set(jobId, {
        status: 'done',
        steps: [{ step: 'mint', status: mintResult.status, mintTxHash: mintResult.mintTxHash }],
      });
    } catch (err) {
      recordError(jobId, 'mint', err);
    }
  }

  function handleUnwind(req, res) {
    const { unwindTxHash, stellarRecipient } = req.body || {};
    if (!unwindTxHash || !stellarRecipient) {
      return sendJson(res, 400, { error: 'unwindTxHash and stellarRecipient are required' });
    }

    const jobId = genId();
    jobs.set(jobId, { status: 'pending', steps: [] });
    sendJson(res, 200, { jobId });

    // Non-custodial invariant: relay ONLY the reverse CCTP mint. Never dispatch a withdraw here.
    void runUnwindJob(jobId, unwindTxHash, stellarRecipient);
  }

  const relayerRouter = async function relayerRouter(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end('');
    }

    await ensureBody(req);
    const path = subPath(req);

    if (req.method === 'POST' && path === '/mandate') return handleMandate(req, res);
    if (req.method === 'POST' && path === '/mandate/revoke') return handleMandateRevoke(req, res);
    if (req.method === 'POST' && path === '/farm') return handleFarm(req, res);
    if (req.method === 'POST' && path === '/farm/attach') return handleFarmAttach(req, res);
    if (req.method === 'POST' && path === '/unwind') return handleUnwind(req, res);
    if (req.method === 'GET') {
      if (path === '/config') {
        return sendJson(res, 200, publicRuntime ?? { networkId, readiness: { ready: false } });
      }
      const statusMatch = path.match(/^\/status\/([^/]+)$/);
      if (statusMatch) return handleStatus(res, decodeURIComponent(statusMatch[1]));
      if (path === '/mandate/valid') return handleMandateValid(req, res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  };
  relayerRouter.resumeMandateActivations = resumeMandateActivations;
  relayerRouter.resumeFarmJobs = resumeFarmJobs;
  return relayerRouter;
}
