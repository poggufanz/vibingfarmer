// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contrastRatio } from './contrast.js'
import { THEME_IDS, THEMES, applyTheme, isLightTheme, normalizeTheme } from './theme.js'

const CORE_VARIABLES = Object.freeze({
  '--pc-canvas': 'canvas',
  '--pc-workspace': 'workspace',
  '--pc-owned': 'owned',
  '--pc-ink': 'text',
  '--pc-muted': 'textMuted',
  '--pc-owned-ink': 'ownedInk',
  '--pc-owned-muted': 'ownedMuted',
  '--pc-harvest': 'harvest',
  '--pc-harvest-ink': 'harvestInk',
  '--pc-danger': 'danger',
  '--pc-danger-on-light': 'dangerOnLight',
  '--pc-danger-ink': 'dangerInk',
  '--pc-focus-on-dark': 'focusOnDark',
  '--pc-focus-on-light': 'focusOnLight',
  '--pc-disabled-on-dark': 'disabledOnDark',
  '--pc-disabled-on-light': 'disabledOnLight',
})

const compatibilityValues = (tokens) => ({
  '--bg-base': tokens.canvas,
  '--bg-canvas': tokens.canvas,
  '--bg-card': tokens.canvas,
  '--bg-elev': tokens.canvas,
  '--bg-elev-2': tokens.canvas,
  '--bg-input': tokens.canvas,
  '--text': tokens.text,
  '--text-primary': tokens.text,
  '--text-muted': tokens.textMuted,
  '--text-faint': tokens.textMuted,
  '--text-dim': tokens.textMuted,
  '--accent': tokens.harvest,
  '--accent-fg': tokens.harvestInk,
  '--accent-soft': tokens.workspace,
  '--border': tokens.light ? tokens.disabledOnLight : tokens.disabledOnDark,
  '--border-strong': tokens.light ? tokens.text : tokens.textMuted,
  '--border-accent': tokens.light ? tokens.focusOnLight : tokens.focusOnDark,
  '--danger': tokens.danger,
  '--info': tokens.textMuted,
  '--warn': tokens.light ? tokens.danger : tokens.harvest,
  '--ok': tokens.text,
  '--focus-ring': tokens.light ? tokens.focusOnLight : tokens.focusOnDark,
  '--focus-ring-contrast': tokens.light ? tokens.owned : tokens.focusOnLight,
  '--line': tokens.light ? tokens.disabledOnLight : tokens.disabledOnDark,
  '--eco-accent': tokens.harvest,
  '--pc-disabled': tokens.light ? tokens.disabledOnLight : tokens.disabledOnDark,
})

const SHADOWS = Object.freeze({
  forest: Object.freeze({
    '--shadow-sm': '0 1px 2px rgb(7 15 11 / 24%)',
    '--shadow-md': '0 8px 20px rgb(7 15 11 / 22%)',
    '--shadow-lg': '0 18px 44px rgb(7 15 11 / 28%)',
  }),
  'day-field': Object.freeze({
    '--shadow-sm': '0 1px 2px rgb(23 37 31 / 12%)',
    '--shadow-md': '0 8px 20px rgb(23 37 31 / 14%)',
    '--shadow-lg': '0 18px 44px rgb(23 37 31 / 18%)',
  }),
})

const assertDeepFrozen = (value) => {
  expect(Object.isFrozen(value)).toBe(true)
  Object.values(value).forEach((child) => {
    if (child && typeof child === 'object') assertDeepFrozen(child)
  })
}

const normalizedCssValue = (value) =>
  value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .toUpperCase()

