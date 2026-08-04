// frontend/src/components/crew/CrewRoute.test.jsx
// Task 9 (Pocket Crew design alignment). CrewRoute composition test -- route heading, stat strip
// sourced from real model fields, per-agent cancel wiring, revoked-agent dimming, empty-state CTA,
// and the decision log. Accessibility sweep mirrors MyMoneyRoute.a11y.test.jsx's own axe pattern.
//
// Fix round 1, F5: closes the coverage gaps the review named -- the "Total working" stat (and its
// honest '—' fallback), the keeper feed (both event kinds + the empty line), the keeper.label ->
// Status mapping (all three branches), decision `tone` -> `data-tone` (including 'rejected'), the
// per-lane amount path (known + null->Unavailable), `data-revoked`, and an exact lane COUNT (the
// old `getAllByRole('listitem').length > 0` was satisfied by the decision list alone). Fix round 1,
// F4: only a fresh authoritative empty model or a fresh current model with known-zero productive
// custody may show the confident "no successful crew" claim; incomplete reads stay uncertain.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { CrewRoute } from './CrewRoute.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const AGENT = 'C' + 'A'.repeat(55)
const agentRow = (over = {}) => ({
  address: AGENT,
  scope: { state: 'known', value: { vault: 'CVAULT', revoked: false, expiry: 0 } },
  amount: { token: 'USDC', units: '2500000000', decimals: 7 },
  executionStatus: 'idle',
  custody: { location: 'stellar-vault' },
  problems: [],
  ...over,
})
const model = {
  state: 'current',
  confirmedTotal: { state: 'known', amount: { token: 'USDC', units: '2500000000', decimals: 7 } },
  custodyBreakdown: { 'stellar-vault': '2500000000' },
  yield: { state: 'live', apy: 8.1 },
  protection: {
    state: 'armed',
    authority: 'G'.repeat(56),
    mandateExpiry: Math.floor(Date.now() / 1000) + 3600,
  },
}
const keeper = { label: 'healthy', lastHeartbeatAt: Date.now() - 30_000, evidence: {} }

const renderCrew = (over = {}) =>
  render(
    <CrewRoute
      agents={[agentRow()]}
      model={model}
      keeper={keeper}
      keeperEvents={[]}
      decisions={[
        { id: 1, tone: 'kept', title: 'Council proposal', detail: 'hold', time: '12:00' },
      ]}
      onRenewMandate={vi.fn()}
      onCancelAgent={vi.fn()}
      onStartStrategy={vi.fn()}
      {...over}
    />
  )

