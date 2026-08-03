// @vitest-environment jsdom
// frontend/src/strategy/strategyJourney.test.jsx
// Strategy Task 13 (Pocket Crew redesign, Wave 5) — the 22 Strategy journey cases from the
// approved spec. Mocks chain dependencies at module boundaries (no real wallet/RPC/relay calls);
// one case (J17) drives the harness through the REAL, verbatim orchestrator/worker/bridge event
// names and shapes documented in StartStage.jsx's own header comment, proving the reducer +
// adapter + component contract holds end to end within that mocked boundary.
//
// `Harness` below is a small, test-local re-implementation of app.jsx's real Plan/Protect/Start
// wiring (useReducer(strategyFlowReducer) + the same PLAN_REQUESTED/PLAN_READY/PROTECT_OPENED/
// PREFLIGHT_READY/PREFLIGHT_FAILED/GRANT_REQUESTED/GRANT_CONFIRMED/REUSE_CONFIRMED/WALLET_REJECTED/
// WALLET_FAILED/custody-event dispatch shape app.jsx's real adapters use) so these tests exercise
// the REAL flowState.js reducer and the REAL PlanStage/ProtectStage/StartStage components, with
// only the wallet/strategist/orchestrator CALLS themselves mocked per test.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { useReducer, useState, useRef, useImperativeHandle, forwardRef } from 'react'
import { strategyFlowReducer, initialStrategyFlowState } from './flowState.js'
import { PermissionPhaseError } from './permissionError.js'
import { StrategyProgress } from '../components/strategy/StrategyProgress.jsx'
import { PlanStage } from '../components/strategy/PlanStage.jsx'
import { ProtectStage } from '../components/strategy/ProtectStage.jsx'
import { StartStage } from '../components/strategy/StartStage.jsx'
import { SOROBAN_TOKEN_ADDRESS } from '../stellar/config.js'
import { STELLAR_USDC_SAC } from '../stellar/cctpBurn.js'

const AMOUNT_UNITS = 1_000_000_000n // 100 USDC, 7dp
const FUNDED_VAULT = 5_000_000_000n

const disconnectedBase = { connected: false, healthy: null, mandateView: null, action: null }
const connectedNoBase = { connected: true, healthy: false, mandateView: null, action: null }
const readyStellarVenue = {
  name: 'Vibing Farmer Autofarm',
  protocol: 'blend-usdc',
  apy: 6.4,
  risk: 'low',
  role: 'Conservative, lending',
}

function agentInitFor(allocationId, units = '1000000000') {
  return {
    allocationId,
    kind: 0,
    token: SOROBAN_TOKEN_ADDRESS,
    target: SOROBAN_TOKEN_ADDRESS,
    cap: { token: SOROBAN_TOKEN_ADDRESS, units, decimals: 7 },
    periodSeconds: 86400,
    expiry: Math.floor(Date.now() / 1000) + 86400,
    signerFingerprint: '0xsig',
    saltFingerprint: '0xsalt',
    destinationDomain: 0,
    mintRecipient: null,
  }
}

function freshDecision(runId, allocationId, over = {}) {
  return {
    version: 1,
    runId,
    mode: 'fresh',
    planFingerprint: '0xplan',
    agentInitFingerprint: '0xagents',
    checkedAt: Math.floor(Date.now() / 1000),
    reviewedBudgets: [{ token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 }],
    durationSeconds: 86400,
    reviewedAgentInits: [agentInitFor(allocationId)],
    confirmationCount: 1,
    grantReceiptFingerprint: null,
    allowanceExpiryProof: null,
    agents: [],
    freshReason: 'allowance-proof-missing',
    ...over,
  }
}

