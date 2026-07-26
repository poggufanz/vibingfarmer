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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { PlanStage } from './PlanStage.jsx'
import { FIRST_DEPOSIT_MIN_UNITS } from '../../strategy/amountValidation.js'

expect.extend(axeMatchers)

afterEach(cleanup)

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
    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({ baseEligible: false }))
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
    // Never rendered inside the reviewed-plan surface -- there is no plan yet at all.
    expect(screen.queryByRole('button', { name: 'Accept plan' })).toBeNull()
  })

  it('a healthy relayer with a ready mandate makes Base eligible for generation', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
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
    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({ baseEligible: true }))
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
  it('shows the three real phases while a promise is pending, with no fake speed*delay timer', async () => {
    const gen = deferred()
    const onGenerate = vi.fn().mockReturnValue(gen.promise)
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ onGenerate })

    expect(screen.getByText('Checking destinations')).toBeTruthy()
    expect(screen.getByText('Building bounded allocations')).toBeTruthy()
    expect(screen.getByText('Safety review')).toBeTruthy()
    // Still pending: nothing after this point should require fake timers to observe.
    expect(screen.queryByRole('button', { name: 'Accept plan' })).toBeNull()

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
    expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThanOrEqual(2)
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
    expect(screen.getAllByText('Yield unavailable').length).toBeGreaterThan(0)
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
      stellarUnits: '1000000000',
      baseAllocations: [
        { address: '0xAAA', proxyTarget: 'aave-v3', factSlug: 'aave-v3-base', units: '30000000', chain: 'base' },
        { address: '0xBBB', proxyTarget: 'morpho-blue', factSlug: 'morpho-blue-base', units: '20000000', chain: 'base' },
      ],
    })
    render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={readyBase} onGenerate={onGenerate} />)
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
  }

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

  it('renders the same reviewed plan under prefers-reduced-motion with no timer-driven state', async () => {
    const original = window.matchMedia
    window.matchMedia = (query) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })
    try {
      const onGenerate = vi.fn().mockResolvedValue({
        source: 'deepseek',
        sourceState: 'live-ai',
        stellarUnits: '1000000000',
        baseAllocations: [],
      })
      render(<PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />)
      await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
      await screen.findByRole('button', { name: 'Accept plan' })
      expect(screen.queryByText(/speed/i)).toBeNull()
    } finally {
      window.matchMedia = original
    }
  })
})