describe('CrewRoute', () => {
  it('shows only successfully working agents from a mixed three-agent execution', () => {
    const STELLAR_SUCCESS = 'C' + 'S'.repeat(55)
    const FAILED_AT_AGENT = 'C' + 'F'.repeat(55)
    const BASE_SUCCESS = 'C' + 'B'.repeat(55)
    const { container } = renderCrew({
      model: {
        ...model,
        confirmedTotal: {
          state: 'known',
          amount: { token: 'USDC', units: '7500000000', decimals: 7 },
        },
        custodyBreakdown: {
          'stellar-vault': '2500000000',
          'base-proxy': '2500000000',
          agent: '2500000000',
        },
      },
      agents: [
        agentRow({ address: STELLAR_SUCCESS }),
        agentRow({
          address: FAILED_AT_AGENT,
          executionStatus: 'failed',
          custody: { location: 'agent' },
          problems: [],
        }),
        agentRow({
          address: BASE_SUCCESS,
          executionStatus: 'succeeded',
          custody: { location: 'unknown' },
          custodyBreakdown: [
            {
              location: 'base-proxy',
              amount: { token: 'USDC', units: '2500000000', decimals: 7 },
            },
          ],
        }),
      ],
    })

    const lanes = [...container.querySelectorAll('.pc-crew-lane')]
    expect(lanes).toHaveLength(2)
    expect(lanes.map((lane) => lane.querySelector('.pc-crew-lane-address').textContent)).toEqual([
      'CSSS…SSSS',
      'CBBB…BBBB',
    ])
    expect(screen.getByText('Active permissions').nextElementSibling.textContent).toBe('2 of 2')
    expect(screen.getByText('Total working').nextElementSibling.textContent).toBe('500 USDC')
  })

  it('shows a truthful empty state when all three deployed agents failed', () => {
    const failedAgent = (suffix) =>
      agentRow({
        address: 'C' + suffix.repeat(55),
        amount: { token: 'USDC', units: '0', decimals: 7 },
        executionStatus: 'failed',
        custody: { location: 'agent' },
        problems: [],
      })
    const { container } = renderCrew({
      agents: [failedAgent('F'), failedAgent('G'), failedAgent('H')],
      model: {
        ...model,
        state: 'empty',
        agentCount: 3,
        confirmedTotal: {
          state: 'known',
          amount: { token: 'USDC', units: '0', decimals: 7 },
        },
      },
    })

    expect(container.querySelector('.pc-crew-lane')).toBeNull()
    expect(screen.getByText(/no successful crew members are working yet/i)).toBeTruthy()
    expect(screen.queryByText(/no crew members are deployed yet/i)).toBeNull()
  })

  it('confidently reports no successful crew after a fresh complete read finds only stranded funds', () => {
    const { container } = renderCrew({
      agents: [
        agentRow({
          amount: { token: 'USDC', units: '2500000000', decimals: 7 },
          executionStatus: 'failed',
          custody: { location: 'agent' },
        }),
      ],
      model: {
        ...model,
        state: 'current',
        custodyBreakdown: { agent: '2500000000' },
      },
    })

    expect(container.querySelector('.pc-crew-lane')).toBeNull()
    expect(screen.getByText(/no successful crew members are working yet/i)).toBeTruthy()
    expect(screen.queryByText(/could not confirm your crew/i)).toBeNull()
  })

  it('renders the route h1 and exactly one lane per agent', () => {
    const AGENT_2 = 'C' + 'E'.repeat(55)
    const { container } = renderCrew({ agents: [agentRow(), agentRow({ address: AGENT_2 })] })
    expect(screen.getByRole('heading', { level: 1, name: /the crew, live/i })).toBeTruthy()
    const lanes = container.querySelectorAll('.pc-crew-lane')
    expect(lanes.length).toBe(2)
    // Fix round 2, F6: AgentMark's `label` is now the short 1-based lane number (not the address),
    // so an unscoped `getByText` on this address substring is unambiguous again. Kept scoped to
    // `lanes[0]`'s own address paragraph anyway -- it is the STRICTER check: it also catches a
    // lane-ordering regression (e.g. the array rendered reversed) that an unscoped, page-wide
    // `getByText` would miss entirely, since the same address text would still be found somewhere
    // on the page, just in the wrong lane.
    expect(lanes[0].querySelector('.pc-crew-lane-address').textContent).toMatch(
      new RegExp(AGENT.slice(0, 4))
    )
  })

  it("gives each AgentMark a distinct accessible name via its own lane number (M11, fix round 2: was the full short address, which overflowed AgentMark's visible <text> glyph -- F6)", () => {
    const AGENT_2 = 'C' + 'F'.repeat(55)
    const { container } = renderCrew({ agents: [agentRow(), agentRow({ address: AGENT_2 })] })
    const marks = container.querySelectorAll('.pc-agent-mark')
    expect(marks[0].getAttribute('aria-label')).not.toBe(marks[1].getAttribute('aria-label'))
  })

  it('shows the stat strip from real model fields, including the real confirmed total', () => {
    // A distinct per-agent amount (100 USDC) from the model's own confirmedTotal (250 USDC) so the
    // two don't render identical text -- otherwise `getByText('250 USDC')` would be ambiguous.
    renderCrew({
      agents: [agentRow({ amount: { token: 'USDC', units: '1000000000', decimals: 7 } })],
    })
    expect(screen.getByText(/active permissions/i)).toBeTruthy()
    expect(screen.getByText(/1 of 1/)).toBeTruthy()
    expect(screen.getByText(/8\.1%/)).toBeTruthy()
    expect(screen.getByText('250 USDC')).toBeTruthy()
  })

  it('shows an honest dash for Total working when confirmedTotal is not known, never a fabricated number', () => {
    // `amount` is present (a real partial/unconfirmed reading), only `state` says it isn't known --
    // proves the component checks `state`, not merely "is amount present".
    renderCrew({
      model: {
        ...model,
        confirmedTotal: {
          state: 'partial',
          amount: { token: 'USDC', units: '999000000', decimals: 7 },
        },
      },
    })
    const totalValue = screen.getByText('Total working').nextElementSibling
    expect(totalValue.textContent).toBe('—')
  })

  it('shows an honest dash when a legacy snapshot lacks productive custody evidence', () => {
    renderCrew({ model: { ...model, custodyBreakdown: null } })
    const totalValue = screen.getByText('Total working').nextElementSibling
    expect(totalValue.textContent).toBe('—')
  })

  it('maps keeper.label to the real Status word and tone: healthy, stale, and anything else', () => {
    const { unmount: unmountHealthy } = renderCrew({ keeper: { label: 'healthy' } })
    const healthyStatus = screen.getByText('Status').nextElementSibling
    expect(healthyStatus.textContent).toBe('Running')
    expect(healthyStatus.dataset.tone).toBe('good')
    unmountHealthy()

    const { unmount: unmountStale } = renderCrew({ keeper: { label: 'stale' } })
    const staleStatus = screen.getByText('Status').nextElementSibling
    expect(staleStatus.textContent).toBe('Quiet')
    expect(staleStatus.dataset.tone).toBe('warn')
    unmountStale()

    renderCrew({ keeper: { label: 'unavailable' } })
    const unavailableStatus = screen.getByText('Status').nextElementSibling
    expect(unavailableStatus.textContent).toBe('Unavailable')
    expect(unavailableStatus.dataset.tone).toBe('warn')
  })

  it('renders a confirmed amount and never promotes an unavailable read into the successful crew', () => {
    const { unmount } = renderCrew({
      agents: [agentRow({ amount: { token: 'USDC', units: '750000000', decimals: 7 } })],
    })
    expect(screen.getByText('75 USDC')).toBeTruthy()
    unmount()

    const { container } = renderCrew({
      agents: [agentRow({ amount: null, custody: { location: 'unknown' } })],
    })
    expect(container.querySelector('.pc-crew-lane')).toBeNull()
    expect(screen.getByText(/could not confirm your crew/i)).toBeTruthy()
  })

  it('renders both real keeper event kinds, and the honest empty line when there are none', () => {
    const { unmount: unmountCompound } = renderCrew({
      keeperEvents: [
        {
          id: 'compound:1',
          kind: 'compound_executed',
          totalGainUsdc: '12.34',
          txHash: 'abcdef1234567890',
          timestamp: Date.now() - 5000,
        },
      ],
    })
    expect(screen.getByText('Compounded, +12.34 USDC')).toBeTruthy()
    unmountCompound()

    const { unmount: unmountRebalance } = renderCrew({
      keeperEvents: [
        {
          id: 'rebalance:1',
          kind: 'rebalance_executed',
          fromLabel: 'VaultA',
          toLabel: 'VaultB',
          amountUsdc: '5.00',
          txHash: 'abcdef1234567890',
          timestamp: Date.now() - 5000,
        },
      ],
    })
    expect(screen.getByText('Rebalanced, VaultA to VaultB, 5.00 USDC')).toBeTruthy()
    unmountRebalance()

    renderCrew({ keeperEvents: [] })
    expect(screen.getByText('No keeper activity yet on this device.')).toBeTruthy()
  })

  it("stamps data-tone from each decision row's own tone, including 'rejected'", () => {
    const { container } = renderCrew({
      decisions: [
        { id: 1, tone: 'kept', title: 'Council proposal', detail: 'hold', time: '12:00' },
        { id: 2, tone: 'watch', title: 'Keeper rebalance created', detail: '', time: '12:05' },
        { id: 3, tone: 'rejected', title: 'Rejected a candidate pool', detail: '', time: '12:10' },
      ],
    })
    const rows = container.querySelectorAll('.pc-crew-decision-row')
    expect(rows[0].dataset.tone).toBe('kept')
    expect(rows[1].dataset.tone).toBe('watch')
    expect(rows[2].dataset.tone).toBe('rejected')
  })

  it('cancel button reports the agent address', () => {
    const onCancelAgent = vi.fn()
    renderCrew({ onCancelAgent })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancelAgent).toHaveBeenCalledWith(AGENT)
  })

  it('revoked agents render dimmed (data-revoked) without a cancel button', () => {
    const { container } = renderCrew({
      agents: [
        agentRow({
          scope: { state: 'known', value: { vault: 'CVAULT', revoked: true, expiry: 0 } },
        }),
      ],
    })
    expect(screen.queryByRole('button', { name: /^cancel/i })).toBeNull()
    expect(screen.getByText(/cancelled/i)).toBeTruthy()
    expect(container.querySelector('.pc-crew-lane').dataset.revoked).toBe('true')
  })

  it('empty state points to the strategy', () => {
    const onStartStrategy = vi.fn()
    renderCrew({ agents: [], onStartStrategy })
    fireEvent.click(screen.getByRole('button', { name: /put it to work/i }))
    expect(onStartStrategy).toHaveBeenCalled()
  })

  it('shows the confident successful-crew empty state only when model.state is authoritatively empty', () => {
    renderCrew({ agents: [], model: { ...model, state: 'empty' } })
    expect(screen.getByText(/no successful crew members are working yet/i)).toBeTruthy()
  })

  it('never claims there is no successful crew when an incomplete read merely produced zero agents', () => {
    renderCrew({ agents: [], model: { ...model, state: 'unavailable' } })
    expect(screen.queryByText(/no successful crew members are working yet/i)).toBeNull()
    expect(screen.getByText(/could not confirm your crew/i)).toBeTruthy()
  })

  it('renders decision log rows', () => {
    renderCrew()
    // Final-review fix, M6: "Every decision, written down" overclaimed completeness the
    // selector cannot honour (dropped AgentFailed rows, allowlist-neutralized verdicts).
    expect(screen.getByText(/decisions we logged/i)).toBeTruthy()
    expect(screen.getByText('Council proposal')).toBeTruthy()
  })
})

describe('CrewRoute — accessibility', () => {
  it('has zero axe violations for the active crew view', async () => {
    const { container } = renderCrew()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero axe violations for the empty-crew view', async () => {
    const { container } = renderCrew({ agents: [] })
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero axe violations for a revoked/mixed-problem crew view', async () => {
    const { container } = renderCrew({
      agents: [
        agentRow(),
        agentRow({
          address: 'C' + 'B'.repeat(55),
          scope: { state: 'known', value: { vault: 'CVAULT', revoked: true, expiry: 0 } },
        }),
        agentRow({ address: 'C' + 'D'.repeat(55), problems: ['scope-revoked'] }),
      ],
    })
    expect(await axe(container)).toHaveNoViolations()
  })
})
