// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import OpsConsole from './OpsConsole.jsx'

vi.mock('../../agents.jsx', () => ({
  AgentGraph: () => <div data-testid="agent-graph" />,
  DecisionLogPanel: () => <div data-testid="decision-log" />,
}))
vi.mock('../WithdrawModal.jsx', () => ({ default: () => <div /> }))

afterEach(cleanup)

const VAULT = 'CB5VKYDUABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDJDYU'
const NOW = Date.now()
const props = {
  positions: {
    [VAULT]: { balance: 500_000_000, unclaimedRewards: 1_000_000, vaultName: 'Autofarm USDC' },
  },
  vaultMeta: { [VAULT.toLowerCase()]: { apy: 8.2, protocol: 'blend-autofarm' } },
  lastUpdated: NOW,
  userAddress: 'GUSER',
  withdrawEnabled: true,
  onWithdrawSuccess: () => {},
  onNewStrategy: () => {},
  monitorStatus: { level: 'skip', reason: 'no drift', lastCheck: NOW },
  loop: {
    running: true,
    phase: 'sleep',
    cycle: 7,
    nextTickAt: NOW + 23_000,
    heartbeatMs: 600_000,
    rows: [{ cycle: 7, verdict: 'keep', reason: '', ts: NOW }],
    summary: { total: 1, keep: 1, discard: 0, gated: 0, crash: 0, idle: 0, lastCycle: 7 },
    decisionsRows: [],
    decisionsSummary: { byAgent: {} },
  },
  keeper: {
    events: [],
    pricePerShare: '1.0234',
    strategies: [{ address: 'C1', label: 'Blend USDC', poolLabel: 'fixed', aprPct: 7.5 }],
  },
  lifeboat: {
    state: { derisked: false, mandateExpiry: Math.floor(NOW / 1000) + 43_200, authority: 'GKEEP' },
    events: [],
    busy: false,
    onGrant: () => {},
  },
  scopes: [
    {
      agent: 'CAGENT1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAB12',
      capPerPeriod: 400_000_000,
      maxAtRisk: 200_000_000,
      revoked: false,
    },
  ],
  onRevoke: () => {},
  graph: { data: { nodes: [{ id: 'k' }], links: [] }, paletteIsLight: false, pulseEdge: null },
}

describe('OpsConsole', () => {
  it('renders all eight zones in the grid', () => {
    const { container } = render(<OpsConsole {...props} />)
    for (const area of [
      'strip',
      'swarm',
      'council',
      'positions',
      'keeper',
      'monitor',
      'lifeboat',
      'mandate',
    ]) {
      expect(container.querySelector(`.console-${area}`), area).toBeTruthy()
    }
    expect(container.querySelector('.console')).toBeTruthy()
  })
  it('derives portfolio totals into the strip', () => {
    // Scoped to .console-strip: the single-vault fixture makes the portfolio
    // total equal the one position's own balance, so the same "50.00" text
    // also legitimately appears in PositionsZone — a plain screen.getByText
    // would match both. Scoping asserts what the test name says: the total
    // lands in the strip.
    const { container } = render(<OpsConsole {...props} />)
    const strip = container.querySelector('.console-strip')
    expect(within(strip).getByText('50.00')).toBeTruthy()
  })
  it('loop null renders monitor as stopped without crashing', () => {
    render(<OpsConsole {...props} loop={null} />)
    expect(screen.getByText('Loop stopped')).toBeTruthy()
  })
})
