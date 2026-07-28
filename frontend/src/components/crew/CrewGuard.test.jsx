// frontend/src/components/crew/CrewGuard.test.jsx
// Task 9 (Pocket Crew design alignment). ARMED-with-countdown vs. ALARM-ONLY-when-lapsed, and the
// renew action (fires + disables while pending). `mandateExpiry` is unix SECONDS (confirmed
// against myMoneyModel.js's resolveProtection: `nowS = Math.floor(now / 1000)`).
//
// Fix round 1, F3: `protection.state` now governs first (see CrewGuard.jsx's own header comment)
// -- a failed read (`state:'unavailable'`) gets a third, honestly-unknown presentation rather than
// a manufactured ARMED/ALARM claim, and `state:'disarmed'` is forced off regardless of what its
// own mandateExpiry number says.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CrewGuard } from './CrewGuard.jsx'

afterEach(cleanup)

describe('CrewGuard', () => {
  it('shows ARMED with a countdown while the mandate is live', () => {
    render(
      <CrewGuard
        protection={{ state: 'armed', mandateExpiry: Math.floor(Date.now() / 1000) + 3661 }}
        onRenew={vi.fn()}
        pending={false}
      />
    )
    expect(screen.getByText('ARMED')).toBeTruthy()
    expect(screen.getByText(/^01:01:0\d$/)).toBeTruthy()
  })

  it('shows ALARM ONLY when the mandate has lapsed', () => {
    render(
      <CrewGuard
        protection={{ state: 'armed', mandateExpiry: Math.floor(Date.now() / 1000) - 10 }}
        onRenew={vi.fn()}
        pending={false}
      />
    )
    expect(screen.getByText('ALARM ONLY')).toBeTruthy()
    expect(screen.getByText('00:00:00')).toBeTruthy()
  })

  it('renew button fires and disables while pending', () => {
    const onRenew = vi.fn()
    const { rerender } = render(
      <CrewGuard
        protection={{ state: 'armed', mandateExpiry: 0 }}
        onRenew={onRenew}
        pending={false}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /renew/i }))
    expect(onRenew).toHaveBeenCalled()
    rerender(
      <CrewGuard protection={{ state: 'armed', mandateExpiry: 0 }} onRenew={onRenew} pending />
    )
    expect(screen.getByRole('button', { name: /renew/i }).disabled).toBe(true)
  })

  it('shows a third, honestly-unknown state when protection could not be read at all — never ARMED, never the manufactured ALARM ONLY claim', () => {
    render(
      <CrewGuard
        protection={{ state: 'unavailable', mandateExpiry: null }}
        onRenew={vi.fn()}
        pending={false}
      />
    )
    expect(screen.getByText('STATUS UNKNOWN')).toBeTruthy()
    expect(screen.queryByText('ARMED')).toBeNull()
    expect(screen.queryByText('ALARM ONLY')).toBeNull()
  })

  it('a disarmed mandate never reads as ARMED, even with a future mandateExpiry still on record', () => {
    render(
      <CrewGuard
        protection={{ state: 'disarmed', mandateExpiry: Math.floor(Date.now() / 1000) + 3600 }}
        onRenew={vi.fn()}
        pending={false}
      />
    )
    expect(screen.queryByText('ARMED')).toBeNull()
    expect(screen.getByText('ALARM ONLY')).toBeTruthy()
  })
})
