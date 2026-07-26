// frontend/src/components/strategy/PlanStage.test.jsx
// Strategy Task 10 (Pocket Crew redesign, Wave 5). PlanStage is the first-visit "Plan" surface:
// amount + comfort (risk) input, real asynchronous strategy generation (no artificial
// `speed * ...` delays -- see app.jsx's legacy ThinkingCard for the pattern this must NOT
// reproduce), and the reviewed-plan truth surface (Stellar always, Base only when the canonical
// mandate view says it is actually ready). Base availability is CONSUMED from
// strategy/baseMandateView.js's toBaseMandateView + mergeFlowHelpers.js's
// resolveBaseAvailability/needsBaseMandateSetup -- this file never re-derives that policy, it
// only asserts PlanStage renders/gates correctly off of it.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { PlanStage } from './PlanStage.jsx'
import { FIRST_DEPOSIT_MIN_UNITS } from '../../strategy/amountValidation.js'
import { canonicalizeStrategy } from '../../strategy/canonicalStrategy.js'
import * as planModel from '../../strategy/planModel.js'

expect.extend(axeMatchers)

afterEach(cleanup)

// Fix loop 1 -- real-CSS regression helper (used by I6 and the owner mono-face ruling below).
// jsdom's getComputedStyle does not resolve `var()`, but it DOES correctly apply the cascade
// (specificity/!important/source order) and echo back whichever declaration's raw text won --
// verified against these exact two files before relying on it. That is enough to prove a scoped
// override rule is winning (or an animation rule is genuinely absent), without needing a real
// browser for every regression run; the two Critical, rendered-colour findings are still verified
// separately in a real browser (see the fix report).
const here = path.dirname(fileURLToPath(import.meta.url))
const REAL_STYLESHEET = [
  fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8'),
  fs.readFileSync(path.resolve(here, './strategy.css'), 'utf8'),
].join('\n')

async function withRealStylesheet(run) {
  const styleEl = document.createElement('style')
  styleEl.textContent = REAL_STYLESHEET
  document.head.appendChild(styleEl)
  try {
    await run()
  } finally {
    styleEl.remove()
  }
}

const FUNDED_VAULT = 500_0000000n // vault already seeded -- first-deposit floor does not apply

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const disconnectedBase = { connected: false, healthy: null, mandateView: null, action: null }

async function fillAndSubmit({ amount = '100', risk = 'Steady' }) {
  fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: amount } })
  fireEvent.click(screen.getByRole('radio', { name: risk }))
  fireEvent.click(screen.getByRole('button', { name: 'Build my plan' }))
}

