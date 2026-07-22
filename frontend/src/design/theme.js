export const THEME_IDS = Object.freeze({ FOREST: 'forest', DAY_FIELD: 'day-field' })

const freezeTheme = (theme) => Object.freeze(theme)

export const THEMES = Object.freeze({
  forest: freezeTheme({
    canvas: '#17251F',
    workspace: '#20342B',
    owned: '#F2F5EF',
    text: '#F2F5EF',
    textMuted: '#A8B5AD',
    ownedInk: '#17251F',
    ownedMuted: '#536159',
    harvest: '#DFF56C',
    harvestInk: '#17251F',
    danger: '#E26E67',
    dangerOnLight: '#A8403C',
    dangerInk: '#17251F',
    focusOnDark: '#DFF56C',
    focusOnLight: '#17251F',
    disabledOnDark: '#8C9B93',
    disabledOnLight: '#5F6C65',
    light: false,
  }),
  'day-field': freezeTheme({
    canvas: '#E9EEE8',
    workspace: '#F7F9F5',
    owned: '#F2F5EF',
    text: '#17251F',
    textMuted: '#536159',
    ownedInk: '#17251F',
    ownedMuted: '#536159',
    harvest: '#DFF56C',
    harvestInk: '#17251F',
    danger: '#A8403C',
    dangerOnLight: '#A8403C',
    dangerInk: '#F2F5EF',
    focusOnDark: '#DFF56C',
    focusOnLight: '#17251F',
    disabledOnDark: '#8C9B93',
    disabledOnLight: '#5F6C65',
    light: true,
  }),
})

export function normalizeTheme(value) {
  if (typeof value !== 'string') return THEME_IDS.FOREST
  if (value === THEME_IDS.DAY_FIELD || value === 'bone-paper') return THEME_IDS.DAY_FIELD
  return THEME_IDS.FOREST
}

export function applyTheme(theme, root = document.documentElement) {
  const normalized = normalizeTheme(theme)
  root.setAttribute('data-theme', normalized)
  return normalized
}

export function isLightTheme(theme) {
  return THEMES[normalizeTheme(theme)].light
}

// Reads the theme the DOM is actually rendering right now (the same `data-theme` attribute
// pocket-crew.css keys its selectors on), for components that pick per-theme values without a
// theme prop/context of their own -- e.g. BrandLockup's tone='auto' and AgentMark's ink choice.
export function currentDomTheme(
  root = typeof document !== 'undefined' ? document.documentElement : null
) {
  return normalizeTheme(root?.getAttribute('data-theme'))
}
