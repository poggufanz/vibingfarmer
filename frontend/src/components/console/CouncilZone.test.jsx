// @vitest-environment jsdom
// frontend/src/components/console/CouncilZone.test.jsx
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import CouncilZone from './CouncilZone.jsx'

vi.mock('../../agents.jsx', () => ({
  DecisionLogPanel: () => <div data-testid="decision-log" />,
}))

afterEach(cleanup)

const row = {
  id: 'd1',
  cycle: 7,
  finalDecision: 'keep',
  majoritySignal: 'DEPOSIT',
  majorityCount: 2,
  avgConfidence: 0.81,
  resolvedBy: 'majority',
  ts: 999_000,
  verdicts: [
    { role: 'yield', signal: 'DEPOSIT', confidence: 0.9, summary: 'apr healthy' },
    { role: 'risk', signal: 'HOLD', confidence: 0.7, summary: 'tvl flat' },
    { role: 'market', signal: 'DEPOSIT', confidence: 0.83, summary: 'stable' },
  ],
}
const props = {
  monitorStatus: { level: 'skip', reason: 'no drift', lastCheck: 999_000 },
  decisionsRows: [row],
  decisionsSummary: { byAgent: { yield: { DEPOSIT: 3, HOLD: 1, WITHDRAW: 0 } } },
  nowMs: 1_000_000,
}

describe('CouncilZone', () => {
  it('renders three jury seats with stance and confidence', () => {
    render(<CouncilZone {...props} />)
    expect(screen.getByText('yield')).toBeTruthy()
    expect(screen.getByText('90%')).toBeTruthy()
    expect(screen.getAllByText(/deposit|hold/)).toBeTruthy()
  })
  it('stamps the latest verdict', () => {
    render(<CouncilZone {...props} />)
    expect(screen.getByText('KEEP')).toBeTruthy()
    expect(screen.getByText(/DEPOSIT ×2/)).toBeTruthy()
  })
  it('opens the full decision log modal', () => {
    render(<CouncilZone {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /full decision log/i }))
    expect(screen.getByTestId('decision-log')).toBeTruthy()
  })
  it('empty state when no verdicts yet', () => {
    render(<CouncilZone {...props} decisionsRows={[]} />)
    expect(screen.getByText(/council idle/)).toBeTruthy()
  })
})
