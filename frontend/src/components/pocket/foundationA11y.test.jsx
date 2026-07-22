// frontend/src/components/pocket/foundationA11y.test.jsx
// Foundation Task 7 -- semantic + contrast coverage for the deterministic `foundation` fixture
// that ../../../visual/main.jsx also renders for Playwright. Importing `FoundationFixture`
// straight from the visual entry keeps exactly one copy of the fixture markup (per the brief);
// this file never redeclares the composition. An axe pass alone is not sufficient (brief Step
// 2), so every CONTRAST_REQUIREMENTS tuple is re-asserted here too via contrastRatio().
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { CONTRAST_REQUIREMENTS, contrastRatio } from '../../design/contrast.js'
import { FoundationFixture } from '../../../visual/main.jsx'

expect.extend(axeMatchers)

afterEach(cleanup)

function renderThemed(theme) {
  document.documentElement.dataset.theme = theme
  return render(<FoundationFixture />)
}

describe('FoundationFixture', () => {
  it('has zero axe violations in the forest theme', async () => {
    const { container } = renderThemed('forest')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero axe violations in the day-field theme', async () => {
    const { container } = renderThemed('day-field')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('carries the harness heading the Playwright smoke test relies on', () => {
    renderThemed('forest')
    expect(screen.getByRole('heading', { name: 'Pocket Crew visual harness' })).toBeTruthy()
  })

  // Explicit visible-label checks (brief Step 2) -- never rely on logo/mark recognition alone.
  it('names the product mark via visible text', () => {
    renderThemed('forest')
    expect(screen.getAllByText('Vibing Farmer').length).toBeGreaterThan(0)
  })

  it('labels every network badge with a visible name, not color/mark alone', () => {
    renderThemed('forest')
    expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Base Sepolia').length).toBeGreaterThan(0)
  })

  it('renders all five documented network route states as visible, truthful text', () => {
    renderThemed('forest')
    expect(screen.getByText('Awaiting bridge on Stellar testnet')).toBeTruthy()
    expect(screen.getByText('Bridging from Stellar testnet')).toBeTruthy()
    expect(screen.getByText('Arrived on Base Sepolia')).toBeTruthy()
    expect(screen.getByText(/Bridge failed\. Funds remain on Stellar testnet/)).toBeTruthy()
    // Missing-asset route: an unrecognized network id must still surface visibly, never an empty
    // icon (Foundation Task 4 invariant).
    expect(screen.getByText('Unknown network')).toBeTruthy()
  })

  it('renders every MoneyFigure state as truthful visible text, never a coerced 0', () => {
    renderThemed('forest')
    expect(screen.getByText(/loading/i)).toBeTruthy()
    expect(screen.getByText(/1,234.56/)).toBeTruthy()
    expect(screen.getByText(/987.65/)).toBeTruthy()
    expect(screen.getByText(/stale/i)).toBeTruthy()
    expect(screen.getByText(/no balance/i)).toBeTruthy()
    expect(screen.getByText(/could not load/i)).toBeTruthy()
    expect(screen.getAllByText(/unknown/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^0(\.\d+)? USDC$/)).toBeNull()
  })

  it('renders both VenueTruth variants with their own truthful copy', () => {
    renderThemed('forest')
    expect(screen.getByText(/Autofarm Vault supplies to Blend/)).toBeTruthy()
    expect(screen.getByText('Base Sepolia proxy. Custody only. No protocol yield.')).toBeTruthy()
  })

  it('gives both the harvest-surface and owned-surface demo buttons an accessible name', () => {
    renderThemed('forest')
    expect(screen.getByRole('button', { name: 'Confirm deposit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Revoke agent' })).toBeTruthy()
  })

  it('renders the long address as real, selectable text rather than an image', () => {
    renderThemed('forest')
    expect(screen.getByText(/^G[A-Z0-9]{55}$/)).toBeTruthy()
  })

  it('exposes the technical disclosure via native, keyboard-operable details/summary', () => {
    const { container } = renderThemed('forest')
    const details = container.querySelector('details')
    expect(details).toBeTruthy()
    expect(details.open).toBe(true)
    expect(container.querySelector('summary').textContent).toBe('Raw grant scope')
  })
})

describe('CONTRAST_REQUIREMENTS (re-asserted here per Task 7 brief Step 2)', () => {
  it.each(CONTRAST_REQUIREMENTS)('%s clears its minimum ratio', (_name, fg, bg, minRatio) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(minRatio)
  })
})
