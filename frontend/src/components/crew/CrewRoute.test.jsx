// frontend/src/components/crew/CrewRoute.test.jsx
// Task 9 (Pocket Crew design alignment). CrewRoute composition test -- route heading, stat strip
// sourced from real model fields, per-agent cancel wiring, revoked-agent dimming, empty-state CTA,
// and the decision log. Accessibility sweep mirrors MyMoneyRoute.a11y.test.jsx's own axe pattern.
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
  it('renders the route h1 and one lane per agent', () => {
    renderCrew()
    expect(screen.getByRole('heading', { level: 1, name: /the crew, live/i })).toBeTruthy()
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
    expect(screen.getByText(new RegExp(AGENT.slice(0, 4)))).toBeTruthy()
  })

  it('shows the stat strip from real model fields', () => {
    renderCrew()
    expect(screen.getByText(/working for you/i)).toBeTruthy()
    expect(screen.getByText(/1 of 1/)).toBeTruthy()
    expect(screen.getByText(/8\.1%/)).toBeTruthy()
  })

  it('cancel button reports the agent address', () => {
    const onCancelAgent = vi.fn()
    renderCrew({ onCancelAgent })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancelAgent).toHaveBeenCalledWith(AGENT)
  })

  it('revoked agents render dimmed without a cancel button', () => {
    renderCrew({
      agents: [
        agentRow({
          scope: { state: 'known', value: { vault: 'CVAULT', revoked: true, expiry: 0 } },
        }),
      ],
    })
    expect(screen.queryByRole('button', { name: /^cancel/i })).toBeNull()
    expect(screen.getByText(/cancelled/i)).toBeTruthy()
  })

  it('empty state points to the strategy', () => {
    const onStartStrategy = vi.fn()
    renderCrew({ agents: [], onStartStrategy })
    fireEvent.click(screen.getByRole('button', { name: /put it to work/i }))
    expect(onStartStrategy).toHaveBeenCalled()
  })

  it('renders decision log rows', () => {
    renderCrew()
    expect(screen.getByText(/every decision, written down/i)).toBeTruthy()
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