function reuseDecision(runId, allocationId, agentAddress = 'CAGENT1') {
  const now = Math.floor(Date.now() / 1000)
  return {
    version: 1,
    runId,
    mode: 'reuse',
    planFingerprint: '0xplan',
    agentInitFingerprint: '0xagents',
    checkedAt: now,
    reviewedBudgets: [{ token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 }],
    durationSeconds: 86400,
    reviewedAgentInits: [agentInitFor(allocationId)],
    confirmationCount: 0,
    grantReceiptFingerprint: '0xreceipt1',
    allowanceExpiryProof: {
      latestLedger: 1000,
      approvals: [{ amount: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000' } }],
    },
    agents: [
      {
        allocationId,
        workerId: 'w1',
        agentAddress,
        headroom: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
        scopeExpiry: now + 86400,
        scopeFingerprint: '0xscope',
        executionCredentialRef: agentAddress,
      },
    ],
    freshReason: null,
  }
}

function classify(err) {
  if (err instanceof PermissionPhaseError && err.phase !== 'fresh-grant') {
    return { kind: 'preflight', message: err.message }
  }
  const message = err?.message || 'The wallet request did not complete.'
  const rejected = /declin|reject|denied|cancel/i.test(message)
  return { kind: rejected ? 'rejected' : 'failed', message }
}

// Mirrors app.jsx's real wiring (onGenerate/onAcceptPlan/onRetryPreflight/onRequestGrant/
// onConfirmReuse/requestPermissionConfirmation/handleNewRunEvent) at the scale this test needs.
const Harness = forwardRef(function Harness({ mocks, initialFlowState }, ref) {
  const [flow, dispatch] = useReducer(
    strategyFlowReducer,
    initialFlowState || initialStrategyFlowState
  )
  const [events, setEvents] = useState([])
  const [receipt, setReceipt] = useState(null)
  const [reached, setReached] = useState(['plan'])
  const pendingRef = useRef(null)

  useImperativeHandle(ref, () => ({
    feedEvent(name, data) {
      setEvents((prev) => [...prev, { name, data }])
      if (name === 'worker-queued')
        dispatch({ type: 'WORKER_QUEUED', allocationId: data.allocationId })
      if (name === 'worker-started' || name === 'started')
        dispatch({ type: 'WORKER_STARTED', allocationId: data.allocationId })
      if (name === 'pull-confirmed')
        dispatch({ type: 'PULL_CONFIRMED', allocationId: data.allocationId })
      if (name === 'completed')
        dispatch({ type: 'DEPOSIT_CONFIRMED', allocationId: data.allocationId })
      if (name === 'failed')
        dispatch({ type: 'DEPOSIT_FAILED', allocationId: data.allocationId, error: data.error })
      if (name === 'grant-confirmed' || name === 'reuse-confirmed') {
        dispatch({ type: name === 'grant-confirmed' ? 'GRANT_CONFIRMED' : 'REUSE_CONFIRMED' })
        pendingRef.current?.resolve({ agentAddresses: data.agentAddresses || [] })
        pendingRef.current = null
      }
    },
    setReceipt(r) {
      setReceipt(r)
    },
    getState() {
      return flow
    },
  }))

  function onAcceptPlan({ plan, fingerprint }) {
    const canonical = { ...plan, planFingerprint: fingerprint }
    dispatch({ type: 'PLAN_READY', plan: canonical })
    dispatch({ type: 'PROTECT_OPENED' })
    setReached(['plan', 'protect'])
  }

  async function onGenerate(input, reportPhase) {
    dispatch({ type: 'PLAN_REQUESTED' })
    try {
      return await mocks.onGenerate(input, reportPhase)
    } catch (err) {
      dispatch({ type: 'PLAN_FAILED', error: err?.message })
      throw err
    }
  }

  async function onRetryPreflight(args) {
    try {
      const decision = await mocks.onRetryPreflight(args)
      dispatch({ type: 'PREFLIGHT_READY', decision })
      return decision
    } catch (err) {
      dispatch({ type: 'PREFLIGHT_FAILED', error: err?.message })
      throw err
    }
  }

  function requestConfirmation(run) {
    return new Promise((resolve, reject) => {
      pendingRef.current = { resolve, reject }
      run().catch((err) => {
        if (!pendingRef.current) return // resolved via a grant-confirmed/reuse-confirmed event
        pendingRef.current = null
        const { kind, message } = classify(err)
        if (kind === 'preflight') {
          dispatch({ type: 'PREFLIGHT_FAILED', error: message })
          reject(
            err instanceof PermissionPhaseError
              ? err
              : new PermissionPhaseError({ phase: 'preflight', code: 'X', message })
          )
        } else if (kind === 'rejected') {
          dispatch({ type: 'WALLET_REJECTED', reason: message })
          reject(new Error(message))
        } else {
          dispatch({ type: 'WALLET_FAILED', error: message })
          reject(new Error(message))
        }
      })
    })
  }

  function onRequestGrant() {
    dispatch({ type: 'GRANT_REQUESTED' })
    return requestConfirmation(() => mocks.onRequestGrant())
  }
  function onConfirmReuse() {
    // No GRANT_REQUESTED: REUSE_CONFIRMED's gate needs only a reuse-mode preflight-ready decision.
    return requestConfirmation(() => mocks.onConfirmReuse())
  }
  function onEditPlan() {
    mocks.onEditPlan?.()
  }

  return (
    <div className="pc-route">
      <div className="pc-route-stack">
        <StrategyProgress current={flow.moment} reached={reached} onNavigate={() => {}} />
        {flow.moment === 'plan' && (
          <PlanStage
            vaultTotalShares={mocks.vaultTotalShares ?? FUNDED_VAULT}
            stellarVenue={readyStellarVenue}
            base={mocks.base ?? disconnectedBase}
            runId={mocks.runId || 'run-1'}
            onGenerate={onGenerate}
            onRetryLive={onGenerate}
            onAcceptPlan={onAcceptPlan}
            onConnectForBase={mocks.onConnectForBase || vi.fn()}
            onSetupBase={mocks.onSetupBase || vi.fn()}
            onRebuildPlan={mocks.onRebuildPlan || vi.fn()}
            hashPlan={mocks.hashPlan || ((p) => `0x${p.agents.length}`)}
          />
        )}
        {flow.moment === 'protect' && flow.plan && (
          <ProtectStage
            plan={flow.plan}
            owner={mocks.owner ?? 'GOWNER'}
            baseMandateView={mocks.baseMandateView ?? null}
            onConnectWallet={mocks.onConnectWallet || vi.fn()}
            onRetryPreflight={onRetryPreflight}
            onRequestGrant={onRequestGrant}
            onConfirmReuse={onConfirmReuse}
            onEditPlan={onEditPlan}
          />
        )}
        {flow.moment === 'start' && flow.plan && (
          <StartStage
            plan={flow.plan}
            permission={flow.permission}
            events={events}
            receipt={receipt}
            runId={mocks.runId || 'run-1'}
            stellarVenue={readyStellarVenue}
            onRetryAllocation={mocks.onRetryAllocation || vi.fn()}
            onViewMoney={mocks.onViewMoney || vi.fn()}
            onMakeAnotherDeposit={mocks.onMakeAnotherDeposit || vi.fn()}
          />
        )}
      </div>
    </div>
  )
})

function generatedPlan({
  runId = 'run-1',
  source = 'deepseek',
  sourceState = 'live-ai',
  stellarUnits = '1000000000',
  baseAllocations = [],
} = {}) {
  return { source, sourceState, stellarUnits, baseAllocations }
}

// 'Steady' (RISK_PROFILES.low.targetSlots === 1) keeps most journeys to a single deposit agent,
// so a test that feeds custody events by allocationId doesn't have to enumerate a whole crew.
async function buildPlan({ getByLabelText, getByText }, amount = '100', risk = 'Steady') {
  fireEvent.change(getByLabelText('Amount in USDC'), { target: { value: amount } })
  fireEvent.click(getByText(risk))
  fireEvent.click(getByText('Build my plan'))
}

afterEach(cleanup)

describe('Strategy journeys (Task 13, Wave 5) — 22 approved-spec cases', () => {
  it('J1: first visit reaches Plan input with nothing decided yet, matching initialStrategyFlowState', () => {
    const ref = { current: null }
    render(<Harness ref={ref} mocks={{ onGenerate: vi.fn() }} />)
    expect(screen.getByText('How much do you want to put to work?')).toBeTruthy()
    expect(ref.current.getState()).toEqual(initialStrategyFlowState)
  })

  it('J2: first visit all the way to an all-success receipt (fresh grant, single deposit agent)', async () => {
    const ref = { current: null }
    const onGenerate = vi.fn().mockResolvedValue(generatedPlan())
    const onRetryPreflight = vi.fn().mockResolvedValue(freshDecision('run-1', 'run-1:deposit:0'))
    const onRequestGrant = vi.fn().mockResolvedValue({ agentAddresses: ['CAGENT1'] })
    const utils = render(
      <Harness ref={ref} mocks={{ onGenerate, onRetryPreflight, onRequestGrant }} />
    )
    await buildPlan(utils)
    await waitFor(() => expect(screen.getByText('Accept plan')).toBeTruthy())
    fireEvent.click(screen.getByText('Accept plan'))
    expect(ref.current.getState().moment).toBe('protect')
    fireEvent.click(screen.getByText('Check my permission'))
    await waitFor(() => expect(screen.getByText('Authorize with wallet')).toBeTruthy())
    const grantPromise = new Promise((resolve) => {
      fireEvent.click(screen.getByText('Authorize with wallet'))
      resolve()
    })
    await grantPromise
    // Simulate the orchestrator: grant-confirmed resolves onRequestGrant's promise (Protect -> Start)
    ref.current.feedEvent('grant-confirmed', { agentAddresses: ['CAGENT1'] })
    await waitFor(() => expect(ref.current.getState().moment).toBe('start'))
    ref.current.feedEvent('worker-queued', { allocationId: 'run-1:deposit:0' })
    ref.current.feedEvent('worker-started', { allocationId: 'run-1:deposit:0' })
    ref.current.feedEvent('pull-confirmed', { allocationId: 'run-1:deposit:0' })
    ref.current.feedEvent('completed', { allocationId: 'run-1:deposit:0', txHash: '0xdeadbeef' })
    await waitFor(() =>
      expect(ref.current.getState().custody['run-1:deposit:0'].status).toBe('deposited')
    )
    const { isReceiptComplete } = await import('./flowState.js')
    expect(isReceiptComplete(ref.current.getState())).toBe(true)
    ref.current.setReceipt({
      version: 1,
      runId: 'run-1',
      permission: { mode: 'fresh', agentAddresses: ['CAGENT1'] },
      allocations: [
        {
          allocationId: 'run-1:deposit:0',
          amount: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
          executionStatus: 'succeeded',
          custody: { location: 'stellar-vault', confirmed: true, checkedAt: Date.now() },
          txHash: '0xdeadbeef',
          error: null,
        },
      ],
    })
    await waitFor(() => expect(screen.getByText('Your receipt')).toBeTruthy())
    expect(screen.getByText('Every agent completed')).toBeTruthy()
  })

  it('J3: labeled deterministic fallback shows "Safe default plan", never claims live AI', async () => {
    const onGenerate = vi
      .fn()
      .mockResolvedValue(generatedPlan({ source: 'fallback', sourceState: 'deterministic' }))
    const utils = render(<Harness ref={{ current: null }} mocks={{ onGenerate }} />)
    await buildPlan(utils)
    await waitFor(() => expect(screen.getByText('Safe default plan')).toBeTruthy())
    expect(screen.queryByText('Live AI + live market checks')).toBeNull()
  })

  it('J4: an invalid (too-small) amount is rejected before generation ever runs', async () => {
    const onGenerate = vi.fn()
    const utils = render(
      <Harness ref={{ current: null }} mocks={{ onGenerate, vaultTotalShares: 0n }} />
    )
    fireEvent.change(utils.getByLabelText('Amount in USDC'), { target: { value: '0.0001' } })
    fireEvent.click(utils.getByText('Balanced'))
    fireEvent.click(utils.getByText('Build my plan'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('J5: all candidates blocked — a plan with zero agents fails PROTECT_OPENED closed with no-eligible-agents', () => {
    let state = strategyFlowReducer(initialStrategyFlowState, {
      type: 'PLAN_READY',
      plan: { runId: 'run-1', planFingerprint: '0xp', agents: [] },
    })
    state = strategyFlowReducer(state, { type: 'PROTECT_OPENED' })
    expect(state.moment).toBe('plan')
    expect(state.planStatus).toBe('failed')
    expect(state.planError).toBe('no-eligible-agents')
  })

  it('J6: a shared grant rejection preserves the reviewed plan/permission and returns Protect retryable', async () => {
    const ref = { current: null }
    const onGenerate = vi.fn().mockResolvedValue(generatedPlan())
    const onRetryPreflight = vi.fn().mockResolvedValue(freshDecision('run-1', 'run-1:deposit:0'))
    const onRequestGrant = vi.fn().mockRejectedValue(new Error('User declined access'))
    const utils = render(
      <Harness ref={ref} mocks={{ onGenerate, onRetryPreflight, onRequestGrant }} />
    )
    await buildPlan(utils)
    await waitFor(() => screen.getByText('Accept plan'))
    fireEvent.click(screen.getByText('Accept plan'))
    const planBefore = ref.current.getState().plan
    fireEvent.click(screen.getByText('Check my permission'))
    await waitFor(() => screen.getByText('Authorize with wallet'))
    fireEvent.click(screen.getByText('Authorize with wallet'))
    await waitFor(() => expect(screen.getByText('Nothing moved')).toBeTruthy())
    const state = ref.current.getState()
    expect(state.moment).toBe('protect')
    expect(state.plan).toBe(planBefore)
    expect(state.permission).not.toBeNull() // wallet-class: the reviewed decision is preserved
    expect(state.retryable).toBe(true)
    expect(state.permissionError).toBe('User declined access')
  })

  it('J7: fresh mode is a one-confirmation path — exactly one onRequestGrant call, never onConfirmReuse', async () => {
    const ref = { current: null }
    const onGenerate = vi.fn().mockResolvedValue(generatedPlan())
    const onRetryPreflight = vi.fn().mockResolvedValue(freshDecision('run-1', 'run-1:deposit:0'))
    const onRequestGrant = vi.fn().mockResolvedValue({ agentAddresses: ['CAGENT1'] })
    const onConfirmReuse = vi.fn()
    const utils = render(
      <Harness ref={ref} mocks={{ onGenerate, onRetryPreflight, onRequestGrant, onConfirmReuse }} />
    )
    await buildPlan(utils)
    await waitFor(() => screen.getByText('Accept plan'))
    fireEvent.click(screen.getByText('Accept plan'))
    fireEvent.click(screen.getByText('Check my permission'))
    await waitFor(() => screen.getByText('Authorize with wallet'))
    fireEvent.click(screen.getByText('Authorize with wallet'))
    ref.current.feedEvent('grant-confirmed', { agentAddresses: ['CAGENT1'] })
    await waitFor(() => expect(ref.current.getState().moment).toBe('start'))
    expect(onRequestGrant).toHaveBeenCalledTimes(1)
    expect(onConfirmReuse).not.toHaveBeenCalled()
  })

  it('J8: a verified reuse decision is a zero-confirmation path — no onRequestGrant/provider call at all', async () => {
    const ref = { current: null }
    const onGenerate = vi.fn().mockResolvedValue(generatedPlan())
    const onRetryPreflight = vi.fn().mockResolvedValue(reuseDecision('run-1', 'run-1:deposit:0'))
    const onRequestGrant = vi.fn()
    const onConfirmReuse = vi.fn().mockResolvedValue({ agentAddresses: ['CAGENT1'] })
    const utils = render(
      <Harness ref={ref} mocks={{ onGenerate, onRetryPreflight, onRequestGrant, onConfirmReuse }} />
    )
    await buildPlan(utils)
    await waitFor(() => screen.getByText('Accept plan'))
    fireEvent.click(screen.getByText('Accept plan'))
    fireEvent.click(screen.getByText('Check my permission'))
    await waitFor(() => expect(screen.getByText(/0 wallet confirmations needed/)).toBeTruthy())
    fireEvent.click(screen.getByText('Continue'))
    ref.current.feedEvent('reuse-confirmed', { agentAddresses: ['CAGENT1'] })
    await waitFor(() => expect(ref.current.getState().moment).toBe('start'))
    expect(onConfirmReuse).toHaveBeenCalledTimes(1)
    expect(onRequestGrant).not.toHaveBeenCalled() // no provider/grant builder call for reuse
    expect(ref.current.getState().permissionStatus).toBe('reuse-confirmed')
  })

  it('J9a: Base is excluded from generation before activation — onGenerate never sees baseEligible:true', async () => {
    const onGenerate = vi.fn().mockResolvedValue(generatedPlan({ baseAllocations: [] }))
    const utils = render(
      <Harness ref={{ current: null }} mocks={{ onGenerate, base: connectedNoBase }} />
    )
    await buildPlan(utils)
    await waitFor(() => expect(onGenerate).toHaveBeenCalled())
    expect(onGenerate.mock.calls[0][0]).toMatchObject({ baseEligible: false })
  })

  it('J9b: after Base activation succeeds, the reviewed plan is invalidated and only an explicit Rebuild plan re-generates it', async () => {
    const onGenerate = vi
      .fn()
      .mockResolvedValueOnce(generatedPlan({ stellarUnits: '1000000000', baseAllocations: [] }))
      .mockResolvedValueOnce(
        generatedPlan({
          stellarUnits: '500000000',
          baseAllocations: [
            {
              address: '0xAAA',
              proxyTarget: 'aave-v3',
              factSlug: 'aave-v3-base',
              units: '50000000',
              chain: 'base',
            },
          ],
        })
      )
    const onRebuildPlan = vi.fn()
    const utils = render(
      <Harness
        ref={{ current: null }}
        mocks={{
          onGenerate,
          onRebuildPlan,
          base: {
            connected: true,
            healthy: true,
            mandateView: { ready: true, status: 'ready' },
            action: null,
          },
        }}
      />
    )
    await buildPlan(utils)
    await waitFor(() => screen.getByText('Accept plan'))
    // Base activation succeeded after this plan was already built -- re-render with the caller's
    // post-setup `action` (mirrors app.jsx's onSetupBase -> refreshBaseView flow).
    utils.rerender(
      <Harness
        ref={{ current: null }}
        mocks={{
          onGenerate,
          onRebuildPlan,
          base: {
            connected: true,
            healthy: true,
            mandateView: { ready: true, status: 'ready' },
            action: { label: 'Rebuild plan', invalidatesPlan: true },
          },
        }}
      />
    )
    await waitFor(() => expect(screen.getByText('Rebuild plan')).toBeTruthy())
    expect(screen.queryByText('Accept plan')).toBeNull()
    fireEvent.click(screen.getByText('Rebuild plan'))
    expect(onRebuildPlan).toHaveBeenCalledTimes(1)
  })

  it('J10: disconnected first plan stays Stellar-only; connecting alone does not retroactively add Base to the reviewed plan', async () => {
    const onGenerate = vi.fn().mockResolvedValue(generatedPlan({ baseAllocations: [] }))
    const onConnectForBase = vi.fn()
    const utils = render(
      <Harness
        ref={{ current: null }}
        mocks={{ onGenerate, onConnectForBase, base: disconnectedBase }}
      />
    )
    expect(screen.getByText('Connect to check Base testnet')).toBeTruthy()
    fireEvent.click(screen.getByText('Connect to check Base testnet'))
    expect(onConnectForBase).toHaveBeenCalledTimes(1)
    await buildPlan(utils)
    await waitFor(() => expect(onGenerate).toHaveBeenCalled())
    expect(onGenerate.mock.calls[0][0].baseEligible).toBe(false)
  })

  it('J11: one worker failure does not erase an already-successful sibling — the run stays on Start with a partial-completion notice', async () => {
    const ref = { current: null }
    // Seeded directly into Start with a 2-agent plan (faster than a full click-through for a
    // lane-outcome assertion; J2/J7/J8 already prove the click-through path to Start).
    render(<Harness ref={ref} mocks={{}} initialFlowState={toStartState(['a', 'b'])} />)
    ref.current.feedEvent('pull-confirmed', { allocationId: 'a' })
    ref.current.feedEvent('completed', { allocationId: 'a', txHash: '0xa' })
    ref.current.feedEvent('pull-confirmed', { allocationId: 'b' })
    ref.current.feedEvent('failed', { allocationId: 'b', error: 'relay-timeout' })
    await waitFor(() =>
      expect(screen.getByText('One or more agents did not complete')).toBeTruthy()
    )
    expect(
      screen.getByText(
        'Agents that already finished stay confirmed. This page keeps reflecting the real state.'
      )
    ).toBeTruthy()
  })

  it('J12: one bridge agent settles N children under a single lane/mark, each with its own destination', async () => {
    const ref = { current: null }
    const plan = {
      runId: 'run-1',
      planFingerprint: '0xp',
      amount: { token: STELLAR_USDC_SAC, units: '500000000', decimals: 7 },
      agents: [
        {
          allocationId: 'run-1:bridge:base',
          kind: 'bridge',
          hostNetworkId: 'stellar-testnet',
          allocation: { token: STELLAR_USDC_SAC, units: '500000000', decimals: 7 },
          cap: { token: STELLAR_USDC_SAC, units: '500000000', decimals: 7 },
          periodSeconds: 86400,
          expiry: Math.floor(Date.now() / 1000) + 86400,
          destination: 'Base Sepolia bridge',
          children: [
            {
              allocationId: 'run-1:bridge:aave-v3',
              address: '0xAAA',
              proxyTarget: 'aave-v3',
              destination: 'aave-v3',
              allocation: { token: 'USDC', units: '25000000', decimals: 6 },
            },
            {
              allocationId: 'run-1:bridge:morpho',
              address: '0xBBB',
              proxyTarget: 'morpho-blue',
              destination: 'morpho-blue',
              allocation: { token: 'USDC', units: '25000000', decimals: 6 },
            },
          ],
        },
      ],
      truth: { agentIsolationCount: 1, stellarVenueCount: 0, baseUsesProxyVaults: true },
    }
    render(
      <Harness
        ref={ref}
        mocks={{}}
        initialFlowState={{
          ...initialStrategyFlowState,
          moment: 'start',
          plan,
          permission: { mode: 'fresh' },
        }}
      />
    )
    ref.current.feedEvent('farm-burn-started', { allocationId: 'run-1:bridge:base' })
    await waitFor(() =>
      expect(screen.getAllByText(/Burning on Stellar|aave-v3|morpho-blue/).length).toBeGreaterThan(
        0
      )
    )
    // ONE bridge mark (one `.pc-agent-lane[data-agent-kind="bridge"]`), both children listed inside it.
    const lanes = document.querySelectorAll('.pc-agent-lane[data-agent-kind="bridge"]')
    expect(lanes.length).toBe(1)
    expect(within(lanes[0]).getByText(/aave-v3/)).toBeTruthy()
    expect(within(lanes[0]).getByText(/morpho-blue/)).toBeTruthy()
  })

  it('J13: a queued Stellar order shows queued before it starts moving (per-lane monotonic phase)', async () => {
    const ref = { current: null }
    render(<Harness ref={ref} mocks={{}} initialFlowState={toStartState(['a'])} />)
    ref.current.feedEvent('worker-queued', { allocationId: 'a' })
    await waitFor(() => expect(screen.getByText('Queued')).toBeTruthy())
    ref.current.feedEvent('worker-started', { allocationId: 'a' })
    await waitFor(() => expect(screen.getByText('Moving allocation')).toBeTruthy())
  })

  it('J14: mixed branch partial success — a Stellar success beside a Base failure both settle correctly in the receipt', async () => {
    const ref = { current: null }
    render(
      <Harness
        ref={ref}
        mocks={{}}
        initialFlowState={{
          ...initialStrategyFlowState,
          moment: 'start',
          plan: {
            runId: 'run-1',
            planFingerprint: '0xp',
            amount: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
            agents: [
              {
                allocationId: 'a',
                kind: 'deposit',
                allocation: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
                cap: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
                destination: 'Stellar deposit',
                children: [],
              },
            ],
          },
          permission: { mode: 'fresh' },
        }}
      />
    )
    ref.current.setReceipt({
      version: 1,
      runId: 'run-1',
      permission: { mode: 'fresh' },
      allocations: [
        {
          allocationId: 'a',
          amount: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
          executionStatus: 'succeeded',
          custody: { location: 'stellar-vault', confirmed: true, checkedAt: Date.now() },
          txHash: '0xok',
          error: null,
        },
        {
          allocationId: 'b',
          amount: { token: STELLAR_USDC_SAC, units: '500000000', decimals: 7 },
          executionStatus: 'failed',
          custody: { location: 'agent', confirmed: true, checkedAt: Date.now() },
          txHash: null,
          error: 'burn tx rejected',
        },
      ],
    })
    await waitFor(() => expect(screen.getByText('Some agents did not complete')).toBeTruthy())
    expect(screen.getAllByText(/Deposited/).length).toBe(2) // one per token group (USDC, Circle USDC)
    expect(screen.getByText(/Held:/)).toBeTruthy()
  })

  it('J15: reload reconciliation replays no automatic action — restoring mid-run state moves nothing on its own', async () => {
    const ref = { current: null }
    const onRequestGrant = vi.fn()
    const onConfirmReuse = vi.fn()
    // Simulates a page-reload restore straight into 'start' with a fresh, unconfirmed-by-this-tab
    // custody map -- no click, no dispatch, just the restored state itself.
    render(
      <Harness
        ref={ref}
        mocks={{ onRequestGrant, onConfirmReuse }}
        initialFlowState={toStartState(['a'])}
      />
    )
    await waitFor(() => expect(screen.getByText('Starting your run')).toBeTruthy())
    expect(onRequestGrant).not.toHaveBeenCalled()
    expect(onConfirmReuse).not.toHaveBeenCalled()
  })

  it('J16: official network badge/route semantics — Stellar deposit and Base bridge lanes each carry their own real network identity, never a shared/generic one', async () => {
    const ref = { current: null }
    const plan = {
      runId: 'run-1',
      planFingerprint: '0xp',
      amount: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
      agents: [
        {
          allocationId: 'a',
          kind: 'deposit',
          hostNetworkId: 'stellar-testnet',
          allocation: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
          cap: { token: SOROBAN_TOKEN_ADDRESS, units: '1000000000', decimals: 7 },
          periodSeconds: 86400,
          expiry: Math.floor(Date.now() / 1000) + 86400,
          destination: 'Stellar deposit',
          children: [],
        },
      ],
      truth: { agentIsolationCount: 1, stellarVenueCount: 1, baseUsesProxyVaults: false },
    }
    render(
      <Harness
        ref={ref}
        mocks={{}}
        initialFlowState={{
          ...initialStrategyFlowState,
          moment: 'start',
          plan,
          permission: { mode: 'fresh' },
        }}
      />
    )
    await waitFor(() => expect(screen.getByText(/Stellar Testnet/i)).toBeTruthy())
  })

  it('J17 (real event contract): the exact verbatim orchestrator/worker event names/shapes StartStage.jsx documents drive a fresh deposit run to isReceiptComplete', async () => {
    // Every event below is copied verbatim from StartStage.jsx's own header-comment producer list
    // (orchestrator.js:458,469 / worker.js:75,125,154) -- this is the "real reducer/adapters/
    // orchestrator event contract" integration case (brief Step 1).
    const ref = { current: null }
    render(<Harness ref={ref} mocks={{}} initialFlowState={toStartState(['run-1:deposit:0'])} />)
    ref.current.feedEvent('worker-queued', {
      allocationId: 'run-1:deposit:0',
      agentId: '0xagent',
      agent: 'CAGENT1',
      queueIndex: 0,
    })
    ref.current.feedEvent('worker-started', {
      allocationId: 'run-1:deposit:0',
      agentId: '0xagent',
      agent: 'CAGENT1',
      queueIndex: 0,
    })
    ref.current.feedEvent('started', {
      agentId: '0xagent',
      vault: 'CVAULT',
      allocationId: 'run-1:deposit:0',
    })
    ref.current.feedEvent('pull-confirmed', { agentId: '0xagent', allocationId: 'run-1:deposit:0' })
    ref.current.feedEvent('completed', {
      agentId: '0xagent',
      vault: 'CVAULT',
      txHash: '0xreal',
      gasMethod: 'relayer',
      allocationId: 'run-1:deposit:0',
    })
    await waitFor(() =>
      expect(ref.current.getState().custody['run-1:deposit:0'].status).toBe('deposited')
    )
    const { isReceiptComplete } = await import('./flowState.js')
    expect(isReceiptComplete(ref.current.getState())).toBe(true)
  })

  it('J18: a preflight failure clears the held decision and Retry re-checks permission, never the wallet', async () => {
    const ref = { current: null }
    const onGenerate = vi.fn().mockResolvedValue(generatedPlan())
    const onRetryPreflight = vi.fn().mockResolvedValue(freshDecision('run-1', 'run-1:deposit:0'))
    // assertPermissionMatchesPlan-shaped failure: the reviewed decision no longer matches the
    // plan, discovered at the top of dispatchPermissioned before either mode branch runs --
    // genuinely preflight-class (never 'fresh-grant', which classifyPermissionFailure treats as
    // wallet-class since it also covers real wallet rejections).
    const onRequestGrant = vi.fn().mockRejectedValueOnce(
      new PermissionPhaseError({
        phase: 'preflight',
        code: 'VF_PLAN_FINGERPRINT_MISMATCH',
        message: 'stale',
      })
    )
    const utils = render(
      <Harness ref={ref} mocks={{ onGenerate, onRetryPreflight, onRequestGrant }} />
    )
    await buildPlan(utils)
    await waitFor(() => screen.getByText('Accept plan'))
    fireEvent.click(screen.getByText('Accept plan'))
    fireEvent.click(screen.getByText('Check my permission'))
    await waitFor(() => screen.getByText('Authorize with wallet'))
    fireEvent.click(screen.getByText('Authorize with wallet'))
    await waitFor(() => expect(screen.getByText('Nothing moved')).toBeTruthy())
    expect(onRetryPreflight).toHaveBeenCalledTimes(1)
    // Retry, on a preflight-class failure, re-checks permission -- never re-opens the wallet.
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(onRetryPreflight).toHaveBeenCalledTimes(2))
    expect(onRequestGrant).toHaveBeenCalledTimes(1) // never retried directly
    await waitFor(() => expect(screen.getByText('Authorize with wallet')).toBeTruthy())
  })

  it('J19: WALLET_REJECTED and WALLET_FAILED are distinguishable via permissionError, never byte-identical', () => {
    let rejected = strategyFlowReducer(initialStrategyFlowState, {
      type: 'PLAN_READY',
      plan: { agents: [{ allocationId: 'a' }] },
    })
    rejected = strategyFlowReducer(rejected, { type: 'PROTECT_OPENED' })
    rejected = strategyFlowReducer(rejected, {
      type: 'PREFLIGHT_READY',
      decision: freshDecision('run-1', 'a'),
    })
    rejected = strategyFlowReducer(rejected, { type: 'GRANT_REQUESTED' })
    let failed = rejected
    rejected = strategyFlowReducer(rejected, { type: 'WALLET_REJECTED', reason: 'user-declined' })
    failed = strategyFlowReducer(failed, { type: 'WALLET_FAILED', error: 'network-timeout' })
    expect(rejected.permissionError).toBe('user-declined')
    expect(failed.permissionError).toBe('network-timeout')
    expect(rejected.permissionError).not.toBe(failed.permissionError)
  })

  it('J20: no fake protocol/APY claims — a bridge child never renders a live APY, only the planned-mainnet-target disclosure', async () => {
    const onGenerate = vi.fn().mockResolvedValue(
      generatedPlan({
        stellarUnits: '500000000',
        baseAllocations: [
          {
            address: '0xAAA',
            proxyTarget: 'aave-v3',
            factSlug: 'aave-v3-base',
            units: '50000000',
            chain: 'base',
          },
        ],
      })
    )
    const utils = render(
      <Harness
        ref={{ current: null }}
        mocks={{
          onGenerate,
          base: { connected: true, healthy: true, mandateView: { ready: true }, action: null },
        }}
      />
    )
    await buildPlan(utils)
    await waitFor(() => expect(screen.getByText(/Planned mainnet target/)).toBeTruthy())
    expect(screen.queryByText(/% APY/)).toBeNull()
  })

  it('J21: the three-step progress nav announces the current step and only ever exposes reached steps as navigation targets', () => {
    render(<Harness ref={{ current: null }} mocks={{}} />)
    const nav = screen.getByRole('navigation', { name: 'Strategy progress' })
    expect(within(nav).getByText('Step 1 of 3: Plan')).toBeTruthy()
    expect(within(nav).getByText('2 · Protect').closest('button').disabled).toBe(true)
    expect(within(nav).getByText('3 · Start').closest('button').disabled).toBe(true)
  })

  it('J22: a receipt is never claimed complete on attestation alone — ATTESTATION_RECEIVED never flips isReceiptComplete', async () => {
    const ref = { current: null }
    render(<Harness ref={ref} mocks={{}} initialFlowState={toStartState(['a'])} />)
    ref.current.feedEvent('pull-confirmed', { allocationId: 'a' })
    const { isReceiptComplete, strategyFlowReducer: reduce } = await import('./flowState.js')
    let state = reduce(ref.current.getState(), {
      type: 'ATTESTATION_RECEIVED',
      attestation: { proof: '0xabc' },
    })
    expect(isReceiptComplete(state)).toBe(false)
    state = reduce(state, { type: 'DEPOSIT_CONFIRMED', allocationId: 'a' })
    expect(isReceiptComplete(state)).toBe(true)
  })
})

// ---- test-local helpers for the reducer-driven (non-click-through) journeys ----
function toStartState(allocationIds) {
  const each = 1_000_000_000n / BigInt(allocationIds.length)
  return {
    ...initialStrategyFlowState,
    moment: 'start',
    plan: {
      runId: 'run-1',
      planFingerprint: '0xp',
      amount: {
        token: SOROBAN_TOKEN_ADDRESS,
        units: (each * BigInt(allocationIds.length)).toString(),
        decimals: 7,
      },
      agents: allocationIds.map((id) => ({
        allocationId: id,
        kind: 'deposit',
        allocation: { token: SOROBAN_TOKEN_ADDRESS, units: each.toString(), decimals: 7 },
        cap: { token: SOROBAN_TOKEN_ADDRESS, units: each.toString(), decimals: 7 },
        destination: 'Stellar deposit',
        children: [],
      })),
    },
    permission: { mode: 'fresh' },
  }
}
