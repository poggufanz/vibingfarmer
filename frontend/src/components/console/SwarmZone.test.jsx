// @vitest-environment jsdom
// frontend/src/components/console/SwarmZone.test.jsx
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import SwarmZone from './SwarmZone.jsx'

vi.mock('../../agents.jsx', () => ({
  AgentGraph: () => <div data-testid="agent-graph" />,
}))

afterEach(cleanup)

const props = {
  graphData: {
    nodes: [{ id: 'keeper' }, { id: 'strategy' }],
    links: [{ source: 'keeper', target: 'strategy' }],
  },
  paletteIsLight: false,
  pulseEdge: null,
  nowMs: 1_000_000_000_000,
  traceEvents: [
    { label: 'compounded · +0.42 USDC', tone: 'ok', timestamp: 999_999_990_000 },
    { label: 'mandate updated', tone: 'info', timestamp: 999_999_980_000 },
  ],
}

describe('SwarmZone', () => {
  it('renders the graph hero with honest counters', () => {
    render(<SwarmZone {...props} />)
    expect(screen.getByTestId('agent-graph')).toBeTruthy()
    expect(screen.getByText(/2 nodes · 1 links/)).toBeTruthy()
  })
  it('trace strip: one tick per event + dual-coded last event', () => {
    const { container } = render(<SwarmZone {...props} />)
    expect(container.querySelectorAll('.trace-tick')).toHaveLength(2)
    expect(screen.getByText(/last · compounded · \+0.42 USDC/)).toBeTruthy()
  })
  it('empty graph shows deploy hint', () => {
    render(<SwarmZone {...props} graphData={{ nodes: [], links: [] }} traceEvents={[]} />)
    expect(screen.getByText(/no active agents — grant deploys the swarm/)).toBeTruthy()
  })
})