describe('Pocket Crew theme contract', () => {
  it('exports the exact theme ids and deeply immutable theme records', () => {
    expect(THEME_IDS).toEqual({ FOREST: 'forest', DAY_FIELD: 'day-field' })
    expect(Object.keys(THEMES)).toEqual(['forest', 'day-field'])
    assertDeepFrozen(THEME_IDS)
    assertDeepFrozen(THEMES)
  })

  it.each([
    ['forest', 'forest'],
    ['day-field', 'day-field'],
    ['acid-yield', 'forest'],
    ['mono-slate', 'forest'],
    ['liquid-mint', 'forest'],
    ['bone-paper', 'day-field'],
    ['unknown', 'forest'],
    ['', 'forest'],
    [null, 'forest'],
    [undefined, 'forest'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeTheme(input)).toBe(expected)
  })

  it('fails prototype keys and malformed non-string inputs safely to Forest', () => {
    const nullPrototype = Object.create(null)
    const hostileCoercion = {
      toString() {
        throw new Error('must not coerce')
      },
    }

    ;['toString', 'constructor', '__proto__'].forEach((value) => {
      expect(normalizeTheme(value)).toBe(THEME_IDS.FOREST)
    })
    ;[nullPrototype, hostileCoercion, {}, ['bone-paper'], Symbol('day-field')].forEach((value) => {
      expect(() => normalizeTheme(value)).not.toThrow()
      expect(normalizeTheme(value)).toBe(THEME_IDS.FOREST)
    })
  })

  it('writes only normalized data-theme and returns the applied theme', () => {
    const root = { setAttribute: vi.fn() }

    expect(applyTheme('bone-paper', root)).toBe('day-field')
    expect(root.setAttribute).toHaveBeenCalledTimes(1)
    expect(root.setAttribute).toHaveBeenCalledWith('data-theme', 'day-field')
  })

  it('treats only Day Field, including its legacy value, as light', () => {
    expect(isLightTheme('day-field')).toBe(true)
    expect(isLightTheme('bone-paper')).toBe(true)
    expect(isLightTheme('forest')).toBe(false)
    expect(isLightTheme('acid-yield')).toBe(false)
    expect(isLightTheme()).toBe(false)
  })
})

