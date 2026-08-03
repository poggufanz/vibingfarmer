const freezeRequirement = (requirement) => Object.freeze(requirement)

export const CONTRAST_REQUIREMENTS = Object.freeze(
  [
    ['forest.text/canvas', '#F2F5EF', '#17251F', 4.5],
    ['forest.text/workspace', '#F2F5EF', '#20342B', 4.5],
    ['forest.muted/canvas', '#A8B5AD', '#17251F', 4.5],
    ['forest.muted/workspace', '#A8B5AD', '#20342B', 4.5],
    ['forest.ownedInk/owned', '#17251F', '#F2F5EF', 4.5],
    ['forest.ownedMuted/owned', '#536159', '#F2F5EF', 4.5],
    ['forest.harvestInk/harvest', '#17251F', '#DFF56C', 4.5],
    ['forest.danger/canvas', '#E26E67', '#17251F', 4.5],
    ['forest.dangerBoundary/workspace', '#E26E67', '#20342B', 3],
    ['forest.dangerOnLight/owned', '#A8403C', '#F2F5EF', 4.5],
    ['forest.dangerInk/danger', '#17251F', '#E26E67', 4.5],
    ['forest.disabledOnDark/canvas', '#8C9B93', '#17251F', 4.5],
    ['forest.disabledOnDark/workspace', '#8C9B93', '#20342B', 4.5],
    ['forest.disabledOnLight/owned', '#5F6C65', '#F2F5EF', 4.5],
    ['forest.disabledOnLight/harvest', '#5F6C65', '#DFF56C', 4.5],
    ['forest.focusOnDark/canvas', '#DFF56C', '#17251F', 3],
    ['forest.focusOnDark/workspace', '#DFF56C', '#20342B', 3],
    ['forest.focusOnLight/owned', '#17251F', '#F2F5EF', 3],
    ['forest.focusOnLight/harvest', '#17251F', '#DFF56C', 3],
    ['forest.warn/canvas', '#E8A33D', '#17251F', 4.5],
    ['forest.warn/workspace', '#E8A33D', '#20342B', 4.5],
    ['day.text/canvas', '#17251F', '#E9EEE8', 4.5],
    ['day.text/workspace', '#17251F', '#F7F9F5', 4.5],
    ['day.text/owned', '#17251F', '#F2F5EF', 4.5],
    ['day.muted/canvas', '#536159', '#E9EEE8', 4.5],
    ['day.muted/workspace', '#536159', '#F7F9F5', 4.5],
    ['day.muted/owned', '#536159', '#F2F5EF', 4.5],
    ['day.harvestInk/harvest', '#17251F', '#DFF56C', 4.5],
    ['day.danger/canvas', '#A8403C', '#E9EEE8', 4.5],
    ['day.danger/workspace', '#A8403C', '#F7F9F5', 4.5],
    ['day.danger/owned', '#A8403C', '#F2F5EF', 4.5],
    ['day.dangerInk/danger', '#F2F5EF', '#A8403C', 4.5],
    ['day.disabled/canvas', '#5F6C65', '#E9EEE8', 4.5],
    ['day.disabled/workspace', '#5F6C65', '#F7F9F5', 4.5],
    ['day.disabled/owned', '#5F6C65', '#F2F5EF', 4.5],
    ['day.disabled/harvest', '#5F6C65', '#DFF56C', 4.5],
    ['day.focus/canvas', '#17251F', '#E9EEE8', 3],
    ['day.focus/workspace', '#17251F', '#F7F9F5', 3],
    ['day.focus/owned', '#17251F', '#F2F5EF', 3],
    ['day.focus/harvest', '#17251F', '#DFF56C', 3],
    ['day.warn/canvas', '#8A5A00', '#E9EEE8', 4.5],
    ['day.warn/workspace', '#8A5A00', '#F7F9F5', 4.5],
    ['day.warn/owned', '#8A5A00', '#F2F5EF', 4.5],

    // AgentMark identity crew palette (Foundation Task 5 review fix) -- the ink AgentMark.jsx
    // picks per crew fill for its optional identity label (`CREW_INK_BY_THEME`). Text-tier 4.5:1.
    ['forest.crewInk/crew1', '#17251F', '#8FBF8A', 4.5],
    ['forest.crewInk/crew2', '#17251F', '#6FA8DC', 4.5],
    ['forest.crewInk/crew3', '#17251F', '#E0B84B', 4.5],
    ['forest.crewInk/crew4', '#17251F', '#C9967B', 4.5],
    ['forest.crewInk/crew5', '#17251F', '#5FD3BC', 4.5],
    ['forest.crewInk/crew6', '#17251F', '#D98BA8', 4.5],
    ['day.crewInk/crew1', '#17251F', '#569D50', 4.5],
    ['day.crewInk/crew2', '#F2F5EF', '#3E72A8', 4.5],
    ['day.crewInk/crew3', '#17251F', '#B18220', 4.5],
    ['day.crewInk/crew4', '#F2F5EF', '#8C5A3E', 4.5],
    ['day.crewInk/crew5', '#17251F', '#229C85', 4.5],
    ['day.crewInk/crew6', '#F2F5EF', '#A8446B', 4.5],

    // AgentMark state badge -- the ink AgentMark.jsx picks for the state glyph against its own
    // solid badge chip (`STATE_INK_BY_THEME`), never against the identity fill underneath it.
    ['forest.stateInk/active', '#17251F', '#DFF56C', 4.5],
    ['forest.stateInk/confirmed', '#17251F', '#F2F5EF', 4.5],
    ['forest.stateInk/failed', '#17251F', '#E26E67', 4.5],
    ['forest.stateInk/idle', '#17251F', '#A8B5AD', 4.5],
    ['day.stateInk/active', '#17251F', '#DFF56C', 4.5],
    ['day.stateInk/confirmed', '#F2F5EF', '#17251F', 4.5],
    ['day.stateInk/failed', '#F2F5EF', '#A8403C', 4.5],
    ['day.stateInk/idle', '#F2F5EF', '#536159', 4.5],
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
