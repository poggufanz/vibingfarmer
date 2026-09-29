// frontend/src/components/pocket/AgentMark.jsx
// Per-agent identity mark -- a round identity chip carrying a status icon, geometrically distinct
// from the fixed product mark (BrandLockup: a closed, notch-only pocket) and from the rounded-
// square persona avatars it sits beside. Fill is seeded ONLY from the required `identity` string
// (the agent's real address or run seed) so the same agent always gets the same color across
// reorder/remount/re-fetch --
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

// Which ink reads correctly on each crew swatch, per theme -- the status icon is drawn in it,
// precomputed against the literal hex values in pocket-crew.css via contrastRatio() and
// exhaustively registered in src/design/contrast.js (forest.crewInk/crew1..6,
// day.crewInk/crew1..6, all >=4.5:1, well past the 3:1 a graphic needs). A fill
// that is light enough for dark ink in one theme can be recalibrated dark enough to need light
// ink in the other (see day-field's --pc-crew-2/4/6), so this table is genuinely per-theme, not
// a single global choice. Re-run the calibration and update both this table and the registry
// together if a --pc-crew-* hex ever changes.
const CREW_INK_BY_THEME = Object.freeze({
  [THEME_IDS.FOREST]: [INK_DARK, INK_DARK, INK_DARK, INK_DARK, INK_DARK, INK_DARK],
  [THEME_IDS.DAY_FIELD]: [INK_DARK, INK_LIGHT, INK_DARK, INK_LIGHT, INK_DARK, INK_LIGHT],
})

// State is coded by icon shape, never by color: the chip's color is the identity, so a status
// color on top of it would fight it. `glyph` groups states that read the same way (planned/
// existing/idle are all "not yet live": an open ring).
const STATE_GLYPH = Object.freeze({
  planned: 'idle',
  existing: 'idle',
  idle: 'idle',
  active: 'active',
  confirmed: 'confirmed',
  failed: 'failed',
})

// Icons on the 32-unit grid, centered on (16,16). Stroked icons use round caps; `active` is a
// filled play triangle so it differs from the stroked ones in weight as well as outline.
const GLYPH_D = Object.freeze({
  idle: 'M16 11.25A4.75 4.75 0 1 1 16 20.75A4.75 4.75 0 1 1 16 11.25Z',
  active: 'M13 10.5L22 16L13 21.5Z',
  confirmed: 'M10.5 16.5L14.25 20.25L21.5 12.25',
  failed: 'M11.75 11.75L20.25 20.25M20.25 11.75L11.75 20.25',
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

// Body: a full circle -- round against the rounded-square persona avatars and the pocket product
// mark, so it never reads as a second logo.
const BODY_D = 'M16 1A15 15 0 1 1 16 31A15 15 0 1 1 16 1Z'

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
  const glyph = Object.prototype.hasOwnProperty.call(STATE_GLYPH, executionState)
    ? STATE_GLYPH[executionState]
    : 'idle'
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
      {/* Always-present state cue, coded by shape. `label` stays in the accessible name only:
          no caller's label ever fit legibly inside the chip. */}
      <path
        d={GLYPH_D[glyph]}
        className="pc-agent-mark-state"
        data-glyph={glyph}
        fill={glyph === 'active' ? fillInk : 'none'}
        stroke={fillInk}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