describe('PlanStage — first visit input', () => {
  it('shows the amount field and the three Steady/Balanced/Adventurous comfort controls', () => {
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />)
    expect(screen.getByLabelText('Amount in USDC')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Steady' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Balanced' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Adventurous' })).toBeTruthy()
  })

  it('never renders an advanced crew-count input', () => {
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />)
    expect(screen.queryByLabelText(/crew|agent count|number of agents/i)).toBeNull()
  })

  it('renders the literal "nothing moves" reassurance before any signature', () => {
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />)
    expect(screen.getByText(/Nothing moves until you review and confirm/)).toBeTruthy()
  })

  it('disables submit until an amount and a comfort level are both chosen', () => {
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />)
    const submit = screen.getByRole('button', { name: 'Build my plan' })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '100' } })
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Steady' }))
    expect(submit.disabled).toBe(false)
  })

  it('shows an inline field error for an unusable amount instead of proceeding', () => {
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Steady' }))
    fireEvent.click(screen.getByRole('button', { name: 'Build my plan' }))
    expect(screen.getByText('Amount must be greater than zero.')).toBeTruthy()
  })

  it('reports an unknown vault read as a retryable inline error, never a silent guess', () => {
    render(<PlanStage vaultTotalShares={null} base={disconnectedBase} onGenerate={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Steady' }))
    fireEvent.click(screen.getByRole('button', { name: 'Build my plan' }))
    expect(screen.getByText('Could not verify the vault minimum. Try again.')).toBeTruthy()
  })

  it('has zero axe violations on first visit', async () => {
    const { container } = render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('PlanStage — Base availability is consumed, never re-derived', () => {
  it('disconnected: offers Connect to check Base testnet and never claims Base is available', async () => {
    const onConnectForBase = vi.fn()
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [{ address: '0xAAA', proxyTarget: 'aave-v3', units: '50000000', chain: 'base' }],
    })
    render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={disconnectedBase}
        onGenerate={onGenerate}
        onConnectForBase={onConnectForBase}
      />
    )
    const connect = screen.getByRole('button', { name: 'Connect to check Base testnet' })
    fireEvent.click(connect)
    expect(onConnectForBase).toHaveBeenCalledTimes(1)

    await fillAndSubmit({ onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })

    // The mock (mis-)returned a base allocation -- a disconnected first plan must ignore it
    // rather than silently adding Base.
    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ baseEligible: false }),
      expect.any(Function)
    )
    expect(screen.queryByText('Circle CCTP v2')).toBeNull()
    expect(screen.queryByText(/Set up Base testnet/)).toBeNull()
  })

  it('connected + healthy + missing mandate: shows a separate Set up Base testnet action outside the plan', () => {
    const onSetupBase = vi.fn()
    render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={{
          connected: true,
          healthy: true,
          mandateView: { status: 'missing', ready: false, primaryCopy: 'Base mandate copy.' },
          action: null,
        }}
        onGenerate={vi.fn()}
        onSetupBase={onSetupBase}
      />
    )
    expect(screen.getByText('Set up Base testnet', { selector: 'p' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up Base testnet' }))
    expect(onSetupBase).toHaveBeenCalledTimes(1)
    // No plan has been generated in this render yet, so there is nothing to accept -- this does
    // NOT assert that Accept plan and Set up Base testnet can't coexist; see the I3 describe
    // block below for the test that proves they do.
    expect(screen.queryByRole('button', { name: 'Accept plan' })).toBeNull()
  })

  it('a healthy relayer with a ready mandate makes Base eligible for generation', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      // 50 USDC Stellar + 50 USDC Base (30+20M base 6dp -> 500000000 7dp bridge cap) = 100 USDC,
      // reconciling with the typed amount below (see C2's fail-closed reconciliation check).
      stellarUnits: '500000000',
      baseAllocations: [
        { address: '0xAAA', proxyTarget: 'aave-v3', factSlug: 'aave-v3-base', units: '50000000', chain: 'base' },
      ],
    })
    render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={{
          connected: true,
          healthy: true,
          mandateView: { status: 'ready', ready: true, primaryCopy: 'Ready copy.' },
          action: null,
        }}
        onGenerate={onGenerate}
      />
    )
    await fillAndSubmit({ onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ baseEligible: true }),
      expect.any(Function)
    )
    expect(screen.getByText('Circle CCTP v2')).toBeTruthy()
  })

  it('successful setup invalidates a reviewed plan and requires the explicit Rebuild plan action', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    const onRebuildPlan = vi.fn()
    const { rerender } = render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={{ connected: true, healthy: true, mandateView: { status: 'missing', ready: false }, action: null }}
        onGenerate={onGenerate}
        onRebuildPlan={onRebuildPlan}
      />
    )
    await fillAndSubmit({ onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })

    rerender(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={{
          connected: true,
          healthy: true,
          mandateView: { status: 'ready', ready: true },
          action: { label: 'Rebuild plan', invalidatesPlan: true },
        }}
        onGenerate={onGenerate}
        onRebuildPlan={onRebuildPlan}
      />
    )

    expect(screen.queryByRole('button', { name: 'Accept plan' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild plan' }))
    expect(onRebuildPlan).toHaveBeenCalledTimes(1)
    // Back to a fresh input surface -- the stale plan is gone, not silently kept.
    expect(screen.getByRole('button', { name: 'Build my plan' })).toBeTruthy()
  })
})

