import { FOUNDATION_CREW_TOKENS, FOUNDATION_THEMES } from './pocket-crew-contract.js'

const freezeRequirement = (requirement) => Object.freeze(requirement)

const FOREST = FOUNDATION_THEMES.forest
const DAY_FIELD = FOUNDATION_THEMES['day-field']
const FOREST_CREW = FOUNDATION_CREW_TOKENS.forest
const DAY_FIELD_CREW = FOUNDATION_CREW_TOKENS['day-field']

export const CONTRAST_REQUIREMENTS = Object.freeze(
  [
    ['forest.text/canvas', FOREST['--pc-ink'], FOREST['--pc-canvas'], 4.5],
    ['forest.text/workspace', FOREST['--pc-ink'], FOREST['--pc-workspace'], 4.5],
    ['forest.muted/canvas', FOREST['--pc-muted'], FOREST['--pc-canvas'], 4.5],
    ['forest.muted/workspace', FOREST['--pc-muted'], FOREST['--pc-workspace'], 4.5],
    ['forest.ownedInk/owned', FOREST['--pc-owned-ink'], FOREST['--pc-owned'], 4.5],
    ['forest.ownedMuted/owned', FOREST['--pc-owned-muted'], FOREST['--pc-owned'], 4.5],
    ['forest.harvestInk/harvest', FOREST['--pc-harvest-ink'], FOREST['--pc-harvest'], 4.5],
    ['forest.danger/canvas', FOREST['--pc-danger'], FOREST['--pc-canvas'], 4.5],
    ['forest.dangerBoundary/workspace', FOREST['--pc-danger'], FOREST['--pc-workspace'], 3],
    ['forest.dangerOnLight/owned', FOREST['--pc-danger-on-light'], FOREST['--pc-owned'], 4.5],
    ['forest.dangerInk/danger', FOREST['--pc-danger-ink'], FOREST['--pc-danger'], 4.5],
    ['forest.disabledOnDark/canvas', FOREST['--pc-faint'], FOREST['--pc-canvas'], 4.5],
    ['forest.disabledOnDark/workspace', FOREST['--pc-faint'], FOREST['--pc-workspace'], 4.5],
    ['forest.disabledOnLight/owned', DAY_FIELD['--pc-faint'], FOREST['--pc-owned'], 4.5],
    ['forest.disabledOnLight/harvest', DAY_FIELD['--pc-faint'], FOREST['--pc-harvest'], 4.5],
    ['forest.focusOnDark/canvas', FOREST['--pc-focus'], FOREST['--pc-canvas'], 3],
    ['forest.focusOnDark/workspace', FOREST['--pc-focus'], FOREST['--pc-workspace'], 3],
    ['forest.focusOnLight/owned', FOREST['--pc-focus-contrast'], FOREST['--pc-owned'], 3],
    ['forest.focusOnLight/harvest', FOREST['--pc-focus-contrast'], FOREST['--pc-harvest'], 3],
    ['forest.warn/canvas', FOREST['--pc-warning'], FOREST['--pc-canvas'], 4.5],
    ['forest.warn/workspace', FOREST['--pc-warning'], FOREST['--pc-workspace'], 4.5],
    ['day.text/canvas', DAY_FIELD['--pc-ink'], DAY_FIELD['--pc-canvas'], 4.5],
    ['day.text/workspace', DAY_FIELD['--pc-ink'], DAY_FIELD['--pc-workspace'], 4.5],
    ['day.text/owned', DAY_FIELD['--pc-ink'], DAY_FIELD['--pc-owned'], 4.5],
    ['day.muted/canvas', DAY_FIELD['--pc-muted'], DAY_FIELD['--pc-canvas'], 4.5],
    ['day.muted/workspace', DAY_FIELD['--pc-muted'], DAY_FIELD['--pc-workspace'], 4.5],
    ['day.muted/owned', DAY_FIELD['--pc-muted'], DAY_FIELD['--pc-owned'], 4.5],
    ['day.harvestInk/harvest', DAY_FIELD['--pc-harvest-ink'], DAY_FIELD['--pc-harvest'], 4.5],
    ['day.danger/canvas', DAY_FIELD['--pc-danger'], DAY_FIELD['--pc-canvas'], 4.5],
    ['day.danger/workspace', DAY_FIELD['--pc-danger'], DAY_FIELD['--pc-workspace'], 4.5],
    ['day.dangerBoundary/workspace', DAY_FIELD['--pc-danger'], DAY_FIELD['--pc-workspace'], 3],
    ['day.dangerOnLight/owned', DAY_FIELD['--pc-danger-on-light'], DAY_FIELD['--pc-owned'], 4.5],
    ['day.danger/owned', DAY_FIELD['--pc-danger'], DAY_FIELD['--pc-owned'], 4.5],
    ['day.dangerInk/danger', DAY_FIELD['--pc-danger-ink'], DAY_FIELD['--pc-danger'], 4.5],
    ['day.disabled/canvas', DAY_FIELD['--pc-faint'], DAY_FIELD['--pc-canvas'], 4.5],
    ['day.disabled/workspace', DAY_FIELD['--pc-faint'], DAY_FIELD['--pc-workspace'], 4.5],
    ['day.disabled/owned', DAY_FIELD['--pc-faint'], DAY_FIELD['--pc-owned'], 4.5],
    ['day.disabled/harvest', DAY_FIELD['--pc-faint'], DAY_FIELD['--pc-harvest'], 4.5],
    ['day.focus/canvas', DAY_FIELD['--pc-focus'], DAY_FIELD['--pc-canvas'], 3],
    ['day.focus/workspace', DAY_FIELD['--pc-focus'], DAY_FIELD['--pc-workspace'], 3],
    ['day.focus/owned', DAY_FIELD['--pc-focus'], DAY_FIELD['--pc-owned'], 3],
    ['day.focus/harvest', DAY_FIELD['--pc-focus'], DAY_FIELD['--pc-harvest'], 3],
    ['day.warn/canvas', DAY_FIELD['--pc-warning'], DAY_FIELD['--pc-canvas'], 4.5],
    ['day.warn/workspace', DAY_FIELD['--pc-warning'], DAY_FIELD['--pc-workspace'], 4.5],
    ['day.warn/owned', DAY_FIELD['--pc-warning'], DAY_FIELD['--pc-owned'], 4.5],

    // AgentMark identity crew palette (Foundation Task 5 review fix) -- the ink AgentMark.jsx
    // picks per crew fill for its optional identity label (`CREW_INK_BY_THEME`). Text-tier 4.5:1.
    ['forest.crewInk/crew1', FOREST['--pc-owned-ink'], FOREST_CREW['--pc-crew-1'], 4.5],
    ['forest.crewInk/crew2', FOREST['--pc-owned-ink'], FOREST_CREW['--pc-crew-2'], 4.5],
    ['forest.crewInk/crew3', FOREST['--pc-owned-ink'], FOREST_CREW['--pc-crew-3'], 4.5],
    ['forest.crewInk/crew4', FOREST['--pc-owned-ink'], FOREST_CREW['--pc-crew-4'], 4.5],
    ['forest.crewInk/crew5', FOREST['--pc-owned-ink'], FOREST_CREW['--pc-crew-5'], 4.5],
    ['forest.crewInk/crew6', FOREST['--pc-owned-ink'], FOREST_CREW['--pc-crew-6'], 4.5],
    ['day.crewInk/crew1', DAY_FIELD['--pc-owned-ink'], DAY_FIELD_CREW['--pc-crew-1'], 4.5],
    ['day.crewInk/crew2', DAY_FIELD['--pc-owned'], DAY_FIELD_CREW['--pc-crew-2'], 4.5],
    ['day.crewInk/crew3', DAY_FIELD['--pc-owned-ink'], DAY_FIELD_CREW['--pc-crew-3'], 4.5],
    ['day.crewInk/crew4', DAY_FIELD['--pc-owned'], DAY_FIELD_CREW['--pc-crew-4'], 4.5],
    ['day.crewInk/crew5', DAY_FIELD['--pc-owned-ink'], DAY_FIELD_CREW['--pc-crew-5'], 4.5],
    ['day.crewInk/crew6', DAY_FIELD['--pc-owned'], DAY_FIELD_CREW['--pc-crew-6'], 4.5],

    // AgentMark state badge -- the ink AgentMark.jsx picks for the state glyph against its own
    // solid badge chip (`STATE_INK_BY_THEME`), never against the identity fill underneath it.
    ['forest.stateInk/active', FOREST['--pc-harvest-ink'], FOREST['--pc-harvest'], 4.5],
    ['forest.stateInk/confirmed', FOREST['--pc-owned-ink'], FOREST['--pc-owned'], 4.5],
    ['forest.stateInk/failed', FOREST['--pc-owned-ink'], FOREST['--pc-danger'], 4.5],
    ['forest.stateInk/idle', FOREST['--pc-owned-ink'], FOREST['--pc-muted'], 4.5],
    ['day.stateInk/active', DAY_FIELD['--pc-harvest-ink'], DAY_FIELD['--pc-harvest'], 4.5],
    ['day.stateInk/confirmed', DAY_FIELD['--pc-owned'], DAY_FIELD['--pc-ink'], 4.5],
    ['day.stateInk/failed', DAY_FIELD['--pc-owned'], DAY_FIELD['--pc-danger'], 4.5],
    ['day.stateInk/idle', DAY_FIELD['--pc-owned'], DAY_FIELD['--pc-muted'], 4.5],
  ].map(freezeRequirement)
)

const HEX_COLOR = /^#[0-9a-f]{6}$/i

const parseHex = (hex) => {
  if (typeof hex !== 'string' || !HEX_COLOR.test(hex)) {
    throw new TypeError('Expected a six-digit hexadecimal color')
  }
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
}

const linearize = (channel) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

export function relativeLuminance(hex) {
  const [red, green, blue] = parseHex(hex).map(linearize)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

export function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}
