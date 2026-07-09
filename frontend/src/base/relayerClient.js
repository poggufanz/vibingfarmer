// frontend/src/base/relayerClient.js
// Client for the SP2 relayer's HTTP surface. `// VERIFY:` SP2 (a separate, not-yet-executed
// phase) owns relayer/src/flows/{farm.mjs,unwind.mjs} as importable functions but has not yet
// defined how the browser reaches them over HTTP. This module documents and implements a
// concrete contract — POST /api/vf-cross/farm, GET /api/vf-cross/status/:jobId, POST
// /api/vf-cross/unwind — consistent with this repo's existing Cloudflare Pages Functions
// catch-all pattern (frontend/functions/api/vf/[[path]].js -> frontend/api/vf/_router.js). If
// SP2 lands a different path or response shape, only this file's URL-building and response
// parsing need to change — crossChainFarm.js and the screens never construct URLs themselves.
import { toBaseChainUnits } from './config.js'

const DEFAULT_BASE_URL = import.meta.env?.VITE_CROSS_RELAYER_BASE || '/api/vf-cross'
const DEFAULT_POLL_INTERVAL_MS = 3000
const DEFAULT_MAX_TRIES = 40 // ~2 minutes at the default interval

// `a.amount` arrives as a DISPLAY float (e.g. 33.333...) from venice.js's allocateBasePools —
// the mandate cap path (CrossChainFarmFlow.jsx) already converts its own copy via
// toBaseChainUnits for the on-chain cap, but the deposit path's `a.amount` stays a display value
// all the way to this wire boundary. The relayer (httpRouter.mjs parseAllocations) expects base
// units and does BigInt(a.amount) — a bare display float becomes dust (or throws on a fractional
// string). Convert here, at the seam, so `a.amount` stays a display value everywhere else (UI,
// the mandate cap computation). A bigint here is ALREADY base units (defensive — no known caller
// passes one today) — stringify as-is rather than re-scaling it.
function serializeAllocations(allocations) {
  return allocations.map((a) => ({
    ...a,
    amount: typeof a.amount === 'bigint' ? a.amount.toString() : toBaseChainUnits(a.amount).toString(),
    minShares: typeof a.minShares === 'bigint' ? a.minShares.toString() : a.minShares,
  }))
}

/**
 * Dispatch the farm flow: relay the Stellar burn (forward CCTP) then fan out session-key
 * deposits across `allocations`. Returns immediately with a job id to poll.
 * @param {{ burnTxHash: string, sourceDomain: number, serializedApproval: string, allocations: Array<object>, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ jobId: string }>}
 */
export async function postFarm({
  burnTxHash,
  sourceDomain,
  serializedApproval,
  allocations,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${baseUrl}/farm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      burnTxHash,
      sourceDomain,
      serializedApproval,
      allocations: serializeAllocations(allocations),
    }),
  })
  if (!res.ok) throw new Error(`farm dispatch failed (${res.status})`)
  return res.json()
}

/**
 * Poll job status until terminal (`done`/`error`) or `maxTries` is exhausted — never hangs
 * forever. Returns whatever the last poll saw either way; the caller decides what "still
 * pending after maxTries" means for the UI (§7: funds stay recoverable, this never blocks them).
 * @param {{ jobId: string, baseUrl?: string, intervalMs?: number, maxTries?: number, deps?: { fetchImpl?: Function, sleep?: Function } }} p
 * @returns {Promise<{ status: string, steps?: object }>}
 */
export async function pollFarmStatus({
  jobId,
  baseUrl = DEFAULT_BASE_URL,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxTries = DEFAULT_MAX_TRIES,
  deps = {},
}) {
  const { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps
  let last = { status: 'pending' }
  for (let i = 0; i < maxTries; i++) {
    const res = await fetchImpl(`${baseUrl}/status/${jobId}`)
    if (res.ok) last = await res.json()
    if (last.status === 'done' || last.status === 'error') return last
    if (i < maxTries - 1) await sleep(intervalMs)
  }
  return last
}

/**
 * Register a mandate's session key with the relayer ONCE (controller decision, plan Option 2):
 * subsequent farm requests reference the mandate by `serializedApproval` alone, so the session
 * private key crosses the wire exactly one time per mandate, not once per farm dispatch. The
 * relayer stores it in-memory keyed by `serializedApproval` (see relayer/src/httpRouter.mjs).
 * Never log `sessionPrivateKey` — this function only ever passes it through to the request body.
 * @param {{ serializedApproval: string, sessionPrivateKey: string, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ ok: boolean }>}
 */
export async function postMandate({
  serializedApproval,
  sessionPrivateKey,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${baseUrl}/mandate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serializedApproval, sessionPrivateKey }),
  })
  if (!res.ok) throw new Error(`mandate registration failed (${res.status})`)
  return res.json()
}

/**
 * Hand the (already owner-signed) unwind batch tx hash to the relayer, which watches for the
 * withdraw receipts and relays the reverse CCTP mint back to Stellar.
 * @param {{ unwindTxHash: string, stellarRecipient: string, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ jobId: string }>}
 */
export async function postUnwind({
  unwindTxHash,
  stellarRecipient,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${baseUrl}/unwind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unwindTxHash, stellarRecipient }),
  })
  if (!res.ok) throw new Error(`unwind dispatch failed (${res.status})`)
  return res.json()
}
