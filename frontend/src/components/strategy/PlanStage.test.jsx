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

vi.mock('../../base/deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } =
    await import('../../base/hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

import { PlanStage } from './PlanStage.jsx'
import { StrategyRoute } from './StrategyRoute.jsx'
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

// Fix loop 3 -- G1 regression guard. jsdom never runs layout (getBoundingClientRect/scrollWidth
// are inert there, and `min-width: max-content`/grid-track sizing is never computed) -- that is
// exactly why the I6/I9 guards two loops ago were computed-style-only and provably could not see
// their own regressions (see the review's mutation tests). A real overflow -- a grid track forced
// wider than its container by a button's forced min-content width -- needs a real layout engine to
// observe. Rather than adding a new devDependency, this launches a Chromium binary this machine
// already has (either @playwright/test's own managed download, if present, or the OS's installed
// Chrome/Chromium -- @playwright/test's driver already ships in this repo either way) against the
// REAL shipped style.css + pocket-crew.css + strategy.css and a real jsdom-rendered DOM dump, and
// reads back `scrollWidth` the way an actual 320px phone would.
const LEGACY_STYLESHEET = fs.readFileSync(path.resolve(here, '../../../style.css'), 'utf8')
const GEIST_FONT_HREF =
  'file://' + path.resolve(here, '../../../node_modules/@fontsource-variable/geist/index.css')

function buildLayoutHarnessHtml(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${GEIST_FONT_HREF}">
<style>${LEGACY_STYLESHEET}</style>
<style>${REAL_STYLESHEET}</style>
</head><body>${bodyHtml}</body></html>`
}

// undefined first -- prefer Playwright's own managed browser download when one exists (this is
// what a CI box with `playwright install` already ran will hit); the explicit paths are a fallback
// for a dev machine/sandbox that only has a system browser, never a new download.
const CHROMIUM_CANDIDATES = [
  undefined,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
]

async function launchRealChromium() {
  const { chromium } = await import('playwright-core')
  let lastErr
  for (const executablePath of CHROMIUM_CANDIDATES) {
    if (executablePath && !fs.existsSync(executablePath)) continue
    try {
      return await chromium.launch(
        executablePath ? { executablePath, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] }
      )
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `G1 layout guard: no usable Chromium binary found for real-layout measurement (${lastErr?.message})`
  )
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
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    expect(screen.getByLabelText('Amount in USDC')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Steady' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Balanced' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Adventurous' })).toBeTruthy()
  })

  it('never renders an advanced crew-count input', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    expect(screen.queryByLabelText(/crew|agent count|number of agents/i)).toBeNull()
  })

  it('renders the literal "nothing moves" reassurance before any signature', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    expect(screen.getByText(/Nothing moves until you review and confirm/)).toBeTruthy()
  })

  it('groups the Base connect and build actions in their own spaced row', () => {
    const { container } = render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    const actions = container.querySelector('.pc-plan-actions')
    expect(actions.children).toHaveLength(2)
    expect(actions.contains(screen.getByRole('button', { name: 'Build my plan' }))).toBe(true)
  })

  it('disables submit until an amount and a comfort level are both chosen', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    const submit = screen.getByRole('button', { name: 'Build my plan' })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '100' } })
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Steady' }))
    expect(submit.disabled).toBe(false)
  })

  it('shows an inline field error for an unusable amount instead of proceeding', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
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

  // G1 (re-review after fix loop 2): the disconnected first-visit input phase -- the one state
  // that renders `Connect to check Base testnet` -- overflowed a 320px device (documentElement
  // .scrollWidth measured 325 in a real browser). Rendered through StrategyRoute (not PlanStage
  // alone) so `.pc-route`'s real mobile gutter/width math is in play, exactly as the review
  // measured it.
  it('G1: creates no horizontal overflow at a 320px viewport, measured in a real layout engine', async () => {
    const { container } = render(
      <StrategyRoute
        stage="plan"
        reached={['plan']}
        vaultTotalShares={FUNDED_VAULT}
        base={disconnectedBase}
        onGenerate={vi.fn()}
      />
    )
    const browser = await launchRealChromium()
    try {
      const page = await browser.newPage()
      await page.setViewportSize({ width: 320, height: 900 })
      await page.setContent(buildLayoutHarnessHtml(container.innerHTML))
      const { scrollWidth, decisionRight, maxDescendantRight } = await page.evaluate(() => {
        const decision = document.querySelector('.pc-dominant--decision')
        const decisionRect = decision.getBoundingClientRect()
        let maxRight = 0
        for (const el of decision.querySelectorAll('*')) {
          maxRight = Math.max(maxRight, el.getBoundingClientRect().right)
        }
        return {
          scrollWidth: document.documentElement.scrollWidth,
          decisionRight: decisionRect.right,
          maxDescendantRight: maxRight,
        }
      })
      expect(scrollWidth).toBe(320)
      // The fix must trade nothing for clipping: no element inside the decision surface may
      // extend past the surface's own right edge (that would mean overflow got hidden, not
      // removed).
      expect(maxDescendantRight).toBeLessThanOrEqual(decisionRight + 0.5)
    } finally {
      await browser.close()
    }
  }, 20000)
})

describe('PlanStage — Base availability is consumed, never re-derived', () => {
  it('disconnected: offers Connect to check Base testnet and never claims Base is available', async () => {
    const onConnectForBase = vi.fn()
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [
        { address: '0xAAA', proxyTarget: 'aave-v3', units: '50000000', chain: 'base' },
      ],
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
        {
          address: '0xAAA',
          proxyTarget: 'aave-v3',
          factSlug: 'aave-v3-base',
          units: '50000000',
          chain: 'base',
        },
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
        base={{
          connected: true,
          healthy: true,
          mandateView: { status: 'missing', ready: false },
          action: null,
        }}
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
  it('rotates reassuring copy and counts elapsed time while generation is pending', async () => {
    vi.useFakeTimers()
    const gen = deferred()
    const { unmount } = render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={disconnectedBase}
        onGenerate={vi.fn().mockReturnValue(gen.promise)}
      />
    )

    try {
      await fillAndSubmit({})
      expect(screen.getByText('Building your plan')).toBeTruthy()
      expect(screen.getByText('00:00')).toBeTruthy()

      act(() => vi.advanceTimersByTime(3000))

      expect(screen.getByText('Making the strategy work for you')).toBeTruthy()
      expect(screen.getByText('00:03')).toBeTruthy()
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('shows one honest generating message, never a fake simultaneous 3-phase list, when the caller reports no phases', async () => {
    const gen = deferred()
    const onGenerate = vi.fn().mockReturnValue(gen.promise)
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
    await fillAndSubmit({ onGenerate })

    expect(screen.getByText('Working on it…')).toBeTruthy()
    expect(document.querySelector('.pc-plan-building[aria-busy="true"] .think-spin')).toBeTruthy()
    // The old implementation rendered all three as a static list regardless of any real signal --
    // that is exactly what this proves is gone: none of the three phase labels is shown unless
    // the caller actually reported it (see the next test).
    expect(screen.queryByText('Checking destinations')).toBeNull()
    expect(screen.queryByText('Building bounded allocations')).toBeNull()
    expect(screen.queryByText('Safety review')).toBeNull()
    // Still pending: nothing after this point should require fake timers to observe.
    expect(screen.queryByRole('button', { name: 'Accept plan' })).toBeNull()

    gen.resolve({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    await screen.findByRole('button', { name: 'Accept plan' })
  })

  it('advances through real caller-reported phases one at a time, in response to genuine events -- never all at once', async () => {
    const gen = deferred()
    let reportPhase
    const onGenerate = vi.fn((_input, report) => {
      reportPhase = report
      return gen.promise
    })
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
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

    gen.resolve({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    await screen.findByRole('button', { name: 'Accept plan' })
  })

  it('surfaces a generation failure without crashing and lets the user try again', async () => {
    const onGenerate = vi.fn().mockRejectedValueOnce(new Error('network down'))
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
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
        stellarVenue={{
          name: 'Vibing Farmer Autofarm',
          chain: 'stellar',
          yield: { state: 'live', apy: 5.5 },
        }}
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

  it('reviews the real agent count and per-agent cap, with one shared expiry/yield summary', async () => {
    await generateStellarOnlyPlan()
    // risk 'Balanced' (med) -> exactly 2 real deposit agents, no manual count anywhere.
    expect(screen.getAllByText(/^Cap /)).toHaveLength(2)
    // Owner report item 6: expiry and yield are PLAN-level facts -- every deposit agent from one
    // generation call shares the same expiry/venue -- hoisted into ONE shared summary line above
    // the worker list instead of repeated once per row.
    expect(screen.getAllByText(/^Expires /)).toHaveLength(1)
    expect(screen.getByText('5.5% APY')).toBeTruthy()
    expect(screen.getByText('100 USDC')).toBeTruthy() // review amount total
  })

  it('renders the Stellar truth block: isolated accounts, one live venue, Autofarm -> Blend', async () => {
    await generateStellarOnlyPlan()
    expect(screen.getByText('2 isolated accounts')).toBeTruthy()
    expect(screen.getByText('1 live venue')).toBeTruthy()
    expect(screen.getByText(/Vibing Farmer Autofarm supplies to Blend/)).toBeTruthy()
  })

  it('shows one shared network badge above the worker list, not repeated per allocation', async () => {
    await generateStellarOnlyPlan()
    // risk 'Balanced' (med) -> exactly 2 deposit agents sharing ONE Stellar testnet badge -- an
    // identical badge repeated per row was exactly the "info blocks repeated 3x" defect the owner
    // reported (item 6). Fix loop 1 -- Important 2 (review finding): a plain document-wide count
    // stopped being a precise proxy once Task 4's aside ALSO mentions "Stellar testnet" once, in
    // its own unrelated provenance breadcrumb (`.pc-plan-so-far`) -- but disambiguating that by
    // scoping ONLY to `.pc-plan-facts` (the hoisted summary itself) silently dropped the actual
    // regression this test exists to catch: the worker rows it guards live in the SIBLING
    // `.pc-allocation-list`, entirely outside `.pc-plan-facts`, so a badge reintroduced per row
    // there would never be seen by a `.pc-plan-facts`-only query. Asserting BOTH -- zero inside
    // the worker list, exactly one inside the hoisted summary -- restores the original coverage
    // while still tolerating the new breadcrumb.
    expect(
      within(document.querySelector('.pc-allocation-list')).queryAllByText('Stellar testnet')
    ).toHaveLength(0)
    expect(
      within(document.querySelector('.pc-plan-facts')).getAllByText('Stellar testnet')
    ).toHaveLength(1)
  })

  it('renders "Yield unavailable" honestly when the venue carries no live yield', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    const note = screen.getByText('Yield unavailable')
    expect(note.className).toMatch(/pc-plan-yield-note/)
    expect(note.textContent).not.toContain('!')
    expect(document.querySelector('.pc-plan-facts').contains(note)).toBe(false)
  })

  it('does not use a flat catalog APY for the plan estimate', async () => {
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
        stellarVenue={{
          name: 'Vibing Farmer Autofarm',
          chain: 'stellar',
          apy: 4.8,
        }}
        onGenerate={onGenerate}
      />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })

    expect(screen.getByText('Yield unavailable')).toBeTruthy()
    expect(screen.queryByText('4.8% APY')).toBeNull()
    expect(screen.queryByText('Estimated in 30 days')).toBeNull()
    expect(screen.queryByText(/USDC\/day estimated/)).toBeNull()
  })

  it('uses only explicit live venue evidence for the plan estimate', async () => {
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
        stellarVenue={{
          name: 'Vibing Farmer Autofarm',
          chain: 'stellar',
          apy: 4.8,
          yield: { state: 'live', apy: 5.5, asOf: Date.now() },
        }}
        onGenerate={onGenerate}
      />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })

    expect(screen.getByText('5.5% APY')).toBeTruthy()
    expect(screen.queryByText('4.8% APY')).toBeNull()
    expect(screen.getByText('Estimated in 30 days')).toBeTruthy()
    expect(screen.getByText('+0.45 USDC')).toBeTruthy()
  })

  it('keeps the reviewed plan until Change amount is confirmed', async () => {
    await generateStellarOnlyPlan()
    fireEvent.click(screen.getByText('Change mind?'))
    fireEvent.click(screen.getByRole('button', { name: 'Change amount' }))
    const dialog = screen.getByRole('dialog', { name: 'Change this amount?' })
    expect(screen.getByRole('button', { name: 'Accept plan' })).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep current plan' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Accept plan' })).toBeTruthy()

    fireEvent.click(screen.getByText('Change mind?'))
    fireEvent.click(screen.getByRole('button', { name: 'Change amount' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Change amount' })
    )
    expect(screen.getByLabelText('Amount in USDC').value).toBe('100')
    expect(screen.getByRole('radio', { name: 'Balanced' }).getAttribute('aria-checked')).toBe(
      'true'
    )
  })

  it('clears the amount and comfort choice only after Reset plan is confirmed', async () => {
    await generateStellarOnlyPlan()
    fireEvent.click(screen.getByText('Change mind?'))
    fireEvent.click(screen.getByRole('button', { name: 'Reset plan' }))
    const dialog = screen.getByRole('dialog', { name: 'Reset this plan?' })
    expect(screen.queryByLabelText('Amount in USDC')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset plan' }))
    expect(screen.getByLabelText('Amount in USDC').value).toBe('')
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.getAttribute('aria-checked')).toBe('false')
    }
  })

  it('places Accept plan beside a 25% Change mind dropdown', async () => {
    await generateStellarOnlyPlan()
    const actions = document.querySelector('.pc-plan-final-actions')
    expect(actions.firstElementChild).toBe(screen.getByRole('button', { name: 'Accept plan' }))
    expect(within(actions).getByText('Change mind?')).toBeTruthy()
    await withRealStylesheet(async () => {
      expect(getComputedStyle(actions).gridTemplateColumns).toMatch(/3fr.*1fr/)
    })
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

  it('hands Protect a Stellar contract address instead of the USDC display symbol', async () => {
    const { onAcceptPlan } = await generateStellarOnlyPlan()
    fireEvent.click(screen.getByRole('button', { name: 'Accept plan' }))

    expect(onAcceptPlan.mock.calls[0][0].plan.agents[0].cap.token).toBe(
      'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
    )
  })

  it('Task 5 regression: plan.review from the generator survives runGeneration onto the plan handed to onAcceptPlan', async () => {
    // Guards PlanStage.jsx's runGeneration, which builds an explicit object literal for
    // normalizeStrategyPlan (only runId/risk/source/sourceState/stellarUnits/baseAllocations,
    // never a spread of the generator's result) -- `review: result.review` is a deliberate line
    // in that literal, easy to delete by accident with the suite staying green, since no other
    // test asserts it. This also covers handleAccept's `{...plan, ...}` spread in the same stroke.
    const review = {
      candidates: [
        { protocol: 'Aave v3 (proxy)', chain: 'base', eligible: false, reasons: ['facts stale'] },
      ],
    }
    const { onAcceptPlan } = await generateStellarOnlyPlan({ review })
    fireEvent.click(screen.getByRole('button', { name: 'Accept plan' }))
    const call = onAcceptPlan.mock.calls[0][0]
    expect(call.plan.review).toEqual(review)
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
        {
          address: '0xAAA',
          proxyTarget: 'aave-v3',
          factSlug: 'aave-v3-base',
          units: '30000000',
          chain: 'base',
        },
        {
          address: '0xBBB',
          proxyTarget: 'morpho-blue',
          factSlug: 'morpho-blue-base',
          units: '20000000',
          chain: 'base',
        },
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
        {
          address: '0xAAA',
          proxyTarget: 'aave-v3',
          factSlug: 'aave-v3-base',
          units: '30000000',
          chain: 'base',
        },
        {
          address: '0xBBB',
          proxyTarget: 'morpho-blue',
          factSlug: 'morpho-blue-base',
          units: '20000000',
          chain: 'base',
        },
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

describe('PlanStage — generation error layout', () => {
  it('keeps one spacing token between the error notice and the retry button', async () => {
    const onGenerate = vi.fn().mockRejectedValue(new Error('Strategy provider unavailable'))
    const { container } = render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady' })
    await screen.findByRole('alert')

    const browser = await launchRealChromium()
    try {
      const page = await browser.newPage()
      await page.setViewportSize({ width: 656, height: 480 })
      await page.setContent(buildLayoutHarnessHtml(container.innerHTML))
      const gap = await page.evaluate(() => {
        const notice = document.querySelector('.pc-status-notice')
        const retry = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent.trim() === 'Build my plan'
        )
        return retry.getBoundingClientRect().top - notice.getBoundingClientRect().bottom
      })

      expect(gap).toBe(16)
    } finally {
      await browser.close()
    }
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
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
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
        base={{
          connected: true,
          healthy: true,
          mandateView: { status: 'missing', ready: false },
          action: null,
        }}
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
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={disconnectedBase}
        runId="run-fixed"
        onGenerate={onGenerate}
      />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    const firstMark = document.querySelector('[data-agent-kind="deposit"] .pc-plan-agent-avatar')
    const firstAvatar = firstMark.getAttribute('src')
    unmount()

    render(
      <PlanStage
        vaultTotalShares={FUNDED_VAULT}
        base={disconnectedBase}
        runId="run-fixed"
        onGenerate={onGenerate}
      />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    const secondMark = document.querySelector('[data-agent-kind="deposit"] .pc-plan-agent-avatar')
    const secondAvatar = secondMark.getAttribute('src')

    expect(secondAvatar).toBe(firstAvatar)
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
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    for (const el of screen.getAllByRole('button')) expect(el.tagName).toBe('BUTTON')
    for (const el of screen.getAllByRole('radio')) expect(el.tagName).toBe('BUTTON')
    expect(screen.getByLabelText('Amount in USDC').tagName).toBe('INPUT')
  })

  // I5 (review finding): the old test only checked tagName -- it could not catch a missing ARIA
  // APG radiogroup implementation. These press real keys and assert real focus/selection moves.
  it('I5: arrow keys move focus AND change the comfort-level selection (roving tabindex, real APG radiogroup)', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
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

  // N2 (re-review finding, fix loop 3): the CSS-source check above is blind to a button that
  // animates via an inline `style={{ animation: ... }}` prop instead of a class rule -- mutation-
  // verified: injecting `style={{ animation: 'zzpulse 1s infinite' }}` onto the primary button in
  // PlanStage.jsx left the old guard green. This surface has zero inline styles today (every
  // visual property is a `.pc-*` class from strategy.css/pocket-crew.css, per repo convention), so
  // reading the raw JSX source text for `style=` or the word `animation` is a real, falsifiable
  // check, not a false-positive risk -- it currently matches nothing in any of the three files.
  it('N2: no component in this surface sets an inline style or an inline animation (rejection checklist item 6, JSX route)', () => {
    for (const file of ['./PlanStage.jsx', './StrategyRoute.jsx', './StrategyProgress.jsx']) {
      const source = fs.readFileSync(path.resolve(here, file), 'utf8')
      expect(source).not.toMatch(/style=|animation/i)
    }
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
      render(
        <PlanStage
          vaultTotalShares={FUNDED_VAULT}
          base={disconnectedBase}
          onGenerate={onGenerate}
        />
      )
      await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
      await screen.findByRole('button', { name: 'Accept plan' })

      const summary = document.querySelector('.pc-technical-details-summary')
      const body = document.querySelector('.pc-technical-details-body')
      // jsdom does not resolve var(), but it DOES correctly resolve which declaration wins the
      // cascade (verified against these exact two files) -- so the raw winning text tells us
      // whether the mono face (--font-mono) or the body face (--font-body) is actually applied.
      // Wave 6 carry (owner decision #19): Foundation's own pocket-crew.css default for
      // .pc-technical-details-summary/-body is now the body face directly -- the scoped
      // strategy.css override this test used to pin (`--pc-font-body`) was retired as redundant
      // once the root default itself stopped being mono. If the mono face returns on either
      // Foundation's rule or a future regression, this still fails.
      expect(getComputedStyle(summary).fontFamily).toBe('var(--font-body)')
      expect(getComputedStyle(body).fontFamily).toBe('var(--font-body)')
    })
  })
})

describe("PlanStage — I8: Cap renders the plan agent's cap, never the display allocation", () => {
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
      render(
        <PlanStage
          vaultTotalShares={FUNDED_VAULT}
          base={disconnectedBase}
          onGenerate={onGenerate}
        />
      )
      await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
      await screen.findByRole('button', { name: 'Accept plan' })
      // allocation is 100 USDC; the spy doubled the plan-level cap to 200. Owner report item 3:
      // every displayed Cap is formatted to 2dp now, so this is '200.00', not '200'.
      expect(screen.getByText('Cap 200.00 USDC')).toBeTruthy()
      expect(screen.queryByText('Cap 100.00 USDC')).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})

// Strategy Task 14 fix loop N -- owner report (strategy-plan-visual-brief.md), Plan review surface.
describe('PlanStage — owner report: P0 correctness (items 1, 2, 3, 4)', () => {
  async function generateThreeWaySplit() {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000', // 100 USDC, risk 'Adventurous' -> exactly 3 deposit agents
      baseAllocations: [],
    })
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
    await fillAndSubmit({ amount: '100', risk: 'Adventurous', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
  }

  it('item 3: a 100/3 split displays 33.33/33.33/33.34 caps that sum exactly to the 100.00 total', async () => {
    await generateThreeWaySplit()
    const caps = screen.getAllByText(/^Cap /).map((el) => el.textContent)
    expect(caps).toHaveLength(3)
    // The exact multiset the owner's own acceptance check names -- the raw BigInt remainder from
    // splitEven physically sits on the FIRST agent (planModel.js's own doc comment), but the
    // human-readable display remainder is redistributed onto the LAST one (buildCapDisplayMap).
    expect(caps.sort()).toEqual(['Cap 33.33 USDC', 'Cap 33.33 USDC', 'Cap 33.34 USDC'])
    const centsSum = caps.reduce((s, t) => s + Math.round(Number(t.match(/[\d.]+/)[0]) * 100), 0)
    expect(centsSum).toBe(10000) // 100.00 USDC, exactly -- no float drift in the sum either
    // No worker's Cap ever shows raw float digits past 2dp (the original defect: 33.3333334).
    for (const t of caps) expect(t).toMatch(/^Cap \d+\.\d{2} USDC$/)
  })

  it('I-2 (reviewer finding): the per-worker allocation figure is also 2dp and sums exactly to the total, not a separate 3dp rounding stacked on top of Cap', async () => {
    await generateThreeWaySplit()
    const figures = document.querySelectorAll('.pc-allocation-row .pc-money')
    expect(figures.length).toBe(3)
    const values = Array.from(figures).map((el) => el.textContent.replace(/\s+/g, ' ').trim())
    // Sorted so this doesn't depend on which worker got the redistributed cent.
    expect(values.sort()).toEqual(['33.33 USDC', '33.33 USDC', '33.34 USDC'])
    const cents = values.reduce((s, v) => s + Math.round(Number(v.match(/[\d.]+/)[0]) * 100), 0)
    expect(cents).toBe(10000) // matches the Cap sum and the 100 USDC header total exactly
  })

  it('items 6/8: network, expiry, and yield stay hoisted to one shared line even with three workers', async () => {
    await generateThreeWaySplit()
    // Fix loop 1 -- Important 2: same restored zero-in-worker-list + one-in-summary pair as the
    // sibling test above, so this variant keeps guarding a badge reintroduced per row too.
    expect(
      within(document.querySelector('.pc-allocation-list')).queryAllByText('Stellar testnet')
    ).toHaveLength(0)
    expect(
      within(document.querySelector('.pc-plan-facts')).getAllByText('Stellar testnet')
    ).toHaveLength(1)
    expect(screen.getAllByText(/^Expires /)).toHaveLength(1)
    expect(screen.getAllByText(/Yield unavailable/)).toHaveLength(1)
  })

  it('item 7: every worker instructions disclosure loads collapsed, uniformly -- no default expand-state mismatch', async () => {
    await generateThreeWaySplit()
    const details = document.querySelectorAll('.pc-technical-details')
    expect(details.length).toBe(3)
    for (const el of details) expect(el.hasAttribute('open')).toBe(false)
  })

  it('item 5: replaces numbered marks with three distinct crew SVG avatars', async () => {
    await generateThreeWaySplit()
    expect(screen.queryByText(/^Worker \d/)).toBeNull()
    for (const name of ['Sprout', 'Clover', 'Mochi']) expect(screen.getByText(name)).toBeTruthy()
    const marks = document.querySelectorAll('[data-agent-kind="deposit"] img.pc-plan-agent-avatar')
    expect(marks.length).toBe(3)
    expect(new Set(Array.from(marks, (mark) => mark.getAttribute('src'))).size).toBe(3)
    for (const mark of marks) {
      expect(mark.getAttribute('src')).toMatch(/\/brand\/agents\/(sprout|clover|mochi)\.svg$/)
      expect(Number(mark.getAttribute('width'))).toBeGreaterThanOrEqual(40)
      expect(Number(mark.getAttribute('height'))).toBeGreaterThanOrEqual(40)
    }
  })

  it('rotates the shared three-persona catalog across six planned allocations', async () => {
    const originalNormalize = planModel.normalizeStrategyPlan
    const spy = vi.spyOn(planModel, 'normalizeStrategyPlan').mockImplementation((input) => {
      const real = originalNormalize(input)
      const units = ['166666667', '166666667', '166666667', '166666667', '166666666', '166666666']
      return {
        ...real,
        agents: units.map((allocationUnits, index) => ({
          ...real.agents[0],
          allocationId: `${real.runId}:deposit:${index}`,
          allocation: { ...real.agents[0].allocation, units: allocationUnits },
          cap: { ...real.agents[0].cap, units: allocationUnits },
        })),
      }
    })
    try {
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
        />
      )
      await fillAndSubmit({ amount: '100', risk: 'Steady' })
      await screen.findByRole('button', { name: 'Accept plan' })

      expect(
        Array.from(document.querySelectorAll('.pc-worker-name'), (row) => row.textContent)
      ).toEqual(['Sprout', 'Clover', 'Mochi', 'Sprout', 'Clover', 'Mochi'])
      expect(
        Array.from(document.querySelectorAll('.pc-plan-agent-avatar'), (image) =>
          image.getAttribute('src')
        )
      ).toEqual([
        '/brand/agents/sprout.svg',
        '/brand/agents/clover.svg',
        '/brand/agents/mochi.svg',
        '/brand/agents/sprout.svg',
        '/brand/agents/clover.svg',
        '/brand/agents/mochi.svg',
      ])
      expect(document.body.textContent).not.toMatch(/Pepper|Juniper|Basil/)
    } finally {
      spy.mockRestore()
    }
  })

  it('item 4: expiry renders as relative time with the absolute local time alongside it, never a raw ISO instant', async () => {
    await generateThreeWaySplit()
    const expires = screen.getByText(/^Expires /)
    expect(expires.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) // no raw ISO instant
    expect(expires.textContent).toMatch(/in (\d+h( \d+m)?|\d+ hours?|\d+ minutes?)/)
    expect(expires.textContent).toMatch(/\(.+\)/) // absolute local time shown alongside it
  })

  it('item 1: the plan total header (badge, retry button, money) is a real flex row, not bare concatenated siblings', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'fallback',
      sourceState: 'deterministic',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={onGenerate} />
    )
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    const header = document.querySelector('.pc-plan-summary-header')
    expect(header).toBeTruthy()
    expect(header.querySelector('.pc-source-badge')).toBeTruthy()
    expect(header.querySelector('.pc-money')).toBeTruthy()
    // Real geometry (the gap actually renders, not just that the class is present) is verified in
    // a real Chromium layout engine below -- jsdom draws no layout at all.
  })

  it('item 9: Accept plan carries the full-width primary-action class', async () => {
    await generateThreeWaySplit()
    const accept = screen.getByRole('button', { name: 'Accept plan' })
    expect(accept.className).toMatch(/\bpc-accept-plan-button\b/)
  })
})

describe('PlanStage — owner report: real-browser geometry and contrast (items 1, 2, 5, 9)', () => {
  // [r, g, b] channels (0-255) -> WCAG relative luminance -> contrast ratio. A small local
  // duplicate of src/design/contrast.js's own formula (that file only accepts hex; these come from
  // an in-page alpha-compositing walk, see the test below) rather than adding a hex round-trip
  // layer for one test.
  function contrastFromRgb([r1, g1, b1], [r2, g2, b2]) {
    const lin = (c) => {
      const v = c / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const l1 = lum(r1, g1, b1)
    const l2 = lum(r2, g2, b2)
    const lighter = Math.max(l1, l2)
    const darker = Math.min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)
  }

  it(
    'items 1/2/5/9: real layout measurement of label/value spacing, textarea contrast, avatar ' +
      'alignment, and Accept-plan width',
    async () => {
      const onGenerate = vi.fn().mockResolvedValue({
        source: 'deepseek',
        sourceState: 'live-ai',
        stellarUnits: '1000000000',
        baseAllocations: [],
      })
      const { container } = render(
        <PlanStage
          vaultTotalShares={FUNDED_VAULT}
          base={disconnectedBase}
          onGenerate={onGenerate}
        />
      )
      await fillAndSubmit({ amount: '100', risk: 'Adventurous', onGenerate })
      await screen.findByRole('button', { name: 'Accept plan' })

      const browser = await launchRealChromium()
      try {
        const page = await browser.newPage()
        await page.setViewportSize({ width: 1280, height: 1600 })
        await page.setContent(buildLayoutHarnessHtml(container.innerHTML))
        const result = await page.evaluate(() => {
          document.querySelectorAll('.pc-technical-details-summary').forEach((s) => s.click())

          const header = document.querySelector('.pc-plan-summary-header')
          const badge = header.querySelector('.pc-source-badge')
          const money = header.querySelector('.pc-money')
          const badgeRect = badge.getBoundingClientRect()
          const moneyRect = money.getBoundingClientRect()
          // Same visual line (flex row, no wrap at this width) -- assert a real, positive gap
          // between the two boxes, not just that they don't overlap.
          const headerGap =
            Math.abs(badgeRect.top - moneyRect.top) < 4 ? moneyRect.left - badgeRect.right : null

          const textarea = document.querySelector('.pc-instruction-input')
          const taStyle = getComputedStyle(textarea)
          // `.pc-instruction-input`'s own background is a deliberately translucent 5% tint (the
          // same recipe `.pc-strategy-amount` already uses) meant to composite over the Harvest
          // ancestor's OPAQUE fill -- getComputedStyle only ever returns the element's own
          // (5%-alpha) declared color, never the visually-composited result, so reading it naively
          // would report a false near-black background. Walk the real ancestor chain and alpha-
          // composite each layer "over" the previous one, root to leaf, the same way the browser
          // actually paints it -- verified against a live Chromium instance of this exact fixture
          // (rgb(23, 37, 31) ink over an effective ~rgb(213, 235, 104) fill, 12:1).
          const parseColor = (str) => {
            if (!str || str === 'transparent') return [0, 0, 0, 0]
            const m = str.match(/rgba?\(([^)]+)\)/)
            if (m) {
              const parts = m[1].split(',').map((s) => Number.parseFloat(s))
              return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
            }
            const m2 = str.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?:\s*\/\s*([\d.]+))?\)/)
            if (m2) {
              return [
                Number.parseFloat(m2[1]) * 255,
                Number.parseFloat(m2[2]) * 255,
                Number.parseFloat(m2[3]) * 255,
                m2[4] ? Number.parseFloat(m2[4]) : 1,
              ]
            }
            return [0, 0, 0, 1]
          }
          const compositeOver = (top, base) => {
            const [tr, tg, tb, ta2] = top
            const [br, bg2, bb] = base
            return [
              tr * ta2 + br * (1 - ta2),
              tg * ta2 + bg2 * (1 - ta2),
              tb * ta2 + bb * (1 - ta2),
              1,
            ]
          }
          const chain = []
          let ancestor = textarea
          while (ancestor) {
            chain.unshift(ancestor)
            ancestor = ancestor.parentElement
          }
          let effectiveBg = [255, 255, 255, 1]
          for (const node of chain) {
            const c = parseColor(getComputedStyle(node).backgroundColor)
            if (c[3] > 0) effectiveBg = compositeOver(c, effectiveBg)
          }

          const row = document.querySelector('.pc-allocation-row')
          const mark = row.querySelector('.pc-plan-agent-avatar')
          const name = row.querySelector('.pc-worker-name')
          const markRect = mark.getBoundingClientRect()
          const nameRect = name.getBoundingClientRect()
          const rowRect = row.getBoundingClientRect()
          const markCenter = markRect.top + markRect.height / 2
          const nameCenter = nameRect.top + nameRect.height / 2
          const rowCenter = rowRect.top + rowRect.height / 2

          const acceptButton = Array.from(document.querySelectorAll('button')).find(
            (b) => b.textContent.trim() === 'Accept plan'
          )
          const changeMindButton = Array.from(document.querySelectorAll('summary')).find(
            (summary) => summary.textContent.trim() === 'Change mind?'
          )
          const finalActions = document.querySelector('.pc-plan-final-actions')
          const decision = document.querySelector('.pc-dominant--decision')
          const decisionStyle = getComputedStyle(decision)
          const decisionContentWidth =
            decision.getBoundingClientRect().width -
            Number.parseFloat(decisionStyle.paddingLeft) -
            Number.parseFloat(decisionStyle.paddingRight)

          return {
            headerGap,
            textareaEffectiveBackground: effectiveBg,
            textareaColor: parseColor(taStyle.color),
            markSize: markRect.width,
            distanceToName: Math.abs(markCenter - nameCenter),
            distanceToRowCenter: Math.abs(markCenter - rowCenter),
            acceptButtonWidth: acceptButton.getBoundingClientRect().width,
            changeMindButtonWidth: changeMindButton.getBoundingClientRect().width,
            finalActionsWidth: finalActions.getBoundingClientRect().width,
            decisionContentWidth,
          }
        })

        // Item 1: a real, positive gap between the badge and the money figure (was 0 -- bare
        // concatenated inline siblings).
        expect(result.headerGap).not.toBeNull()
        expect(result.headerGap).toBeGreaterThan(2)

        // Item 2: the instructions textarea is readable -- was rgb(23, 37, 31) ink on a UA dark
        // rgb(59, 59, 59) fill (contrast far under 1.5:1, measured before this fix); WCAG AA for
        // body text is 4.5:1.
        const textareaContrast = contrastFromRgb(
          result.textareaColor,
          result.textareaEffectiveBackground
        )
        expect(textareaContrast).toBeGreaterThanOrEqual(4.5)

        // Item 5: at least 36px, and closer to the header (crew-name) line it belongs to than to
        // the vertical center of the whole, much taller, multi-line row (was the reverse -- the
        // avatar centered on the whole row via the row's own locked `align-items: center`).
        expect(result.markSize).toBeGreaterThanOrEqual(36)
        expect(result.distanceToName).toBeLessThan(result.distanceToRowCenter)

        expect(result.finalActionsWidth).toBeGreaterThanOrEqual(result.decisionContentWidth * 0.9)
        expect(result.acceptButtonWidth / result.changeMindButtonWidth).toBeCloseTo(3, 1)
      } finally {
        await browser.close()
      }
    },
    20000
  )
})

// Task 3 (Pocket Crew design alignment) -- amount preset chips + the read-only, DERIVED crew-count
// line under the risk group (D-28.6: crew count is never user-set -- no input/select for it
// anywhere, see the "never renders an advanced crew-count input" guard above, which this task must
// keep passing). No named render helper exists in this file (every test above calls `render`
// inline with the same vaultTotalShares/base/onGenerate trio) -- mirrored here rather than inventing
// a wrapper. `getByLabelText('Amount in USDC')` (exact string, matching this file's own convention
// everywhere else) rather than a `/amount/i` regex: the new preset group's `aria-label="Quick
// amounts"` contains the substring "amount", and testing-library's getByLabelText matches aria-label
// on ANY element, not just form controls -- a regex query would ambiguously match both.
describe('PlanStage — amount presets and crew line', () => {
  it('clicking a preset fills the amount input', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: '250' }))
    expect(screen.getByLabelText('Amount in USDC').value).toBe('250')
  })

  it('shows the derived crew count after a risk tier is chosen', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Balanced' }))
    expect(screen.getByText(/2 crew members/i)).toBeTruthy()
  })

  // fix loop 1 -- Important 4 (review finding): the two tests above only exercise the trivial
  // halves (a preset click; the crew count with an EMPTY amount, so `formatShare` never runs).
  // `formatShare` -- a money-display function on the route's primary card -- had zero coverage.
  // 20.0099999 / 2 is chosen because it's DISCRIMINATING: splitEven (planModel.js) puts its
  // remainder on the EARLIEST slot, so the real first deposit agent gets 100050000 base units
  // (10.0100000... USDC, displays "10.01"); a naive uniform `total/k` floor -- the bug this fix
  // loop replaced -- gives every slot the same 100049999 units and displays "10.00" instead. A
  // test built on an evenly-divisible amount (e.g. 100/3 elsewhere in this file) cannot tell the
  // two implementations apart; this one can, and was verified against both code paths by hand
  // before being pinned here (see the fix report).
  it('pins the exact per-agent share for a non-evenly-divisible amount, matching the real splitEven remainder rule', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Amount in USDC'), {
      target: { value: '20.0099999' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Balanced' }))
    expect(screen.getByText('2 crew members · each handles about 10.01 USDC')).toBeTruthy()
  })

  it('shows the singular "1 crew member" and its share for Steady (the pluralization ternary\'s other branch)', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Steady' }))
    expect(screen.getByText('1 crew member · each handles about 5.00 USDC')).toBeTruthy()
    expect(screen.queryByText(/1 crew members/)).toBeNull()
  })

  // fix loop 1 -- Important 2 (review finding): the amount field is free text with no
  // sanitization -- "1e999" parses to `Infinity` (Number("1e999") exceeds the double max), which
  // used to pass the old `amountNumber > 0` guard and reach `BigInt(Math.round(Infinity))`, an
  // unrecoverable RangeError with no error boundary anywhere in this app (verified: none exists in
  // frontend/src). This proves the crash is fixed, not just guarded in a way that silently hides a
  // wrong number -- the card must render, and it must not crash.
  it('never crashes on an unparseable/overflowing amount, and shows no bogus share figure', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '1e999' } })
    expect(() => fireEvent.click(screen.getByRole('radio', { name: 'Balanced' }))).not.toThrow()
    expect(screen.getByText(/2 crew members/i)).toBeTruthy()
    expect(screen.queryByText(/each handles about/)).toBeNull()
  })

  // Task 4 fix loop 2 (carried review item): `formatShare` had the SAME class of overflow-on-
  // multiply defect `formatDollarNumber` was fixed for above, at a LOWER threshold (its own
  // multiplier is `10 ** SOROBAN_DECIMALS` = 1e7, not formatDollarNumber's 100). `1e999` above
  // cannot discriminate this: it parses to `Infinity`, which is caught by PlanStage's own
  // `amountNumber` INPUT guard before formatShare is ever called (amountNumber collapses to 0, so
  // `amountNumber > 0` is false and the "each handles about" clause never even renders). `1e307`
  // is itself finite -- it survives that guard, so `amountNumber > 0` is true and formatShare IS
  // called -- and only overflows once multiplied by 1e7 inside formatShare's own multiply.
  it('never crashes when a finite typed amount overflows formatShare on the multiply', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '1e307' } })
    expect(() => fireEvent.click(screen.getByRole('radio', { name: 'Balanced' }))).not.toThrow()
    // The clause still renders (amountNumber IS > 0, unlike the 1e999 case above) but formatShare
    // degrades to its own existing empty-string fallback rather than a crash or a bogus number.
    const crewLine = screen.getByText(/2 crew members/i)
    expect(crewLine.textContent).toBe('2 crew members · each handles about ')
    expect(crewLine.textContent).not.toMatch(/Infinity|NaN/)
  })
})

