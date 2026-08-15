// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { assertPocketCrewVisualFixtureSafe } from '../../../scripts/generate-pocket-crew-foundation-contract.mjs'
import {
  FOUNDATION_ATLAS_MODEL,
  FOUNDATION_CLOCK,
  FOUNDATION_FACT,
  FOUNDATION_PUBLIC_STRINGS,
  FoundationAtlasFixture,
} from '../../../visual/FoundationAtlasFixture.jsx'

afterEach(cleanup)

describe('FoundationAtlasFixture', () => {
  it('publishes the fixed offline clock, anchors, and display strings', () => {
    expect(FOUNDATION_CLOCK).toEqual({
      nowMs: 1786406400000,
      nowIso: '2026-08-11T00:00:00.000Z',
      checkedAtMs: 1786406340000,
      checkedAt: '2026-08-10T23:59:00.000Z',
      staleAfterMs: null,
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })
    expect(FOUNDATION_FACT.checkedAt).toBe(FOUNDATION_CLOCK.checkedAt)
    expect(FOUNDATION_FACT.staleAfterMs).toBeNull()
    expect(FOUNDATION_FACT.confirmedLedger).toBe('12345')
    expect(FOUNDATION_FACT.confirmedBlock).toBe('67890')
    expect(FOUNDATION_PUBLIC_STRINGS).toEqual([
      'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS',
      'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
      'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J',
      'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77',
      'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
      '0x0000000000000000000000000000000000000aa1',
      '0x00000000000000000000000000000000000000b2',
    ])
  })

  it('keeps the generated fixture model within the Task 8 safety boundary', () => {
    expect(() => assertPocketCrewVisualFixtureSafe(FOUNDATION_ATLAS_MODEL)).not.toThrow()
    expect(Object.isFrozen(FOUNDATION_ATLAS_MODEL)).toBe(true)
  })

  it('renders the exact atlas sections, states, and one page heading', () => {
    render(<FoundationAtlasFixture theme="forest" />)

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Pocket Crew foundation atlas' })).toBeTruthy()
    expect(
      [...document.querySelectorAll('[data-foundation-section]')].map(
        (node) => node.dataset.foundationSection
      )
    ).toEqual([
      'BrandLockup',
      'NetworkBadge/NetworkRoute',
      'AgentMark',
      'MoneyFigure',
      'VenueTruth',
      'StatusNotice',
      'TechnicalDetails',
      'StageShell',
      'Dialog',
    ])

    for (const className of [
      'pc-foundation-atlas',
      'pc-foundation-atlas-section',
      'pc-foundation-atlas-grid',
    ]) {
      expect(document.querySelector(`.${className}`)).toBeTruthy()
    }

    for (const text of [
      'Awaiting bridge on Stellar testnet',
      'Bridging from Stellar testnet',
      'Arrived on Base Sepolia',
      'Bridge failed. Funds remain on Stellar testnet',
      'Bridge status unknown',
      'Unknown network',
      'Loading',
      '1,234.56 USDC',
      '987.65 USDC',
      'No balance yet',
      'Could not load',
      'Unknown',
      'Autofarm Vault supplies to Blend',
      'Base Sepolia proxy. Custody only. No protocol yield.',
      'Unavailable',
    ]) {
      expect(
        screen.getAllByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))).length
      ).toBeGreaterThan(0)
    }
  })

  it('renders fixed fact provenance, consequence, safe action, and identity phases', () => {
    render(<FoundationAtlasFixture theme="forest" />)

    expect(screen.getAllByText(FOUNDATION_FACT.source).length).toBeGreaterThan(0)
    expect(screen.getAllByText(FOUNDATION_FACT.consequence).length).toBeGreaterThan(0)
    expect(screen.getAllByText(FOUNDATION_FACT.safeNextAction).length).toBeGreaterThan(0)
    expect(screen.getAllByText(FOUNDATION_CLOCK.checkedAt).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.getByText(FOUNDATION_PUBLIC_STRINGS[0])).toBeTruthy()
    expect(screen.getByText(FOUNDATION_PUBLIC_STRINGS[5])).toBeTruthy()
    expect(screen.getByText(FOUNDATION_PUBLIC_STRINGS[6])).toBeTruthy()
    expect(document.querySelector('[data-identity-phase="planned"]')).toBeTruthy()
    expect(document.querySelector('[data-identity-phase="deployed"]')).toBeTruthy()
    expect(document.querySelector('[data-identity-state="unavailable"]')).toBeTruthy()
  })

  it('does not present an unverified Stellar yield as a live APY or source claim', () => {
    render(<FoundationAtlasFixture theme="forest" />)

    expect(screen.queryByText(/8\.2% APY/u)).toBeNull()
    expect(screen.getByText('Authoritative yield: Unavailable')).toBeTruthy()

    const source = readFileSync(resolve(process.cwd(), 'visual/FoundationAtlasFixture.jsx'), 'utf8')
    expect(source).not.toMatch(/8\.2|Stellar RPC/iu)
  })

  it('keeps the disclosure open, exposes a wrapping hook, and provides a dialog trigger', () => {
    render(<FoundationAtlasFixture theme="forest" />)

    expect(document.querySelector('details')?.open).toBe(true)
    expect(document.querySelector('.pc-foundation-atlas-long-value')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open evidence dialog' })).toBeTruthy()
    expect(document.querySelector('[aria-live="polite"]')).toBeTruthy()
  })

  it('keeps shared status and technical fact rhythm on the Pocket Crew spacing grid', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')
    expect(css).toMatch(/\.pc-status-notice-label,[\s\S]*?margin:\s*var\(--pc-space-1\) 0 0;/u)
    expect(css).toMatch(/\.pc-technical-details-fact,[\s\S]*?gap:\s*var\(--pc-space-2\);/u)
    expect(css).not.toMatch(/0\.2rem|0\.35rem/u)
  })

  it('keeps every network route fact explicit, separated, and wrappable', () => {
    render(<FoundationAtlasFixture theme="forest" />)
    const facts = document.querySelector('.network-route-facts')
    expect(facts).toBeTruthy()
    expect([...facts.children].map((node) => node.className)).toEqual([
      'network-route-source',
      'network-route-destination',
      'network-route-custody',
      'network-route-transit',
      'network-route-status-label',
    ])

    const css = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')
    expect(css).toMatch(/\.network-badge\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?gap:\s*7px;/u)
    expect(css).toMatch(
      /\.network-route-facts\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*var\(--pc-space-1\) var\(--pc-space-2\);/u
    )
    expect(css).toMatch(/\.network-route-facts\s*>\s*span[\s\S]*?overflow-wrap:\s*anywhere;/u)
  })

  it('contains no ambient clock, randomness, network, or remote-url access', () => {
    const source = readFileSync(resolve(process.cwd(), 'visual/FoundationAtlasFixture.jsx'), 'utf8')
    expect(source).not.toMatch(
      /Date\.now|Math\.random|fetch|XMLHttpRequest|WebSocket|crypto\.getRandomValues/iu
    )
    expect(source).not.toMatch(/https?:\/\//iu)
  })

  it('keeps the visual entry on the canonical foundation fixture without a legacy duplicate', () => {
    const source = readFileSync(resolve(process.cwd(), 'visual/main.jsx'), 'utf8')
    expect(source).not.toMatch(/_LegacyFoundationFixture/iu)
    expect(source).toMatch(/return <FoundationAtlasFixture theme=\{theme\} \/>/u)
  })
})
