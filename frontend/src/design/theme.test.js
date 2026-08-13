// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contrastRatio } from './contrast.js'
import { FOUNDATION_SHARED_TOKENS, FOUNDATION_THEMES } from './pocket-crew-contract.js'
import {
  THEME_IDS,
  THEMES,
  applyTheme,
  currentDomTheme,
  isLightTheme,
  normalizeTheme,
} from './theme.js'

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

// Warn is not a frozen THEMES token — it's a compat-mapping-only tone, distinct per theme from
// both --danger and --accent/--focus-ring (see the warn/danger identity collision fix).
const WARN = Object.freeze({ forest: '#E8A33D', 'day-field': '#8A5A00' })

const compatibilityValues = (tokens, themeId) => ({
  '--bg-base': tokens.canvas,
  '--bg-canvas': tokens.canvas,
  // 2026-07-29: these three used to expect `tokens.canvas`, matching a note in pocket-crew.css that
  // existing routes would stay flat "until they adopt an explicit surface pair". That adoption has
  // now happened. While they were flat, 111 declarations across the app asked for an elevated
  // surface and were handed the canvas back, so every legacy card, panel and rail rendered as a bare
  // border -- the sidebar's active nav item painted the rail's own colour and was invisible in both
  // themes. They now resolve to the workspace surface (Grove / #f7f9f5).
  '--bg-card': tokens.workspace,
  '--bg-elev': tokens.workspace,
  '--bg-elev-2': tokens.workspace,
  // --bg-input stays on the canvas: an input sits ON a card, so it must read as inset against the
  // workspace rather than merge into it.
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
  '--warn': WARN[themeId],
  '--ok': tokens.text,
  '--focus-ring': tokens.light ? tokens.focusOnLight : tokens.focusOnDark,
  '--focus-ring-contrast': tokens.light ? tokens.owned : tokens.focusOnLight,
  '--line': tokens.light ? tokens.disabledOnLight : tokens.disabledOnDark,
  '--eco-accent': tokens.harvest,
  '--pc-disabled': tokens.light ? tokens.disabledOnLight : tokens.disabledOnDark,
})