// Task 4 (Pocket Crew design alignment) -- the aside's FIRST block: a live "plan so far" summary
// (deployed amount, crew size, zero fees, plus a "Sent to Base" row and a 30-day estimate row
// only when the caller's own plan/venue actually support them) that renders even before any plan
// has been generated. The existing Stellar truth card and Base bridge disclosure (rendered below
// it in the DOM) are untouched -- already covered by the describe blocks above; this block only
// covers the new summary.
//
// `STELLAR_VENUE_FIXTURE` carries the only shape that is allowed to drive a yield estimate: a
// nested, fresh live-venue yield. Flat catalog/DeFiLlama APY remains reference data and is covered
// by the unavailable-yield tests above.
const STELLAR_VENUE_FIXTURE = Object.freeze({
  name: 'Vibing Farmer Autofarm',
  yield: { state: 'live', apy: 4.8, asOf: Date.now() },
})

// No named render helper exists elsewhere in this file for a `stellarVenue`-bearing render (every
// other describe block above either doesn't need one or inlines `render` directly) -- this one
// does, several times, so it is factored out here rather than repeated per test.
function renderPlanStage(props = {}) {
  return render(
    <PlanStage
      vaultTotalShares={FUNDED_VAULT}
      base={disconnectedBase}
      stellarVenue={STELLAR_VENUE_FIXTURE}
      onGenerate={vi.fn()}
      {...props}
    />
  )
}

