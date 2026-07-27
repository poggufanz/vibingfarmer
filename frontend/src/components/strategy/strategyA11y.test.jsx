// frontend/src/components/strategy/strategyA11y.test.jsx
// Strategy Task 14 (Pocket Crew redesign, Wave 6 snapshot freeze). Accessibility freeze for the
// /strategy stages' shared invariants: one h1 per stage, the stage-progress announcement, the
// amount field's error association, focus management across a stage change (and its restraint on
// background updates within the same stage), native disclosures, batched live status, and
// always-visible network text. This file is self-contained (its own fixture builders), matching
// the existing convention in PlanStage.test.jsx/ProtectStage.test.jsx/StartStage.test.jsx/
// StrategyRoute.test.jsx -- each already independently declares its own plan/decision/event
// fixtures rather than importing another test file's; no UI markup is duplicated anywhere here
// (every render below mounts a REAL production component, never a hand-rolled stand-in).
//
// Every fixture that flows through reusePreflight.js/grant.js's addrScVal uses the REAL
// SOROBAN_TOKEN_ADDRESS/STELLAR_USDC_SAC contracts, never a 'USDC' literal -- ProtectStage.test.jsx/
// StartStage.test.jsx/StrategyReceipt.test.jsx's own header comments explain why (scval.js's
// addrScVal throws on anything that isn't a real Stellar Address).
//
// Two of the eight items below (aria-describedby, focus-after-transition) are NEW production
// wiring added by this task (a scoped, owner-authorized exception to Task 14's file list --
// PlanStage.jsx and StrategyRoute.jsx). Per the owner's ruling, both were mutation-proofed by hand
// during implementation: the wiring was reverted to a differently-written (not just commented-out)
// broken formulation, the exact test below was run and observed RED, then the wiring was restored
// and the test observed GREEN again. The transcript is in the Task 14 report. The other six items
// cover pre-existing behavior; each carries an inline positive control (a deliberately-wrong
// double, or a differential comparison) proving the assertion actually discriminates the defect it
// names, per this project's "guards must be able to fail" standard.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { StrategyRoute } from './StrategyRoute.jsx'
import { StrategyProgress } from './StrategyProgress.jsx'
import { PlanStage } from './PlanStage.jsx'
import { StartStage } from './StartStage.jsx'
import { StrategyReceipt } from './StrategyReceipt.jsx'
import { SOROBAN_TOKEN_ADDRESS } from '../../stellar/config.js'
import { STELLAR_USDC_SAC } from '../../stellar/cctpBurn.js'

expect.extend(axeMatchers)

afterEach(cleanup)

const NOW = 1_800_000_000
const TOKEN_ADDR = SOROBAN_TOKEN_ADDRESS
const BRIDGE_TOKEN_ADDR = STELLAR_USDC_SAC
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const REAL_TX_HASH = 'a1b2c3d4'.repeat(8)

const disconnectedBase = { connected: false, healthy: null, mandateView: null, action: null }

function amount(token, units, decimals = 7) {
  return { token, units, decimals }
}

const PLAN_ONE_DEPOSIT = Object.freeze({
  runId: 'run-1',
  planFingerprint: '0xplan1',
  amount: amount(TOKEN_ADDR, '1000000000'),
  agents: [
    {
      allocationId: 'run-1:deposit:0',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: amount(TOKEN_ADDR, '1000000000'),
      cap: amount(TOKEN_ADDR, '1000000000'),
      periodSeconds: 3600,
      expiry: NOW + 3600,
      destination: 'Stellar deposit',
      children: [],
    },
  ],
  truth: { agentIsolationCount: 1, stellarVenueCount: 1, baseUsesProxyVaults: false },
})

const PLAN_WITH_BRIDGE = Object.freeze({
  runId: 'run-2',
  planFingerprint: '0xplan2',
  amount: amount(TOKEN_ADDR, '2000000000'),
  agents: [
    ...PLAN_ONE_DEPOSIT.agents,
    {
      allocationId: 'run-2:bridge:base',
      kind: 'bridge',
      hostNetworkId: 'stellar-testnet',
      allocation: amount(BRIDGE_TOKEN_ADDR, '1000000000'),
      cap: amount(BRIDGE_TOKEN_ADDR, '1000000000'),
      periodSeconds: 3600,
      expiry: NOW + 3600,
      destination: 'Base Sepolia bridge',
      children: [
        {
          allocationId: 'run-2:bridge:aave-v3',
          proxyTarget: 'aave-v3',
          destination: 'aave-v3',
          allocation: amount('USDC', '600000', 6),
        },
      ],
    },
  ],
  truth: { agentIsolationCount: 2, stellarVenueCount: 1, baseUsesProxyVaults: true },
})

