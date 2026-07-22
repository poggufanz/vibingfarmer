// frontend/src/strategy/venueTruth.js
// Strategy Task 1 (Pocket Crew redesign, Wave 1). Truthful venue records: exactly one live
// Stellar execution venue (this product's own Autofarm vault, supplying Blend Capital v2) and,
// optionally, a set of Base Sepolia custody-only proxy pools that carry NO protocol yield claim.
// Every later Strategy task is meant to consume ONLY the guards exported here — never read
// venueKind/networkId/yield/disclosure off a raw catalog record directly — so a single place
// (this file) is the one spot that can lie, and it doesn't.
import { NETWORK_IDS } from '../design/networks.js'

export const VENUE_KINDS = Object.freeze({
  STELLAR_LIVE: 'stellar-live',
  BASE_CUSTODY_PROXY: 'base-custody-proxy',
})

// The only real Stellar execution target: our own Autofarm vault, which supplies into Blend
// Capital v2. Every Stellar-side record normalizes to this destination regardless of whatever
// protocol/name string a fetched or fabricated input claims — that is the whole point of this
// module (see buildMergedCatalog in mergedCatalog.js, which stamps this over live inputs too).
const STELLAR_DESTINATION = 'Autofarm Vault → Blend Capital v2'
const STELLAR_LIVE_DISCLOSURE =
  'Vibing Farmer Autofarm supplies to Blend Capital v2 on Stellar testnet.'

// Sentence form, matching the Foundation `VenueTruth` primitive's BASE_PROXY_COPY constant
// (frontend/src/components/pocket/Primitives.jsx) EXACTLY -- an approved-ruling override of this
// task's brief, which spelled the same fact as 'Base Sepolia proxy · custody only · no
// protocol yield' (two middle dots). That form conflicts with the ruling of at most one middle dot
// per line, so the sentence form below is used instead, aligned with Foundation's copy.
//
// Duplicated here rather than imported: Primitives.jsx is a JSX component module (imports React +
// NetworkIdentity.jsx) that is not in this task's file list to touch, and its BASE_PROXY_COPY
// constant is not exported -- importing it would both pull the design/React layer into this pure
// strategy-data module AND require modifying an out-of-scope file. venueTruth.test.js instead reads
// Primitives.jsx's source text directly and asserts the two literals stay equal, so drift is still
// caught without either dependency.
const BASE_PROXY_DISCLOSURE = 'Base Sepolia proxy. Custody only. No protocol yield.'

const NONE_YIELD = Object.freeze({ state: 'none', apy: null })
const UNAVAILABLE_YIELD = Object.freeze({ state: 'unavailable', apy: null })

// ponytail: no task has wired a genuinely live per-venue yield feed into the `{state:'live', apy,
// asOf}` shape yet (today's `apy` fields on catalog/live-fetch records are flat legacy numbers that
// normalizeVenue intentionally never trusts as "live" -- see normalizeYield below). This TTL only
// matters once such a feed exists; it mirrors vaultFactsLive.js's 6h cache TTL for consistency.
// Tighten it if a later task specifies a stricter freshness bound for on-chain yield.
const MAX_LIVE_YIELD_AGE_MS = 6 * 60 * 60 * 1000

function isProxyKind(venueKind) {
  return venueKind === VENUE_KINDS.BASE_CUSTODY_PROXY
}

// Only an explicit, well-shaped `{ state: 'live', apy: <finite number> }` (optionally with a
// fresh `asOf`) is ever treated as live. A flat top-level `apy` number -- which is what every
// current input (the static config.js catalog, the DeFiLlama fetch in defiLlama.js) actually
// carries -- is deliberately NOT recognized here: that is "no static APY elevated to current/live
// yield." Absent, malformed, or stale live yield is truthfully 'unavailable', never coerced to 0.
function normalizeYield(raw, venueKind, nowMs) {
  if (isProxyKind(venueKind)) return NONE_YIELD // custody-only -- apy is always ignored, never partially trusted
  const y = raw?.yield
  if (!y || y.state !== 'live' || typeof y.apy !== 'number' || !Number.isFinite(y.apy)) {
    return UNAVAILABLE_YIELD
  }
  if (typeof y.asOf === 'number' && nowMs - y.asOf > MAX_LIVE_YIELD_AGE_MS) return UNAVAILABLE_YIELD
  return { state: 'live', apy: y.apy }
}

/**
 * Normalizes an arbitrary raw venue-shaped record into the canonical truth record. Idempotent
 * (normalizing an already-normalized record returns the same shape). `raw.venueKind` is the only
 * signal trusted to select Base-custody-proxy vs. Stellar-live; callers that stamp venueKind
 * explicitly (buildMergedCatalog) control which bucket a record lands in regardless of any other
 * field (protocol/name/apy) the record claims.
 *
 * @param {object} raw
 * @param {{now?: number}} [opts]
 */
export function normalizeVenue(raw, { now = Date.now() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const venueKind = isProxyKind(r.venueKind)
    ? VENUE_KINDS.BASE_CUSTODY_PROXY
    : VENUE_KINDS.STELLAR_LIVE
  const isProxy = isProxyKind(venueKind)

  return Object.freeze({
    name: r.name || (isProxy ? undefined : 'Vibing Farmer Autofarm'),
    protocol: isProxy ? 'vf-erc4626-proxy' : r.protocol || 'blend-usdc',
    factSlug: r.factSlug,
    address: r.address,
    networkId: isProxy ? NETWORK_IDS.BASE_SEPOLIA : NETWORK_IDS.STELLAR_TESTNET,
    venueKind,
    // Legacy alias some existing (pre-truth) consumers still tag/filter on.
    chain: isProxy ? 'base' : 'stellar',
    destination: isProxy ? undefined : STELLAR_DESTINATION,
    // Planned-mainnet label only -- never an execution or yield claim. See disclosure below.
    proxyTarget: isProxy ? r.proxyTarget : undefined,
    yield: normalizeYield(r, venueKind, now),
    disclosure: isProxy ? BASE_PROXY_DISCLOSURE : STELLAR_LIVE_DISCLOSURE,
  })
}

/** @returns {{state: 'live'|'none'|'unavailable', apy: number|null}} */
export function venueYield(raw) {
  return normalizeVenue(raw).yield
}

/** @returns {string} the one truthful sentence describing where this venue's funds sit. */
export function venueDisclosure(raw) {
  return normalizeVenue(raw).disclosure
}

/** @returns {boolean} true only for a venue currently reporting a genuinely live, fresh APY. */
export function isLiveYieldVenue(raw) {
  return venueYield(raw).state === 'live'
}

/**
 * Throws for a venue record that cannot actually execute (no address). Returns the normalized
 * record otherwise, so a caller can use this as a validating pass-through right before dispatch.
 */
export function assertExecutableVenue(raw) {
  const v = normalizeVenue(raw)
  if (!v.address) {
    throw new Error(`Venue "${v.name || v.proxyTarget || v.protocol}" has no execution address.`)
  }
  return v
}
