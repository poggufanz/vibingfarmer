// @vitest-environment jsdom
// frontend/src/components/console/KeeperZone.test.jsx
import { afterEach, describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import KeeperZone from '../KeeperZone.jsx'
import { trailingApyPct } from '../../../history/ppsHistory.js'

afterEach(cleanup)

const props = {
  nowMs: 1_000_000_000_000,
  pricePerShare: '1.0234',
  strategies: [
    { address: 'C1', label: 'Blend USDC', poolLabel: 'fixed', aprPct: 7.53 },
    { address: 'C2', label: 'Reserve', poolLabel: null, aprPct: null },
  ],
  events: [
    {
      kind: 'compound_executed',
      totalGainUsdc: '0.42',
      pricePerShare: '1.0234',
      txHash: 'abcdef1234567890',
      timestamp: 999_999_990_000,
    },
    {
      kind: 'compound_executed',
      totalGainUsdc: '0.40',
      pricePerShare: '1.0200',
      txHash: 'abcdef1234567891',
      timestamp: 999_999_980_000,
    },
  ],
}

describe('KeeperZone', () => {
  it('autopilot engaged with dial apr and pps delta', () => {
    render(<KeeperZone {...props} />)
    expect(screen.getByText(/autopilot engaged/i)).toBeTruthy()
    expect(screen.getByText('7.53%')).toBeTruthy()
    expect(screen.getByText('1.0234')).toBeTruthy()
    expect(screen.getByText(/\+0.0034/)).toBeTruthy()
  })
  it('renders strategy rows', () => {
    render(<KeeperZone {...props} />)
    expect(screen.getByText('Blend USDC')).toBeTruthy()
    expect(screen.getAllByText(/--/).length).toBeGreaterThan(0)
  })
  it('idle when nothing registered', () => {
    render(<KeeperZone {...props} strategies={[]} pricePerShare={null} events={[]} />)
    expect(screen.getByText('No strategies registered.')).toBeTruthy()
  })
})
describe('KeeperZone live Blend APY + PPS sparkline (P0 #2)', () => {
  const NOW = 1_000_000_000_000
  const DAY_MS = 24 * 60 * 60 * 1000

  it('shows the live supply APY with data freshness, snapshot dial untouched', () => {
    render(
      <KeeperZone
        {...props}
        nowMs={NOW}
        liveApr={{ state: 'live', aprPct: 4.16, asOf: NOW - 45_000 }}
      />
    )
    expect(screen.getByText('Live supply APY 4.16%')).toBeTruthy()
    expect(screen.getByText(/updated 45s ago/)).toBeTruthy()
    expect(screen.getByText('7.53%')).toBeTruthy() // catalog snapshot dial unchanged
  })

  it('fails soft to unavailable when the reserve read fails — never a fake number', () => {
    render(
      <KeeperZone
        {...props}
        nowMs={NOW}
        liveApr={{ state: 'unavailable', aprPct: null, asOf: null }}
      />
    )
    expect(screen.getByText('Live APY unavailable')).toBeTruthy()
    expect(screen.queryByText(/Live supply APY/)).toBeNull()
  })

  it('renders the 30-day sparkline with 7/30-day trailing APY from the PPS series', () => {
    const ppsHistory = [
      { t: NOW - 20 * DAY_MS, pps: '10000000' },
      { t: NOW - 5 * DAY_MS, pps: '10050000' },
      { t: NOW, pps: '10100000' },
    ]
    const { container } = render(<KeeperZone {...props} nowMs={NOW} ppsHistory={ppsHistory} />)
    const svg = container.querySelector('.keeper-pps-history svg')
    expect(svg?.getAttribute('aria-label')).toMatch(/3 samples/)
    const expected7 = trailingApyPct(ppsHistory, { days: 7, now: NOW })
    const expected30 = trailingApyPct(ppsHistory, { days: 30, now: NOW })
    expect(expected7).not.toBeNull()
    expect(expected30).not.toBeNull()
    expect(
      screen.getByText(`Trailing APY — 7d: ${expected7.toFixed(2)}%, 30d: ${expected30.toFixed(2)}%`)
    ).toBeTruthy()
  })

  it('reports trailing APY unavailable on an empty series, sparkline stays a flat baseline', () => {
    const { container } = render(<KeeperZone {...props} nowMs={NOW} ppsHistory={[]} />)
    expect(screen.getByText('Trailing APY — 7d: unavailable, 30d: unavailable')).toBeTruthy()
    const svg = container.querySelector('.keeper-pps-history svg')
    expect(svg?.getAttribute('aria-label')).toMatch(/no history yet/)
  })
})
