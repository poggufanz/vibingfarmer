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
  return NETWORK_META_BY_ID[networkId] || UNKNOWN_META
}

const TRANSIT_STATES = Object.freeze([
  'none',
  'source',
  'burning',
  'attesting',
  'minting',
  'arrived',
  'failed',
  'unknown',
])
const TRANSIT_STATE_SET = new Set(TRANSIT_STATES)

// A non-empty string network id is kept as-is even when unrecognized (see UNKNOWN_META above) --
// only null/undefined/non-string/blank collapse to null, meaning "no network in this role".
const toNetworkId = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : value
}

const toTransitState = (value, fallback) =>
  typeof value === 'string' && TRANSIT_STATE_SET.has(value) ? value : fallback

/**
 * Sanitizes an arbitrary object into the canonical NetworkContext shape:
 * `{ hostNetworkId, sourceNetworkId, destinationNetworkId, custodyNetworkId, transitState }`.
 *
 * Enforces the one truth rule this module exists for: custody can only equal the destination
 * once transitState is 'arrived'. Any input that claims destination custody earlier is
 * corrected back onto the source (falling back to host, then null).
 */
export function normalizeNetworkContext(context) {
  const raw = context && typeof context === 'object' ? context : {}
  const hostNetworkId = toNetworkId(raw.hostNetworkId)
  const sourceNetworkId = toNetworkId(raw.sourceNetworkId)
  const destinationNetworkId = toNetworkId(raw.destinationNetworkId)
  // A context that never mentions transitState at all describes a plain, non-bridge item (no
  // transit modeled) -- 'none'. One that mentions it with a garbage value is actively lying or
  // broken, which is exactly what the visible 'unknown' state is for.
  const transitState = toTransitState(raw.transitState, 'transitState' in raw ? 'unknown' : 'none')
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
  return CHAIN_ALIASES[value.toLowerCase()] ?? value
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
  const a = allocation && typeof allocation === 'object' ? allocation : {}
  const destinationNetworkId = resolveChainId(a.chain)
  const hostNetworkId = resolveChainId(a.hostChain) ?? NETWORK_IDS.STELLAR_TESTNET
  const isBridging = Boolean(a.bridge) && typeof a.bridge === 'object'
  const transitState = isBridging ? toTransitState(a.bridge.status, 'unknown') : 'none'
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