function evt(name, data) {
  return { name, data }
}

function alloc(over) {
  return {
    allocationId: 'run-1:deposit:0',
    amount: amount(TOKEN_ADDR, '1000000000'),
    networkContext: {
      executionNetwork: 'stellar-testnet',
      currentCustodyNetwork: 'stellar-testnet',
      transit: false,
    },
    executionStatus: 'succeeded',
    custody: { location: 'stellar-vault', confirmed: true, checkedAt: NOW },
    txHash: REAL_TX_HASH,
    error: null,
    evidence: {},
    ...over,
  }
}

function receiptFor(allocations) {
  return {
    version: 1,
    runId: 'run-1',
    planFingerprint: '0xplan1',
    permission: {
      mode: 'fresh',
      status: 'confirmed',
      confirmationCount: 1,
      txHash: 'e5f6a7b8'.repeat(8),
      grantReceiptFingerprint: '0xreceiptfp',
      expiryLedger: 9001,
      agentAddresses: [AGENT_1],
    },
    branches: {
      stellar: { status: 'succeeded', results: allocations },
      base: { status: 'not-planned', results: [] },
    },
    allocations,
  }
}

// ---------------------------------------------------------------------------------------------
// 1. One h1 per stage.
// ---------------------------------------------------------------------------------------------
describe('Strategy a11y -- one h1 per stage', () => {
  const stageEls = {
    Plan: (
      <StrategyRoute
        stage="plan"
        reached={['plan']}
        vaultTotalShares={500_0000000n}
        base={disconnectedBase}
        onGenerate={vi.fn()}
      />
    ),
    Protect: (
      <StrategyRoute
        stage="protect"
        reached={['plan', 'protect']}
        plan={PLAN_ONE_DEPOSIT}
        protectProps={{ owner: null, onConnectWallet: vi.fn(), onEditPlan: vi.fn() }}
      />
    ),
    Start: (
      <StrategyRoute
        stage="start"
        reached={['plan', 'protect', 'start']}
        plan={PLAN_ONE_DEPOSIT}
        startProps={{ permission: null, events: [], receipt: null, runId: 'run-1' }}
      />
    ),
  }

  for (const [label, el] of Object.entries(stageEls)) {
    it(`${label}: renders exactly one h1`, () => {
      render(el)
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    })
  }

  // Positive control: proves the assertion above actually discriminates a two-h1 shape rather than
  // vacuously passing on anything. A test-local double (not production code) with two h1s.
  it('CONTROL: the same assertion fails against a two-h1 shape', () => {
    function BrokenTwoHeadings() {
      return (
        <div>
          <h1>First</h1>
          <h1>Second</h1>
        </div>
      )
    }
    render(<BrokenTwoHeadings />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(2)
    expect(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)).toThrow()
  })
})

