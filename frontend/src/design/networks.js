// frontend/src/design/networks.js
// Canonical, truthful network identity + route state for the primary Stellar testnet flow and
// the optional Base Sepolia leg. Every surface that names a network, shows its mark, or claims
// where funds currently sit (badges, agent/position rows, Credits/About) reads NETWORK_IDS /
// getNetworkMeta / NETWORK_CREDITS from here instead of duplicating a label, mark path, or
// trademark line -- see Foundation Task 4.
//
// The one rule this module exists to enforce: a bridged allocation's custody can only be
// attributed to the destination network once its transit has actually arrived. Every other
// transitState (source/burning/attesting/minting/failed/unknown) keeps custody on the source
// (or host) network -- even if a caller's raw data mistakenly claims otherwise. The
// pre-arrival-bridge-never-claims-Base-custody invariant is enforced in normalizeNetworkContext
// so it holds no matter which caller builds the context.

export const NETWORK_IDS = Object.freeze({
  STELLAR_TESTNET: 'stellar-testnet',
  BASE_SEPOLIA: 'base-sepolia',
})

const STELLAR_META = Object.freeze({
  id: NETWORK_IDS.STELLAR_TESTNET,
  label: 'Stellar testnet',
  markPath: '/brand/networks/stellar.svg',
  sourceUrl: 'https://stellar.org/brand-resources',
  trademarkNotice:
    'Stellar and the Stellar logo are trademarks of the Stellar Development Foundation (SDF). Shown here under the SDF brand policy to indicate that this project builds on the Stellar network.',
  independenceNotice:
    'Vibing Farmer is an independent project running on Stellar testnet. It is not issued, endorsed, or sponsored by the Stellar Development Foundation.',
})

const BASE_META = Object.freeze({
  id: NETWORK_IDS.BASE_SEPOLIA,
  label: 'Base Sepolia',
  markPath: '/brand/networks/base.svg',
  sourceUrl: 'https://brand.base.org/core-identifiers',
  trademarkNotice:
    'Base and the Base Square mark are trademarks of Coinbase. Shown here under the public Base brand guidelines to identify the optional Base Sepolia leg.',
  independenceNotice:
    'Vibing Farmer is an independent project. Its optional Base Sepolia leg is not affiliated with or endorsed by Coinbase or the Base team.',
})

// Returned whenever a networkId is missing or not one of the two known networks above. The label
// stays visible on purpose -- an unrecognized id must never collapse to a blank icon or a silent
// no-op; the user always sees that a network claim exists and could not be identified.
const UNKNOWN_META = Object.freeze({
  id: null,
  label: 'Unknown network',
  markPath: null,
  sourceUrl: '',
  trademarkNotice: '',
  independenceNotice: '',
})

const NETWORK_META_BY_ID = Object.freeze({
  [NETWORK_IDS.STELLAR_TESTNET]: STELLAR_META,
  [NETWORK_IDS.BASE_SEPOLIA]: BASE_META,
})

/** Immutable roster for Credits/About surfaces -- every known network, in a fixed order. */
export const NETWORK_CREDITS = Object.freeze([STELLAR_META, BASE_META])

/**
 * @param {string} networkId one of NETWORK_IDS' values
 * @returns {{
 *   id: string|null, label: string, markPath: string|null, sourceUrl: string,
 *   trademarkNotice: string, independenceNotice: string,
 * }}
 */
export function getNetworkMeta(networkId) {
  return Object.prototype.hasOwnProperty.call(NETWORK_META_BY_ID, networkId)
    ? NETWORK_META_BY_ID[networkId]
    : UNKNOWN_META
}

export const NETWORK_TRANSIT_STATES = Object.freeze([
  'none',
  'source',
  'burning',
  'attesting',
  'minting',
  'arrived',
  'failed',
  'unknown',
])
const TRANSIT_STATE_SET = new Set(NETWORK_TRANSIT_STATES)

