// frontend/src/base/relayerClient.js
// Client for the relayer's HTTP surface, reached ONLY through the same-origin Pages Function
// proxy (`/api/vf-cross` — frontend/api/vf-cross.js). The proxy is the capability boundary:
// JavaScript never holds a bearer token; the one-time capability crosses the wire exactly once
// inside `postMandate`'s registration body, the proxy installs it as an HttpOnly
// `__Host-vf-mandate-<id>` cookie, and every later protected call is a fixed-path POST whose
// JSON body names the public mandate/job identity the proxy maps back onto that cookie. A
// cross-origin `VITE_CROSS_RELAYER_BASE` override is deliberately ignored here — capability
// flows must never bypass the proxy's cookie translation boundary.
import { toBaseChainUnits, BASE_USDC_DECIMALS, assertBaseCrossChainAvailable } from './config.js'
import { BASE_POOL_CATALOG } from '../config.js'
import {
  isVerifiedBaseMandateStatus,
  normalizeBaseMandateStatus,
  publicBaseMandateEvidence,
} from './mandateStatus.js'

const DEFAULT_BASE_URL = '/api/vf-cross'
const DEFAULT_POLL_INTERVAL_MS = 3000
const DEFAULT_MAX_TRIES = 40 // ~2 minutes at the default interval

const CANONICAL_MANDATE_ID = /^[0-9a-f]{32}$/ // 128-bit lowercase hex
const CANONICAL_CAPABILITY = /^[0-9a-f]{64}$/ // 256-bit lowercase hex

// Capability authority only ever travels same-origin: a caller-supplied absolute/cross-origin
// base URL is rejected before any fetch so a stale local override can never route a protected
// call around the proxy.
function requireSameOriginBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('/') || baseUrl.startsWith('//')) {
    throw new Error('relayer calls must go through the same-origin proxy')
  }
  return baseUrl
}

function requireMandateIdentity(mandateId, message = 'invalid mandate identity') {
  if (!CANONICAL_MANDATE_ID.test(mandateId)) throw new Error(message)
  return mandateId
}

function requireJobIdentity(jobId) {
  if (!CANONICAL_MANDATE_ID.test(jobId)) throw new Error('invalid job identity')
  return jobId
}

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
 * Durably commit the immutable Base child intent before the browser is allowed to burn.
 * Returns only after the relayer has validated D1's authenticated 201 acknowledgement.
 * The mandate is named by its public `mandateId` — the proxy supplies the capability from the
 * matching HttpOnly cookie, so no approval blob or bearer value ever rides this request.
 * stellarOwner/kernelAddress bind the dispatch to the
 * owner it was mandated for; bridgeAgent/runId/grantTxHash default to null when the caller
 * doesn't have them yet (both are threaded through by baseLeg.js/crossChainFarm.js when known).
 * @param {{ sourceDomain: number, mandateId: string, stellarOwner?: string, kernelAddress?: string, bridgeAgent?: string, runId?: string, grantTxHash?: string, allocations: Array<object>, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ jobId: string, acknowledged: true, schemaVersion: 1 }>}
 */
