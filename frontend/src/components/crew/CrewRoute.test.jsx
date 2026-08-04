// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { CrewRoute } from './CrewRoute.jsx'
import { CrewLanes } from './CrewLanes.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const ADDRESSES = Object.freeze({
  first: `C${'A'.repeat(55)}`,
  second: `C${'B'.repeat(55)}`,
  base: `C${'C'.repeat(55)}`,
  fourth: `C${'D'.repeat(55)}`,
})

function amount(units, token = 'USDC', decimals = 7) {
  return { token, units, decimals }
}

function child(address, units, overrides = {}) {
  const workingAmount = amount(units)
  return {
    agent: {
      address,
      scope: { state: 'known', value: { revoked: false, vault: 'CVAULT' } },
      executionStatus: 'succeeded',
      problems: [],
    },
    discoveryRow: {
      runId: `run-${address.slice(-4)}`,
      runOrdinal: 0,
      createdLedger: 1234,
      createdTxHash: `create-${address.slice(-4)}`,
    },
    workingLegs: [
      {
        location: 'stellar-vault',
        amount: workingAmount,
        shared: false,
        counted: true,
      },
    ],
    workingTotals: [workingAmount],
    idleAmount: amount('50000000'),
    hasWithdrawableStellar: true,
    active: true,
    incomplete: false,
    ...overrides,
  }
}

function persona(id, name, avatar, children = [], totals = [], totalState = 'known') {
  return { id, name, avatar, children, totals, totalState }
}

function crew(overrides = {}) {
  const first = child(ADDRESSES.first, '1000000000')
  const second = child(ADDRESSES.second, '500000000', {
    discoveryRow: {
      runId: 'run-second',
      runOrdinal: 3,
      createdLedger: 1300,
      createdTxHash: 'create-second',
    },
  })
  return {
    status: 'complete',
    personas: [
      persona(
        'sprout',
        'Sprout',
        '/brand/agents/sprout.svg',
        [first, second],
        [amount('1500000000')]
      ),
      persona('clover', 'Clover', '/brand/agents/clover.svg'),
      persona('mochi', 'Mochi', '/brand/agents/mochi.svg'),
    ],
    pendingAssignments: [],
    productiveAgentCount: 2,
    activeCount: 2,
    totals: [amount('1500000000')],
    ...overrides,
  }
}

const model = {
  yield: { state: 'live', apy: 8.1 },
  protection: {
    state: 'armed',
    ownerIsAuthority: true,
    mandateExpiry: Math.floor(Date.now() / 1000) + 3600,
  },
}
const keeper = { label: 'healthy' }

function renderCrew(overrides = {}) {
  return render(
    <CrewRoute
      crew={crew()}
      model={model}
      keeper={keeper}
      keeperEvents={[]}
      decisions={[]}
      onRenewMandate={vi.fn()}
      onCancelAgent={vi.fn()}
      onStartStrategy={vi.fn()}
      {...overrides}
    />
  )
}

