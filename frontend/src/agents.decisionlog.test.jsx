// @vitest-environment jsdom
// DecisionLogPanel pagination — rendered against the real agents.jsx export
// (only the canvas-bound force graph dependency is stubbed).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('react-force-graph-2d', () => ({ default: () => null }))

import { DecisionLogPanel } from './agents.jsx'

afterEach(cleanup)

const makeRow = (i) => ({
  id: `c${i}-${i}000`,
  ts: 1_000_000_000_000 + i * 1000,
  cycle: i,
  finalDecision: i % 3 === 0 ? 'discard' : 'keep',
  majoritySignal: 'DEPOSIT',
  majorityCount: 2,
  avgConfidence: 0.8,
  resolvedBy: 'majority',
  verdicts: [],
})

describe('DecisionLogPanel', () => {
  it('shows every decision row and toggles its details', () => {
    const rows = Array.from({ length: 7 }, (_, i) => makeRow(i + 1))
    const { container } = render(<DecisionLogPanel rows={rows} summary={{ byAgent: {} }} />)
    expect(container.querySelectorAll('.decision-row')).toHaveLength(7)

    const first = container.querySelector('.decision-row-head')
    fireEvent.click(first)
    expect(first.closest('.decision-row').classList.contains('open')).toBe(true)
    expect(container.querySelector('.decision-verdicts')).toBeTruthy()

    fireEvent.click(first)
    expect(first.closest('.decision-row').classList.contains('open')).toBe(false)
    expect(container.querySelector('.decision-verdicts')).toBeNull()
  })
  it('renders a short decision log without pagination controls', () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(i + 1))
    const { container } = render(<DecisionLogPanel rows={rows} summary={null} />)
    expect(container.querySelectorAll('.decision-row')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /next page/i })).toBeNull()
  })
})