const SHADOWS = Object.freeze({
  forest: Object.freeze({
    '--shadow-sm': `0 8px 24px ${FOUNDATION_THEMES.forest['--pc-shadow-color']}`,
    '--shadow-md': `0 8px 24px ${FOUNDATION_THEMES.forest['--pc-shadow-color']}`,
    '--shadow-lg': `0 24px 60px ${FOUNDATION_THEMES.forest['--pc-shadow-color']}`,
  }),
  'day-field': Object.freeze({
    '--shadow-sm': `0 8px 24px ${FOUNDATION_THEMES['day-field']['--pc-shadow-color']}`,
    '--shadow-md': `0 8px 24px ${FOUNDATION_THEMES['day-field']['--pc-shadow-color']}`,
    '--shadow-lg': `0 24px 60px ${FOUNDATION_THEMES['day-field']['--pc-shadow-color']}`,
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
    .replace(/\s*,\s*/g, ',')
    .replace(/['"]/g, '')
    .toUpperCase()

// jsdom's getComputedStyle does not substitute var() references inside a custom property's own
// computed value -- it returns the declaration text verbatim. The Wave 5 token port (see
// contractTokens.test.js) aliases several CORE_VARIABLES entries to another custom property
// (e.g. `--pc-canvas: var(--pc-field)`), so this test has to follow that reference itself to
// keep asserting the actual resolved color rather than the literal string "var(--pc-field)".
const resolveComputedVar = (computed, rawValue, depth = 5) => {
  let value = rawValue.trim()
  let iterations = 0
  while (/var\(\s*--[\w-]+\s*\)/.test(value) && iterations < depth) {
    value = value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name) =>
      computed.getPropertyValue(name).trim()
    )
    iterations += 1
  }
  return value
}

const assertResolvedAlias = (computed, alias, canonical, expected) => {
  expect(computed.getPropertyValue(alias).trim(), `${alias} direct mapping`).toBe(
    `var(${canonical})`
  )
  expect(
    normalizedCssValue(resolveComputedVar(computed, computed.getPropertyValue(alias))),
    alias
  ).toBe(normalizedCssValue(expected))
}

describe('Pocket Crew theme contract', () => {
  it('exports the exact theme ids and deeply immutable theme records', () => {
    expect(THEME_IDS).toEqual({ FOREST: 'forest', DAY_FIELD: 'day-field' })
    expect(Object.keys(THEMES)).toEqual(['forest', 'day-field'])
    assertDeepFrozen(THEME_IDS)
    assertDeepFrozen(THEMES)
  })

  it('derives the public theme records from the foundation contract', async () => {
    vi.resetModules()
    vi.doMock('./pocket-crew-contract.js', () => ({
      FOUNDATION_THEMES: {
        forest: {
          '--pc-canvas': '#101010',
          '--pc-workspace': '#202020',
          '--pc-owned': '#303030',
          '--pc-ink': '#404040',
          '--pc-muted': '#505050',
          '--pc-owned-ink': '#606060',
          '--pc-owned-muted': '#707070',
          '--pc-harvest': '#808080',
          '--pc-harvest-ink': '#909090',
          '--pc-danger': '#A0A0A0',
          '--pc-danger-on-light': '#B0B0B0',
          '--pc-danger-ink': '#C0C0C0',
          '--pc-focus': '#D0D0D0',
          '--pc-focus-contrast': '#E0E0E0',
          '--pc-faint': '#F0F0F0',
        },
        'day-field': {
          '--pc-canvas': '#111111',
          '--pc-workspace': '#222222',
          '--pc-owned': '#333333',
          '--pc-ink': '#444444',
          '--pc-muted': '#555555',
          '--pc-owned-ink': '#666666',
          '--pc-owned-muted': '#777777',
          '--pc-harvest': '#888888',
          '--pc-harvest-ink': '#999999',
          '--pc-danger': '#AAAAAA',
          '--pc-danger-on-light': '#BBBBBB',
          '--pc-danger-ink': '#CCCCCC',
          '--pc-focus': '#DDDDDD',
          '--pc-focus-contrast': '#EEEEEE',
          '--pc-faint': '#FFFFFF',
        },
      },
    }))

    try {
      const { THEMES: derivedThemes } = await import('./theme.js?contract-derivation')

      expect(derivedThemes.forest).toMatchObject({
        canvas: '#101010',
        workspace: '#202020',
        harvest: '#808080',
        disabledOnDark: '#F0F0F0',
        disabledOnLight: '#FFFFFF',
        light: false,
      })
      expect(derivedThemes['day-field']).toMatchObject({
        canvas: '#111111',
        workspace: '#222222',
        harvest: '#888888',
        disabledOnDark: '#F0F0F0',
        disabledOnLight: '#FFFFFF',
        light: true,
      })
    } finally {
      vi.doUnmock('./pocket-crew-contract.js')
      vi.resetModules()
    }
  })

  it('projects the reviewed semantic values into the legacy public theme API', () => {
    expect(THEMES).toEqual({
      forest: {
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
      },
      'day-field': {
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
      },
    })
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

  it('reads the normalized theme that the DOM is actually rendering', () => {
    const root = document.createElement('html')
    root.setAttribute('data-theme', 'bone-paper')

    expect(currentDomTheme(root)).toBe(THEME_IDS.DAY_FIELD)
    root.setAttribute('data-theme', 'not-a-theme')
    expect(currentDomTheme(root)).toBe(THEME_IDS.FOREST)
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
        const resolvedValue = resolveComputedVar(computed, computed.getPropertyValue(property))
        expect(normalizedCssValue(resolvedValue), property).toBe(tokens[token])
      })
      Object.entries(compatibilityValues(tokens, themeId)).forEach(([property, expected]) => {
        expect(
          normalizedCssValue(resolveComputedVar(computed, computed.getPropertyValue(property))),
          property
        ).toBe(normalizedCssValue(expected))
      })
      Object.entries(SHADOWS[themeId]).forEach(([property, expected]) => {
        assertResolvedAlias(
          computed,
          property,
          property === '--shadow-lg' ? '--pc-shadow-dominant' : '--pc-shadow-support',
          expected
        )
      })

      const disabled = computed.getPropertyValue('--pc-disabled').trim()
      expect(contrastRatio(disabled, tokens.canvas)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it('keeps the exact radius tiers and scopes Newsreader to the wordmark utility', () => {
    const computed = getComputedStyle(document.documentElement)
    assertResolvedAlias(
      computed,
      '--pc-radius-sm',
      '--pc-radius-control',
      FOUNDATION_SHARED_TOKENS['--pc-radius-control']
    )
    assertResolvedAlias(
      computed,
      '--pc-radius-md',
      '--pc-radius-support',
      FOUNDATION_SHARED_TOKENS['--pc-radius-support']
    )
    assertResolvedAlias(
      computed,
      '--pc-radius-lg',
      '--pc-radius-dominant',
      FOUNDATION_SHARED_TOKENS['--pc-radius-dominant']
    )
    assertResolvedAlias(
      computed,
      '--font-body',
      '--pc-font-body',
      FOUNDATION_SHARED_TOKENS['--pc-font-body']
    )
    assertResolvedAlias(
      computed,
      '--font-mono',
      '--pc-font-mono',
      FOUNDATION_SHARED_TOKENS['--pc-font-mono']
    )
    assertResolvedAlias(
      computed,
      '--font-script',
      '--pc-font-body',
      FOUNDATION_SHARED_TOKENS['--pc-font-body']
    )

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

  it.each(Object.values(THEME_IDS))(
    'keeps --warn visually distinct from --danger and --accent for %s (re-review: warn/danger identity collision)',
    (themeId) => {
      applyTheme(themeId)
      const computed = getComputedStyle(document.documentElement)
      const warn = computed.getPropertyValue('--warn').trim()
      const danger = computed.getPropertyValue('--danger').trim()
      const accent = computed.getPropertyValue('--accent').trim()

      expect(warn, 'warn vs danger').not.toBe(danger)
      expect(warn, 'warn vs accent').not.toBe(accent)
    }
  )
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