describe('PlanStage — generation is event-driven, not timer-driven', () => {
  it('shows one honest generating message, never a fake simultaneous 3-phase list, when the caller reports no phases', async () => {
    const gen = deferred()
    const onGenerate = vi.fn().mockReturnValue(gen.promise)
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ onGenerate })

    expect(screen.getByText('Working on it…')).toBeTruthy()
    // The old implementation rendered all three as a static list regardless of any real signal --
    // that is exactly what this proves is gone: none of the three phase labels is shown unless
    // the caller actually reported it (see the next test).
    expect(screen.queryByText('Checking destinations')).toBeNull()
    expect(screen.queryByText('Building bounded allocations')).toBeNull()
    expect(screen.queryByText('Safety review')).toBeNull()
    // Still pending: nothing after this point should require fake timers to observe.
    expect(screen.queryByRole('button', { name: 'Accept plan' })).toBeNull()

    gen.resolve({ source: 'deepseek', sourceState: 'live-ai', stellarUnits: '1000000000', baseAllocations: [] })
    await screen.findByRole('button', { name: 'Accept plan' })
  })

  it('advances through real caller-reported phases one at a time, in response to genuine events -- never all at once', async () => {
    const gen = deferred()
    let reportPhase
    const onGenerate = vi.fn((_input, report) => {
      reportPhase = report
      return gen.promise
    })
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ onGenerate })

    expect(screen.getByText('Working on it…')).toBeTruthy()
    expect(typeof reportPhase).toBe('function')

    act(() => reportPhase('Checking destinations'))
    expect(screen.getByText('Checking destinations')).toBeTruthy()
    expect(screen.queryByText('Building bounded allocations')).toBeNull()
    expect(screen.queryByText('Working on it…')).toBeNull()

    act(() => reportPhase('Building bounded allocations'))
    expect(screen.getByText('Building bounded allocations')).toBeTruthy()
    expect(screen.queryByText('Checking destinations')).toBeNull()

    act(() => reportPhase('Safety review'))
    expect(screen.getByText('Safety review')).toBeTruthy()
    expect(screen.queryByText('Building bounded allocations')).toBeNull()

    gen.resolve({ source: 'deepseek', sourceState: 'live-ai', stellarUnits: '1000000000', baseAllocations: [] })
    await screen.findByRole('button', { name: 'Accept plan' })
  })

  it('surfaces a generation failure without crashing and lets the user try again', async () => {
    const onGenerate = vi.fn().mockRejectedValueOnce(new Error('network down'))
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ onGenerate })
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Build my plan' })).toBeTruthy()
  })
})