export async function postFarm({
  sourceDomain,
  mandateId,
  allocations,
  stellarOwner = null,
  kernelAddress = null,
  bridgeAgent = null,
  runId = null,
  grantTxHash = null,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  assertBaseCrossChainAvailable()

  const base = requireSameOriginBaseUrl(baseUrl)
  requireMandateIdentity(mandateId)
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${base}/farm`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceDomain,
      mandateId,
      stellarOwner,
      kernelAddress,
      bridgeAgent,
      runId,
      grantTxHash,
      allocations: toWireAllocations(allocations, runId),
    }),
  })
  if (!res.ok) throw new Error(`farm dispatch failed (${res.status})`)
  if (res.status !== 201) throw new Error(`farm intent expected 201, got ${res.status}`)
  let acknowledgement
  try {
    acknowledgement = await res.json()
  } catch (error) {
    throw new Error('farm intent acknowledgement is malformed', { cause: error })
  }
  if (
    acknowledgement?.acknowledged !== true ||
    !CANONICAL_MANDATE_ID.test(acknowledgement?.jobId)
  ) {
    throw new Error('farm intent acknowledgement is malformed')
  }
  if (acknowledgement.schemaVersion !== 1) throw new Error('farm intent schema mismatch')
  return acknowledgement
}

/**
 * Attach the observed Stellar burn to a previously queued farm job. The relayer revalidates the
 * exact mandate identity/owner/kernel/binding (via the proxy's capability cookie) before it
 * starts execution; session key material is deliberately absent from this transition.
 */
export async function postFarmAttach({
  mandateId,
  jobId,
  burnTxHash,
  stellarOwner,
  kernelAddress,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  assertBaseCrossChainAvailable()

  const base = requireSameOriginBaseUrl(baseUrl)
  requireMandateIdentity(mandateId)
  requireJobIdentity(jobId)
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${base}/farm/attach`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mandateId,
      jobId,
      burnTxHash,
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
 * Fixed-path `POST /status` with a JSON identity: `{mandateId, jobId}` for a farm job (mandate
 * cookie authority) or `{jobId}` alone for an unwind job (Task 12's unwind cookie namespace —
 * a mandate cookie is never reused for it, so job-only polling fails closed until then).
 * @param {{ mandateId?: string, jobId: string, baseUrl?: string, intervalMs?: number, maxTries?: number, deps?: { fetchImpl?: Function, sleep?: Function } }} p
 * @returns {Promise<{ status: string, steps?: object }>}
 */
export async function pollFarmStatus({
  mandateId,
  jobId,
  baseUrl = DEFAULT_BASE_URL,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxTries = DEFAULT_MAX_TRIES,
  deps = {},
}) {
  const base = requireSameOriginBaseUrl(baseUrl)
  if (mandateId !== undefined) requireMandateIdentity(mandateId)
  requireJobIdentity(jobId)
  const { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps
  const identity = mandateId === undefined ? { jobId } : { mandateId, jobId }
  let last = { status: 'pending' }
  for (let i = 0; i < maxTries; i++) {
    const res = await fetchImpl(`${base}/status`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(identity),
    })
    if (!res.ok) throw new Error(`farm status check failed (${res.status})`)
    last = await res.json()
    if (last.status === 'done' || last.status === 'error') return last
    if (i < maxTries - 1) await sleep(intervalMs)
  }
  return last
}

// The exact public fields a strict 202 pending_activation acknowledgement may carry. Anything
// else — an echoed capability/approval/private key, an unexpected field, a nested object — is
// rejected as malformed rather than trusted or returned.
const REGISTRATION_RESPONSE_KEYS = Object.freeze([
  'ok',
  'status',
  'mandateId',
  'bindingId',
  'bindingHash',
  'relayerOrigin',
])

function isValidOrigin(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}

/**
 * Register a mandate's session key + one-time capability with the relayer ONCE (v3 capability
 * transport): the capability crosses the wire exactly here, inside this request body, and is
 * dropped from JavaScript state immediately after. The same-origin proxy validates the 202 and
 * installs the capability as an HttpOnly `__Host-vf-mandate-<mandateId>` cookie JavaScript can
 * never read back; later calls name only the public `mandateId`.
 * Accepts ONLY a strict 202 `{ok:true, status:'pending_activation', mandateId, bindingId,
 * bindingHash, relayerOrigin}` acknowledgement — any other lifecycle, echoed secret, or extra
 * field fails closed. Errors thrown here are fixed public messages: a dependency failure that
 * handled the raw capability/private key is never copied into an error.
 * Never log `sessionPrivateKey`/`capability` — this function only ever passes them through to
 * the request body.
 * @param {{ mandateId: string, capability: string, serializedApproval: string, sessionPrivateKey: string, sessionKeyAddress?: string, expiresAt: number, stellarOwner?: string, kernelAddress?: string, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ ok: true, status: 'pending_activation', mandateId: string, bindingId: string, bindingHash: string, relayerOrigin: string }>}
 */
export async function postMandate({
  mandateId,
  capability,
  serializedApproval,
  sessionPrivateKey,
  sessionKeyAddress,
  expiresAt,
  stellarOwner,
  kernelAddress,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  assertBaseCrossChainAvailable()

  const base = requireSameOriginBaseUrl(baseUrl)
  requireMandateIdentity(mandateId, 'mandate registration requires a canonical mandate identity')
  if (!CANONICAL_CAPABILITY.test(capability)) {
    throw new Error('mandate registration requires a canonical capability')
  }
  const { fetchImpl = fetch } = deps
  let res
  try {
    res = await fetchImpl(`${base}/mandate`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mandateId,
        capability,
        serializedApproval,
        sessionPrivateKey,
        sessionKeyAddress,
        expiresAt,
        stellarOwner,
        kernelAddress,
      }),
    })
  } catch {
    // The transport error may quote request material (capability, approval, private key) —
    // never copy it into the public error.
    throw new Error('mandate registration failed (transport error)')
  }
  if (!res.ok) throw new Error(`mandate registration failed (${res.status})`)
  if (res.status !== 202) {
    throw new Error(`mandate registration expected 202, got ${res.status}`)
  }
  let pending
  try {
    pending = await res.json()
  } catch {
    throw new Error('mandate registration acknowledgement is malformed')
  }
  const strict =
    !!pending &&
    typeof pending === 'object' &&
    !Array.isArray(pending) &&
    Object.keys(pending).every((key) => REGISTRATION_RESPONSE_KEYS.includes(key)) &&
    pending.ok === true &&
    pending.status === 'pending_activation' &&
    pending.mandateId === mandateId &&
    typeof pending.bindingId === 'string' &&
    pending.bindingId.length > 0 &&
    CANONICAL_CAPABILITY.test(pending.bindingHash) &&
    isValidOrigin(pending.relayerOrigin)
  if (!strict) throw new Error('mandate registration acknowledgement is malformed')
  return pending
}

