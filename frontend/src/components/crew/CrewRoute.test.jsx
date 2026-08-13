// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { buildCrewPersonas } from '../../crew/buildCrewPersonas.js'
import { CrewRoute } from './CrewRoute.jsx'
import { CrewLanes, formatCrewAmount } from './CrewLanes.jsx'

expect.extend(axeMatchers)
afterEach(cleanup)

const ADDRESSES = Object.freeze({
  first: `C${'A'.repeat(55)}`,
  second: `C${'B'.repeat(55)}`,
  base: `C${'C'.repeat(55)}`,
  fourth: `C${'D'.repeat(55)}`,
})

const FIXTURE_NOW_MS = Date.parse('2026-08-11T00:00:00.000Z')
const CREW_CSS = readFileSync('src/components/crew/crew.css', 'utf8')

function isAccessibilityExposed(element) {
  let current = element
  while (current) {
    if (
      current.hasAttribute('hidden') ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true' ||
      (current.tagName === 'DETAILS' && !current.hasAttribute('open'))
    ) {
      return false
    }
    current = current.parentElement
  }
  return true
}

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
    identity: address
      ? {
          phase: 'deployed',
          address,
          verified: true,
          source: 'owner-discovery',
        }
      : undefined,
    ...overrides,
  }
}

function persona(id, name, avatar, children = [], totals = [], totalState = 'known') {
  return { id, name, avatar, children, totals, totalState }
}

function discoveryRow(address, overrides = {}) {
  return {
    address,
    creator: 'CINDEXEDCREATOR',
    createdLedger: 1200,
    createdTxHash: `create-${address}`,
    runId: `run-${address}`,
    runOrdinal: 0,
    grantTxHash: `grant-${address}`,
    provenance: {
      source: 'router-event',
      providerId: 'live-rpc',
      endpointClass: 'live',
      generation: 'agent-v3',
    },
    discoverySources: ['agent-index-api'],
    scopeReadStatus: 'ok',
    vault: 'CVAULT',
    revoked: false,
    expiry: 0,
    authorized: true,
    cap: amount('9999999999'),
    baseChildren: [],
    ...overrides,
  }
}

function discovery(rows) {
  return {
    status: 'complete',
    networkId: 'stellar-testnet',
    owner: 'GOWNER',
    agents: rows,
    coverage: null,
    hints: {
      localCacheCount: 0,
      rpcEventCount: 0,
      registryCount: 0,
      vaultVerifiedCount: 0,
      unverifiedCandidateCount: 0,
    },
  }
}

function moneyAgent(address, overrides = {}) {
  const workingAmount = amount('700000000')
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: 'CVAULT', revoked: false, expiry: 0, authorized: true },
      checkedAt: 1,
    },
    vaultShares: { state: 'known', amount: amount('0'), checkedAt: 1 },
    idleToken: { state: 'known', amount: amount('0'), checkedAt: 1 },
    amount: workingAmount,
    executionStatus: 'idle',
    custody: { location: 'base-proxy' },
    custodyBreakdown: [
      {
        location: 'base-proxy',
        amount: workingAmount,
        kernelAddress: '0xKeRnEl',
        poolAddress: '0xPoOl',
        asset: '0xUSDC',
        poolName: 'Aave v3',
        coverageReason: null,
      },
    ],
    problems: [],
    ...overrides,
  }
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
  yield: {
    venueKind: 'stellar-live',
    chain: 'stellar',
    yield: {
      state: 'live',
      apy: 8.1,
      asOf: '2026-08-10T23:59:00.000Z',
      source: 'defillama',
      checkedAt: '2026-08-11T00:00:00.000Z',
    },
  },
  protection: {
    state: 'armed',
    ownerIsAuthority: true,
    mandateExpiry: Math.floor(FIXTURE_NOW_MS / 1000) + 3600,
  },
}
const keeper = { label: 'healthy' }

