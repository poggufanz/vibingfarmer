// frontend/src/components/pocket/NetworkIdentity.jsx
// Truthful, reusable network identity primitives: a badge (mark + always-visible label) and a
// route strip (source -> destination + transit status), both driven entirely by the canonical
// network model in src/design/networks.js. No surface should compute its own network label,
// arrow, or "arrived" claim -- see Foundation Task 4.
import {
  getNetworkMeta,
  NETWORK_TRANSIT_STATUS,
  normalizeNetworkContext,
} from '../../design/networks.js'

const BADGE_SIZES = new Set([14, 16])

// Standard badges are 16px and compact/mobile badges are 14px. An invalid explicit size falls
// back to the mode's standard rather than shipping an unreadable mark.
const badgeSize = (size, compact) => (BADGE_SIZES.has(size) ? size : compact ? 14 : 16)

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
export function NetworkBadge({ networkId, compact = false, size, className = '' }) {
  const meta = getNetworkMeta(networkId)
  const px = badgeSize(size ?? (compact ? 14 : 16), compact)

  return (
    <span
      className={`network-badge${className ? ` ${className}` : ''}`}
      data-network={meta.id || 'unknown'}
      data-compact={compact ? 'true' : 'false'}
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
// or elapsed time -- so the phrase shown always matches what the badge/route can prove. Detail
// phrases stay available for existing callers; the adjacent status label makes the state explicit
// for compact and full routes alike.
const TRANSIT_COPY = Object.freeze({
  none: (ctx) => `Settled on ${getNetworkMeta(ctx.custodyNetworkId).label}`,
  source: (ctx) => `Awaiting bridge on ${getNetworkMeta(ctx.sourceNetworkId).label}`,
  burning: (ctx) => `Bridging from ${getNetworkMeta(ctx.sourceNetworkId).label}`,
  attesting: () => 'Awaiting attestation',
  minting: (ctx) => `Minting on ${getNetworkMeta(ctx.destinationNetworkId).label}`,
  arrived: (ctx) => `Arrived on ${getNetworkMeta(ctx.destinationNetworkId).label}`,
  failed: (ctx) => `Bridge failed. Funds remain on ${getNetworkMeta(ctx.sourceNetworkId).label}`,
  unknown: () => 'Bridge status unknown',
})

function transitCopy(ctx) {
  const build = Object.prototype.hasOwnProperty.call(TRANSIT_COPY, ctx.transitState)
    ? TRANSIT_COPY[ctx.transitState]
    : TRANSIT_COPY.unknown
  return build ? build(ctx) : ''
}

function networkLabel(networkId) {
  return getNetworkMeta(networkId).label
}

// Drawn, not typed. The bundled Geist subsets declare U+2191/U+2193 but NOT U+2192, so a literal
// "→" always fell through to whatever system font the machine happened to have -- different
// advance width per machine, which shifted every route line and (at some widths) re-wrapped the
// surface, so frozen visual baselines could never survive a move between the authoring machine
// and CI. An inline SVG has the same box everywhere.
export function RouteArrowMark({ px = 16 }) {
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="network-route-arrow-mark"
    >
      <path
        d="M2.5 8h11M9.5 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
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

  // A route with a missing endpoint still has an explicit role in the UI. Keep each role
  // independent so an absent source/destination is rendered as Unknown network rather than being
  // silently borrowed from the host or the other endpoint.
  const sourceNetworkId = ctx.sourceNetworkId
  const destinationNetworkId = ctx.destinationNetworkId
  const sourceLabel = networkLabel(sourceNetworkId)
  const destinationLabel = networkLabel(destinationNetworkId)
  const custodyLabel = networkLabel(ctx.custodyNetworkId)
  const transitLabel = NETWORK_TRANSIT_STATUS[ctx.transitState] || NETWORK_TRANSIT_STATUS.unknown
  const detail = transitCopy(ctx)

  const showHostNote =
    Boolean(ctx.hostNetworkId) &&
    Boolean(ctx.custodyNetworkId) &&
    ctx.hostNetworkId !== ctx.custodyNetworkId

  return (
    <div
      className={rootClassName}
      data-transit={ctx.transitState}
      data-source-network={ctx.sourceNetworkId || 'unknown'}
      data-destination-network={ctx.destinationNetworkId || 'unknown'}
      data-custody-network={ctx.custodyNetworkId || 'unknown'}
      data-status={transitLabel.toLowerCase().replace(/\s+/g, '-')}
    >
      {isBridge ? (
        <div className="network-route-path">
          <NetworkBadge networkId={ctx.sourceNetworkId} compact={compact} size={px} />
          <span className="network-route-arrow" role="img" aria-label="to">
            <RouteArrowMark px={px} />
          </span>
          <NetworkBadge networkId={ctx.destinationNetworkId} compact={compact} size={px} />
        </div>
      ) : (
        <NetworkBadge networkId={destinationNetworkId} compact={compact} size={px} />
      )}
      <p className="network-route-facts" aria-label="Network route facts">
        <span className="network-route-source">Source: {sourceLabel}</span>
        <span className="network-route-destination">Destination: {destinationLabel}</span>
        <span className="network-route-custody">Custody: {custodyLabel}</span>
        <span className="network-route-transit">Transit: {ctx.transitState}</span>
        <span className="network-route-status-label">Status: {transitLabel}</span>
      </p>
      <p className="network-route-status">
        <span className="network-route-status-kind">{transitLabel}</span>
        <span className="network-route-status-detail">
          {compact ? `Status detail: ${detail}` : detail}
        </span>
      </p>
      {!compact && showHostNote && (
        <p className="network-route-host-note">
          Hosted on {getNetworkMeta(ctx.hostNetworkId).label}
        </p>
      )}
    </div>
  )
}
