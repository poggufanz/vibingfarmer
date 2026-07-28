// frontend/src/components/strategy/ProtectStage.test.jsx
// Strategy Task 11 (Pocket Crew redesign, Wave 5). Protect is the stage where the user authorizes
// a REAL wallet request -- no fake modal, no timeout, no simulated "Sign authorization" ceremony
// (see the header comment on ProtectStage.jsx for the full design rationale). This file proves:
// disconnected wallet choice, the non-claiming `checking` phase, fresh vs. reuse review content
// (friendly + technical copy from the SAME budget/scope data -- Step 2), the real wallet request
// starting while the UI stays in Protect, fail-closed advancement (only a confirmed result ever
// shows as confirmed), `Nothing moved` on any rejection/failure with Retry/Edit, the
// PermissionPhaseError rebuild-without-a-surprise-wallet-request rule, "unknown expiry cannot show
// reuse", and the usual keyboard/320px/reduced-motion/axe coverage.
// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import * as axeMatchers from 'vitest-axe/matchers'
import { ProtectStage } from './ProtectStage.jsx'
import { PermissionPhaseError } from '../../strategy/permissionError.js'
// Fix loop 1 -- C1 (review finding): every fixture below used to substitute a human label
// ('USDC', 'Circle USDC (Base)') into `reviewedBudgets[].token` / `cap.token` / `headroom.token`
// -- a shape reusePreflight.js/grant.js can never actually produce (grant.js's `addrScVal` throws
// on anything that isn't a real Stellar Address). Importing the REAL production constants here
// means these fixtures are byte-identical to what the real producers emit, so the suite can see
// this class of defect instead of being structurally blind to it.
import { SOROBAN_TOKEN_ADDRESS } from '../../stellar/config.js'
import { STELLAR_USDC_SAC } from '../../stellar/cctpBurn.js'

expect.extend(axeMatchers)

afterEach(cleanup)

const here = path.dirname(fileURLToPath(import.meta.url))

// Real-CSS regression helper -- same technique PlanStage.test.jsx uses (jsdom resolves the
// cascade correctly even though it can't resolve var()), reused here for the same reason: proving
// a scoped override / the absence of an animation rule against the REAL shipped stylesheet.
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

// Real-layout 320px guard -- same mechanism as PlanStage.test.jsx's G1 guard (jsdom never runs
// layout at all: no scrollWidth, no grid-track sizing, no min-content). Launches a real Chromium
// binary against the REAL shipped style.css + pocket-crew.css + strategy.css.
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
  throw new Error(`320px layout guard: no usable Chromium binary found (${lastErr?.message})`)
}

