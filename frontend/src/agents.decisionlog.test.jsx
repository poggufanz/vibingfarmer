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

describe('DecisionLogPanel pagination', () => {
  it('shows 5 rows per page and navigates', () => {
    const rows = Array.from({ length: 7 }, (_, i) => makeRow(i + 1))
    const { container } = render(<DecisionLogPanel rows={rows} summary={{ byAgent: {} }} />)
    expect(container.querySelectorAll('.decision-row')).toHaveLength(5)
    expect(screen.getByText('1 / 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /next page/i }))
    expect(container.querySelectorAll('.decision-row')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /next page/i }).disabled).toBe(true)
  })
  it('no pager when rows fit on one page', () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(i + 1))
    render(<DecisionLogPanel rows={rows} summary={null} />)
    expect(screen.queryByRole('button', { name: /next page/i })).toBeNull()
  })
})
