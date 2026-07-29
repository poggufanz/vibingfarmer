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
// VF Wallet Task 7: the /mandate* endpoints and /farm now operate EXCLUSIVELY against
// `mandatesV2` (the owner/kernel-bound store — see mandateStore.mjs's createMandateStoreV2 /
// sqliteStores.mjs's mandatesV2). The legacy approval-only `mandates` store (server.mjs no longer
// wires it in here at all) is left completely alone for rollback — any row still sitting in it is
// simply never looked at by this router again, i.e. "never executable; the client must
// reactivate" by POSTing a fresh /mandate with the full v2 field set.

import { createHash } from 'node:crypto';
import { validateMandateBinding, MAX_CALL_CAP_UNITS } from './base/session.mjs';

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
  'burnTxHash',
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
  relayerOrigin = null, sanitizeErrors = false, networkId = 'stellar-testnet',
  publicRuntime = null,
  poolTargets = new Map(), agentIndexReporter = null,
}) {
  const associationReportTails = new Map();

  async function reportAssociation(record, binding) {
    if (!agentIndexReporter?.report) {
      console.warn('[relayer] non-custodial agent index warning', {
        networkId: record.networkId,
        runId: record.runId,
        warning: 'agent index reporting is not configured',
      });
      return;
    }
    try {
      await agentIndexReporter.report(record, binding);
    } catch {
      console.warn('[relayer] non-custodial agent index warning', {
        networkId: record.networkId,
        runId: record.runId,
        warning: 'agent index reporting failed',
      });
    }
  }

  function enqueueAssociation(jobId, record, binding) {
    const prior = associationReportTails.get(jobId) ?? Promise.resolve();
    const next = prior.then(() => reportAssociation(record, binding));
    associationReportTails.set(jobId, next);
    void next.finally(() => {
      if (associationReportTails.get(jobId) === next) associationReportTails.delete(jobId);
    });
    return next;
  }
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

  function handleMandate(req, res) {
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

  // Lets the client check whether a previously-registered mandate is still reusable WITHOUT ever
  // getting the session key back. Returns the canonical BaseMandateStatusV2 shape.
  function handleMandateValid(req, res) {
    const q = new URL(req.url, 'http://local').searchParams;
    const approval = q.get('approval');
    const stellarOwner = q.get('stellarOwner');
    const kernelAddress = q.get('kernelAddress');
    if (!approval || !stellarOwner || !kernelAddress) {
      return sendJson(res, 400, { error: 'approval, stellarOwner and kernelAddress query params are all required' });
    }
    return sendJson(res, 200, mandatesV2.status({ serializedApproval: approval, stellarOwner, kernelAddress }));
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

  function reportAllocations(allocations, executionStatus, custodyLocation, txHash) {
    return allocations.map((allocation) => ({
      allocationId: allocation.allocationId,
      poolAddress: allocation.pool,
      proxyTarget: allocation.proxyTarget,
      amount: allocation.reportAmount,
      executionStatus,
      custody: { location: custodyLocation },
      txHash,
    }));
  }

  function storedWireAllocations(allocations) {
    return allocations.map((allocation) => ({
      allocationId: allocation.allocationId,
      poolAddress: allocation.pool,
      amount: allocation.reportAmount,
      minShares: allocation.minShares.toString(),
    }));
  }

  function publicJob(job) {
    if (!job) return job;
    const { _attach, ...safe } = job;
    void _attach;
    return safe;
  }

  async function runFarmJob(
    jobId,
    sessionPrivateKey,
    farmParams,
    reportBase,
    binding,
    enqueueReport,
  ) {
    try {
      const { farm } = buildFarm(sessionPrivateKey);
      const { mintResult, depositResults, runId, bridgeAgent, grantTxHash } = await farm(farmParams);
      const attachContext = jobs.get(jobId)?._attach;
      jobs.set(jobId, {
        status: 'done',
        runId, bridgeAgent, grantTxHash,
        _attach: attachContext,
        steps: [
          { step: 'mint', status: mintResult.status, mintTxHash: mintResult.mintTxHash },
          { step: 'deposits', results: depositResults },
        ],
      });
      const byAllocationId = new Map(
        farmParams.allocations.map((allocation) => [allocation.allocationId, allocation])
      );
      const terminalAllocations = depositResults.flatMap((result) => {
        const allocation = byAllocationId.get(result?.allocationId);
        if (!allocation || !result.executionStatus || !result.custody?.location) return [];
        const txHash = result.txHash
          ?? (result.custody.location === 'agent' ? mintResult.mintTxHash : null)
          ?? null;
        return [{
          allocationId: allocation.allocationId,
          poolAddress: allocation.pool,
          proxyTarget: allocation.proxyTarget,
          amount: allocation.reportAmount,
          executionStatus: result.executionStatus,
          custody: { location: result.custody.location },
          txHash,
        }];
      });
      if (terminalAllocations.length > 0) {
        await enqueueReport(
          { ...reportBase, allocations: terminalAllocations },
          binding,
        );
      }
    } catch (err) {
      // Error only — the sessionPrivateKey must never end up in a job record. Run/bridge context
      // (already known from the request, not re-derived) still rides along onto the error record.
      const observedMintTxHash = jobs.get(jobId)?.steps
        ?.find((step) => step.step === 'mint' && step.mintTxHash)
        ?.mintTxHash ?? null;
      recordError(jobId, 'farm', err, {
        runId: farmParams.runId, bridgeAgent: farmParams.bridgeAgent, grantTxHash: farmParams.grantTxHash,
        _attach: jobs.get(jobId)?._attach,
      });
      await enqueueReport(
        {
          ...reportBase,
          allocations: farmParams.allocations.map((allocation) => ({
            allocationId: allocation.allocationId,
            poolAddress: allocation.pool,
            proxyTarget: allocation.proxyTarget,
            amount: allocation.reportAmount,
            executionStatus: 'failed',
            custody: { location: observedMintTxHash ? 'agent' : 'unknown' },
            txHash: observedMintTxHash,
          })),
        },
        binding,
      );
    }
  }

  function startFarmJob({ jobId, job, record, burnTxHash, parsedAllocations }) {
    const attachContext = { ...job._attach, attachedBurnTxHash: burnTxHash };
    const binding = {
      bindingId: attachContext.bindingId,
      bindingHash: attachContext.bindingHash,
    };
    const reportBase = attachContext.reportBase;
    jobs.set(jobId, {
      ...job,
      status: 'pending',
      steps: [],
      _attach: attachContext,
    });
    const enqueueReport = (report, expectedBinding) =>
      enqueueAssociation(jobId, report, expectedBinding);
    void enqueueReport(
      {
        ...reportBase,
        allocations: reportAllocations(parsedAllocations, 'accepted', 'unknown', null),
      },
      binding,
    );

    const onMintConfirmed = (mintResult) => {
      if (!mintResult?.mintTxHash) return;
      const current = jobs.get(jobId) || job;
      jobs.set(jobId, {
        ...current,
        status: 'depositing',
        steps: [{ step: 'mint', status: mintResult.status, mintTxHash: mintResult.mintTxHash }],
        _attach: attachContext,
      });
      void enqueueReport(
        {
          ...reportBase,
          allocations: reportAllocations(
            parsedAllocations,
            'minted',
            'agent',
            mintResult.mintTxHash,
          ),
        },
        binding,
      );
    };

    // Fire-and-forget: the client polls GET /status/:jobId. The client's `sourceDomain` is
    // intentionally ignored — createFarmFlow hardcodes domains.stellar as the mint source.
    void runFarmJob(jobId, record.sessionPrivateKey, {
      burnTxHash,
      execId: burnTxHash,
      approval: attachContext.serializedApproval,
      allocations: parsedAllocations,
      runId: job.runId,
      bridgeAgent: job.bridgeAgent,
      grantTxHash: job.grantTxHash,
      onMintConfirmed,
    }, reportBase, binding, enqueueReport);
  }

  function handleFarm(req, res) {
    try {
      requireExactFields(req.body || {}, FARM_FIELDS, 'farm');
    } catch (err) {
      return sendJson(res, 400, { error: errorMessage(err) });
    }
    const {
      burnTxHash, serializedApproval, allocations, stellarOwner, kernelAddress,
      bridgeAgent = null, runId = null, grantTxHash = null,
    } = req.body || {};
    if ((burnTxHash !== null && !isValidBurnTxHash(burnTxHash))
      || !serializedApproval || !stellarOwner || !kernelAddress
      || !Array.isArray(allocations) || allocations.length === 0) {
      return sendJson(res, 400, {
        error: 'burnTxHash (string or null), serializedApproval, stellarOwner, kernelAddress and allocations are all required',
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

    const jobId = genId();
    const binding = { bindingId: record.bindingId, bindingHash: record.bindingHash };
    const reportBase = {
      version: 1,
      networkId,
      owner: stellarOwner,
      bridgeAgent,
      runId,
      grantTxHash,
      kernelAddress,
      mandateBindingId: record.bindingId,
      mandateBindingHash: record.bindingHash,
      baseJobId: jobId,
    };
    const job = {
      status: burnTxHash === null ? 'queued' : 'pending',
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
        allocations: storedWireAllocations(parsedAllocations),
        reportBase,
        attachedBurnTxHash: null,
      },
    };
    jobs.set(jobId, job);
    sendJson(res, 200, { jobId });

    if (burnTxHash === null) {
      void enqueueAssociation(
        jobId,
        {
          ...reportBase,
          allocations: reportAllocations(parsedAllocations, 'queued', 'unknown', null),
        },
        binding,
      );
      return;
    }
    void startFarmJob({ jobId, job, record, burnTxHash, parsedAllocations });
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
    void startFarmJob({ jobId, job, record, burnTxHash, parsedAllocations });
    return sendJson(res, 200, { jobId, attached: true, status: 'pending' });
  }

  function handleStatus(res, jobId) {
    const job = jobs.get(jobId);
    if (!job) return sendJson(res, 404, { error: 'unknown jobId' });
    return sendJson(res, 200, publicJob(job));
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

  return async function relayerRouter(req, res) {
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
}
