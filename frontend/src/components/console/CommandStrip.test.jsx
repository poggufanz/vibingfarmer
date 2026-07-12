// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CommandStrip from './CommandStrip.jsx'

const base = {
  running: true,
  cycling: false,
  phase: 'sleep',
  cycle: 7,
  totalDisplay: '120.00',
  earnedDisplay: '0.4200',
  blendedApy: 8.2,
  lifeboatMode: 'ARMED',
  mandateState: { mandateExpiry: 2_000_000, derisked: false, authority: 'G' },
  scopesCount: 3,
  nowS: 2_000_000 - 43_200,
}

describe('CommandStrip', () => {
  it('shows state, portfolio figure and chips', () => {
    render(<CommandStrip {...base} />)
    expect(screen.getByText(/Monitoring · cycle 07/)).toBeTruthy()
    expect(screen.getByText('120.00')).toBeTruthy()
    expect(screen.getByText(/mandate 12h 0m/)).toBeTruthy()
    expect(screen.getByText('lifeboat ARMED')).toBeTruthy()
    expect(screen.getByText('3 scopes')).toBeTruthy()
  })
  it('stopped state mutes the led and label', () => {
    render(<CommandStrip {...base} running={false} />)
    expect(screen.getByText('Stopped')).toBeTruthy()
  })
  it('emergency flips the lifeboat chip to danger', () => {
    render(<CommandStrip {...base} lifeboatMode="ENGAGED" />)
    expect(screen.getByText('lifeboat ENGAGED').dataset.tone).toBe('danger')
  })
})
