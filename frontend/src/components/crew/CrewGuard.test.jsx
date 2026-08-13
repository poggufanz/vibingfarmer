// frontend/src/components/crew/CrewGuard.test.jsx
// Task 9 (Pocket Crew design alignment). ARMED-with-countdown vs. ALARM-ONLY-when-lapsed, and the
// renew action (fires + disables while pending). `mandateExpiry` is unix SECONDS (confirmed
// against myMoneyModel.js's resolveProtection: `nowS = Math.floor(now / 1000)`).
//
// Fix round 1, F3: `protection.state` now governs first (see CrewGuard.jsx's own header comment)
// -- a failed read (`state:'unavailable'`) gets a third, honestly-unknown presentation rather than
// a manufactured ARMED/ALARM claim, and `state:'disarmed'` is forced off regardless of what its
// own mandateExpiry number says.
//
// Final-review fix, F1: the renew button is gated on `protection.ownerIsAuthority === true` (the
// same gate `choosePrimaryMoneyAction` already applies to the identical action, myMoneyModel.js:
// 337-343) -- every other visitor sees the honest alternative line instead of a button that would
// prompt a doomed wallet signature. Every fixture below that needs the button now says so
// explicitly via `ownerIsAuthority: true`.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CrewGuard } from './CrewGuard.jsx'

afterEach(cleanup)

const FIXTURE_NOW_MS = Date.parse('2026-08-11T00:00:00.000Z')

