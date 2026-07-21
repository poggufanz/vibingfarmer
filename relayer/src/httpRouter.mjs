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

/**
 * @param {Object} deps
 * @param {(sessionPrivateKey: string) => { farm: Function }} deps.buildFarm - per-request farm
 *   flow factory (constructs orchestrator + createFarmFlow); never persists the key it's given.
 * @param {(params: { unwindTxHash: string, stellarRecipient: string }) => Promise<{status:string, mintTxHash?:string}>} deps.relayUnwindMint
 * @param {Map<string, {status:string, steps:Array<object>}>} deps.jobs - jobId -> job record
 * @param {{get:Function, set:Function, status:Function}} deps.mandates - serializedApproval ->
 *   sessionPrivateKey (process memory only; a TTL-evicting store — see mandateStore.mjs).
 *   `status(key)` backs GET /mandate/valid and must never return the stored key itself.
 * @param {() => string} deps.genId
 * @param {boolean} [deps.sanitizeErrors=false] - when true, error job records (returned verbatim by
 *   GET /status) carry a generic message and the real error is logged server-side only. Off by
 *   default so local dev / the smoke harness keep full detail; the standalone server turns it ON
 *   unless RELAYER_DEBUG_ERRORS=1 (see server.mjs), so a public deploy never leaks internal error
 *   strings (RPC URLs, addresses) to whoever holds a jobId.
 */
export function createRelayerRouter({ buildFarm, relayUnwindMint, jobs, mandates, genId, sanitizeErrors = false }) {
  // Record a failed job. Client-facing message is generic when sanitizeErrors is on; the real
  // error is always available server-side (console.error) for debugging. Never stores the key.
  function recordError(jobId, step, err) {
    if (sanitizeErrors) {
      console.error(`[relayer] job ${jobId} step ${step} failed:`, err);
      jobs.set(jobId, { status: 'error', steps: [{ step, status: 'error', message: 'internal error' }] });
    } else {
      jobs.set(jobId, { status: 'error', steps: [{ step, status: 'error', message: errorMessage(err) }] });
    }
  }
  // Durable mandate window: the client (baseLeg.js) requests a 7-day expiry so a repeat run can
  // reuse the mandate with zero wallet ceremony; this cap just bounds how far out a client may
  // push it (a compromised/buggy client asking for a 10-year key would otherwise be honored).
  const MAX_MANDATE_WINDOW_SECONDS = 30 * 24 * 3600;

  function handleMandate(req, res) {
    const { serializedApproval, sessionPrivateKey, expiry } = req.body || {};
    if (!serializedApproval || !sessionPrivateKey) {
      return sendJson(res, 400, { error: 'serializedApproval and sessionPrivateKey are required' });
    }
    const nowSeconds = Date.now() / 1000;
    if (typeof expiry !== 'number' || expiry <= nowSeconds || expiry > nowSeconds + MAX_MANDATE_WINDOW_SECONDS) {
      return sendJson(res, 400, {
        error: 'expiry must be a unix-seconds timestamp in the future, at most 30 days out',
      });
    }
    // The key is sent exactly once and lives only in this in-memory map for the process
    // lifetime — NEVER logged, NEVER echoed back. expiry arrives in unix SECONDS; the store
    // wants ms.
    mandates.set(serializedApproval, sessionPrivateKey, expiry * 1000);
    return sendJson(res, 200, { ok: true });
  }

  // Lets the client check whether a previously-registered mandate is still reusable WITHOUT ever
  // getting the session key back — the response is {valid, expiresAt} only.
  function handleMandateValid(req, res) {
    const approval = new URL(req.url, 'http://local').searchParams.get('approval');
    if (!approval) return sendJson(res, 400, { error: 'approval query param is required' });
    const { valid, expiresAt } = mandates.status(approval);
    return sendJson(res, 200, { valid, expiresAt });
  }

  function parseAllocations(allocations) {
    return allocations.map((a) => ({ pool: a.pool, amount: BigInt(a.amount), minShares: BigInt(a.minShares) }));
  }

  async function runFarmJob(jobId, sessionPrivateKey, farmParams) {
    try {
      const { farm } = buildFarm(sessionPrivateKey);
      const { mintResult, depositResults } = await farm(farmParams);
      jobs.set(jobId, {
        status: 'done',
        steps: [
          { step: 'mint', status: mintResult.status, mintTxHash: mintResult.mintTxHash },
          { step: 'deposits', results: depositResults },
        ],
      });
    } catch (err) {
      // Error only — the sessionPrivateKey must never end up in a job record.
      recordError(jobId, 'farm', err);
    }
  }

  function handleFarm(req, res) {
    const { burnTxHash, serializedApproval, allocations } = req.body || {};
    if (!burnTxHash || !serializedApproval || !Array.isArray(allocations) || allocations.length === 0) {
      return sendJson(res, 400, { error: 'burnTxHash, serializedApproval and allocations are required' });
    }
    const sessionPrivateKey = mandates.get(serializedApproval);
    if (!sessionPrivateKey) {
      return sendJson(res, 400, { error: 'unknown mandate' });
    }

    let parsedAllocations;
    try {
      parsedAllocations = parseAllocations(allocations);
    } catch {
      return sendJson(res, 400, { error: 'invalid allocation amount/minShares' });
    }

    const jobId = genId();
    jobs.set(jobId, { status: 'pending', steps: [] });
    sendJson(res, 200, { jobId });

    // Fire-and-forget: the client polls GET /status/:jobId. The client's `sourceDomain` is
    // intentionally ignored — createFarmFlow hardcodes domains.stellar as the mint source.
    void runFarmJob(jobId, sessionPrivateKey, {
      burnTxHash, execId: burnTxHash, approval: serializedApproval, allocations: parsedAllocations,
    });
  }

  function handleStatus(res, jobId) {
    const job = jobs.get(jobId);
    if (!job) return sendJson(res, 404, { error: 'unknown jobId' });
    return sendJson(res, 200, job);
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
    if (req.method === 'POST' && path === '/farm') return handleFarm(req, res);
    if (req.method === 'POST' && path === '/unwind') return handleUnwind(req, res);
    if (req.method === 'GET') {
      const statusMatch = path.match(/^\/status\/([^/]+)$/);
      if (statusMatch) return handleStatus(res, decodeURIComponent(statusMatch[1]));
      if (path === '/mandate/valid') return handleMandateValid(req, res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  };
}
