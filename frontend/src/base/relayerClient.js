// frontend/src/base/relayerClient.js
// Client for the SP2 relayer's HTTP surface. `// VERIFY:` SP2 (a separate, not-yet-executed
// phase) owns relayer/src/flows/{farm.mjs,unwind.mjs} as importable functions but has not yet
// defined how the browser reaches them over HTTP. This module documents and implements a
// concrete contract — POST /api/vf-cross/farm, GET /api/vf-cross/status/:jobId, POST
// /api/vf-cross/unwind — consistent with this repo's existing Cloudflare Pages Functions
// catch-all pattern (frontend/functions/api/vf/[[path]].js -> frontend/api/vf/_router.js). If
// SP2 lands a different path or response shape, only this file's URL-building and response
// parsing need to change — crossChainFarm.js and the screens never construct URLs themselves.
import { toBaseChainUnits, BASE_USDC_DECIMALS } from './config.js'
import { BASE_POOL_CATALOG } from '../config.js'

const DEFAULT_BASE_URL = import.meta.env?.VITE_CROSS_RELAYER_BASE || '/api/vf-cross'
const DEFAULT_POLL_INTERVAL_MS = 3000
const DEFAULT_MAX_TRIES = 40 // ~2 minutes at the default interval

// Fix loop 2, Fix 2b: the set of proxy targets a canonical `${runId}:bridge:${proxyTarget}`
// allocationId may end in — the same vocabulary relayer/src/httpRouter.mjs:246-262 resolves via
// its own pool-address lookup. `frontend/src/crossChainFarm.js`'s pre-burn guard (Fix 2a) already
// does the full pool-address-bound resolution for every real caller (both screens/Farm.jsx and
// baseLeg.js dispatch through runFarmFlow, never postFarm directly), so this client-seam check is
// deliberately the lighter of the two: it rejects a non-canonical SHAPE (e.g. the array-index
// suffix `run-42:bridge:0` orchestrator.js:1060 can produce) without re-deriving proxyTarget from
// `a.pool` — preserving this module's existing "an explicit reviewed allocationId is forwarded
// verbatim" contract for callers that legitimately don't have a pool-catalog entry to check
// against yet.
const KNOWN_BASE_PROXY_TARGETS = new Set(BASE_POOL_CATALOG.map((entry) => entry.proxyTarget))

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

// VF Wallet Task 6 wire envelope: wraps the already-quantized/serialized allocation (still
// computed by quantizeAllocations/serializeAllocations above, untouched — this is a precision-
// critical path with its own dedicated test coverage) into the binding plan's cross-boundary
// shape `{allocationId, poolAddress, amount:{token,units,decimals}}`. minShares rides along as an
// extra field (not in the plan's example, but dropping it would silently remove the live-quoted
// slippage floor baseLeg.js computes per pool — see base/quotes.js).
function toWireAllocations(allocations, runId) {
  return serializeAllocations(allocations).map((a) => {
    if (typeof a.allocationId !== 'string' || !a.allocationId) {
      throw new Error('every farm allocation requires its reviewed allocationId')
    }
    if (runId) {
      const prefix = `${runId}:bridge:`
      const proxyTarget = a.allocationId.startsWith(prefix)
        ? a.allocationId.slice(prefix.length)
        : null
      if (!proxyTarget || !KNOWN_BASE_PROXY_TARGETS.has(proxyTarget)) {
        throw new Error(
          'allocationId does not match the reviewed run and a known Base proxy target'
        )
      }
    }
    return {
      allocationId: a.allocationId,
      poolAddress: a.pool,
      amount: { token: 'USDC', units: a.amount, decimals: BASE_USDC_DECIMALS },
      minShares: a.minShares,
    }
  })
}

/**
 * Dispatch the farm flow: relay the Stellar burn (forward CCTP) then fan out session-key
 * deposits across `allocations`. Returns immediately with a job id to poll. `burnTxHash` may be
 * null — a job can be queued/accepted before a burn hash is observed; a later attach/callback
 * fills it in (relayer side, Task 7's job). stellarOwner/kernelAddress bind the dispatch to the
 * owner it was mandated for; bridgeAgent/runId/grantTxHash default to null when the caller
 * doesn't have them yet (both are threaded through by baseLeg.js/crossChainFarm.js when known).
 * @param {{ burnTxHash: string|null, sourceDomain: number, serializedApproval: string, stellarOwner?: string, kernelAddress?: string, bridgeAgent?: string, runId?: string, grantTxHash?: string, allocations: Array<object>, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ jobId: string }>}
 */
export async function postFarm({
  burnTxHash = null,
  sourceDomain,
  serializedApproval,
  allocations,
  stellarOwner = null,
  kernelAddress = null,
  bridgeAgent = null,
  runId = null,
  grantTxHash = null,
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
      stellarOwner,
      kernelAddress,
      bridgeAgent,
      runId,
      grantTxHash,
      allocations: toWireAllocations(allocations, runId),
    }),
  })
  if (!res.ok) throw new Error(`farm dispatch failed (${res.status})`)
  return res.json()
}

