// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const mountedHarness = vi.hoisted(() => ({
  accountListener: null,
  initialAccount: null,
  routeProps: null,
  crewRouteProps: null,
  sidebarProps: null,
  moneyRouteProps: null,
  withdrawDialogProps: null,
  stopAccessDialogProps: null,
  recoveryPanelProps: null,
  renderRealMoneyRoute: false,
  baseWithdrawScreenMount: null,
  orchestratorConfig: null,
  dispatch: null,
  movement: null,
}))

const cctpRecovery = vi.hoisted(() => ({
  resume: vi.fn(),
}))

vi.mock('./components.jsx', async (importOriginal) => {
  const actual = await importOriginal()
  const { createElement } = await import('react')
  return {
    ...actual,
    Sidebar: (props) => {
      mountedHarness.sidebarProps = props
      return createElement(actual.Sidebar, props)
    },
  }
})

vi.mock('./stellar/index.js', () => ({
  connectActiveAccount: vi.fn(async () => mountedHarness.initialAccount),
  onActiveAccountChange: vi.fn((listener) => {
    mountedHarness.accountListener = listener
    return () => {
      if (mountedHarness.accountListener === listener) mountedHarness.accountListener = null
    }
  }),
  revokeAgentOnChain: vi.fn(),
  subscribeAgentRevoked: vi.fn(() => () => {}),
}))

vi.mock('./cctp/resumeTransfers.js', () => ({
  resumePendingCctpTransfers: (...args) => cctpRecovery.resume(...args),
}))

vi.mock('./components/strategy/StrategyRoute.jsx', async () => {
  const { createElement } = await import('react')
  return {
    StrategyRoute: (props) => {
      mountedHarness.routeProps = props
      return createElement(
        'output',
        { 'data-testid': 'mounted-app-state' },
        JSON.stringify({
          stage: props.stage,
          eventNames: props.startProps?.events?.map((event) => event.name) || [],
          hasReceipt: Boolean(props.startProps?.receipt),
          owner: props.protectProps?.owner || null,
        })
      )
    },
  }
})

vi.mock('./components/money/MyMoneyRoute.jsx', async (importOriginal) => {
  const actual = await importOriginal()
  const { createElement } = await import('react')
  return {
    MyMoneyRoute: (props) => {
      mountedHarness.moneyRouteProps = props
      if (mountedHarness.renderRealMoneyRoute) return createElement(actual.MyMoneyRoute, props)
      return createElement(
        'output',
        { 'data-testid': 'mounted-money-state' },
        JSON.stringify({ owner: props.account?.address ?? null, agentCount: props.agents.length })
      )
    },
  }
})

vi.mock('./components/crew/CrewRoute.jsx', async () => {
  const { createElement } = await import('react')
  return {
    CrewRoute: (props) => {
      mountedHarness.crewRouteProps = props
      return createElement('output', { 'data-testid': 'mounted-crew-state' }, 'crew')
    },
  }
})

vi.mock('./components/money/WithdrawDialog.jsx', async (importOriginal) => {
  const actual = await importOriginal()
  const { createElement } = await import('react')
  return {
    ...actual,
    WithdrawDialog: (props) => {
      mountedHarness.withdrawDialogProps = props
      return createElement(actual.WithdrawDialog, props)
    },
  }
})

vi.mock('./components/money/StopAccessDialog.jsx', async (importOriginal) => {
  const actual = await importOriginal()
  const { createElement } = await import('react')
  return {
    ...actual,
    StopAccessDialog: (props) => {
      mountedHarness.stopAccessDialogProps = props
      return createElement(actual.StopAccessDialog, props)
    },
  }
})

vi.mock('./components/money/RecoveryPanel.jsx', async (importOriginal) => {
  const actual = await importOriginal()
  const { createElement } = await import('react')
  return {
    ...actual,
    RecoveryPanel: (props) => {
      mountedHarness.recoveryPanelProps = props
      return createElement(actual.RecoveryPanel, props)
    },
  }
})

// The production manifest hashes frozen JSON at module load, which currently fails in this
// suite's jsdom realm with `expected Uint8Array`. Keep that static-data boundary inert here; the
// App/orchestrator behavior under test does not consult legacy direct-setup policy.
vi.mock('./stellar/agentCreatorManifest.js', () => ({
  isLegacyDirectSetupAllowed: vi.fn(() => false),
}))

vi.mock('./orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    OrchestratorAgent: class {
      constructor(config) {
        mountedHarness.orchestratorConfig = config
      }
      dispatch() {
        mountedHarness.movement.grant()
        mountedHarness.movement.pull()
        mountedHarness.movement.burn()
        mountedHarness.movement.farmPost()
        return mountedHarness.dispatch.promise
      }
    },
  }
})

vi.mock('./strategy/reusePreflight.js', async (importOriginal) => ({
  ...(await importOriginal()),
  preflightPermission: vi.fn(async (input) => ({
    mode: 'fresh',
    runId: input.runId,
    planFingerprint: input.planFingerprint,
    reviewedAgentInits: input.agentInits,
    reviewedBudgets: input.reviewedBudgets,
  })),
  toPermissionDecisionView: vi.fn((value) => value),
}))

vi.mock('./stellar/vaultReads.js', () => ({
  readTotalShares: vi.fn(async () => 0n),
  readPricePerShare: vi.fn(async () => null),
  readLifeboatState: vi.fn(async () => null),
}))
vi.mock('./stellar/lifeboat.js', async (importOriginal) => ({
  ...(await importOriginal()),
  grantMandate: vi.fn(async () => ({ hash: 'HMANDATE', status: 'SUCCESS' })),
}))
vi.mock('./strategy/vaultFactsLive.js', () => ({ primeVaultFacts: vi.fn(async () => {}) }))
vi.mock('./strategy/councilReview.js', () => ({
  buildCouncilInput: vi.fn(() => ({})),
  councilReview: vi.fn(async () => ({ verdict: 'keep', resolvedBy: 'test', citedRules: [] })),
  buildDebateInput: vi.fn(() => ({})),
  councilDebate: vi.fn(async () => ({ verdict: 'keep', citedRules: [] })),
}))
vi.mock('./stellar/events.js', () => ({
  queryAgentsByOwner: vi.fn(async () => []),
  discoverAgentsFromHorizon: vi.fn(async () => []),
  discoverAgentsFromVault: vi.fn(async () => []),
}))
vi.mock('./stellar/scopeRehydrate.js', () => ({ rehydrateScopes: vi.fn(async () => []) }))
vi.mock('./base/dashboardPositions.js', () => ({
  loadDeviceBasePositions: vi.fn(async () => []),
  loadIndexedBasePositions: vi.fn(async () => []),
}))
vi.mock('./base/readPositions.js', () => ({
  readIdleUsdc: vi.fn(),
}))
vi.mock('./wallet/passkeyBridge.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureBaseOwner: vi.fn(),
}))
vi.mock('./screens/Withdraw.jsx', async () => {
  const { createElement } = await import('react')
  return {
    default: () => {
      mountedHarness.baseWithdrawScreenMount?.()
      return createElement('output', { 'data-testid': 'base-withdraw-screen' })
    },
  }
})
vi.mock('./stellar/keeperEvents.js', () => ({ fetchKeeperEvents: vi.fn(async () => []) }))
vi.mock('./positionsStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  reconcilePositionsFromChain: vi.fn(async () => null),
}))
vi.mock('./stellar/ownerDiscovery.js', () => ({
  discoverOwnerScopes: vi.fn(),
}))
vi.mock('./money/readOwnerMoney.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readOwnerMoney: vi.fn(),
}))
vi.mock('./stellar/partialWithdraw.js', () => ({
  ensureExitSigner: vi.fn(),
  partialWithdraw: vi.fn(),
}))
vi.mock('./stellar/exit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sweepAgents: vi.fn(),
}))
vi.mock('./base/relayerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getMandateStatus: vi.fn(),
}))
vi.mock('./wallet/baseBinding.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readBaseMandate: vi.fn((...args) => actual.readBaseMandate(...args)),
  }
})
vi.mock('./mergeFlowHelpers.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    buildBaseLegContext: vi.fn((...args) => actual.buildBaseLegContext(...args)),
  }
})
vi.mock('./strategy/mergedCatalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  checkRelayerHealth: vi.fn(async () => true),
}))
vi.mock('./stellar/agentDeposit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readTokenBalance: vi.fn(async () => 10n),
}))

