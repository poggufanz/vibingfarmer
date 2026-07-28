// frontend/src/components/strategy/StrategyRoute.test.jsx
// Fix loop 1 (Strategy Task 13 review, checklist gap on items 1 and 12). The reviewer measured
// items 1 and 12 for each isolated stage component in Tasks 10-12, but recorded the INTEGRATED
// `/strategy` route (this file's `<StrategyRoute>`, now the single wrapper app.jsx renders too --
// see fix loop 1's I1 resolution) as an honest gap: new markup that was never measured in a
// browser. This file closes that gap for all four public states (Plan, Protect, Start, receipt),
// through the real wrapper, not the bare stage component.
//
// Item 1 (reject if the main composition is 3+ equal rounded cards): each stage's own file already
// commits to exactly one `.pc-dominant` decision surface + `.pc-support` asides (PlanStage.jsx,
// ProtectStage.jsx, StartStage.jsx, StrategyReceipt.jsx headers) -- verified here at the ROUTE
// level, through the real `.pc-route`/`.pc-route-stack` wrapper, per state.
//
// Item 12 (reject if desktop content exceeds 1240px or 320px creates horizontal scroll): reuses
// the same real-Chromium playwright-core technique as PlanStage.test.jsx's G1 / ProtectStage.test.jsx's
// G / StartStage.test.jsx's G guards -- jsdom never runs layout, so `scrollWidth` and bounding-rect
// widths are inert there.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { StrategyRoute } from './StrategyRoute.jsx'
import { SOROBAN_TOKEN_ADDRESS } from '../../stellar/config.js'
import { STELLAR_USDC_SAC } from '../../stellar/cctpBurn.js'

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))
const REAL_STYLESHEET = [
  fs.readFileSync(path.resolve(here, '../../design/pocket-crew.css'), 'utf8'),
  fs.readFileSync(path.resolve(here, './strategy.css'), 'utf8'),
].join('\n')
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
  throw new Error(`Route layout guard: no usable Chromium binary found (${lastErr?.message})`)
}

// Measures both item-12 numbers for one rendered `<StrategyRoute>` tree in one real-Chromium
// session: 320px `documentElement.scrollWidth` (must equal 320 -- no horizontal overflow) and the
// route's CONTENT width at 1440px (must not exceed 1240px). `.pc-route` itself
// (strategy.css: `width: min(100%, var(--pc-shell-max) + 2*var(--pc-route-gutter))`,
// `padding: var(--pc-route-gutter)`) is DELIBERATELY wider than 1240px -- the gutter is outside
// the 1240px content cap by design (--pc-shell-max: 1240px, pocket-crew.css), so the checklist's
// "content" is `.pc-route-stack`'s own box (inside the padding), not `.pc-route`'s outer edge.
async function measureRouteAt(bodyHtml) {
  const browser = await launchRealChromium()
  try {
    const page = await browser.newPage()
    await page.setContent(buildLayoutHarnessHtml(bodyHtml))
    await page.setViewportSize({ width: 320, height: 900 })
    const scrollWidth320 = await page.evaluate(() => document.documentElement.scrollWidth)
    await page.setViewportSize({ width: 1440, height: 900 })
    const routeContentWidth1440 = await page.evaluate(() => {
      const el = document.querySelector('.pc-route-stack')
      return el.getBoundingClientRect().width
    })
    // Task 2 review, Important 2: `.pc-route` used to be a plain block box with no gap of its own,
    // so `.pc-route-header` (zero margin) sat flush against `.pc-route-stack` (zero margin) below
    // it -- jsdom never lays out, so this real-layout number is the only way to see it.
    const headerToStackGap1440 = await page.evaluate(() => {
      const header = document.querySelector('.pc-route-header')
      const stack = document.querySelector('.pc-route-stack')
      if (!header || !stack) return null
      return stack.getBoundingClientRect().top - header.getBoundingClientRect().bottom
    })
    return { scrollWidth320, routeContentWidth1440, headerToStackGap1440 }
  } finally {
    await browser.close()
  }
}

const disconnectedBase = { connected: false, healthy: null, mandateView: null, action: null }

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const TOKEN_ADDR = SOROBAN_TOKEN_ADDRESS
const BRIDGE_TOKEN_ADDR = STELLAR_USDC_SAC
const NOW = 1_800_000_000

function amount(token, units, decimals = 7) {
  return { token, units, decimals }
}

