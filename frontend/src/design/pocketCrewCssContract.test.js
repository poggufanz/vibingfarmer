// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FOUNDATION_BREAKPOINTS, FOUNDATION_LAYERS } from './pocket-crew-contract.js'

const CSS_PATH = resolve(process.cwd(), 'src/design/pocket-crew.css')

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

const parseStyleRules = (css) => {
  const probe = document.createElement('style')
  probe.textContent = css
  document.head.append(probe)

  const rules = []
  const visit = (cssRules, mediaConditions = []) => {
    Array.from(cssRules || []).forEach((cssRule) => {
      if (cssRule.selectorText && cssRule.style) {
        const declarations = {}
        for (let index = 0; index < cssRule.style.length; index += 1) {
          const property = cssRule.style.item(index)
          const value = cssRule.style.getPropertyValue(property).trim()
          const priority = cssRule.style.getPropertyPriority(property)
          declarations[property] = priority ? value + ' !' + priority : value
        }

        rules.push({
          selectors: cssRule.selectorText.split(',').map((selector) => selector.trim()),
          declarations,
          mediaConditions,
        })
      }

      if (cssRule.cssRules) {
        const condition = cssRule.conditionText?.trim()
        visit(cssRule.cssRules, condition ? [...mediaConditions, condition] : mediaConditions)
      }
    })
  }

  visit(probe.sheet?.cssRules)
  probe.remove()
  return rules
}

const ruleBody = (css, selector) =>
  parseStyleRules(css)
    .filter((rule) => rule.selectors.includes(selector))
    .at(-1)

const declaration = (rule, property) => rule?.declarations?.[property]

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

const reducedMotionRules = (css) =>
  parseStyleRules(css).filter(({ mediaConditions }) =>
    mediaConditions.some(
      (condition) => condition.replace(/\s+/g, ' ').trim() === REDUCED_MOTION_QUERY
    )
  )

const reducedMotionDeclaration = (css, selector, property) =>
  reducedMotionRules(css)
    .filter((rule) => rule.selectors.includes(selector))
    .at(-1)?.declarations[property]

const computedDeclaration = (css, className, property) => {
  const probe = document.createElement('style')
  const target = document.createElement('span')
  probe.textContent = css
  target.className = className
  document.head.append(probe)
  document.body.append(target)

  try {
    return getComputedStyle(target).getPropertyValue(property).trim()
  } finally {
    target.remove()
    probe.remove()
  }
}

const LEGACY_ALIAS_PROPERTIES = Object.freeze([
  '--pc-radius-sm',
  '--pc-radius-md',
  '--pc-radius-lg',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--font-display',
  '--font-body',
  '--font-sans',
  '--font-mono',
  '--mono',
  '--font-script',
  '--ease-out',
  '--shadow-sm',
  '--shadow-md',
  '--shadow-lg',
])

const sourceDeclarations = (css, property) => {
  const escapedProperty = property.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`^\\s*${escapedProperty}\\s*:\\s*([^;]+);`, 'gmu'))].map(
    (match) => match[1].trim()
  )
}

const resolveLayerValue = (value) => {
  const token = value?.match(/^var\((--pc-[\w-]+)\)$/u)?.[1]
  return token ? FOUNDATION_LAYERS[token] : Number.parseInt(value, 10)
}

const assertMoneyAndReducedMotionContract = (css) => {
  const clean = stripComments(css)
  const money = ruleBody(clean, '.pc-money')
  expect(declaration(money, 'font-family')).toBe('var(--pc-font-body)')
  expect(computedDeclaration(clean, 'pc-money', 'font-family')).toBe('var(--pc-font-body)')

  expect(reducedMotionRules(clean)).not.toHaveLength(0)
  expect(reducedMotionDeclaration(clean, '*', 'transition-duration')).toBe('0.01ms !important')
}