import App, {
  createActiveAccountEpochStore,
  createEpochBoundRun,
  composeV3Decision,
} from './app.jsx'
import { bindBaseLegCustodyDeps, reconcileBaseLegEpochCustody } from './orchestrator.js'
import { normalizeStrategyPlan } from './strategy/planModel.js'
import { preflightPermission } from './strategy/reusePreflight.js'
import { discoverOwnerScopes } from './stellar/ownerDiscovery.js'
import { readOwnerMoney } from './money/readOwnerMoney.js'
import { ensureExitSigner, partialWithdraw } from './stellar/partialWithdraw.js'
import { sweepAgents } from './stellar/exit.js'
import { revokeAgentOnChain } from './stellar/index.js'
import { getMandateStatus } from './base/relayerClient.js'
import { baseMandateStorageKey, readBaseMandate } from './wallet/baseBinding.js'
import { buildBaseLegContext } from './mergeFlowHelpers.js'
import { BASE_POOL_CATALOG } from './config.js'
import { readLifeboatState } from './stellar/vaultReads.js'
import { grantMandate } from './stellar/lifeboat.js'
import { loadDeviceBasePositions, loadIndexedBasePositions } from './base/dashboardPositions.js'
import { readIdleUsdc } from './base/readPositions.js'
import { ensureBaseOwner } from './wallet/passkeyBridge.js'
import { connectActiveAccount } from './stellar/index.js'

const G = Object.freeze({
  version: 1,
  kind: 'G',
  address: `G${'A'.repeat(55)}`,
  networkPassphrase: 'Test SDF Network ; September 2015',
  connectorId: 'freighter',
  epoch: 1,
})
const C = Object.freeze({ ...G, kind: 'C', address: 'COWNER', connectorId: 'vf-wallet', epoch: 2 })
const BASE_KERNEL = `0x${'11'.repeat(20)}`
const BASE_SESSION = '0x1563915e194D8CfBA1943570603F7606A3115508'
const BASE_RELAYER_ORIGIN = 'https://relayer.test'
const BASE_MANDATE_ID = 'ab'.repeat(16)
const BASE_VALID_UNTIL_SECONDS = 2_000_000_000
// Captured from the relayer evaluator with the production 10,000-USDC cap, this test's exact
// 40-USDC allocation, and the producer harness's `0xfeed` encoded calls.
const BASE_PERMISSION_ID = '0x4086748b'
const BASE_IMPLEMENTATION = '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D'
const BASE_ECDSA_SIGNER = '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF'
const BASE_CALL_POLICY = '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2'
const BASE_TIMESTAMP_POLICY = '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F'
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const BASE_ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d'
const BASE_POLICY_DATA = [
  `0x0000${BASE_CALL_POLICY.slice(2)}`,
  `0x0000${BASE_TIMESTAMP_POLICY.slice(2)}`,
]

function discoveryWith(rows = []) {
  return {
    status: 'complete',
    owner: G.address,
    networkId: 'stellar-testnet',
    checkedAt: Date.now(),
    agents: rows,
  }
}

function moneyReads(agents = []) {
  return {
    status: 'complete',
    owner: G.address,
    checkedAt: Date.now(),
    source: 'agent-index',
    agents,
    stellarSubtotalUnits: agents.reduce((sum, agent) => sum + BigInt(agent.amount.units), 0n),
    baseSubtotalUnits: 0n,
    baseIdle: [],
    stellarYield: { state: agents.length ? 'unavailable' : 'none', apy: null },
  }
}

