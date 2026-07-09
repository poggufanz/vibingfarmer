// @vitest-environment jsdom
// LifeboatPanel — vf-lifeboat Task 8. Presentational: all data arrives via props (readLifeboatState
// poll + lifeboat event feed from app.jsx). Mirrors the render/assert shape of KeeperPanel.test.jsx.
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import LifeboatPanel from './LifeboatPanel.jsx'

afterEach(cleanup)

const armedState = {
  derisked: false,
  mandateExpiry: Math.floor(Date.now() / 1000) + 7200,
  authority: 'GAUTH',
}

describe('LifeboatPanel', () => {
  it('renders ARMED with a countdown when the mandate is live', () => {
    render(<LifeboatPanel state={armedState} events={[]} owner="GOWNER" onGrant={() => {}} />)
    expect(screen.getByText(/ARMED/)).toBeTruthy()
    expect(screen.getByText(/1h 59m|2h 0m/)).toBeTruthy()
  })
  it('renders ENGAGED when derisked', () => {
    render(
      <LifeboatPanel
        state={{ ...armedState, derisked: true }}
        events={[]}
        owner="GOWNER"
        onGrant={() => {}}
      />
    )
    expect(screen.getByText(/ENGAGED/)).toBeTruthy()
  })
  it('renders DISARMED loudly when the mandate is expired', () => {
    render(
      <LifeboatPanel
        state={{ ...armedState, mandateExpiry: 1 }}
        events={[]}
        owner="GOWNER"
        onGrant={() => {}}
      />
    )
    expect(screen.getByText(/DISARMED/)).toBeTruthy()
    expect(screen.getByText(/cannot act/)).toBeTruthy()
  })
  it('renders "--" when the state read failed (null), never a guess', () => {
    render(<LifeboatPanel state={null} events={[]} owner="GOWNER" onGrant={() => {}} />)
    expect(screen.getByText('--')).toBeTruthy()
  })
  it('grant button calls onGrant and disables without an owner', () => {
    const onGrant = vi.fn()
    const { rerender } = render(
      <LifeboatPanel state={armedState} events={[]} owner="GOWNER" onGrant={onGrant} />
    )
    fireEvent.click(screen.getByRole('button', { name: /renew 24h mandate/i }))
    expect(onGrant).toHaveBeenCalled()
    rerender(<LifeboatPanel state={armedState} events={[]} owner={null} onGrant={onGrant} />)
    expect(screen.getByRole('button', { name: /renew 24h mandate/i }).disabled).toBe(true)
  })
  it('renders a derisk event row with the shared reason label', () => {
    const events = [
      {
        type: 'derisk',
        reasonCode: 2,
        drainedTotal: 800_0000000n,
        txHash: 'abc123def456',
        timestamp: Date.now(),
      },
    ]
    render(<LifeboatPanel state={armedState} events={events} owner="GOWNER" onGrant={() => {}} />)
    expect(screen.getByText(/Liquidity drop/)).toBeTruthy()
  })
})
