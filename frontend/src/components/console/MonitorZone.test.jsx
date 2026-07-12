// @vitest-environment jsdom
// frontend/src/components/console/MonitorZone.test.jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import MonitorZone from './MonitorZone.jsx'

beforeEach(() => vi.useFakeTimers({ now: 1_000_000_000_000 }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const rows = [
  { cycle: 3, verdict: 'keep', reason: '', ts: 999_999_990_000 },
  { cycle: 2, verdict: 'keep', reason: '', ts: 999_999_980_000 },
  { cycle: 1, verdict: 'discard', reason: '', ts: 999_999_970_000 },
]
const props = {
  running: true,
  rows,
  summary: { total: 3, keep: 2, discard: 1, gated: 0, crash: 0, idle: 0, lastCycle: 3 },
  phase: 'sleep',
  nextTickAt: 1_000_000_023_000,
  heartbeatMs: 600_000,
}

describe('MonitorZone', () => {
  it('shows vitals: cycles, consecutive ok, interval, countdown', () => {
    render(<MonitorZone {...props} />)
    expect(screen.getByText('3')).toBeTruthy() // cycles total
    expect(screen.getByText('2')).toBeTruthy() // consecutive ok
    expect(screen.getByText('Next check in 23s')).toBeTruthy()
    expect(screen.getByText('Observe only')).toBeTruthy()
  })
  it('stopped renders flat state', () => {
    render(<MonitorZone {...props} running={false} />)
    expect(screen.getByText('Loop stopped')).toBeTruthy()
  })
})
