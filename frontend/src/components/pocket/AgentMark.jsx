// frontend/src/components/pocket/AgentMark.jsx
// Per-agent identity mark -- a rounded seed/crew shape with a lower-left tail (Design Spec
// §6.6), geometrically distinct from the fixed product mark (BrandLockup: a closed, notch-only
// pocket). Fill is seeded ONLY from the required `identity` string (the agent's real address or
// run seed) so the same agent always gets the same color across reorder/remount/re-fetch --
// deriving it from list index instead would silently reassign colors on every re-sort, which is
// exactly the kind of quiet-but-wrong behavior this mark exists to avoid (Design Spec §6.6: "one
// crew mark always means one actually deployed account").
import { THEME_IDS, currentDomTheme } from '../../design/theme.js'
import { resolveAgentIdentity } from '../../design/pocket-crew-foundation.js'

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

// 36 added for Strategy Task 14 fix (owner report item 5): the Plan review crew avatars measured
// ~20-32px in a real browser and read as "nearly invisible" -- the contract's own base
// `.pc-agent-mark` size (pocket-crew.css) is 36px. Purely additive: every existing call site keeps
// whatever size it already passed, so no other frozen fixture's pixels move from this alone.
const VALID_SIZES = new Set([16, 20, 32, 36])

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

function identityInput(identity) {
  // Existing My Money rows pass their authoritative address string. Keep that caller contract
  // working while routing structured identities through the phase-aware Task 3 adapter. New rows
  // should pass the structured form so deployed/reused proof is explicit at the presentation
  // boundary.
  if (typeof identity === 'string') {
    const address = identity.trim()
    if (!address) return {}
    return {
      phase: 'deployed',
      verifiedAddress: address,
      verified: true,
      source: 'owner-discovery',
    }
  }
  if (!identity || typeof identity !== 'object') return {}
  return {
    phase: identity.phase,
    runId: identity.runId,
    allocationId:
      identity.allocationId || (identity.phase === 'planned' ? identity.key : undefined),
    verifiedAddress: identity.verifiedAddress || identity.address,
    verified: identity.verified,
    source: identity.source,
    state: identity.state,
  }
}

function resolveIdentity(identity) {
  return resolveAgentIdentity(identityInput(identity))
}

function labelForIdentity(identity) {
  if (identity.phase === 'planned') return 'Planned'
  if (identity.phase === 'deployed') return 'Deployed'
  if (identity.phase === 'reused') return 'Existing'
  return 'Agent identity unavailable'
}

function stateLabelFor(state) {
  const labels = {
    planned: 'Planned',
    creating: 'Creating',
    queued: 'Queued',
    ready: 'Ready',
    moving: 'Moving',
    depositing: 'Depositing',
    bridging: 'Bridging',
    'in-transit': 'In transit',
    working: 'Working',
    active: 'Active',
    confirmed: 'Confirmed',
    existing: 'Existing',
    deployed: 'Deployed',
    reused: 'Reused',
    failed: 'Failed',
    idle: 'Idle',
  }
  return Object.prototype.hasOwnProperty.call(labels, state) ? labels[state] : 'Unknown'
}

export function AgentMark({ identity, state = 'planned', size = 32, label, className = '' }) {
  const resolved = resolveIdentity(identity)
  const identityLabel = labelForIdentity(resolved)
  if (resolved.status !== 'available') {
    return (
      <span
        className={`pc-agent-mark-unavailable${className ? ` ${className}` : ''}`}
        role="status"
        aria-label="Agent identity unavailable"
        data-identity-state="unavailable"
      >
        Agent identity unavailable
      </span>
    )
  }

  const identityKey = resolved.key
  const px = VALID_SIZES.has(size) ? size : 32
  const theme = currentDomTheme()
  const fillIndex = hashIdentity(identityKey) % CREW_PALETTE.length
  const fill = CREW_PALETTE[fillIndex]
  const fillInk = CREW_INK_BY_THEME[theme][fillIndex]

  // A structured deployed/reused identity carries its phase as the real identity label. The
  // execution `state` remains caller-owned and is never derived from persona or row position.
  const executionState =
    state === 'planned' && resolved.state !== 'planned' ? resolved.state : state
  const stateLabel = stateLabelFor(executionState)
  const colorKey = Object.prototype.hasOwnProperty.call(STATE_COLOR_KEY, executionState)
    ? STATE_COLOR_KEY[executionState]
    : 'idle'
  const badgeFill = STATE_BADGE_VAR[colorKey]
  const badgeInk = STATE_INK_BY_THEME[theme][colorKey]
  const ariaLabel = `${identityLabel}${label ? ` ${label}` : ''}, ${stateLabel}`

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={px}
      height={px}
      viewBox="0 0 32 32"
      data-state={executionState}
      data-identity-state="available"
      data-identity-phase={resolved.phase}
      data-identity-source={resolved.source}
      data-identity-key={identityKey}
      data-verified={resolved.verified ? 'true' : 'false'}
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