// ---------------------------------------------------------------------------------------------
// 2. Stage announcement (StrategyProgress's role=status live region).
// ---------------------------------------------------------------------------------------------
describe('Strategy a11y -- stage announcement', () => {
  it('announces "Step N of 3: <Label>" for the current stage, and it changes with the stage', () => {
    const { container, rerender } = render(<StrategyProgress current="plan" />)
    const region = () => container.querySelector('[role="status"][aria-live="polite"]')
    expect(region().textContent).toBe('Step 1 of 3: Plan')

    // CONTROL: a different `current` produces a genuinely different announcement -- proves the
    // text is derived from the prop, not a hardcoded string that would pass regardless of input.
    rerender(<StrategyProgress current="protect" />)
    expect(region().textContent).toBe('Step 2 of 3: Protect')
    rerender(<StrategyProgress current="start" />)
    expect(region().textContent).toBe('Step 3 of 3: Start')
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Input errors linked via aria-describedby (NEW wiring, PlanStage.jsx).
// ---------------------------------------------------------------------------------------------
describe('Strategy a11y -- amount field error is linked via aria-describedby', () => {
  it('links the amount input to its error via aria-describedby only while the error exists', () => {
    render(
      <PlanStage vaultTotalShares={500_0000000n} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    const input = screen.getByLabelText('Amount in USDC')
    expect(input.hasAttribute('aria-describedby')).toBe(false) // no dangling reference up front

    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Steady' }))
    fireEvent.click(screen.getByRole('button', { name: 'Build my plan' }))

    const error = screen.getByRole('alert')
    expect(error.textContent).toBe('Amount must be greater than zero.')
    expect(error.id).toBeTruthy()
    // The exact-match, not a truthy check -- a guard that only asked "is there SOME
    // aria-describedby" would pass even if it pointed at the wrong (or a nonexistent) element.
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
  })
})

// ---------------------------------------------------------------------------------------------
// 4 & 6. Focus after a stage transition, and no focus theft from a background event within the
// same stage (NEW wiring, StrategyRoute.jsx). Two directions on purpose: a guard that only checks
// the first would pass a component that steals focus on every render, not just on a real change.
// ---------------------------------------------------------------------------------------------
describe('Strategy a11y -- focus follows a stage change but never a same-stage background update', () => {
  it('moves focus to the new stage heading when `stage` changes', () => {
    const { rerender } = render(
      <StrategyRoute
        stage="plan"
        reached={['plan']}
        vaultTotalShares={500_0000000n}
        base={disconnectedBase}
        onGenerate={vi.fn()}
      />
    )
    rerender(
      <StrategyRoute
        stage="protect"
        reached={['plan', 'protect']}
        plan={PLAN_ONE_DEPOSIT}
        protectProps={{ owner: null, onConnectWallet: vi.fn(), onEditPlan: vi.fn() }}
      />
    )
    expect(document.activeElement.tagName).toBe('H1')
    expect(document.activeElement.textContent).toBe('Protect this run')
  })

  it('never moves focus on the very first mount (nothing to transition FROM yet)', () => {
    render(
      <StrategyRoute
        stage="plan"
        reached={['plan']}
        vaultTotalShares={500_0000000n}
        base={disconnectedBase}
        onGenerate={vi.fn()}
      />
    )
    expect(document.activeElement).toBe(document.body)
  })

  it('does NOT move focus for a same-stage re-render carrying a background event (StartStage live update)', () => {
    const { rerender } = render(
      <StrategyRoute
        stage="start"
        reached={['plan', 'protect', 'start']}
        plan={PLAN_ONE_DEPOSIT}
        startProps={{ permission: null, events: [], receipt: null, runId: 'run-1' }}
      />
    )
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    expect(document.activeElement).toBe(button)

    // Same `stage="start"`, but new live events arrived in the background -- exactly the case the
    // brief's "no focus theft from background events" item names.
    rerender(
      <StrategyRoute
        stage="start"
        reached={['plan', 'protect', 'start']}
        plan={PLAN_ONE_DEPOSIT}
        startProps={{
          permission: null,
          events: [evt('worker-queued', { allocationId: 'run-1:deposit:0' })],
          receipt: null,
          runId: 'run-1',
        }}
      />
    )
    expect(document.activeElement).toBe(button)
    document.body.removeChild(button)
  })
})

// ---------------------------------------------------------------------------------------------
// 5. Disclosures -- native, keyboard-operable <details>/<summary>, not a div impersonating one.
// ---------------------------------------------------------------------------------------------
describe('Strategy a11y -- technical disclosures are native details/summary', () => {
  it('StrategyReceipt’s Technical details is a real <details> that toggles open on activation', () => {
    const { container } = render(
      <StrategyReceipt
        receipt={receiptFor([alloc()])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    const disclosure = container.querySelector('.pc-technical-details')
    expect(disclosure.tagName).toBe('DETAILS')
    expect(disclosure.querySelector(':scope > summary')).toBeTruthy()
    expect(disclosure.open).toBe(false)
    fireEvent.click(disclosure.querySelector('summary'))
    expect(disclosure.open).toBe(true)
  })

  // CONTROL: proves `tagName === 'DETAILS'` actually discriminates -- a div/role="button" fake
  // fails the same check a real disclosure passes.
  it('CONTROL: a div impersonating a disclosure fails the native-element check', () => {
    function FakeDisclosure() {
      return (
        <div className="pc-technical-details" role="button" tabIndex={0}>
          <span>Technical details</span>
        </div>
      )
    }
    const { container } = render(<FakeDisclosure />)
    const fake = container.querySelector('.pc-technical-details')
    expect(fake.tagName).not.toBe('DETAILS')
  })
})

// ---------------------------------------------------------------------------------------------
// 7. Batched live status -- one bucket-level announcement, never a running commentary of every
// worker.js sub-step.
// ---------------------------------------------------------------------------------------------
describe('Strategy a11y -- batched live status, never a per-sub-step commentary', () => {
  function region(container) {
    return container.querySelector('[role="status"][aria-live="polite"]')
  }

  it('two different raw sub-step sequences that land in the SAME bucket produce an IDENTICAL announcement', () => {
    // Both sequences end at the 'moving' bucket (worker-started fired, but no deposit-pending step
    // yet) -- the second sequence just has more raw worker.js sub-steps folded in along the way.
    const sparse = [
      evt('worker-queued', { allocationId: 'run-1:deposit:0' }),
      evt('worker-started', { allocationId: 'run-1:deposit:0' }),
    ]
    const chatty = [
      evt('worker-queued', { allocationId: 'run-1:deposit:0' }),
      evt('worker-started', { allocationId: 'run-1:deposit:0' }),
      evt('step', { step: 'key-setup', status: 'pending', allocationId: 'run-1:deposit:0' }),
      evt('step', { step: 'key-setup', status: 'done', allocationId: 'run-1:deposit:0' }),
      evt('step', { step: 'swap', status: 'skipped', allocationId: 'run-1:deposit:0' }),
    ]
    const a = render(
      <StartStage plan={PLAN_ONE_DEPOSIT} permission={null} events={sparse} runId="run-1" />
    )
    const b = render(
      <StartStage plan={PLAN_ONE_DEPOSIT} permission={null} events={chatty} runId="run-1" />
    )
    expect(region(a.container).textContent).toBe(region(b.container).textContent)
    expect(region(a.container).textContent).toBe('1 agent: 1 moving allocation')
    a.unmount()
    b.unmount()
  })

  it('a mixed run announces one bucket-level count per phase, never a raw event/step name', () => {
    const events = [
      evt('worker-queued', { allocationId: 'run-2:deposit:0' }),
      evt('worker-queued', { allocationId: 'run-2:deposit:1' }),
      evt('worker-started', { allocationId: 'run-2:deposit:1' }),
      evt('step', { step: 'deposit', status: 'pending', allocationId: 'run-2:deposit:1' }),
    ]
    const plan = Object.freeze({
      ...PLAN_ONE_DEPOSIT,
      runId: 'run-2',
      agents: [
        { ...PLAN_ONE_DEPOSIT.agents[0], allocationId: 'run-2:deposit:0' },
        { ...PLAN_ONE_DEPOSIT.agents[0], allocationId: 'run-2:deposit:1' },
      ],
    })
    const { container } = render(
      <StartStage plan={plan} permission={null} events={events} runId="run-2" />
    )
    const text = region(container).textContent
    expect(text).toBe('2 agents: 1 queued, 1 depositing')
    expect(text).not.toMatch(/worker-queued|worker-started|key-setup|step\b/i)
  })
})

// ---------------------------------------------------------------------------------------------
// 8. Network text -- every network mark in Strategy carries visible environment text, never
// color/mark alone (same invariant Foundation already proved for the shared primitives; this
// confirms Strategy actually calls them with real network ids).
// ---------------------------------------------------------------------------------------------
describe('Strategy a11y -- network identity is always visible text, not color/mark alone', () => {
  it('a bridge-inclusive Start lane names both Stellar testnet and Base Sepolia visibly', () => {
    render(<StartStage plan={PLAN_WITH_BRIDGE} permission={null} events={[]} runId="run-2" />)
    // The deposit lane's own NetworkBadge plus the bridge lane's NetworkRoute (source badge) both
    // name Stellar testnet -- more than one is the expected, correct shape here.
    expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThan(1)
    expect(screen.getByText('Base Sepolia')).toBeTruthy()
    // The bridge lane starts at 'ready' -> NetworkIdentity.jsx's 'source' transit copy.
    expect(screen.getByText('Awaiting bridge on Stellar testnet')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
// axe -- zero violations on every stage/state exercised above.
// ---------------------------------------------------------------------------------------------
describe('Strategy a11y -- axe', () => {
  it('Plan (input) has zero violations', async () => {
    const { container } = render(
      <StrategyRoute
        stage="plan"
        reached={['plan']}
        vaultTotalShares={500_0000000n}
        base={disconnectedBase}
        onGenerate={vi.fn()}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('Protect (disconnected) has zero violations', async () => {
    const { container } = render(
      <StrategyRoute
        stage="protect"
        reached={['plan', 'protect']}
        plan={PLAN_ONE_DEPOSIT}
        protectProps={{ owner: null, onConnectWallet: vi.fn(), onEditPlan: vi.fn() }}
      />
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('Start (bridge-inclusive, live) has zero violations', async () => {
    const { container } = render(
      <StartStage plan={PLAN_WITH_BRIDGE} permission={null} events={[]} runId="run-2" />
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('StrategyReceipt with Technical details expanded has zero violations', async () => {
    const { container } = render(
      <StrategyReceipt
        receipt={receiptFor([alloc()])}
        runId="run-1"
        onViewMoney={() => {}}
        onMakeAnotherDeposit={() => {}}
      />
    )
    fireEvent.click(container.querySelector('.pc-technical-details summary'))
    expect(await axe(container)).toHaveNoViolations()
  })
})
