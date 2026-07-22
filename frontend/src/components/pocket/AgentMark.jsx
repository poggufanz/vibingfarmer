// frontend/src/components/pocket/AgentMark.jsx
// Per-agent identity mark -- a rounded seed/crew shape with a lower-left tail (Design Spec
// §6.6), geometrically distinct from the fixed product mark (BrandLockup: a closed, notch-only
// pocket). Fill is seeded ONLY from the required `identity` string (the agent's real address or
// run seed) so the same agent always gets the same color across reorder/remount/re-fetch --
// deriving it from list index instead would silently reassign colors on every re-sort, which is
// exactly the kind of quiet-but-wrong behavior this mark exists to avoid (Design Spec §6.6: "one
// crew mark always means one actually deployed account").

// Fixed crew palette -- CSS custom properties so each swatch stays theme-correct (forest/day)
// without this component needing its own theme detection; see pocket-crew.css.
const CREW_PALETTE = [
  'var(--pc-crew-1)',
  'var(--pc-crew-2)',
  'var(--pc-crew-3)',
  'var(--pc-crew-4)',
  'var(--pc-crew-5)',
  'var(--pc-crew-6)',
]

const STATE_LABEL = Object.freeze({
  planned: 'Planned',
  existing: 'Existing',
  active: 'Active',
  confirmed: 'Confirmed',
  failed: 'Failed',
  idle: 'Idle',
})

// State is dual-coded (text/icon + color); no state relies on color alone. Color reuses the
// existing semantic tokens rather than inventing new ones.
const STATE_COLOR_VAR = Object.freeze({
  planned: 'var(--pc-muted)',
  existing: 'var(--pc-muted)',
  active: 'var(--pc-harvest)',
  confirmed: 'var(--pc-ink)',
  failed: 'var(--pc-danger)',
  idle: 'var(--pc-muted)',
})

const VALID_SIZES = new Set([16, 20, 32])

// Deterministic djb2-style string hash -- a pure function of `identity`, so the resulting
// palette index never depends on render order, list position, or remounts.
function hashIdentity(identity) {
  let hash = 5381
  for (let i = 0; i < identity.length; i += 1) {
    hash = (hash * 33 + identity.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function crewColorFor(identity) {
  return CREW_PALETTE[hashIdentity(identity) % CREW_PALETTE.length]
}

// Body: a rounded vertical capsule (seed silhouette). Tail: a small triangle poking out past the
// body's lower-left edge -- the one required distinguishing feature vs. the product mark.
const BODY_D =
  'M16 4C10.477 4 6 8.477 6 14V20C6 25.523 10.477 30 16 30C21.523 30 26 25.523 26 20V14C26 8.477 21.523 4 16 4Z'
const TAIL_D = 'M9 25L9 30L4 28Z'

export function AgentMark({ identity, state = 'planned', size = 32, label, className = '' }) {
  const hasIdentity = typeof identity === 'string' && identity.trim() !== ''
  if (!hasIdentity) {
    const message =
      'AgentMark: `identity` is required (the agent address or run seed) and must never fall ' +
      'back to a list index -- list position is not a stable identity.'
    // Loud in development so a missing identity is caught before it ships; production renders a
    // visibly neutral fallback (never crashes the surrounding UI over a decorative mark).
    if (import.meta.env.DEV) throw new Error(message)
    // eslint-disable-next-line no-console
    console.error(message)
  }

  const px = VALID_SIZES.has(size) ? size : 32
  const stateLabel = STATE_LABEL[state] || state
  const fill = hasIdentity ? crewColorFor(identity) : 'var(--pc-disabled)'
  const stroke = STATE_COLOR_VAR[state] || STATE_COLOR_VAR.idle
  const ariaLabel = `${label ? `${label} agent` : 'Agent'}, ${stateLabel}`

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={px}
      height={px}
      viewBox="0 0 32 32"
      data-state={state}
      className={`pc-agent-mark pc-agent-mark--${px}${className ? ` ${className}` : ''}`}
    >
      <path d={BODY_D} fill={fill} stroke={stroke} strokeWidth="2" />
      <path d={TAIL_D} fill={fill} stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
      {label && (
        <text x="16" y="19" textAnchor="middle" className="pc-agent-mark-label">
          {label}
        </text>
      )}
      {/* Always-present visible state cue -- a short text abbreviation, not a color-only dot --
          so state reads correctly even when `label` already occupies the center glyph. */}
      <text x="23" y="27" textAnchor="middle" className="pc-agent-mark-state" fill={stroke}>
        {stateLabel.charAt(0)}
      </text>
    </svg>
  )
}