describe('CrewRoute persona projection', () => {
  it('renders exactly Sprout, Clover, and Mochi in stable order, including empty personas', () => {
    const { container } = renderCrew()
    const cards = [...container.querySelectorAll('[data-persona-id]')]

    expect(cards.map((card) => card.dataset.personaId)).toEqual(['sprout', 'clover', 'mochi'])
    expect(cards).toHaveLength(3)
    expect(within(cards[0]).getByRole('heading', { name: 'Sprout' })).toBeTruthy()
    expect(within(cards[1]).getByText(/no productive accounts assigned yet/i)).toBeTruthy()
    expect(within(cards[2]).getByText(/no productive accounts assigned yet/i)).toBeTruthy()
    expect(
      within(cards[1])
        .getByRole('img', { name: /clover/i })
        .getAttribute('src')
    ).toBe('/brand/agents/clover.svg')
  })

  it('keeps two physical children under Sprout and sums only the supplied exact productive total', () => {
    const { container } = renderCrew()
    const sprout = container.querySelector('[data-persona-id="sprout"]')
    const rows = [...sprout.querySelectorAll('[data-child-address]')]

    expect(rows.map((row) => row.dataset.childAddress)).toEqual([ADDRESSES.first, ADDRESSES.second])
    expect(within(sprout).getByText('150 USDC')).toBeTruthy()
    expect(within(sprout).getByText('2 accounts')).toBeTruthy()
    expect(screen.getByText('Total working').nextElementSibling.textContent).toContain('150 USDC')
  })

  it('never creates a fourth persona card when more child deployments arrive', () => {
    const many = crew()
    many.personas = many.personas.map((entry) => ({ ...entry, children: [...entry.children] }))
    many.personas[0].children.push(child(ADDRESSES.fourth, '250000000'))
    many.personas[1].children.push(child(`C${'E'.repeat(55)}`, '250000000'))
    many.personas[2].children.push(child(`C${'F'.repeat(55)}`, '250000000'))

    const { container } = renderCrew({ crew: many })
    expect(container.querySelectorAll('[data-persona-id]')).toHaveLength(3)
  })

  it('renders each token/decimal total independently and labels partial coverage', () => {
    const partial = crew({
      status: 'partial',
      totals: [amount('1500000000'), amount('1234567', 'USDC', 6), amount('42', 'EURC', 2)],
    })
    partial.personas[0] = {
      ...partial.personas[0],
      totalState: 'partial',
      totals: [amount('1500000000'), amount('1234567', 'USDC', 6), amount('42', 'EURC', 2)],
    }
    const { container } = renderCrew({ crew: partial })
    const total = screen.getByText('Total working').nextElementSibling
    const sprout = container.querySelector('[data-persona-id="sprout"]')

    expect(total.textContent).toContain('150 USDC')
    expect(total.textContent).toContain('1.234567 USDC')
    expect(total.textContent).toContain('0.42 EURC')
    expect(within(sprout).getByText(/partial coverage/i)).toBeTruthy()
  })

  it('shows pending productive evidence as syncing without assigning it or claiming confirmed empty', () => {
    const pendingChild = child(ADDRESSES.base, '700000000', {
      assignment: { state: 'pending', reason: 'unverified-discovery-row' },
      active: false,
    })
    const pendingCrew = crew({
      status: 'partial',
      personas: crew().personas.map((entry) => ({ ...entry, children: [], totals: [] })),
      pendingAssignments: [pendingChild],
      productiveAgentCount: 1,
      activeCount: 0,
      totals: [amount('700000000')],
    })
    const { container } = renderCrew({ crew: pendingCrew })

    expect(screen.getByText(/crew assignment syncing/i)).toBeTruthy()
    expect(
      screen.getByText(new RegExp(`${ADDRESSES.base.slice(0, 4)}.*${ADDRESSES.base.slice(-4)}`))
    ).toBeTruthy()
    expect(container.querySelectorAll('[data-persona-id]')).toHaveLength(0)
    expect(screen.queryByText(/no successful crew members are working yet/i)).toBeNull()
  })

  it('uses the projection status for a confident empty versus uncertain empty result', () => {
    const emptyPersonas = crew().personas.map((entry) => ({ ...entry, children: [], totals: [] }))
    const complete = crew({
      personas: emptyPersonas,
      pendingAssignments: [],
      productiveAgentCount: 0,
      activeCount: 0,
      totals: [],
    })
    const { unmount } = renderCrew({ crew: complete })
    expect(screen.getByText(/no confirmed productive crew accounts are working yet/i)).toBeTruthy()
    unmount()

    renderCrew({ crew: { ...complete, status: 'partial' } })
    expect(screen.queryByText(/no confirmed productive crew accounts are working yet/i)).toBeNull()
    expect(screen.getByText(/could not confirm your crew/i)).toBeTruthy()
  })

  it('preserves the Emergency guard and Activity side column', () => {
    renderCrew({
      keeperEvents: [
        {
          id: 'compound:1',
          kind: 'compound_executed',
          totalGainUsdc: '4.82',
          txHash: 'abcdef1234567890',
          timestamp: Date.now(),
        },
      ],
      decisions: [{ id: 'd1', tone: 'kept', title: 'Hold position', detail: '', time: '12:00' }],
    })

    expect(screen.getByRole('heading', { name: /emergency guard/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /keeper activity/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /decisions we logged/i })).toBeTruthy()
    expect(screen.getByText('Compounded, +4.82 USDC')).toBeTruthy()
    expect(screen.getByText('Hold position')).toBeTruthy()
  })
})