describe('PlanStage — reviewed plan (Stellar-only)', () => {
  async function generateStellarOnlyPlan(overrides = {}) {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000', // 100 USDC, risk med -> 2 deposit agents
      baseAllocations: [],
      ...overrides,
    })
    const onAcceptPlan = vi.fn()
    render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={disconnectedBase}
        stellarVenue={{ name: 'Vibing Farmer Autofarm', chain: 'stellar', yield: { state: 'live', apy: 5.5 } }}
        onGenerate={onGenerate}
        onAcceptPlan={onAcceptPlan}
        hashPlan={(plan) => `0xstub${plan.agents.length}`}
      />
    )
    await fillAndSubmit({ amount: '100', risk: 'Balanced', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    return { onGenerate, onAcceptPlan }
  }

  it('shows the live-AI source badge with no retry when the source state is live', async () => {
    await generateStellarOnlyPlan()
    expect(screen.getByText('Live AI + live market checks')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry live check' })).toBeNull()
  })

  it('shows the fallback badge with an explicit retry when the source state is not live', async () => {
    const onGenerate = vi
      .fn()
      .mockResolvedValueOnce({
        source: 'fallback',
        sourceState: 'deterministic',
        stellarUnits: '1000000000',
        baseAllocations: [],
      })
      .mockResolvedValueOnce({
        source: 'deepseek',
        sourceState: 'live-ai',
        stellarUnits: '1000000000',
        baseAllocations: [],
      })
    const onRetryLive = onGenerate
    render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={disconnectedBase}
        onGenerate={onGenerate}
        onRetryLive={onRetryLive}
      />
    )
    await fillAndSubmit({ onGenerate })
    await screen.findByText('Safe default plan')
    fireEvent.click(screen.getByRole('button', { name: 'Retry live check' }))
    await screen.findByText('Live AI + live market checks')
    expect(onGenerate).toHaveBeenCalledTimes(2)
  })

  it('reviews the real agent count, per-agent allocation/cap/expiry, and yield', async () => {
    await generateStellarOnlyPlan()
    // risk 'Balanced' (med) -> exactly 2 real deposit agents, no manual count anywhere.
    expect(screen.getAllByText(/^Cap /)).toHaveLength(2)
    expect(screen.getAllByText(/^Expires /)).toHaveLength(2)
    expect(screen.getAllByText('5.5% APY')).toHaveLength(2)
    expect(screen.getByText('100 USDC')).toBeTruthy() // review amount total
  })

  it('renders the Stellar truth block: isolated accounts, one live venue, Autofarm -> Blend', async () => {
    await generateStellarOnlyPlan()
    expect(screen.getByText('2 isolated accounts')).toBeTruthy()
    expect(screen.getByText('1 live venue')).toBeTruthy()
    expect(screen.getByText(/Vibing Farmer Autofarm supplies to Blend/)).toBeTruthy()
  })

  it('shows a network badge on every allocation', async () => {
    await generateStellarOnlyPlan()
    // risk 'Balanced' (med) -> exactly 2 deposit agents, one badge each.
    expect(screen.getAllByText('Stellar testnet')).toHaveLength(2)
  })

  it('renders "Yield unavailable" honestly when the venue carries no live yield', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    // risk 'Steady' (low) -> exactly 1 deposit agent.
    expect(screen.getAllByText('Yield unavailable')).toHaveLength(1)
  })

  it('edits an agent instruction inside Technical details and approves the edited value in one deliberate action', async () => {
    const { onAcceptPlan } = await generateStellarOnlyPlan()
    const [firstTextarea] = screen.getAllByLabelText(/instructions$/i)
    fireEvent.change(firstTextarea, { target: { value: 'Deposit and never auto-compound.' } })
    // Editing alone must not have already "accepted" anything.
    expect(onAcceptPlan).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Accept plan' }))
    expect(onAcceptPlan).toHaveBeenCalledTimes(1)
    const call = onAcceptPlan.mock.calls[0][0]
    expect(call.plan.agents[0].instructions).toBe('Deposit and never auto-compound.')
    // hashPlan is injected as a stub above (the real hashStrategy needs a real Node/browser
    // Uint8Array realm -- see PlanStage's hashPlan doc comment); this only proves PlanStage calls
    // whatever hasher it's given with the exact reviewed (post-edit) plan.
    expect(call.fingerprint).toBe(`0xstub${call.plan.agents.length}`)
  })

  it('I7: the reviewed-plan shape PlanStage builds is exactly what the REAL canonicalizer (hashStrategy default path) needs', async () => {
    // hashStrategy's own sha256 step cannot run inside this jsdom file -- a jsdom Buffer/
    // Uint8Array realm mismatch crashes @noble/hashes even for a bare, no-React call (reproduced
    // independently by both the implementer and the Task 10 review). That sha256 step is
    // shape-agnostic (it just hashes whatever JSON string comes out) and is already exercised
    // against a real StrategyPlan, in vitest's default node environment, by
    // strategy/canonicalStrategy.test.js. What was never proven is that PlanStage's OWN
    // construction (frozen plan spread + merged per-agent `instructions`) is a shape the REAL,
    // unmocked canonicalizeStrategy can actually consume -- this captures that exact construction
    // and runs the real function on it.
    let captured = null
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={disconnectedBase}
        onGenerate={onGenerate}
        onAcceptPlan={() => {}}
        hashPlan={(plan) => {
          captured = plan
          return '0xcaptured'
        }}
      />
    )
    await fillAndSubmit({ amount: '100', risk: 'Balanced', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    fireEvent.click(screen.getByRole('button', { name: 'Accept plan' }))
    expect(captured).toBeTruthy()

    expect(() => JSON.stringify(canonicalizeStrategy(captured))).not.toThrow()
    const first = JSON.stringify(canonicalizeStrategy(captured))
    const second = JSON.stringify(canonicalizeStrategy(captured))
    expect(first).toBe(second) // deterministic, same as hashStrategy requires
    expect(JSON.parse(first).agents[0].instructions).toBeTruthy()
  })

  it('has zero axe violations once a plan is reviewed', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    const { container } = render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('PlanStage — reviewed plan with a Base bridge leg', () => {
  const readyBase = {
    connected: true,
    healthy: true,
    mandateView: { status: 'ready', ready: true, primaryCopy: 'Ready copy.' },
    action: null,
  }

  async function generateBridgedPlan() {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      // 50 USDC Stellar + 30+20 USDC Base (bridge cap 500000000 7dp = 50 USDC) = 100 USDC,
      // reconciling with the typed amount below (see C2's fail-closed reconciliation check --
      // this fixture used to total 150 against a typed 100, the exact bug the review reproduced).
      stellarUnits: '500000000',
      baseAllocations: [
        { address: '0xAAA', proxyTarget: 'aave-v3', factSlug: 'aave-v3-base', units: '30000000', chain: 'base' },
        { address: '0xBBB', proxyTarget: 'morpho-blue', factSlug: 'morpho-blue-base', units: '20000000', chain: 'base' },
      ],
    })
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={readyBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
  }

  it('reconciles the reviewed total against the typed amount for a bridged plan', async () => {
    await generateBridgedPlan()
    expect(screen.getByText('100 USDC')).toBeTruthy()
  })

  it('renders the Base truth: Circle CCTP v2, Circle USDC, custody-only proxy, planned (not live) targets', async () => {
    await generateBridgedPlan()
    expect(screen.getByText('Circle CCTP v2')).toBeTruthy()
    expect(screen.getByText(/Circle USDC/)).toBeTruthy()
    expect(screen.getByText('Base Sepolia proxy. Custody only. No protocol yield.')).toBeTruthy()
    expect(screen.getByText(/aave-v3.*not live/)).toBeTruthy()
    expect(screen.getByText(/morpho-blue.*not live/)).toBeTruthy()
  })

  it('collapses every Base pool into exactly one bridge AgentMark carrying its child destinations', async () => {
    await generateBridgedPlan()
    const bridgeRow = document.querySelector('[data-agent-kind="bridge"]')
    expect(bridgeRow).toBeTruthy()
    expect(within(bridgeRow).getAllByRole('img', { name: /agent/i }).length).toBe(1)
    expect(within(bridgeRow).getByText(/aave-v3/)).toBeTruthy()
    expect(within(bridgeRow).getByText(/morpho-blue/)).toBeTruthy()
  })

  it('shows the full source -> destination network route on the bridge row', async () => {
    await generateBridgedPlan()
    const bridgeRow = document.querySelector('[data-agent-kind="bridge"]')
    expect(within(bridgeRow).getByText('Stellar testnet')).toBeTruthy()
    expect(within(bridgeRow).getByText('Base Sepolia')).toBeTruthy()
    expect(within(bridgeRow).getByRole('img', { name: 'to' })).toBeTruthy()
  })
})

describe('PlanStage — C2: the reviewed amount must reconcile with the typed amount', () => {
  it('fails closed instead of rendering/offering a plan for a different amount than the user typed', async () => {
    // The reviewer's exact reproduction: typed 100, the strategist's response totals 150
    // (100 Stellar + 30 + 20 Base) -- the surface must never confidently display 150 USDC or
    // offer to accept it.
    const readyBase = {
      connected: true,
      healthy: true,
      mandateView: { status: 'ready', ready: true, primaryCopy: 'Ready copy.' },
      action: null,
    }
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000', // 100 USDC
      baseAllocations: [
        { address: '0xAAA', proxyTarget: 'aave-v3', factSlug: 'aave-v3-base', units: '30000000', chain: 'base' },
        { address: '0xBBB', proxyTarget: 'morpho-blue', factSlug: 'morpho-blue-base', units: '20000000', chain: 'base' },
      ], // +50 USDC bridge cap -- 150 USDC total against a typed 100
    })
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={readyBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })

    await screen.findByRole('alert')
    expect(screen.queryByText('150 USDC')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept plan' })).toBeNull()
    expect(
      screen.getByText('The generated plan did not match the amount you entered. Try again.')
    ).toBeTruthy()
  })
})

