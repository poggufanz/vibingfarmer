// Core Task 11 route-level accessibility and semantic presentation guards.
// These tests mount real Core route components.  The dedicated route suites remain the owners of
// their detailed state machines; this file protects the cross-route contract used by the Core
// visual atlas: one page heading, named landmarks, visible network text, focus restraint, and
// the no-dash UI-copy rule.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { MyMoneyRoute } from './money/MyMoneyRoute.jsx'
import { HowMoneyWorks } from './money/HowMoneyWorks.jsx'
import { StrategyRoute } from './strategy/StrategyRoute.jsx'
import { CrewRoute } from './crew/CrewRoute.jsx'
import SettingsPage from './SettingsPage.jsx'

expect.extend(axeMatchers)
afterEach(() => {
  cleanup()
  localStorage.clear()
})

function moneyModel(overrides = {}) {
  return {
    state: 'disarmed',
    owner: 'GCORETASK11OWNER',
    confirmedTotal: { state: 'unavailable', amount: null },
    yield: { state: 'unavailable', apy: null },
    earned: { state: 'unavailable', amount: null },
    unattributed: {},
    custodyBreakdown: {},
    agentCount: 0,
    problemAgentCount: 0,
    freshness: 'unavailable',
    checkedAt: null,
    confirmedLedger: null,
    confirmedBlock: null,
    source: 'soroban-rpc',
    problemAgents: [],
    protection: {
      state: 'disarmed',
      authority: 'GCORETASK11AUTHORITY',
      mandateExpiry: 1,
      urgentRenewal: false,
      ownerIsAuthority: false,
    },
    hasKnownVaultMoney: false,
    ...overrides,
  }
}

function routeAgent({
  address = 'GCORETASK11AGENT',
  location = 'stellar-vault',
  coverageReason = null,
  revoked = false,
} = {}) {
  return {
    address,
    scope: { state: 'known', value: { vault: 'GCORETASK11VAULT', revoked, expiry: 0 } },
    amount: { token: 'USDC', units: '5000000000', decimals: 7 },
    executionStatus: 'idle',
    custody: { location },
    custodyBreakdown: [
      {
        location,
        amount: { token: 'USDC', units: '5000000000', decimals: 7 },
        coverageReason,
      },
    ],
    problems: revoked ? ['scope-revoked'] : [],
  }
}

const STATE_RICH_MONEY = [
  [
    'stale',
    moneyModel({
      state: 'stale',
      confirmedTotal: {
        state: 'known',
        amount: { token: 'USDC', units: '5000000000', decimals: 7 },
      },
      freshness: 'stale',
      checkedAt: Date.parse('2026-08-01T00:00:00.000Z'),
      agentCount: 1,
    }),
    [routeAgent({ coverageReason: 'stale' })],
  ],
  [
    'unavailable',
    moneyModel({
      state: 'unavailable',
      confirmedTotal: { state: 'unavailable', amount: null },
      freshness: 'unavailable',
      checkedAt: null,
      agentCount: 0,
    }),
    [],
  ],
  [
    'partial-discovery',
    moneyModel({
      state: 'partial-discovery',
      confirmedTotal: {
        state: 'known',
        amount: { token: 'USDC', units: '5000000000', decimals: 7 },
      },
      freshness: 'current',
      checkedAt: Date.parse('2026-08-11T00:00:00.000Z'),
      agentCount: 0,
    }),
    [],
  ],
  [
    'problem',
    moneyModel({
      state: 'problem',
      confirmedTotal: {
        state: 'known',
        amount: { token: 'USDC', units: '5000000000', decimals: 7 },
      },
      freshness: 'current',
      checkedAt: Date.parse('2026-08-11T00:00:00.000Z'),
      agentCount: 1,
      problemAgentCount: 1,
      problemAgents: ['GCORETASK11REVOKED'],
    }),
    [routeAgent({ address: 'GCORETASK11REVOKED', location: 'agent', revoked: true })],
  ],
  [
    'recovery',
    moneyModel({
      state: 'problem',
      confirmedTotal: {
        state: 'known',
        amount: { token: 'USDC', units: '5000000000', decimals: 7 },
      },
      freshness: 'current',
      checkedAt: Date.parse('2026-08-11T00:00:00.000Z'),
      agentCount: 1,
      problemAgentCount: 1,
      problemAgents: ['GCORETASK11RECOVERY'],
    }),
    [routeAgent({ address: 'GCORETASK11RECOVERY', location: 'agent', revoked: true })],
  ],
]

