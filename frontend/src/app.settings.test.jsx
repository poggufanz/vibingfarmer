// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryRouter } from 'react-router-dom'

const harness = vi.hoisted(() => ({
  settingsProps: null,
  account: null,
  accountListener: null,
  mandateRecords: new Map(),
  mandateResponses: new Map(),
  getMandateStatus: vi.fn(async () => null),
  checkRelayerHealth: vi.fn(async () => false),
}))

const ACCOUNT_A = `G${'A'.repeat(55)}`
const ACCOUNT_B = `G${'B'.repeat(55)}`
const KERNEL_A = '0x1111111111111111111111111111111111111111'
const SESSION_A = '0x2222222222222222222222222222222222222222'
const activeMandateA = {
  version: 3,
  mandateId: 'aa'.repeat(16),
  stellarOwner: ACCOUNT_A,
  kernelAddress: KERNEL_A,
  sessionKeyAddress: SESSION_A,
  relayerOrigin: 'https://relayer.example',
  validUntilSeconds: 1_800_000_000,
  status: 'active',
  bindingId: 'binding-a',
  bindingHash: 'binding-hash-a',
  reasonCodes: [],
  expected: { chainId: 84532 },
  observed: {
    blockNumber: '101',
    blockHash: `0x${'ab'.repeat(32)}`,
    blockTime: 1_700_000_000,
    implementation: '0x3333333333333333333333333333333333333333',
    permission: { digest: 'permission-a' },
    activation: {
      userOpHash: `0x${'33'.repeat(32)}`,
      txHash: `0x${'44'.repeat(32)}`,
      activatedAt: 1_700_000_000,
    },
  },
  checks: {
    chain: true,
    owner: true,
    kernel: true,
    session: true,
    permission: true,
    policy: true,
    binding: true,
    origin: true,
    implementation: true,
    freshness: true,
    reconstruction: true,
    activation: true,
  },
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

vi.mock('./components/SettingsPage.jsx', async () => {
  const { createElement } = await import('react')
  return {
    default: (props) => {
      harness.settingsProps = props
      return createElement('output', { 'data-testid': 'settings-seam' }, 'settings')
    },
  }
})

vi.mock('./stellar/index.js', () => ({
  connectActiveAccount: vi.fn(async () => harness.account),
  onActiveAccountChange: vi.fn((listener) => {
    harness.accountListener = listener
    return () => {
      if (harness.accountListener === listener) harness.accountListener = null
    }
  }),
  revokeAgentOnChain: vi.fn(),
  subscribeAgentRevoked: vi.fn(() => () => {}),
}))

vi.mock('./stellar/vaultReads.js', () => ({
  readTotalShares: vi.fn(async () => 0n),
  readPricePerShare: vi.fn(async () => null),
  readLifeboatState: vi.fn(async () => null),
}))

vi.mock('./stellar/events.js', () => ({
  queryAgentsByOwner: vi.fn(async () => []),
  discoverAgentsFromHorizon: vi.fn(async () => []),
  discoverAgentsFromVault: vi.fn(async () => []),
}))

vi.mock('./stellar/scopeRehydrate.js', () => ({ rehydrateScopes: vi.fn(async () => []) }))
vi.mock('./stellar/keeperEvents.js', () => ({ fetchKeeperEvents: vi.fn(async () => []) }))
vi.mock('./positionsStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  reconcilePositionsFromChain: vi.fn(async () => null),
}))
vi.mock('./base/dashboardPositions.js', () => ({
  loadDeviceBasePositions: vi.fn(async () => []),
  loadIndexedBasePositions: vi.fn(async () => ({ status: 'empty', accounts: [] })),
}))
vi.mock('./base/readPositions.js', () => ({ readIdleUsdc: vi.fn() }))
vi.mock('./money/readOwnerMoney.js', () => ({
  readOwnerMoney: vi.fn(async () => ({ status: 'complete', owner: null, agents: [] })),
  aggregateOwnerPositions: vi.fn(() => []),
}))
vi.mock('./stellar/ownerDiscovery.js', () => ({ discoverOwnerScopes: vi.fn() }))
vi.mock('./stellar/partialWithdraw.js', () => ({
  ensureExitSigner: vi.fn(),
  partialWithdraw: vi.fn(),
}))
vi.mock('./stellar/exit.js', () => ({ sweepAgents: vi.fn() }))
vi.mock('./base/relayerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getMandateStatus: (...args) => {
    const owner = args[1]?.stellarOwner
    return harness.mandateResponses.has(owner)
      ? harness.mandateResponses.get(owner)
      : harness.getMandateStatus(...args)
  },
}))
vi.mock('./strategy/mergedCatalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  checkRelayerHealth: (...args) => harness.checkRelayerHealth(...args),
}))
vi.mock('./stellar/agentDeposit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readTokenBalance: vi.fn(async () => 0n),
}))
vi.mock('./wallet/baseBinding.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readBaseMandate: vi.fn((owner) => harness.mandateRecords.get(owner) || null),
  }
})
vi.mock('./stellar/agentCreatorManifest.js', () => ({
  isLegacyDirectSetupAllowed: vi.fn(() => false),
}))
vi.mock('./strategy/vaultFactsLive.js', () => ({ primeVaultFacts: vi.fn(async () => {}) }))
vi.mock('./strategy/councilReview.js', () => ({
  buildCouncilInput: vi.fn(() => ({})),
  councilReview: vi.fn(async () => ({ verdict: 'keep', resolvedBy: 'test', citedRules: [] })),
  buildDebateInput: vi.fn(() => ({})),
  councilDebate: vi.fn(async () => ({ verdict: 'keep', citedRules: [] })),
}))
vi.mock('./cctp/resumeTransfers.js', () => ({ resumePendingCctpTransfers: vi.fn(async () => {}) }))
vi.mock('./wallet/passkeyBridge.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureBaseOwner: vi.fn(),
}))
vi.mock('./screens/Withdraw.jsx', () => ({ default: () => null }))

