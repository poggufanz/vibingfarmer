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

/**
 * Convert strategist display allocations to exact Base USDC units once, using largest remainder.
 * Display `amount` is retained for the UI; every security/execution boundary consumes the added
 * bigint `amountBaseUnits`. This prevents independently rounded mandate caps and deposits from
 * drifting by one base unit. Ties are stable, so the earliest pool receives the first remainder.
 *
 * Calling this with already-quantized allocations is idempotent (fresh object copies, same units).
 * @param {Array<object>} allocations
 * @param {{ targetUnits?: bigint }} options - authoritative Base 6dp total when supplied
 * @returns {Array<object & { amountBaseUnits: bigint }>}
 */
export function quantizeAllocations(allocations, { targetUnits } = {}) {
  if (!Array.isArray(allocations)) throw new Error('allocations must be an array')
  const hasExplicitTarget = targetUnits !== undefined
  if (hasExplicitTarget && (typeof targetUnits !== 'bigint' || targetUnits <= 0n)) {
    throw new Error('targetUnits must be a positive bigint')
  }
  if (hasExplicitTarget && allocations.length === 0) {
    throw new Error('cannot apportion positive targetUnits across an empty allocation list')
  }
  if (allocations.length === 0) return []

  const hasExactUnits = allocations.map((a) => typeof a.amountBaseUnits === 'bigint')
  if (hasExactUnits.every(Boolean)) {
    if (allocations.some((a) => a.amountBaseUnits <= 0n)) {
      throw new Error('every amountBaseUnits value must be positive')
    }
    const exactTotal = allocations.reduce((sum, a) => sum + a.amountBaseUnits, 0n)
    if (hasExplicitTarget && exactTotal !== targetUnits) {
      throw new Error(`pre-quantized allocations sum to ${exactTotal}, expected ${targetUnits}`)
    }
    return allocations.map((a) => ({ ...a }))
  }
  if (hasExactUnits.some(Boolean)) {
    throw new Error('allocations must either all include amountBaseUnits or none include it')
  }
  if (
    !allocations.every(
      (a) => typeof a.amount === 'number' && Number.isFinite(a.amount) && a.amount > 0
    )
  ) {
    throw new Error('quantizeAllocations requires positive finite display-number amounts')
  }

  const displayTotal = allocations.reduce((sum, a) => sum + a.amount, 0)
  const exactTarget = hasExplicitTarget ? targetUnits : toBaseChainUnits(displayTotal)
  if (exactTarget <= 0n) throw new Error('allocation target must be positive')

  // Turn display amounts into fixed-precision proportional weights, then do Hamilton/largest-
  // remainder apportionment entirely with bigint. The target stays exact even for totals above
  // Number.MAX_SAFE_INTEGER, while display floats are used only to choose relative weights.
  const WEIGHT_SCALE = 1_000_000_000_000
  const weights = allocations.map((a) =>
    BigInt(Math.max(1, Math.round((a.amount / displayTotal) * WEIGHT_SCALE)))
  )
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n)
  const floors = weights.map((weight) => (exactTarget * weight) / totalWeight)
  const remainders = weights.map((weight) => (exactTarget * weight) % totalWeight)
  const distributed = floors.reduce((sum, floor) => sum + floor, 0n)
  const deficit = exactTarget - distributed
  if (deficit < 0n || deficit > BigInt(allocations.length)) {
    throw new Error('largest-remainder apportionment produced an invalid deficit')
  }
  const bumped = new Set(
    remainders
      .map((remainder, i) => ({ i, remainder }))
      .sort((a, b) =>
        a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1
      )
      .slice(0, Number(deficit))
      .map((x) => x.i)
  )

  const quantized = allocations.map((a, i) => ({
    ...a,
    amountBaseUnits: floors[i] + (bumped.has(i) ? 1n : 0n),
  }))
  if (quantized.some((a) => a.amountBaseUnits <= 0n)) {
    throw new Error('targetUnits is too small to give every allocation a positive cap')
  }
  return quantized
}

// The production flow arrives pre-quantized. Numeric and bigint `amount` branches remain as a
// compatibility seam for older/standalone callers; they are deliberately not used by
// CrossChainFarmFlow. The exact-unit field is removed from JSON because bigint is not serializable.
function serializeAllocations(allocations) {
  const serializeMinShares = (a) =>
    typeof a.minShares === 'bigint' ? a.minShares.toString() : a.minShares

  const hasExactUnits = allocations.map((a) => typeof a.amountBaseUnits === 'bigint')
  if (hasExactUnits.some(Boolean) && !hasExactUnits.every(Boolean)) {
    throw new Error('allocations must either all include amountBaseUnits or none include it')
  }
  if (hasExactUnits.every(Boolean) && allocations.length > 0) {
    return allocations.map(({ amountBaseUnits, ...a }) => ({
      ...a,
      amount: amountBaseUnits.toString(),
      minShares: serializeMinShares(a),
    }))
  }

  if (allocations.every((a) => typeof a.amount === 'number')) {
    return quantizeAllocations(allocations).map(({ amountBaseUnits, ...a }) => ({
      ...a,
      amount: amountBaseUnits.toString(),
      minShares: serializeMinShares(a),
    }))
  }

  return allocations.map((a) => ({
    ...a,
    amount:
      typeof a.amount === 'bigint' ? a.amount.toString() : toBaseChainUnits(a.amount).toString(),
    minShares: serializeMinShares(a),
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
 * `expiry` (unix seconds) sets how long the relayer will honor it — baseLeg.js requests a 7-day
 * window (MANDATE_WINDOW_SECONDS) so a repeat run can reuse it via getMandateStatus below instead
 * of repeating the wallet ceremony every time.
 * Never log `sessionPrivateKey` — this function only ever passes it through to the request body.
 * @param {{ serializedApproval: string, sessionPrivateKey: string, expiry: number, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ ok: boolean }>}
 */
export async function postMandate({
  serializedApproval,
  sessionPrivateKey,
  expiry,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${baseUrl}/mandate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serializedApproval, sessionPrivateKey, expiry }),
  })
  if (!res.ok) throw new Error(`mandate registration failed (${res.status})`)
  return res.json()
}

/**
 * Check whether a previously-registered mandate is still reusable, WITHOUT ever getting the
 * session key back — the relayer's GET /mandate/valid only ever answers {valid, expiresAt}. Lets
 * baseLeg.js skip the owner ceremony + a fresh mandate mint on a repeat run.
 * @param {string} serializedApproval
 * @param {{ baseUrl?: string, deps?: { fetchImpl?: Function } }} [p]
 * @returns {Promise<{ valid: boolean, expiresAt?: number }>}
 */
export async function getMandateStatus(
  serializedApproval,
  { baseUrl = DEFAULT_BASE_URL, deps = {} } = {}
) {
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(
    `${baseUrl}/mandate/valid?approval=${encodeURIComponent(serializedApproval)}`
  )
  if (!res.ok) throw new Error(`mandate status check failed (${res.status})`)
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