function activeBaseWireEvidence() {
  return {
    version: 3,
    mandateId: BASE_MANDATE_ID,
    status: 'active',
    reasonCodes: [],
    stellarOwner: G.address,
    kernelAddress: BASE_KERNEL,
    relayerOrigin: BASE_RELAYER_ORIGIN,
    sessionKeyAddress: BASE_SESSION,
    bindingId: 'binding-test',
    bindingHash: '761ae6f804c1c9774dc3d91678a4752f46259cb6ffa346c996bef372675c0725',
    validUntilSeconds: BASE_VALID_UNTIL_SECONDS,
    expected: {
      chainId: 84532,
      relayerOrigin: BASE_RELAYER_ORIGIN,
      kernelImplementation: BASE_IMPLEMENTATION,
      kernelVersion: '0.3.1',
      entryPointVersion: '0.7',
      entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      policyContracts: {
        call: BASE_CALL_POLICY,
        timestamp: BASE_TIMESTAMP_POLICY,
        signer: BASE_ECDSA_SIGNER,
      },
      allowedCalls: [
        { target: BASE_USDC, selector: '0x095ea7b3' },
        { target: BASE_ROUTER, selector: '0x0efe6a8b' },
      ],
      executionHorizonSeconds: 2700,
      observationMaxAgeSeconds: 12,
      owner: G.address,
      kernelAddress: BASE_KERNEL,
      sessionKeyAddress: BASE_SESSION,
      permissionId: BASE_PERMISSION_ID,
      policyDigest: 'fde7fc639b0f3b04ed2722c20868f2b2c06707d8b3e56398f7bc6f3b35c65ffa',
      bindingId: 'binding-test',
      bindingHash: '761ae6f804c1c9774dc3d91678a4752f46259cb6ffa346c996bef372675c0725',
      validUntilSeconds: BASE_VALID_UNTIL_SECONDS,
    },
    observed: {
      blockNumber: '101',
      blockHash: `0x${'ab'.repeat(32)}`,
      blockTime: Date.now() - 1000,
      chainId: 84532,
      implementation: BASE_IMPLEMENTATION,
      permission: {
        permissionId: BASE_PERMISSION_ID,
        permissionFlag: '0x0000',
        signer: BASE_ECDSA_SIGNER,
        policyData: BASE_POLICY_DATA,
        digest: '3570159502324ec8b94b984b62452c9fc026c937bffde96e83472c2d4d26655f',
      },
      activation: {
        userOpHash: `0x${'33'.repeat(32)}`,
        txHash: `0x${'44'.repeat(32)}`,
        activatedAt: Math.floor(Date.now() / 1000) - 10,
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

async function prepareLargeOwnerActionRead() {
  const { readOwnerMoney: actualReadOwnerMoney } = await vi.importActual(
    './money/readOwnerMoney.js'
  )
  const agentAddress = 'CAGENT1'
  const amount = { token: 'USDC', units: '10000000000000000', decimals: 7 }
  const visibleAgent = {
    address: agentAddress,
    amount,
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [{ location: 'stellar-vault', amount }],
    executionStatus: 'confirmed',
    problems: [],
  }
  const rows = Array.from({ length: 501 }, (_, index) => ({
    address: index === 0 ? agentAddress : `COLD${String(index).padStart(3, '0')}`,
    scopeReadStatus: 'ok',
    vault: 'CVAULT',
    revoked: false,
    expiry: 9_999_999_999,
    authorized: true,
    association: 'unknown',
    baseChildren: [],
  }))
  const started = []
  let actionPhase = false
  let readBarrier = null
  const rpc = async () => {
    started.push(started.length)
    return 0n
  }

  discoverOwnerScopes.mockResolvedValue(discoveryWith(rows))
  readOwnerMoney.mockImplementation(async (args) => {
    if (!actionPhase || args.owner !== G.address) return moneyReads([visibleAgent])
    if (readBarrier) await readBarrier
    return actualReadOwnerMoney({
      ...args,
      stellar: {
        readVaultShares: rpc,
        readTokenBalance: rpc,
        readPricePerShare: rpc,
        readSupplyAprBps: async () => null,
      },
      base: {
        loadIndexedBasePositions: async () => ({ status: 'empty', accounts: [] }),
      },
    })
  })

  return {
    agentAddress,
    visibleAgent,
    started,
    beginActionReads() {
      actionPhase = true
    },
    holdActionReads(promise) {
      readBarrier = promise
    },
  }
}

function renderMoneyApp() {
  return render(
    <MemoryRouter
      initialEntries={['/home']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <App />
    </MemoryRouter>
  )
}

function mountedState() {
  return JSON.parse(screen.getByTestId('mounted-app-state').textContent)
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('yv_onboarded', 'true')
  localStorage.setItem('yv_skip_landing', 'true')
  mountedHarness.accountListener = null
  mountedHarness.initialAccount = G
  mountedHarness.routeProps = null
  mountedHarness.crewRouteProps = null
  mountedHarness.sidebarProps = null
  mountedHarness.moneyRouteProps = null
  mountedHarness.withdrawDialogProps = null
  mountedHarness.stopAccessDialogProps = null
  mountedHarness.recoveryPanelProps = null
  mountedHarness.renderRealMoneyRoute = false
  mountedHarness.baseWithdrawScreenMount = vi.fn()
  mountedHarness.orchestratorConfig = null
  mountedHarness.dispatch = deferred()
  mountedHarness.movement = {
    grant: vi.fn(),
    pull: vi.fn(),
    burn: vi.fn(),
    farmPost: vi.fn(),
  }
  discoverOwnerScopes.mockReset().mockResolvedValue(discoveryWith())
  readOwnerMoney.mockReset().mockResolvedValue(moneyReads())
  ensureExitSigner.mockReset().mockResolvedValue({ publicKey: 'GEXIT' })
  partialWithdraw.mockReset().mockResolvedValue({
    redeemed: 9007199254740993n,
    redeemHash: 'HREDEEM',
    transferHash: 'HTRANSFER',
  })
  sweepAgents.mockReset().mockResolvedValue({ errors: [], txHashes: [] })
  revokeAgentOnChain.mockReset().mockResolvedValue({ status: 'SUCCESS', hash: 'HREVOKE' })
  getMandateStatus.mockReset().mockResolvedValue(null)
  readLifeboatState.mockReset().mockResolvedValue(null)
  grantMandate.mockClear()
  loadDeviceBasePositions.mockReset().mockResolvedValue([])
  loadIndexedBasePositions.mockReset().mockResolvedValue({ status: 'empty', accounts: [] })
  readIdleUsdc.mockReset()
  ensureBaseOwner.mockReset()
  readBaseMandate.mockClear()
  buildBaseLegContext.mockClear()
  cctpRecovery.resume.mockReset().mockResolvedValue({
    owner: G.address,
    resumed: [],
    held: [],
    terminal: [],
    uncertain: [],
    blocked: [],
  })
})

afterEach(() => cleanup())

describe('active account application state', () => {
  it('starts CCTP recovery only after installing the restored owner, with read-only narrow dependencies', async () => {
    const restore = deferred()
    connectActiveAccount.mockReturnValueOnce(restore.promise)

    renderMoneyApp()
    expect(cctpRecovery.resume).not.toHaveBeenCalled()

    await act(async () => {
      restore.resolve(G)
      await restore.promise
    })
    await waitFor(() => expect(mountedHarness.moneyRouteProps?.account?.address).toBe(G.address))
    await waitFor(() => expect(cctpRecovery.resume).toHaveBeenCalledTimes(1))

    const [owner, options] = cctpRecovery.resume.mock.calls[0]
    expect(owner).toBe(G.address)
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.reconcileUnwindUserOp).toBeTypeOf('function')
    expect(Object.keys(options).sort()).toEqual([
      'pollForwardStatus',
      'pollUnwindStatus',
      'postFarmAttach',
      'postFarmIntent',
      'postUnwindAttach',
      'reconcileUnwindUserOp',
      'signal',
    ])
    for (const forbidden of [
      'account',
      'sign',
      'wallet',
      'passkey',
      'kernel',
      'capability',
      'sendUserOperation',
    ]) {
      expect(options).not.toHaveProperty(forbidden)
    }
  })

  it('aborts recovery for a replaced owner and App teardown while giving the new owner its own scan', async () => {
    const view = renderMoneyApp()
    await waitFor(() => expect(cctpRecovery.resume).toHaveBeenCalledTimes(1))
    const firstSignal = cctpRecovery.resume.mock.calls[0][1].signal

    await act(async () => mountedHarness.accountListener(C))
    await waitFor(() => expect(cctpRecovery.resume).toHaveBeenCalledTimes(2))
    const secondCall = cctpRecovery.resume.mock.calls[1]
    expect(firstSignal.aborted).toBe(true)
    expect(secondCall[0]).toBe(C.address)
    expect(secondCall[1].signal.aborted).toBe(false)

    view.unmount()
    expect(secondCall[1].signal.aborted).toBe(true)
  })

  it('keeps real /home Base history visible but every unavailable withdraw/recovery entry inert', async () => {
    mountedHarness.renderRealMoneyRoute = true
    const amount = { token: 'USDC', units: '50000000', decimals: 7 }
    const agentAddress = `C${'B'.repeat(55)}`
    const agentPool = '0x1111111111111111111111111111111111111112'
    const historyPool = '0x1111111111111111111111111111111111111113'
    const historyOnlyMarker = 'Device loader history 8472'
    const historicalPosition = {
      pool: historyPool,
      poolName: historyOnlyMarker,
      shares: 5_500_000n,
      assets: 5_250_000n,
      minAssets: 5_223_750n,
    }
    const agent = {
      address: agentAddress,
      amount,
      custody: { location: 'base-proxy' },
      custodyBreakdown: [
        {
          location: 'base-proxy',
          amount,
          kernelAddress: '0x2222222222222222222222222222222222222222',
          poolAddress: agentPool,
          poolName: 'Agent custody decoy',
          asset: 'USDC',
          coverageReason: null,
        },
      ],
      executionStatus: 'failed',
      problems: ['base-execution-failed'],
    }
    discoverOwnerScopes.mockResolvedValue(
      discoveryWith([{ address: agentAddress, scopeReadStatus: 'ok', revoked: false, expiry: 0 }])
    )
    readOwnerMoney.mockResolvedValue(moneyReads([agent]))
    loadDeviceBasePositions.mockResolvedValue([historicalPosition])

    renderMoneyApp()

    await waitFor(() => expect(mountedHarness.moneyRouteProps?.model?.state).toBe('problem'))
    await waitFor(() =>
      expect(mountedHarness.withdrawDialogProps?.basePlan?.positions).toEqual([historicalPosition])
    )
    expect(loadDeviceBasePositions).toHaveBeenCalledWith({ stellarOwner: G.address })
    const history = screen.getByRole('region', { name: 'Historical Base positions' })
    expect(within(history).getByText(historyOnlyMarker)).toBeTruthy()
    expect(within(history).getByText('5.25 USDC')).toBeTruthy()
    expect(within(history).getByText(/temporarily unavailable/i)).toBeTruthy()
    const recover = screen.getByRole('button', { name: 'Recover Base account' })
    expect(recover.disabled).toBe(true)
    expect(document.getElementById('recover-base-unavailable').textContent).toMatch(
      /temporarily unavailable/i
    )
    fireEvent.click(recover)

    fireEvent.click(screen.getByRole('button', { name: 'Review problem' }))
    const baseTab = await screen.findByRole('tab', { name: /base full unwind/i })
    expect(baseTab.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /withdraw everything from base/i })).toBeNull()
    fireEvent.click(baseTab)

    const baseStorageBefore = Object.keys(localStorage)
      .filter((key) => key.startsWith('vf_base'))
      .sort()
    await act(async () => mountedHarness.moneyRouteProps.onRecoverBase())

    expect(ensureBaseOwner).not.toHaveBeenCalled()
    expect(loadIndexedBasePositions).not.toHaveBeenCalled()
    expect(readIdleUsdc).not.toHaveBeenCalled()
    expect(mountedHarness.baseWithdrawScreenMount).not.toHaveBeenCalled()
    expect(
      Object.keys(localStorage)
        .filter((key) => key.startsWith('vf_base'))
        .sort()
    ).toEqual(baseStorageBefore)
    expect(mountedHarness.withdrawDialogProps.basePlan).toMatchObject({
      available: false,
      positions: [historicalPosition],
    })
  })

  it('builds one unfiltered Crew projection for the route and sidebar without wiring Withdraw', async () => {
    const assignedAddress = `C${'S'.repeat(55)}`
    const pendingAddress = `C${'P'.repeat(55)}`
    const strandedAddress = `C${'F'.repeat(55)}`
    const productiveAmount = { token: 'USDC', units: '1000000000', decimals: 7 }
    const assignedRow = {
      address: assignedAddress,
      creator: 'CINDEXCREATOR',
      createdLedger: 1200,
      createdTxHash: 'create-assigned',
      runId: 'run-assigned',
      runOrdinal: 0,
      provenance: {
        source: 'router-event',
        providerId: 'rpc',
        endpointClass: 'live',
        generation: 'agent-v3',
      },
      discoverySources: ['agent-index-api'],
      scopeReadStatus: 'ok',
      vault: 'CVAULT',
      revoked: false,
      expiry: 0,
      authorized: true,
      baseChildren: [],
    }
    const pendingRow = {
      ...assignedRow,
      address: pendingAddress,
      creator: null,
      createdLedger: null,
      createdTxHash: null,
      runId: null,
      runOrdinal: null,
      provenance: null,
      discoverySources: ['rpc-router-events'],
    }
    const productiveAgent = (address) => ({
      address,
      scope: { state: 'known', value: { vault: 'CVAULT', revoked: false } },
      amount: productiveAmount,
      custody: { location: 'stellar-vault' },
      custodyBreakdown: [{ location: 'stellar-vault', amount: productiveAmount }],
      executionStatus: 'succeeded',
      problems: [],
    })
    const strandedAgent = {
      ...productiveAgent(strandedAddress),
      custody: { location: 'agent' },
      custodyBreakdown: [{ location: 'agent', amount: productiveAmount }],
      executionStatus: 'failed',
    }

    discoverOwnerScopes.mockResolvedValue({
      ...discoveryWith([assignedRow, pendingRow, { ...assignedRow, address: strandedAddress }]),
      status: 'partial',
    })
    readOwnerMoney.mockResolvedValue(
      moneyReads([productiveAgent(assignedAddress), productiveAgent(pendingAddress), strandedAgent])
    )

    render(
      <MemoryRouter
        initialEntries={['/agent']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    )

    await waitFor(() => expect(mountedHarness.crewRouteProps).not.toBeNull())
    await waitFor(() => expect(mountedHarness.crewRouteProps?.crew?.productiveAgentCount).toBe(1))
    const projectedCrew = mountedHarness.crewRouteProps.crew
    expect(projectedCrew.personas).toHaveLength(3)
    expect(projectedCrew.personas[0].children.map((row) => row.agent.address)).toEqual([
      assignedAddress,
    ])
    expect(projectedCrew.pendingAssignments.map((row) => row.agent.address)).toEqual([
      pendingAddress,
    ])
    expect(projectedCrew.personas.flatMap((entry) => entry.children)).not.toContainEqual(
      expect.objectContaining({ agent: expect.objectContaining({ address: strandedAddress }) })
    )
    expect(mountedHarness.sidebarProps.agentCount).toBe(projectedCrew.activeCount)
    expect(mountedHarness.sidebarProps.agentCount).toBe(1)
    expect(mountedHarness.crewRouteProps.onWithdrawAgent).toBeUndefined()
  })

  it('projects owner-wide Base value and coverage changes from the full money envelope', async () => {
    const newerAddress = `C${'N'.repeat(55)}`
    const oldestAddress = `C${'O'.repeat(55)}`
    const discoveryRow = (address, runOrdinal, createdLedger) => ({
      address,
      creator: 'CINDEXCREATOR',
      createdLedger,
      createdTxHash: `create-${runOrdinal}`,
      runId: `run-${runOrdinal}`,
      runOrdinal,
      grantTxHash: `grant-${runOrdinal}`,
      provenance: {
        source: 'router-event',
        providerId: 'rpc',
        endpointClass: 'live',
        generation: 'agent-v3',
      },
      discoverySources: ['agent-index-api'],
      scopeReadStatus: 'ok',
      vault: 'CVAULT',
      revoked: false,
      expiry: 0,
      authorized: true,
      baseChildren: [],
    })
    const baseAgent = (address, units) => {
      const amount = { token: 'USDC', units, decimals: 7 }
      return {
        address,
        scope: { state: 'known', value: { vault: 'CVAULT', revoked: false } },
        vaultShares: {
          state: 'known',
          amount: { token: 'USDC', units: '0', decimals: 7 },
        },
        idleToken: {
          state: 'known',
          amount: { token: 'USDC', units: '0', decimals: 7 },
        },
        amount,
        custody: { location: 'base-proxy' },
        custodyBreakdown: [
          {
            location: 'base-proxy',
            amount,
            kernelAddress: '0xKeRnEl',
            poolAddress: '0xPoOl',
            asset: 'USDC',
            coverageReason: null,
          },
        ],
        executionStatus: 'succeeded',
        problems: [],
      }
    }
    const agents = [baseAgent(newerAddress, '300000000'), baseAgent(oldestAddress, '700000000')]
    const envelope = (units, groupState, coverage) => ({
      ...moneyReads(agents),
      networkId: 'stellar-testnet',
      stellarSubtotalUnits: 0n,
      baseSubtotalUnits: BigInt(units),
      baseGroups: [
        {
          groupKey: '84532:0xkernel:0xpool:usdc',
          kernelAddress: '0xkernel',
          poolAddress: '0xpool',
          asset: 'usdc',
          amount: { token: 'USDC', units, decimals: 7 },
          coverage: {
            state: groupState,
            problems: groupState === 'complete' ? [] : ['base-read-unavailable'],
          },
        },
      ],
      associationCoverage: coverage,
      baseSourceCoverage: { state: 'complete' },
      basePositionCoverage:
        groupState === 'complete'
          ? { state: 'complete', reasons: [] }
          : { state: 'unknown', reasons: ['unavailable'] },
    })

    discoverOwnerScopes.mockResolvedValue(
      discoveryWith([discoveryRow(newerAddress, 0, 200), discoveryRow(oldestAddress, 1, 100)])
    )
    readOwnerMoney
      .mockReset()
      .mockResolvedValueOnce(
        envelope('1000000000', 'partial', {
          state: 'unknown',
          reasons: ['unavailable'],
        })
      )
      // Reuse the exact same agents array: only owner-wide value/coverage changes. This catches a
      // Crew memo keyed solely on moneyRead.agents as well as an App that drops the envelope.
      .mockResolvedValue(envelope('1250000000', 'complete', { state: 'complete', reasons: [] }))

    render(
      <MemoryRouter
        initialEntries={['/agent']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    )

    await waitFor(() =>
      expect(mountedHarness.crewRouteProps?.crew?.totals).toEqual([
        { token: 'USDC', units: '1000000000', decimals: 7 },
      ])
    )
    expect(mountedHarness.crewRouteProps.crew.status).toBe('partial')
    expect(mountedHarness.sidebarProps.agentCount).toBe(
      mountedHarness.crewRouteProps.crew.activeCount
    )

    await act(async () => {
      await mountedHarness.withdrawDialogProps.onConfirmPartial({
        ok: true,
        mode: 'partial',
        agentAddress: newerAddress,
        amount: { token: 'USDC', units: '1', decimals: 7 },
      })
    })

    await waitFor(() =>
      expect(mountedHarness.crewRouteProps?.crew?.totals).toEqual([
        { token: 'USDC', units: '1250000000', decimals: 7 },
      ])
    )
    expect(mountedHarness.crewRouteProps.crew.status).toBe('complete')
    expect(mountedHarness.sidebarProps.agentCount).toBe(
      mountedHarness.crewRouteProps.crew.activeCount
    )
  })

  it('starts an owner action after React StrictMode replays mount effects', async () => {
    render(
      <React.StrictMode>
        <MemoryRouter
          initialEntries={['/home']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <App />
        </MemoryRouter>
      </React.StrictMode>
    )
    await waitFor(() =>
      expect(mountedHarness.withdrawDialogProps?.account).toEqual({
        kind: G.kind,
        address: G.address,
      })
    )

    let actionPromise
    await act(async () => {
      actionPromise = mountedHarness.withdrawDialogProps.onConfirmPartial({
        ok: true,
        mode: 'partial',
        agentAddress: 'CAGENT1',
        amount: { token: 'USDC', units: '10000000', decimals: 7 },
      })
      await expect(actionPromise).resolves.toBeUndefined()
    })

    expect(partialWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: G.address,
        agentAddress: 'CAGENT1',
        activeAccount: G,
      })
    )
  })

  it('projects a renewed lifeboat expiry into the mounted money model', async () => {
    let lifeboat = {
      derisked: false,
      mandateExpiry: Math.floor(Date.now() / 1000) - 60,
      authority: G.address,
    }
    const mandateExpiry = Math.floor(Date.now() / 1000) + 86_400
    readLifeboatState.mockImplementation(async () => lifeboat)

    render(
      <MemoryRouter
        initialEntries={['/home']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    )

    await waitFor(() =>
      expect(mountedHarness.moneyRouteProps?.model?.protection.state).toBe('disarmed')
    )

    lifeboat = { ...lifeboat, mandateExpiry }
    await act(async () => mountedHarness.moneyRouteProps.onAction('renew-protection'))

    await waitFor(() =>
      expect(mountedHarness.moneyRouteProps?.model?.protection).toMatchObject({
        state: 'armed',
        mandateExpiry,
        ownerIsAuthority: true,
      })
    )
    expect(grantMandate).toHaveBeenCalledWith({ owner: G.address })
  })

  it('clears old-owner review, receipt, Base and My Money state before installing a switched account', () => {
    const clear = vi.fn()
    const store = createActiveAccountEpochStore({ initial: G, clear })

    store.install(C)

    expect(clear).toHaveBeenCalledWith(G)
    expect(store.current()).toBe(C)
  })

  it('rejects stale completions after C→G and C1→C2 transitions', () => {
    const store = createActiveAccountEpochStore({ initial: C, clear: vi.fn() })
    const c1 = store.capture()
    store.install(G)
    expect(() => store.assertCurrent(c1)).toThrow(/active wallet account changed/i)

    const g = store.capture()
    const c2 = Object.freeze({ ...C, address: 'COTHER', epoch: 3 })
    store.install(c2)
    expect(() => store.assertCurrent(g)).toThrow(/active wallet account changed/i)
  })

  it('aborts a running orchestration and drops stale events, completion and error renders', () => {
    let current = G
    const event = vi.fn()
    const completion = vi.fn()
    const failure = vi.fn()
    const run = createEpochBoundRun({ captured: G, getCurrent: () => current, onEvent: event })

    expect(run.onEvent('worker-started', { agentId: 'a1' })).toBe(true)
    current = C
    run.cancel()

    expect(run.signal.aborted).toBe(true)
    expect(run.onEvent('worker-completed', { agentId: 'a1' })).toBe(false)
    expect(run.commit(completion)).toBe(false)
    expect(run.commit(failure)).toBe(false)
    expect(event).toHaveBeenCalledTimes(1)
    expect(completion).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled()
  })

  it('binds Base pull and burn custody boundaries to the captured account', async () => {
    let current = G
    const pull = vi.fn(async () => {
      current = C
      return { hash: 'pull', status: 'SUCCESS' }
    })
    const burn = vi.fn(async () => ({ hash: 'burn', status: 'SUCCESS' }))
    const deps = bindBaseLegCustodyDeps({
      activeAccount: G,
      getCurrentActiveAccount: () => current,
      runAgentPullFn: pull,
      loadRunAgentBurn: async () => burn,
    })

    await expect(deps.runAgentPull({ amount: 1n })).resolves.toMatchObject({
      hash: 'pull',
      status: 'SUCCESS',
    })
    await expect(deps.runAgentBurn({ amount: 1n })).rejects.toMatchObject({
      code: 'ACTIVE_ACCOUNT_CHANGED',
    })
    expect(pull).toHaveBeenCalledOnce()
    expect(burn).not.toHaveBeenCalled()
  })

  it('preserves unknown Base custody when a pull response is not confirmation', async () => {
    const unknown = Object.assign(new Error('pull outcome unknown'), {
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      custody: { location: 'unknown', confirmed: false },
      result: { hash: 'pull', status: 'PENDING' },
    })
    const deps = bindBaseLegCustodyDeps({
      activeAccount: G,
      getCurrentActiveAccount: () => G,
      runAgentPullFn: vi.fn(async () => {
        throw unknown
      }),
    })

    await expect(deps.runAgentPull({ amount: 1n })).rejects.toBe(unknown)
    const reconciled = reconcileBaseLegEpochCustody(
      {
        success: false,
        custody: { location: 'owner', confirmed: true },
        allocations: [{ custody: { location: 'owner', confirmed: true } }],
      },
      deps
    )
    expect(reconciled.custody).toEqual({ location: 'unknown', confirmed: false })
    expect(reconciled.allocations[0].custody).toEqual({
      location: 'unknown',
      confirmed: false,
    })
  })

  it('preserves unknown Base custody when the burn transport loses its response', async () => {
    const unknown = Object.assign(new Error('burn outcome unknown'), {
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      custody: { location: 'unknown', confirmed: false },
      result: { hash: 'burn-maybe', status: 'PENDING' },
    })
    const deps = bindBaseLegCustodyDeps({
      activeAccount: G,
      getCurrentActiveAccount: () => G,
      loadRunAgentBurn: async () => async () => {
        throw unknown
      },
    })

    await expect(deps.runAgentBurn({ amount: 1n })).rejects.toBe(unknown)
    const reconciled = reconcileBaseLegEpochCustody(
      {
        success: false,
        custody: { location: 'agent', confirmed: true },
        allocations: [{ custody: { location: 'agent', confirmed: true } }],
      },
      deps
    )
    expect(reconciled.custody).toEqual({ location: 'unknown', confirmed: false })
    expect(reconciled.allocations[0].custody).toEqual({
      location: 'unknown',
      confirmed: false,
    })
  })

  it('mounted App carries the real WithdrawDialog raw USDC amount into exact partialWithdraw units', async () => {
    const agentAddress = 'CAGENT1'
    const amount = {
      token: 'USDC',
      units: '10000000000000000',
      decimals: 7,
    }
    const agent = {
      address: agentAddress,
      amount,
      custody: { location: 'stellar-vault' },
      custodyBreakdown: [{ location: 'stellar-vault', amount }],
      executionStatus: 'confirmed',
      problems: [],
    }
    discoverOwnerScopes.mockResolvedValue(
      discoveryWith([{ address: agentAddress, scopeReadStatus: 'ok', revoked: false, expiry: 0 }])
    )
    readOwnerMoney.mockResolvedValue(moneyReads([agent]))

    render(
      <MemoryRouter
        initialEntries={['/home']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    )
    await waitFor(() => expect(mountedHarness.moneyRouteProps?.agents).toEqual([agent]))

    await act(async () => {
      await mountedHarness.moneyRouteProps.onAction('review-problem')
    })
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    expect(screen.getByLabelText(/CAGE.*1/i).parentElement.textContent).toMatch(
      /1000000000 USDC available/i
    )

    const input = screen.getByRole('textbox', { name: /amount/i })
    fireEvent.change(input, { target: { value: '0900719925.4740993' } })
    expect(input.value).toBe('0900719925.4740993')
    fireEvent.click(screen.getByRole('button', { name: /withdraw this amount/i }))

    await waitFor(() => expect(partialWithdraw).toHaveBeenCalledOnce())
    expect(ensureExitSigner).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: G.address,
        agentAddress,
        activeAccount: G,
        getCurrentActiveAccount: expect.any(Function),
      })
    )
    const request = partialWithdraw.mock.calls[0][0]
    expect(request).toMatchObject({
      owner: G.address,
      agentAddress,
      amountUnits: 9007199254740993n,
      activeAccount: G,
      getCurrentActiveAccount: expect.any(Function),
    })
    // The real dialog selected a confirmed USDC vault leg above. App intentionally supplies no
    // token override here, so partialWithdraw keeps its production SOROBAN_TOKEN_ADDRESS default.
    expect(request).not.toHaveProperty('token')
    expect(request.getCurrentActiveAccount()).toBe(G)
  })

  it('aborts a 501-row action reconciliation on account replacement before queued RPCs start', async () => {
    const { readOwnerMoney: actualReadOwnerMoney } = await vi.importActual(
      './money/readOwnerMoney.js'
    )
    const agentAddress = 'CAGENT1'
    const amount = { token: 'USDC', units: '10000000000000000', decimals: 7 }
    const visibleAgent = {
      address: agentAddress,
      amount,
      custody: { location: 'stellar-vault' },
      custodyBreakdown: [{ location: 'stellar-vault', amount }],
      executionStatus: 'confirmed',
      problems: [],
    }
    const rows = Array.from({ length: 501 }, (_, index) => ({
      address: index === 0 ? agentAddress : `COLD${String(index).padStart(3, '0')}`,
      scopeReadStatus: 'ok',
      vault: 'CVAULT',
      revoked: false,
      expiry: 9_999_999_999,
      authorized: true,
      association: 'unknown',
      baseChildren: [],
    }))
    const gates = Array.from({ length: 8 }, deferred)
    const started = []
    let actionPhase = false
    let oldReadSettled = false
    const heldRpc = async () => {
      const index = started.length
      started.push(index)
      if (index < gates.length) await gates[index].promise
      return 0n
    }

    discoverOwnerScopes.mockResolvedValue(discoveryWith(rows))
    readOwnerMoney.mockImplementation((args) => {
      if (!actionPhase || args.owner !== G.address)
        return Promise.resolve(moneyReads([visibleAgent]))
      return actualReadOwnerMoney({
        ...args,
        stellar: {
          readVaultShares: heldRpc,
          readTokenBalance: heldRpc,
          readPricePerShare: heldRpc,
          readSupplyAprBps: async () => null,
        },
        base: {
          loadIndexedBasePositions: async () => ({ status: 'empty', accounts: [] }),
        },
      }).finally(() => {
        oldReadSettled = true
      })
    })

    render(
      <MemoryRouter
        initialEntries={['/home']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    )
    await waitFor(() => expect(mountedHarness.moneyRouteProps?.agents).toEqual([visibleAgent]))

    actionPhase = true
    await act(async () => mountedHarness.moneyRouteProps.onAction('review-problem'))
    fireEvent.click(screen.getByRole('tab', { name: /partial/i }))
    fireEvent.click(await screen.findByLabelText(/CAGE.*1/i))
    fireEvent.change(screen.getByRole('textbox', { name: /amount/i }), {
      target: { value: '1' },
    })
    fireEvent.click(screen.getByRole('button', { name: /withdraw this amount/i }))

    await waitFor(() => expect(started).toHaveLength(8))
    await act(async () => mountedHarness.accountListener(C))
    for (const gate of gates) gate.resolve()
    await waitFor(() => expect(oldReadSettled).toBe(true))

    expect(started).toHaveLength(8)
    expect(mountedHarness.moneyRouteProps.account.address).toBe(C.address)
  })

  it('uses the partial action epoch when a switch happens before VF_SUBMISSION_UNKNOWN', async () => {
    const probe = await prepareLargeOwnerActionRead()
    const withdraw = deferred()
    const unknown = Object.assign(new Error('withdraw response was lost'), {
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
    })
    partialWithdraw.mockReturnValueOnce(withdraw.promise)
    renderMoneyApp()
    await waitFor(() =>
      expect(mountedHarness.moneyRouteProps?.agents).toEqual([probe.visibleAgent])
    )

    probe.beginActionReads()
    let actionPromise
    await act(async () => {
      actionPromise = mountedHarness.withdrawDialogProps.onConfirmPartial({
        ok: true,
        mode: 'partial',
        agentAddress: probe.agentAddress,
        amount: { token: 'USDC', units: '10000000', decimals: 7 },
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(partialWithdraw).toHaveBeenCalledOnce())

    await act(async () => {
      mountedHarness.accountListener(C)
      withdraw.reject(unknown)
      await actionPromise.catch(() => {})
    })

    expect(probe.started).toHaveLength(0)
  })

  it.each(['full', 'partial', 'revoke'])(
    'does not resume %s action work after App teardown',
    async (kind) => {
      const probe = await prepareLargeOwnerActionRead()
      const pending = deferred()
      if (kind === 'full') sweepAgents.mockReturnValueOnce(pending.promise)
      if (kind === 'partial') partialWithdraw.mockReturnValueOnce(pending.promise)
      if (kind === 'revoke') revokeAgentOnChain.mockReturnValueOnce(pending.promise)

      const view = renderMoneyApp()
      await waitFor(() =>
        expect(mountedHarness.moneyRouteProps?.agents).toEqual([probe.visibleAgent])
      )
      probe.beginActionReads()

      let actionPromise
      await act(async () => {
        if (kind === 'full') {
          actionPromise = mountedHarness.withdrawDialogProps.onConfirmFull({
            ok: true,
            targets: [{ address: probe.agentAddress }],
          })
        } else if (kind === 'partial') {
          actionPromise = mountedHarness.withdrawDialogProps.onConfirmPartial({
            ok: true,
            mode: 'partial',
            agentAddress: probe.agentAddress,
            amount: { token: 'USDC', units: '10000000', decimals: 7 },
          })
        } else {
          actionPromise = mountedHarness.stopAccessDialogProps.onConfirmRevoke({
            ok: true,
            agentAddress: probe.agentAddress,
          })
        }
        await Promise.resolve()
      })
      const pendingMock =
        kind === 'full' ? sweepAgents : kind === 'partial' ? partialWithdraw : revokeAgentOnChain
      await waitFor(() => expect(pendingMock).toHaveBeenCalledOnce())

      const storageSet = vi.spyOn(Storage.prototype, 'setItem')
      view.unmount()
      storageSet.mockClear()
      discoverOwnerScopes.mockClear()
      await act(async () => {
        if (kind === 'full') pending.resolve({ errors: [null], txHashes: ['HFULL'] })
        if (kind === 'partial') pending.resolve({ status: 'SUCCESS', hash: 'HPARTIAL' })
        if (kind === 'revoke') pending.resolve({ status: 'SUCCESS', hash: 'HREVOKE' })
        await actionPromise.catch(() => {})
      })

      expect(probe.started).toHaveLength(0)
      expect(discoverOwnerScopes).not.toHaveBeenCalled()
      expect(storageSet).not.toHaveBeenCalled()
      storageSet.mockRestore()
    }
  )

  it('does not refresh, persist, or start RPCs when status reconciliation resumes after teardown', async () => {
    const probe = await prepareLargeOwnerActionRead()
    const unknown = Object.assign(new Error('withdraw response was lost'), {
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
    })
    partialWithdraw.mockRejectedValueOnce(unknown)
    const view = renderMoneyApp()
    await waitFor(() =>
      expect(mountedHarness.moneyRouteProps?.agents).toEqual([probe.visibleAgent])
    )

    await act(async () => {
      await mountedHarness.withdrawDialogProps.onConfirmPartial({
        ok: true,
        mode: 'partial',
        agentAddress: probe.agentAddress,
        amount: { token: 'USDC', units: '10000000', decimals: 7 },
      })
    })
    await waitFor(() => expect(mountedHarness.recoveryPanelProps.open).toBe(true))

    const pendingRead = deferred()
    probe.beginActionReads()
    probe.holdActionReads(pendingRead.promise)
    readOwnerMoney.mockClear()
    let statusPromise
    await act(async () => {
      statusPromise = mountedHarness.recoveryPanelProps.onCheckStatus()
      await Promise.resolve()
    })
    await waitFor(() => expect(readOwnerMoney).toHaveBeenCalledOnce())

    const storageSet = vi.spyOn(Storage.prototype, 'setItem')
    view.unmount()
    storageSet.mockClear()
    discoverOwnerScopes.mockClear()
    await act(async () => {
      pendingRead.resolve()
      await statusPromise.catch(() => {})
    })

    expect(probe.started).toHaveLength(0)
    expect(discoverOwnerScopes).not.toHaveBeenCalled()
    expect(storageSet).not.toHaveBeenCalled()
    storageSet.mockRestore()
  })

  it('gates a crafted reviewed bridge before mandate/storage/context/orchestrator work when Base is unavailable', async () => {
    const reviewedEvidence = activeBaseWireEvidence()
    getMandateStatus.mockImplementation(async () => reviewedEvidence)
    localStorage.setItem(baseMandateStorageKey(G.address), JSON.stringify(reviewedEvidence))

    render(
      <MemoryRouter
        initialEntries={['/strategy']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    )
    await waitFor(() => expect(mountedHarness.routeProps?.base?.mandateView?.ready).toBe(true))

    const pool = BASE_POOL_CATALOG[0]
    const plan = normalizeStrategyPlan({
      runId: 'run-mounted-unavailable-bridge',
      risk: 'low',
      stellarUnits: 0n,
      baseAllocations: [
        {
          address: pool.address,
          proxyTarget: pool.proxyTarget,
          factSlug: pool.factSlug,
          chain: 'base',
          units: 40_000_000n,
          decimals: 6,
        },
      ],
    })
    await act(async () => {
      mountedHarness.routeProps.onAcceptPlan({ plan, fingerprint: 'PLAN-UNAVAILABLE-BRIDGE' })
    })
    await waitFor(() => expect(mountedState().stage).toBe('protect'))
    await act(async () => {
      await mountedHarness.routeProps.protectProps.onRetryPreflight({ durationSeconds: 3600 })
    })

    readBaseMandate.mockClear()
    getMandateStatus.mockClear()
    buildBaseLegContext.mockClear()
    preflightPermission.mockClear()
    mountedHarness.orchestratorConfig = null
    Object.values(mountedHarness.movement).forEach((movement) => movement.mockClear())
    const unreachableDispatch = Promise.reject(new Error('dispatch must be unreachable'))
    unreachableDispatch.catch(() => {})
    mountedHarness.dispatch = { promise: unreachableDispatch }
    const storageGet = vi.spyOn(Storage.prototype, 'getItem')
    const storageSet = vi.spyOn(Storage.prototype, 'setItem')
    const storageRemove = vi.spyOn(Storage.prototype, 'removeItem')

    try {
      let confirmation
      await act(async () => {
        confirmation = mountedHarness.routeProps.protectProps.onRequestGrant()
        confirmation.catch(() => {})
        await Promise.resolve()
      })

      await expect(confirmation).rejects.toMatchObject({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' })
      expect(readBaseMandate).not.toHaveBeenCalled()
      expect(getMandateStatus).not.toHaveBeenCalled()
      expect(buildBaseLegContext).not.toHaveBeenCalled()
      expect(preflightPermission).not.toHaveBeenCalled()
      expect(storageGet).not.toHaveBeenCalledWith(baseMandateStorageKey(G.address))
      expect(storageSet).not.toHaveBeenCalled()
      expect(storageRemove).not.toHaveBeenCalled()
      expect(mountedHarness.orchestratorConfig).toBeNull()
      expect(mountedHarness.movement.grant).not.toHaveBeenCalled()
      expect(mountedHarness.movement.pull).not.toHaveBeenCalled()
      expect(mountedHarness.movement.burn).not.toHaveBeenCalled()
      expect(mountedHarness.movement.farmPost).not.toHaveBeenCalled()
    } finally {
      storageGet.mockRestore()
      storageSet.mockRestore()
      storageRemove.mockRestore()
    }
  })

  it('mounted App drops stale orchestrator events and completion after a network epoch switch', async () => {
    render(
      <MemoryRouter
        initialEntries={['/strategy']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    )
    await waitFor(() => expect(mountedState().owner).toBe(G.address))

    const plan = normalizeStrategyPlan({
      runId: 'run-mounted-transition',
      risk: 'low',
      stellarUnits: 100_000_000n,
    })
    await act(async () => {
      mountedHarness.routeProps.onAcceptPlan({ plan, fingerprint: 'PLAN-MOUNTED' })
    })
    await waitFor(() => expect(mountedState().stage).toBe('protect'))

    await act(async () => {
      await mountedHarness.routeProps.protectProps.onRetryPreflight({ durationSeconds: 3600 })
    })
    let confirmation
    await act(async () => {
      confirmation = mountedHarness.routeProps.protectProps.onRequestGrant()
      await Promise.resolve()
    })
    await waitFor(() => expect(mountedHarness.orchestratorConfig).not.toBeNull())

    const staleOrchestrator = mountedHarness.orchestratorConfig
    await act(async () => {
      staleOrchestrator.onEvent('grant-confirmed', { agentAddresses: ['CAGENT'] })
      await confirmation
      staleOrchestrator.onEvent('worker-started', {
        allocationId: plan.agents[0].allocationId,
      })
    })
    expect(mountedState()).toMatchObject({
      stage: 'start',
      eventNames: ['grant-confirmed', 'worker-started'],
    })

    const switchedNetwork = Object.freeze({
      ...G,
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      epoch: 2,
    })
    await act(async () => {
      mountedHarness.accountListener(switchedNetwork)
    })
    expect(mountedState()).toMatchObject({
      stage: 'plan',
      eventNames: [],
      hasReceipt: false,
      owner: G.address,
    })

    await act(async () => {
      staleOrchestrator.onEvent('completed', {
        allocationId: plan.agents[0].allocationId,
        txHash: 'HSTALE',
      })
      mountedHarness.dispatch.resolve({
        completed: 1,
        failed: 0,
        permission: { agentAddresses: ['CAGENT'] },
        results: [{ success: true }],
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mountedState()).toMatchObject({
      stage: 'plan',
      eventNames: [],
      hasReceipt: false,
      owner: G.address,
    })
  })

  // Finding 2 (final whole-branch review): app.jsx's `onRetryPreflight` used to call
  // `preflightPermission` with no `activeAccount`/`getCurrentActiveAccount` at all, so the
  // INITIAL V3 review had no account binding -- only `orchestrator.revalidateReuse` supplied one.
  // Mirrors the existing wiring every other activeAccount-scoped app.jsx call site already uses
  // (`handleConfirmFullExit`, `handleConfirmPartialExit`, `handleConfirmRevoke`, etc.).
  it('binds the initial preflight review to the captured active account', async () => {
    render(
      <MemoryRouter
        initialEntries={['/strategy']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    )
    await waitFor(() => expect(mountedState().owner).toBe(G.address))

    const plan = normalizeStrategyPlan({
      runId: 'run-account-binding',
      risk: 'low',
      stellarUnits: 100_000_000n,
    })
    await act(async () => {
      mountedHarness.routeProps.onAcceptPlan({ plan, fingerprint: 'PLAN-ACCOUNT-BINDING' })
    })
    await waitFor(() => expect(mountedState().stage).toBe('protect'))

    await act(async () => {
      await mountedHarness.routeProps.protectProps.onRetryPreflight({ durationSeconds: 3600 })
    })

    expect(preflightPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAccount: G,
        getCurrentActiveAccount: expect.any(Function),
      })
    )
    const call = preflightPermission.mock.calls.at(-1)[0]
    expect(call.getCurrentActiveAccount()).toBe(G)
  })
})

describe('composeV3Decision', () => {
  const PLAN = Object.freeze({ planFingerprint: '0xplan-compose-test' })
  const REVIEWED_BUDGETS = Object.freeze([{ token: 'CTOKEN', units: '100', decimals: 7 }])
  const AGENT_INITS = Object.freeze([{ allocationId: 'run-1:deposit:0', kind: 0 }])

  // This is the SOLE production producer of `planFingerprint`/`reviewedBudgets`/
  // `reviewedAgentInits`/`checkedAt` on a V3 decision -- `proveReusablePermission`'s own return
  // carries none of them (permissionGrantV3.js's `base` object), yet orchestrator.js's
  // `assertPermissionMatchesPlan` and its reviewed-budget check require all three unconditionally.
  it('merges plan/reviewedBudgets/agentInits onto a V3 decision', () => {
    const raw = Object.freeze({
      version: 3,
      mode: 'reuse',
      freshReason: null,
      scopeId: '0x' + 'ab'.repeat(32),
    })
    const composed = composeV3Decision(raw, {
      plan: PLAN,
      reviewedBudgets: REVIEWED_BUDGETS,
      agentInits: AGENT_INITS,
    })
    expect(composed).toMatchObject({
      version: 3,
      mode: 'reuse',
      freshReason: null,
      scopeId: raw.scopeId,
      planFingerprint: PLAN.planFingerprint,
      reviewedBudgets: REVIEWED_BUDGETS,
      reviewedAgentInits: AGENT_INITS,
    })
    expect(Number.isInteger(composed.checkedAt)).toBe(true)
  })

  it('returns a V2 decision unchanged (identity, no merge)', () => {
    const raw = Object.freeze({
      version: 1,
      mode: 'fresh',
      planFingerprint: '0xalready-here',
      reviewedBudgets: [{ token: 'CTOKEN', units: '1', decimals: 7 }],
    })
    const composed = composeV3Decision(raw, {
      plan: PLAN,
      reviewedBudgets: REVIEWED_BUDGETS,
      agentInits: AGENT_INITS,
    })
    expect(composed).toBe(raw)
  })
})
