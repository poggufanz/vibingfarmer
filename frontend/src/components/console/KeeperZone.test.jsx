// @vitest-environment jsdom
// frontend/src/components/console/KeeperZone.test.jsx
import { afterEach, describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import KeeperZone from './KeeperZone.jsx'

afterEach(cleanup)

const props = {
  nowMs: 1_000_000_000_000,
  pricePerShare: '1.0234',
  strategies: [
    { address: 'C1', label: 'Blend USDC', poolLabel: 'fixed', aprPct: 7.53 },
    { address: 'C2', label: 'Reserve', poolLabel: null, aprPct: null },
  ],
  events: [
    { kind: 'compound_executed', totalGainUsdc: '0.42', pricePerShare: '1.0234', txHash: 'abcdef1234567890', timestamp: 999_999_990_000 },
    { kind: 'compound_executed', totalGainUsdc: '0.40', pricePerShare: '1.0200', txHash: 'abcdef1234567891', timestamp: 999_999_980_000 },
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
    expect(screen.getByText(/no strategies registered/)).toBeTruthy()
  })
})
