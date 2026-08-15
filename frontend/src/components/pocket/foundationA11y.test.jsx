// Foundation CAP-01 semantic and accessibility acceptance checks for the isolated atlas fixture.
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { CONTRAST_REQUIREMENTS, contrastRatio } from '../../design/contrast.js'
import { toFreshnessView } from '../../design/pocket-crew-foundation.js'
import {
  FOUNDATION_ATLAS_MODEL,
  FOUNDATION_CLOCK,
  FOUNDATION_FACT,
  FOUNDATION_PUBLIC_STRINGS,
  FOUNDATION_STALE_FACT,
  FoundationAtlasFixture,
} from '../../../visual/FoundationAtlasFixture.jsx'
import { assertPocketCrewVisualFixtureSafe } from '../../../scripts/generate-pocket-crew-foundation-contract.mjs'

expect.extend(axeMatchers)

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('style')
  document.body.innerHTML = ''
})

function renderTheme(theme) {
  document.documentElement.dataset.theme = theme
  return render(<FoundationAtlasFixture theme={theme} />)
}

describe('FoundationAtlasFixture CAP-01 a11y', () => {
  it.each(['forest', 'day-field'])('has zero axe violations in %s', async (theme) => {
    const { container } = renderTheme(theme)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('keeps the atlas one-heading, section-complete, and visibly labelled', () => {
    renderTheme('forest')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Pocket Crew foundation atlas' })).toBeTruthy()
    expect(screen.getAllByText(/Stellar testnet/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Base Sepolia/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Unknown network').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-foundation-section]')).toHaveLength(9)
  })

  it('keeps every network, money, and venue state truthful', () => {
    renderTheme('forest')
    for (const copy of [
      'Awaiting bridge on Stellar testnet',
      'Bridging from Stellar testnet',
      'Arrived on Base Sepolia',
      'Bridge failed. Funds remain on Stellar testnet',
      'Bridge status unknown',
      'Loading',
      '1,234.56 USDC',
      '987.65 USDC',
      'No balance yet',
      'Could not load',
      'Unknown',
      'Autofarm Vault supplies to Blend',
      'Authoritative yield: Unavailable',
      'Base Sepolia proxy. Custody only. No protocol yield.',
    ]) {
      expect(
        screen.getAllByText(new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))).length
      ).toBeGreaterThan(0)
    }
    expect(screen.queryByText(/^0(?:\.0+)? USDC$/u)).toBeNull()
    expect(screen.queryByText(/8\.2% APY/u)).toBeNull()
  })

  it('shares source-owned Fact evidence across status, technical, and venue views', () => {
    renderTheme('forest')
    const freshness = toFreshnessView(FOUNDATION_FACT)
    expect(Object.keys(freshness)).toEqual([
      'phase',
      'state',
      'label',
      'source',
      'checkedAt',
      'staleAfterMs',
      'confirmedLedger',
      'confirmedBlock',
    ])
    expect(freshness).toEqual({
      phase: 'confirmed',
      state: 'confirmed',
      label: 'Confirmed',
      source: FOUNDATION_FACT.source,
      checkedAt: FOUNDATION_CLOCK.checkedAt,
      staleAfterMs: null,
      confirmedLedger: FOUNDATION_CLOCK.confirmedLedger,
      confirmedBlock: FOUNDATION_CLOCK.confirmedBlock,
    })
    expect(screen.getAllByText(FOUNDATION_FACT.consequence).length).toBeGreaterThan(0)
    expect(screen.getAllByText(FOUNDATION_FACT.safeNextAction).length).toBeGreaterThan(0)
    expect(screen.getAllByText(FOUNDATION_CLOCK.checkedAt).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
    expect(screen.getAllByText(FOUNDATION_CLOCK.confirmedLedger).length).toBeGreaterThan(0)
    expect(screen.getAllByText(FOUNDATION_CLOCK.confirmedBlock).length).toBeGreaterThan(0)
  })

  it('keeps identity phase cues dual-coded and omits an unverified mark', () => {
    renderTheme('forest')
    expect(document.querySelector('[data-identity-phase="planned"]')).toBeTruthy()
    expect(document.querySelector('[data-identity-phase="deployed"]')).toBeTruthy()
    const unavailable = document.querySelector('[data-identity-state="unavailable"]')
    expect(unavailable).toBeTruthy()
    expect(unavailable.querySelector('svg')).toBeNull()
    expect(unavailable.textContent).toContain('Agent identity unavailable')
  })

  it('uses native details disclosure and exposes long values as wrapping text', () => {
    renderTheme('forest')
    const details = document.querySelector('details')
    expect(details).toBeTruthy()
    expect(details.open).toBe(true)
    const summary = details.querySelector('summary')
    expect(summary?.textContent).toBe('Technical evidence')
    expect(summary?.getAttribute('role')).not.toBe('img')
    expect(document.querySelector('.pc-foundation-atlas-long-value')).toBeTruthy()
  })

  it('opens the dialog, moves focus, closes on Escape, and restores the trigger focus', () => {
    renderTheme('forest')
    const trigger = screen.getByRole('button', { name: 'Open evidence dialog' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Foundation evidence dialog' })
    expect(dialog).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Foundation evidence dialog' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['forest', 'day-field'])(
    'keeps dialog, disclosure, state, focus, and live text in reduced-motion parity for %s',
    (theme) => {
      renderTheme(theme)
      const liveRegion = document.querySelector('[aria-live="polite"]')
      expect(liveRegion).toBeTruthy()
      expect(liveRegion.textContent).toContain('Confirmed')

      const details = document.querySelector('details')
      const summary = details?.querySelector('summary')
      expect(details?.open).toBe(true)
      fireEvent.click(summary)
      expect(details?.open).toBe(false)
      fireEvent.click(summary)
      expect(details?.open).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: 'Show stale status' }))
      expect(liveRegion.textContent).toContain('Stale')
      expect(
        document.querySelector('[data-fixture="foundation"]')?.getAttribute('data-foundation-state')
      ).toBe('stale')
      expect(FOUNDATION_STALE_FACT.phase).toBe('stale')

      const css = readFileSync(resolve(process.cwd(), 'src/design/pocket-crew.css'), 'utf8')
      expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u)
      expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/u)
      expect(css).toMatch(/animation-duration:\s*0\.01ms\s*!important/u)

      const trigger = screen.getByRole('button', { name: 'Open evidence dialog' })
      trigger.focus()
      fireEvent.click(trigger)
      const close = screen.getByRole('button', { name: 'Close dialog' })
      expect(document.activeElement).toBe(close)
      fireEvent.keyDown(document, { key: 'Tab' })
      expect(document.activeElement).toBe(close)
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(close)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'Foundation evidence dialog' })).toBeNull()
      expect(document.activeElement).toBe(trigger)
    }
  )

  it('reuses Task 8 recursive fixture validation and keeps all public strings as values', () => {
    expect(() => assertPocketCrewVisualFixtureSafe(FOUNDATION_ATLAS_MODEL)).not.toThrow()
    for (const publicString of FOUNDATION_PUBLIC_STRINGS) {
      expect(JSON.stringify(FOUNDATION_ATLAS_MODEL)).toContain(publicString)
    }
  })
})

describe('CONTRAST_REQUIREMENTS (re-asserted for the Foundation acceptance surface)', () => {
  it.each(CONTRAST_REQUIREMENTS)('%s clears its minimum ratio', (_name, fg, bg, minimum) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(minimum)
  })
})
