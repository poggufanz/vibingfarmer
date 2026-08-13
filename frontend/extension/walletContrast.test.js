// VF Wallet pure contrast contract.
//
// This deliberately never asks a browser for computed styles and never treats axe or a pixel
// sample as a contrast proof. The reviewed tuple table is generated from the Foundation contract
// by src/design/contrast.js; wallet pages must use the same semantic/crew/state pairs.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONTRAST_REQUIREMENTS, contrastRatio } from '../src/design/contrast.js'
import { FOUNDATION_CREW_TOKENS, FOUNDATION_THEMES } from '../src/design/pocket-crew-contract.js'

const walletCss = readFileSync(resolve(import.meta.dirname, 'wallet.css'), 'utf8')
const approvalCss = readFileSync(resolve(import.meta.dirname, 'approval.css'), 'utf8')

const reviewedThemes = [FOUNDATION_THEMES.forest, FOUNDATION_THEMES['day-field']]

describe('VF Wallet pure contrast tuples', () => {
  it('clears every registered Foundation semantic, crew-ink, and state-ink threshold', () => {
    expect(CONTRAST_REQUIREMENTS.length).toBeGreaterThan(0)
    for (const [name, foreground, background, minimum] of CONTRAST_REQUIREMENTS) {
      expect(contrastRatio(foreground, background), name).toBeGreaterThanOrEqual(minimum)
    }
  })

  it('keeps both external wallet stylesheets sourced from the generated token contract', () => {
    for (const tokenSet of reviewedThemes) {
      for (const value of Object.values(tokenSet)) {
        if (!/^#[0-9a-f]{6}$/iu.test(value)) continue
        expect(walletCss.toLowerCase()).toContain(value.toLowerCase())
        expect(approvalCss.toLowerCase()).toContain(value.toLowerCase())
      }
    }
  })

  it('registers text, state, disabled, focus, and boundary pairs rather than delegating to axe', () => {
    const names = CONTRAST_REQUIREMENTS.map(([name]) => name)
    expect(names.some((name) => /disabled/iu.test(name))).toBe(true)
    expect(names.some((name) => /focus/iu.test(name))).toBe(true)
    expect(names.some((name) => /Boundary/iu.test(name))).toBe(true)
    expect(names.some((name) => /crewInk/iu.test(name))).toBe(true)
    expect(names.some((name) => /stateInk/iu.test(name))).toBe(true)
    for (const crewSet of Object.values(FOUNDATION_CREW_TOKENS)) {
      for (const value of Object.values(crewSet)) {
        expect(
          CONTRAST_REQUIREMENTS.some(([, foreground, background]) =>
            [foreground, background].includes(value)
          )
        ).toBe(true)
      }
    }
  })
})
