// frontend/src/components/pocket/AgentMark.jsx
// Per-agent identity mark -- a rounded seed/crew shape with a lower-left tail (Design Spec
// §6.6), geometrically distinct from the fixed product mark (BrandLockup: a closed, notch-only
// pocket). Fill is seeded ONLY from the required `identity` string (the agent's real address or
// run seed) so the same agent always gets the same color across reorder/remount/re-fetch --
// deriving it from list index instead would silently reassign colors on every re-sort, which is
// exactly the kind of quiet-but-wrong behavior this mark exists to avoid (Design Spec §6.6: "one
// crew mark always means one actually deployed account").
import { THEME_IDS, currentDomTheme } from '../../design/theme.js'

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

// The two absolute ink extremes this design system uses everywhere (Field/Rice, §6.2) -- picking
// between exactly these two, per fill, is what keeps text legible without inventing new colors.
const INK_DARK = '#17251F'
const INK_LIGHT = '#F2F5EF'

// Which ink reads correctly on each crew swatch, per theme -- precomputed against the literal
// hex values in pocket-crew.css via contrastRatio() and exhaustively registered in
// src/design/contrast.js (forest.crewInk/crew1..6, day.crewInk/crew1..6, all >=4.5:1). A fill
// that is light enough for dark ink in one theme can be recalibrated dark enough to need light
// ink in the other (see day-field's --pc-crew-2/4/6), so this table is genuinely per-theme, not
// a single global choice. Re-run the calibration and update both this table and the registry
// together if a --pc-crew-* hex ever changes.
const CREW_INK_BY_THEME = Object.freeze({
  [THEME_IDS.FOREST]: [INK_DARK, INK_DARK, INK_DARK, INK_DARK, INK_DARK, INK_DARK],
  [THEME_IDS.DAY_FIELD]: [INK_DARK, INK_LIGHT, INK_DARK, INK_LIGHT, INK_DARK, INK_LIGHT],
})

const STATE_LABEL = Object.freeze({
  planned: 'Planned',
  existing: 'Existing',
  active: 'Active',
  confirmed: 'Confirmed',
  failed: 'Failed',
  idle: 'Idle',
})

// State is dual-coded (text glyph + color); no state relies on color alone. `colorKey` groups
// states that share an underlying semantic color (planned/existing/idle all read as "not yet
// live", so they share the muted tone) -- this is the join key into both maps below.
const STATE_COLOR_KEY = Object.freeze({
  planned: 'idle',
  existing: 'idle',
  idle: 'idle',
  active: 'active',
  confirmed: 'confirmed',
  failed: 'failed',
})

const STATE_BADGE_VAR = Object.freeze({
  active: 'var(--pc-harvest)',
  confirmed: 'var(--pc-ink)',
  failed: 'var(--pc-danger)',
  idle: 'var(--pc-muted)',
})

// Ink for the state-badge glyph, chosen against that badge's own fixed color (not the crew fill
// -- the glyph is drawn fully inside the solid badge circle, so it never has to fight the
// identity color underneath). Registered in src/design/contrast.js as forest.stateInk/* and
// day.stateInk/* -- all >=4.5:1 (well past the 3:1 a small glyph needs).
const STATE_INK_BY_THEME = Object.freeze({
  [THEME_IDS.FOREST]: { active: INK_DARK, confirmed: INK_DARK, failed: INK_DARK, idle: INK_DARK },
  [THEME_IDS.DAY_FIELD]: {
    active: INK_DARK,
    confirmed: INK_LIGHT,
    failed: INK_LIGHT,
    idle: INK_LIGHT,
  },
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
  const theme = currentDomTheme()
  const fillIndex = hasIdentity ? hashIdentity(identity) % CREW_PALETTE.length : 0
  const fill = hasIdentity ? CREW_PALETTE[fillIndex] : 'var(--pc-disabled)'
  // The fallback (missing-identity) fill isn't a registered crew swatch -- INK_DARK is a safe,
  // reasonable default for that rare, dev-already-warned-about path rather than a formally
  // verified pairing.
  const fillInk = hasIdentity ? CREW_INK_BY_THEME[theme][fillIndex] : INK_DARK

  const stateLabel = STATE_LABEL[state] || state
  const colorKey = STATE_COLOR_KEY[state] || 'idle'
  const badgeFill = STATE_BADGE_VAR[colorKey]
  const badgeInk = STATE_INK_BY_THEME[theme][colorKey]
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
      <path d={BODY_D} fill={fill} />
      <path d={TAIL_D} fill={fill} />
      {label && (
        <text x="16" y="19" textAnchor="middle" className="pc-agent-mark-label" fill={fillInk}>
          {label}
        </text>
      )}
      {/* Always-present visible state cue -- a short text glyph inside its own solid badge, not
          a color-only dot and never drawn directly over the (arbitrary) identity fill -- so both
          the badge and its text stay legible regardless of which crew color this agent got. */}
      <circle cx="23" cy="25" r="6.25" fill={badgeFill} />
      <text x="23" y="27.5" textAnchor="middle" className="pc-agent-mark-state" fill={badgeInk}>
        {stateLabel.charAt(0)}
      </text>
    </svg>
  )
}
