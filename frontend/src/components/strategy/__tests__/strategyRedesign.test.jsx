// 2026-09-28 Strategy redesign: the new visual pieces are pictures of state the surface already
// owns. These pin that they stay truthful -- the split is exact-unit arithmetic, and a station only
// lights for an event that really arrived.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CrewSplit, formatShare, shareBasisPoints } from '../CrewSplit.jsx'
import { StartStage } from '../StartStage.jsx'
import { PlanStage } from '../PlanStage.jsx'
import { StrategyProgress } from '../StrategyProgress.jsx'
import { SOROBAN_TOKEN_ADDRESS } from '../../../stellar/config.js'

afterEach(cleanup)

const amount = (units) => ({ token: SOROBAN_TOKEN_ADDRESS, units, decimals: 7 })
const PLAN = Object.freeze({
  runId: 'run-1',
  planFingerprint: '0xplan1',
  amount: amount('1000000000'),
  agents: [
    {
      allocationId: 'run-1:deposit:0',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: amount('1000000000'),
      cap: amount('1000000000'),
      periodSeconds: 3600,
      expiry: 1_800_003_600,
      destination: 'Stellar deposit',
      children: [],
    },
  ],
  truth: { agentIsolationCount: 1, stellarVenueCount: 1, baseUsesProxyVaults: false },
})
const evt = (name, data) => ({ name, data: { runId: 'run-1', ...data } })
const ALLOC = 'run-1:deposit:0'

function stations(events) {
  const { container } = render(
    <StartStage plan={PLAN} permission={{ mode: 'fresh' }} events={events} />
  )
  return [...container.querySelectorAll('.pc-lane-stations > li')].map((li) =>
    li.getAttribute('data-station')
  )
}

describe('crew split arithmetic', () => {
  it('normalizes decimals before splitting, in integer basis points', () => {
    expect(
      shareBasisPoints([
        { units: '1000000000', decimals: 7 },
        { units: '100000000', decimals: 6 },
      ])
    ).toEqual([5000, 5000])
    expect(shareBasisPoints([{ units: '0', decimals: 7 }])).toEqual([0])
    expect(formatShare(3333)).toBe('33.3%')
  })

  it('shows the invitation instead of a bar when there is nothing to split', () => {
    const { container } = render(<CrewSplit segments={[]} emptyText="Pick an amount." />)
    expect(screen.getByText('Pick an amount.')).toBeTruthy()
    expect(container.querySelector('.pc-crew-split-seg')).toBeNull()
  })
})

describe('Start lane station rail', () => {
  it('lights nothing before the first real worker event', () => {
    expect(stations([])).toEqual(['ahead', 'ahead', 'ahead', 'ahead'])
  })

  it('follows queued -> moving -> depositing -> working', () => {
    const queued = [evt('worker-queued', { allocationId: ALLOC })]
    expect(stations(queued)).toEqual(['current', 'ahead', 'ahead', 'ahead'])
    cleanup()
    const depositing = [
      ...queued,
      evt('worker-started', { allocationId: ALLOC }),
      evt('step', { allocationId: ALLOC, step: 'deposit', status: 'pending' }),
    ]
    expect(stations(depositing)).toEqual(['done', 'done', 'current', 'ahead'])
    cleanup()
    expect(stations([...depositing, evt('completed', { allocationId: ALLOC })])).toEqual([
      'done',
      'done',
      'done',
      'done',
    ])
  })

  it('marks the station that was in flight as failed, never a later one', () => {
    const events = [
      evt('worker-queued', { allocationId: ALLOC }),
      evt('worker-started', { allocationId: ALLOC }),
      evt('step', { allocationId: ALLOC, step: 'deposit', status: 'pending' }),
      evt('failed', { allocationId: ALLOC, error: 'relay FAILED' }),
    ]
    expect(stations(events)).toEqual(['done', 'done', 'failed', 'ahead'])
  })
})

describe('Plan comfort tiles and stage rail keep their accessible names', () => {
  it('names each tile by its label and describes it with the account count', () => {
    render(
      <PlanStage
        vaultTotalShares={500_0000000n}
        base={{ connected: false, healthy: null, mandateView: null, action: null }}
        onGenerate={vi.fn()}
      />
    )
    const balanced = screen.getByRole('radio', { name: 'Balanced' })
    expect(balanced.getAttribute('aria-describedby')).toBe('plan-comfort-note-med')
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '100' } })
    fireEvent.click(balanced)
    expect(document.querySelectorAll('.pc-crew-split-seg')).toHaveLength(2)
    expect(screen.getAllByText('50.0%')).toHaveLength(2)
  })

  it('keeps "N · Label" as the only accessible name of each station', () => {
    render(<StrategyProgress current="protect" reached={['plan', 'protect']} />)
    expect(screen.getByRole('button', { name: '1 · Plan' }).getAttribute('data-station')).toBe(
      'done'
    )
    expect(screen.getByRole('button', { name: '2 · Protect' }).getAttribute('data-station')).toBe(
      'current'
    )
  })
})