describe('Crew amount presentation boundary', () => {
  it('delegates canonical validation and exact formatting, rejecting unsafe amount records', () => {
    expect(formatCrewAmount({ token: 'USDC', units: '9007199254740993', decimals: 7 })).toBe(
      '900719925.4740993 USDC'
    )
    expect(formatCrewAmount({ token: 'USDC', units: '-1', decimals: 7 })).toBe('Unavailable')
    expect(formatCrewAmount({ token: 'USDC', units: '1.5', decimals: 7 })).toBe('Unavailable')
    expect(formatCrewAmount({ token: 'USDC', units: '1', decimals: 39 })).toBe('Unavailable')
  })
})

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
      nowMs={FIXTURE_NOW_MS}
      {...overrides}
    />
  )
}

describe('CrewRoute persona projection', () => {
  it('renders the canonical Stellar testnet label for a confirmed Stellar vault leg', () => {
    renderCrew()

    const stellarRow = document.querySelector(`[data-child-address="${ADDRESSES.first}"]`)
    const stellarHead = stellarRow.querySelector('.pc-crew-child-head')
    const badge = stellarHead.querySelector('.network-badge[data-network="stellar-testnet"]')
    expect(badge).toBeTruthy()
    expect(isAccessibilityExposed(badge)).toBe(true)
    expect(badge.closest('details')).toBeNull()
    expect(within(stellarHead).getByText('Stellar testnet', { exact: true })).toBeTruthy()
    expect(badge.querySelector('img.network-mark')?.getAttribute('src')).toBe(
      '/brand/networks/stellar.svg'
    )
    expect(badge.querySelector('img.network-mark')?.getAttribute('alt')).toBe('')
    expect(
      stellarRow.querySelectorAll('.network-badge[data-network="stellar-testnet"]')
    ).toHaveLength(1)
    expect(stellarRow.querySelector('.pc-crew-child-details .network-badge')).toBeNull()
  })

  it('renders the canonical Base Sepolia label beside the custody-only disclosure for a confirmed Base leg', () => {
    const baseChild = child(ADDRESSES.base, '700000000', {
      workingLegs: [
        {
          location: 'base-proxy',
          amount: amount('700000000'),
          shared: false,
          counted: true,
          kernelAddress: '0xKeRnEl',
          poolAddress: '0xPoOl',
          asset: '0xUSDC',
          poolName: 'Aave v3',
          coverageReason: null,
        },
      ],
      workingTotals: [amount('700000000')],
      hasWithdrawableStellar: false,
    })
    const sourceCrew = crew()
    const baseCrew = {
      ...sourceCrew,
      personas: sourceCrew.personas.map((entry, index) =>
        index === 0
          ? { ...entry, children: [baseChild], totals: [amount('700000000')] }
          : { ...entry, children: [], totals: [] }
      ),
      productiveAgentCount: 1,
      activeCount: 1,
      totals: [amount('700000000')],
    }

    renderCrew({ crew: baseCrew })

    const baseRow = document.querySelector(`[data-child-address="${ADDRESSES.base}"]`)
    const baseHead = baseRow.querySelector('.pc-crew-child-head')
    const badge = baseHead.querySelector('.network-badge[data-network="base-sepolia"]')
    expect(baseRow).toBeTruthy()
    expect(badge).toBeTruthy()
    expect(isAccessibilityExposed(badge)).toBe(true)
    expect(badge.closest('details')).toBeNull()
    expect(within(baseHead).getByText('Base Sepolia', { exact: true })).toBeTruthy()
    expect(badge.querySelector('img.network-mark')?.getAttribute('src')).toBe(
      '/brand/networks/base.svg'
    )
    expect(badge.querySelector('img.network-mark')?.getAttribute('alt')).toBe('')
    expect(baseRow.querySelectorAll('.network-badge[data-network="base-sepolia"]')).toHaveLength(1)
    expect(baseRow.querySelector('.pc-crew-child-details .network-badge')).toBeNull()
    expect(
      within(baseRow).getByText('Base Sepolia proxy. Custody only. No protocol yield.', {
        exact: true,
      })
    ).toBeTruthy()
  })

  it('shows unknown network for an unresolved custody leg without borrowing a network mark', () => {
    const unknownChild = child(ADDRESSES.base, '700000000', {
      workingLegs: [
        {
          amount: amount('700000000'),
          shared: false,
          counted: true,
        },
      ],
      workingTotals: [amount('700000000')],
    })

    render(
      <CrewLanes
        personas={[persona('sprout', 'Sprout', '/brand/agents/sprout.svg', [unknownChild])]}
      />
    )

    const row = document.querySelector(`[data-child-address="${ADDRESSES.base}"]`)
    const head = row.querySelector('.pc-crew-child-head')
    const badge = head.querySelector('.network-badge[data-network="unknown"]')
    expect(badge).toBeTruthy()
    expect(isAccessibilityExposed(badge)).toBe(true)
    expect(badge.closest('details')).toBeNull()
    expect(within(head).getByText('Unknown network', { exact: true })).toBeTruthy()
    expect(within(head).queryByText('Stellar testnet', { exact: true })).toBeNull()
    expect(within(head).queryByText('Base Sepolia', { exact: true })).toBeNull()
    expect(badge.querySelector('svg.network-mark--fallback')).toBeTruthy()
    expect(badge.querySelector('img.network-mark')).toBeNull()
    expect(row.querySelector('.pc-crew-child-details .network-badge')).toBeNull()
  })

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
    expect(screen.getByText('Working for you').nextElementSibling.textContent).toContain('2 of 2')
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
    const sprout = container.querySelector('[data-persona-id="sprout"]')

    expect(within(sprout).getByText('150 USDC')).toBeTruthy()
    expect(within(sprout).getByText('1.234567 USDC')).toBeTruthy()
    expect(within(sprout).getByText('0.42 EURC')).toBeTruthy()
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
    const onStartStrategy = vi.fn()
    const emptyPersonas = crew().personas.map((entry) => ({ ...entry, children: [], totals: [] }))
    const complete = crew({
      personas: emptyPersonas,
      pendingAssignments: [],
      productiveAgentCount: 0,
      activeCount: 0,
      totals: [],
    })
    const { unmount } = renderCrew({ crew: complete, onStartStrategy })
    expect(screen.getByText(/no confirmed productive crew accounts are working yet/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Put it to work' }))
    expect(onStartStrategy).toHaveBeenCalledTimes(1)
    unmount()

    renderCrew({ crew: { ...complete, status: 'partial' } })
    expect(screen.queryByText(/no confirmed productive crew accounts are working yet/i)).toBeNull()
    expect(screen.getByText(/could not confirm your crew/i)).toBeTruthy()
  })

  it('uses uncertain copy for a complete discovery whose joined money row is unreadable', () => {
    const unreadable = moneyAgent(ADDRESSES.first, {
      scope: { state: 'unavailable', value: null, checkedAt: 1 },
      vaultShares: { state: 'unavailable', amount: null, checkedAt: 1 },
      idleToken: { state: 'unavailable', amount: null, checkedAt: 1 },
      amount: null,
      executionStatus: 'unknown',
      custody: { location: 'unknown' },
      custodyBreakdown: [],
      problems: ['scope-read-failed'],
    })
    const projected = buildCrewPersonas({
      discovery: discovery([discoveryRow(ADDRESSES.first)]),
      moneyAgents: [unreadable],
    })

    renderCrew({ crew: projected })

    expect(screen.getByText(/could not confirm your crew/i)).toBeTruthy()
    expect(screen.queryByText(/no confirmed productive crew accounts/i)).toBeNull()
  })

  it('shows counted Stellar and known shared Base evidence for the same pending child', () => {
    const projected = buildCrewPersonas({
      discovery: discovery([
        discoveryRow(ADDRESSES.first),
        discoveryRow(ADDRESSES.base, {
          creator: null,
          createdLedger: null,
          createdTxHash: null,
          runId: null,
          runOrdinal: null,
          grantTxHash: null,
          provenance: null,
          discoverySources: ['rpc-router-events'],
        }),
      ]),
      moneyAgents: [
        moneyAgent(ADDRESSES.first),
        moneyAgent(ADDRESSES.base, {
          custody: { location: 'unknown' },
          custodyBreakdown: [
            { location: 'stellar-vault', amount: amount('300000000') },
            {
              location: 'base-proxy',
              amount: amount('700000000'),
              kernelAddress: '0xKeRnEl',
              poolAddress: '0xPoOl',
              asset: '0xUSDC',
              poolName: 'Aave v3',
              coverageReason: null,
            },
          ],
        }),
      ],
    })

    renderCrew({ crew: projected })
    const pending = screen.getByRole('status')
    expect(within(pending).getByText('Agent identity unavailable')).toBeTruthy()
    expect(within(pending).getByText('Amount unavailable')).toBeTruthy()
    expect(within(pending).queryByText(/custody/i)).toBeNull()
    expect(within(pending).queryByText(/30 USDC|70 USDC/)).toBeNull()
  })

  it('preserves the Emergency guard and Activity side column', () => {
    renderCrew({
      keeperEvents: [
        {
          id: 'compound:1',
          kind: 'compound_executed',
          totalGainUsdc: '4.82',
          txHash: 'abcdef1234567890',
          timestamp: FIXTURE_NOW_MS,
          closedAt: FIXTURE_NOW_MS - 60_000,
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

describe('CrewRoute — child identity projection', () => {
  it('renders a deterministic AgentMark for each physical child account', () => {
    const { container } = renderCrew()
    const marks = container.querySelectorAll('[data-child-address] [data-identity-key]')
    expect(marks).toHaveLength(2)
    expect([...marks].map((mark) => mark.getAttribute('data-identity-key'))).toEqual(
      expect.arrayContaining([ADDRESSES.first, ADDRESSES.second])
    )
  })

  it('keeps planned, deployed, and reused identity labels tied to canonical identity fields', () => {
    const planned = child('', '100000000', {
      agent: { address: '', scope: { value: { revoked: false } }, problems: [] },
      identity: {
        phase: 'planned',
        allocationId: 'allocation-planned',
        runId: 'run-planned',
        source: 'reviewed-plan',
      },
      workingLegs: [],
      workingTotals: [],
      hasWithdrawableStellar: false,
    })
    const deployed = child(ADDRESSES.first, '100000000', {
      identity: {
        phase: 'deployed',
        address: ADDRESSES.first,
        verified: true,
        source: 'creation-event',
        runId: 'run-deployed',
        allocationId: 'allocation-deployed',
      },
    })
    const reused = child(ADDRESSES.second, '100000000', {
      identity: {
        phase: 'reused',
        address: ADDRESSES.second,
        verified: true,
        source: 'owner-discovery',
        runId: 'run-reused',
        allocationId: 'allocation-reused',
      },
    })
    const onCancelAgent = vi.fn()
    const { rerender } = render(
      <CrewLanes
        personas={[
          persona('sprout', 'Sprout', '/brand/agents/sprout.svg', [planned, deployed, reused]),
        ]}
        onCancelAgent={onCancelAgent}
      />
    )

    const sprout = document.querySelector('[data-persona-id="sprout"]')
    expect(within(sprout).getAllByText('Planned').length).toBeGreaterThan(0)
    expect(within(sprout).getByLabelText(/Deployed agent, Existing/i)).toBeTruthy()
    expect(within(sprout).queryByText('allocation-planned')).toBeNull()
    expect(within(sprout).getByText(`CAAA…AAAA`)).toBeTruthy()

    const initialKeys = Object.fromEntries(
      [...sprout.querySelectorAll('[data-identity-key]')].map((mark) => [
        mark.dataset.identityKey,
        mark.outerHTML,
      ])
    )
    fireEvent.click(within(sprout).getByRole('button', { name: `Cancel ${ADDRESSES.second}` }))
    expect(onCancelAgent).toHaveBeenCalledWith(ADDRESSES.second)

    rerender(
      <CrewLanes
        personas={[
          persona('sprout', 'Sprout', '/brand/agents/sprout.svg', [reused, planned, deployed]),
        ]}
        onCancelAgent={onCancelAgent}
      />
    )
    const reordered = document.querySelector('[data-persona-id="sprout"]')
    const reorderedKeys = Object.fromEntries(
      [...reordered.querySelectorAll('[data-identity-key]')].map((mark) => [
        mark.dataset.identityKey,
        mark.outerHTML,
      ])
    )
    expect(reorderedKeys).toEqual(initialKeys)
    fireEvent.click(within(reordered).getByRole('button', { name: `Cancel ${ADDRESSES.first}` }))
    expect(onCancelAgent).toHaveBeenCalledWith(ADDRESSES.first)
  })

  it('keeps a missing or unverified child visible without identity mark, money, cap, custody, or actions', () => {
    const missing = child('', '900000000', {
      agent: { address: '', scope: { value: { revoked: false } }, problems: [] },
      identity: {
        phase: 'deployed',
        address: '',
        verified: false,
        source: 'creation-event',
        allocationId: 'allocation-missing',
        runId: 'run-missing',
      },
    })
    const unverified = child(ADDRESSES.fourth, '800000000', {
      agent: { address: ADDRESSES.fourth, scope: { value: { revoked: false } }, problems: [] },
      identity: {
        phase: 'deployed',
        address: ADDRESSES.fourth,
        verified: false,
        source: 'creation-event',
      },
    })
    const sibling = child(ADDRESSES.first, '100000000')

    render(
      <CrewLanes
        personas={[
          persona('sprout', 'Sprout', '/brand/agents/sprout.svg', [missing, unverified, sibling]),
        ]}
        onCancelAgent={vi.fn()}
        onWithdrawAgent={vi.fn()}
      />
    )

    const unavailableRows = document.querySelectorAll('[data-child-identity-unavailable="true"]')
    expect(unavailableRows).toHaveLength(2)
    unavailableRows.forEach((row) => {
      expect(within(row).getByText('Agent identity unavailable')).toBeTruthy()
      expect(row.querySelector('[data-identity-key]')).toBeNull()
      expect(row.querySelector('svg')).toBeNull()
      expect(within(row).queryByText(/USDC/)).toBeNull()
      expect(within(row).queryByRole('button')).toBeNull()
      expect(within(row).queryByText(/vault|custody|cap/i)).toBeNull()
    })
    expect(document.querySelector(`[data-child-address="${ADDRESSES.first}"]`)).toBeTruthy()
    expect(screen.getByRole('button', { name: `Cancel ${ADDRESSES.first}` })).toBeTruthy()
  })

  it('fails closed on mismatched identity/address evidence and keeps two unavailable keys distinct', () => {
    const mismatch = child(ADDRESSES.first, '100000000', {
      agent: { ...child(ADDRESSES.first, '100000000').agent, address: ADDRESSES.second },
      identity: {
        phase: 'deployed',
        address: ADDRESSES.first,
        verified: true,
        source: 'creation-event',
        allocationId: 'allocation-mismatch',
        runId: 'run-mismatch',
      },
    })
    const unavailableOne = child('', '100000000', {
      agent: { address: '', scope: { value: { revoked: false } }, problems: [] },
      identity: {
        phase: 'deployed',
        address: '',
        verified: false,
        source: 'creation-event',
      },
    })
    const unavailableTwo = child('', '200000000', {
      agent: { address: '', scope: { value: { revoked: false } }, problems: [] },
      identity: {
        phase: 'deployed',
        address: '',
        verified: false,
        source: 'creation-event',
      },
    })

    render(
      <CrewLanes
        personas={[
          persona('sprout', 'Sprout', '/brand/agents/sprout.svg', [
            mismatch,
            unavailableOne,
            unavailableTwo,
          ]),
        ]}
        onCancelAgent={vi.fn()}
        onWithdrawAgent={vi.fn()}
      />
    )

    const unavailableRows = [
      ...document.querySelectorAll('[data-child-identity-unavailable="true"]'),
    ]
    expect(unavailableRows).toHaveLength(3)
    expect(unavailableRows.map((row) => row.dataset.childIdentity)).toEqual(
      expect.arrayContaining(['allocation-mismatch'])
    )
    expect(new Set(unavailableRows.map((row) => row.dataset.childIdentity)).size).toBe(3)
    unavailableRows.forEach((row) => {
      expect(row.dataset.childAddress).toBeUndefined()
      expect(within(row).queryByRole('button')).toBeNull()
      expect(within(row).queryByText(/technical details/i)).toBeNull()
    })
  })

  it('does not promote a raw row or agent address when the canonical identity view is absent', () => {
    const unprojected = child(ADDRESSES.first, '100000000', { identity: undefined })

    render(
      <CrewLanes
        personas={[persona('sprout', 'Sprout', '/brand/agents/sprout.svg', [unprojected])]}
        onCancelAgent={vi.fn()}
        onWithdrawAgent={vi.fn()}
      />
    )

    const row = document.querySelector('[data-child-identity-unavailable="true"]')
    expect(row).toBeTruthy()
    expect(row.dataset.childAddress).toBeUndefined()
    expect(within(row).getByText('Agent identity unavailable')).toBeTruthy()
    expect(within(row).queryByRole('button')).toBeNull()
  })
})

describe('CrewRoute — canonical stat projections', () => {
  function stat(label) {
    const labelNode = screen.getByText(label, { selector: '.pc-crew-stat-label' })
    return labelNode.parentElement
  }

  it('renders exactly the four source-backed stat labels and canonical values', () => {
    renderCrew({
      model: {
        ...model,
        earned: {
          state: 'current',
          amount: amount('123456789', 'USDC', 7),
          source: 'vault-ledger',
          checkedAt: '2026-08-10T23:59:00.000Z',
          confirmedLedger: '12345',
        },
      },
    })

    expect(
      [...document.querySelectorAll('.pc-crew-stats .pc-crew-stat-label')].map(
        (node) => node.textContent
      )
    ).toEqual(['Status', 'Working for you', 'Earned this run', 'Blended rate'])
    expect(within(stat('Working for you')).getByText('2 of 2')).toBeTruthy()
    expect(within(stat('Earned this run')).getByText('12.3456789 USDC')).toBeTruthy()
    expect(within(stat('Blended rate')).getByText('8.1%')).toBeTruthy()
    expect(within(stat('Blended rate')).getByText(/defillama/i)).toBeTruthy()
    expect(within(stat('Blended rate')).getByText(/2026-08-10T23:59:00.000Z/)).toBeTruthy()
  })

  it('rejects flat APY and proofless earned decoys even when their values look complete', () => {
    const { rerender } = renderCrew({
      model: {
        ...model,
        yield: {
          state: 'live',
          apy: 99,
          source: 'decoy',
          asOf: '2026-08-10T23:59:00.000Z',
          checkedAt: '2026-08-11T00:00:00.000Z',
        },
        earned: {
          state: 'current',
          amount: amount('123456789', 'USDC', 7),
        },
      },
    })

    expect(within(stat('Blended rate')).getByText('Unavailable')).toBeTruthy()
    expect(stat('Blended rate').textContent).not.toContain('99')
    expect(within(stat('Earned this run')).getByText('Unavailable')).toBeTruthy()
    expect(stat('Earned this run').textContent).not.toContain('12.3456789 USDC')

    rerender(
      <CrewRoute
        crew={crew()}
        model={{
          ...model,
          earned: {
            state: 'current',
            amount: amount('123456789', 'USDC', 7),
            source: 'vault-ledger',
            checkedAt: '2026-08-10T23:59:00.000Z',
          },
        }}
        keeper={keeper}
        keeperEvents={[]}
        decisions={[]}
        onRenewMandate={vi.fn()}
        onCancelAgent={vi.fn()}
        onStartStrategy={vi.fn()}
        nowMs={FIXTURE_NOW_MS}
      />
    )
    expect(within(stat('Earned this run')).getByText('Unavailable')).toBeTruthy()
  })

  it('never substitutes principal totals for an unavailable or stale earned value', () => {
    renderCrew({
      model: {
        ...model,
        earned: { state: 'unavailable', amount: null },
      },
    })

    expect(within(stat('Earned this run')).getByText('Unavailable')).toBeTruthy()
    expect(stat('Earned this run').textContent).not.toContain('150 USDC')
    expect(stat('Earned this run').textContent).not.toContain('0 USDC')
  })

  it('keeps a source-owned stale earned fact visibly stale without showing its value', () => {
    renderCrew({
      model: {
        ...model,
        earned: {
          state: 'stale',
          amount: amount('123456789', 'USDC', 7),
          source: 'vault-ledger',
          checkedAt: '2026-08-10T23:59:00.000Z',
          confirmedLedger: '12345',
        },
      },
    })

    expect(within(stat('Earned this run')).getByText('Stale')).toBeTruthy()
    expect(stat('Earned this run').textContent).not.toContain('12.3456789 USDC')
  })

  it('uses only a fresh nested venue yield and rejects stale or flat APY decoys', () => {
    const { rerender } = renderCrew({
      model: { ...model, yield: { state: 'stale', apy: 99 } },
    })
    expect(within(stat('Blended rate')).getByText('Unavailable')).toBeTruthy()

    rerender(
      <CrewRoute
        crew={crew()}
        model={{ ...model, yield: { apy: 99 } }}
        keeper={keeper}
        keeperEvents={[]}
        decisions={[]}
        onRenewMandate={vi.fn()}
        onCancelAgent={vi.fn()}
        onStartStrategy={vi.fn()}
      />
    )
    expect(within(stat('Blended rate')).getByText('Unavailable')).toBeTruthy()
    expect(stat('Blended rate').textContent).not.toContain('99')
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
    const secondStellar = child(ADDRESSES.second, '250000000')
    render(
      <CrewLanes
        personas={[
          persona(
            'sprout',
            'Sprout',
            '/brand/agents/sprout.svg',
            [stellar, secondStellar, baseOnly],
            [amount('1750000000')]
          ),
        ]}
        onCancelAgent={onCancelAgent}
        onWithdrawAgent={onWithdrawAgent}
      />
    )

    const stellarRow = document.querySelector(`[data-child-address="${ADDRESSES.first}"]`)
    const secondStellarRow = document.querySelector(`[data-child-address="${ADDRESSES.second}"]`)
    const baseRow = document.querySelector(`[data-child-address="${ADDRESSES.base}"]`)
    const withdrawFirst = within(stellarRow).getByRole('button', {
      name: `Withdraw from ${ADDRESSES.first}`,
    })
    expect(
      within(secondStellarRow).getByRole('button', {
        name: `Withdraw from ${ADDRESSES.second}`,
      })
    ).toBeTruthy()
    expect(
      within(stellarRow).getByRole('button', { name: `Cancel ${ADDRESSES.first}` })
    ).toBeTruthy()
    expect(
      within(secondStellarRow).getByRole('button', { name: `Cancel ${ADDRESSES.second}` })
    ).toBeTruthy()
    const cancelBase = within(baseRow).getByRole('button', { name: `Cancel ${ADDRESSES.base}` })

    fireEvent.click(withdrawFirst)
    fireEvent.click(cancelBase)

    expect(onWithdrawAgent).toHaveBeenCalledWith(ADDRESSES.first)
    expect(onCancelAgent).toHaveBeenCalledWith(ADDRESSES.base)
    expect(within(baseRow).queryByRole('button', { name: /withdraw/i })).toBeNull()
    expect(within(stellarRow).getByText(ADDRESSES.first)).toBeTruthy()
    expect(within(stellarRow).getByText('run-AAAA')).toBeTruthy()
    expect(within(stellarRow).getByText(/stellar vault/i)).toBeTruthy()
    expect(within(stellarRow).getByText('5 USDC')).toBeTruthy()
    expect(within(stellarRow).getByText('base-read-unavailable')).toBeTruthy()
    expect(within(stellarRow).queryByText(/plan id/i)).toBeNull()
    expect(
      within(baseRow).getByText('Base Sepolia proxy. Custody only. No protocol yield.')
    ).toBeTruthy()
  })

  it('labels Base-only custody as custody only rather than generic working yield', () => {
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
      hasWithdrawableStellar: false,
    })
    render(
      <CrewLanes personas={[persona('sprout', 'Sprout', '/brand/agents/sprout.svg', [baseOnly])]} />
    )
    const row = document.querySelector(`[data-child-address="${ADDRESSES.base}"]`)
    expect(within(row).getByText('Custody only')).toBeTruthy()
    expect(within(row).queryByText('Working')).toBeNull()
  })

  it('keeps a revoked child visible as cancelled without offering Cancel again', () => {
    const revoked = child(ADDRESSES.first, '1000000000', {
      agent: {
        address: ADDRESSES.first,
        scope: { state: 'known', value: { revoked: true, vault: 'CVAULT' } },
        executionStatus: 'idle',
        problems: ['scope-revoked'],
      },
      active: false,
    })

    render(
      <CrewLanes
        personas={[
          persona(
            'sprout',
            'Sprout',
            '/brand/agents/sprout.svg',
            [revoked],
            [amount('1000000000')],
            'partial'
          ),
        ]}
        onCancelAgent={vi.fn()}
      />
    )

    const row = document.querySelector(`[data-child-address="${ADDRESSES.first}"]`)
    expect(row.dataset.revoked).toBe('true')
    expect(within(row).getByText('Cancelled')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: `Cancel ${ADDRESSES.first}` })).toBeNull()
  })

  it('renders each repeated problem only once', () => {
    const repeated = child(ADDRESSES.first, '1000000000', {
      agent: {
        address: ADDRESSES.first,
        scope: { state: 'known', value: { revoked: false, vault: 'CVAULT' } },
        executionStatus: 'failed',
        problems: ['base-read-unavailable', 'base-read-unavailable', 'unexpected-error'],
      },
    })

    render(
      <CrewLanes
        personas={[
          persona(
            'sprout',
            'Sprout',
            '/brand/agents/sprout.svg',
            [repeated],
            [amount('1000000000')]
          ),
        ]}
      />
    )

    expect(screen.getAllByText('base-read-unavailable')).toHaveLength(1)
    expect(screen.getAllByText('unexpected-error')).toHaveLength(1)
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

describe('CrewRoute zoom reflow contract', () => {
  it('lets the guard and activity side column shrink around long authority evidence', () => {
    expect(CREW_CSS).toMatch(/\.pc-crew-side\s*{[^}]*min-width:\s*0;/)
    expect(CREW_CSS).toMatch(/\.pc-crew-guard\s*{[^}]*min-width:\s*0;/)
    expect(CREW_CSS).toMatch(/\.pc-crew-activity\s*{[^}]*min-width:\s*0;/)
    expect(CREW_CSS).toMatch(/\.pc-crew-guard-renew-note\s*{[^}]*overflow-wrap:\s*anywhere;/)
  })
})