import App from './app.jsx'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('yv_onboarded', 'true')
  localStorage.setItem('yv_skip_landing', 'true')
  harness.settingsProps = null
  harness.accountListener = null
  harness.mandateRecords = new Map()
  harness.mandateResponses = new Map()
  harness.getMandateStatus.mockReset().mockResolvedValue(null)
  harness.checkRelayerHealth.mockReset().mockResolvedValue(false)
  harness.account = {
    version: 1,
    kind: 'G',
    address: ACCOUNT_A,
    connectorId: 'freighter',
    epoch: 9,
  }
})

afterEach(() => cleanup())

function renderApp(path = '/settings') {
  return render(
    <MemoryRouter
      initialEntries={[path]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <App />
    </MemoryRouter>
  )
}

describe('App Settings composition seam', () => {
  it('passes the app-owned Base view/status values and guarded refresh to Settings', async () => {
    renderApp('/settings')

    await waitFor(() => expect(harness.settingsProps).not.toBeNull())

    expect(harness.settingsProps).toMatchObject({
      mandateView: null,
      connected: false,
      busy: false,
      error: null,
      onSetup: expect.any(Function),
      onRefresh: expect.any(Function),
    })
    expect(harness.settingsProps).not.toHaveProperty('onRenew')
    expect(harness.settingsProps).not.toHaveProperty('onBaseRevoke')
  })

  it('invokes the guarded refresh with the captured account and ignores stale completion after a switch', async () => {
    renderApp('/settings')

    await waitFor(() => expect(harness.accountListener).toEqual(expect.any(Function)))
    harness.mandateRecords.set(ACCOUNT_A, { mandateId: 'mandate-a', kernelAddress: KERNEL_A })

    await act(async () => {
      harness.accountListener(harness.account)
    })
    await waitFor(() => expect(harness.settingsProps?.connected).toBe(true))

    const pendingA = deferred()
    harness.mandateResponses.set(ACCOUNT_A, pendingA.promise)
    const refreshPromise = harness.settingsProps.onRefresh()
    await waitFor(() =>
      expect(harness.getMandateStatus).toHaveBeenCalledWith(
        'mandate-a',
        expect.objectContaining({ stellarOwner: ACCOUNT_A, kernelAddress: KERNEL_A })
      )
    )

    await act(async () => {
      harness.accountListener({ ...harness.account, address: ACCOUNT_B, epoch: 10 })
    })
    await waitFor(() => expect(harness.settingsProps?.mandateView?.status).toBe('missing'))

    pendingA.resolve(activeMandateA)
    await expect(refreshPromise).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
    expect(harness.settingsProps.mandateView?.status).toBe('missing')
    expect(harness.settingsProps.mandateView?.stellarOwner).not.toBe(ACCOUNT_A)
  })

  it('keeps the Settings refresh bridge explicitly bound to the active account seam', async () => {
    const source = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'app.jsx'),
      'utf8'
    )
    expect(source).toMatch(/onRefresh=\{\(\) => refreshBaseView\(activeAccount\)\}/)
    expect(source).not.toMatch(/onRefresh=\{\(\) => refreshBaseView\(\)\}/)
  })

  it('does not mount the Settings Base manager on Home or Crew routes', async () => {
    const home = renderApp('/home')
    await waitFor(() => expect(screen.queryByTestId('settings-seam')).toBeNull())
    expect(screen.queryByText('Base Mandate')).toBeNull()
    home.unmount()

    renderApp('/agent')
    await waitFor(() => expect(screen.queryByTestId('settings-seam')).toBeNull())
    expect(screen.queryByText('Base Mandate')).toBeNull()

    const strategy = renderApp('/strategy')
    await waitFor(() => expect(screen.queryByTestId('settings-seam')).toBeNull())
    expect(screen.queryByText('Base Mandate')).toBeNull()
    strategy.unmount()
  })
})
