import { FOUNDATION_THEMES } from './pocket-crew-contract.js'

export const THEME_IDS = Object.freeze({ FOREST: 'forest', DAY_FIELD: 'day-field' })

const themeFromContract = (themeId) => {
  const tokens = FOUNDATION_THEMES[themeId]
  const forestTokens = FOUNDATION_THEMES[THEME_IDS.FOREST]

  return Object.freeze({
    canvas: tokens['--pc-canvas'],
    workspace: tokens['--pc-workspace'],
    owned: tokens['--pc-owned'],
    text: tokens['--pc-ink'],
    textMuted: tokens['--pc-muted'],
    ownedInk: tokens['--pc-owned-ink'],
    ownedMuted: tokens['--pc-owned-muted'],
    harvest: tokens['--pc-harvest'],
    harvestInk: tokens['--pc-harvest-ink'],
    danger: tokens['--pc-danger'],
    dangerOnLight: tokens['--pc-danger-on-light'],
    dangerInk: tokens['--pc-danger-ink'],
    focusOnDark: forestTokens['--pc-focus'],
    focusOnLight:
      themeId === THEME_IDS.FOREST ? tokens['--pc-focus-contrast'] : tokens['--pc-focus'],
    disabledOnDark: forestTokens['--pc-faint'],
    disabledOnLight: FOUNDATION_THEMES[THEME_IDS.DAY_FIELD]['--pc-faint'],
    light: themeId === THEME_IDS.DAY_FIELD,
  })
}

export const THEMES = Object.freeze({
  forest: themeFromContract(THEME_IDS.FOREST),
  'day-field': themeFromContract(THEME_IDS.DAY_FIELD),
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
