// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const mountedHarness = vi.hoisted(() => ({
  accountListener: null,
  initialAccount: null,
  routeProps: null,
  orchestratorConfig: null,
  dispatch: null,
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
  discoverOwnerScopes: vi.fn(async () => {
    throw new Error('offline test read')
  }),
}))

import App, {
  createActiveAccountEpochStore,
  createEpochBoundRun,
  composeV3Decision,
} from './app.jsx'
import { bindBaseLegCustodyDeps, reconcileBaseLegEpochCustody } from './orchestrator.js'
import { normalizeStrategyPlan } from './strategy/planModel.js'
import { preflightPermission } from './strategy/reusePreflight.js'

const G = Object.freeze({
  version: 1,
  kind: 'G',
  address: 'GOWNER',
  networkPassphrase: 'Test SDF Network ; September 2015',
  connectorId: 'freighter',
  epoch: 1,
})
const C = Object.freeze({ ...G, kind: 'C', address: 'COWNER', connectorId: 'vf-wallet', epoch: 2 })

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
  mountedHarness.orchestratorConfig = null
  mountedHarness.dispatch = deferred()
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