describe('Pocket Crew CSS theme parity', () => {
  let style

  beforeEach(() => {
    style = document.createElement('style')
    style.textContent = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')
    document.head.append(style)
  })

  afterEach(() => {
    style.remove()
    document.documentElement.removeAttribute('data-theme')
  })

  it.each(Object.values(THEME_IDS))(
    'emits computed Pocket Crew and legacy variables for %s',
    (themeId) => {
      applyTheme(themeId)
      const computed = getComputedStyle(document.documentElement)
      const tokens = THEMES[themeId]

      Object.entries(CORE_VARIABLES).forEach(([property, token]) => {
        expect(normalizedCssValue(computed.getPropertyValue(property)), property).toBe(
          tokens[token]
        )
      })
      Object.entries(compatibilityValues(tokens)).forEach(([property, expected]) => {
        expect(normalizedCssValue(computed.getPropertyValue(property)), property).toBe(
          normalizedCssValue(expected)
        )
      })
      Object.entries(SHADOWS[themeId]).forEach(([property, expected]) => {
        expect(normalizedCssValue(computed.getPropertyValue(property)), property).toBe(
          normalizedCssValue(expected)
        )
      })

      const disabled = computed.getPropertyValue('--pc-disabled').trim()
      expect(contrastRatio(disabled, tokens.canvas)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it('keeps the exact radius tiers and scopes Newsreader to the wordmark utility', () => {
    const computed = getComputedStyle(document.documentElement)
    expect(computed.getPropertyValue('--pc-radius-sm').trim()).toBe('12px')
    expect(computed.getPropertyValue('--pc-radius-md').trim()).toBe('16px')
    expect(computed.getPropertyValue('--pc-radius-lg').trim()).toBe('24px')
    expect(computed.getPropertyValue('--font-body')).toContain('Geist Variable')
    expect(computed.getPropertyValue('--font-mono')).toContain('JetBrains Mono Variable')
    expect(computed.getPropertyValue('--font-script')).not.toContain('Newsreader')

    const wordmark = document.createElement('span')
    wordmark.className = 'pc-wordmark'
    document.body.append(wordmark)
    expect(getComputedStyle(wordmark).fontFamily).toContain('Newsreader Variable')
    wordmark.remove()
  })

  it('contains no decorative gradient and wins the legacy hover cascade', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')

    expect(css).not.toMatch(/(?:linear|radial|conic)-gradient/i)
    expect(css).toMatch(/background-image:\s*none\s*!important/i)
    expect(css).toMatch(/animation:\s*none\s*!important/i)
  })

  it('wins the legacy disabled-button opacity cascade and covers owned-surface self states (finding 1)', () => {
    const legacy = document.createElement('style')
    legacy.textContent = readFileSync(resolve(process.cwd(), 'style.css'), 'utf8')
    // Mirror main.jsx's real load order: legacy style.css first, Pocket Crew after.
    document.head.insertBefore(legacy, style)
    applyTheme('forest')

    // Behavioral: `.btn-primary:disabled`/`.btn-gradient:disabled`/`.btn-ghost:disabled` in
    // style.css set opacity 0.32/0.4 at equal-or-higher specificity than Pocket Crew's reset,
    // which otherwise wins regardless of import order — jsdom resolves plain numeric opacity
    // through the real cascade, so this is a faithful regression check.
    ;['btn-primary', 'btn-gradient', 'btn-ghost'].forEach((cls) => {
      const btn = document.createElement('button')
      btn.className = cls
      btn.disabled = true
      document.body.append(btn)
      expect(getComputedStyle(btn).opacity, cls).toBe('1')
      btn.remove()
    })
    legacy.remove()

    // Structural: jsdom's computed style doesn't resolve `!important` on var()-valued color
    // declarations, so the color half of the same fix (and the owned-surface self coverage)
    // is verified against the authored rule text instead of a computed value.
    const css = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')
    expect(css).toMatch(/color:\s*var\(--pc-disabled\)\s*!important/)
    expect(css).toMatch(/opacity:\s*1\s*!important/)
    expect(css).toMatch(/\.pc-owned,[\s\S]*?\):disabled/)
    expect(css).toMatch(/\.pc-owned,[\s\S]*?\)\[aria-disabled='true'\]/)
    expect(css).toMatch(/color:\s*var\(--pc-disabled-on-light\)\s*!important/)
  })

  it('keeps disabled primary/gradient/Harvest buttons off the dark-calibrated disabled ink (self-review: harvest sits on a light surface too)', () => {
    // --pc-disabled resolves to disabledOnDark in Forest (calibrated for the dark canvas). The
    // generic disabled-color reset alone would apply that dark-safe ink to `.btn-primary` /
    // `.btn-gradient`, which render on the light Harvest background regardless of theme —
    // #8C9B93 on #DFF56C is ~2.4:1, well under the 4.5:1 floor. They need the on-light variant.
    expect(
      contrastRatio(THEMES.forest.disabledOnLight, THEMES.forest.harvest)
    ).toBeGreaterThanOrEqual(4.5)

    const css = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')
    expect(css).toMatch(
      /:where\(\s*\.pc-owned,\s*\[data-pc-surface='owned'\],\s*\.pc-harvest,\s*\[data-pc-surface='harvest'\],\s*\.btn-primary,\s*\.btn-gradient\s*\):disabled/
    )
  })

  it('applies the surface-aware focus ring to the focused owned/Harvest/primary-button/gradient-button element itself, not only descendants (finding 2)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')

    expect(css).toMatch(
      /:where\(\s*\.pc-owned,\s*\[data-pc-surface='owned'\],\s*\.pc-harvest,\s*\[data-pc-surface='harvest'\],\s*\.btn-primary,\s*\.btn-gradient\s*\):focus-visible/
    )
  })

  it('extends the 44px touch rule to links and summary disclosure triggers (finding 4)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')
    const touchBlock = css.match(
      /@media \(hover: none\), \(pointer: coarse\), \(max-width: 767px\) \{([\s\S]*?)\n\s*\}\n\}/
    )

    expect(touchBlock).not.toBeNull()
    expect(touchBlock[1]).toMatch(/\ba\[href\]/)
    expect(touchBlock[1]).toMatch(/(?:^|[\s,])summary(?=[\s,)])/m)
    expect(touchBlock[1]).toMatch(/min-height:\s*44px/)
  })
})

describe('local font policy', () => {
  it('keeps remote font stylesheets and preconnects out of index.html', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

    expect(html).not.toMatch(/fonts\.googleapis\.com/i)
    expect(html).not.toMatch(/fonts\.gstatic\.com/i)
    expect(html).not.toMatch(/<link[^>]+rel=["'](?:stylesheet|preconnect)["'][^>]+https?:\/\//i)
  })

  it('loads local Fontsource packages and the semantic layer after legacy CSS', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.jsx'), 'utf8')

    expect(main).toContain("import '@fontsource-variable/geist'")
    expect(main).toContain("import '@fontsource-variable/jetbrains-mono'")
    expect(main).toContain("import '@fontsource-variable/newsreader'")
    expect(main.indexOf("import '../style.css'")).toBeLessThan(
      main.indexOf("import './design/pocket-crew.css'")
    )
  })
})