const PLAN = Object.freeze({
  runId: 'run-1',
  planFingerprint: '0xplan1',
  amount: amount('USDC', '2000000000'),
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
    {
      allocationId: 'run-1:deposit:1',
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
  truth: { agentIsolationCount: 2, stellarVenueCount: 1, baseUsesProxyVaults: false },
})

const PERMISSION_FRESH = Object.freeze({
  mode: 'fresh',
  txHash: '0xgrant1',
  grantReceiptFingerprint: '0xreceiptfp',
  expiryLedger: 9001,
  agentAddresses: ['CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'],
  confirmationCount: 1,
})

function succeededAllocation(allocationId) {
  return {
    allocationId,
    amount: amount(TOKEN_ADDR, '1000000000'),
    networkContext: {
      executionNetwork: 'stellar-testnet',
      currentCustodyNetwork: 'stellar-testnet',
      transit: false,
    },
    executionStatus: 'succeeded',
    custody: { location: 'stellar-vault', confirmed: true, checkedAt: NOW },
    txHash: 'a1b2c3d4'.repeat(8),
    error: null,
    evidence: { allocationId, depositTxHash: 'a1b2c3d4'.repeat(8) },
  }
}

const RECEIPT = {
  version: 1,
  runId: 'run-1',
  planFingerprint: '0xplan1',
  permission: {
    mode: 'fresh',
    status: 'confirmed',
    confirmationCount: 1,
    txHash: '0xgrant1',
    grantReceiptFingerprint: '0xreceiptfp',
    expiryLedger: 9001,
    agentAddresses: PERMISSION_FRESH.agentAddresses,
  },
  branches: {
    stellar: {
      status: 'complete',
      results: [succeededAllocation('run-1:deposit:0'), succeededAllocation('run-1:deposit:1')],
    },
    base: { status: 'not-planned', results: [] },
  },
  allocations: [succeededAllocation('run-1:deposit:0'), succeededAllocation('run-1:deposit:1')],
}

// One `<StrategyRoute>` tree per public state, built exactly the way app.jsx's own
// `renderStrategyRoute()` builds it (same prop names/shapes) -- see app.jsx's `protectProps`/
// `startProps` bags introduced by the I1 fix.
const STATES = {
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
      plan={PLAN}
      protectProps={{ owner: null, onConnectWallet: vi.fn(), onEditPlan: vi.fn() }}
    />
  ),
  Start: (
    <StrategyRoute
      stage="start"
      reached={['plan', 'protect', 'start']}
      plan={PLAN}
      startProps={{ permission: PERMISSION_FRESH, events: [], receipt: null, runId: 'run-1' }}
    />
  ),
  'Start + receipt': (
    <StrategyRoute
      stage="start"
      reached={['plan', 'protect', 'start']}
      plan={PLAN}
      startProps={{
        permission: PERMISSION_FRESH,
        events: [],
        receipt: RECEIPT,
        runId: 'run-1',
        onViewMoney: vi.fn(),
        onMakeAnotherDeposit: vi.fn(),
      }}
    />
  ),
}

describe('StrategyRoute — item 1 (rejection checklist): dominant decision, never 3+ equal cards', () => {
  for (const [label, el] of Object.entries(STATES)) {
    it(`${label}: main composition is a dominant decision surface, never 3+ equal cards`, () => {
      const { container } = render(el)
      // Start+receipt legitimately stacks two dominant sections sequentially (the live progress
      // view, then StrategyReceipt once settled -- StartStage.jsx's own Task 12 composition,
      // unchanged by this fix loop) -- still nowhere near the reject condition's "3+ equal cards".
      expect(container.querySelectorAll('.pc-dominant').length).toBeLessThan(3)
      expect(container.querySelector('.pc-dominant--decision, .pc-dominant--owned')).toBeTruthy()
    })
  }
})

describe('StrategyRoute — item 12 (rejection checklist): 320px no overflow, 1240px desktop cap', () => {
  for (const [label, el] of Object.entries(STATES)) {
    it(`${label}: 320px creates no horizontal scroll and route content stays within 1240px at 1440px`, async () => {
      const { container } = render(el)
      const { scrollWidth320, routeContentWidth1440 } = await measureRouteAt(container.innerHTML)
      expect(scrollWidth320).toBe(320)
      expect(routeContentWidth1440).toBeLessThanOrEqual(1240)
    }, 20000)
  }
})

// Task 2 review, Important 2: the header markup/CSS is identical across every stage (only its
// "Step N of 3" text differs), so one real-layout measurement -- not one per STATES entry like
// item 12 above -- already exercises the defect class; a per-stage repeat would cost four more
// Chromium sessions to re-check a CSS rule that doesn't vary by stage.
describe('StrategyRoute — route header sits apart from the stage tabs (real layout)', () => {
  it('leaves a real, non-zero gap between .pc-route-header and .pc-route-stack at 1440px', async () => {
    const { container } = render(STATES.Plan)
    const { headerToStackGap1440 } = await measureRouteAt(container.innerHTML)
    // Before the fix this measured 0 (flush, zero-margin siblings under a plain block `.pc-route`)
    // -- a loose ">0" rather than pinning the exact --pc-route-gap px value keeps this from being
    // a brittle re-assertion of the token's own clamp() math the CSS already declares.
    expect(headerToStackGap1440).toBeGreaterThan(0)
  }, 20000)
})

// Task 2 (Pocket Crew design alignment): the route-level header living above StrategyProgress --
// a single `<h1>` ("Hire a crew, once.") the route owns, plus a "Step N of 3" counter for the
// current stage. Demotes each stage's own heading to `<h2>` so this is the only h1 on the route
// (item 1's a11y invariant, exercised for all three stages by strategyA11y.test.jsx elsewhere).
const baseProps = {
  stage: 'plan',
  reached: ['plan'],
  onNavigateStage: () => {},
  plan: null,
  protectProps: {},
  startProps: {},
  onGenerate: vi.fn(),
  onAcceptPlan: () => {},
}

describe('StrategyRoute header', () => {
  it('renders the route h1 and the step counter for the current stage', () => {
    render(<StrategyRoute {...baseProps} />)
    expect(screen.getByRole('heading', { level: 1, name: /hire a crew, once/i })).toBeTruthy()
    expect(screen.getByText('Step 1 of 3')).toBeTruthy()
  })

  it('numbers the stage tabs', () => {
    render(<StrategyRoute {...baseProps} />)
    expect(screen.getByRole('button', { name: /1 · Plan/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /2 · Protect/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /3 · Start/ })).toBeTruthy()
  })

  it('keeps exactly one h1 on the route', () => {
    render(<StrategyRoute {...baseProps} />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })
})
