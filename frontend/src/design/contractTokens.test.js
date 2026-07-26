// @vitest-environment jsdom
//
// Wave 5 prerequisite (pocket-crew-wave5-prereq-tokens): proves the visual contract's token
// blocks were ported into pocket-crew.css as a visual no-op.
//
// The contract itself (docs/superpowers/specs/2026-07-23-pocket-crew-visual-contract.css) is
// local-only and git-ignored -- it will not exist in a clean CI checkout, so this test cannot
// read it at run time. The values below are pinned by hand from that contract instead. Tradeoff:
// if the contract changes, pocket-crew.css AND this file must both be updated by a human -- there
// is no automatic link once this test can't read the source of truth. See the task report for
// the full reasoning.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

// Contract :37-68 -- :root, :root[data-theme='forest'].
const FOREST_TOKENS = Object.freeze({
  '--pc-field': '#17251f',
  '--pc-grove': '#20342b',
  '--pc-harvest': '#dff56c',
  '--pc-rice': '#f2f5ef',
  '--pc-danger': '#e26e67',
  '--pc-canvas': '#17251f',
  '--pc-workspace': '#20342b',
  '--pc-owned': '#f2f5ef',
  '--pc-ink': '#f2f5ef',
  '--pc-muted': '#a8b5ad',
  '--pc-faint': '#8c9b93',
  '--pc-owned-ink': '#17251f',
  '--pc-owned-muted': '#536159',
  '--pc-harvest-ink': '#17251f',
  '--pc-danger-ink': '#17251f',
  '--pc-danger-on-light': '#a8403c',
  '--pc-warning': '#e8a33d',
  '--pc-focus': '#dff56c',
  '--pc-focus-contrast': '#17251f',
  '--pc-line': 'rgb(242 245 239 / 16%)',
  '--pc-line-strong': '#8c9b93',
  '--pc-overlay': 'rgb(7 15 11 / 62%)',
  '--pc-shadow-color': 'rgb(7 15 11 / 28%)',
  '--pc-shadow-support': '0 8px 24px rgb(7 15 11 / 28%)',
  '--pc-shadow-dominant': '0 24px 60px rgb(7 15 11 / 28%)',
})

// Contract :69-99 -- :root[data-theme='day-field'].
const DAY_FIELD_TOKENS = Object.freeze({
  '--pc-field': '#17251f',
  '--pc-grove': '#20342b',
  '--pc-harvest': '#dff56c',
  '--pc-rice': '#f2f5ef',
  '--pc-danger': '#a8403c',
  '--pc-canvas': '#e9eee8',
  '--pc-workspace': '#f7f9f5',
  '--pc-owned': '#f2f5ef',
  '--pc-ink': '#17251f',
  '--pc-muted': '#536159',
  '--pc-faint': '#5f6c65',
  '--pc-owned-ink': '#17251f',
  '--pc-owned-muted': '#536159',
  '--pc-harvest-ink': '#17251f',
  '--pc-danger-ink': '#f2f5ef',
  '--pc-danger-on-light': '#a8403c',
  '--pc-warning': '#8a5a00',
  '--pc-focus': '#17251f',
  '--pc-focus-contrast': '#f2f5ef',
  '--pc-line': 'rgb(23 37 31 / 16%)',
  '--pc-line-strong': '#5f6c65',
  '--pc-overlay': 'rgb(23 37 31 / 48%)',
  '--pc-shadow-color': 'rgb(23 37 31 / 16%)',
  '--pc-shadow-support': '0 8px 24px rgb(23 37 31 / 16%)',
  '--pc-shadow-dominant': '0 24px 60px rgb(23 37 31 / 16%)',
})

const THEME_TOKENS = Object.freeze({ forest: FOREST_TOKENS, 'day-field': DAY_FIELD_TOKENS })

// The twelve declarations pocket-crew.css carried as hardcoded literals before this port (7 in
// Forest, 5 in Day Field) and now carries as the contract's var() alias form -- pinned
// independently from THEME_TOKENS above (sourced from the pre-port file content, not re-derived
// from the contract pin) so a mistake in one list can't silently validate the other.
const PRE_PORT_ALIASED_VALUES = Object.freeze({
  forest: Object.freeze({
    '--pc-canvas': '#17251f',
    '--pc-workspace': '#20342b',
    '--pc-owned': '#f2f5ef',
    '--pc-ink': '#f2f5ef',
    '--pc-owned-ink': '#17251f',
    '--pc-harvest-ink': '#17251f',
    '--pc-danger-ink': '#17251f',
  }),
  'day-field': Object.freeze({
    '--pc-owned': '#f2f5ef',
    '--pc-ink': '#17251f',
    '--pc-owned-ink': '#17251f',
    '--pc-harvest-ink': '#17251f',
    '--pc-danger-ink': '#f2f5ef',
  }),
})