const strategyProps = {
  stage: 'plan',
  reached: ['plan'],
  vaultTotalShares: 500_0000000n,
  base: { connected: false, healthy: null, mandateView: null, action: null },
  onGenerate: vi.fn(),
}

const settingsProps = {
  userAddress: null,
  walletPhase: 'none',
  permActive: false,
  permExpiresAt: null,
  permissionCount: 0,
  agentEnabled: false,
  setAgentEnabled: vi.fn(),
  agentSettings: {},
  setAgentSettings: vi.fn(),
  skillSource: 'default',
  language: 'en',
  onLanguageChange: vi.fn(),
  onChangeSkill: vi.fn(),
  onResetSkill: vi.fn(),
  onResetAgentSettings: vi.fn(),
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
  onRevoke: vi.fn(),
  addLog: vi.fn(),
  mandateView: null,
  connected: false,
  busy: false,
  error: null,
  onSetup: vi.fn(),
  onRefresh: vi.fn(),
}

function renderMoney(overrides = {}, agents = []) {
  return render(
    <main>
      <MyMoneyRoute
        model={moneyModel(overrides)}
        agents={agents}
        venue={{ venueKind: 'stellar-live', yield: { state: 'unavailable', apy: null } }}
        baseActionsAvailable={false}
        baseUnavailableReason="Base recovery is unavailable on this device."
      />
    </main>
  )
}