async function measureScrollWidthAt320(bodyHtml) {
  const browser = await launchRealChromium()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 320, height: 1400 })
    await page.setContent(buildLayoutHarnessHtml(bodyHtml))
    return await page.evaluate(() => document.documentElement.scrollWidth)
  } finally {
    await browser.close()
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

const NOW = 1_800_000_000
// The real vault deposit token (stellar/config.js's SOROBAN_TOKEN_ADDRESS) -- kept as its own
// named constant (rather than importing-and-using directly at every call site) so a fixture
// reading `token: TOKEN_ADDR` still reads as "a token", matching the shape reusePreflight.js's
// own AgentInit/PermissionDecisionV1 fields carry.
const TOKEN_ADDR = SOROBAN_TOKEN_ADDRESS
// The real CCTP bridge burn-source token (stellar/cctpBurn.js's STELLAR_USDC_SAC) -- a SECOND,
// genuinely different Stellar contract from TOKEN_ADDR, used below for the mixed-token fixtures
// (C1/I3): both are "USDC" to a human, but distinct on-chain assets, exactly the case the brief's
// mixed-token rule exists to keep distinguishable.
const BRIDGE_TOKEN_ADDR = STELLAR_USDC_SAC
const VAULT_ADDR = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const SECRET_REF = 'SECRET-CREDENTIAL-REF-MUST-NEVER-RENDER'

const PLAN_DEPOSIT_ONLY = Object.freeze({
  runId: 'run-1',
  planFingerprint: '0xplan1',
  amount: { token: 'USDC', units: '1000000000', decimals: 7 }, // 100 USDC
  agents: [
    {
      allocationId: 'run-1:deposit:0',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: { token: 'USDC', units: '1000000000', decimals: 7 },
      cap: { token: 'USDC', units: '1000000000', decimals: 7 },
      periodSeconds: 3600,
      expiry: NOW + 3600,
      destination: 'Stellar deposit',
      children: [],
      instructions: 'Deposit into the Autofarm vault and hold.',
    },
  ],
  truth: { agentIsolationCount: 1, stellarVenueCount: 1, baseUsesProxyVaults: false },
})

const PLAN_WITH_BRIDGE = Object.freeze({
  ...PLAN_DEPOSIT_ONLY,
  amount: { token: 'USDC', units: '2000000000', decimals: 7 }, // 200 USDC
  agents: [
    ...PLAN_DEPOSIT_ONLY.agents,
    {
      allocationId: 'run-1:bridge:base',
      kind: 'bridge',
      hostNetworkId: 'stellar-testnet',
      allocation: { token: 'USDC', units: '1000000000', decimals: 7 },
      cap: { token: 'USDC', units: '1000000000', decimals: 7 },
      periodSeconds: 3600,
      expiry: NOW + 3600,
      destination: 'Base Sepolia bridge',
      children: [
        {
          allocationId: 'run-1:bridge:aave-v3',
          proxyTarget: 'aave-v3',
          destination: 'aave-v3',
          allocation: 100,
        },
      ],
      instructions:
        'Bridge USDC to the allowlisted Base custody proxies via Circle CCTP v2, then stop.',
    },
  ],
  truth: { agentIsolationCount: 2, stellarVenueCount: 1, baseUsesProxyVaults: true },
})

function reviewedAgentInit(over = {}) {
  return {
    allocationId: 'run-1:deposit:0',
    kind: 0,
    token: TOKEN_ADDR,
    target: VAULT_ADDR,
    cap: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
    periodSeconds: 3600,
    // Exactly 3 periods ahead of NOW (3 * 3600 = 10800) so maxAtRisk (cap * ceil(periods)) is
    // distinctly 3x the per-period cap -- a boundary-equal fixture (1 period) couldn't tell a
    // reader (or a future reviewer) that this is really `maxAtRisk`, not just an echo of `cap`.
    expiry: NOW + 10800,
    signerFingerprint: '0xsig1',
    saltFingerprint: '0xsalt1',
    destinationDomain: 0,
    mintRecipient: null,
    ...over,
  }
}

function freshDecisionRaw(over = {}) {
  return {
    version: 1,
    runId: 'run-1',
    owner: OWNER,
    planFingerprint: '0xplan1',
    agentInitFingerprint: '0xagentinit1',
    checkedAt: NOW,
    reviewedBudgets: [{ token: TOKEN_ADDR, units: '1000000000', decimals: 7 }],
    durationSeconds: 86400,
    reviewedAgentInits: [reviewedAgentInit()],
    mode: 'fresh',
    confirmationCount: 1,
    grantReceiptFingerprint: null,
    allowanceExpiryProof: null,
    agents: [],
    freshReason: 'allowance-proof-missing',
    ...over,
  }
}

function reuseDecisionRaw(over = {}) {
  return {
    ...freshDecisionRaw(),
    mode: 'reuse',
    confirmationCount: 0,
    grantReceiptFingerprint: '0xreceipt1',
    allowanceExpiryProof: {
      latestLedger: 1000,
      approvals: [{ amount: { token: TOKEN_ADDR, units: '900000000' } }],
    },
    freshReason: null,
    agents: [
      {
        allocationId: 'run-1:deposit:0',
        workerId: 'run-1:deposit:0',
        agentAddress: AGENT_1,
        headroom: { token: TOKEN_ADDR, units: '900000000', decimals: 7 },
        scopeExpiry: NOW + 7200,
        scopeFingerprint: '0xscope1',
        executionCredentialRef: SECRET_REF,
      },
    ],
    ...over,
  }
}

const AVAILABLE_WALLETS = ['VF Wallet', 'Freighter', 'xBull', 'Albedo']

function baseProps(overrides = {}) {
  return {
    plan: PLAN_DEPOSIT_ONLY,
    owner: OWNER,
    availableWallets: AVAILABLE_WALLETS,
    onConnectWallet: vi.fn().mockResolvedValue(OWNER),
    onRetryPreflight: vi.fn().mockResolvedValue(freshDecisionRaw()),
    onRequestGrant: vi.fn().mockResolvedValue({ agentAddresses: [AGENT_1] }),
    onConfirmReuse: vi.fn().mockResolvedValue({ agentAddresses: [AGENT_1] }),
    onEditPlan: vi.fn(),
    ...overrides,
  }
}

async function checkPermission() {
  fireEvent.click(screen.getByRole('button', { name: 'Check my permission' }))
  await screen.findByRole('button', { name: /Authorize with wallet|Continue/ })
}

// Task 6 (Pocket Crew design alignment) -- the "Protect recompose" tests below use their own
// small render helper + a `planFixture` alias onto the file's existing PLAN_DEPOSIT_ONLY fixture
// (this file had no shared render helper before this task -- every earlier test calls
// `render(<ProtectStage {...baseProps(overrides)} />)` directly; this wraps that same call).
const planFixture = PLAN_DEPOSIT_ONLY

function renderProtectStage(overrides = {}) {
  return render(<ProtectStage {...baseProps(overrides)} />)
}

describe('ProtectStage — disconnected: wallet choice', () => {
  it('lists every available wallet and offers a real connect action', () => {
    render(<ProtectStage {...baseProps({ owner: null })} />)
    const text = document.body.textContent
    for (const name of AVAILABLE_WALLETS) expect(text).toContain(name)
    expect(screen.queryByRole('button', { name: 'Check my permission' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeTruthy()
  })

  it('shows only the wallets the caller reports as available', () => {
    render(
      <ProtectStage {...baseProps({ owner: null, availableWallets: ['VF Wallet', 'Freighter'] })} />
    )
    const text = document.body.textContent
    expect(text).toContain('VF Wallet')
    expect(text).toContain('Freighter')
    expect(text).not.toContain('xBull')
    expect(text).not.toContain('Albedo')
  })

  it('calls the real connect action on click -- no fake picker UI of its own', async () => {
    const onConnectWallet = vi.fn().mockResolvedValue(OWNER)
    render(<ProtectStage {...baseProps({ owner: null, onConnectWallet })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(onConnectWallet).toHaveBeenCalledTimes(1)
  })
})

describe('ProtectStage — preflight `checking` makes no confirmation claim', () => {
  it('shows a neutral checking notice with zero confirmation language and no action buttons', async () => {
    const gen = deferred()
    const onRetryPreflight = vi.fn().mockReturnValue(gen.promise)
    render(<ProtectStage {...baseProps({ onRetryPreflight })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check my permission' }))

    expect(screen.queryByText(/confirmation/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Authorize with wallet|Continue/ })).toBeNull()
    expect(screen.getByRole('status')).toBeTruthy()

    gen.resolve(freshDecisionRaw())
    await screen.findByRole('button', { name: 'Authorize with wallet' })
  })
})

describe('ProtectStage — fresh review content (Step 2: friendly + technical copy, same data)', () => {
  it('shows one confirmation, the intended amount, headroom, nominal exposure, duration, and per-agent facts', async () => {
    render(<ProtectStage {...baseProps()} />)
    await checkPermission()

    expect(screen.getByText(/This needs 1 wallet confirmation/)).toBeTruthy()
    expect(screen.getByText('100 USDC')).toBeTruthy() // plan.amount, the intended amount
    expect(screen.getByText(/Headroom after granting: 100 USDC/)).toBeTruthy()
    // maxAtRisk: cap 100 USDC * ceil(10800/3600 periods) = 300 USDC (see reviewedAgentInit's comment).
    expect(screen.getByText(/Worst case.*300 USDC/)).toBeTruthy()
    expect(screen.getByText(/Valid for 24 hours/)).toBeTruthy()
    expect(screen.getByText(/Cap per period: 100 USDC/)).toBeTruthy()
    expect(screen.getByText(/Expires/)).toBeTruthy()
    expect(screen.getByText(/separate session key/i)).toBeTruthy()
    expect(screen.getByText(/stopped on its own/i)).toBeTruthy()
    expect(screen.getByText(/Gas is sponsored/i)).toBeTruthy()
  })

  it('does not collapse a mixed Stellar allowance + exact bridge budget into one misleading total', async () => {
    // C1 (review finding): both rows use REAL, DIFFERENT Stellar contract addresses (the vault
    // deposit token and the CCTP bridge's burn-source token) -- the exact production shape. The
    // old fixture substituted human labels directly ('USDC', 'Circle USDC (Base)'), a shape
    // reusePreflight.js/grant.js can never emit, which is why this test could pass even while the
    // shipped code rendered a raw 56-char address where "Circle USDC" now correctly appears.
    const onRetryPreflight = vi.fn().mockResolvedValue(
      freshDecisionRaw({
        reviewedBudgets: [
          { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
          { token: BRIDGE_TOKEN_ADDR, units: '500000000', decimals: 7 },
        ],
      })
    )
    render(<ProtectStage {...baseProps({ plan: PLAN_WITH_BRIDGE, onRetryPreflight })} />)
    await checkPermission()

    // Both budget rows render distinctly, as human symbols -- never the raw contract address...
    expect(screen.getByText(/Headroom after granting: 100 USDC/)).toBeTruthy()
    expect(screen.getByText(/Headroom after granting: 50 Circle USDC/)).toBeTruthy()
    // ...and nothing on screen presents their sum (150) as a single ceiling/total.
    expect(screen.queryByText(/150/)).toBeNull()
    // The one true "intended amount" still comes from the reviewed plan, unaffected by budget rows.
    expect(screen.getByText('200 USDC')).toBeTruthy()
  })

  // Strategy Task 14 fix round 2 (reviewer finding, concern 4): this guard used to scope itself to
  // `.pc-support-content` -- the one sub-element Strategy Task 11's review happened to name -- so
  // the SAME Critical could resurface at a different site (the confirmation-count MoneyFigure,
  // `.pc-strategy-decision`, a sibling of `.pc-support-content`) and stay green (Strategy Task 14's
  // I-4). Widened to scan the WHOLE rendered Protect surface for the class of defect, not an
  // enumerated subset of sites: strip every technical disclosure (Owner decision #19's one
  // sanctioned place for a raw identifier -- `.pc-technical-details`/`.pc-technical`) and assert no
  // Stellar CONTRACT address (`C` + 55 base32 chars -- SEP-41 tokens are always contracts, matching
  // scval.js's addrScVal boundary) survives anywhere else, a real Stellar G-account identity (e.g.
  // an agent address) is a different, intentionally-visible thing and not what this guards.
  const STELLAR_CONTRACT_RE = /\bC[A-Z2-7]{55}\b/

  it('C1: no raw Stellar contract address survives anywhere on the friendly Protect surface (only inside a technical disclosure)', async () => {
    // plan.amount.token is resolved defensively via tokenSymbol() at its one render site
    // (ProtectStage.jsx's confirmation-count MoneyFigure) regardless of what today's one real
    // caller (PlanStage.jsx, always the literal 'USDC') happens to pass -- same principle as the
    // reviewedBudgets/reviewedAgentInits resolution a few lines above. PLAN_DEPOSIT_ONLY's own
    // `amount.token` is already the literal 'USDC', so it cannot exercise that defensive path
    // either way -- a guard built on it would pass whether or not the resolution code even
    // existed. A real contract address here is what actually proves it (mutation-verified: see
    // the Task 14 fix-round-2 report -- reverting the resolution at ProtectStage.jsx:334 makes
    // exactly this assertion fail).
    const planWithRealTopLevelToken = {
      ...PLAN_DEPOSIT_ONLY,
      amount: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
    }
    const onRetryPreflight = vi.fn().mockResolvedValue(freshDecisionRaw())
    const { container } = render(
      <ProtectStage {...baseProps({ plan: planWithRealTopLevelToken, onRetryPreflight })} />
    )
    await checkPermission()

    const friendlySurface = container.cloneNode(true)
    friendlySurface.querySelectorAll('.pc-technical-details, .pc-technical').forEach((el) => {
      el.remove()
    })
    expect(friendlySurface.textContent).toContain('USDC')
    expect(friendlySurface.textContent).not.toMatch(STELLAR_CONTRACT_RE)
    expect(friendlySurface.textContent).not.toContain(TOKEN_ADDR)
  })

  it('I3: "Cap per period" and "Worst case" label from EACH agent\'s own reviewed cap token, never plan.amount.token', async () => {
    // A genuine mixed-token plan: the deposit agent is budgeted in TOKEN_ADDR (-> "USDC"), the
    // bridge agent in a DIFFERENT real Stellar contract, BRIDGE_TOKEN_ADDR (-> "Circle USDC") --
    // while plan.amount.token stays the generic 'USDC' literal for both. Before the I3 fix, both
    // rows read `plan.amount.token` and were therefore identically (and for the bridge row,
    // wrongly) labelled "USDC" regardless of which contract each agent was actually capped in.
    const bridgeReviewed = reviewedAgentInit({
      allocationId: 'run-1:bridge:base',
      token: BRIDGE_TOKEN_ADDR,
      cap: { token: BRIDGE_TOKEN_ADDR, units: '500000000', decimals: 7 },
    })
    const onRetryPreflight = vi
      .fn()
      .mockResolvedValue(
        freshDecisionRaw({ reviewedAgentInits: [reviewedAgentInit(), bridgeReviewed] })
      )
    render(<ProtectStage {...baseProps({ plan: PLAN_WITH_BRIDGE, onRetryPreflight })} />)
    await checkPermission()

    expect(screen.getByText(/Worst case for agent 1.*300 USDC/)).toBeTruthy()
    expect(screen.getByText(/Worst case for agent 2.*150 Circle USDC/)).toBeTruthy()
    expect(screen.getByText(/Cap per period: 100 USDC/)).toBeTruthy()
    expect(screen.getByText(/Cap per period: 50 Circle USDC/)).toBeTruthy()
  })

  it('lets the user choose the duration preset before checking', async () => {
    const onRetryPreflight = vi
      .fn()
      .mockResolvedValue(freshDecisionRaw({ durationSeconds: 604800 }))
    render(<ProtectStage {...baseProps({ onRetryPreflight })} />)
    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check my permission' }))
    await screen.findByRole('button', { name: 'Authorize with wallet' })
    expect(onRetryPreflight).toHaveBeenCalledWith({ durationSeconds: 604800 })
    expect(screen.getByText(/Valid for 7 days/)).toBeTruthy()
  })
})

describe('ProtectStage — reuse review content', () => {
  it('shows 0 wallet confirmations and the exact reused agents/headroom/expiry', async () => {
    const onRetryPreflight = vi.fn().mockResolvedValue(reuseDecisionRaw())
    render(<ProtectStage {...baseProps({ onRetryPreflight })} />)
    await checkPermission()

    expect(screen.getByText(/0 wallet confirmations/)).toBeTruthy()
    expect(screen.getByText(AGENT_1)).toBeTruthy()
    expect(screen.getByText(/Headroom: 90 USDC/)).toBeTruthy()
    expect(screen.getByText(/Expires/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
  })

  it('never renders the secret execution credential reference', async () => {
    const onRetryPreflight = vi.fn().mockResolvedValue(reuseDecisionRaw())
    render(<ProtectStage {...baseProps({ onRetryPreflight })} />)
    await checkPermission()
    expect(document.body.textContent).not.toContain(SECRET_REF)
  })

  it('I: unknown expiry cannot show reuse -- falls back to a re-check, never a 0-confirmation CTA', async () => {
    const badReuse = reuseDecisionRaw({
      agents: [{ ...reuseDecisionRaw().agents[0], scopeExpiry: undefined }],
    })
    const onRetryPreflight = vi.fn().mockResolvedValue(badReuse)
    render(<ProtectStage {...baseProps({ onRetryPreflight })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check my permission' }))
    await screen.findByRole('button', { name: 'Check again' })

    expect(screen.queryByText(/0 wallet confirmations/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.getByText(/Could not confirm your existing permission/)).toBeTruthy()
  })
})

describe('ProtectStage — Base always shows fresh + the full mandate trust disclosure', () => {
  const baseMandateView = {
    status: 'ready',
    ready: true,
    destination: 'allowlisted Base Sepolia custody proxies',
    technicalDisclosure: 'The relayer holds the session key. Binding ID: bind-1.',
    renewalCopy: 'Renew the mandate before its expiry to continue using Base testnet.',
    revokeCopy: 'Deleting or revoking the VF relayer copy does not invalidate another copied key.',
    outageCopy:
      'If the relayer has an outage, Base is unavailable until its health check succeeds.',
  }

  it('shows the full trust disclosure regardless of phase, and the decision is always fresh', async () => {
    const onRetryPreflight = vi
      .fn()
      .mockResolvedValue(freshDecisionRaw({ freshReason: 'base-required' }))
    render(
      <ProtectStage {...baseProps({ plan: PLAN_WITH_BRIDGE, onRetryPreflight, baseMandateView })} />
    )

    // Present even before the user checks permission -- Base's trust story is not conditional on
    // the fresh/reuse outcome, since a bridge leg always forces fresh anyway.
    expect(screen.getByText(baseMandateView.technicalDisclosure)).toBeTruthy()
    expect(screen.getByText(baseMandateView.renewalCopy)).toBeTruthy()
    expect(screen.getByText('Base Sepolia proxy. Custody only. No protocol yield.')).toBeTruthy()

    await checkPermission()
    expect(screen.getByText(/This needs 1 wallet confirmation/)).toBeTruthy() // fresh, never reuse
    expect(screen.getByText(baseMandateView.technicalDisclosure)).toBeTruthy()
  })
})

describe('ProtectStage — the real wallet request begins while the UI stays in Protect', () => {
  it('calls onRequestGrant synchronously on click and stays on the Protect surface with no dialog', async () => {
    const gen = deferred()
    const onRequestGrant = vi.fn().mockReturnValue(gen.promise)
    render(<ProtectStage {...baseProps({ onRequestGrant })} />)
    await checkPermission()

    fireEvent.click(screen.getByRole('button', { name: 'Authorize with wallet' }))
    expect(onRequestGrant).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Protect this run')).toBeTruthy() // still in Protect, no navigation away
    expect(document.querySelector('[role="dialog"]')).toBeNull() // no fake modal/ceremony
    expect(screen.queryByText(/Sign authorization/)).toBeNull()

    gen.resolve({ agentAddresses: [AGENT_1] })
    await screen.findByText('Confirmed')
  })
})

describe('ProtectStage — only a confirmed result advances; nothing optimistic', () => {
  it('shows nothing "confirmed" until onRequestGrant actually resolves', async () => {
    const gen = deferred()
    const onRequestGrant = vi.fn().mockReturnValue(gen.promise)
    render(<ProtectStage {...baseProps({ onRequestGrant })} />)
    await checkPermission()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize with wallet' }))

    expect(screen.queryByText('Confirmed')).toBeNull()
    expect(screen.queryByText(AGENT_1)).toBeNull()

    gen.resolve({ agentAddresses: [AGENT_1] })
    await screen.findByText('Confirmed')
    expect(screen.getByText(AGENT_1)).toBeTruthy()
  })

  it('never shows confirmed when the request is rejected', async () => {
    const onRequestGrant = vi.fn().mockRejectedValue(new Error('User declined access'))
    render(<ProtectStage {...baseProps({ onRequestGrant })} />)
    await checkPermission()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize with wallet' }))
    await screen.findByText('Nothing moved')
    expect(screen.queryByText('Confirmed')).toBeNull()
  })
})

describe('ProtectStage — rejection/failure says "Nothing moved" and offers Retry/Edit', () => {
  it('preserves the plan and review, shows Nothing moved verbatim, and retries the SAME wallet request', async () => {
    const onRequestGrant = vi
      .fn()
      .mockRejectedValueOnce(new Error('User declined access'))
      .mockResolvedValueOnce({ agentAddresses: [AGENT_1] })
    render(<ProtectStage {...baseProps({ onRequestGrant })} />)
    await checkPermission()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize with wallet' }))
    await screen.findByText('Nothing moved')

    // Review facts are preserved, not wiped.
    expect(screen.getByText('100 USDC')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit plan' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRequestGrant).toHaveBeenCalledTimes(2) // retried the grant directly, no re-preflight
    await screen.findByText('Confirmed')
  })

  it('Edit plan calls onEditPlan', async () => {
    const onEditPlan = vi.fn()
    const onRequestGrant = vi.fn().mockRejectedValue(new Error('nope'))
    render(<ProtectStage {...baseProps({ onEditPlan, onRequestGrant })} />)
    await checkPermission()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize with wallet' }))
    await screen.findByText('Nothing moved')
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    expect(onEditPlan).toHaveBeenCalledTimes(1)
  })
})

describe('ProtectStage — I2: fresh and reuse authorize through distinct actions', () => {
  it('the fresh review calls onRequestGrant, and never onConfirmReuse', async () => {
    const onRequestGrant = vi.fn().mockResolvedValue({ agentAddresses: [AGENT_1] })
    const onConfirmReuse = vi.fn().mockResolvedValue({ agentAddresses: [AGENT_1] })
    render(<ProtectStage {...baseProps({ onRequestGrant, onConfirmReuse })} />)
    await checkPermission()

    fireEvent.click(screen.getByRole('button', { name: 'Authorize with wallet' }))
    await screen.findByText('Confirmed')
    expect(onRequestGrant).toHaveBeenCalledTimes(1)
    expect(onConfirmReuse).not.toHaveBeenCalled()
  })

  it("the reuse review calls onConfirmReuse, and never onRequestGrant -- a single shared action would dispatch GRANT_REQUESTED into REUSE_CONFIRMED's guard and deadlock the flow", async () => {
    const onRetryPreflight = vi.fn().mockResolvedValue(reuseDecisionRaw())
    const onRequestGrant = vi.fn().mockResolvedValue({ agentAddresses: [AGENT_1] })
    const onConfirmReuse = vi.fn().mockResolvedValue({ agentAddresses: [AGENT_1] })
    render(<ProtectStage {...baseProps({ onRetryPreflight, onRequestGrant, onConfirmReuse })} />)
    await checkPermission()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Confirmed')
    expect(onConfirmReuse).toHaveBeenCalledTimes(1)
    expect(onRequestGrant).not.toHaveBeenCalled()
  })
})

describe('ProtectStage — PermissionPhaseError rebuilds a fresh review, never a surprise wallet request', () => {
  it('from the initial preflight: Retry re-checks, never opens the wallet', async () => {
    const onRetryPreflight = vi
      .fn()
      .mockRejectedValueOnce(
        new PermissionPhaseError({ phase: 'preflight', code: 'X', message: 'stale' })
      )
      .mockResolvedValueOnce(freshDecisionRaw())
    const onRequestGrant = vi.fn().mockResolvedValue({ agentAddresses: [AGENT_1] })
    render(<ProtectStage {...baseProps({ onRetryPreflight, onRequestGrant })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check my permission' }))
    await screen.findByText('Nothing moved')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryPreflight).toHaveBeenCalledTimes(2)
    expect(onRequestGrant).not.toHaveBeenCalled() // no surprise wallet request
    await screen.findByRole('button', { name: 'Authorize with wallet' })
  })

  it('from reuse revalidation: Retry rebuilds via preflight, never re-calls the wallet-requesting action directly', async () => {
    const onRetryPreflight = vi
      .fn()
      .mockResolvedValueOnce(reuseDecisionRaw())
      .mockResolvedValueOnce(freshDecisionRaw())
    // Reuse revalidation failures surface through onConfirmReuse (I2) -- onRequestGrant, the
    // fresh-grant wallet action, must never even be called on this path.
    const onConfirmReuse = vi.fn().mockRejectedValueOnce(
      new PermissionPhaseError({
        phase: 'reuse-revalidation',
        code: 'Y',
        message: 'evidence changed',
      })
    )
    const onRequestGrant = vi.fn().mockResolvedValue({ agentAddresses: [AGENT_1] })
    render(<ProtectStage {...baseProps({ onRetryPreflight, onConfirmReuse, onRequestGrant })} />)
    await checkPermission()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByText('Nothing moved')
    expect(onConfirmReuse).toHaveBeenCalledTimes(1)
    expect(onRequestGrant).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryPreflight).toHaveBeenCalledTimes(2)
    // The stale reuse decision must not still be on screen (it was proven stale).
    await screen.findByRole('button', { name: 'Authorize with wallet' })
    expect(screen.queryByText(/0 wallet confirmations/)).toBeNull()
    // Retry never re-invoked the reuse-confirming action on its own.
    expect(onConfirmReuse).toHaveBeenCalledTimes(1)
  })
})

describe('ProtectStage — no fake modal, no timeout, no simulated ceremony', () => {
  it('source contains no Dialog usage, no setTimeout, and no "Sign authorization" ceremony copy', () => {
    const source = fs.readFileSync(path.resolve(here, './ProtectStage.jsx'), 'utf8')
    expect(source).not.toMatch(/setTimeout|setInterval/)
    expect(source).not.toMatch(/<Dialog|Dialog>/)
    expect(source).not.toMatch(/Sign authorization/)
  })

  it('no component in this surface sets an inline style or an inline animation', () => {
    const source = fs.readFileSync(path.resolve(here, './ProtectStage.jsx'), 'utf8')
    expect(source).not.toMatch(/style=|animation/i)
  })
})

describe('ProtectStage — keyboard operability and long values', () => {
  it('exposes every interactive control as a native, keyboard-operable element', async () => {
    render(<ProtectStage {...baseProps()} />)
    for (const el of screen.getAllByRole('button')) expect(el.tagName).toBe('BUTTON')
    await checkPermission()
    for (const el of screen.getAllByRole('button')) expect(el.tagName).toBe('BUTTON')
  })

  it('renders a very large reviewed amount without truncating or crashing', async () => {
    const onRetryPreflight = vi.fn().mockResolvedValue(
      freshDecisionRaw({
        reviewedAgentInits: [
          reviewedAgentInit({ cap: { token: TOKEN_ADDR, units: '123456789012345', decimals: 7 } }),
        ],
      })
    )
    const bigPlan = {
      ...PLAN_DEPOSIT_ONLY,
      amount: { token: 'USDC', units: '123456789012345', decimals: 7 },
      agents: [
        {
          ...PLAN_DEPOSIT_ONLY.agents[0],
          cap: { token: 'USDC', units: '123456789012345', decimals: 7 },
        },
      ],
    }
    render(<ProtectStage {...baseProps({ plan: bigPlan, onRetryPreflight })} />)
    await checkPermission()
    // MoneyFigure formats via Number.prototype.toLocaleString(), which defaults to 3 fraction
    // digits (verified directly: (12345678.9012345).toLocaleString() === '12,345,678.901') --
    // this only proves the huge value renders and is not silently dropped/crashed, not that every
    // digit survives (MoneyFigure's own rounding is Foundation's concern, not this stage's).
    expect(screen.getByText('12,345,678.901 USDC')).toBeTruthy()
  })

  it('renders a long technical fingerprint inside a disclosure without losing any of it', async () => {
    const longFingerprint = '0x' + 'a1b2c3d4'.repeat(8) // 66 chars, matches a real sha256 hex length
    const onRetryPreflight = vi.fn().mockResolvedValue(
      freshDecisionRaw({
        reviewedAgentInits: [reviewedAgentInit({ signerFingerprint: longFingerprint })],
      })
    )
    render(<ProtectStage {...baseProps({ onRetryPreflight })} />)
    await checkPermission()
    const details = document.querySelector('.pc-technical-details summary')
    fireEvent.click(details)
    // The fingerprint shares a <p> with its "Session key fingerprint: " label -- getByText's
    // default exact-match compares the WHOLE element's text content, so a regex (not the bare
    // fingerprint string) is the correct matcher here, not a sign of broken-up text.
    expect(screen.getByText(new RegExp(longFingerprint))).toBeTruthy()
  })
})

describe('ProtectStage — reduced motion / no animation (rejection checklist item 6)', () => {
  it('strategy.css defines no NEW keyframes, animation, or gradient declarations', () => {
    const css = fs.readFileSync(path.resolve(here, './strategy.css'), 'utf8')
    expect(css).not.toMatch(/@keyframes/i)
    expect(css).not.toMatch(/\banimation(-name)?\s*:/i)
    expect(css).not.toMatch(/gradient/i)
  })

  // Owner decision #19 (Wave 6 carry): the Foundation-level default for the disclosure container
  // itself flipped to the body face -- a disclosure's own caption is UI chrome, and its body is not
  // reliably technical (PlanStage's editable instructions prove that). What DOES need to stay mono
  // on THIS surface is the raw values inside it (fingerprint/token contract/target), which
  // ProtectStage.jsx now marks individually with `.pc-technical`. This replaces the old container-
  // level pin (which asserted the CONTAINER computed mono) with a pin on the actual values, plus an
  // explicit assertion that the container itself is NOT mono -- so a regression in either direction
  // (container silently back to mono, or a value losing its .pc-technical mark) goes red.
  it("unlike Plan's editable-instructions case, this surface's raw values (fingerprint/contract IDs) stay mono via .pc-technical even though the container itself is the friendly body face", async () => {
    await withRealStylesheet(async () => {
      render(<ProtectStage {...baseProps()} />)
      await checkPermission()
      const summary = document.querySelector('.pc-technical-details-summary')
      fireEvent.click(summary)
      const body = document.querySelector('.pc-technical-details-body')
      expect(getComputedStyle(summary).fontFamily).toBe('var(--font-body)')
      expect(getComputedStyle(body).fontFamily).toBe('var(--font-body)')
      const values = body.querySelectorAll('.pc-technical')
      expect(values.length).toBeGreaterThanOrEqual(3) // fingerprint, token contract, target
      for (const value of values) {
        expect(getComputedStyle(value).fontFamily).toBe('var(--font-mono)')
      }
    })
  })
})

describe('ProtectStage — axe', () => {
  it('has zero violations disconnected', async () => {
    const { container } = render(<ProtectStage {...baseProps({ owner: null })} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero violations on the fresh review', async () => {
    const { container } = render(<ProtectStage {...baseProps()} />)
    await checkPermission()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero violations on the reuse review', async () => {
    const onRetryPreflight = vi.fn().mockResolvedValue(reuseDecisionRaw())
    const { container } = render(<ProtectStage {...baseProps({ onRetryPreflight })} />)
    await checkPermission()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has zero violations on the failed/"Nothing moved" state', async () => {
    const onRequestGrant = vi.fn().mockRejectedValue(new Error('nope'))
    const { container } = render(<ProtectStage {...baseProps({ onRequestGrant })} />)
    await checkPermission()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize with wallet' }))
    await screen.findByText('Nothing moved')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('Protect recompose', () => {
  it('renders the four boundary bullets from the plan', () => {
    renderProtectStage({ plan: planFixture }) // reuse the file's existing plan fixture/helper
    expect(screen.getByText(/can spend at most/i)).toBeTruthy()
    expect(screen.getByText(/stops on/i)).toBeTruthy()
    expect(screen.getByText(/pinned to one vault/i)).toBeTruthy()
    expect(screen.getByText(/only go back to your address/i)).toBeTruthy()
  })

  it('renders PASSED and REJECTED background-check rows from plan.review', () => {
    renderProtectStage({
      plan: {
        ...planFixture,
        review: {
          candidates: [
            { protocol: 'Blend Capital v2', chain: 'stellar', eligible: true, reasons: [] },
            { protocol: 'Aave v3 (proxy)', chain: 'base', eligible: false, reasons: ['facts stale'] },
          ],
        },
      },
    })
    expect(screen.getByText('PASSED')).toBeTruthy()
    expect(screen.getByText('REJECTED')).toBeTruthy()
    expect(screen.getByText(/facts stale/i)).toBeTruthy()
  })

  it('omits the background-check section when the plan has no review', () => {
    renderProtectStage({ plan: { ...planFixture, review: null } })
    expect(screen.queryByText(/background check/i)).toBeNull()
  })
})

describe('ProtectStage — 320px real layout guard', () => {
  it('G: disconnected wallet-choice phase creates no horizontal overflow at 320px', async () => {
    const { container } = render(
      <div className="pc-route">
        <div className="pc-route-stack">
          <ProtectStage {...baseProps({ owner: null })} />
        </div>
      </div>
    )
    const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
    expect(scrollWidth).toBe(320)
  }, 20000)

  it('G: the fresh review (richest content, including an expanded long technical disclosure) creates no horizontal overflow at 320px', async () => {
    const longFingerprint = '0x' + 'a1b2c3d4'.repeat(8)
    const onRetryPreflight = vi.fn().mockResolvedValue(
      freshDecisionRaw({
        reviewedAgentInits: [reviewedAgentInit({ signerFingerprint: longFingerprint })],
      })
    )
    const { container } = render(
      <div className="pc-route">
        <div className="pc-route-stack">
          <ProtectStage {...baseProps({ plan: PLAN_WITH_BRIDGE, onRetryPreflight })} />
        </div>
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check my permission' }))
    await screen.findByRole('button', { name: 'Authorize with wallet' })
    // Expand every technical-details disclosure so the long fingerprint actually contributes to
    // layout in the real-browser measurement below (a collapsed <details> body contributes
    // nothing to box width, which would make this guard unable to see its own regression).
    for (const el of document.querySelectorAll('.pc-technical-details summary')) fireEvent.click(el)

    const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
    expect(scrollWidth).toBe(320)
  }, 20000)

  it('G: the reuse review renders a full 56-char contract address as plain (always-visible) text with no horizontal overflow at 320px', async () => {
    const onRetryPreflight = vi.fn().mockResolvedValue(reuseDecisionRaw())
    const { container } = render(
      <div className="pc-route">
        <div className="pc-route-stack">
          <ProtectStage {...baseProps({ onRetryPreflight })} />
        </div>
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check my permission' }))
    await screen.findByRole('button', { name: 'Continue' })

    const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
    expect(scrollWidth).toBe(320)
  }, 20000)

  it('G: the confirmed state renders a full deployed agent address with no horizontal overflow at 320px', async () => {
    const gen = deferred()
    const onRequestGrant = vi.fn().mockReturnValue(gen.promise)
    const { container } = render(
      <div className="pc-route">
        <div className="pc-route-stack">
          <ProtectStage {...baseProps({ onRequestGrant })} />
        </div>
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check my permission' }))
    await screen.findByRole('button', { name: 'Authorize with wallet' })
    fireEvent.click(screen.getByRole('button', { name: 'Authorize with wallet' }))
    gen.resolve({ agentAddresses: [AGENT_1] })
    await screen.findByText('Confirmed')

    const scrollWidth = await measureScrollWidthAt320(container.innerHTML)
    expect(scrollWidth).toBe(320)
  }, 20000)
})
