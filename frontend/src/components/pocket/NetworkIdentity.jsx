// frontend/src/components/pocket/NetworkIdentity.jsx
// Truthful, reusable network identity primitives: a badge (mark + always-visible label) and a
// route strip (source -> destination + transit status), both driven entirely by the canonical
// network model in src/design/networks.js. No surface should compute its own network label,
// arrow, or "arrived" claim -- see Foundation Task 4.
import { getNetworkMeta, normalizeNetworkContext } from '../../design/networks.js'

const BADGE_SIZES = new Set([14, 16])

// size accepts only 14 or 16 for in-product badges; anything else quietly falls back to 16
// rather than shipping an unreadable mark.
const badgeSize = (size) => (BADGE_SIZES.has(size) ? size : 16)

/** Neutral outlined glyph shown when a network has no mark asset (unknown network). Decorative. */
function FallbackMark({ px }) {
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="network-mark network-mark--fallback"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M1.75 8h12.5M8 1.75c2.1 1.75 2.1 10.75 0 12.5M8 1.75c-2.1 1.75-2.1 10.75 0 12.5"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  )
}

/**
 * A network mark plus its always-visible name -- `Stellar testnet` or `Base Sepolia` (or
 * `Unknown network`). The mark image is decorative (`alt=""`) because the visible text is what
 * carries the accessible name; a missing/unrecognized network falls back to a neutral outlined
 * glyph so the icon is never empty.
 */
export function NetworkBadge({ networkId, size = 16, className = '' }) {
  const meta = getNetworkMeta(networkId)
  const px = badgeSize(size)

  return (
    <span
      className={`network-badge${className ? ` ${className}` : ''}`}
      data-network={meta.id || 'unknown'}
    >
      {meta.markPath ? (
        <img src={meta.markPath} alt="" width={px} height={px} className="network-mark" />
      ) : (
        <FallbackMark px={px} />
      )}
      <span className="network-badge-label">{meta.label}</span>
    </span>
  )
}

// Transit copy is derived purely from the canonical transitState -- never from animation timing
// or elapsed time -- so the phrase shown always matches what the badge/route can prove.
const TRANSIT_COPY = Object.freeze({
  source: (ctx) => `Awaiting bridge on ${getNetworkMeta(ctx.sourceNetworkId).label}`,
  burning: (ctx) => `Bridging from ${getNetworkMeta(ctx.sourceNetworkId).label}`,
  attesting: () => 'Awaiting attestation',
  minting: (ctx) => `Minting on ${getNetworkMeta(ctx.destinationNetworkId).label}`,
  arrived: (ctx) => `Arrived on ${getNetworkMeta(ctx.destinationNetworkId).label}`,
  failed: (ctx) => `Bridge failed. Funds remain on ${getNetworkMeta(ctx.sourceNetworkId).label}`,
  unknown: () => 'Bridge status unknown',
})

function transitCopy(ctx) {
  const build = TRANSIT_COPY[ctx.transitState]
  return build ? build(ctx) : ''
}

/**
 * Renders a network route. A single badge when there is nothing to bridge (source equals
 * destination, or there is no destination at all); otherwise source, an accessible arrow, then
 * destination, plus a truthful transit phrase. When the account's host network differs from
 * where funds are currently custodied (e.g. a Stellar-hosted agent whose bridge has arrived on
 * Base), that gets its own line so "hosted on" is never conflated with "funds are on".
 */
export function NetworkRoute({ context, compact = false, className = '' }) {
  const ctx = normalizeNetworkContext(context)
  const px = compact ? 14 : 16
  const rootClassName = `network-route${compact ? ' network-route--compact' : ''}${
    className ? ` ${className}` : ''
  }`

  const isBridge =
    Boolean(ctx.sourceNetworkId) &&
    Boolean(ctx.destinationNetworkId) &&
    ctx.sourceNetworkId !== ctx.destinationNetworkId

  if (!isBridge) {
    const soleNetworkId = ctx.destinationNetworkId || ctx.sourceNetworkId || ctx.hostNetworkId
    return (
      <div className={rootClassName} data-transit={ctx.transitState}>
        <NetworkBadge networkId={soleNetworkId} size={px} />
      </div>
    )
  }

  const phrase = transitCopy(ctx)
  const showHostNote =
    Boolean(ctx.hostNetworkId) &&
    Boolean(ctx.custodyNetworkId) &&
    ctx.hostNetworkId !== ctx.custodyNetworkId

  return (
    <div className={rootClassName} data-transit={ctx.transitState}>
      <div className="network-route-path">
        <NetworkBadge networkId={ctx.sourceNetworkId} size={px} />
        <span className="network-route-arrow" role="img" aria-label="to">
          →
        </span>
        <NetworkBadge networkId={ctx.destinationNetworkId} size={px} />
      </div>
      {!compact && phrase && <p className="network-route-status">{phrase}</p>}
      {!compact && showHostNote && (
        <p className="network-route-host-note">
          Hosted on {getNetworkMeta(ctx.hostNetworkId).label}
        </p>
      )}
    </div>
  )
}
