// frontend/src/components/money/formatUtc.test.js
// Pins the exact deterministic output (no Intl, no locale/TZ variance -- see the module header).
import { describe, it, expect } from 'vitest'
import { formatUtcMs, formatUtcSeconds } from './formatUtc.js'

describe('formatUtcMs', () => {
  it('renders a human UTC timestamp with no milliseconds and an explicit zone', () => {
    // 2027-01-15T08:15:00.000Z -- the exact shape that used to render raw.
    expect(formatUtcMs(Date.UTC(2027, 0, 15, 8, 15, 0, 116))).toBe('15 Jan 2027, 08:15 UTC')
  })

  it('pads single-digit day, hour, and minute', () => {
    expect(formatUtcMs(Date.UTC(2026, 11, 2, 1, 38, 58))).toBe('2 Dec 2026, 01:38 UTC')
  })

  it('never guesses for a missing/invalid read', () => {
    expect(formatUtcMs(null)).toBe('Unavailable')
    expect(formatUtcMs(undefined)).toBe('Unavailable')
    expect(formatUtcMs(NaN)).toBe('Unavailable')
  })
})

describe('formatUtcSeconds', () => {
  it('renders epoch seconds in the same human UTC form', () => {
    // 4102444800 = 2100-01-01T00:00:00.000Z (AgentTeam's known-expiry fixture).
    expect(formatUtcSeconds(4102444800)).toBe('1 Jan 2100, 00:00 UTC')
  })

  it('never guesses for a missing/invalid/non-positive read', () => {
    expect(formatUtcSeconds(null)).toBe('Unavailable')
    expect(formatUtcSeconds(0)).toBe('Unavailable')
    expect(formatUtcSeconds(-5)).toBe('Unavailable')
  })
})
