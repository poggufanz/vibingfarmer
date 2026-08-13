import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BASE_HEX_FIXTURES,
  REQUIRED_WALLET_ATLAS_SECTIONS,
  STELLAR_C_FIXTURES,
  STELLAR_G_FIXTURE,
  WALLET_ATLAS_COMPOSITIONS,
  WALLET_ATLAS_SECTION_MAP,
  WALLET_CAPTURE_CELLS,
  WALLET_CAPTURE_GROUPS,
  WALLET3_VARIANTS,
  assertWalletFixtureState,
} from './walletFixtureRegistry.js'

const POPUP_IDS = Array.from({ length: 21 }, (_, i) => `P${String(i).padStart(2, '0')}`)
const APPROVAL_IDS = Array.from({ length: 10 }, (_, i) => `A${String(i).padStart(2, '0')}`)
const CEREMONY_IDS = Array.from({ length: 10 }, (_, i) => `C${String(i).padStart(2, '0')}`)
const VISUAL_MAIN_SOURCE = readFileSync(resolve(import.meta.dirname, 'main.jsx'), 'utf8')

describe('VF Wallet deterministic fixture registry', () => {
  it('registers the exact 41 P/A/C sections with one composition contract each', () => {
    expect(REQUIRED_WALLET_ATLAS_SECTIONS).toEqual([...POPUP_IDS, ...APPROVAL_IDS, ...CEREMONY_IDS])
    expect(REQUIRED_WALLET_ATLAS_SECTIONS).toHaveLength(41)
    expect(Object.keys(WALLET_ATLAS_SECTION_MAP)).toEqual(REQUIRED_WALLET_ATLAS_SECTIONS)

    for (const id of REQUIRED_WALLET_ATLAS_SECTIONS) {
      const section = WALLET_ATLAS_SECTION_MAP[id]
      expect(section.id).toBe(id)
      expect(section.fixture).toBe(id.startsWith('P') ? 'vf-wallet-home' : 'vf-wallet-approval')
      expect(WALLET_ATLAS_COMPOSITIONS).toContain(section.composition)
      expect(section.states.length).toBeGreaterThan(0)
      expect(() => assertWalletFixtureState(section)).not.toThrow()
    }
  })

  it('keeps identity fixtures case-sensitive and display-only', () => {
    expect(STELLAR_G_FIXTURE).toBe('GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS')
    expect(STELLAR_C_FIXTURES).toEqual([
      'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
      'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J',
      'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77',
      'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
    ])
    expect(STELLAR_G_FIXTURE).toMatch(/^G[A-Z2-7]{55}$/u)
    for (const value of STELLAR_C_FIXTURES) expect(value).toMatch(/^C[A-Z2-7]{55}$/u)
    expect(BASE_HEX_FIXTURES).toEqual([
      '0x0000000000000000000000000000000000000aa1',
      '0x00000000000000000000000000000000000000b2',
    ])
    for (const value of BASE_HEX_FIXTURES) expect(value).toMatch(/^0x[0-9a-f]{40}$/u)
    expect(STELLAR_G_FIXTURE).not.toMatch(/^0x[0-9a-f]{40}$/u)
    expect(BASE_HEX_FIXTURES[0]).not.toMatch(/^G[A-Z2-7]{55}$/u)
    expect(BASE_HEX_FIXTURES[0]).not.toMatch(/^C[A-Z2-7]{55}$/u)

    expect(VISUAL_MAIN_SOURCE).toMatch(/const VFW_PUBLIC_G_DISPLAY = STELLAR_G_FIXTURE/u)
    expect(VISUAL_MAIN_SOURCE).toMatch(/const VFW_PUBLIC_C_DISPLAY = STELLAR_C_FIXTURES\[0\]/u)
    expect(VISUAL_MAIN_SOURCE).toMatch(/const VFW_BASE_KERNEL_DISPLAY = BASE_HEX_FIXTURES\[0\]/u)
    for (const alias of [
      'VFW_PUBLIC_G_DISPLAY',
      'VFW_PUBLIC_C_DISPLAY',
      'VFW_BASE_KERNEL_DISPLAY',
    ]) {
      expect(VISUAL_MAIN_SOURCE).not.toMatch(
        new RegExp(`(?:address|owner|account|custody|session|capability)\\s*:\\s*${alias}\\b`, 'u')
      )
    }
  })

  it('freezes the finite capture metadata without requiring screenshot execution', () => {
    expect(WALLET_CAPTURE_GROUPS).toHaveLength(3)
    expect(WALLET3_VARIANTS).toHaveLength(3)
    expect(WALLET_CAPTURE_CELLS).toHaveLength(9)
    expect(WALLET_CAPTURE_CELLS.map((cell) => cell.id)).toEqual([
      'popup-forest-360',
      'popup-day-field-360',
      'popup-reduced-forest-360',
      'approval-forest-360',
      'approval-day-field-360',
      'approval-reduced-forest-360',
      'ceremony-forest-360',
      'ceremony-day-field-360',
      'ceremony-reduced-forest-360',
    ])
    for (const cell of WALLET_CAPTURE_CELLS) {
      expect([320, 360]).toContain(cell.width)
      expect(['forest', 'day-field']).toContain(cell.theme)
      expect(['normal', 'reduced']).toContain(cell.motion)
    }
  })

  it('wires external CSS, theme/motion query state, and a settled false readiness gate without side effects', () => {
    expect(VISUAL_MAIN_SOURCE).toMatch(/import\('\.\.\/extension\/wallet\.css'\)/u)
    expect(VISUAL_MAIN_SOURCE).toMatch(/import\('\.\.\/extension\/approval\.css'\)/u)
    expect(VISUAL_MAIN_SOURCE).toContain('document.documentElement.dataset.theme = theme')
    expect(VISUAL_MAIN_SOURCE).toContain('document.documentElement.dataset.motion = motion')
    expect(VISUAL_MAIN_SOURCE).toContain("data-fixture-pending={ready ? 'false' : 'true'}")
    expect(VISUAL_MAIN_SOURCE).toContain("data-fixture-pending={cssReady ? 'false' : 'true'}")

    const walletFixtureSource = VISUAL_MAIN_SOURCE.slice(
      VISUAL_MAIN_SOURCE.indexOf('function VfWalletHomeFixture'),
      VISUAL_MAIN_SOURCE.indexOf('// approval.css is dynamically imported')
    )
    const approvalFixtureSource = VISUAL_MAIN_SOURCE.slice(
      VISUAL_MAIN_SOURCE.indexOf('function VfWalletApprovalFixture'),
      VISUAL_MAIN_SOURCE.indexOf(
        '// -------------------------------------------------------------------------------------------\n// Secondary functional fixture branches'
      )
    )
    for (const source of [walletFixtureSource, approvalFixtureSource]) {
      expect(source).not.toMatch(/\b(fetch|Date\.now|Math\.random|XMLHttpRequest|WebSocket)\b/u)
    }
  })
})
