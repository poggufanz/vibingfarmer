// frontend/src/components/strategy/__tests__/PoolSafetyPanel.test.jsx
// P0 G3 pool-safety panel: full data renders with source+freshness, partial data renders
// "Unavailable" rows, and a failed live fetch never crashes the review screen.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { PoolSafetyPanel, PoolSafetySection } from '../PoolSafetyPanel.jsx'
import { buildPoolSafetyView } from '../../../strategy/poolSafety.js'

expect.extend(axeMatchers)
afterEach(cleanup)

const AS_OF = Date.parse('2026-09-01T00:00:00Z')
const field = (value, source = 'snapshot', asOf = AS_OF) => ({ value, source, asOf })

const FULL_FACTS = {
  audit: field('audited'),
  adminKey: field('timelock_multisig'),
  oracleType: field('circuit_breaker'),
  tvl: field(127_174_055),
  collateralLiquidityDepthUsd: field(1_000_000),
  supplierConcentrationPct: field(25),
}

const fullSafety = (over = {}) =>
  buildPoolSafetyView({
    facts: FULL_FACTS,
    poolLabel: 'Blend USDC (Stellar)',
    utilization: { bps: 6532, asOf: AS_OF },
    ...over,
  })

describe('PoolSafetyPanel — full data', () => {
  it('renders every checklist row with its source and freshness date', () => {
    render(<PoolSafetyPanel safety={fullSafety()} />)
    expect(screen.getByText('Pool safety · Blend USDC (Stellar)')).toBeTruthy()
    expect(screen.getByText('$127.2M')).toBeTruthy()
    expect(screen.getByText('65.32%')).toBeTruthy()
    expect(screen.getByText('Circuit breaker')).toBeTruthy()
    expect(screen.getByText('Timelock + multisig')).toBeTruthy()
    expect(screen.getByText('Audited')).toBeTruthy()
    // Each row names its source; dated rows carry the as-of date.
    expect(screen.getAllByText(/Snapshot/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Blend pool · live RPC/)).toBeTruthy()
    expect(screen.getAllByText(/as of 2026-09-01/).length).toBeGreaterThan(0)
  })

  it('has zero axe violations for a fully-populated panel', async () => {
    const { container } = render(<PoolSafetyPanel safety={fullSafety()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('PoolSafetyPanel — partial data', () => {
  it('renders Unavailable rows (never a guessed number) when data is missing', () => {
    render(<PoolSafetyPanel safety={buildPoolSafetyView({ facts: null, utilization: null })} />)
    // 8 rows, all unavailable — including the structurally-unavailable backstop row.
    expect(screen.getAllByText('Unavailable')).toHaveLength(8)
    expect(
      screen.getByText(/No on-chain backstop read is wired yet/)
    ).toBeTruthy()
  })

  it('renders nothing when safety itself is absent', () => {
    const { container } = render(<PoolSafetyPanel safety={null} />)
    expect(container.textContent).toBe('')
  })
})

describe('PoolSafetySection — explicit live refresh', () => {
  it('mounts snapshot rows without fetching (zero I/O on mount)', () => {
    const loadSafety = vi.fn(async () => fullSafety())
    render(<PoolSafetySection loadSafety={loadSafety} />)
    expect(loadSafety).not.toHaveBeenCalled()
    expect(screen.getByText('$127.2M')).toBeTruthy()
    // Utilization starts unavailable until the explicit refresh.
    expect(screen.getByText('Pool utilization (live)')).toBeTruthy()
  })

  it('refreshes live figures on click and updates the utilization row', async () => {
    const loadSafety = vi.fn(async () => fullSafety())
    render(<PoolSafetySection loadSafety={loadSafety} />)
    fireEvent.click(screen.getByRole('button', { name: /Refresh live figures/ }))
    expect(loadSafety).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('65.32%')).toBeTruthy()
  })

  it('a failed live fetch keeps the snapshot rows — the review never crashes', async () => {
    const loadSafety = vi.fn(async () => { throw new Error('rpc down') })
    render(<PoolSafetySection loadSafety={loadSafety} />)
    fireEvent.click(screen.getByRole('button', { name: /Refresh live figures/ }))
    // Still the snapshot TVL afterwards (findByText retries through the async refresh).
    expect(await screen.findByText('$127.2M')).toBeTruthy()
    expect(screen.queryByText('65.32%')).toBeNull()
  })
})
