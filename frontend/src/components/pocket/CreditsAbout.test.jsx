// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { NETWORK_CREDITS } from '../../design/networks.js'
import { CreditsAbout } from './CreditsAbout.jsx'

expect.extend(axeMatchers)

afterEach(cleanup)

describe('CreditsAbout', () => {
  it('renders exactly one labelled region', () => {
    render(<CreditsAbout />)
    expect(screen.getAllByRole('region')).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Network credits' })).toBeTruthy()
  })

  it('shows both visible network names and their (decorative) marks', () => {
    const { container } = render(<CreditsAbout />)
    expect(screen.getByText('Stellar testnet')).toBeTruthy()
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
    const marks = Array.from(container.querySelectorAll('img.network-mark'))
    expect(marks).toHaveLength(2)
    expect(marks.every((img) => img.getAttribute('alt') === '')).toBe(true)
  })

  it('reads trademark text straight from the NETWORK_CREDITS manifest, not a hand-copied string', () => {
    render(<CreditsAbout />)
    for (const net of NETWORK_CREDITS) {
      expect(screen.getByText(net.trademarkNotice)).toBeTruthy()
    }
  })

  it('links to each network’s official source URL and says it opens in a new tab', () => {
    render(<CreditsAbout />)
    for (const net of NETWORK_CREDITS) {
      const link = screen.getByRole('link', {
        name: new RegExp(`${net.label}.*opens in a new tab`),
      })
      expect(link.getAttribute('href')).toBe(net.sourceUrl)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
    }
  })

  it('renders exactly one plain-English independence statement naming both networks', () => {
    render(<CreditsAbout />)
    expect(
      screen.getByText(
        'Vibing Farmer is not sponsored by or affiliated with Stellar Development Foundation or Base.'
      )
    ).toBeTruthy()
  })

  it('has zero axe violations', async () => {
    const { container } = render(<CreditsAbout />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