describe('PlanStage — I2: the cached source state is never mislabeled as the deterministic fallback', () => {
  it('shows a distinct "cached" badge and freshness, never "Safe default plan"/"Fallback"', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'cached',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    expect(screen.getByText('Live AI (cached)')).toBeTruthy()
    expect(screen.queryByText('Safe default plan')).toBeNull()
    expect(screen.getByText('Cached')).toBeTruthy()
    expect(screen.queryByText('Fallback')).toBeNull()
  })
})

describe('PlanStage — I3: Set up Base testnet stays reachable alongside a reviewed plan', () => {
  it('keeps rendering the setup notice once a plan exists, so setup -> invalidate -> Rebuild plan is reachable', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={{ connected: true, healthy: true, mandateView: { status: 'missing', ready: false }, action: null }}
        onGenerate={onGenerate}
      />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    // The setup notice is still on screen, outside the reviewed plan surface -- not hidden just
    // because a plan now exists.
    expect(screen.getByRole('button', { name: 'Set up Base testnet' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Accept plan' })).toBeTruthy()
  })
})

describe('PlanStage — I4: runId arrives from the caller, never minted internally', () => {
  it('produces the same agent identities across two generations given the same runId prop (no Date.now() involved)', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    const { unmount } = render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} runId="run-fixed" onGenerate={onGenerate} />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    const firstMark = document.querySelector('[data-agent-kind="deposit"] svg')
    const firstFill = firstMark.querySelector('path').getAttribute('fill')
    unmount()

    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} runId="run-fixed" onGenerate={onGenerate} />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    const secondMark = document.querySelector('[data-agent-kind="deposit"] svg')
    const secondFill = secondMark.querySelector('path').getAttribute('fill')

    // Same runId prop in -> the same allocationId -> the same seeded AgentMark colour. A
    // Date.now()-minted runId would make this flaky/always-different across two real calls.
    expect(secondFill).toBe(firstFill)
  })
})