describe('Pocket Crew foundation CSS contract', () => {
  let cssText
  let cleanCss
  let style

  beforeEach(() => {
    cssText = readFileSync(CSS_PATH, 'utf8')
    cleanCss = stripComments(cssText)
    style = document.createElement('style')
    style.textContent = cssText
    document.head.append(style)
  })

  afterEach(() => {
    style.remove()
    document.documentElement.removeAttribute('data-theme')
  })

  it('keeps money figures on the body face with tabular numerals', () => {
    const rule = ruleBody(cleanCss, '.pc-money')

    expect(declaration(rule, 'font-family')).toBe('var(--pc-font-body)')
    expect(declaration(rule, 'font-variant-numeric')).toBe('tabular-nums')
  })

  it('rejects later money overrides and reduced-motion declarations outside the exact block', () => {
    const outsideReducedMotionMutation = cleanCss
      .replace('transition-duration: 0.01ms !important;', 'transition-duration: 1s !important;')
      .concat(
        '\n.pc-money { font-family: var(--pc-wrong-font); }',
        '\n* { transition-duration: 0.01ms !important; }'
      )
    const insideReducedMotionMutation = `${cleanCss}
@media (prefers-reduced-motion: reduce) {
  *, *::before { transition-duration: 1s !important; }
}`
    const specificityMutation = `${cleanCss}
body .pc-money { font-family: var(--pc-wrong-font); }`

    const rejected = [
      outsideReducedMotionMutation,
      insideReducedMotionMutation,
      specificityMutation,
    ].map((css) => {
      try {
        assertMoneyAndReducedMotionContract(css)
        return false
      } catch {
        return true
      }
    })

    expect(rejected).toEqual([true, true, true])
  })

  it('keeps legacy compatibility aliases as direct Foundation variable mappings', () => {
    LEGACY_ALIAS_PROPERTIES.forEach((property) => {
      const values = sourceDeclarations(cleanCss, property)

      expect(values, `${property} must be declared`).not.toHaveLength(0)
      values.forEach((value) => {
        expect(value, `${property} must map to a Foundation token`).toMatch(/^var\(--pc-[\w-]+\)$/u)
      })
    })
  })

  it('keeps Foundation dialogs above active legacy overlays during mixed migration', () => {
    const legacyCss = readFileSync(resolve(process.cwd(), 'style.css'), 'utf8')
    const combinedCss = stripComments(`${legacyCss}\n${cssText}`)
    const dialogZ = resolveLayerValue(declaration(ruleBody(combinedCss, '.pc-dialog'), 'z-index'))
    const legacyOverlayZ = ['.modal-backdrop', '.skill-drawer-overlay', '.skill-drawer'].map(
      (selector) => resolveLayerValue(declaration(ruleBody(combinedCss, selector), 'z-index'))
    )

    expect(dialogZ).toBe(FOUNDATION_LAYERS['--pc-z-overlay'])
    expect(legacyOverlayZ).toEqual([
      FOUNDATION_LAYERS['--pc-z-popover'],
      FOUNDATION_LAYERS['--pc-z-popover'],
      FOUNDATION_LAYERS['--pc-z-popover'],
    ])
    expect(dialogZ).toBeGreaterThan(Math.max(...legacyOverlayZ))
  })

  it('keeps #root containing-block sized at 200% without masking overflow', () => {
    const legacyCss = readFileSync(resolve(process.cwd(), 'style.css'), 'utf8')
    const root = ruleBody(stripComments(legacyCss), '#root')

    expect(root, 'style.css must define the application root contract').toBeDefined()
    expect(declaration(root, 'width')).toBe('100%')
    expect(declaration(root, 'overflow')).toBeUndefined()
    expect(declaration(root, 'overflow-x')).toBeUndefined()
  })

  it('uses foundation spacing and support shape tokens for StatusNotice', () => {
    const rule = ruleBody(cleanCss, '.pc-status-notice')

    expect(declaration(rule, 'gap')).toBe('var(--pc-space-3)')
    expect(declaration(rule, 'padding')).toBe('var(--pc-space-3) var(--pc-space-4)')
    expect(declaration(rule, 'border-radius')).toBe('var(--pc-radius-support)')
  })

  it('uses control spacing and shape tokens for TechnicalDetails', () => {
    const rule = ruleBody(cleanCss, '.pc-technical-details')

    expect(declaration(rule, 'border-radius')).toBe('var(--pc-radius-control)')
    expect(declaration(rule, 'padding')).toBe('var(--pc-space-2) var(--pc-space-3)')
  })

  it('binds Dialog overlay and panel to the documented layer and surface tokens', () => {
    const overlay = ruleBody(cleanCss, '.pc-dialog')
    const panel = ruleBody(cleanCss, '.pc-dialog-panel')

    expect(declaration(overlay, 'z-index')).toBe('var(--pc-z-overlay)')
    expect(declaration(overlay, 'background')).toBe('var(--pc-overlay)')
    expect(declaration(overlay, 'padding')).toBe('var(--pc-space-6)')
    expect(declaration(panel, 'z-index')).toBe('var(--pc-z-dialog)')
    expect(declaration(panel, 'border-radius')).toBe('var(--pc-radius-dominant)')
    expect(declaration(panel, 'padding')).toBe('var(--pc-space-6)')
  })

  it('keeps the skip link on the foundation layer scale', () => {
    const rule = ruleBody(cleanCss, '.pc-skip-link:focus')

    expect(declaration(rule, 'z-index')).toBe('var(--pc-z-skip-link)')
  })

  it('contains no literal legacy stacking values, gradients, glow, or shimmer declarations', () => {
    expect(cleanCss).not.toMatch(/z-index\s*:\s*(?:1000|2000|55)\b/u)
    expect(cleanCss).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/iu)
    expect(cleanCss).not.toMatch(/\b(?:glow|shimmer)\b/iu)
    expect(cleanCss).not.toMatch(
      /(?:animation|transition|filter)\s*:[^;{}]*\b(?:glow|shimmer|blur)\b/iu
    )
  })

  it('keeps reduced motion instantaneous and disables smooth scrolling', () => {
    expect(reducedMotionRules(cleanCss)).not.toHaveLength(0)
    expect(reducedMotionDeclaration(cleanCss, 'html:focus-within', 'scroll-behavior')).toBe('auto')
    expect(reducedMotionDeclaration(cleanCss, '*', 'scroll-behavior')).toBe('auto')
    expect(reducedMotionDeclaration(cleanCss, '*', 'animation-duration')).toBe('0.01ms !important')
    expect(reducedMotionDeclaration(cleanCss, '*', 'transition-duration')).toBe('0.01ms !important')
    expect(reducedMotionDeclaration(cleanCss, '*', 'transition-delay')).toBe('0ms !important')
  })

  it('uses the exact foundation mobile breakpoint', () => {
    expect(cleanCss).toMatch(
      new RegExp(`@media\\s*\\(max-width:\\s*${FOUNDATION_BREAKPOINTS.mobileMax}px\\)`)
    )
  })

  it('audits only the Foundation stylesheet', () => {
    expect(cleanCss).toContain('.pc-money')
    expect(cleanCss).toContain('.pc-dialog')
    expect(cleanCss).not.toMatch(/(?:^|[,{]\s*)\.(?:landing|console|extension)(?:[-\s.{:#])/imu)
  })
})