describe('CrewGuard', () => {
  // The expiry below and the clock CrewGuard reads at render time have to be the SAME instant, or
  // this asserts on a moving target: it used to build the expiry from a live `Date.now()` and match
  // /^01:01:0\d$/, which tolerated only ten seconds of drift between the two reads -- enough on an
  // idle machine, not enough on a loaded runner (observed failing mid-suite locally). Frozen, the
  // remaining time is exactly 3661s and the expected string is exact.
  it('shows ARMED with a countdown while the mandate is live', () => {
    const { container } = render(
      <CrewGuard
        protection={{ state: 'armed', mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) + 3661 }}
        onRenew={vi.fn()}
        pending={false}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(screen.getByText('ARMED')).toBeTruthy()
    expect(screen.getByText('01:01:01')).toBeTruthy()
    expect(container.querySelector('.pc-crew-radar-sweep--active')).toBeTruthy()
  })

  it('shows ALARM ONLY when the mandate has lapsed', () => {
    render(
      <CrewGuard
        protection={{ state: 'armed', mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) - 10 }}
        onRenew={vi.fn()}
        pending={false}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(screen.getByText('ALARM ONLY')).toBeTruthy()
    expect(screen.getByText('00:00:00')).toBeTruthy()
  })

  it('renew button fires and disables while pending, for the vault authority', () => {
    const onRenew = vi.fn()
    const { rerender } = render(
      <CrewGuard
        protection={{
          state: 'armed',
          mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) + 3600,
          ownerIsAuthority: true,
        }}
        onRenew={onRenew}
        pending={false}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /renew/i }))
    expect(onRenew).toHaveBeenCalled()
    rerender(
      <CrewGuard
        protection={{
          state: 'armed',
          mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) + 3600,
          ownerIsAuthority: true,
        }}
        onRenew={onRenew}
        pending
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(screen.getByRole('button', { name: /renew/i }).disabled).toBe(true)
  })

  it.each([
    { mandateExpiry: null, label: 'missing' },
    { mandateExpiry: 'not-a-number', label: 'non-numeric' },
    { mandateExpiry: NaN, label: 'non-finite' },
  ])(
    'shows unknown and no renewal for an armed mandate with $label expiry',
    ({ mandateExpiry }) => {
      render(
        <CrewGuard
          protection={{ state: 'armed', mandateExpiry, ownerIsAuthority: true }}
          onRenew={vi.fn()}
          pending={false}
          nowMs={FIXTURE_NOW_MS}
        />
      )
      expect(screen.getByText('STATUS UNKNOWN')).toBeTruthy()
      expect(screen.getByText('Unavailable')).toBeTruthy()
      expect(screen.queryByText('ALARM ONLY')).toBeNull()
      expect(screen.queryByRole('button', { name: /renew/i })).toBeNull()
    }
  )

  it("hides the renew button for a visitor who is not the vault's configured authority, and shows the honest alternative line instead (F1: was rendered unconditionally, prompting a doomed wallet signature)", () => {
    render(
      <CrewGuard
        protection={{ state: 'armed', mandateExpiry: 0, ownerIsAuthority: false }}
        onRenew={vi.fn()}
        pending={false}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(screen.queryByRole('button', { name: /renew/i })).toBeNull()
    expect(screen.getByText(/only the configured authority can renew this/i)).toBeTruthy()
  })

  it('also hides the renew button when authority is simply unknown (no protection read, or a read that never says ownerIsAuthority true)', () => {
    render(<CrewGuard protection={null} onRenew={vi.fn()} pending={false} nowMs={FIXTURE_NOW_MS} />)
    expect(screen.queryByRole('button', { name: /renew/i })).toBeNull()
    expect(screen.getByText(/only the configured authority can renew this/i)).toBeTruthy()
  })

  it('shows a third, honestly-unknown state when protection could not be read at all — never ARMED, never the manufactured ALARM ONLY claim', () => {
    render(
      <CrewGuard
        protection={{ state: 'unavailable', mandateExpiry: null }}
        onRenew={vi.fn()}
        pending={false}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(screen.getByText('STATUS UNKNOWN')).toBeTruthy()
    expect(screen.queryByText('ARMED')).toBeNull()
    expect(screen.queryByText('ALARM ONLY')).toBeNull()
  })

  it('a disarmed mandate never reads as ARMED, even with a future mandateExpiry still on record', () => {
    render(
      <CrewGuard
        protection={{ state: 'disarmed', mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) + 3600 }}
        onRenew={vi.fn()}
        pending={false}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(screen.queryByText('ARMED')).toBeNull()
    expect(screen.getByText('ALARM ONLY')).toBeTruthy()
  })

  it('keeps a confirmed engaged or stale guard out of ARMED and shows a static watch frame', () => {
    const { container, rerender } = render(
      <CrewGuard
        protection={{
          state: 'engaged',
          mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) + 3600,
          ownerIsAuthority: true,
        }}
        onRenew={vi.fn()}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(container.querySelector('[data-guard-phase="armed"]')).toBeNull()
    expect(screen.getByText('ALARM ONLY')).toBeTruthy()
    expect(container.querySelector('.pc-crew-radar-sweep--active')).toBeNull()

    rerender(
      <CrewGuard
        protection={{
          state: 'stale',
          mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) + 3600,
          ownerIsAuthority: true,
        }}
        onRenew={vi.fn()}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(screen.getByText('STATUS UNKNOWN')).toBeTruthy()
    expect(container.querySelector('.pc-crew-radar-sweep--active')).toBeNull()
  })

  it('renders the same static radar geometry under reduced motion', () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    try {
      const { container } = render(
        <CrewGuard
          protection={{
            state: 'armed',
            mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) + 3600,
            ownerIsAuthority: true,
          }}
          onRenew={vi.fn()}
          nowMs={FIXTURE_NOW_MS}
        />
      )
      expect(screen.getByText('ARMED')).toBeTruthy()
      expect(screen.getByText('01:00:00')).toBeTruthy()
      expect(container.querySelector('.pc-crew-radar-sweep--active')).toBeNull()
      expect(container.querySelectorAll('.pc-crew-radar-ring')).toHaveLength(2)
      expect(container.querySelector('.pc-crew-radar-core')).toBeTruthy()
      expect(screen.getByRole('button', { name: /renew/i })).toBeTruthy()
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})