// Presentation labels stay beside the canonical route states so every route variant can expose
// the same evidence-backed status without inventing a second vocabulary in a component.
export const NETWORK_TRANSIT_STATUS = Object.freeze({
  none: 'Settled',
  source: 'Awaiting bridge',
  burning: 'In transit',
  attesting: 'In transit',
  minting: 'In transit',
  arrived: 'Arrived',
  failed: 'Failed',
  unknown: 'Unavailable',
})

// A non-empty string network id is kept as-is even when unrecognized (see UNKNOWN_META above) --
// only null/undefined/non-string/blank collapse to null, meaning "no network in this role".
const toNetworkId = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : value
}

const toTransitState = (value, fallback) =>
  typeof value === 'string' && TRANSIT_STATE_SET.has(value) ? value : fallback

const NETWORK_CONTEXT_KEYS = Object.freeze([
  'hostNetworkId',
  'sourceNetworkId',
  'destinationNetworkId',
  'custodyNetworkId',
  'transitState',
])

// Read only own data descriptors in one snapshot. Direct property reads would invoke an
// inherited or own getter, and `in` would treat prototype claims as evidence. A revoked or
// adversarial proxy can also throw while descriptors are collected; returning null lets callers
// use the all-unknown shape instead of leaking that error into a money-facing surface.
function ownDataSnapshot(value, keys = []) {
  if (!value || typeof value !== 'object') return null

  let descriptors
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    return null
  }

  const values = Object.create(null)
  const accessorKeys = new Set()
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor) continue
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      values[key] = descriptor.value
    } else {
      accessorKeys.add(key)
    }
  }

  return { values, accessorKeys }
}

const EMPTY_CONTEXT = Object.freeze({
  hostNetworkId: null,
  sourceNetworkId: null,
  destinationNetworkId: null,
  custodyNetworkId: null,
  transitState: 'none',
})

const UNAVAILABLE_CONTEXT = Object.freeze({
  hostNetworkId: null,
  sourceNetworkId: null,
  destinationNetworkId: null,
  custodyNetworkId: null,
  transitState: 'unknown',
})

/**
 * Sanitizes an arbitrary object into the canonical NetworkContext shape:
 * `{ hostNetworkId, sourceNetworkId, destinationNetworkId, custodyNetworkId, transitState }`.
 *
 * Enforces the one truth rule this module exists for: custody can only equal the destination
 * once transitState is 'arrived'. Any input that claims destination custody earlier is
 * corrected back onto the source (falling back to host, then null).
 */
export function normalizeNetworkContext(context) {
  if (!context || typeof context !== 'object') return EMPTY_CONTEXT
  const snapshot = ownDataSnapshot(context, NETWORK_CONTEXT_KEYS)
  if (!snapshot) return UNAVAILABLE_CONTEXT

  const raw = snapshot.values
  const hostNetworkId = toNetworkId(raw.hostNetworkId)
  const sourceNetworkId = toNetworkId(raw.sourceNetworkId)
  const destinationNetworkId = toNetworkId(raw.destinationNetworkId)
  // A context that never mentions transitState at all describes a plain, non-bridge item (no
  // transit modeled) -- 'none'. One that mentions it with a garbage value is actively lying or
  // broken, which is exactly what the visible 'unknown' state is for.
  const transitState = toTransitState(
    raw.transitState,
    snapshot.accessorKeys.has('transitState') ||
      Object.prototype.hasOwnProperty.call(raw, 'transitState')
      ? 'unknown'
      : 'none'
  )
  let custodyNetworkId = toNetworkId(raw.custodyNetworkId)

  const claimsDestinationEarly =
    transitState !== 'arrived' &&
    destinationNetworkId !== null &&
    custodyNetworkId === destinationNetworkId
  if (claimsDestinationEarly) {
    custodyNetworkId = sourceNetworkId ?? hostNetworkId ?? null
  }

  return Object.freeze({
    hostNetworkId,
    sourceNetworkId,
    destinationNetworkId,
    custodyNetworkId,
    transitState,
  })
}