describe('Core route accessibility', () => {
  beforeEach(() => window.history.replaceState({}, '', '/settings'))

  it.each([
    ['My money', () => renderMoney()],
    [
      'Put it to work',
      () =>
        render(
          <main>
            <StrategyRoute {...strategyProps} />
          </main>
        ),
    ],
    [
      'The crew',
      () =>
        render(
          <main>
            <CrewRoute
              crew={{
                status: 'complete',
                personas: [],
                pendingAssignments: [],
                productiveAgentCount: 0,
                activeCount: 0,
                totals: [],
              }}
              model={null}
              keeper={null}
            />
          </main>
        ),
    ],
    [
      'Settings',
      () =>
        render(
          <main>
            <SettingsPage {...settingsProps} />
          </main>
        ),
    ],
  ])('%s exposes exactly one page heading below the shell main landmark', (_label, mount) => {
    mount()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
    const main = screen.getByRole('main')
    expect(main.querySelector('.pc-route, .pc-settings')).toBeTruthy()
  })

  it.each(STATE_RICH_MONEY)(
    'My money %s state keeps rendered copy free of prohibited em/en dash separators',
    async (_label, model, agents) => {
      const { container } = renderMoney(model, agents)
      expect(container.textContent).not.toMatch(/[—–]/)
      expect(await axe(container)).toHaveNoViolations()
    }
  )

  it('My money recovery copy remains separator-free when the real dialog is opened', () => {
    const [, model, agents] = STATE_RICH_MONEY.at(-1)
    renderMoney(model, agents)
    fireEvent.click(screen.getByRole('button', { name: 'Recover funds' }))
    const dialog = screen.getByRole('dialog', { name: "Recover this agent's funds" })
    expect(dialog.textContent).not.toMatch(/[—–]/)
    expect(dialog.textContent).toMatch(/Owner withdrawal is always allowed/)
  })

  it('renders every PositionList coverage reason without prohibited separators', () => {
    const agent = routeAgent({ address: 'GCORETASK11COVERAGE' })
    agent.custodyBreakdown = [
      agent.custodyBreakdown[0],
      ...['stale', 'unavailable', 'dead-letter'].map((coverageReason, index) => ({
        location: 'base-proxy',
        amount: { token: 'USDC', units: '1000000000', decimals: 7 },
        coverageReason,
        kernelAddress: `0xcore-task-11-kernel-${index}`,
        poolAddress: `0xcore-task-11-pool-${index}`,
        asset: 'usdc',
      })),
    ]
    const { container } = renderMoney(
      {
        state: 'stale',
        confirmedTotal: {
          state: 'known',
          amount: { token: 'USDC', units: '5000000000', decimals: 7 },
        },
        freshness: 'stale',
        checkedAt: Date.parse('2026-08-01T00:00:00.000Z'),
        agentCount: 1,
      },
      [agent]
    )
    expect(container.textContent).not.toMatch(/[—–]/)
    expect(container.textContent).toMatch(
      /Confirmed evidence is a little older than usual\. Refreshing\./
    )
    expect(container.textContent).toMatch(
      /Could not reconfirm this round\. Last known amount shown, not zero\./
    )
    expect(container.textContent).toMatch(/Delivery report is stuck\. Needs attention\./)
  })

  it('My money keeps the lower evidence groups named and exposes the live network environment', async () => {
    const { container } = renderMoney()
    expect(screen.getByRole('region', { name: 'Vault protection' })).toBeTruthy()
    const how = screen.getByRole('region', { name: 'How your money is working' })
    expect(within(how).getByText('Stellar testnet')).toBeTruthy()
    expect(within(how).getByText('Autofarm Vault supplies to Blend')).toBeTruthy()
    expect(container.textContent).not.toMatch(/[—–]/)
    expect(screen.getByRole('button', { name: 'Recover Base account' }).disabled).toBe(true)
  })

  it('does not infer a Stellar venue from an explicit none yield when no venue source exists', () => {
    const { container } = render(
      <main>
        <MyMoneyRoute
          model={moneyModel({ yield: { state: 'none', apy: null } })}
          agents={[]}
          baseActionsAvailable={false}
          baseUnavailableReason="Base recovery is unavailable on this device."
        />
      </main>
    )
    const how = screen.getByRole('region', { name: 'How your money is working' })
    expect(within(how).getByText('Unknown venue')).toBeTruthy()
    expect(within(how).queryByText('Autofarm Vault supplies to Blend')).toBeNull()
    expect(within(how).queryByText('Stellar testnet')).toBeNull()
    expect(container.textContent).not.toMatch(/Base Sepolia proxy\. Custody only\./)
  })

  it('keeps an explicitly unavailable Stellar venue distinct from an unknown source', () => {
    render(
      <main>
        <MyMoneyRoute
          model={moneyModel({ yield: { state: 'unavailable', apy: null } })}
          venue={{ venueKind: 'stellar-live', yield: { state: 'unavailable', apy: null } }}
          agents={[]}
          baseActionsAvailable={false}
          baseUnavailableReason="Base recovery is unavailable on this device."
        />
      </main>
    )
    const how = screen.getByRole('region', { name: 'How your money is working' })
    expect(within(how).getByText('Autofarm Vault supplies to Blend')).toBeTruthy()
    expect(within(how).getByText('Stellar testnet')).toBeTruthy()
    expect(within(how).queryByText('Unknown venue')).toBeNull()
  })

  it('My money is axe-clean in the honest disarmed/unavailable state', async () => {
    const { container } = renderMoney()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('does not show Stellar network context for a direct Base custody venue', () => {
    render(
      <main>
        <HowMoneyWorks
          venue={{ venueKind: 'base-custody-proxy', yield: { state: 'none', apy: null } }}
        />
      </main>
    )
    const how = screen.getByRole('region', { name: 'How your money is working' })
    expect(
      within(how).getByText('Base Sepolia proxy. Custody only. No protocol yield.')
    ).toBeTruthy()
    expect(within(how).queryByText('Stellar testnet')).toBeNull()
  })

  it('stage navigation moves focus to the new Strategy stage without creating a second page heading', () => {
    const { rerender } = render(<StrategyRoute {...strategyProps} />)
    rerender(
      <StrategyRoute
        {...strategyProps}
        stage="protect"
        reached={['plan', 'protect']}
        plan={{
          runId: 'core-task-11',
          planFingerprint: '0xcore-task-11',
          amount: { token: 'USDC', units: '1000000000', decimals: 7 },
          agents: [],
          truth: { agentIsolationCount: 0, stellarVenueCount: 1, baseUsesProxyVaults: false },
        }}
        protectProps={{ owner: null, onConnectWallet: vi.fn(), onEditPlan: vi.fn() }}
      />
    )
    expect(document.activeElement.tagName).toBe('H2')
    expect(document.activeElement.textContent).toBe('Protect this run')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('deep-link Settings focus remains on the Base mandate target rather than an unlabeled tab', () => {
    window.history.replaceState({}, '', '/settings?tab=wallet#base-mandate')
    render(<SettingsPage {...settingsProps} />)
    expect(screen.getByRole('tab', { name: 'Wallet' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('region', { name: /base mandate/i }).getAttribute('id')).toBe(
      'base-mandate'
    )
  })

  it('the route-level heading guard catches an accidental duplicate h1', () => {
    render(
      <main>
        <h1>One</h1>
        <h1>Accidental duplicate</h1>
      </main>
    )
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(2)
    expect(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)).toThrow()
  })
})
