// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const moneyCss = fs.readFileSync(path.resolve(here, './my-money.css'), 'utf8')
const foundationCss = fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8')

// Contract scans must inspect declarations, not prose in the route stylesheet's extensive
// provenance comments. This also makes a forbidden rule impossible to hide behind a comment.
function declarationsOnly(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function topLevelRules(css) {
  // Owned files keep top-level selectors flush-left; nested media selectors are indented. This
  // deliberately ignores nested blocks so the mobile `.pc-route` safe-area override is not
  // mistaken for a duplicate of Foundation's top-level geometry rule.
  return [...css.matchAll(/^([.#][^@{}\n]+)\{([^{}]*)\}/gm)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }))
}

const activeMoneyCss = declarationsOnly(moneyCss)
const activeFoundationCss = declarationsOnly(foundationCss)
const moneyRules = topLevelRules(activeMoneyCss)
const foundationRules = topLevelRules(activeFoundationCss)

function hasExactRule(rules, selector) {
  return rules.some((rule) => rule.selector === selector)
}

describe('My Money CSS contract', () => {
  it('keeps shared route geometry in Foundation while retaining owned visual selectors absent there', () => {
    expect(hasExactRule(foundationRules, '.pc-route')).toBe(true)
    expect(hasExactRule(foundationRules, '.pc-route-stack')).toBe(true)
    expect(hasExactRule(moneyRules, '.pc-route')).toBe(false)
    expect(hasExactRule(moneyRules, '.pc-route-stack')).toBe(false)
    expect(activeMoneyCss).not.toMatch(/\.pc-route\s*\{/)

    // The current Foundation cascade has no base selector for these owned route roles. Their
    // local rules are intentional and preserve My Money visuals without editing Foundation.
    expect(hasExactRule(foundationRules, '.pc-dominant')).toBe(false)
    expect(hasExactRule(foundationRules, '.pc-button')).toBe(false)
    expect(hasExactRule(moneyRules, '.pc-dominant')).toBe(true)
    expect(hasExactRule(moneyRules, '.pc-button')).toBe(true)
  })

  it('styles real hoisted money-dialog siblings directly with the required geometry', () => {
    expect(activeMoneyCss).toMatch(/\.pc-dialog\.pc-money-dialog\s*\{[\s\S]*?z-index:\s*var\(/)
    expect(activeMoneyCss).not.toMatch(/\.pc-my-money-route\s+\.pc-dialog/)
    expect(activeMoneyCss).toMatch(
      /\.pc-money-dialog\s+\.pc-dialog-panel\s*\{[\s\S]*?width:\s*min\(100%,\s*480px\)/
    )
    expect(activeMoneyCss).toMatch(
      /\.pc-money-dialog\s+\.pc-dialog-panel\s*\{[\s\S]*?max-height:\s*min\(760px,\s*calc\(100dvh\s*-\s*32px\)\)/
    )
    expect(activeMoneyCss).toMatch(
      /@media\s*\(max-width:\s*767px\)[\s\S]*?\.pc-money-dialog\s+\.pc-dialog-panel\s*\{[\s\S]*?max-height:\s*88dvh[\s\S]*?safe-area-inset-bottom/
    )
  })

  it('scopes mobile full-width buttons to money dialogs and leaves an unrelated dialog untouched', () => {
    const mobileCss = activeMoneyCss.slice(activeMoneyCss.indexOf('@media (max-width: 767px)'))
    expect(mobileCss).toMatch(
      /\.pc-money-dialog\s+\.pc-dialog-actions\s+\.pc-button\s*\{[\s\S]*?width:\s*100%/
    )
    // Match only a selector that starts at a CSS selector boundary.  A plain substring
    // search would also match the correctly-scoped `.pc-money-dialog .pc-dialog-actions`
    // selector after its ancestor has been consumed.
    expect(mobileCss).not.toMatch(
      /(?:^|[,{]\s*)\.pc-dialog-actions\s+\.pc-button\s*\{[\s\S]*?width:/m
    )

    const unrelated = document.createElement('div')
    unrelated.innerHTML =
      '<div class="pc-dialog"><div class="pc-dialog-actions"><button class="pc-button">Unrelated</button></div></div>'
    document.body.append(unrelated)
    expect(unrelated.querySelector('.pc-dialog-actions .pc-button')).toBeTruthy()
    expect(unrelated.querySelector('.pc-money-dialog .pc-dialog-actions .pc-button')).toBeNull()
    unrelated.remove()
  })

  it('keeps route spacing, shape, and layer values tokenized', () => {
    expect(activeMoneyCss).not.toMatch(
      /(?:gap|padding|margin|border-radius)\s*:\s*[^;{}]*(?:px|rem)\b/i
    )
    expect(activeMoneyCss).not.toMatch(/z-index\s*:\s*-?\d/i)
    expect(activeMoneyCss).not.toMatch(/(?:filter|backdrop-filter)\s*:[^;{}]*blur\s*\(/i)
    expect(activeMoneyCss).not.toMatch(/@keyframes|\banimation(?:-name)?\s*:/i)
    expect(activeMoneyCss).not.toMatch(/gradient\s*\(/i)
  })

  it('does not introduce inline style or style-tag escape hatches in the owned JSX surface', () => {
    for (const file of [
      'MyMoneyRoute.jsx',
      'MoneyHero.jsx',
      'PositionList.jsx',
      'AgentTeam.jsx',
      'VaultProtection.jsx',
      'HowMoneyWorks.jsx',
      'TechnicalMoneyDetails.jsx',
    ]) {
      const source = fs.readFileSync(path.resolve(here, file), 'utf8')
      expect(source, `${file} must not carry an inline style`).not.toMatch(/<style\b|\bstyle\s*=/i)
    }
  })
})