// Short aliases already used elsewhere in this codebase for pool/vault records (config.js's
// `chain: 'stellar' | 'base'`) resolve to the canonical ids; the canonical ids themselves also
// pass straight through so callers can pass either.
const CHAIN_ALIASES = Object.freeze({
  stellar: NETWORK_IDS.STELLAR_TESTNET,
  'stellar-testnet': NETWORK_IDS.STELLAR_TESTNET,
  base: NETWORK_IDS.BASE_SEPOLIA,
  'base-sepolia': NETWORK_IDS.BASE_SEPOLIA,
})

// Unrecognized chain strings pass through unchanged (rather than becoming null) so an
// unsupported/future chain still surfaces truthfully as "Unknown network" downstream instead of
// silently disappearing.
const resolveChainId = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return null
  const alias = value.toLowerCase()
  return Object.prototype.hasOwnProperty.call(CHAIN_ALIASES, alias) ? CHAIN_ALIASES[alias] : value
}

/**
 * Derives a NetworkContext from an allocation-shaped record.
 *
 * @param {{
 *   chain?: string,       // destination/settlement chain, e.g. 'stellar' | 'base' (aliases ok)
 *   hostChain?: string,   // chain the owning agent account/position lives on; defaults to
 *                         // Stellar testnet (agent accounts are always Soroban-hosted)
 *   bridge?: { status?: 'source'|'burning'|'attesting'|'minting'|'arrived'|'failed' },
 *             // present only for allocations funded through the optional CCTP leg
 * }} allocation
 * @returns {ReturnType<typeof normalizeNetworkContext>}
 */
export function networkContextForAllocation(allocation) {
  if (!allocation || typeof allocation !== 'object') {
    return normalizeNetworkContext({ hostNetworkId: NETWORK_IDS.STELLAR_TESTNET })
  }
  const allocationSnapshot = ownDataSnapshot(allocation, ['chain', 'hostChain', 'bridge'])
  if (!allocationSnapshot) return UNAVAILABLE_CONTEXT

  // An explicit accessor is malformed input. Ignore the allocation rather than allowing a
  // different field (for example `chain: 'base'`) to turn an unreadable bridge claim into a
  // settled Base position.
  if (allocationSnapshot.accessorKeys.size > 0) return UNAVAILABLE_CONTEXT

  const a = allocationSnapshot.values
  const destinationNetworkId = resolveChainId(a.chain)
  const hostNetworkId = resolveChainId(a.hostChain) ?? NETWORK_IDS.STELLAR_TESTNET
  const bridge = a.bridge
  const hasOwnBridgeData = Object.prototype.hasOwnProperty.call(a, 'bridge')
  const isBridging = Boolean(bridge) && typeof bridge === 'object'

  // A known or future destination that differs from its host is a cross-network claim. It must
  // carry an own bridge data descriptor; otherwise inherited metadata (or an omitted bridge)
  // could turn an unreadable Stellar-hosted transfer into settled destination custody. Same-chain
  // resident positions remain valid without bridge evidence (including Base host -> Base).
  const destinationDiffersHost =
    destinationNetworkId !== null &&
    hostNetworkId !== null &&
    destinationNetworkId !== hostNetworkId
  if (destinationDiffersHost && (!hasOwnBridgeData || !isBridging)) return UNAVAILABLE_CONTEXT

  const bridgeSnapshot = isBridging ? ownDataSnapshot(bridge, ['status']) : null
  if (isBridging && !bridgeSnapshot) return UNAVAILABLE_CONTEXT
  const transitState = isBridging ? toTransitState(bridgeSnapshot.values.status, 'unknown') : 'none'
  const sourceNetworkId = isBridging ? hostNetworkId : destinationNetworkId
  // Only an actually-arrived job may claim the destination holds the funds; every other transit
  // state (including a bridging allocation with no reported status at all) keeps custody on the
  // source/host, matching normalizeNetworkContext's guard below.
  const custodyNetworkId = transitState === 'arrived' ? destinationNetworkId : sourceNetworkId

  return normalizeNetworkContext({
    hostNetworkId,
    sourceNetworkId,
    destinationNetworkId,
    custodyNetworkId,
    transitState,
  })
}