describe('CrewLanes exact-address actions and evidence', () => {
  it('emits exact child addresses, offers Withdraw only for an eligible Stellar child, and exposes technical facts', () => {
    const onCancelAgent = vi.fn()
    const onWithdrawAgent = vi.fn()
    const stellar = child(ADDRESSES.first, '1000000000', {
      agent: {
        address: ADDRESSES.first,
        scope: { state: 'known', value: { revoked: false, vault: 'CVAULT' } },
        executionStatus: 'failed',
        problems: ['base-read-unavailable'],
      },
    })
    const baseOnly = child(ADDRESSES.base, '500000000', {
      workingLegs: [
        {
          location: 'base-proxy',
          amount: amount('500000000'),
          poolName: 'Aave v3',
          shared: false,
          counted: true,
        },
      ],
      workingTotals: [amount('500000000')],
      idleAmount: null,
      hasWithdrawableStellar: false,
    })
    render(
      <CrewLanes
        personas={[
          persona(
            'sprout',
            'Sprout',
            '/brand/agents/sprout.svg',
            [stellar, baseOnly],
            [amount('1500000000')]
          ),
        ]}
        onCancelAgent={onCancelAgent}
        onWithdrawAgent={onWithdrawAgent}
      />
    )

    const stellarRow = document.querySelector(`[data-child-address="${ADDRESSES.first}"]`)
    const baseRow = document.querySelector(`[data-child-address="${ADDRESSES.base}"]`)
    fireEvent.click(within(stellarRow).getByRole('button', { name: /withdraw/i }))
    fireEvent.click(within(baseRow).getByRole('button', { name: /cancel/i }))

    expect(onWithdrawAgent).toHaveBeenCalledWith(ADDRESSES.first)
    expect(onCancelAgent).toHaveBeenCalledWith(ADDRESSES.base)
    expect(within(baseRow).queryByRole('button', { name: /withdraw/i })).toBeNull()
    expect(within(stellarRow).getByText(ADDRESSES.first)).toBeTruthy()
    expect(within(stellarRow).getByText('run-AAAA')).toBeTruthy()
    expect(within(stellarRow).getByText(/stellar vault/i)).toBeTruthy()
    expect(within(stellarRow).getByText('5 USDC')).toBeTruthy()
    expect(within(stellarRow).getByText('base-read-unavailable')).toBeTruthy()
    expect(within(stellarRow).queryByText(/plan id/i)).toBeNull()
  })
})

describe('CrewRoute accessibility', () => {
  it('has zero axe violations for assigned, pending, and empty persona states', async () => {
    const active = renderCrew()
    expect(await axe(active.container)).toHaveNoViolations()
    active.unmount()

    const pending = crew({
      status: 'partial',
      personas: crew().personas.map((entry) => ({ ...entry, children: [], totals: [] })),
      pendingAssignments: [child(ADDRESSES.base, '700000000', { active: false })],
      productiveAgentCount: 1,
      activeCount: 0,
      totals: [amount('700000000')],
    })
    const pendingView = renderCrew({ crew: pending })
    expect(await axe(pendingView.container)).toHaveNoViolations()
    pendingView.unmount()

    const empty = crew({
      personas: crew().personas.map((entry) => ({ ...entry, children: [], totals: [] })),
      pendingAssignments: [],
      productiveAgentCount: 0,
      activeCount: 0,
      totals: [],
    })
    const emptyView = renderCrew({ crew: empty })
    expect(await axe(emptyView.container)).toHaveNoViolations()
  })
})
