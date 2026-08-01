// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const mountedHarness = vi.hoisted(() => ({
  accountListener: null,
  initialAccount: null,
  routeProps: null,
  moneyRouteProps: null,
  orchestratorConfig: null,
  dispatch: null,
  movement: null,
}))

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

vi.mock('./components/money/MyMoneyRoute.jsx', async () => {
  const { createElement } = await import('react')
  return {
    MyMoneyRoute: (props) => {
      mountedHarness.moneyRouteProps = props
      return createElement(
        'output',
        { 'data-testid': 'mounted-money-state' },
        JSON.stringify({ owner: props.account?.address ?? null, agentCount: props.agents.length })
      )
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
vi.mock('./base/relayerClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getMandateStatus: vi.fn(),
}))
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
import { getMandateStatus } from './base/relayerClient.js'
import { baseMandateStorageKey } from './wallet/baseBinding.js'
import { BASE_POOL_CATALOG } from './config.js'

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
const BASE_EXPIRES_AT_MS = 2_000_000_000_000
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
    version: 2,
    status: 'active',
    reasonCodes: [],
    stellarOwner: G.address,
    kernelAddress: BASE_KERNEL,
    relayerOrigin: BASE_RELAYER_ORIGIN,
    sessionKeyAddress: BASE_SESSION,
    bindingId: 'binding-test',
    bindingHash: '761ae6f804c1c9774dc3d91678a4752f46259cb6ffa346c996bef372675c0725',
    expiresAt: BASE_EXPIRES_AT_MS,
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
      expiresAt: BASE_EXPIRES_AT_MS,
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
      preparedCallDigest: '24bac97411885d34f4d8248c2a7f5110611280ae97fbaa74e82809425163c490',
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
      allocation: true,
      freshness: true,
      reconstruction: true,
      prepared: true,
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
  mountedHarness.moneyRouteProps = null
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
  getMandateStatus.mockReset().mockResolvedValue(null)
})

afterEach(() => cleanup())

describe('active account application state', () => {
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

  it('mounted App rechecks a reviewed Base mandate immediately before grant and blocks every movement when it was revoked', async () => {
    const reviewedEvidence = activeBaseWireEvidence()
    let remoteEvidence = reviewedEvidence
    getMandateStatus.mockImplementation(async () => remoteEvidence)
    localStorage.setItem(
      baseMandateStorageKey(G.address),
      JSON.stringify({
        version: 2,
        stellarOwner: G.address,
        kernelAddress: BASE_KERNEL,
        serializedApproval: 'APPROVAL',
        sessionKeyAddress: BASE_SESSION,
        relayerOrigin: BASE_RELAYER_ORIGIN,
        expiresAt: BASE_EXPIRES_AT_MS / 1000,
        status: 'active',
        bindingId: reviewedEvidence.bindingId,
        bindingHash: reviewedEvidence.bindingHash,
        createdAt: Math.floor(Date.now() / 1000),
      })
    )

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
      runId: 'run-mounted-mandate-recheck',
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
      mountedHarness.routeProps.onAcceptPlan({ plan, fingerprint: 'PLAN-BASE-RECHECK' })
    })
    await waitFor(() => expect(mountedState().stage).toBe('protect'))
    await act(async () => {
      await mountedHarness.routeProps.protectProps.onRetryPreflight({ durationSeconds: 3600 })
    })

    const reviewedStatusCalls = getMandateStatus.mock.calls.length
    remoteEvidence = {
      ...reviewedEvidence,
      status: 'revoked',
      reasonCodes: ['PERMISSION_REVOKED'],
      observed: {
        ...reviewedEvidence.observed,
        permission: {
          permissionId: BASE_PERMISSION_ID,
          permissionFlag: '0x0000',
          signer: `0x${'00'.repeat(20)}`,
          policyData: [],
          digest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        },
        preparedCallDigest: null,
      },
      checks: {
        ...reviewedEvidence.checks,
        permission: false,
        reconstruction: false,
        prepared: false,
      },
    }
    let confirmation
    await act(async () => {
      confirmation = mountedHarness.routeProps.protectProps.onRequestGrant()
      confirmation.catch(() => {})
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(getMandateStatus.mock.calls.length).toBeGreaterThan(reviewedStatusCalls)
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getMandateStatus).toHaveBeenLastCalledWith('APPROVAL', {
      stellarOwner: G.address,
      kernelAddress: BASE_KERNEL,
      allocation: {
        allocationId: plan.agents[0].children[0].allocationId,
        poolAddress: pool.address,
        amount: { token: 'USDC', units: '40000000', decimals: 6 },
        minShares: '0',
      },
    })
    expect(mountedHarness.orchestratorConfig).toBeNull()
    expect(mountedHarness.movement.grant).not.toHaveBeenCalled()
    expect(mountedHarness.movement.pull).not.toHaveBeenCalled()
    expect(mountedHarness.movement.burn).not.toHaveBeenCalled()
    expect(mountedHarness.movement.farmPost).not.toHaveBeenCalled()
    await expect(confirmation).rejects.toMatchObject({
      phase: 'preflight',
      code: 'VF_BASE_MANDATE_CHANGED',
    })
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