describe('PlanStage — all-blocked plan has no Protect/signing action', () => {
  it('an empty vault + a risk split that cannot each clear the first-deposit minimum blocks Accept entirely', async () => {
    // 2 USDC split 3 ways (Adventurous) on an EMPTY vault: every slot lands under the 1 USDC
    // on-chain first-deposit floor, even though the typed total itself looked fine.
    expect(FIRST_DEPOSIT_MIN_UNITS).toBe(1_0000000n)
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '20000000', // 2 USDC at 7dp
      baseAllocations: [],
    })
    render(<PlanStage vaultTotalShares={0n} base={disconnectedBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ amount: '2', risk: 'Adventurous', onGenerate })
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Accept plan' })).toBeNull()
  })
})

describe('PlanStage — keyboard operability and reduced motion', () => {
  it('exposes every interactive control as a native, keyboard-operable element', () => {
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />)
    for (const el of screen.getAllByRole('button')) expect(el.tagName).toBe('BUTTON')
    for (const el of screen.getAllByRole('radio')) expect(el.tagName).toBe('BUTTON')
    expect(screen.getByLabelText('Amount in USDC').tagName).toBe('INPUT')
  })

  // I5 (review finding): the old test only checked tagName -- it could not catch a missing ARIA
  // APG radiogroup implementation. These press real keys and assert real focus/selection moves.
  it('I5: arrow keys move focus AND change the comfort-level selection (roving tabindex, real APG radiogroup)', () => {
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />)
    const [steady, balanced, adventurous] = screen.getAllByRole('radio')

    // Roving tabindex: exactly one stop in the tab order before any selection is made.
    expect(steady.tabIndex).toBe(0)
    expect(balanced.tabIndex).toBe(-1)
    expect(adventurous.tabIndex).toBe(-1)

    steady.focus()
    fireEvent.keyDown(steady, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(balanced)
    expect(balanced.getAttribute('aria-checked')).toBe('true')
    expect(steady.getAttribute('aria-checked')).toBe('false')
    expect(balanced.tabIndex).toBe(0)
    expect(steady.tabIndex).toBe(-1)

    fireEvent.keyDown(balanced, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(adventurous)
    expect(adventurous.getAttribute('aria-checked')).toBe('true')

    // Wraps at the end.
    fireEvent.keyDown(adventurous, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(steady)
    expect(steady.getAttribute('aria-checked')).toBe('true')

    fireEvent.keyDown(steady, { key: 'End' })
    expect(document.activeElement).toBe(adventurous)
    fireEvent.keyDown(adventurous, { key: 'Home' })
    expect(document.activeElement).toBe(steady)
  })

  // N2 (re-review finding, fix loop 2): the old test asserted on jsdom's
  // `getComputedStyle(...).animationName`, but jsdom reports "none" for the `animation` SHORTHAND
  // regardless of its value (verified directly: `.a { animation: k 1s infinite }` ->
  // animationName === "none"; only the longhand `animation-name: k` is visible to jsdom) -- and
  // every realistic violation (gradient/glow/shimmer/pulse) is written with the shorthand, so the
  // old test could never fail. This instead parses the actual shipped strategy.css source text --
  // the same "read and assert on the real file" mechanism this repo already uses for the
  // byte-for-byte contract-port checks (and the accepted jsdom/real-cascade tradeoff recorded in
  // Foundation Task 2) -- and asserts no `@keyframes`, `animation` declaration, or gradient value
  // exists anywhere in it. Falsifiable: reintroducing `@keyframes zzpulse` +
  // `animation: zzpulse 1s infinite` on `.pc-button--primary` fails this (see the fix report).
  it('I6: strategy.css defines no keyframes, animation, or gradient declarations (rejection checklist item 6)', () => {
    const css = fs.readFileSync(path.resolve(here, './strategy.css'), 'utf8')
    expect(css).not.toMatch(/@keyframes/i)
    expect(css).not.toMatch(/\banimation(-name)?\s*:/i)
    expect(css).not.toMatch(/gradient/i)
  })
})

describe('PlanStage — owner ruling (decision #19): friendly copy never renders in the mono face', () => {
  it('renders the editable instructions summary and body in the contract body face, not JetBrains Mono', async () => {
    await withRealStylesheet(async () => {
      const onGenerate = vi.fn().mockResolvedValue({
        source: 'deepseek',
        sourceState: 'live-ai',
        stellarUnits: '1000000000',
        baseAllocations: [],
      })
      render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
      await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
      await screen.findByRole('button', { name: 'Accept plan' })

      const summary = document.querySelector('.pc-technical-details-summary')
      const body = document.querySelector('.pc-technical-details-body')
      // jsdom does not resolve var(), but it DOES correctly resolve which declaration wins the
      // cascade (verified against these exact two files) -- so the raw winning text tells us
      // whether the mono override (--font-mono, Foundation's) or this task's body-face override
      // (--pc-font-body, strategy.css) is the one actually applied. If the mono face returns,
      // both of these flip back to `var(--font-mono)` and this test fails.
      expect(getComputedStyle(summary).fontFamily).toBe('var(--pc-font-body)')
      expect(getComputedStyle(body).fontFamily).toBe('var(--pc-font-body)')
    })
  })
})

describe('PlanStage — I8: Cap renders the plan agent\'s cap, never the display allocation', () => {
  it('renders a Cap value that tracks plan.agents[].cap even when it diverges from the allocation figure', async () => {
    // planModel.js (off-limits for this fix loop) always sets cap === allocation today, so a
    // black-box render can't distinguish "reads cap" from "reads allocation." vi.spyOn on the
    // real, still-imported module (not a full vi.mock/resetModules module-graph swap, which risks
    // loading a second React copy for a component test) proves the fix reads the field the review
    // named, per its suggested fix ("assert the two independently in a test with divergent
    // fixtures") -- `allocation` is left completely real, only `cap` is perturbed.
    const originalNormalize = planModel.normalizeStrategyPlan
    const spy = vi.spyOn(planModel, 'normalizeStrategyPlan').mockImplementation((input) => {
      const real = originalNormalize(input)
      return {
        ...real,
        agents: real.agents.map((a) => ({
          ...a,
          cap: { ...a.cap, units: (BigInt(a.cap.units) * 2n).toString() },
        })),
      }
    })
    try {
      const onGenerate = vi.fn().mockResolvedValue({
        source: 'deepseek',
        sourceState: 'live-ai',
        stellarUnits: '1000000000', // 100 USDC allocation
        baseAllocations: [],
      })
      render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
      await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
      await screen.findByRole('button', { name: 'Accept plan' })
      // allocation is 100 USDC; the spy doubled the plan-level cap to 200.
      expect(screen.getByText('Cap 200 USDC')).toBeTruthy()
      expect(screen.queryByText('Cap 100 USDC')).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})