/**
 * Check whether a previously-registered mandate is still usable, WITHOUT ever getting the
 * capability or session key back. Amount-free by contract: the fixed-path POST carries exactly
 * `{mandateId, stellarOwner, kernelAddress}` — no allocation, pool, amount, or minShares — and
 * no identity or authority appears in the URL.
 * @param {string} mandateId
 * @param {{ stellarOwner?: string, kernelAddress?: string, baseUrl?: string, deps?: { fetchImpl?: Function } }} [p]
 * @returns {Promise<import('../wallet/baseBinding.js').BaseMandateStatusV3>}
 */
export async function getMandateStatus(
  mandateId,
  { stellarOwner, kernelAddress, baseUrl = DEFAULT_BASE_URL, deps = {} } = {}
) {
  const base = requireSameOriginBaseUrl(baseUrl)
  requireMandateIdentity(mandateId)
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${base}/mandate/status`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mandateId, stellarOwner, kernelAddress }),
  })
  if (!res.ok) {
    throw Object.assign(new Error(`mandate status check failed (${res.status})`), {
      status: res.status,
    })
  }
  return publicBaseMandateEvidence(normalizeBaseMandateStatus(await res.json()))
}

/**
 * Poll a freshly registered mandate from `pending_activation` to remotely VERIFIED active
 * evidence. Fails closed: a terminal `activation_uncertain`/`revoked`/`expired`/`mismatch`/
 * `unknown` stops immediately (the public status is the only detail carried by the error), and
 * perpetual pending stops after `maxTries` rather than polling forever. A 429 rate-limited read
 * is retried as still pending (the proxy's per-minute bucket must not kill a slow activation),
 * while any other read failure aborts the ceremony immediately. Retry controls are validated
 * before the first read so a bad `maxTries`/`intervalMs` can never create an accidental
 * infinite loop.
 * @param {{ mandateId: string, stellarOwner: string, kernelAddress: string, intervalMs?: number, maxTries?: number, deps?: { getMandateStatus?: Function, sleep?: Function } }} p
 */
export async function waitForMandateActivation({
  mandateId,
  stellarOwner,
  kernelAddress,
  intervalMs = 1000,
  maxTries = 120,
  deps = {},
}) {
  if (!Number.isInteger(maxTries) || maxTries <= 0) {
    throw new Error('mandate activation polling requires a positive integer maxTries')
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('mandate activation polling requires a positive intervalMs')
  }
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    let evidence
    try {
      evidence = await (deps.getMandateStatus ?? getMandateStatus)(mandateId, {
        stellarOwner,
        kernelAddress,
        deps,
      })
    } catch (error) {
      if (error?.status !== 429) throw error
      // Rate-limited read: count it as a try and keep waiting rather than aborting the ceremony.
      if (attempt + 1 < maxTries) await sleep(intervalMs)
      continue
    }
    if (evidence.status === 'active' && isVerifiedBaseMandateStatus(evidence)) return evidence
    if (
      ['activation_uncertain', 'revoked', 'expired', 'mismatch', 'unknown'].includes(
        evidence.status
      )
    ) {
      throw new Error(`Base mandate activation stopped: ${evidence.status}`)
    }
    if (attempt + 1 < maxTries) await sleep(intervalMs)
  }
  throw new Error('Base mandate activation timed out')
}

/**
 * Revoke a registered mandate. The proxy authenticates the revoke against the mandate cookie
 * named by `mandateId`; stellarOwner/kernelAddress let the relayer confirm the binding rather
 * than trusting the identity alone.
 * @param {{ mandateId: string, stellarOwner?: string, kernelAddress?: string, baseUrl?: string, deps?: { fetchImpl?: Function } }} p
 * @returns {Promise<{ ok: boolean }>}
 */
export async function postMandateRevoke({
  mandateId,
  stellarOwner,
  kernelAddress,
  baseUrl = DEFAULT_BASE_URL,
  deps = {},
}) {
  const base = requireSameOriginBaseUrl(baseUrl)
  requireMandateIdentity(mandateId)
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${base}/mandate/revoke`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mandateId, stellarOwner, kernelAddress }),
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
  assertBaseCrossChainAvailable()

  const base = requireSameOriginBaseUrl(baseUrl)
  const { fetchImpl = fetch } = deps
  const res = await fetchImpl(`${base}/unwind`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unwindTxHash, stellarRecipient }),
  })
  if (!res.ok) throw new Error(`unwind dispatch failed (${res.status})`)
  return res.json()
}