// Contract :100-168 -- the theme-independent :root block, minus --pc-shadow-support/-dominant
// (folded into THEME_TOKENS above since they resolve through the theme-dependent shadow color).
const SHARED_TOKENS = Object.freeze({
  '--pc-font-display': "'Geist Variable', 'Geist', system-ui, sans-serif",
  '--pc-font-body': "'Geist Variable', 'Geist', system-ui, sans-serif",
  '--pc-font-mono': "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
  '--pc-font-wordmark': "'Newsreader Variable', 'Newsreader', Georgia, serif",
  '--pc-space-1': '4px',
  '--pc-space-2': '8px',
  '--pc-space-3': '12px',
  '--pc-space-4': '16px',
  '--pc-space-5': '20px',
  '--pc-space-6': '24px',
  '--pc-space-8': '32px',
  '--pc-space-10': '40px',
  '--pc-space-12': '48px',
  '--pc-space-16': '64px',
  '--pc-space-20': '80px',
  '--pc-radius-control': '12px',
  '--pc-radius-support': '16px',
  '--pc-radius-dominant': '24px',
  '--pc-radius-round': '999px',
  '--pc-sidebar-width': '248px',
  '--pc-topbar-height': '64px',
  '--pc-shell-max': '1240px',
  '--pc-route-gutter': 'clamp(20px, 4vw, 48px)',
  '--pc-route-gap': 'clamp(32px, 5vw, 64px)',
  '--pc-dominant-padding': 'clamp(24px, 4vw, 48px)',
  '--pc-control-height': '48px',
  '--pc-touch-target': '44px',
  '--pc-type-money': 'clamp(48px, 7vw, 76px)',
  '--pc-type-page': 'clamp(34px, 4.4vw, 52px)',
  '--pc-type-stage': 'clamp(28px, 3.2vw, 40px)',
  '--pc-type-section': 'clamp(21px, 2vw, 28px)',
  '--pc-type-body': '16px',
  '--pc-type-body-small': '14px',
  '--pc-type-label': '13px',
  '--pc-type-technical': '12px',
  '--pc-leading-tight': '1.05',
  '--pc-leading-title': '1.12',
  '--pc-leading-body': '1.55',
  '--pc-duration-fast': '120ms',
  '--pc-duration-base': '220ms',
  '--pc-duration-enter': '320ms',
  '--pc-stagger': '40ms',
  '--pc-ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
  '--pc-ease-standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
  '--pc-z-base': '0',
  '--pc-z-sticky': '20',
  '--pc-z-popover': '40',
  '--pc-z-overlay': '80',
  '--pc-z-dialog': '90',
  '--pc-z-skip-link': '100',
})

// Contract :834-841 -- the mobile :root override.
const MOBILE_ROOT_OVERRIDE = Object.freeze({
  '--pc-route-gutter': '16px',
  '--pc-route-gap': '36px',
  '--pc-dominant-padding': '24px',
  '--pc-type-money': 'clamp(44px, 15vw, 60px)',
  '--pc-type-page': 'clamp(32px, 10vw, 42px)',
})

// Foundation's own tokens -- not part of the contract, must survive the port untouched.
const FOUNDATION_ONLY_TOKENS = Object.freeze({
  forest: Object.freeze({
    '--pc-crew-1': '#8fbf8a',
    '--pc-crew-2': '#6fa8dc',
    '--pc-crew-3': '#e0b84b',
    '--pc-crew-4': '#c9967b',
    '--pc-crew-5': '#5fd3bc',
    '--pc-crew-6': '#d98ba8',
    '--pc-disabled': '#8c9b93',
    '--pc-disabled-on-dark': '#8c9b93',
    '--pc-disabled-on-light': '#5f6c65',
    '--pc-focus-on-dark': '#dff56c',
    '--pc-focus-on-light': '#17251f',
    '--pc-radius-sm': '12px',
    '--pc-radius-md': '16px',
    '--pc-radius-lg': '24px',
  }),
  'day-field': Object.freeze({
    '--pc-crew-1': '#569d50',
    '--pc-crew-2': '#3e72a8',
    '--pc-crew-3': '#b18220',
    '--pc-crew-4': '#8c5a3e',
    '--pc-crew-5': '#229c85',
    '--pc-crew-6': '#a8446b',
    '--pc-disabled': '#5f6c65',
    '--pc-disabled-on-dark': '#8c9b93',
    '--pc-disabled-on-light': '#5f6c65',
    '--pc-focus-on-dark': '#dff56c',
    '--pc-focus-on-light': '#17251f',
    '--pc-radius-sm': '12px',
    '--pc-radius-md': '16px',
    '--pc-radius-lg': '24px',
  }),
})

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

      Object.entries(PRE_PORT_ALIASED_VALUES[themeId]).forEach(([property, expected]) => {
        expect(resolved(computed, property), property).toBe(normalizedCssValue(expected))
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

    Object.entries(MOBILE_ROOT_OVERRIDE).forEach(([property, expected]) => {
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
