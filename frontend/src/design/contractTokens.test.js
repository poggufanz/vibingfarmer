// @vitest-environment jsdom
//
// Foundation conformance: prove that pocket-crew.css consumes the Task 1 exports as its semantic
// source of truth. The contract module is tracked and imported directly; tests only normalize
// browser serialization and resolve jsdom's custom-property var() behavior.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FOUNDATION_CREW_TOKENS,
  FOUNDATION_LAYERS,
  FOUNDATION_MOBILE_OVERRIDES,
  FOUNDATION_MOTION,
  FOUNDATION_SHARED_TOKENS,
  FOUNDATION_THEMES,
} from './pocket-crew-contract.js'
import { THEME_IDS, applyTheme } from './theme.js'

// jsdom re-serializes font-family lists as double-quoted, comma-tight tokens
// ("geist variable","geist",...) regardless of how they were authored, so quote style and
// comma spacing have to be normalized away too, not just whitespace and case.
const normalizedCssValue = (value) =>
  value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*,\s*/g, ',')
    .replace(/['"]/g, '')
    .toLowerCase()

// jsdom's getComputedStyle does not substitute var() references inside a custom property's own
// computed value (verified empirically -- it returns the declaration text verbatim). That
// substitution is exactly what this port relies on to be a visual no-op, so it has to be proven
// by hand: follow var(--x) references through further computed-value lookups until none remain.
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

const resolved = (computed, property) =>
  normalizedCssValue(resolveComputedVar(computed, computed.getPropertyValue(property)))

const THEME_TOKENS = Object.freeze(
  Object.fromEntries(
    Object.values(THEME_IDS).map((themeId) => {
      const themeTokens = FOUNDATION_THEMES[themeId]
      // Task 1 exports the theme shadow color, but not the support/dominant geometry. Keep these
      // two DESIGN.md dimensions local until the contract exports their geometry explicitly.
      return [
        themeId,
        Object.freeze({
          ...themeTokens,
          '--pc-shadow-support': `0 8px 24px ${themeTokens['--pc-shadow-color']}`,
          '--pc-shadow-dominant': `0 24px 60px ${themeTokens['--pc-shadow-color']}`,
        }),
      ]
    })
  )
)

// These declarations were already public aliases before the semantic port. Keep the list of
// aliases independently, but derive each expected value from the Task 1 semantic contract.
const PRE_PORT_ALIASED_PROPERTIES = Object.freeze({
  forest: Object.freeze([
    '--pc-canvas',
    '--pc-workspace',
    '--pc-owned',
    '--pc-ink',
    '--pc-owned-ink',
    '--pc-harvest-ink',
    '--pc-danger-ink',
  ]),
  'day-field': Object.freeze([
    '--pc-owned',
    '--pc-ink',
    '--pc-owned-ink',
    '--pc-harvest-ink',
    '--pc-danger-ink',
  ]),
})

const SHARED_TOKENS = Object.freeze({
  ...FOUNDATION_SHARED_TOKENS,
  ...FOUNDATION_MOTION,
  ...Object.fromEntries(
    Object.entries(FOUNDATION_LAYERS).map(([property, value]) => [property, String(value)])
  ),
})

const FOUNDATION_ONLY_TOKENS = Object.freeze(
  Object.fromEntries(
    Object.values(THEME_IDS).map((themeId) => {
      const themeTokens = FOUNDATION_THEMES[themeId]
      return [
        themeId,
        Object.freeze({
          ...FOUNDATION_CREW_TOKENS[themeId],
          '--pc-disabled': themeTokens['--pc-faint'],
          '--pc-disabled-on-dark': FOUNDATION_THEMES[THEME_IDS.FOREST]['--pc-faint'],
          '--pc-disabled-on-light': FOUNDATION_THEMES[THEME_IDS.DAY_FIELD]['--pc-faint'],
          '--pc-focus-on-dark': FOUNDATION_THEMES[THEME_IDS.FOREST]['--pc-focus'],
          '--pc-focus-on-light': FOUNDATION_THEMES[THEME_IDS.DAY_FIELD]['--pc-focus'],
          '--pc-radius-sm': FOUNDATION_SHARED_TOKENS['--pc-radius-control'],
          '--pc-radius-md': FOUNDATION_SHARED_TOKENS['--pc-radius-support'],
          '--pc-radius-lg': FOUNDATION_SHARED_TOKENS['--pc-radius-dominant'],
        }),
      ]
    })
  )
)

describe('Pocket Crew contract token port', () => {
  let style
  let cssText

  beforeEach(() => {
    cssText = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')
    style = document.createElement('style')
    style.textContent = cssText
    document.head.append(style)
  })

  afterEach(() => {
    style.remove()
    document.documentElement.removeAttribute('data-theme')
  })

  it.each(Object.values(THEME_IDS))(
    "carries every ported %s token at the contract's exact value",
    (themeId) => {
      applyTheme(themeId)
      const computed = getComputedStyle(document.documentElement)

      Object.entries(THEME_TOKENS[themeId]).forEach(([property, expected]) => {
        expect(resolved(computed, property), property).toBe(normalizedCssValue(expected))
      })
      Object.entries(SHARED_TOKENS).forEach(([property, expected]) => {
        expect(resolved(computed, property), property).toBe(normalizedCssValue(expected))
      })
    }
  )

  it.each(Object.values(THEME_IDS))(
    'keeps the twelve overlapping alias tokens computed identically to their pre-port literal for %s',
    (themeId) => {
      applyTheme(themeId)
      const computed = getComputedStyle(document.documentElement)

      PRE_PORT_ALIASED_PROPERTIES[themeId].forEach((property) => {
        expect(resolved(computed, property), property).toBe(
          normalizedCssValue(THEME_TOKENS[themeId][property])
        )
      })
    }
  )

  it.each(Object.values(THEME_IDS))(
    'keeps all fourteen Foundation-only tokens for %s',
    (themeId) => {
      applyTheme(themeId)
      const computed = getComputedStyle(document.documentElement)

      Object.entries(FOUNDATION_ONLY_TOKENS[themeId]).forEach(([property, expected]) => {
        expect(resolved(computed, property), property).toBe(normalizedCssValue(expected))
      })
    }
  )

  it("carries the mobile :root override with the contract's exact values", () => {
    const mobileBlock = cssText.match(/@media \(max-width: 767px\) \{\s*:root \{([\s\S]*?)\}\s*\}/)
    expect(mobileBlock, 'mobile :root override block must exist').not.toBeNull()

    Object.entries(FOUNDATION_MOBILE_OVERRIDES).forEach(([property, expected]) => {
      const escapedProp = property.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
      const match = mobileBlock[1].match(new RegExp(`${escapedProp}\\s*:\\s*([^;]+);`))
      expect(match, property).not.toBeNull()
      expect(normalizedCssValue(match[1]), property).toBe(normalizedCssValue(expected))
    })
  })

  it('does not wrap the ported tokens in @layer', () => {
    expect(cssText).not.toMatch(/@layer/)
  })
})