describe('the plan so far aside', () => {
  // Deviation from the task brief's literal `screen.getByLabelText(/amount/i)`: Task 3 already
  // gave the "Quick amounts" preset group (rendered in the SAME form) `aria-label="Quick
  // amounts"` -- testing-library's getByLabelText matches any element's `aria-label` attribute,
  // not just form controls (verified directly: @testing-library/dom's label-text query runs
  // `queryAllByAttribute('aria-label', ...)` with no role restriction), so `/amount/i` matches
  // BOTH the amount input's label and that group's aria-label and throws "Found multiple
  // elements" before the aside is ever queried -- this is exactly why every other test in this
  // file already uses the exact string `'Amount in USDC'` (see the "amount presets and crew
  // line" describe block's own header comment above, which documents the identical tradeoff).
  it('lists deployed amount, crew count and zero fees once inputs are set', () => {
    renderPlanStage()
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('radio', { name: /balanced/i }))
    const aside = screen.getByRole('complementary', { name: /the plan so far/i })
    expect(aside.textContent).toMatch(/blend/i)
    expect(aside.textContent).toMatch(/network fees/i)
    expect(aside.textContent).toMatch(/zero/i)
  })

  it('places the Vault Advisor directly below the plan summary and opens customization', () => {
    const onCustomizeSkill = vi.fn()
    const { container } = renderPlanStage({
      skillSource: 'user-file',
      marketLive: {},
      vaultLive: false,
      onCustomizeSkill,
    })
    const summary = container.querySelector('.pc-plan-so-far')
    const advisor = container.querySelector('.pc-vault-advisor')
    expect(summary.nextElementSibling).toBe(advisor)
    expect(advisor.textContent).toMatch(/custom strategy.*live market.*cached vaults/i)
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    expect(onCustomizeSkill).toHaveBeenCalledOnce()
  })

  // Pins REAL values (Task 3's review lesson: a test that would also pass against an empty aside
  // does not cover this task) -- proves deployedText/estimate30d are the caller's own typed
  // amount and evidenced venue APY, not a hardcoded string that happens to satisfy the regex test.
  // 250 USDC * 4.8% APY * 30/365 days = 0.9863... -> "0.99" (formatDollarNumber's own rounding).
  it('shows the typed amount, the derived crew count, and the yield estimate before any plan exists', () => {
    renderPlanStage()
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('radio', { name: /balanced/i }))
    const aside = screen.getByRole('complementary', { name: /the plan so far/i })
    expect(within(aside).getByText('250.00 USDC')).toBeTruthy()
    expect(within(aside).getByText('Crew members').closest('li').textContent).toMatch(/2/)
    expect(within(aside).getByText('+0.99 USDC')).toBeTruthy()
  })

  it('shows no crew-members row before a comfort level is chosen -- never a guessed default', () => {
    renderPlanStage()
    const aside = screen.getByRole('complementary', { name: /the plan so far/i })
    expect(within(aside).queryByText('Crew members')).toBeNull()
  })

  // Constraint: never invent a number. No `stellarVenue` prop at all (before the venue catalog has
  // loaded) means no nested live yield, so the row must be omitted entirely rather than
  // substituting a default/placeholder rate.
  it('omits the estimated-yield row when the venue exposes no numeric APY', () => {
    render(
      <PlanStage vaultTotalShares={FUNDED_VAULT} base={disconnectedBase} onGenerate={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '250' } })
    const aside = screen.getByRole('complementary', { name: /the plan so far/i })
    expect(within(aside).queryByText(/Estimated in 30 days/)).toBeNull()
  })

  it('reflects the real reviewed totals and a Sent to Base row once a bridged plan is generated', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '600000000', // 60 USDC Stellar
      baseAllocations: [
        { address: '0xAAA', proxyTarget: 'aave-v3', units: '25000000', chain: 'base' },
        { address: '0xBBB', proxyTarget: 'morpho-blue', units: '15000000', chain: 'base' },
      ], // + 40 USDC bridge cap = 100 USDC total, reconciling with the typed amount below
    })
    const readyBase = {
      connected: true,
      healthy: true,
      mandateView: { status: 'ready', ready: true, primaryCopy: 'Ready copy.' },
      action: null,
    }
    renderPlanStage({ base: readyBase, onGenerate })
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Steady' }))
    fireEvent.click(screen.getByRole('button', { name: 'Build my plan' }))
    await screen.findByRole('button', { name: 'Accept plan' })
    const aside = screen.getByRole('complementary', { name: /the plan so far/i })
    // Deployed to Blend v2 now reflects the REVIEWED plan total (60), not the typed amount (100).
    expect(within(aside).getByText('60.00 USDC')).toBeTruthy()
    expect(within(aside).getByText('Sent to Base')).toBeTruthy()
    expect(within(aside).getByText('40.00 USDC')).toBeTruthy()
    // Fix loop 1 -- Important 3 (review finding): the 30-day estimate must apply the evidenced 4.8% APY
    // only to the 60 USDC that actually went to Blend (60 * 0.048 * 30/365 = 0.2367... -> "0.24"),
    // never to the full 100 USDC typed amount (which would have given the wrong "0.39" -- the
    // exact bug this fix closes, asserted absent below too).
    expect(within(aside).getByText('+0.24 USDC')).toBeTruthy()
    expect(within(aside).queryByText('+0.39 USDC')).toBeNull()
  })

  // Fix loop 1 -- Important 1 (review finding): `amountNumber` (1e307) is itself finite -- the
  // upstream Number.isFinite guard never collapses it to 0 -- but `formatDollarNumber`'s own
  // `value * 100` overflows to Infinity (Number.MAX_VALUE / 100 ~= 1.8e306), and `BigInt(Infinity)`
  // used to throw with no error boundary anywhere in the app, blanking the whole Plan stage. The
  // pre-existing `1e999` regression test can't catch this: `1e999` parses to `Infinity` and is
  // already collapsed to 0 by the amountNumber guard before it ever reaches a formatter.
  it('does not crash when a finite typed amount overflows on the cents multiply', () => {
    renderPlanStage()
    expect(() =>
      fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '1e307' } })
    ).not.toThrow()
    const aside = screen.getByRole('complementary', { name: /the plan so far/i })
    // Collapses to the same 0 sentinel the amount field's own Number.isFinite guard already uses
    // for unusable input -- not a crash, and not a fabricated non-zero number either.
    expect(within(aside).getByText('0.00 USDC')).toBeTruthy()
  })

  // Bundled minor (review finding): the existing no-APY test omits `stellarVenue` entirely, which
  // only exercises the `?.` optional-chain -- this pins the `typeof ... === 'number'` check
  // itself against a venue that HAS an `apy` field, just not a numeric one (e.g. a not-yet-parsed
  // string from an upstream source).
  it('omits the estimated-yield row when apy is present but not a number', () => {
    renderPlanStage({ stellarVenue: { name: 'Vibing Farmer Autofarm', apy: '4.8' } })
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '250' } })
    const aside = screen.getByRole('complementary', { name: /the plan so far/i })
    expect(within(aside).queryByText(/Estimated in 30 days/)).toBeNull()
  })

  // A11y: `<aside>` only maps to the `complementary` role when it is not nested inside another
  // sectioning element -- proven above by the successful `getByRole('complementary', ...)`
  // queries, not assumed. This adds the explicit contract check plus a real axe pass over the
  // reviewed-plan phase, which now renders the aside's new content alongside the existing Stellar
  // truth card.
  it('has zero axe violations with the new summary rendered alongside a reviewed plan', async () => {
    const onGenerate = vi.fn().mockResolvedValue({
      source: 'deepseek',
      sourceState: 'live-ai',
      stellarUnits: '1000000000',
      baseAllocations: [],
    })
    const { container } = renderPlanStage({ onGenerate })
    await fillAndSubmit({ amount: '100', risk: 'Steady', onGenerate })
    await screen.findByRole('button', { name: 'Accept plan' })
    expect(screen.getByRole('complementary', { name: /the plan so far/i })).toBeTruthy()
    expect(await axe(container)).toHaveNoViolations()
  })
})