/**
 * Attach the observed Stellar burn to a previously queued farm job. The relayer revalidates the
 * exact mandate approval/owner/kernel/binding before it starts execution; session key material is
 * deliberately absent from this transition.
 */
export async function postFarmAttach({
  jobId,
  burnTxHash,
  serializedApproval,
  stellarOwner,
  kernelAddress,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${baseUrl}/farm/attach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      burnTxHash,
      serializedApproval,
      stellarOwner,
      kernelAddress,
    }),
  })
  if (!res.ok) throw new Error(`farm burn attach failed (${res.status})`)
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
 * `expiresAt` (unix seconds) sets how long the relayer will honor it — baseLeg.js requests a
 * 7-day window (MANDATE_WINDOW_SECONDS) so a repeat run can reuse it via getMandateStatus below
 * instead of repeating the wallet ceremony every time. stellarOwner/kernelAddress bind the
 * registration to the owner it was minted for (VF Wallet Task 6).
 * Never log `sessionPrivateKey` — this function only ever passes it through to the request body.
 * @param {{ serializedApproval: string, sessionPrivateKey: string, sessionKeyAddress?: string, expiresAt: number, stellarOwner?: string, kernelAddress?: string, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ ok: boolean }>}
 */
export async function postMandate({
  serializedApproval,
  sessionPrivateKey,
  sessionKeyAddress,
  expiresAt,
  stellarOwner,
  kernelAddress,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${baseUrl}/mandate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serializedApproval,
      sessionPrivateKey,
      sessionKeyAddress,
      expiresAt,
      stellarOwner,
      kernelAddress,
    }),
  })
  if (!res.ok) throw new Error(`mandate registration failed (${res.status})`)
  return res.json()
}

// Normalizes whatever the relayer answers into the canonical BaseMandateStatusV2 shape (binding
// plan §3). The real relayer server is not migrated by this task (Task 7's job) and today answers
// the older `{valid, expiresAt}` shape — `status` falls back to 'active'/'unknown' from `valid`
// so callers can rely on `.status` regardless of which relayer generation answers. Unknown fields
// are null, never guessed, per the "never render unknown as healthy" rule — 'unknown' fails every
// gate the same way 'expired'/'missing' do (only 'active' passes).
function normalizeMandateStatus(body = {}, { stellarOwner, kernelAddress } = {}) {
  return {
    stellarOwner: body.stellarOwner ?? stellarOwner ?? null,
    kernelAddress: body.kernelAddress ?? kernelAddress ?? null,
    sessionKeyAddress: body.sessionKeyAddress ?? null,
    relayerOrigin: body.relayerOrigin ?? null,
    expiresAt: body.expiresAt ?? null,
    status: body.status ?? (body.valid ? 'active' : 'unknown'),
    bindingId: body.bindingId ?? null,
    bindingHash: body.bindingHash ?? null,
  }
}

/**
 * Check whether a previously-registered mandate is still reusable, WITHOUT ever getting the
 * session key back. Lets baseLeg.js skip the owner ceremony + a fresh mandate mint on a repeat
 * run. stellarOwner/kernelAddress (VF Wallet Task 6) travel with the request so the relayer can
 * confirm the binding, not just that the approval blob itself is unexpired somewhere.
 * @param {string} serializedApproval
 * @param {{ stellarOwner?: string, kernelAddress?: string, baseUrl?: string, deps?: { fetchImpl?: Function } }} [p]
 * @returns {Promise<import('../wallet/baseBinding.js').BaseMandateStatusV2>}
 */
export async function getMandateStatus(
  serializedApproval,
  { stellarOwner, kernelAddress, baseUrl = DEFAULT_BASE_URL, deps = {} } = {}
) {
  const { fetchImpl = fetch } = deps
  let qs = `approval=${encodeURIComponent(serializedApproval)}`
  if (stellarOwner) qs += `&stellarOwner=${encodeURIComponent(stellarOwner)}`
  if (kernelAddress) qs += `&kernelAddress=${encodeURIComponent(kernelAddress)}`
  const res = await fetchImpl(`${baseUrl}/mandate/valid?${qs}`)
  if (!res.ok) throw new Error(`mandate status check failed (${res.status})`)
  return normalizeMandateStatus(await res.json(), { stellarOwner, kernelAddress })
}

/**
 * Revoke a registered mandate. stellarOwner/kernelAddress let the relayer authenticate the revoke
 * against the binding it stored at registration time rather than trusting the approval blob alone.
 * @param {{ serializedApproval: string, stellarOwner?: string, kernelAddress?: string, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ ok: boolean }>}
 */
export async function postMandateRevoke({
  serializedApproval,
  stellarOwner,
  kernelAddress,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${baseUrl}/mandate/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serializedApproval, stellarOwner, kernelAddress }),
  })
  if (!res.ok) throw new Error(`mandate revoke failed (${res.status})`)
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
