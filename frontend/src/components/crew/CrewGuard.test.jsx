// frontend/src/components/crew/CrewGuard.test.jsx
// Task 9 (Pocket Crew design alignment). ARMED-with-countdown vs. ALARM-ONLY-when-lapsed, and the
// renew action (fires + disables while pending). `mandateExpiry` is unix SECONDS (confirmed
// against myMoneyModel.js's resolveProtection: `nowS = Math.floor(now / 1000)`).
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
})
