// Core Task 11 route stylesheet contract.
//
// This suite reads the production stylesheets and the production JSX files.  It is deliberately
// not a snapshot of selector names: each assertion names a presentation regression that would
// change the rendered Core routes (shared geometry ownership, My Money typography/rhythm, and
// forbidden inline/effect escape hatches).
// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const routeRoot = path.resolve(here)
const read = (file) => fs.readFileSync(path.join(routeRoot, file), 'utf8')
const foundationCss = fs.readFileSync(path.resolve(routeRoot, '../design/pocket-crew.css'), 'utf8')
const cssFiles = {
  money: read('money/my-money.css'),
  strategy: read('strategy/strategy.css'),
  crew: read('crew/crew.css'),
  settings: read('settings/settings.css'),
}

function declarationsOnly(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function topLevelSelectors(css) {
  return [...declarationsOnly(css).matchAll(/^([^@{}\n]+)\{[^{}]*\}/gm)].map((match) =>
    match[1].trim()
  )
}

function rule(css, selector) {
  const source = declarationsOnly(css)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^{}]*)\\}`, 'm'))?.[1] ?? ''
}

describe('Core route stylesheet ownership', () => {
  it('reads Foundation contract owners and exposes the tokens consumed by Core routes', () => {
    const foundation = declarationsOnly(foundationCss)
    expect(topLevelSelectors(foundationCss)).toEqual(
      expect.arrayContaining(['.pc-route', '.pc-route-stack', '.pc-dialog', '.pc-dialog-panel'])
    )
    expect(foundation).toMatch(/--pc-space-3:\s*[^;]+;/)
    expect(foundation).toMatch(/--pc-route-gap:\s*[^;]+;/)
    expect(foundation).toMatch(/--pc-type-body:\s*[^;]+;/)
    expect(foundation).toMatch(/--pc-type-page:\s*[^;]+;/)
    expect(foundation).toMatch(/--pc-type-section:\s*[^;]+;/)
    expect(foundation).toMatch(/--pc-leading-body:\s*[^;]+;/)
    expect(foundation).toMatch(/--pc-leading-title:\s*[^;]+;/)
  })

  it('keeps Foundation-owned route geometry tokenized and avoids conflicting route copies', () => {
    // Strategy and Crew retain a small display/grid bridge for their route roots because their
    // existing compositions need an outer gap in addition to Foundation's width/gutter contract.
    // The bridge is allowed only when it leaves the Foundation width, margin, and padding values
    // untouched. My Money and Settings do not re-declare either Foundation selector.
    for (const [name, css] of Object.entries(cssFiles)) {
      const route = rule(css, '.pc-route')
      const stack = rule(css, '.pc-route-stack')
      if (name === 'strategy' || name === 'crew') {
        expect(route, `${name} route bridge must use a tokenized gap`).toMatch(
          /gap:\s*var\(--pc-route-gap\)/
        )
        expect(route, `${name} route bridge must not hard-code the gutter`).toMatch(
          /padding:\s*var\(--pc-route-gutter\)/
        )
      } else {
        expect(route, `${name} must not redefine Foundation .pc-route geometry`).toBe('')
        expect(stack, `${name} must not redefine Foundation .pc-route-stack geometry`).toBe('')
      }
    }
  })

  it('makes shared primitive ownership explicit against the exact current Foundation contract', () => {
    const foundationSelectors = topLevelSelectors(foundationCss)
    const routeFallbacks = {
      '.pc-dominant': ['money', 'strategy'],
      '.pc-button': ['money', 'strategy', 'crew'],
    }

    for (const [selector, fallbackNames] of Object.entries(routeFallbacks)) {
      if (foundationSelectors.includes(selector)) {
        for (const [name, css] of Object.entries(cssFiles)) {
          expect(topLevelSelectors(css), `${name} must not duplicate ${selector}`).not.toContain(
            selector
          )
        }
        continue
      }

      // The current Foundation file has no exact base rule for these two primitives. Removing
      // the route copies would therefore remove their layout/shape contract from the real route;
      // keep the exception explicit and require every fallback copy to stay byte-equivalent.
      const canonical = rule(cssFiles[fallbackNames[0]], selector)
      expect(canonical, `${selector} needs a non-empty current fallback`).not.toBe('')
      for (const [name, css] of Object.entries(cssFiles)) {
        if (!fallbackNames.includes(name)) {
          expect(
            topLevelSelectors(css),
            `${name} must not add a ${selector} fallback`
          ).not.toContain(selector)
          continue
        }
        expect(rule(css, selector), `${name} ${selector} fallback diverged`).toBe(canonical)
      }
    }
  })

  it('keeps My Money on the Pocket Crew body/title scale and gives evidence a tokenized rhythm', () => {
    const money = declarationsOnly(cssFiles.money)
    expect(money).toMatch(
      /\.pc-my-money-route\s*\{[^{}]*font-size:\s*var\(--pc-type-body\);[^{}]*line-height:\s*var\(--pc-leading-body\);[^{}]*\}/s
    )
    expect(money).toMatch(
      /\.pc-my-money-route\s*>\s*\.pc-route-stack\s*>\s*h1\s*\{[^{}]*font-size:\s*var\(--pc-type-page\);[^{}]*line-height:\s*var\(--pc-leading-title\);[^{}]*\}/s
    )
    expect(money).toMatch(
      /\.pc-my-money-route\s+\.pc-money-section\s*>\s*header\s+h2\s*\{[^{}]*font-size:\s*var\(--pc-type-section\);[^{}]*line-height:\s*var\(--pc-leading-title\);[^{}]*\}/s
    )
    expect(money).toMatch(
      /\.pc-my-money-route\s+\.pc-money-section\s*>\s*div\s*\{[^{}]*display:\s*grid;[^{}]*gap:\s*var\(--pc-space-3\);[^{}]*\}/s
    )
  })

  it('preserves the approved asymmetric My Money section composition', () => {
    const section = rule(cssFiles.money, '.pc-money-section')
    expect(section).toMatch(/grid-template-columns:\s*minmax\(180px,\s*3fr\)\s+minmax\(0,\s*9fr\)/)
    expect(section).toMatch(/gap:\s*var\(--pc-space-8\)/)
  })

  it('keeps dialog geometry owned by Foundation, with only the explicit money-dialog hook allowed', () => {
    for (const [name, css] of Object.entries(cssFiles)) {
      const selectors = topLevelSelectors(css)
      expect(selectors, `${name} must not own an unscoped Dialog root`).not.toContain('.pc-dialog')
      expect(selectors, `${name} must not own an unscoped Dialog panel`).not.toContain(
        '.pc-dialog-panel'
      )
    }
    expect(topLevelSelectors(cssFiles.money)).toContain('.pc-dialog.pc-money-dialog')
  })

  it('does not add forbidden visual effects or raw inline style escape hatches to Core route files', () => {
    for (const [name, css] of Object.entries(cssFiles)) {
      const active = declarationsOnly(css)
      expect(active, `${name} must not add gradients`).not.toMatch(/gradient\s*\(/i)
      expect(active, `${name} must not add glass blur`).not.toMatch(/backdrop-filter\s*:/i)
      const layerValues = [...active.matchAll(/z-index\s*:\s*([^;{}]+)/gi)].map((match) =>
        match[1].trim()
      )
      expect(
        layerValues.every((value) => /^var\(--pc-z-[^)]+\)$/.test(value)),
        `${name} must use a token for every layer`
      ).toBe(true)

      const transitionValues = [...active.matchAll(/transition(?:-[\w-]+)?\s*:\s*([^;{}]+)/gi)].map(
        (match) => match[1]
      )
      expect(transitionValues.join(' '), `${name} must not animate layout properties`).not.toMatch(
        /\b(width|height|top|right|bottom|left|inset|margin|padding|grid-template|flex)\b/i
      )
      expect(active, `${name} must not use !important to force transitions`).not.toMatch(
        /transition(?:-[\w-]+)?\s*:[^;{}]*!important/i
      )
      if (name === 'crew') {
        expect(active, 'Crew may keep only its state-bearing guard sweep keyframe').toMatch(
          /@keyframes\s+pc-crew-sweep\b/
        )
        expect(
          active.replace(/@keyframes\s+pc-crew-sweep\b[\s\S]*?\}/, ''),
          'Crew must not add a second keyframe family'
        ).not.toMatch(/@keyframes\b/i)
      } else {
        expect(active, `${name} must not add shimmer/glow keyframes`).not.toMatch(/@keyframes\b/i)
      }
    }
    for (const file of [
      'money/MyMoneyRoute.jsx',
      'money/MoneyHero.jsx',
      'money/PositionList.jsx',
      'money/AgentTeam.jsx',
      'money/VaultProtection.jsx',
      'money/HowMoneyWorks.jsx',
      'money/TechnicalMoneyDetails.jsx',
      'strategy/StrategyRoute.jsx',
      'crew/CrewRoute.jsx',
      'SettingsPage.jsx',
    ]) {
      expect(read(file), `${file} must not use inline styles`).not.toMatch(/<style\b|\bstyle\s*=/i)
    }
  })
})
