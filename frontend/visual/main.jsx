// frontend/visual/main.jsx
// Secondary Vite entry (frontend/visual/index.html) for Playwright visual regression + this
// file's own jsdom-importable `FoundationAtlasFixture` (Foundation Task 10). Reads `?fixture=<id>` and
// `?theme=forest|day-field` from the URL exactly like Task 1 established; the Playwright spec
// (../e2e/pocket-crew.visual.spec.js) drives both params, and foundationA11y.test.jsx imports
// `FoundationAtlasFixture` directly (no browser, no query string) to assert the same composition is
// axe-clean and meets every registered contrast tuple.
//
// The real app's own entry (src/main.jsx) loads the legacy stylesheet, the Pocket Crew semantic
// layer, and the three self-hosted variable fonts -- this harness mirrors that so the frozen
// screenshots are the same pixels the product actually ships, not an unstyled stand-in.
//
// VF Wallet Task 14: this MUST be the first import in the file (extension/shims.js's own header:
// "this file must stay the FIRST import of every entry that touches wallet code"). Discovered by
// running the harness after wiring in the wallet fixtures below: WalletOnboarding.jsx (needed for
// first-run/account-choice/seed-backup) and WalletAdvanced.jsx (its "Restore a different wallet"
// section) both statically import extension/classic/ImportScreen.jsx -> importValidate.js ->
// classicKeypair.js -> the 'ed25519-hd-key' package -> 'hash-base's bundled 'readable-stream',
// which reads a bare `process` at MODULE-EVALUATION time (not gated behind any prop or runtime
// branch -- an ES import's transitive graph always evaluates, whichever fixture is active). MV3
// extension pages have no Node globals either, which is exactly why shims.js already exists and
// is already the first import of popup.jsx/approve.js/ceremony.js -- this harness has the
// identical requirement the moment it imports any wallet-onboarding component, for the first time
// with this task. Confirmed by a real-Chromium run: WITHOUT this import, `?fixture=foundation` and
// `?fixture=strategy` (fixtures with no relation to wallet code) ALSO crashed with "process is not
// defined" thrown from ed25519-hd-key's module body -- an uncaught ReferenceError during ES module
// evaluation aborts the whole module graph, not just the branch that needed it, so this was never
// a `vf-wallet`-only blast radius. WITH it, all fixtures (old and new) render cleanly -- see the
// task report for the before/after console-error transcript. Guarded internally
// (`typeof globalThis.process === 'undefined'`), so it changes nothing observable for every
// existing fixture, which never reads `process`/`Buffer` themselves.
import '../extension/shims.js'
import { createRoot } from 'react-dom/client'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import '@fontsource-variable/geist'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/newsreader'
import '../style.css'
import '../src/design/pocket-crew.css'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { FoundationAtlasFixture } from './FoundationAtlasFixture.jsx'
import {
  CORE_FIXTURE_CLOCK,
  CORE_FIXTURE_CLASSES,
  CORE_FIXTURE_STATES,
  buildCoreBaseWithdrawFixture,
  buildCoreCrewFixture,
  buildCoreDialogFixture,
  buildCoreMoneyFixture,
  buildCoreSettingsFixture,
  buildCoreStrategyFixture,
  withCoreFixtureEnvironment,
} from './coreFixtures.js'
import { StrategyRoute } from '../src/components/strategy/StrategyRoute.jsx'
// Pure selector, not a React component -- no CSS side effect (confirmed by reading the file in
// full), so a plain static top-level import here is safe exactly like approvalView.js/
// ceremonyView.js's own imports below (never a lazy() candidate; lazy() exists only to keep a
// ROUTE's own stylesheet off every fixture page, and this file has none).
import { selectCrewDecisions } from '../src/components/crew/selectCrewDecisions.js'
import { buildCrewPersonas } from '../src/crew/buildCrewPersonas.js'
// Task 12 fix round 1, M8: the real, shared export app.jsx itself imports from the same place
// (app.jsx:33, used for its own keeper-event fromLabel/toLabel -- app.jsx:1156-1157) -- not a
// second hand-copied `slice(0,6)…slice(-4)` this file would need to keep in sync by hand if the
// real one ever changes shape.
import { shortAddr } from '../src/screens.jsx'
import { buildMyMoneyModel } from '../src/money/myMoneyModel.js'
import {
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
} from '../src/stellar/config.js'
import {
  STELLAR_USDC_SAC,
  STELLAR_TOKEN_MESSENGER_MINTER,
  CCTP_BASE_DOMAIN,
} from '../src/stellar/cctpBurn.js'
import { VF_TESTNET_ISSUER } from '../src/wallet/trustline.js'
import LandingHero from '../src/components/LandingHero.jsx'
import OnboardingFlow from '../src/components/OnboardingFlow.jsx'
import ExplorerPage from '../src/components/ExplorerPage.jsx'
import EcosystemPage from '../src/components/EcosystemPage.jsx'
import ReplayPage from '../src/components/ReplayPage.jsx'
import HistoryPanel from '../src/components/HistoryPanel.jsx'
import VaultDetailPage from '../src/components/VaultDetailPage.jsx'
import TxDetailPage from '../src/components/TxDetailPage.jsx'
import DevelopersLayout from '../src/developers/DevelopersLayout.jsx'
import KeysSection from '../src/developers/KeysSection.jsx'
import UsageSection from '../src/developers/UsageSection.jsx'
import DocsSection from '../src/developers/DocsSection.jsx'
import SkillDrawer from '../src/components/SkillDrawer.jsx'
import {
  TweakButton,
  TweakSection,
  TweakSlider,
  TweakToggle,
  TweaksPanel,
} from '../src/tweaks-panel.jsx'
import {
  BASE_HEX_FIXTURES,
  SECONDARY_CLASS_ROUTES,
  SECONDARY_NOW,
  SECONDARY_OWNED_CLASSES,
  SECONDARY_ROUTE_FIXTURES,
  STELLAR_C_FIXTURES,
  STELLAR_G_FIXTURE,
  secondaryPayload,
} from './secondaryFixtures.js'
import {
  REQUIRED_WALLET_ATLAS_SECTIONS,
  WALLET_ATLAS_SECTION_MAP,
} from './walletFixtureRegistry.js'
// VF Wallet Task 14. WalletHome/WalletOnboarding/WalletActivity/WalletAdvanced/WalletSettings all
// wrap the shared WalletShell, which renders its own <style> tag inline on every mount (see
// VfWalletHomeFixture's own header comment below for why that makes it safe to import these
// statically, unlike MyMoneyRoute above) -- plain top-level imports, no lazy() needed.
import { WalletHome } from '../src/wallet/ui/WalletHome.jsx'
import { WalletOnboarding } from '../src/wallet/ui/WalletOnboarding.jsx'
import { WalletActivity } from '../src/wallet/ui/WalletActivity.jsx'
import { WalletReceive } from '../src/wallet/ui/WalletReceive.jsx'
import { WalletAdvanced } from '../src/wallet/ui/WalletAdvanced.jsx'
import { WalletSettings } from '../src/wallet/ui/WalletSettings.jsx'
import { WalletShell } from '../src/wallet/ui/WalletShell.jsx'
import { ApproveOverlay } from '../src/wallet/ui/ApproveOverlay.jsx'
import SendScreen from '../src/wallet/ui/classic/SendScreen.jsx'
import AddAssetScreen from '../src/wallet/ui/classic/AddAssetScreen.jsx'
// Pure vanilla view-model + DOM renderers (extension/approvalView.js, extension/ceremonyView.js)
// -- not React components, imported for their functions only. No CSS side effect (confirmed by
// reading both files in full): the stylesheet these need (extension/approval.css) is loaded
// separately, dynamically, only inside VfWalletApprovalFixture -- see that function's own header
// comment for why a static import here would repeat My Money's own cascade defect, more widely.
import {
  buildApprovalView,
  renderApprovalView,
  SUBMISSION_STATE,
} from '../extension/approvalView.js'
import { buildCeremonyView, renderCeremonyView, CEREMONY_STATE } from '../extension/ceremonyView.js'

// My Money Task 14: `lazy()`, not a static top-level import, and for a DIFFERENT reason than
// TechnicalMoneyDetails.jsx's own PixiSwarmGraph lazy-load (bundle size) -- this harness is ONE
// Vite entry serving every `?fixture=` value from the SAME page, so a static import here would
// mean my-money.css loads on EVERY fixture, always, including `?fixture=strategy`. Found
// empirically: my-money.css re-declares `.pc-route`/`.pc-dominant`/`.pc-button` etc. verbatim
// (its own header comment explains why -- "pocket-crew.css does not define these; only
// strategy.css has ported them so far, and this route must not depend on that file being
// loaded", written when each route's CSS was assumed to load in isolation, exactly as production
// code-splitting guarantees but this shared harness does not) -- loading BOTH stylesheets on the
// same page put my-money.css's copies last in source order, shrinking Strategy's frozen fixture by
// ~640px at both mobile projects (found via a controlled A/B: stubbing this import out made
// Strategy's 12/12 pass again).
//
// MM14 fix round 1 (I-3, reviewer finding): the ~640px cause IS now identified, and the two
// files' `.pc-route` declarations are NOT verbatim-identical -- strategy.css carries a mobile
// `padding-bottom: calc(var(--pc-space-20) + env(safe-area-inset-bottom))` rule
// (strategy.css:466-469) that my-money.css never had. my-money.css's own unconditional
// `.pc-route { padding: var(--pc-route-gutter) }` re-declares the `padding` SHORTHAND, which
// zeroes any `padding-bottom` a stylesheet loaded before it contributed -- loaded after
// strategy.css on this shared page, it silently deleted Strategy's own bottom-gutter override on
// every one of the fixture's 10 `.pc-route`s (StrategyFixture below mounts exactly ten
// Section-wrapped StrategyRoutes, each rendering exactly one `.pc-route` -- verified by count, not
// assumed). VFW14 correction: the arithmetic this comment previously gave here (and the one
// my-money.css:337 still carries) was wrong on two counts at once -- it named 8 routes where there
// are 10, and 80px per route where the actual per-route LOSS is 64px, not the full 80px: at mobile
// the base `.pc-route` gutter is 16px per side (`--pc-route-gutter`) and strategy.css's override
// replaces only the BOTTOM side with `--pc-space-20` (80px) + safe-area-inset-bottom (0 in headless
// Chromium) -- my-money.css's later shorthand reset returns that one side to 16px, so each route
// loses 80 - 16 = 64px, never the full 80. 10 routes x 64px = 640px, exactly. This was a
// (contract:845-848) and my-money.css never carried it, so My Money's own mobile surface shipped
// with no safe-area bottom gutter regardless of any other stylesheet on the page. Both are now
// fixed -- my-money.css carries its own copy of the rule (see its mobile media query) -- so this
// lazy-load no longer has a real cascade conflict left to guard against. It stays anyway: it is
// still the correct match for production's own route-level code-splitting (my-money.css should
// only ever be on the page when `?fixture=my-money` is), and removing it would leave the harness
// one accidental future shared-selector collision away from silently repeating this exact class of
// bug.
const MyMoneyRoute = lazy(() =>
  import('../src/components/money/MyMoneyRoute.jsx').then((m) => ({ default: m.MyMoneyRoute }))
)

// Task 12 (visual harness fixtures): same lazy-load discipline as MyMoneyRoute above, for the same
// verified reason -- CrewRoute.jsx statically imports its own './crew.css', which (confirmed by
// reading it) re-declares the SAME `.pc-route { padding: var(--pc-route-gutter) }` shorthand-reset
// rule my-money.css was found to carry (MM14 fix round 1, this same file's comment above). A static
// top-level import here would load crew.css on every `?fixture=` page, not only `?fixture=crew`,
// repeating that exact cascade defect a third time. lazy() keeps it out of the page entirely except
// when this fixture is the one requested.
const CrewRoute = lazy(() =>
  import('../src/components/crew/CrewRoute.jsx').then((m) => ({ default: m.CrewRoute }))
)
const SettingsPageRoute = lazy(() =>
  import('../src/components/SettingsPage.jsx').then((m) => ({ default: m.default }))
)
const WithdrawRoute = lazy(() =>
  Promise.all([
    // Withdraw.jsx is a standalone lazy route in production, while MyMoneyRoute normally brings
    // the money stylesheet onto the page first.  The Core CAP-18 fixture mounts Withdraw directly,
    // so load the same route-owned stylesheet at this composition boundary instead of leaving
    // technical/visually-hidden values unstyled (which can paint outside the 200% zoom viewport).
    import('../src/components/money/my-money.css'),
    import('../src/screens/Withdraw.jsx'),
  ]).then(([, m]) => ({ default: m.default }))
)
const WithdrawDialogRoute = lazy(() =>
  Promise.all([
    import('../src/components/money/my-money.css'),
    import('../src/components/money/WithdrawDialog.jsx'),
  ]).then(([, m]) => ({ default: m.WithdrawDialog }))
)
const StopAccessDialogRoute = lazy(() =>
  Promise.all([
    import('../src/components/money/my-money.css'),
    import('../src/components/money/StopAccessDialog.jsx'),
  ]).then(([, m]) => ({ default: m.StopAccessDialog }))
)
const RecoveryPanelRoute = lazy(() =>
  Promise.all([
    import('../src/components/money/my-money.css'),
    import('../src/components/money/RecoveryPanel.jsx'),
  ]).then(([, m]) => ({ default: m.RecoveryPanel }))
)

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') || 'foundation'
const theme = params.get('theme') || 'forest'
const motion = params.get('motion') === 'reduced' ? 'reduced' : 'normal'
const walletSection = params.get('section')
const secondaryClass = params.get('class')
const secondaryState = params.get('state') || 'current'
const secondaryBranch =
  fixture === 'secondary-routes' ? SECONDARY_CLASS_ROUTES[secondaryClass] || 'landing' : fixture

if (REQUIRED_WALLET_ATLAS_SECTIONS.length !== 41) {
  throw new Error('VF Wallet atlas must expose exactly 41 P/A/C sections')
}

// Secondary functional fixtures are offline by construction. Install the browser guard before
// the React root is mounted; local app assets are still loaded by the browser itself, while any
// route reader that accidentally reaches for an external source fails closed and its existing
// fail-soft path remains visible. The production readers/defaults are untouched.
const SECONDARY_FIXTURE_IDS = new Set([
  'landing',
  'onboarding',
  'explorer',
  'ecosystem',
  'replay',
  'history',
  'vault',
  'tx',
  'developers',
  'developer-keys',
  'developer-usage',
  'developer-docs',
  'skill-drawer',
  'dev-panel',
  'secondary-routes',
])

const isSecondaryFixture = SECONDARY_FIXTURE_IDS.has(fixture)
if (isSecondaryFixture) {
  const blocked = (kind) => {
    throw new Error(`Secondary fixture attempted an unexpected ${kind} call`)
  }
  Date.now = () => Date.parse(SECONDARY_NOW)
  Math.random = () => blocked('randomness')
  globalThis.fetch = () => blocked('network')
  globalThis.XMLHttpRequest = class SecondaryFixtureXHR {
    constructor() {
      blocked('XHR')
    }
  }
  globalThis.WebSocket = class SecondaryFixtureWebSocket {
    constructor() {
      blocked('WebSocket')
    }
  }
  if (globalThis.navigator && typeof globalThis.navigator.sendBeacon === 'function') {
    globalThis.navigator.sendBeacon = () => blocked('beacon')
  }
}

document.documentElement.dataset.theme = theme
document.documentElement.dataset.motion = motion

// -------------------------------------------------------------------------------------------
// Strategy Task 14 (Pocket Crew redesign, Wave 6 snapshot freeze). One deterministic composite
// covering every state Strategy Tasks 10-13 shipped: Plan input, safe-default generating/review,
// mixed Stellar/Base truth review, Protect fresh/reuse/rejected, Start queued/partial-failure/
// in-transit, all-success and mixed-partial receipts, long address/technical details, and (via the
// e2e spec's separate `prefers-reduced-motion` capture of this SAME fixture, exactly like
// FoundationAtlasFixture's own `foundation-reduced-motion.png`) reduced motion.
//
// Every real production component below (StrategyRoute -> PlanStage/ProtectStage/StartStage/
// StrategyReceipt) is mounted through its real composition root, StrategyRoute -- never a
// hand-assembled stand-in (Strategy Task 13's own review finding: app.jsx used to duplicate
// StrategyRoute's wrapper markup by hand, which had already drifted). PlanStage/ProtectStage's
// review/decision phases are internal, uncontrolled state reached only through real user
// interaction (typing, clicking) -- there is no prop that jumps straight to "ready" or "reviewed" --
// so each interactive state below is reached by dispatching the same native DOM events a real user
// produces (see `driveAutopilot` below), never by reaching into React internals. `data-fixture-pending`
// on the wrapping div is removed once a section's own driven interaction has genuinely settled; the
// Playwright spec waits for zero pending markers before capturing anything, so a screenshot never
// races a still-in-flight click/await chain -- the only source of "waiting" here is real committed
// state, never a timer.
const NOW_SECONDS = 1_800_000_000

// Determinism hazard, found empirically (a re-run of this exact fixture produced a different
// screenshot with zero code changes): planModel.js's expandAgentSlots defaults a plan agent's
// `expiry` to `Math.floor(Date.now() / 1000) + 3600` whenever the caller doesn't supply one --
// and PlanStage.jsx's real runGeneration() never does (matching real production: the strategist
// result it awaits carries no `expiry` field either). That default is invisible in a single run
// but drifts the "Plan -- safe-default review"/"mixed Stellar/Base truth review" sections' printed
// Expires timestamp by real wall-clock time between runs. Freezing Date.now() for this fixture
// module only (never touching planModel.js/PlanStage.jsx) is the fixture-side fix the brief's
// "freeze anything that moves -- clocks" rule calls for.
if (fixture === 'strategy') {
  const FIXED_NOW_MS = NOW_SECONDS * 1000
  Date.now = () => FIXED_NOW_MS
}

// Same determinism hazard, second clock: freezing Date.now() above is not enough for the
// "Plan -- safe-default generating" section. driveGenerating() parks PlanStage in `generating`
// forever (its `generate()` deliberately never resolves), and that phase owns a 1s
// `window.setInterval` counter (PlanStage.jsx:275) that does NOT read Date.now() -- it increments
// its own `generationElapsed`, which drives both the printed 00:mm:ss and the rotating
// BUILDING_MESSAGES line. So the surface kept changing every second forever: the frozen baseline
// captured whichever second it happened to land on, and Playwright could never take two
// consecutive stable screenshots of it (all 12 Strategy baselines, CI run 30772546683).
//
// Neutered here, in the harness, rather than in PlanStage: the ticking is correct product
// behaviour. Only setInterval is stubbed, and only on this fixture -- waitFor() above polls on
// setTimeout, and no other interval renders on the strategy surface.
if (fixture === 'strategy') {
  window.setInterval = () => 0
}

// Task 12 (visual harness fixtures): CrewGuard.jsx (src/components/crew/CrewGuard.jsx) owns a LIVE
// clock -- `useState(() => Date.now())` plus a 1s `setInterval(() => setNow(Date.now()))` for its
// countdown -- unlike anything MyMoneyRoute renders; it reads the wall clock at RENDER time, not
// just once at fixture-build time the way MM_MODEL_ACTIVE's `now: MM_NOW` param above does.
// CrewActivity.jsx (`agoText`'s keeper-activity/decision-log "x ago" text) independently calls
// `Date.now()` too. Threading a `now` prop through CrewGuard alone (as this task's brief first
// suggests) would need CrewRoute.jsx to forward it -- not in this task's file list -- and would
// still leave CrewActivity's own call unfrozen. Reusing the SAME fixture-scoped global override the
// strategy fixture already established immediately above freezes every `Date.now()` reader on the
// page (CrewGuard's tick AND CrewActivity's read) to one identical instant, with zero production
// file touched -- confirmed by reading both components in full.
if (fixture === 'crew') {
  const FIXED_NOW_MS = NOW_SECONDS * 1000
  Date.now = () => FIXED_NOW_MS
}
const TOKEN_ADDR = SOROBAN_TOKEN_ADDRESS
const BRIDGE_TOKEN_ADDR = STELLAR_USDC_SAC
// Real-shaped Stellar identities (56-char contract/account strkeys) and a real 64-hex tx hash --
// short placeholders fit at 320px regardless of whether overflow-wrap is present, which would
// leave the freeze unable to see its own regression (StrategyReceipt.test.jsx/StartStage.test.jsx's
// own header comments record this exact trap, "shipped twice").
const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_2 = 'CDCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UB'
const VAULT_ADDR = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77' // real autofarm vault
// Real-length stand-in for the CCTP TokenMessengerMinter Bridge target -- deployments/
// stellar-testnet.json only records a truncated reference ("CDNG7HXA…SLRTHP") for the real one, so
// this reuses another already-real, full 56-char contract id (the registry) purely for its LENGTH;
// never rendered as a claim about what this specific contract does.
const BRIDGE_TARGET_STANDIN = 'CAP5E2FPDAGEQ7SR55YRY4Z56GPBSTRRZJCYN2PQ6PZQHQJKYEDVM5FB'
const REAL_TX_HASH_1 = 'a1b2c3d4'.repeat(8)
const REAL_TX_HASH_2 = 'e5f6a7b8'.repeat(8)
// Real Base Sepolia allowedPool addresses (deployments/base-sepolia.json) -- genuinely deployed
// contracts, not fabricated 0x literals.
const BASE_POOL_AAVE = '0x389250872044368759D3db5C09b2706A6628d4e0'
const BASE_POOL_MOONWELL = '0x5E843A639F0555E2A6669601621befC887Bdb479'
const FUNDED_VAULT_SHARES = 500_0000000n // already-seeded vault -- first-deposit floor never applies

const disconnectedBase = Object.freeze({
  connected: false,
  healthy: null,
  mandateView: null,
  action: null,
})
const eligibleBase = Object.freeze({
  connected: true,
  healthy: true,
  mandateView: { ready: true },
  action: null,
})

function stellarAmount(units, decimals = 7) {
  return { token: TOKEN_ADDR, units, decimals }
}

// Task 12 (visual harness fixtures): Protect's background-check section (ProtectStage.jsx:366-401,
// Task 6) only renders when `plan.review?.candidates?.length > 0` -- shared across the plans below
// so both new-section states (candidates present / `review: null` entirely omitted) are frozen at
// least once. Values verbatim from the task-12 brief.
const PLAN_REVIEW_CANDIDATES = Object.freeze({
  candidates: [
    { protocol: 'Blend Capital v2', chain: 'stellar', eligible: true, reasons: [] },
    {
      protocol: 'Community pool (proxy)',
      chain: 'base',
      eligible: false,
      reasons: ['facts stale', 'no oracle circuit breaker'],
    },
  ],
})

// m-7 fix regression (Strategy Task 14 fix round 1, self-caught on re-freeze review): every plan's
// TOP-LEVEL `amount.token` below is the literal 'USDC', never a real contract address -- matching
// what production's normalizeStrategyPlan actually puts there (PlanStage.jsx never threads a real
// token through it) and StartStage.test.jsx's own established `PLAN_TWO_DEPOSITS`/`PLAN_WITH_BRIDGE`
// precedent. Only PER-AGENT `allocation`/`cap` fields use the real SOROBAN_TOKEN_ADDRESS/
// STELLAR_USDC_SAC (those genuinely reach reusePreflight.js/grant.js's addrScVal boundary).
// Fixing m-7 by copying PlanStage.jsx's `{plan.amount.token}` pattern into StartStage.jsx's bridge
// child row exposed that THIS file's own hand-built plans had it backwards: a real contract
// address at the top level rendered raw beside "aave-v3: 300" -- the exact I-4 defect shape, freshly
// reintroduced. Fixed at the source (the data), not by adding a second render-site helper.
const PLAN_ONE_DEPOSIT = Object.freeze({
  runId: 'run-8',
  planFingerprint: '0xplan8',
  amount: { token: 'USDC', units: '1000000000', decimals: 7 },
  agents: [
    {
      allocationId: 'run-8:deposit:0',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: stellarAmount('1000000000'),
      cap: stellarAmount('1000000000'),
      periodSeconds: 3600,
      expiry: NOW_SECONDS + 3600,
      destination: 'Stellar deposit',
      children: [],
    },
  ],
  truth: { agentIsolationCount: 1, stellarVenueCount: 1, baseUsesProxyVaults: false },
  review: PLAN_REVIEW_CANDIDATES,
})

// Genuinely mixed-token: the deposit agent's cap is denominated in SOROBAN_TOKEN_ADDRESS, the
// bridge agent's in the DIFFERENT STELLAR_USDC_SAC contract -- both read "USDC" to a human, but are
// distinct on-chain assets (the exact case ProtectStage.jsx's C1 fix loop exists to keep distinct).
const PLAN_WITH_BRIDGE = Object.freeze({
  runId: 'run-9',
  planFingerprint: '0xplan9',
  amount: { token: 'USDC', units: '4000000000', decimals: 7 },
  agents: [
    {
      allocationId: 'run-9:deposit:0',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: stellarAmount('1000000000'),
      cap: stellarAmount('1000000000'),
      periodSeconds: 3600,
      expiry: NOW_SECONDS + 3600,
      destination: 'Stellar deposit',
      children: [],
    },
    {
      allocationId: 'run-9:bridge:base',
      kind: 'bridge',
      hostNetworkId: 'stellar-testnet',
      allocation: { token: BRIDGE_TOKEN_ADDR, units: '3000000000', decimals: 7 },
      cap: { token: BRIDGE_TOKEN_ADDR, units: '3000000000', decimals: 7 },
      periodSeconds: 3600,
      expiry: NOW_SECONDS + 3600,
      destination: 'Base Sepolia bridge',
      children: [
        {
          allocationId: 'run-9:bridge:aave-v3',
          address: BASE_POOL_AAVE,
          proxyTarget: 'aave-v3',
          destination: 'aave-v3',
          allocation: { token: 'USDC', units: '300000000', decimals: 6 },
        },
      ],
    },
  ],
  truth: { agentIsolationCount: 2, stellarVenueCount: 1, baseUsesProxyVaults: true },
  review: PLAN_REVIEW_CANDIDATES,
})

function reviewedDepositInit(over = {}) {
  return {
    allocationId: 'run-8:deposit:0',
    kind: 0,
    token: TOKEN_ADDR,
    target: VAULT_ADDR,
    cap: { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
    periodSeconds: 3600,
    // 3 full periods ahead of NOW so maxAtRisk is distinctly 3x the per-period cap, not a
    // boundary-equal echo of it.
    expiry: NOW_SECONDS + 10800,
    signerFingerprint: '0xsig1',
    saltFingerprint: '0xsalt1',
    destinationDomain: 0,
    mintRecipient: null,
    ...over,
  }
}

function reviewedBridgeInit(over = {}) {
  return {
    allocationId: 'run-9:bridge:base',
    kind: 1,
    token: BRIDGE_TOKEN_ADDR,
    target: BRIDGE_TARGET_STANDIN,
    cap: { token: BRIDGE_TOKEN_ADDR, units: '3000000000', decimals: 7 },
    periodSeconds: 3600,
    expiry: NOW_SECONDS + 10800,
    signerFingerprint: '0xsig2',
    saltFingerprint: '0xsalt2',
    destinationDomain: 6,
    mintRecipient: BASE_POOL_AAVE,
    ...over,
  }
}

// I-1 (Strategy Task 14 fix round 1, reviewer finding): runId/planFingerprint/agentInitFingerprint
// are now overridable -- the Protect-fresh section below reviews PLAN_WITH_BRIDGE (runId 'run-9'),
// and this function's hardcoded 'run-8'/'0xplan8' defaults (matching PLAN_ONE_DEPOSIT, the other two
// Protect sections' plan) silently didn't match it. Defaults unchanged, so the reuse/rejected
// sections (still reviewing PLAN_ONE_DEPOSIT) are unaffected.
function freshDecisionRaw({
  agentInits,
  budgets,
  runId = 'run-8',
  planFingerprint = '0xplan8',
  agentInitFingerprint = '0xagentinit1',
} = {}) {
  return {
    version: 1,
    runId,
    owner: OWNER,
    planFingerprint,
    agentInitFingerprint,
    checkedAt: NOW_SECONDS,
    reviewedBudgets: budgets || [{ token: TOKEN_ADDR, units: '1000000000', decimals: 7 }],
    durationSeconds: 86400,
    reviewedAgentInits: agentInits || [reviewedDepositInit()],
    mode: 'fresh',
    confirmationCount: 1,
    grantReceiptFingerprint: null,
    allowanceExpiryProof: null,
    agents: [],
    freshReason: 'allowance-proof-missing',
  }
}

function reuseDecisionRaw() {
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
        allocationId: 'run-8:deposit:0',
        workerId: 'run-8:deposit:0',
        agentAddress: AGENT_1,
        headroom: { token: TOKEN_ADDR, units: '900000000', decimals: 7 },
        scopeExpiry: NOW_SECONDS + 7200,
        scopeFingerprint: '0xscope1',
      },
    ],
  }
}

function evt(name, data) {
  return { name, data }
}

// m-5 (Strategy Task 14 fix round 1, reviewer finding): a real settled run always accumulates a
// live event trail on its way to a receipt (worker.js/orchestrator.js fire these for every
// allocation) -- an empty `events: []` beside a fully-succeeded receipt is not a shape production
// can emit. Real event names/shapes, matching StartStage.jsx's own header citations and
// StartStage.test.jsx's `depositQueuedThenStarted`/`depositCompleted` fixtures.
function depositCompletedEvents(allocationId, agentId, queueIndex, txHash) {
  return [
    evt('worker-queued', { allocationId, agentId, queueIndex }),
    evt('worker-started', { allocationId, agentId, queueIndex }),
    evt('started', { agentId, vault: VAULT_ADDR, allocationId }),
    evt('step', { step: 'key-setup', status: 'pending', allocationId }),
    evt('step', { step: 'key-setup', status: 'done', allocationId }),
    evt('step', { step: 'swap', status: 'skipped', allocationId }),
    evt('step', { step: 'deposit', status: 'pending', allocationId }),
    evt('completed', { agentId, vault: VAULT_ADDR, txHash, gasMethod: 'relayer', allocationId }),
  ]
}

function stellarAllocation(allocationId, over = {}) {
  return {
    allocationId,
    amount: stellarAmount('1000000000'),
    networkContext: {
      executionNetwork: 'stellar-testnet',
      currentCustodyNetwork: 'stellar-testnet',
      transit: false,
    },
    executionStatus: 'succeeded',
    custody: { location: 'stellar-vault', confirmed: true, checkedAt: NOW_SECONDS },
    txHash: REAL_TX_HASH_1,
    error: null,
    evidence: { allocationId, depositTxHash: REAL_TX_HASH_1 },
    ...over,
  }
}

function receiptFor(allocations, over = {}) {
  return {
    version: 1,
    runId: 'run-8',
    planFingerprint: '0xplan8',
    permission: {
      mode: 'fresh',
      status: 'confirmed',
      confirmationCount: 1,
      txHash: REAL_TX_HASH_2,
      grantReceiptFingerprint: '0xreceiptfp',
      expiryLedger: 9001,
      agentAddresses: [AGENT_1, AGENT_2],
    },
    branches: {
      stellar: { status: 'complete', results: allocations },
      base: { status: 'not-planned', results: [] },
    },
    allocations,
    ...over,
  }
}

// --- Real-DOM autopilot: every "reviewed"/"decided" state below is internal, uncontrolled React
// state reachable only through genuine interaction -- these helpers dispatch the exact native
// events a real user produces (typing, radio/button clicks), never reach into component internals.
function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function findButton(root, name) {
  return (
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent.trim() === name) || null
  )
}

// m-1 (Strategy Task 14 fix round 1, reviewer finding): this fixture freezes Date.now() (above,
// for the strategy fixture only) so a plan's displayed Expires timestamp never drifts -- but that
// same freeze made THIS timeout math always read `elapsed === 0`, since `Date.now()` never
// advances. A stuck `drive()` would then hang forever instead of rejecting loudly per this
// function's own contract, and AutopilotSection's `.catch()` (below) would silently never fire.
// performance.now() is real wall-clock elapsed time, untouched by the Date.now() override.
function waitFor(check, { timeout = 2000, interval = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    ;(function tick() {
      const result = check()
      if (result) return resolve(result)
      if (performance.now() - start > timeout) {
        reject(new Error('strategy fixture: timed out waiting for a DOM change'))
        return
      }
      setTimeout(tick, interval)
    })()
  })
}

// async and awaited by every caller: React 18 batches the radio click's `setRisk` state update
// and commits the re-render as a microtask, not synchronously within this call -- clicking the
// submit button immediately afterward hit it while its DOM `disabled` attribute was still stale
// (canSubmit had not re-rendered yet), so the click was silently a no-op. Waiting for the button
// to actually report enabled proves the click will land on a real, current DOM state.
async function fillPlanForm(root, { amount, risk }) {
  // StrategyRoute is lazy-mounted inside the atlas.  AutopilotSection's effect runs on the
  // first commit, which can still be the Suspense fallback; wait for the actual PlanStage
  // controls before dispatching native input.  Calling setNativeValue on the fallback's null
  // field used to reject the driver, leaving plan-edit/reset in their un-driven default state.
  const amountField = await waitFor(() => {
    const field = root.querySelector('#plan-amount')
    return field && field.getClientRects().length > 0 ? field : null
  })
  setNativeValue(amountField, amount)
  const radio = await waitFor(() => {
    const candidate = Array.from(root.querySelectorAll('[role="radio"]')).find(
      (r) => r.textContent.trim() === risk && r.getClientRects().length > 0
    )
    return candidate || null
  })
  radio.click()
  const submit = await waitFor(() => {
    const btn = findButton(root, 'Build my plan')
    return btn && !btn.disabled ? btn : null
  })
  submit.click()
}

// Runs `drive(rootEl)` once against the real mounted subtree, then clears `data-fixture-pending`
// once it settles (success or failure -- a fixture-authoring mistake must never hang the
// Playwright wait forever; it is logged loudly instead). Blurs incidental focus from the driven
// interaction, while preserving Foundation Dialog's deliberate initial focus so modal captures
// retain the real keyboard-containment contract.
function AutopilotSection({ drive, children }) {
  const ref = useRef(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => drive(ref.current))
      .catch((err) => {
        if (!cancelled) setError(err?.message || String(err))
        // eslint-disable-next-line no-console
        console.error('strategy fixture autopilot failed:', err)
      })
      .finally(() => {
        if (cancelled) return
        const activeDialog = [...(ref.current?.querySelectorAll('.pc-dialog') || [])].find(
          (dialog) => dialog.getClientRects().length > 0
        )
        if (
          document.activeElement &&
          ref.current?.contains(document.activeElement) &&
          !activeDialog?.contains(document.activeElement)
        ) {
          document.activeElement.blur()
        }
        setPending(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={ref}
      data-fixture-pending={pending ? 'true' : undefined}
      data-fixture-error={error || undefined}
    >
      {children}
    </div>
  )
}

async function driveGenerating(root) {
  await fillPlanForm(root, { amount: '250', risk: 'Steady' })
  // `runGeneration` sets phase to 'generating' synchronously before awaiting the (deliberately
  // never-resolving) `generate()` call -- waiting for its real rendered heading, rather than
  // assuming the click's state update already committed, is what makes this frozen frame
  // trustworthy rather than a lucky race.
  await waitFor(() => root.textContent.includes('Building your plan'))
}

// Strategy Task 14 fix loop N -- item 3 (owner report): 100/Adventurous (3 Stellar-only deposit
// workers, no Base leg) is the exact repro the owner's own acceptance check names ("100 USDC
// deposit and 3 workers... caps display 33.33/33.33/33.34 summing to 100.00") -- this section is
// one of the two Plan review surfaces the brief points at, so it now drives that scenario instead
// of a round number (500/Balanced) that never exercised the float-precision defect at all.
async function driveSafeDefaultReady(root) {
  await fillPlanForm(root, { amount: '100', risk: 'Adventurous' })
  await waitFor(() => findButton(root, 'Accept plan'))
}

// Strategy Task 14 fix loop N -- item 7 (owner report): this used to click exactly the FIRST
// `.pc-technical-details summary` UNCONDITIONALLY as part of just reaching "ready", leaving one
// worker's instructions expanded and the others collapsed as an accidental byproduct -- an
// inconsistent expand state introduced by this fixture's own driver, not by PlanStage.jsx
// (TechnicalDetails already defaults every disclosure to closed, uniformly, with no extra code --
// see PlanStage.jsx's own `<TechnicalDetails summary={...}>` call, no `open` prop, and
// PlanStage.test.jsx's own "every worker instructions disclosure loads collapsed" jsdom test, which
// proves this independently of anything this fixture does). Judgement call (owner-requested):
// all-collapsed is the consistent LOAD-TIME default across every worker, matching
// TechnicalDetails' own default and the contract's own "technical data in disclosures" principle.
//
// Fix round 1 -- I-3 (reviewer finding): removing that click entirely left the item-2 textarea fix
// (contrast/geometry of `.pc-instruction-input`) with ZERO pixel coverage across all 12 frozen
// baselines -- a future regression there would be invisible to the pixel gate. This does NOT
// reopen item 7: the click below happens only in THIS ONE section, after the ready state already
// exists, and represents a real, reachable, deliberate "a user expanded the first worker's
// instructions to review them" interaction -- not a load-time default. The other Plan review
// section (`driveSafeDefaultReady`) is left with its real all-collapsed default untouched, so both
// the default state (there) and the expanded state (here) are each covered by exactly one frozen
// baseline.
async function driveMixedReady(root) {
  await fillPlanForm(root, { amount: '1000', risk: 'Adventurous' })
  await waitFor(() => findButton(root, 'Accept plan'))
  root.querySelector('.pc-technical-details summary')?.click()
}

async function driveProtectFresh(root) {
  findButton(root, 'Check my permission').click()
  await waitFor(() => findButton(root, 'Authorize with wallet'))
  // Reveal the long token/target/signer identifiers (the "long address/technical details" state).
  root.querySelectorAll('.pc-technical-details summary').forEach((s) => s.click())
}

async function driveProtectReuse(root) {
  findButton(root, 'Check my permission').click()
  await waitFor(() => findButton(root, 'Continue'))
}

async function driveProtectRejected(root) {
  findButton(root, 'Check my permission').click()
  await waitFor(() => findButton(root, 'Authorize with wallet')).then((b) => b.click())
  await waitFor(() => findButton(root, 'Retry'))
}

const START_QUEUED_PARTIAL_EVENTS = [
  evt('worker-queued', { allocationId: 'run-9:deposit:0', agentId: AGENT_1, queueIndex: 0 }),
  evt('worker-queued', { allocationId: 'run-9-b:deposit:1', agentId: AGENT_2, queueIndex: 1 }),
  evt('worker-started', { allocationId: 'run-9-b:deposit:1', agentId: AGENT_2, queueIndex: 1 }),
  evt('started', { agentId: AGENT_2, vault: VAULT_ADDR, allocationId: 'run-9-b:deposit:1' }),
  evt('step', { step: 'deposit', status: 'pending', allocationId: 'run-9-b:deposit:1' }),
  evt('failed', {
    agentId: AGENT_2,
    vault: VAULT_ADDR,
    error: 'The Stellar relay returned FAILED.',
    allocationId: 'run-9-b:deposit:1',
  }),
  // Bridge lane: mid-flight (burned on Stellar, attestation not back yet) -- live "in transit".
  evt('farm-burn-started', { address: OWNER, amountUnits: '3000000000' }),
  evt('farm-burn-confirmed', { burnHash: REAL_TX_HASH_1 }),
]

const PLAN_START_LIVE = Object.freeze({
  runId: 'run-9',
  planFingerprint: '0xplan9live',
  amount: { token: 'USDC', units: '4000000000', decimals: 7 },
  agents: [
    { ...PLAN_ONE_DEPOSIT.agents[0], allocationId: 'run-9:deposit:0' },
    { ...PLAN_ONE_DEPOSIT.agents[0], allocationId: 'run-9-b:deposit:1' },
    { ...PLAN_WITH_BRIDGE.agents[1] },
  ],
  truth: { agentIsolationCount: 3, stellarVenueCount: 1, baseUsesProxyVaults: true },
})

const RECEIPT_ALL_SUCCESS = receiptFor([
  stellarAllocation('run-8:deposit:0'),
  stellarAllocation('run-8:deposit:1', { txHash: REAL_TX_HASH_2, evidence: {} }),
])

// Richest receipt state: two token groups (Stellar deposit + Base bridge), all four reconciliation
// buckets (deposited/inTransit/held/unmoved) represented at once. The PLAN below mirrors this
// receipt's allocations 1:1 (dispatchSummary.js's buildDispatchReceipt always derives
// receipt.allocations FROM plan.agents/children, so a receipt entry with no matching plan agent is
// not a shape production can emit -- PLAN_MIXED_RECEIPT exists so this fixture never invents one).
const PLAN_MIXED_RECEIPT = Object.freeze({
  runId: 'run-9',
  planFingerprint: '0xplan9mixed',
  amount: { token: 'USDC', units: '1850000000', decimals: 7 },
  agents: [
    {
      allocationId: 'run-9:deposit:0',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: stellarAmount('1000000000'),
      cap: stellarAmount('1000000000'),
      periodSeconds: 3600,
      expiry: NOW_SECONDS + 3600,
      destination: 'Stellar deposit',
      children: [],
    },
    {
      allocationId: 'run-9:deposit:extra',
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: stellarAmount('400000000'),
      cap: stellarAmount('400000000'),
      periodSeconds: 3600,
      expiry: NOW_SECONDS + 3600,
      destination: 'Stellar deposit',
      children: [],
    },
    {
      allocationId: 'run-9:bridge:base',
      kind: 'bridge',
      hostNetworkId: 'stellar-testnet',
      allocation: { token: BRIDGE_TOKEN_ADDR, units: '450000000', decimals: 7 },
      cap: { token: BRIDGE_TOKEN_ADDR, units: '450000000', decimals: 7 },
      periodSeconds: 3600,
      expiry: NOW_SECONDS + 3600,
      destination: 'Base Sepolia bridge',
      children: [
        {
          allocationId: 'run-9:bridge:aave-v3',
          address: BASE_POOL_AAVE,
          proxyTarget: 'aave-v3',
          destination: 'aave-v3',
          allocation: { token: 'USDC', units: '300000000', decimals: 6 },
        },
        {
          allocationId: 'run-9:bridge:moonwell',
          address: BASE_POOL_MOONWELL,
          proxyTarget: 'moonwell',
          destination: 'moonwell',
          allocation: { token: 'USDC', units: '150000000', decimals: 6 },
        },
      ],
    },
  ],
  truth: { agentIsolationCount: 3, stellarVenueCount: 1, baseUsesProxyVaults: true },
})

const RECEIPT_MIXED_PARTIAL = receiptFor(
  [
    stellarAllocation('run-9:deposit:0', {
      amount: stellarAmount('1000000000'),
      executionStatus: 'succeeded',
    }),
    stellarAllocation('run-9:deposit:extra', {
      amount: stellarAmount('400000000'),
      executionStatus: 'failed',
      custody: { location: 'unknown', confirmed: false, checkedAt: null },
      txHash: null,
      error: 'The Stellar relay returned FAILED.',
    }),
    {
      allocationId: 'run-9:bridge:aave-v3',
      amount: { token: BRIDGE_TOKEN_ADDR, units: '300000000', decimals: 6 },
      networkContext: {
        executionNetwork: 'stellar-testnet',
        destinationNetwork: 'base-sepolia',
        currentCustodyNetwork: null,
        transit: true,
      },
      executionStatus: 'pending',
      custody: { location: 'in-transit', confirmed: false, checkedAt: NOW_SECONDS },
      txHash: null,
      error: null,
      evidence: {},
    },
    {
      allocationId: 'run-9:bridge:moonwell',
      amount: { token: BRIDGE_TOKEN_ADDR, units: '150000000', decimals: 6 },
      networkContext: {
        executionNetwork: 'stellar-testnet',
        destinationNetwork: 'base-sepolia',
        currentCustodyNetwork: 'stellar-testnet',
        transit: false,
      },
      executionStatus: 'failed',
      custody: { location: 'agent', confirmed: true, checkedAt: NOW_SECONDS },
      txHash: null,
      error: 'Base leg failed.',
      evidence: {},
    },
  ],
  { runId: 'run-9' }
)

async function driveOpenTechnicalDetails(root) {
  root.querySelectorAll('.pc-technical-details summary').forEach((s) => s.click())
}

// MM14 fix round 1 (M-3, reviewer finding): `ariaHidden`, harness-only, default false (Strategy's
// own ten Section-wrapped StrategyRoute mounts are unaffected). MyMoneyFixture below mounts the
// SAME real MyMoneyRoute four times on one page for four different data states -- unlike Strategy's
// per-stage mounts (each renders a DIFFERENT, mutually-exclusive stage with its own distinct
// heading), MyMoneyRoute always renders its full, fixed-id heading structure regardless of state, so
// four mounts on one page means four literal copies of the same seven ids (`my-money-hero-heading`,
// `your-position-heading`, etc.) and four `<h1>My money</h1>`s -- every `aria-labelledby` in
// sections 2-4 silently resolves to section 1's own heading (browsers resolve an id reference to
// the FIRST matching element in the document), which would give a false-clean result to any future
// a11y test importing this fixture (none does today; `MyMoneyFixture` is not currently exported,
// unlike `FoundationAtlasFixture`). Marking sections 2-4 `aria-hidden="true"` removes their whole subtree
// from the accessibility tree (and from testing-library's default `hidden:false` role queries and
// axe's scan) without touching pixels -- `aria-hidden` has no effect on CSS layout/paint, so this
// changes zero frozen bytes -- leaving section 1's copy as the one, unambiguous, fully-exposed
// accessible instance. The raw duplicate `id`/`<h1>` attributes still exist in the DOM (this is a
// harness page, never shipped), but no accessibility-tree consumer can reach them anymore.
function Section({ title, children, ariaHidden = false }) {
  return (
    <section
      aria-labelledby={`strategy-${title.replace(/\s+/g, '-').toLowerCase()}`}
      aria-hidden={ariaHidden ? 'true' : undefined}
    >
      <h2 id={`strategy-${title.replace(/\s+/g, '-').toLowerCase()}`}>{title}</h2>
      {children}
    </section>
  )
}

// -------------------------------------------------------------------------------------------
// Core Task 11 atlas branches.  The builders below are the only source of deterministic route
// data.  These wrappers own composition and fixture lifecycle only; they do not recreate money,
// identity, permission, custody, or withdrawal state.  Every mounted route is the same production
// component used by the app, with source-shaped props supplied by visual/coreFixtures.js.
const CORE_BUILDERS = Object.freeze({
  'core-money': buildCoreMoneyFixture,
  'core-strategy': buildCoreStrategyFixture,
  'core-crew': buildCoreCrewFixture,
  'core-settings': buildCoreSettingsFixture,
  'core-dialog': buildCoreDialogFixture,
  'core-base-withdraw': buildCoreBaseWithdrawFixture,
})

if (CORE_FIXTURE_CLASSES.some((id) => typeof CORE_BUILDERS[id] !== 'function')) {
  throw new Error('Core visual atlas is missing a fixture builder')
}

function CoreAtlasSection({ title, state, children, ariaHidden = false, hidden = false }) {
  return (
    <section
      className="pc-core-atlas-section"
      aria-labelledby={`core-${state}-heading`}
      aria-hidden={ariaHidden ? 'true' : undefined}
      hidden={hidden ? true : undefined}
      data-core-state={state}
    >
      <header>
        <h2 id={`core-${state}-heading`}>{title}</h2>
      </header>
      {children}
    </section>
  )
}

function coreAtlas(id, builder) {
  return CORE_FIXTURE_STATES[id].map((state) => builder(state))
}

// A Core page contains the complete source-state atlas, but only the requested state is exposed
// to the browser.  Keeping selection in the URL makes every state a real, directly addressable
// route fixture (and lets the Playwright functional sweeps exercise the same source seam that the
// screenshot cell will capture) without fabricating a second state model in this harness.
function coreActiveState(id, fallback) {
  const requested = params.get('state')
  return CORE_FIXTURE_STATES[id].includes(requested) ? requested : fallback
}

function CoreFixtureLoader({ fixtureId, build, children, allowFixtureStorage = false }) {
  const [ready, setReady] = useState(false)
  const fixturesRef = useRef(null)
  if (!fixturesRef.current) fixturesRef.current = build()

  useEffect(() => {
    let cancelled = false
    let release
    const hold = new Promise((resolve) => {
      release = resolve
    })
    let restoreFixtureStorage
    void withCoreFixtureEnvironment(async () => {
      // SettingsPage is a real route consumer of localStorage/sessionStorage.  Keep the
      // fixture's network/storage guard in force for every other branch, but give this one route
      // the already-defined in-memory adapter so its source code can render without touching a
      // browser-persistent store.  This is still offline fixture state, never production storage.
      if (allowFixtureStorage) restoreFixtureStorage = installCoreMemoryStorage()
      if (!cancelled) setReady(true)
      await hold
    }).catch((error) => {
      if (!cancelled) {
        // eslint-disable-next-line no-console
        console.error(`${fixtureId} fixture environment failed:`, error)
        setReady(true)
      }
    })
    return () => {
      cancelled = true
      release?.()
      restoreFixtureStorage?.()
    }
  }, [allowFixtureStorage, fixtureId])

  return (
    <main
      data-fixture={fixtureId}
      data-fixture-pending={!ready ? 'true' : undefined}
      data-fixture-clock={CORE_FIXTURE_CLOCK.nowIso}
    >
      {ready ? children(fixturesRef.current) : null}
    </main>
  )
}

function CoreMoneyRoute({ fixture, onRecoverAgent, onRecoverBase }) {
  const props = fixture.createProps()
  return (
    <MyMoneyRoute
      {...props}
      onAction={() => {}}
      onRecoverAgent={onRecoverAgent || (() => {})}
      onRecoverBase={onRecoverBase || (() => {})}
      venue={props.venue}
    />
  )
}

function CoreMoneyFixture() {
  const fixtures = coreAtlas('core-money', buildCoreMoneyFixture)
  return (
    <CoreFixtureLoader fixtureId="core-money" build={() => fixtures}>
      {(states) =>
        states.map((fixture, index) => (
          <CoreAtlasSection
            key={fixture.state}
            state={fixture.state}
            title={`My money: ${fixture.state}`}
            ariaHidden={index > 0}
          >
            <CoreMoneyRoute fixture={fixture} />
          </CoreAtlasSection>
        ))
      }
    </CoreFixtureLoader>
  )
}

function CoreStrategyRoute({ fixture }) {
  // Invoke the fixture's source-shaped closure at the direct route mount boundary.  The fixture
  // owns all state, callbacks, and identity/custody values; this harness must not reconstruct or
  // serialize a second model around the production route.
  const props = fixture.createProps()
  return (
    <StrategyRoute {...props} vaultTotalShares={props.vaultTotalShares ?? FUNDED_VAULT_SHARES} />
  )
}

async function driveCoreStrategyProtection(root, state) {
  const check = findButton(root, 'Check my permission')
  if (!check) throw new Error(`core strategy ${state}: missing permission check action`)
  check.click()
  if (state === 'permission-rejected') {
    const authorize = await waitFor(() => findButton(root, 'Authorize with wallet'))
    authorize.click()
    await waitFor(() => findButton(root, 'Retry'))
    return
  }
  if (state === 'permission-reuse-verified') {
    await waitFor(() => findButton(root, 'Continue'))
    return
  }
  if (state === 'permission-reuse-unavailable') {
    await waitFor(() => findButton(root, 'Check again'))
    return
  }
  await waitFor(() => findButton(root, 'Authorize with wallet'))
}

function CoreStrategyFixture() {
  const fixtures = coreAtlas('core-strategy', buildCoreStrategyFixture)
  return (
    <CoreFixtureLoader fixtureId="core-strategy" build={() => fixtures}>
      {(states) =>
        states.map((fixture, index) => (
          <CoreAtlasSection
            key={fixture.state}
            state={fixture.state}
            title={`Put it to work: ${fixture.state}`}
            ariaHidden={index > 0}
          >
            {fixture.stage === 'protect' ? (
              <AutopilotSection drive={(root) => driveCoreStrategyProtection(root, fixture.state)}>
                <CoreStrategyRoute fixture={fixture} />
              </AutopilotSection>
            ) : (
              <CoreStrategyRoute fixture={fixture} />
            )}
          </CoreAtlasSection>
        ))
      }
    </CoreFixtureLoader>
  )
}

function CoreCrewFixture() {
  const fixtures = coreAtlas('core-crew', buildCoreCrewFixture)
  return (
    <CoreFixtureLoader fixtureId="core-crew" build={() => fixtures}>
      {(states) =>
        states.map((fixture, index) => (
          <CoreAtlasSection
            key={fixture.state}
            state={fixture.state}
            title={`The crew: ${fixture.state}`}
            ariaHidden={index > 0}
          >
            <Suspense fallback={<div data-fixture-pending="true" />}>
              <CrewRoute
                {...fixture.createProps()}
                onRenewMandate={() => {}}
                onCancelAgent={() => {}}
              />
            </Suspense>
          </CoreAtlasSection>
        ))
      }
    </CoreFixtureLoader>
  )
}

function installCoreMemoryStorage() {
  if (typeof window === 'undefined') return () => {}
  const makeStorage = () => {
    const memory = new Map()
    return {
      get length() {
        return memory.size
      },
      clear: () => memory.clear(),
      getItem: (key) => (memory.has(String(key)) ? memory.get(String(key)) : null),
      key: (index) => [...memory.keys()][index] ?? null,
      removeItem: (key) => memory.delete(String(key)),
      setItem: (key, value) => memory.set(String(key), String(value)),
    }
  }
  const storages = [
    ['localStorage', makeStorage()],
    ['sessionStorage', makeStorage()],
  ]
  const descriptors = storages.map(([key]) => [key, Object.getOwnPropertyDescriptor(window, key)])
  try {
    for (const [key, storage] of storages) {
      Object.defineProperty(window, key, { configurable: true, value: storage })
    }
  } catch {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(window, key, descriptor)
      else delete window[key]
    }
    return () => {}
  }
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(window, key, descriptor)
      else delete window[key]
    }
  }
}

const coreSettingsNoop = () => {}

function CoreSettingsRoute({ fixture }) {
  const props = fixture.createProps()
  // SettingsPage's production parent normally supplies these callbacks from app state.  The
  // fixture intentionally leaves them undefined because no write/network behavior belongs in a
  // visual atlas.  Supplying inert handlers at this composition boundary keeps every source
  // control keyboard/click reachable while preserving the fixture's read-only mandate view.
  return (
    <SettingsPageRoute
      {...props}
      setAgentEnabled={props.setAgentEnabled || coreSettingsNoop}
      setAgentSettings={props.setAgentSettings || coreSettingsNoop}
      onLanguageChange={props.onLanguageChange || coreSettingsNoop}
      onChangeSkill={props.onChangeSkill || coreSettingsNoop}
      onResetSkill={props.onResetSkill || coreSettingsNoop}
      onResetAgentSettings={props.onResetAgentSettings || coreSettingsNoop}
      onConnect={props.onConnect || coreSettingsNoop}
      onDisconnect={props.onDisconnect || coreSettingsNoop}
      onRevoke={props.onRevoke || coreSettingsNoop}
      addLog={props.addLog || coreSettingsNoop}
      onSetup={props.onSetup || coreSettingsNoop}
      onRenew={props.onRenew || coreSettingsNoop}
      onBaseRevoke={props.onBaseRevoke || coreSettingsNoop}
      onRefresh={props.onRefresh || coreSettingsNoop}
    />
  )
}

function CoreSettingsFixture() {
  const fixtures = coreAtlas('core-settings', buildCoreSettingsFixture)
  const activeState = coreActiveState('core-settings', 'wallet')
  useEffect(() => {
    // This is a fixture-only deep-link, never a production route.  SettingsPage reads its normal
    // pathname/query/hash contract during render, so seed it before the lazy route mounts.
    const previous = window.history.state
    const urlParams = new URLSearchParams(window.location.search)
    const currentTheme = urlParams.get('theme') || 'forest'
    const tab = activeState === 'default' ? 'agent' : 'wallet'
    const hash = tab === 'wallet' ? '#base-mandate' : ''
    window.history.replaceState(
      previous,
      '',
      `/visual/?fixture=core-settings&theme=${encodeURIComponent(currentTheme)}&state=${encodeURIComponent(activeState)}&tab=${tab}${hash}`
    )
    return undefined
  }, [activeState])
  return (
    <CoreFixtureLoader fixtureId="core-settings" build={() => fixtures} allowFixtureStorage>
      {(states) =>
        states.map((fixture) => {
          const active = fixture.state === activeState
          return (
            <CoreAtlasSection
              key={fixture.state}
              state={fixture.state}
              title={`Settings: ${fixture.state}`}
              ariaHidden={!active}
              hidden={!active}
            >
              {active ? (
                <Suspense fallback={<div data-fixture-pending="true" />}>
                  <CoreSettingsRoute fixture={fixture} />
                </Suspense>
              ) : null}
            </CoreAtlasSection>
          )
        })
      }
    </CoreFixtureLoader>
  )
}

function coreStrategyGenerationFromPlan(plan) {
  const depositUnits = plan.agents
    .filter((agent) => agent.kind === 'deposit')
    .reduce((total, agent) => total + BigInt(agent.allocation.units), 0n)
  const baseAllocations = plan.agents
    .filter((agent) => agent.kind === 'bridge')
    .flatMap((agent) =>
      (agent.children || []).map((child) => ({
        address: child.address,
        proxyTarget: child.proxyTarget || child.destination,
        units: child.allocation.units,
        chain: 'base',
      }))
    )
  return {
    source: 'fallback',
    sourceState: 'deterministic',
    stellarUnits: depositUnits.toString(),
    baseAllocations,
  }
}

async function driveCorePlanRevision(root, state) {
  await fillPlanForm(root, { amount: '250', risk: 'Steady' })
  await waitFor(() => findButton(root, 'Accept plan'))
  const menu = await waitFor(() => {
    const details = root.querySelector('.pc-plan-change-menu')
    const summary = details?.querySelector('summary')
    return details && summary && summary.getClientRects().length > 0 ? details : null
  })
  menu.querySelector('summary').click()
  const action = state === 'plan-reset' ? 'Reset plan' : 'Change amount'
  const actionButton = await waitFor(() => {
    const button = [...menu.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent.trim() === action && candidate.getClientRects().length > 0
    )
    return button || null
  })
  actionButton.click()
  await waitFor(() => {
    const dialog = root.querySelector('.pc-dialog, dialog, [role="dialog"]')
    return dialog && dialog.getClientRects().length > 0 ? dialog : null
  })
}

async function driveCoreSettingsClear(root) {
  const clear = await waitFor(() => findButton(root, 'Clear all data'))
  clear.click()
  await waitFor(() => root.querySelector('.pc-dialog, dialog, [role="dialog"]'))
}

function CoreDialogCaller({
  dialogFixture,
  moneyFixture,
  strategyFixture,
  settingsFixture,
  active = false,
}) {
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const dialogProps = dialogFixture.createProps()
  const { caller, status } = dialogProps.dialog
  const moneyProps = moneyFixture.createProps()
  const strategyProps = strategyFixture.createProps()
  const recoveryTarget = moneyProps.agents.find((agent) => agent.problems?.length) || null
  const pending = status === 'submitting'

  if (status === 'unknown') {
    return (
      <>
        <CoreMoneyRoute fixture={moneyFixture} />
        <RecoveryPanelRoute
          open={active}
          onClose={() => {}}
          location="base-proxy"
          amount={recoveryTarget?.amount}
          agentAddress={recoveryTarget?.address}
          submission={{ outcome: 'unknown' }}
          onCheckStatus={() => {}}
        />
      </>
    )
  }

  if (caller === 'plan-edit' || caller === 'plan-reset' || caller === 'Strategy Plan') {
    return (
      <StrategyRoute
        {...strategyProps}
        // CAP-16's source caller reads the already-seeded vault before allowing a reviewed plan
        // to be revised.  The Core strategy fixture intentionally keeps that live read behind its
        // closure; this dialog-only atlas seam uses the existing deterministic seeded-vault value
        // so the real PlanStage validation can reach the genuine Change mind?/Reset plan dialog.
        vaultTotalShares={strategyProps.vaultTotalShares ?? FUNDED_VAULT_SHARES}
        stage="plan"
        reached={['plan']}
        onGenerate={async () => coreStrategyGenerationFromPlan(strategyProps.plan)}
      />
    )
  }

  if (
    caller === 'withdraw' ||
    caller === 'My Money Withdraw' ||
    ['invalid', 'submitting', 'confirmed', 'failed'].includes(status)
  ) {
    return (
      <>
        <CoreMoneyRoute fixture={moneyFixture} />
        <WithdrawDialogRoute
          open={active}
          onClose={() => {}}
          agents={moneyProps.agents}
          discovery={moneyProps.discovery}
          account={moneyProps.account}
          pending={pending}
          progress={pending ? { index: 0, total: moneyProps.agents.length || 1 } : null}
          onConfirmFull={() => {}}
          onConfirmPartial={() => {}}
          onConfirmBase={() => {}}
        />
      </>
    )
  }

  if (caller === 'stop-access' || caller === 'Stop access') {
    return (
      <>
        <CoreMoneyRoute fixture={moneyFixture} />
        <StopAccessDialogRoute
          open={active}
          onClose={() => {}}
          agent={recoveryTarget}
          shareRead={recoveryTarget?.vaultShares}
          idleBalanceRead={recoveryTarget?.idleToken}
          account={moneyProps.account}
          pending={pending}
          onConfirmRevoke={() => {}}
          onGoToWithdraw={() => {}}
        />
      </>
    )
  }

  if (caller === 'recovery' || caller === 'Recovery') {
    return (
      <>
        <CoreMoneyRoute fixture={moneyFixture} onRecoverAgent={() => setRecoveryOpen(true)} />
        <RecoveryPanelRoute
          open={active && recoveryOpen}
          onClose={() => setRecoveryOpen(false)}
          location="agent"
          amount={recoveryTarget?.amount}
          agentAddress={recoveryTarget?.address}
          onRecoverViaFullExit={() => {}}
        />
      </>
    )
  }

  if (caller === 'Settings clear') {
    return <CoreSettingsRoute fixture={settingsFixture} />
  }

  return <CoreMoneyRoute fixture={moneyFixture} data-core-dialog-status={status} />
}

function CoreDialogFixture() {
  const dialogFixtures = coreAtlas('core-dialog', buildCoreDialogFixture)
  const activeState = coreActiveState('core-dialog', 'plan-edit')
  const moneyFixture = buildCoreMoneyFixture('problem')
  const strategyFixture = buildCoreStrategyFixture('plan')
  const settingsFixture = buildCoreSettingsFixture('default')
  useEffect(() => {
    // Settings clear is the one dialog caller whose production surface is a deep-linked Settings
    // route. Seed its normal tab contract before the lazy page evaluates; other callers do not
    // read this location and remain on their source route composition.
    const previous = window.history.state
    const urlParams = new URLSearchParams(window.location.search)
    const currentTheme = urlParams.get('theme') || 'forest'
    const tab = activeState === 'settings-clear' ? 'data' : 'wallet'
    const hash = tab === 'wallet' ? '#base-mandate' : ''
    window.history.replaceState(
      previous,
      '',
      `/visual/?fixture=core-dialog&theme=${encodeURIComponent(currentTheme)}&state=${encodeURIComponent(activeState)}&tab=${tab}${hash}`
    )
    return undefined
  }, [activeState])
  return (
    <CoreFixtureLoader
      fixtureId="core-dialog"
      build={() => ({ dialogFixtures, moneyFixture, strategyFixture, settingsFixture })}
      allowFixtureStorage
    >
      {({
        dialogFixtures: states,
        moneyFixture: currentMoney,
        strategyFixture: currentStrategy,
        settingsFixture: currentSettings,
      }) =>
        states.map((fixture) => {
          const { dialog } = fixture.createProps()
          const active = fixture.state === activeState
          const activeRecovery = active && fixture.state === 'recovery'
          const activePlanRevision = active && ['plan-edit', 'plan-reset'].includes(fixture.state)
          const activeSettingsClear = active && fixture.state === 'settings-clear'
          return (
            <CoreAtlasSection
              key={fixture.state}
              state={fixture.state}
              title={`Dialog: ${dialog.caller}`}
              ariaHidden={!active}
              hidden={!active}
            >
              {active ? (
                activeRecovery || activePlanRevision || activeSettingsClear ? (
                  <AutopilotSection
                    drive={(root) =>
                      activeRecovery
                        ? driveOpenRecoveryDialog(root)
                        : activePlanRevision
                          ? driveCorePlanRevision(root, fixture.state)
                          : driveCoreSettingsClear(root)
                    }
                  >
                    <Suspense fallback={<div data-fixture-pending="true" />}>
                      <CoreDialogCaller
                        dialogFixture={fixture}
                        moneyFixture={currentMoney}
                        strategyFixture={currentStrategy}
                        settingsFixture={currentSettings}
                        active
                      />
                    </Suspense>
                  </AutopilotSection>
                ) : (
                  <Suspense fallback={<div data-fixture-pending="true" />}>
                    <CoreDialogCaller
                      dialogFixture={fixture}
                      moneyFixture={currentMoney}
                      strategyFixture={currentStrategy}
                      settingsFixture={currentSettings}
                      active
                    />
                  </Suspense>
                )
              ) : null}
            </CoreAtlasSection>
          )
        })
      }
    </CoreFixtureLoader>
  )
}

function CoreBaseWithdrawRoute({ fixture }) {
  const props = fixture.createProps()
  return (
    <>
      <h1 className="pc-route-title">Base withdrawal</h1>
      <Suspense fallback={<div data-fixture-pending="true" />}>
        <WithdrawRoute
          {...props}
          // Withdraw keeps production's disabled-by-default behavior when this prop is omitted.
          // The route seam owns the optional flag; the fixture supplies real deterministic
          // adapters and this harness only opts into their already-reviewed Base surface.
          baseCrossChainAvailable
          onDone={() => {}}
          onClose={() => {}}
        />
      </Suspense>
    </>
  )
}

async function driveCoreBaseWithdraw(root, state) {
  if (state === 'idle') return
  const primary = await waitFor(() => {
    const button = findButton(root, 'Withdraw all')
    return button && !button.disabled ? button : null
  })
  primary.click()
  const expected = {
    submitting: 'Confirm the passkey prompt to sign the unwind.',
    relaying: 'Handing the transaction to the relayer.',
    polling: 'Bridging USDC back to Stellar via CCTP.',
    confirmed: 'Receipt and reconciliation confirm the Base unwind.',
    failed: 'Withdraw failed. Please try again.',
    'submission-unknown': 'may have been submitted',
    'in-transit': 'Still settling. The relayer is finishing the bridge.',
  }[state]
  if (!expected) throw new Error(`core base withdraw ${state}: missing expected state copy`)
  await waitFor(() => root.textContent.includes(expected))
}

function CoreBaseWithdrawFixture() {
  const fixtures = coreAtlas('core-base-withdraw', buildCoreBaseWithdrawFixture)
  const activeState = coreActiveState('core-base-withdraw', 'idle')
  return (
    <CoreFixtureLoader fixtureId="core-base-withdraw" build={() => fixtures} allowFixtureStorage>
      {(states) =>
        states.map((fixture) => {
          const active = fixture.state === activeState
          return (
            <CoreAtlasSection
              key={fixture.state}
              state={fixture.state}
              title={`Base withdrawal: ${fixture.state}`}
              ariaHidden={!active}
              hidden={!active}
            >
              {active ? (
                <AutopilotSection drive={(root) => driveCoreBaseWithdraw(root, fixture.state)}>
                  <CoreBaseWithdrawRoute fixture={fixture} />
                </AutopilotSection>
              ) : null}
            </CoreAtlasSection>
          )
        })
      }
    </CoreFixtureLoader>
  )
}

function StrategyFixture() {
  // I-3 (Strategy Task 14 fix round 1, reviewer ruling): no outer padding here, scoped to THIS
  // fixture only. FoundationAtlasFixture owns its own shell and remains independent of this
  // route fixture. Every
  // section already wraps its content in a real `StrategyRoute` (`.pc-route`, its own
  // `--pc-route-gutter`) -- this harness's own extra 24px of padding sat OUTSIDE that, so the
  // `mobile-320` project was freezing a 272px route / 240px stack, not the 320px viewport its own
  // name promises. A project named `mobile-320` must test 320.
  return (
    <main data-fixture="strategy" style={{ display: 'grid', gap: '2.5rem' }}>
      <h1>Pocket Crew visual harness — Strategy</h1>

      <Section title="Plan — input">
        <StrategyRoute
          stage="plan"
          reached={['plan']}
          vaultTotalShares={FUNDED_VAULT_SHARES}
          base={disconnectedBase}
          onGenerate={() => new Promise(() => {})}
        />
      </Section>

      <Section title="Plan — safe-default generating">
        <AutopilotSection drive={driveGenerating}>
          <StrategyRoute
            stage="plan"
            reached={['plan']}
            vaultTotalShares={FUNDED_VAULT_SHARES}
            base={disconnectedBase}
            onGenerate={() => new Promise(() => {})}
          />
        </AutopilotSection>
      </Section>

      <Section title="Plan — safe-default review">
        <AutopilotSection drive={driveSafeDefaultReady}>
          <StrategyRoute
            stage="plan"
            reached={['plan']}
            vaultTotalShares={FUNDED_VAULT_SHARES}
            base={disconnectedBase}
            onGenerate={async () => ({
              source: 'fallback',
              sourceState: 'deterministic',
              // 100 USDC at 7dp, matching driveSafeDefaultReady's typed '100' -- PlanStage's own
              // C2 reconciliation check fails closed (phase 'error') if this doesn't match what
              // was typed.
              stellarUnits: '1000000000',
              baseAllocations: [],
            })}
          />
        </AutopilotSection>
      </Section>

      <Section title="Plan — mixed Stellar/Base truth review">
        <AutopilotSection drive={driveMixedReady}>
          <StrategyRoute
            stage="plan"
            reached={['plan']}
            vaultTotalShares={FUNDED_VAULT_SHARES}
            base={eligibleBase}
            onGenerate={async () => ({
              source: 'deepseek',
              sourceState: 'live-ai',
              stellarUnits: '7000000000',
              baseAllocations: [
                {
                  address: BASE_POOL_AAVE,
                  proxyTarget: 'aave-v3',
                  units: '200000000',
                  chain: 'base',
                },
                {
                  address: BASE_POOL_MOONWELL,
                  proxyTarget: 'moonwell',
                  units: '100000000',
                  chain: 'base',
                },
              ],
            })}
          />
        </AutopilotSection>
      </Section>

      <Section title="Protect — fresh grant, mixed-token">
        <AutopilotSection drive={driveProtectFresh}>
          <StrategyRoute
            stage="protect"
            reached={['plan', 'protect']}
            plan={PLAN_WITH_BRIDGE}
            protectProps={{
              owner: OWNER,
              onConnectWallet: () => Promise.resolve(OWNER),
              onRetryPreflight: () =>
                Promise.resolve(
                  freshDecisionRaw({
                    // I-1 (fix round 1): PLAN_WITH_BRIDGE's deposit agent is 'run-9:deposit:0'
                    // (main.jsx's PLAN_WITH_BRIDGE, above) -- reviewedDepositInit()'s default
                    // 'run-8:deposit:0' matched nothing, so ProtectStage.jsx's `reviewed` lookup
                    // (by allocationId) found no reviewed init for the deposit lane and rendered
                    // mark+badge only, no cap/period/expiry/disclosure.
                    runId: 'run-9',
                    planFingerprint: '0xplan9',
                    agentInitFingerprint: '0xagentinit9',
                    agentInits: [
                      reviewedDepositInit({ allocationId: 'run-9:deposit:0' }),
                      reviewedBridgeInit(),
                    ],
                    budgets: [
                      { token: TOKEN_ADDR, units: '1000000000', decimals: 7 },
                      { token: BRIDGE_TOKEN_ADDR, units: '3000000000', decimals: 7 },
                    ],
                  })
                ),
              onRequestGrant: () => Promise.resolve({ agentAddresses: [AGENT_1, AGENT_2] }),
              onConfirmReuse: () => Promise.resolve({ agentAddresses: [AGENT_1, AGENT_2] }),
              onEditPlan: () => {},
            }}
          />
        </AutopilotSection>
      </Section>

      <Section title="Protect — reuse (zero signatures)">
        <AutopilotSection drive={driveProtectReuse}>
          <StrategyRoute
            stage="protect"
            reached={['plan', 'protect']}
            plan={PLAN_ONE_DEPOSIT}
            protectProps={{
              owner: OWNER,
              onConnectWallet: () => Promise.resolve(OWNER),
              onRetryPreflight: () => Promise.resolve(reuseDecisionRaw()),
              onRequestGrant: () => Promise.resolve({ agentAddresses: [AGENT_1] }),
              onConfirmReuse: () => Promise.resolve({ agentAddresses: [AGENT_1] }),
              onEditPlan: () => {},
            }}
          />
        </AutopilotSection>
      </Section>

      <Section title="Protect — rejected (wallet declined)">
        <AutopilotSection drive={driveProtectRejected}>
          <StrategyRoute
            stage="protect"
            reached={['plan', 'protect']}
            // Task 12: the one Protect scenario that keeps `review: null` -- snapshots the
            // background-check section's omitted state (ProtectStage.jsx's `> 0` guard), while the
            // other two Protect baselines (both sharing/reusing PLAN_REVIEW_CANDIDATES above) freeze
            // the populated state.
            plan={{ ...PLAN_ONE_DEPOSIT, review: null }}
            protectProps={{
              owner: OWNER,
              onConnectWallet: () => Promise.resolve(OWNER),
              onRetryPreflight: () => Promise.resolve(freshDecisionRaw()),
              onRequestGrant: () => Promise.reject(new Error('User declined the request.')),
              onConfirmReuse: () => Promise.resolve({ agentAddresses: [AGENT_1] }),
              onEditPlan: () => {},
            }}
          />
        </AutopilotSection>
      </Section>

      <Section title="Start — queued, partial failure, in-transit">
        <StrategyRoute
          stage="start"
          reached={['plan', 'protect', 'start']}
          plan={PLAN_START_LIVE}
          startProps={{
            permission: { mode: 'fresh', agentAddresses: [AGENT_1, AGENT_2] },
            events: START_QUEUED_PARTIAL_EVENTS,
            receipt: null,
            runId: 'run-9',
          }}
        />
      </Section>

      <Section title="Start — receipt, all agents succeeded">
        <StrategyRoute
          stage="start"
          reached={['plan', 'protect', 'start']}
          plan={Object.freeze({
            ...PLAN_ONE_DEPOSIT,
            agents: [
              PLAN_ONE_DEPOSIT.agents[0],
              { ...PLAN_ONE_DEPOSIT.agents[0], allocationId: 'run-8:deposit:1' },
            ],
          })}
          startProps={{
            permission: { mode: 'fresh', agentAddresses: [AGENT_1, AGENT_2] },
            events: [
              ...depositCompletedEvents('run-8:deposit:0', AGENT_1, 0, REAL_TX_HASH_1),
              ...depositCompletedEvents('run-8:deposit:1', AGENT_2, 1, REAL_TX_HASH_2),
            ],
            receipt: RECEIPT_ALL_SUCCESS,
            runId: 'run-8',
            onViewMoney: () => {},
            onMakeAnotherDeposit: () => {},
          }}
        />
      </Section>

      <Section title="Start — receipt, mixed partial (long address/technical details)">
        <AutopilotSection drive={driveOpenTechnicalDetails}>
          <StrategyRoute
            stage="start"
            reached={['plan', 'protect', 'start']}
            plan={PLAN_MIXED_RECEIPT}
            startProps={{
              permission: { mode: 'fresh', agentAddresses: [AGENT_1, AGENT_2] },
              events: [],
              receipt: RECEIPT_MIXED_PARTIAL,
              runId: 'run-9',
              onViewMoney: () => {},
              onMakeAnotherDeposit: () => {},
            }}
          />
        </AutopilotSection>
      </Section>
    </main>
  )
}

// -------------------------------------------------------------------------------------------
// My Money Task 14 (Pocket Crew redesign, Wave 6 snapshot freeze). One deterministic composite
// over the /agent route's real composition root, MyMoneyRoute -- never a hand-assembled stand-in
// (same discipline Strategy's own fixture above follows). Unlike Strategy, MyMoneyRoute is a
// PURE, static composition over whatever `model`/`agents`/discovery props it's given -- there is
// no internal "review" phase reached only through driven interaction -- so every section below
// needs no AutopilotSection at all except the last (opening the recovery dialog via a real click).
//
// Every model below is built through the REAL buildMyMoneyModel state machine (money/
// myMoneyModel.js), not hand-typed with a `state` literal: this is what makes the "problem"
// precedence (a revoked-funded agent among two healthy ones still yields model.state:'problem'
// overall) and the "empty"/"partial-discovery" gates (freshness, discovery completeness, zero
// unattributed doubt) shapes production can actually emit, not shapes only a fixture could invent
// -- the exact discipline the brief's constraint 4 requires and Strategy Task 11's worst miss
// (a fixture shape production could never produce) was about.
const MM_NOW = 1_800_000_900_000
const MM_OWNER = 'GMMVISUALOWNERDJUQ7IYO7QJJBKWHXMLPQ2KABCVQDU5C2WTP6GZIRJ'
const MM_AGENT_DEPOSIT = 'CMMVISUALDEPOSITAGENTNAURNNAVHOA7SLIIKGAJFYGDVCPRX3TJCTF'
const MM_AGENT_BRIDGE = 'CMMVISUALBRIDGEAGENTTC7BKWIVVSRY5QJMLNYRIYENDJYGK4WTZ6OA'
const MM_AGENT_RECOVERY = 'CMMVISUALRECOVERYAGENTUE6SMT6NRAZILYIZUANKVMLZSMZUFWHOSK'

// readOwnerMoney.js:25 hardcodes this literal `token` for every amount this route renders today
// (`const TOKEN = 'USDC'`) -- not a fixture shortcut, matching the exact same convention Strategy's
// own PlanStage review UI already established for this file (see StrategyFixture's own comment).
function mmAmt(units, decimals = 7) {
  return { token: 'USDC', units: String(units), decimals }
}

function mmDepositAgent() {
  return {
    address: MM_AGENT_DEPOSIT,
    scope: {
      state: 'known',
      value: { vault: SOROBAN_ACTIVE_VAULT_ADDRESS, revoked: false, expiry: 0 },
    },
    amount: mmAmt(300_0000000n),
    executionStatus: 'idle',
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [],
    problems: [],
  }
}

// The "Base child" fixture: a real Stellar+Base split -- one agent, two independently-known legs
// (custody.js's own split-agent contract: the collapsed `custody.location` is 'unknown' by design
// once two legs are each independently known, PositionList/AgentTeam read `custodyBreakdown` first
// for exactly that reason).
function mmBridgeAgent() {
  return {
    address: MM_AGENT_BRIDGE,
    scope: {
      state: 'known',
      value: { vault: SOROBAN_ACTIVE_VAULT_ADDRESS, revoked: false, expiry: 0 },
    },
    amount: mmAmt(200_0000000n),
    executionStatus: 'succeeded',
    custody: { location: 'unknown' },
    custodyBreakdown: [
      { location: 'stellar-vault', amount: mmAmt(120_0000000n) },
      { location: 'base-proxy', amount: mmAmt(80_0000000n) },
    ],
    problems: [],
  }
}

// The "revoked-funded recovery" fixture: a confirmed scope-revoked agent still holding a known
// positive balance -- myMoneyModel.js's own confirmedProblemAgents() precedence (checked BEFORE
// every other branch) is what makes the overall model below 'problem', not a hand-set literal.
function mmRecoveryAgent() {
  return {
    address: MM_AGENT_RECOVERY,
    scope: {
      state: 'known',
      value: { vault: SOROBAN_ACTIVE_VAULT_ADDRESS, revoked: true, expiry: 0 },
    },
    amount: mmAmt(150_0000000n),
    executionStatus: 'idle',
    custody: { location: 'agent' },
    custodyBreakdown: [],
    problems: ['scope-revoked'],
  }
}

const MM_AGENTS_ACTIVE = Object.freeze([mmDepositAgent(), mmBridgeAgent(), mmRecoveryAgent()])

// Cap comes from ownerDiscovery.js's own agent rows (RouterDeployedEvent), never from `agents`
// (AgentTeam.jsx's own header comment) -- the recovery agent deliberately carries none, so its row
// honestly renders "Cap: Unavailable" rather than manufacturing one for an agent whose original
// deploy event may never have been indexed.
//
// MM14 fix round 1 (M-4, reviewer finding): these two caps must stay >= every amount MM_AGENT_
// DEPOSIT/MM_AGENT_BRIDGE are ever shown holding across ALL four fixture sections (300 and 200 USDC
// respectively -- mmDepositAgent()/mmBridgeAgent() above). The router cap is a hard on-chain bound;
// an agent holding 3-4x its own cap (the prior 100/50 USDC values against these same 300/200 USDC
// balances) is a state production can never emit.
const MM_DEPOSIT_CAP = '5000000000' // 500 USDC (decimals 7) -- exceeds the 300 USDC ever shown.
const MM_BRIDGE_CAP = '3000000000' // 300 USDC (decimals 7) -- exceeds the 200 USDC ever shown.
const MM_DISCOVERY_ACTIVE = Object.freeze({
  status: 'complete',
  agents: [
    { address: MM_AGENT_DEPOSIT, cap: MM_DEPOSIT_CAP },
    { address: MM_AGENT_BRIDGE, cap: MM_BRIDGE_CAP },
  ],
})
// MM14 fix round 1 (M-6, reviewer finding): the partial-discovery section reuses this SAME
// MM_AGENT_DEPOSIT address, and previously had no `discovery` prop of its own -- AgentTeam fell
// back to "Cap: Unavailable" there while sections 1/2 showed a real cap for the identical address,
// two different Caps for one agent inside a single frozen image. Shares MM_DEPOSIT_CAP with
// MM_DISCOVERY_ACTIVE above so the one address that appears in both never disagrees with itself.
const MM_DISCOVERY_PARTIAL = Object.freeze({
  status: 'partial',
  agents: [{ address: MM_AGENT_DEPOSIT, cap: MM_DEPOSIT_CAP }],
})
const MM_DISCOVERY_EMPTY = Object.freeze({ status: 'complete', agents: [] })

const MM_KEEPER_HEALTHY = Object.freeze({
  label: 'healthy',
  lastHeartbeatAt: MM_NOW - 30_000,
  evidence: { source: 'keeper-events' },
})
const MM_STRATEGY_CONFIGURED = Object.freeze({ label: 'configured' })
const MM_RISK_WATCH_LOCAL = Object.freeze({
  label: 'This device',
  scope: 'local',
  owner: MM_OWNER,
  networkId: 'stellar-testnet',
})

const MM_MODEL_ACTIVE = buildMyMoneyModel({
  owner: MM_OWNER,
  discovery: MM_DISCOVERY_ACTIVE,
  money: {
    confirmedTotal: { state: 'known', amount: mmAmt(650_0000000n) },
    yield: { state: 'live', apy: 8.1 },
    earned: { state: 'unavailable', amount: null },
    unattributed: {},
    custodyBreakdown: { 'stellar-vault': '420000000000000000', 'base-proxy': '80000000' },
    agentCount: 3,
    problemAgentCount: 1,
    agents: MM_AGENTS_ACTIVE,
    checkedAt: MM_NOW,
    confirmedLedger: 5551234,
    confirmedBlock: 42,
    source: 'stellar-rpc',
  },
  protection: { state: 'armed', authority: MM_OWNER, mandateExpiry: MM_NOW / 1000 + 300_000 },
  now: MM_NOW,
})

// MM14 fix round 1 (M-5, reviewer finding): the unattributed key below renders (truncated) as the
// "Unattributed Base balance (...)" address in PositionList.jsx's idle-row display -- it must be a
// real 56-char strkey shape like every other identity in this file, not a 20-char placeholder, or
// the truncation this fixture freezes is not the truncation production ever actually produces.
const MM_KERNEL_UNCONFIRMED = 'GMMKERNELUNCONFIRMEDABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCD'

const MM_MODEL_PARTIAL = buildMyMoneyModel({
  owner: MM_OWNER,
  discovery: MM_DISCOVERY_PARTIAL,
  money: {
    confirmedTotal: { state: 'known', amount: mmAmt(300_0000000n) },
    yield: { state: 'live', apy: 7.4 },
    earned: { state: 'unavailable', amount: null },
    unattributed: {
      [MM_KERNEL_UNCONFIRMED]: { state: 'unavailable', amount: null, checkedAt: null },
    },
    custodyBreakdown: { 'stellar-vault': '300000000' },
    agentCount: 1,
    problemAgentCount: 0,
    agents: [mmDepositAgent()],
    checkedAt: MM_NOW,
    confirmedLedger: 5551200,
    confirmedBlock: null,
    source: 'stellar-rpc',
  },
  protection: null,
  now: MM_NOW,
})

const MM_MODEL_EMPTY = buildMyMoneyModel({
  owner: MM_OWNER,
  discovery: MM_DISCOVERY_EMPTY,
  money: {
    confirmedTotal: { state: 'known', amount: mmAmt(0n) },
    yield: { state: 'unavailable', apy: null },
    earned: { state: 'unavailable', amount: null },
    unattributed: {},
    custodyBreakdown: {},
    agentCount: 0,
    problemAgentCount: 0,
    agents: [],
    checkedAt: MM_NOW,
    confirmedLedger: 5551300,
    confirmedBlock: null,
    source: 'stellar-rpc',
  },
  protection: { state: 'disarmed', authority: MM_OWNER, mandateExpiry: MM_NOW / 1000 - 3600 },
  now: MM_NOW,
})

function findRecoverFundsButton(root) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent.includes('Recover funds'))
}

async function driveOpenRecoveryDialog(root) {
  // MyMoneyRoute is now `lazy()` (see the module-scoped declaration above) -- on a slow first
  // load the button genuinely doesn't exist in `root` yet at the moment this drive starts, unlike
  // every other AutopilotSection drive in this file, which only ever waits on STATE changes
  // within an already-mounted, eagerly-imported route.
  await waitFor(() => findRecoverFundsButton(root) != null)
  findRecoverFundsButton(root).click()
  // Primitives.jsx's Dialog renders a native <dialog> (implicit role, no role="..." attribute) in
  // any browser that supports showModal() -- which every real Chromium does -- and only falls back
  // to an explicit role="dialog" <div> where that's unsupported (jsdom). Real Chromium capture
  // needs the tag-name form; both are checked so this drive works under either engine.
  await waitFor(() => root.querySelector('dialog, [role="dialog"]') != null)
}

// MM14 fix round 1 (owner decision #41, "money changes crossfade only after a new confirmed
// revision"): harness-only affordance, exposed nowhere in production. `MoneyFigure`/MoneyHero
// declare no transition/animation at all today (confirmed by reading Primitives.jsx/my-money.css),
// so this clause is vacuously true -- decision #41 forbids inventing a production crossfade just to
// exercise it. What CAN be tested in a real browser without inventing anything: a same-revision
// re-render (a NEW `model` object reference with byte-identical fields, the exact shape a poll tick
// that returns unchanged chain state would produce) must never visibly animate the money figure.
// The hidden button below is the only way to drive that from outside the component tree; the e2e
// spec's "same-revision re-render" test clicks it.
function MoneySameRevisionHarness({ model, ...rest }) {
  const [liveModel, setLiveModel] = useState(model)
  return (
    <div data-testid="mm-same-revision-harness">
      <button
        type="button"
        className="pc-visually-hidden"
        data-testid="mm-force-same-revision-rerender"
        onClick={() => setLiveModel({ ...liveModel })}
      >
        Force same-revision re-render (test only)
      </button>
      <MyMoneyRoute model={liveModel} {...rest} />
    </div>
  )
}

function MyMoneyFixture() {
  return (
    <main data-fixture="my-money" style={{ display: 'grid', gap: '2.5rem' }}>
      <h1>Pocket Crew visual harness — My Money</h1>

      {/* One boundary for all four sections below -- MyMoneyRoute is `lazy()` (see its
          declaration's own comment), but it is the SAME dynamic import every time, so React
          resolves and caches it once; every section past the first renders synchronously.
          Fix found empirically: a bare `fallback={null}` removed EVERY marker from the DOM
          (including AutopilotSection's own `data-fixture-pending`, section 1 only, which lives
          INSIDE this boundary and so is unmounted along with everything else while suspended) --
          `waitForFunction(() => 0 pending markers)` then resolved instantly, true but for the
          wrong reason (nothing had mounted yet, not "nothing left to wait for"), and the
          screenshot sometimes raced a still-suspended page (1440x1000, the bare viewport, instead
          of the real ~8871px full page). The fallback below carries its own marker so the wait
          is correct throughout the whole load, not just after it. */}
      <Suspense fallback={<div data-fixture-pending="true" />}>
        {/* Primitives.jsx's Dialog is `position: fixed` (viewport-relative, not DOM-position-
          relative) -- Chromium's full-page screenshot mode does NOT expand a fixed element's
          containing block to the whole document height, so an open dialog always paints over
          roughly the first viewport-height of the page, regardless of which section's own
          AutopilotSection opened it (found empirically: placing it last visually overlaid section
          1's unrelated content instead of its own). Placed FIRST so the dimmed backdrop
          legitimately covers the same section whose own dialog is open, not an unrelated one; the
          identical state is repeated undimmed in the very next section for a clean, unobstructed
          view of the same three-agent/Base-child/needs-recovery content. */}
        <Section title="Your money — recovery dialog open (active, three agents, Base child)">
          <AutopilotSection drive={driveOpenRecoveryDialog}>
            <MyMoneyRoute
              model={MM_MODEL_ACTIVE}
              agents={MM_AGENTS_ACTIVE}
              discovery={MM_DISCOVERY_ACTIVE}
              account={MM_OWNER}
              keeper={MM_KEEPER_HEALTHY}
              strategyConfig={MM_STRATEGY_CONFIGURED}
              riskWatch={MM_RISK_WATCH_LOCAL}
              venue="Autofarm Vault"
              onAction={() => {}}
              onRecoverAgent={() => {}}
              onRecoverBase={() => {}}
            />
          </AutopilotSection>
        </Section>

        <Section
          ariaHidden
          title="Your money — active, three agents (long addresses, Base child, needs recovery), dialog closed"
        >
          <MoneySameRevisionHarness
            model={MM_MODEL_ACTIVE}
            agents={MM_AGENTS_ACTIVE}
            discovery={MM_DISCOVERY_ACTIVE}
            account={MM_OWNER}
            keeper={MM_KEEPER_HEALTHY}
            strategyConfig={MM_STRATEGY_CONFIGURED}
            riskWatch={MM_RISK_WATCH_LOCAL}
            venue="Autofarm Vault"
            onAction={() => {}}
            onRecoverAgent={() => {}}
            onRecoverBase={() => {}}
          />
        </Section>

        <Section ariaHidden title="Your money — partial discovery">
          <MyMoneyRoute
            model={MM_MODEL_PARTIAL}
            agents={[mmDepositAgent()]}
            discovery={MM_DISCOVERY_PARTIAL}
            onAction={() => {}}
            onRecoverBase={() => {}}
          />
        </Section>

        <Section ariaHidden title="Your money — no position (empty)">
          <MyMoneyRoute
            model={MM_MODEL_EMPTY}
            agents={[]}
            discovery={MM_DISCOVERY_EMPTY}
            onAction={() => {}}
            onRecoverBase={() => {}}
          />
        </Section>
      </Suspense>
    </main>
  )
}

// -------------------------------------------------------------------------------------------
// Task 12 (visual harness fixtures + snapshot regeneration). CrewRoute.jsx's own composition root
// (Tasks 9/10, the /agent route) -- real component, real derived selector
// (selectCrewDecisions.js), never a hand-assembled stand-in, same discipline Strategy/My Money's
// own fixtures above already follow. `Date.now()` is frozen for this fixture module above
// (`if (fixture === 'crew')`, next to the strategy freeze) precisely because CrewGuard.jsx owns a
// live per-second clock and CrewActivity.jsx's "x ago" text reads Date.now() independently -- see
// that override's own comment for why a per-component `now` prop would have missed the second one.
//
// Reuses MM_AGENT_DEPOSIT/MM_AGENT_BRIDGE/MM_AGENT_RECOVERY (identities) and mmAmt/mmDepositAgent/
// mmBridgeAgent (shapes) from My Money's own fixture above -- never re-declared. mmRecoveryAgent()
// itself (revoked AND still holding a confirmed-positive balance -- myMoneyModel.js's
// confirmedProblemAgents()) is deliberately NOT reused for Section 3 below: My Money's own fixture
// already freezes that exact "needs recovery" permutation. Section 3's cancelled agent is a
// genuinely different, equally real one production can emit -- revoked with NOTHING confirmed-
// positive left (`confirmedProblemAgents`'s own comment: "a revoked/expired agent holding nothing
// confirmed-positive is not urgent") -- so the crew route's OWN precedence (not a fixture-invented
// one) is what keeps this section's overall model out of the 'problem' state, unlike My Money's.
function crewHealthyAgent(address, units) {
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: SOROBAN_ACTIVE_VAULT_ADDRESS, revoked: false, expiry: 0 },
    },
    amount: mmAmt(units),
    executionStatus: 'idle',
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [],
    problems: [],
  }
}

const CREW_MAX_I128_UNITS = 170141183460469231731687303715884105727n
const CREW_AGENTS_ASSIGNED = Object.freeze([
  mmDepositAgent(),
  crewHealthyAgent(MM_AGENT_RECOVERY, CREW_MAX_I128_UNITS - 300_0000000n),
])

function crewIndexedRow(address, runOrdinal, cap, createdLedger) {
  return {
    address,
    creator: 'CCREWVISUALINDEXCREATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    createdLedger,
    createdTxHash: `${REAL_TX_HASH_1.slice(0, 56)}${String(runOrdinal).padStart(8, '0')}`,
    runId: `run-crew-${runOrdinal}`,
    runOrdinal,
    grantTxHash: REAL_TX_HASH_2,
    provenance: {
      source: 'router-event',
      providerId: 'visual-live-rpc',
      endpointClass: 'live',
      generation: 'agent-v3',
    },
    discoverySources: ['agent-index-api'],
    scopeReadStatus: 'ok',
    vault: SOROBAN_ACTIVE_VAULT_ADDRESS,
    revoked: false,
    expiry: NOW_SECONDS + 3600,
    authorized: true,
    cap,
    baseChildren: [],
  }
}

const CREW_DISCOVERY_ASSIGNED = Object.freeze({
  status: 'complete',
  networkId: 'stellar-testnet',
  owner: MM_OWNER,
  agents: [
    crewIndexedRow(MM_AGENT_DEPOSIT, 0, MM_DEPOSIT_CAP, 5551300),
    // Ordinal 3 wraps to Sprout. This is indexed assignment evidence, not render order.
    crewIndexedRow(MM_AGENT_RECOVERY, 3, '2000000000', 5551350),
  ],
})

const CREW_MONEY_ASSIGNED = Object.freeze({
  confirmedTotal: { state: 'known', amount: mmAmt(CREW_MAX_I128_UNITS) },
  yield: { state: 'live', apy: 8.1 },
  earned: { state: 'unavailable', amount: null },
  unattributed: {},
  custodyBreakdown: { 'stellar-vault': String(CREW_MAX_I128_UNITS) },
  agentCount: 2,
  problemAgentCount: 0,
  agents: CREW_AGENTS_ASSIGNED,
  checkedAt: NOW_SECONDS * 1000,
  confirmedLedger: 5551400,
  confirmedBlock: 43,
  source: 'stellar-rpc',
})

const CREW_PERSONAS_ASSIGNED = buildCrewPersonas({
  moneyAgents: CREW_AGENTS_ASSIGNED,
  discovery: CREW_DISCOVERY_ASSIGNED,
})

const CREW_MODEL_ARMED = buildMyMoneyModel({
  owner: MM_OWNER,
  discovery: CREW_DISCOVERY_ASSIGNED,
  money: CREW_MONEY_ASSIGNED,
  protection: { state: 'armed', authority: MM_OWNER, mandateExpiry: NOW_SECONDS + 5 * 3600 },
  now: NOW_SECONDS * 1000,
})

// Same crew/money/discovery as CREW_MODEL_ARMED -- only `protection.mandateExpiry` moves behind
// the frozen now. CrewGuard.jsx's own header comment: "state:'armed' with a lapsed mandateExpiry
// must still show ALARM ONLY" -- `state` stays 'armed' on purpose, never 'disarmed', so this
// exercises that exact decay path, not a separately-disarmed one.
const CREW_MODEL_ALARM = buildMyMoneyModel({
  owner: MM_OWNER,
  discovery: CREW_DISCOVERY_ASSIGNED,
  money: CREW_MONEY_ASSIGNED,
  protection: { state: 'armed', authority: MM_OWNER, mandateExpiry: NOW_SECONDS - 3600 },
  now: NOW_SECONDS * 1000,
})

// readOwnerMoney.js:197 -- `if (row.revoked) problems.push('scope-revoked')` -- ALWAYS accompanies
// a revoked scope in production; there is no real shape where `revoked:true` carries an empty
// `problems` array. `amount: mmAmt(0n)` is what keeps `isKnownPositiveAmount` (myMoneyModel.js)
// false despite the marker, which is what keeps this section's overall model out of 'problem'
// (see this block's own header comment above).
const CREW_AGENT_CANCELLED = {
  address: MM_AGENT_BRIDGE,
  scope: {
    state: 'known',
    value: { vault: SOROBAN_ACTIVE_VAULT_ADDRESS, revoked: true, expiry: 0 },
  },
  amount: mmAmt(0n),
  executionStatus: 'idle',
  custody: { location: 'stellar-vault' },
  custodyBreakdown: [],
  problems: ['scope-revoked'],
}
const CREW_AGENTS_CANCELLED = Object.freeze([mmDepositAgent(), CREW_AGENT_CANCELLED])

const CREW_DISCOVERY_CANCELLED = Object.freeze({
  status: 'complete',
  networkId: 'stellar-testnet',
  owner: MM_OWNER,
  agents: [
    crewIndexedRow(MM_AGENT_DEPOSIT, 0, MM_DEPOSIT_CAP, 5551300),
    {
      ...crewIndexedRow(MM_AGENT_BRIDGE, 1, MM_BRIDGE_CAP, 5551325),
      revoked: true,
      authorized: false,
    },
  ],
})

const CREW_PERSONAS_CANCELLED = buildCrewPersonas({
  moneyAgents: CREW_AGENTS_CANCELLED,
  discovery: CREW_DISCOVERY_CANCELLED,
})

const CREW_MODEL_CANCELLED = buildMyMoneyModel({
  owner: MM_OWNER,
  discovery: CREW_DISCOVERY_CANCELLED,
  money: {
    confirmedTotal: { state: 'known', amount: mmAmt(300_0000000n) },
    yield: { state: 'live', apy: 7.8 },
    earned: { state: 'unavailable', amount: null },
    unattributed: {},
    custodyBreakdown: { 'stellar-vault': '3000000000' },
    agentCount: 2,
    // readOwnerMoney.js:464 -- `if (a.problems?.length) problemAgentCount += 1` counts EVERY
    // flagged agent, not only confirmed-and-holding ones -- 1 here, honestly, even though this
    // section's overall model state stays out of 'problem' (a different, stricter gate).
    problemAgentCount: 1,
    agents: CREW_AGENTS_CANCELLED,
    checkedAt: NOW_SECONDS * 1000,
    confirmedLedger: 5551450,
    confirmedBlock: 44,
    source: 'stellar-rpc',
  },
  // Guard stays armed/healthy here -- this section's own subject is the cancelled lane, not the
  // guard card.
  protection: { state: 'armed', authority: MM_OWNER, mandateExpiry: NOW_SECONDS + 5 * 3600 },
  now: NOW_SECONDS * 1000,
})

// Task 12 fix round 1, M7: My Money's own MM_MODEL_EMPTY is anchored on MM_NOW
// (1_800_000_900_000), 900 real seconds after this fixture's own frozen `Date.now()`
// (NOW_SECONDS * 1000 = 1_800_000_000_000, set by the `if (fixture === 'crew')` override above).
// Reusing MM_MODEL_EMPTY as-is for Section 4 below left the crew fixture's own empty model
// internally anchored to a clock 900s ahead of the one every live `Date.now()` reader on this
// page actually observes -- harmless today (CrewRoute's `!agents.length` branch renders no
// timestamp), but latent if that branch ever grows one. This is the SAME shape as MM_MODEL_EMPTY
// (same owner/discovery/money/protection), rebuilt with checkedAt/now/mandateExpiry all anchored
// to the crew fixture's own frozen instant instead -- MM_MODEL_EMPTY itself is left untouched
// (My Money's own fixture keeps using it, so its baselines are unaffected).
const CREW_DISCOVERY_EMPTY = Object.freeze({
  ...MM_DISCOVERY_EMPTY,
  networkId: 'stellar-testnet',
  owner: MM_OWNER,
})

const CREW_PERSONAS_EMPTY = buildCrewPersonas({
  moneyAgents: [],
  discovery: CREW_DISCOVERY_EMPTY,
})

const CREW_MODEL_EMPTY = buildMyMoneyModel({
  owner: MM_OWNER,
  discovery: CREW_DISCOVERY_EMPTY,
  money: {
    confirmedTotal: { state: 'known', amount: mmAmt(0n) },
    yield: { state: 'unavailable', apy: null },
    earned: { state: 'unavailable', amount: null },
    unattributed: {},
    custodyBreakdown: {},
    agentCount: 0,
    problemAgentCount: 0,
    agents: [],
    checkedAt: NOW_SECONDS * 1000,
    confirmedLedger: 5551300,
    confirmedBlock: null,
    source: 'stellar-rpc',
  },
  protection: { state: 'disarmed', authority: MM_OWNER, mandateExpiry: NOW_SECONDS - 3600 },
  now: NOW_SECONDS * 1000,
})

// Real shape (app.jsx:1131-1162, CrewActivity.jsx's own header comment): totalGainUsdc/
// pricePerShare/amountUsdc are toFixed() STRINGS, never numbers; txHash/fromLabel/toLabel real-
// length, matching this file's own established "never a short placeholder" discipline for hashes/
// addresses. `timestamp` is ms-since-epoch, computed relative to the SAME frozen NOW_SECONDS*1000
// CrewActivity.jsx's own `Date.now()` read resolves to under this fixture's override -- so the
// printed "x ago" text is stable on every run, not just non-crashing.
const CREW_KEEPER_EVENTS = Object.freeze([
  {
    id: 'compound:9001',
    kind: 'compound_executed',
    vaultName: 'Autofarm vault',
    totalGainUsdc: '4.82',
    pricePerShare: '1.0421',
    txHash: REAL_TX_HASH_1,
    timestamp: NOW_SECONDS * 1000 - 12 * 60 * 1000, // 12 min before frozen now
    closedAt: NOW_SECONDS * 1000 - 12 * 60 * 1000,
  },
  {
    id: 'rebalance:9002',
    kind: 'rebalance_executed',
    vaultName: 'Autofarm vault',
    from: VAULT_ADDR,
    to: BRIDGE_TARGET_STANDIN,
    // Task 12 fix round 1, M8: the real screens.jsx shortAddr (imported above), not a hand-copied
    // reimplementation.
    fromLabel: shortAddr(VAULT_ADDR),
    toLabel: shortAddr(BRIDGE_TARGET_STANDIN),
    amountUsdc: '65.00',
    txHash: REAL_TX_HASH_2,
    timestamp: NOW_SECONDS * 1000 - 47 * 60 * 1000, // 47 min before frozen now
    closedAt: NOW_SECONDS * 1000 - 47 * 60 * 1000,
  },
])

// Real `logs` shape ({id, time, event, meta} -- selectCrewDecisions.test.js's own `L()` helper),
// never a hand-typed {tone,title} literal -- `decisions` below is the SAME selectCrewDecisions()
// call production wires at app.jsx:3518, run over these two entries. `time` is a fixed literal
// string (production's own nowT() is never called here) -- no live-clock read this fixture would
// need to freeze a second way.
const CREW_LOGS = Object.freeze([
  {
    id: 'log-1',
    time: '14:02:11',
    event: 'VaultRejected',
    meta: 'facts stale, Community pool (proxy)',
  },
  {
    id: 'log-2',
    time: '14:07:45',
    event: 'OrchestratorPlanned',
    meta: 'Proposal: hold, Blend Capital v2',
  },
])

function CrewFixture() {
  return (
    <main data-fixture="crew" style={{ display: 'grid', gap: '2.5rem' }}>
      <h1>Pocket Crew visual harness — The Crew</h1>

      {/* CrewRoute is lazy() (see its own declaration's comment) for the same CSS-cascade reason
          MyMoneyRoute is above -- one Suspense boundary, one pending marker, for the whole fixture. */}
      <Suspense fallback={<div data-fixture-pending="true" />}>
        <Section title="The crew — armed, two Sprout children">
          <CrewRoute
            crew={CREW_PERSONAS_ASSIGNED}
            model={CREW_MODEL_ARMED}
            keeper={MM_KEEPER_HEALTHY}
            keeperEvents={CREW_KEEPER_EVENTS}
            decisions={selectCrewDecisions(CREW_LOGS)}
            onRenewMandate={() => {}}
            onCancelAgent={() => {}}
            onStartStrategy={() => {}}
          />
        </Section>

        <Section ariaHidden title="The crew — alarm only (mandate lapsed)">
          <CrewRoute
            crew={CREW_PERSONAS_ASSIGNED}
            model={CREW_MODEL_ALARM}
            keeper={MM_KEEPER_HEALTHY}
            keeperEvents={CREW_KEEPER_EVENTS}
            decisions={selectCrewDecisions(CREW_LOGS)}
            onRenewMandate={() => {}}
            onCancelAgent={() => {}}
            onStartStrategy={() => {}}
          />
        </Section>

        {/* Empty keeperEvents/decisions here (unlike the two sections above) -- genuinely new
            coverage for CrewActivity.jsx's own two "nothing yet" empty-state lines, never reached
            by the two populated sections above. */}
        <Section ariaHidden title="The crew — one agent cancelled">
          <CrewRoute
            crew={CREW_PERSONAS_CANCELLED}
            model={CREW_MODEL_CANCELLED}
            keeper={MM_KEEPER_HEALTHY}
            keeperEvents={[]}
            decisions={[]}
            onRenewMandate={() => {}}
            onCancelAgent={() => {}}
            onStartStrategy={() => {}}
          />
        </Section>

        {/* The same authoritatively empty discovery feeds both the money model and the persistent
            three-persona projection, so the route can distinguish known-empty from a read gap. */}
        <Section ariaHidden title="The crew — empty">
          <CrewRoute
            crew={CREW_PERSONAS_EMPTY}
            model={CREW_MODEL_EMPTY}
            onStartStrategy={() => {}}
          />
        </Section>
      </Suspense>
    </main>
  )
}

// -------------------------------------------------------------------------------------------
// VF Wallet deterministic atlas. Popup screens and approval/ceremony screens are separate
// composition families because their production documents load different external stylesheets.
// The selected `section=P00..P20|A00..A09|C00..C09` query mounts one registry-bound production
// composition; with no section the legacy composite remains available for compatibility checks.
// Both CSS imports are deferred to the fixture boundary, and the explicit pending=false gate is
// only released after the stylesheet side effect and two paint frames have settled. No fixture
// branch invokes network, clock, randomness, signer, relay, or secret-handling code.

// Exact public identity strings remain display-only evidence. Production component props below
// use clearly synthetic account values so no Foundation-serialized fixture record can accidentally
// treat these strings as authority, custody, owner, or signer data.
const VFW_PUBLIC_G_DISPLAY = STELLAR_G_FIXTURE
const VFW_PUBLIC_C_DISPLAY = STELLAR_C_FIXTURES[0]
const VFW_STANDARD_ADDR = 'GVFWALLETSTANDARDFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const VFW_PASSKEY_ADDR = 'CVFWALLETPASSKEYFIXTUREBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const VFW_ALT_PASSKEY_ADDR = 'CDGDIPHVFWALLETPASSKEYFIXTURECCCCCCCCCCCCCCCCCCCCCCCCCC'
const VFW_BASE_KERNEL_DISPLAY = BASE_HEX_FIXTURES[0]
const VFW_DAPP_ORIGIN = 'https://example-dapp.test'
const VFW_NOW = 1_800_000_000

const VFW_STANDARD_ACCOUNT = Object.freeze({
  version: 1,
  id: `stellar-testnet:${VFW_STANDARD_ADDR}`,
  network: 'stellar-testnet',
  address: VFW_STANDARD_ADDR,
  kind: 'G',
  signer: 'classic-ed25519',
})
const VFW_PASSKEY_ACCOUNT = Object.freeze({
  version: 1,
  id: `stellar-testnet:${VFW_PASSKEY_ADDR}`,
  network: 'stellar-testnet',
  address: VFW_PASSKEY_ADDR,
  kind: 'C',
  signer: 'passkey-secp256r1',
})

const VFW_PORTFOLIO_STANDARD = Object.freeze({
  complete: true,
  total: 812.4,
  rows: [
    { asset: 'XLM', code: 'XLM', balance: '120.0000000', usd: 14.4 },
    { asset: `USDC:${VF_TESTNET_ISSUER}`, code: 'USDC', balance: '798.0000000', usd: 798.0 },
  ],
})
const VFW_PORTFOLIO_PASSKEY = Object.freeze({
  complete: true,
  total: 305.0,
  rows: [{ asset: `USDC:${VF_TESTNET_ISSUER}`, code: 'USDC', balance: '305.0000000', usd: 305.0 }],
})

// word0..word23 -- clearly-fake, the established repo convention (WalletOnboarding.test.jsx),
// never real BIP39 words, never a real secret.
const VFW_MNEMONIC = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ')
const VFW_BACKUP_INDICES = [0, 5, 12]

// Not valid XDR bytes -- long, base64-shaped, no natural break points, so the raw technical-details
// disclosure genuinely exercises the 360px long-identifier wrap column this task's brief names as
// its own trap, never a short stand-in that would hide that defect class.
const VFW_FAKE_XDR =
  'AAAAAgAAAABWRldhbGxldEZpeHR1cmVPbmx5TmV2ZXJBUmVhbFNpZ25lZFRyYW5zYWN0aW9uRW52ZWxvcGVOb3RWYWxpZFhEUg' +
  'AAAABkAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAA=='

// Hand-built to the EXACT shape extension/grantDecoder.js's decodeFundingRouterGrant /
// extension/txSummary.js's summarizeInvokeArgs actually produce -- never re-derived through real
// XDR encode/decode (the same discipline StrategyFixture's own freshDecisionRaw()/reuseDecisionRaw()
// helpers already established above). One deposit agent (Autofarm Vault -> Blend, the one live
// Stellar destination) and one bridge agent classified against the REAL CCTP TokenMessengerMinter
// contract + the real Base CCTP domain (grantDecoder.js's own classifyDestination), so the
// decoded row shows a recognized route label, never an "unknown destination" placeholder where a
// truthful one is available.
const VFW_GRANT_SUMMARY = Object.freeze({
  network: 'TESTNET',
  contract: SOROBAN_FUNDING_ROUTER_ADDRESS,
  contractLabel: 'funding router',
  fn: 'grant',
  args: [],
  signer: VFW_PASSKEY_ADDR,
  grant: Object.freeze({
    kind: 'funding-router-grant',
    schemaVersion: 2,
    owner: VFW_PASSKEY_ADDR,
    budgets: [
      { token: SOROBAN_TOKEN_ADDRESS, units: 500_0000000n, decimals: 7 },
      { token: STELLAR_USDC_SAC, units: 300_0000000n, decimals: 7 },
    ],
    expiryLedger: 9001,
    agents: [
      {
        index: 0,
        kind: 'deposit',
        signer: `0x${'ab'.repeat(32)}`,
        token: SOROBAN_TOKEN_ADDRESS,
        capPerPeriod: { token: SOROBAN_TOKEN_ADDRESS, units: 200_0000000n, decimals: 7 },
        periodDurationSeconds: 3600,
        expiryTimestamp: VFW_NOW + 3600,
        target: SOROBAN_ACTIVE_VAULT_ADDRESS,
        destinationDomain: null,
        mintRecipient: null,
        destination: {
          network: 'TESTNET',
          targetAddress: SOROBAN_ACTIVE_VAULT_ADDRESS,
          classification: 'known-stellar-vault',
          routeLabel: 'Autofarm Vault to Blend Capital v2',
          venueLabel: 'Blend Capital v2',
        },
      },
      {
        index: 1,
        kind: 'bridge',
        signer: `0x${'cd'.repeat(32)}`,
        token: STELLAR_USDC_SAC,
        capPerPeriod: { token: STELLAR_USDC_SAC, units: 300_0000000n, decimals: 7 },
        periodDurationSeconds: 3600,
        expiryTimestamp: VFW_NOW + 3600,
        target: STELLAR_TOKEN_MESSENGER_MINTER,
        destinationDomain: CCTP_BASE_DOMAIN,
        mintRecipient: `0x${'ef'.repeat(20)}`,
        destination: {
          network: 'TESTNET',
          targetAddress: STELLAR_TOKEN_MESSENGER_MINTER,
          classification: 'known-cctp-messenger',
          routeLabel: 'Stellar testnet to Circle CCTP to Base Sepolia',
          venueLabel: null,
        },
      },
    ],
    aggregateCapsByToken: [
      { token: SOROBAN_TOKEN_ADDRESS, units: 200_0000000n, decimals: 7 },
      { token: STELLAR_USDC_SAC, units: 300_0000000n, decimals: 7 },
    ],
    allowanceHeadroomByToken: [
      { token: SOROBAN_TOKEN_ADDRESS, units: 300_0000000n, decimals: 7 },
      { token: STELLAR_USDC_SAC, units: 0n, decimals: 7 },
    ],
  }),
})

const VFW_MISMATCH_SUMMARY = Object.freeze({
  network: 'TESTNET',
  contract: SOROBAN_FUNDING_ROUTER_ADDRESS,
  contractLabel: 'funding router',
  fn: 'set_admin',
  args: [`${VFW_STANDARD_ADDR.slice(0, 4)}…${VFW_STANDARD_ADDR.slice(-4)}`],
  signer: VFW_STANDARD_ADDR,
  grant: Object.freeze({
    kind: 'schema-mismatch',
    schemaVersion: 2,
    warning:
      'This is the known funding_router v2, but "set_admin" is not its grant call. Showing raw facts only.',
    contractId: SOROBAN_FUNDING_ROUTER_ADDRESS,
    functionName: 'set_admin',
    args: [`${VFW_STANDARD_ADDR.slice(0, 4)}…${VFW_STANDARD_ADDR.slice(-4)}`],
  }),
})

// Real fail-closed messages from src/wallet/consentStore.js's validateRequestSnapshot() -- both
// ceremony.js's own revalidateAtDelivery() and approve.js's own verifyStillValid() surface these
// verbatim on a real account-context change. Reused here rather than invented copy, for states
// (Step 1's "passkey mismatch" / "relay not submitted") this project's own code already names
// precisely.
const VFW_ACCOUNT_CHANGED_DETAIL = 'VF Wallet: active account changed'
const VFW_CONTEXT_CHANGED_DETAIL = 'VF Wallet: request context changed'

// Mirrors approve.html's static wrapper markup exactly (header + #approval-main + the static
// Reject/Confirm footer whose LABEL TEXT approve.js sets from `view.rejectLabel`/`approveLabel` --
// see that file's own `render()`) -- approvalView.js itself owns only the ordered content inside
// `<main>`, never the surrounding shell, so this wrapper is the harness's one, faithful
// replacement for what real approve.js/approve.html jointly provide. `wireAcknowledgmentGate`'s
// OWN disable-until-opened behavior (approve.js) is reproduced directly (disabled = needsAcknowledgment)
// rather than imported, since that function also wires a live `toggle` listener this frozen fixture
// has no use for.
function VfwApprovalCard({ view, openRawDetails = false }) {
  const mainRef = useRef(null)
  const approveRef = useRef(null)
  useEffect(() => {
    if (!mainRef.current) return
    renderApprovalView(mainRef.current, view)
    if (!mainRef.current.querySelector('h1')) {
      const heading = document.createElement('h1')
      heading.textContent = view.title
      mainRef.current.prepend(heading)
    }
    if (approveRef.current) approveRef.current.disabled = Boolean(view.needsAcknowledgment)
    if (openRawDetails) {
      const details = mainRef.current.querySelector('#raw-details')
      if (details) details.open = true
    }
  }, [view, openRawDetails])

  return (
    <div className="pc-wallet pc-wallet-shell" data-pocket-critical>
      <header className="pc-wallet-header">
        <div className="pc-brand-lockup pc-brand-lockup--compact">
          <img src="./vibing_farmer.logo.svg" alt="Vibing Farmer" />
          <span>VF Wallet</span>
        </div>
      </header>
      <main className="pc-wallet-main" ref={mainRef}>
        <p id="status">Loading request…</p>
      </main>
      <div className="pc-wallet-approval-actions">
        <button type="button" className="pc-button pc-button--secondary">
          {view.rejectLabel}
        </button>
        {view.approveLabel != null && (
          <button type="button" ref={approveRef} className="pc-button pc-button--primary">
            {view.approveLabel}
          </button>
        )}
      </div>
    </div>
  )
}

// Mirrors ceremony.html's static wrapper markup exactly (header with the passkey/secp256r1
// technical badge + #ceremony-main) -- ceremonyView.js owns only the ordered content inside
// <main>, same discipline as VfwApprovalCard above. `statusOverride`, when supplied, replicates
// ceremony.js's OWN direct `setStatus(documentRef, ...)` calls that bypass ceremonyStatusText's
// formal CEREMONY_STATE switch entirely for a few real, literal messages (e.g. ceremony.js's own
// "Submitted (${out.status || 'unknown'}). Not yet confirmed -- check the shares balance before
// relying on this number.") -- reproducing that exact real string, not inventing new copy for a
// state the module's own enum has no dedicated member for.
function VfwCeremonyCard({ view, statusOverride = null }) {
  const mainRef = useRef(null)
  useEffect(() => {
    if (!mainRef.current) return
    renderCeremonyView(mainRef.current, view)
    if (!mainRef.current.querySelector('h1')) {
      const heading = document.createElement('h1')
      heading.textContent = view.title
      mainRef.current.prepend(heading)
    }
    if (statusOverride) {
      const statusEl = mainRef.current.querySelector('#status')
      if (statusEl) statusEl.textContent = statusOverride
    }
  }, [view, statusOverride])

  return (
    <div className="pc-wallet pc-wallet-shell" data-pocket-critical>
      <header className="pc-wallet-header">
        <div className="pc-brand-lockup pc-brand-lockup--compact">
          <img src="./vibing_farmer.logo.svg" alt="Vibing Farmer" />
          <span>VF Wallet</span>
        </div>
        <span className="pc-technical">passkey · secp256r1</span>
      </header>
      <main className="pc-wallet-main" ref={mainRef}>
        <p id="status">Starting passkey ceremony</p>
      </main>
    </div>
  )
}

const VFW_RESULT_HASH = `0x${'ab'.repeat(32)}`
const VFW_NOOP = () => {}

function VfwPopupShell({ heading, account, onBack = VFW_NOOP, status = null, children }) {
  return (
    <WalletShell heading={heading} account={account} onBack={onBack} status={status}>
      {children}
    </WalletShell>
  )
}

function VfwSendSection() {
  return (
    <VfwPopupShell heading="Send" account={VFW_STANDARD_ACCOUNT}>
      <SendScreen
        from={VFW_STANDARD_ADDR}
        onPreview={VFW_NOOP}
        onConfirm={VFW_NOOP}
        preview={null}
        busy={false}
        error="Amount must be greater than 0"
      />
    </VfwPopupShell>
  )
}

function VfwAddAssetSection() {
  return (
    <VfwPopupShell heading="Add asset" account={VFW_STANDARD_ACCOUNT}>
      <AddAssetScreen onAddAsset={VFW_NOOP} busy={false} error={null} success={null} />
    </VfwPopupShell>
  )
}

function VfwPopupSection({ id }) {
  switch (id) {
    case 'P00':
      return (
        <WalletOnboarding
          view="choose"
          status={{ tone: 'info', message: 'Loading wallet' }}
          onChooseStandard={VFW_NOOP}
          onChoosePasskey={VFW_NOOP}
        />
      )
    case 'P01':
      return (
        <WalletOnboarding
          view="choose"
          status={{ tone: 'error', message: 'Wallet data unavailable. Retry.' }}
          onChooseStandard={VFW_NOOP}
          onChoosePasskey={VFW_NOOP}
        />
      )
    case 'P02':
      return (
        <WalletHome
          account={VFW_STANDARD_ACCOUNT}
          onNav={VFW_NOOP}
          securityLabel="Unlocked"
          portfolio={null}
          onSend={VFW_NOOP}
          onReceive={VFW_NOOP}
          onAddAsset={VFW_NOOP}
          onFund={VFW_NOOP}
          onGetUsdc={VFW_NOOP}
          status={{ tone: 'error', message: 'Balance unavailable. Retry.' }}
        />
      )
    case 'P03':
      return (
        <WalletOnboarding
          view="select-account"
          accounts={[VFW_STANDARD_ACCOUNT, VFW_PASSKEY_ACCOUNT]}
          onSelectAccount={VFW_NOOP}
        />
      )
    case 'P04':
      return (
        <WalletOnboarding
          view="standard-create"
          onBack={VFW_NOOP}
          createBusy={false}
          createError={null}
          onCreate={VFW_NOOP}
          onGoImport={VFW_NOOP}
        />
      )
    case 'P05':
      return <VfwSendSection />
    case 'P06':
      return (
        <WalletReceive
          account={VFW_STANDARD_ACCOUNT}
          onBack={VFW_NOOP}
          status={{ message: 'Loading address' }}
        />
      )
    case 'P07':
      return <VfwAddAssetSection />
    case 'P08':
      return <WalletActivity account={VFW_STANDARD_ACCOUNT} onNav={VFW_NOOP} items={null} />
    case 'P09':
      return (
        <WalletSettings
          account={VFW_STANDARD_ACCOUNT}
          onNav={VFW_NOOP}
          securityLabel="Locked"
          autoLockMin={15}
          onSetAutoLock={VFW_NOOP}
          onLock={VFW_NOOP}
          onExport={VFW_NOOP}
          onReset={VFW_NOOP}
          onSwitchAccount={VFW_NOOP}
          onOpenAdvanced={VFW_NOOP}
        />
      )
    case 'P10':
      return (
        <WalletAdvanced
          account={VFW_STANDARD_ACCOUNT}
          onBack={VFW_NOOP}
          busy
          onGetUsdc={VFW_NOOP}
          onFundXlm={VFW_NOOP}
          onImportWallet={VFW_NOOP}
        />
      )
    case 'P11':
      return (
        <WalletOnboarding
          view="passkey-choose"
          passkeyError={null}
          onBack={VFW_NOOP}
          onCreatePasskey={VFW_NOOP}
          onConnectPasskey={VFW_NOOP}
        />
      )
    case 'P12':
      return (
        <WalletHome
          account={VFW_PASSKEY_ACCOUNT}
          onNav={VFW_NOOP}
          securityLabel="Secured by Face ID"
          portfolio={VFW_PORTFOLIO_PASSKEY}
          onSend={null}
          onReceive={VFW_NOOP}
          onGetUsdc={VFW_NOOP}
        />
      )
    case 'P13':
      return (
        <WalletSettings
          account={VFW_PASSKEY_ACCOUNT}
          onNav={VFW_NOOP}
          securityLabel="Secured by Face ID"
          onSwitchAccount={VFW_NOOP}
          switchLabel="Switch to Standard wallet"
          onOpenAdvanced={VFW_NOOP}
        />
      )
    case 'P14':
      return (
        <WalletAdvanced
          account={VFW_PASSKEY_ACCOUNT}
          onBack={VFW_NOOP}
          busy
          depositAmount="50"
          onDepositAmountChange={VFW_NOOP}
          depositVerdict={null}
          onCheckEligibility={VFW_NOOP}
          onEnableDeposits={VFW_NOOP}
          onGetUsdc={VFW_NOOP}
        />
      )
    case 'P15':
      return (
        <WalletAdvanced
          account={VFW_PASSKEY_ACCOUNT}
          onBack={VFW_NOOP}
          depositAmount="50"
          onDepositAmountChange={VFW_NOOP}
          depositVerdict={{ allow: true, reasons: ['Allowance is within the reviewed cap.'] }}
          onCheckEligibility={VFW_NOOP}
          onEnableDeposits={VFW_NOOP}
          onApproveDeposit={VFW_NOOP}
          onRejectDeposit={VFW_NOOP}
        />
      )
    case 'P16':
      return (
        <WalletAdvanced
          account={VFW_PASSKEY_ACCOUNT}
          onBack={VFW_NOOP}
          recoveryAddress={VFW_STANDARD_ADDR}
          onRecoveryAddressChange={VFW_NOOP}
          onAddRecoverySigner={VFW_NOOP}
        />
      )
    case 'P17':
      return <WalletReceive account={VFW_PASSKEY_ACCOUNT} onBack={VFW_NOOP} />
    case 'P18':
      return (
        <VfwPopupShell
          heading="Signing pending"
          account={VFW_PASSKEY_ACCOUNT}
          status={{ tone: 'info', message: 'Waiting for Face ID' }}
        >
          <p className="pc-wallet-origin">
            Requested by <span className="pc-technical">VF Wallet (this extension)</span>
          </p>
          <p className="pc-technical pc-address-full">Display G fixture: {VFW_PUBLIC_G_DISPLAY}</p>
        </VfwPopupShell>
      )
    case 'P19':
      return (
        <VfwPopupShell
          heading="Signing result"
          account={VFW_PASSKEY_ACCOUNT}
          status={{ tone: 'info', message: 'Confirmed' }}
        >
          <p className="pc-field-help">Submitted and reconciled on Stellar testnet.</p>
          <p className="pc-technical pc-address-full">Transaction hash: {VFW_RESULT_HASH}</p>
          <p className="pc-technical pc-address-full">Display C fixture: {VFW_PUBLIC_C_DISPLAY}</p>
          <p className="pc-field-help">Base custody reference: {VFW_BASE_KERNEL_DISPLAY}</p>
        </VfwPopupShell>
      )
    case 'P20':
      return (
        <VfwPopupShell heading="Shared allowance" account={VFW_PASSKEY_ACCOUNT}>
          <ApproveOverlay
            verdict={{ allow: false, reasons: ['Allowance read is pending.'] }}
            simulate={null}
            onApprove={VFW_NOOP}
            onReject={VFW_NOOP}
          />
        </VfwPopupShell>
      )
    default:
      return null
  }
}

function buildVfwApprovalViews() {
  const connectRequest = { method: 'getAddress', params: {}, origin: VFW_DAPP_ORIGIN }
  const signRequest = {
    method: 'signTransaction',
    params: { xdr: VFW_FAKE_XDR },
    origin: VFW_DAPP_ORIGIN,
  }
  return {
    loading: buildApprovalView({ method: 'getAddress', params: {}, origin: null }, {}),
    noWallet: buildApprovalView(connectRequest, {
      address: null,
      submissionState: SUBMISSION_STATE.REVIEWING,
    }),
    connect: buildApprovalView(connectRequest, {
      address: VFW_STANDARD_ADDR,
      kind: 'classic',
      submissionState: SUBMISSION_STATE.REVIEWING,
    }),
    grant: buildApprovalView(signRequest, {
      address: VFW_PASSKEY_ADDR,
      kind: 'passkey',
      summary: VFW_GRANT_SUMMARY,
      submissionState: SUBMISSION_STATE.REVIEWING,
    }),
    schemaMismatch: buildApprovalView(signRequest, {
      address: VFW_STANDARD_ADDR,
      kind: 'classic',
      unlocked: true,
      summary: VFW_MISMATCH_SUMMARY,
      submissionState: SUBMISSION_STATE.REVIEWING,
    }),
    waitingPassword: buildApprovalView(signRequest, {
      address: VFW_STANDARD_ADDR,
      kind: 'classic',
      unlocked: false,
      submissionState: SUBMISSION_STATE.WAITING_PASSWORD,
      detail: 'Waiting for password',
    }),
    waitingPasskey: buildApprovalView(signRequest, {
      address: VFW_PASSKEY_ADDR,
      kind: 'passkey',
      summary: VFW_GRANT_SUMMARY,
      submissionState: SUBMISSION_STATE.WAITING_PASSKEY,
    }),
    signedReturned: buildApprovalView(signRequest, {
      address: VFW_PASSKEY_ADDR,
      kind: 'passkey',
      summary: VFW_GRANT_SUMMARY,
      submissionState: SUBMISSION_STATE.SIGNED_RETURNED,
    }),
    failed: buildApprovalView(signRequest, {
      address: VFW_PASSKEY_ADDR,
      kind: 'passkey',
      summary: VFW_GRANT_SUMMARY,
      submissionState: SUBMISSION_STATE.FAILED,
      detail: 'The request was rejected by the user.',
    }),
    staleAccount: buildApprovalView(signRequest, {
      address: VFW_ALT_PASSKEY_ADDR,
      kind: 'passkey',
      summary: VFW_GRANT_SUMMARY,
      submissionState: SUBMISSION_STATE.FAILED,
      detail: VFW_ACCOUNT_CHANGED_DETAIL,
    }),
    internalGuarded: buildApprovalView({ method: 'getAddress', params: {}, origin: null }, {}),
  }
}

function buildVfwCeremonyViews() {
  const depositRequest = { action: 'deposit', params: {} }
  const approveRequest = { action: 'approve', params: {} }
  const connectRequest = { action: 'connect', params: {} }
  const signRequest = { action: 'signTransaction', params: { xdr: VFW_FAKE_XDR } }
  const common = { address: VFW_PASSKEY_ADDR, kind: 'passkey', amountUnits: 50_0000000n }
  return {
    preparing: buildCeremonyView(depositRequest, {
      ...common,
      submissionState: CEREMONY_STATE.PREPARING,
    }),
    deposit: buildCeremonyView(depositRequest, {
      ...common,
      submissionState: CEREMONY_STATE.PREPARING,
    }),
    approve: buildCeremonyView(approveRequest, {
      ...common,
      submissionState: CEREMONY_STATE.PREPARING,
    }),
    connect: buildCeremonyView(connectRequest, {
      ...common,
      submissionState: CEREMONY_STATE.PREPARING,
    }),
    waitingPasskey: buildCeremonyView(depositRequest, {
      ...common,
      submissionState: CEREMONY_STATE.WAITING_PASSKEY,
    }),
    signed: buildCeremonyView(signRequest, {
      ...common,
      submissionState: CEREMONY_STATE.SIGNED,
    }),
    submitted: buildCeremonyView(depositRequest, {
      ...common,
      result: {
        ok: true,
        action: 'deposit',
        status: 'PENDING',
        hash: VFW_RESULT_HASH,
      },
    }),
    checking: buildCeremonyView(depositRequest, {
      ...common,
      submissionState: CEREMONY_STATE.CHECKING_STATUS,
    }),
    confirmed: buildCeremonyView(depositRequest, {
      ...common,
      result: {
        ok: true,
        action: 'deposit',
        status: 'SUCCESS',
        hash: VFW_RESULT_HASH,
        sharesBefore: '100000000',
        sharesAfter: '105000000',
      },
    }),
    notSubmitted: buildCeremonyView(signRequest, {
      ...common,
      result: {
        ok: false,
        action: 'signTransaction',
        status: 'NOT_SUBMITTED',
        error: VFW_CONTEXT_CHANGED_DETAIL,
      },
    }),
    rejected: buildCeremonyView(depositRequest, {
      ...common,
      result: { ok: false, action: 'deposit', status: 'REJECTED' },
    }),
    baseDisclosure: buildCeremonyView(signRequest, {
      ...common,
      decodedSummary: VFW_GRANT_SUMMARY,
      submissionState: CEREMONY_STATE.WAITING_PASSKEY,
    }),
  }
}

// Popup screens mount through real WalletShell compositions. wallet.css is loaded only here at
// the fixture boundary (popup.html's production document has the same external boundary), and
// the explicit readiness gate waits for the stylesheet side effect plus two paint frames. State
// selection is direct prop data; no fixture autopilot or wallet action is needed.
function VfWalletHomeFixture() {
  const [ready, setReady] = useState(false)
  const selectedEntry = walletSection?.startsWith('P')
    ? WALLET_ATLAS_SECTION_MAP[walletSection] || null
    : null
  useEffect(() => {
    let cancelled = false
    import('../extension/wallet.css').then(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled) setReady(true)
        })
      )
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (selectedEntry) {
    return (
      <div
        data-fixture="vf-wallet-home"
        data-fixture-section={selectedEntry.id}
        data-fixture-pending={ready ? 'false' : 'true'}
      >
        <section
          aria-labelledby={`wallet-${selectedEntry.id}-heading`}
          data-wallet-section={selectedEntry.id}
        >
          <h2 id={`wallet-${selectedEntry.id}-heading`}>{selectedEntry.title}</h2>
          <VfwPopupSection id={selectedEntry.id} />
        </section>
      </div>
    )
  }

  return (
    // Fix round 1 (real-Chromium overflow sweep, self-caught before review): NO outer padding
    // here, the same trap Strategy Task 14 already hit and fixed on this exact file -- padding on a
    // content-box <main> with no explicit width ADDS to the 360px viewport width rather than
    // eating into it (no box-sizing:border-box reset applies out here; that reset is scoped to
    // `.pc-wallet` and its descendants, not this fixture root above it), so `padding: '2rem'`
    // measured as a genuine 392px maxRight at the 360 viewport, caught by this task's own
    // overflow guard before a screenshot was ever frozen with it.
    <main
      data-fixture="vf-wallet-home"
      data-fixture-pending={ready ? 'false' : 'true'}
      style={{ display: 'grid', gap: '2rem' }}
    >
      <h1>Pocket Crew visual harness — VF Wallet (home)</h1>

      <Section title="First run — create or restore a wallet">
        <WalletOnboarding view="choose" onChooseStandard={() => {}} onChoosePasskey={() => {}} />
      </Section>

      <Section ariaHidden title="Account choice — more than one wallet on this device">
        <WalletOnboarding
          view="select-account"
          accounts={[VFW_STANDARD_ACCOUNT, VFW_PASSKEY_ACCOUNT]}
          onSelectAccount={() => {}}
        />
      </Section>

      <Section ariaHidden title="Standard Home">
        <WalletHome
          account={VFW_STANDARD_ACCOUNT}
          onNav={() => {}}
          securityLabel="Unlocked"
          portfolio={VFW_PORTFOLIO_STANDARD}
          onSend={() => {}}
          onReceive={() => {}}
          onAddAsset={() => {}}
          onFund={() => {}}
          onGetUsdc={() => {}}
        />
      </Section>

      {/* Passkey has no persistent lock state and no friendbot/trustline wiring of its own
          (WalletHome.jsx's own header) -- onAddAsset/onFund are omitted, never passed as no-ops,
          matching the "no dead button, fail closed" rule the real composition root follows. */}
      <Section ariaHidden title="Passkey Home">
        <WalletHome
          account={VFW_PASSKEY_ACCOUNT}
          onNav={() => {}}
          securityLabel="Secured by Face ID"
          portfolio={VFW_PORTFOLIO_PASSKEY}
          onSend={() => {}}
          onReceive={() => {}}
          onGetUsdc={() => {}}
        />
      </Section>

      <Section ariaHidden title="Home — unknown price / unavailable balance">
        <WalletHome
          account={VFW_STANDARD_ACCOUNT}
          onNav={() => {}}
          securityLabel="Unlocked"
          portfolio={null}
          onSend={() => {}}
          onReceive={() => {}}
          onAddAsset={() => {}}
          onFund={() => {}}
          onGetUsdc={() => {}}
        />
      </Section>

      <Section ariaHidden title="Activity — empty">
        <WalletActivity account={VFW_STANDARD_ACCOUNT} onNav={() => {}} items={[]} />
      </Section>

      <Section ariaHidden title="Seed backup warning">
        <WalletOnboarding
          view="standard-backup"
          account={VFW_STANDARD_ACCOUNT}
          mnemonic={VFW_MNEMONIC}
          indices={VFW_BACKUP_INDICES}
          onConfirmBackup={() => {}}
          onSkipBackup={() => {}}
        />
      </Section>

      <Section ariaHidden title="Advanced / Testnet">
        <WalletAdvanced
          account={VFW_STANDARD_ACCOUNT}
          onBack={() => {}}
          onGetUsdc={() => {}}
          onFundXlm={() => {}}
          depositAmount=""
          onDepositAmountChange={() => {}}
          depositVerdict={null}
          onCheckEligibility={() => {}}
          onEnableDeposits={() => {}}
          recoveryAddress=""
          onRecoveryAddressChange={() => {}}
          onAddRecoverySigner={() => {}}
          onImportWallet={() => {}}
        />
      </Section>

      <Section ariaHidden title="Settings — Base testnet mandate disclosure">
        <WalletSettings
          account={VFW_STANDARD_ACCOUNT}
          onNav={() => {}}
          securityLabel="Unlocked"
          autoLockMin={15}
          onSetAutoLock={() => {}}
          onLock={() => {}}
          onExport={() => {}}
          onReset={() => {}}
          onSwitchAccount={() => {}}
          onOpenAdvanced={() => {}}
        />
      </Section>
    </main>
  )
}

// approval.css is dynamically imported (never a static top-level import) -- see this section's
// own header comment for why a static import would contaminate every other fixture on this
// shared page. `cssReady` gates the composite behind the SAME `data-fixture-pending="true"`
// convention Strategy/My Money's own AutopilotSection/Suspense already establish, so
// vf-wallet.visual.spec.js's existing `waitForFunction(() => 0 pending markers)` wait covers this
// fixture with no new waiting mechanism. Double `requestAnimationFrame` (not just the import()
// promise resolving) because Vite's dev-mode dynamic CSS import inserts the <style> tag as a side
// effect of the import executing, and a promise resolving is not itself proof the browser has
// completed a style/layout pass against the newly inserted rules -- two rAFs guarantee at least
// one full paint has happened since insertion, the same reasoning MM14's own Suspense-boundary fix
// documents for a different async gap.
function VfWalletApprovalFixture() {
  const [cssReady, setCssReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    import('../extension/approval.css').then(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled) setCssReady(true)
        })
      )
    })
    return () => {
      cancelled = true
    }
  }, [])

  const approvalViews = buildVfwApprovalViews()
  const ceremonyViews = buildVfwCeremonyViews()
  const selectedEntry = walletSection && WALLET_ATLAS_SECTION_MAP[walletSection]

  if (selectedEntry && !selectedEntry.id.startsWith('P')) {
    const view = selectedEntry.id.startsWith('A')
      ? approvalViews[
          {
            A00: 'loading',
            A01: 'noWallet',
            A02: 'connect',
            A03: 'grant',
            A04: 'schemaMismatch',
            A05: 'waitingPassword',
            A06: 'signedReturned',
            A07: 'failed',
            A08: 'staleAccount',
            A09: 'internalGuarded',
          }[selectedEntry.id]
        ]
      : ceremonyViews[
          {
            C00: 'preparing',
            C01: 'deposit',
            C02: 'approve',
            C03: 'connect',
            C04: 'waitingPasskey',
            C05: 'signed',
            C06: 'submitted',
            C07: 'confirmed',
            C08: 'notSubmitted',
            C09: 'baseDisclosure',
          }[selectedEntry.id]
        ]
    const isApproval = selectedEntry.id.startsWith('A')
    return (
      <div
        data-fixture="vf-wallet-approval"
        data-fixture-section={selectedEntry.id}
        data-fixture-pending={cssReady ? 'false' : 'true'}
      >
        <section
          aria-labelledby={`wallet-${selectedEntry.id}-heading`}
          data-wallet-section={selectedEntry.id}
        >
          <h2 id={`wallet-${selectedEntry.id}-heading`}>{selectedEntry.title}</h2>
          {isApproval ? (
            <VfwApprovalCard view={view} openRawDetails={selectedEntry.id === 'A03'} />
          ) : (
            <VfwCeremonyCard view={view} />
          )}
        </section>
      </div>
    )
  }

  return (
    // Fix round 1: no outer padding here either -- see VfWalletHomeFixture's own comment above
    // for the exact same trap (Foundation/Strategy's own precedent), caught here by the identical
    // real-Chromium overflow sweep.
    <main
      data-fixture="vf-wallet-approval"
      data-fixture-pending={cssReady ? 'false' : 'true'}
      style={{ display: 'grid', gap: '2rem' }}
    >
      <h1>Pocket Crew visual harness — VF Wallet (approval / ceremony)</h1>

      <Section title="Connection consent">
        <VfwApprovalCard view={approvalViews.connect} />
      </Section>

      <Section ariaHidden title="Decoded multi-agent grant (technical details open)">
        <VfwApprovalCard view={approvalViews.grant} openRawDetails />
      </Section>

      <Section ariaHidden title="Raw / schema-mismatch approval">
        <VfwApprovalCard view={approvalViews.schemaMismatch} />
      </Section>

      <Section ariaHidden title="Passkey ceremony (signing a decoded grant, Base mandate visible)">
        <VfwCeremonyCard view={ceremonyViews.baseDisclosure} />
      </Section>

      <Section ariaHidden title="Wrong password">
        <VfwApprovalCard view={approvalViews.waitingPassword} />
      </Section>

      <Section ariaHidden title="Passkey mismatch">
        <VfwCeremonyCard view={ceremonyViews.rejected} />
      </Section>

      <Section ariaHidden title="Relay not submitted">
        <VfwCeremonyCard view={ceremonyViews.notSubmitted} />
      </Section>

      <Section ariaHidden title="Submission unknown">
        <VfwCeremonyCard
          view={ceremonyViews.submitted}
          statusOverride="Submitted (unknown). Not yet confirmed — check the shares balance before relying on this number."
        />
      </Section>
    </main>
  )
}

// -------------------------------------------------------------------------------------------
// Secondary functional fixture branches.  These wrappers only provide the composition context
// production routes normally receive from app.jsx (router, settled read, or a dialog opener).
// The route components themselves remain the sole owners of markup, effects, callbacks, and
// navigation behaviour.

function secondaryFixtureState() {
  try {
    secondaryPayload('onboarding', secondaryState)
    return secondaryState
  } catch {
    return 'current'
  }
}

function SecondaryFixtureShell({ fixtureId, cap, children, title }) {
  return (
    <div data-fixture={fixtureId} data-fixture-class={cap} data-fixture-pending="false">
      {title ? <h1 className="pc-visually-hidden">{title}</h1> : null}
      {children}
    </div>
  )
}

function SecondaryRouter({ entry, children }) {
  return <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
}

function SecondaryDevelopersFixture({ branch, state }) {
  const read = secondaryPayload('developers', state)
  if (branch === 'developer-keys') {
    return (
      <main className="pc-route">
        <KeysSection session={{ jwt: 'fixture-session' }} developersRead={read} />
      </main>
    )
  }
  if (branch === 'developer-usage') {
    return (
      <main className="pc-route">
        <UsageSection session={{ jwt: 'fixture-session' }} developersRead={read} />
      </main>
    )
  }
  if (branch === 'developer-docs') {
    return (
      <main className="pc-route">
        <DocsSection />
      </main>
    )
  }
  return (
    <main className="pc-route">
      <DevelopersLayout developersRead={read} />
    </main>
  )
}

function SecondaryTxFixture({ state }) {
  const row = secondaryPayload('history', state).transactions[0]
  const hash = row?.txHash || 'fixture-tx-not-found'
  // TxDetailPage intentionally reads the same local history reader as production. Seed only this
  // fixture's display record at the boundary; no reader or storage implementation is changed.
  try {
    localStorage.setItem('yv_history_transactions', JSON.stringify(row ? [row] : []))
  } catch {
    // A host with unavailable storage still exercises the real unavailable/not-found surface.
  }
  return (
    <SecondaryRouter entry={`/tx/${hash}`}>
      <Routes>
        <Route path="/tx/:txHash" element={<TxDetailPage />} />
      </Routes>
    </SecondaryRouter>
  )
}

function SecondaryDevPanelFixture() {
  useEffect(() => {
    window.postMessage({ type: '__activate_edit_mode' }, '*')
  }, [])
  return (
    <main>
      <h1 className="pc-visually-hidden">Developer tweaks</h1>
      <TweaksPanel title="Tweaks">
        <TweakSection label="Motion">
          <TweakSlider
            label="Scale"
            value={1}
            min={0.5}
            max={1.5}
            step={0.1}
            unit="×"
            onChange={() => {}}
          />
          <TweakToggle label="Reduced motion" value={false} onChange={() => {}} />
        </TweakSection>
        <TweakButton label="Apply" onClick={() => {}} />
      </TweaksPanel>
    </main>
  )
}

function SecondaryFixture({ branch, cap, state }) {
  const fixtureId = branch === 'landing' && cap === 'CAP-07' ? 'compat' : branch
  const payloadRoute = SECONDARY_ROUTE_FIXTURES[branch]?.payloadRoute || branch
  const payload =
    payloadRoute === 'landing' || payloadRoute === 'skill-drawer' || payloadRoute === 'dev-panel'
      ? null
      : secondaryPayload(payloadRoute, state)

  if (branch === 'landing') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <SecondaryRouter entry="/">
          <LandingHero onStart={() => {}} />
        </SecondaryRouter>
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'onboarding') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <OnboardingFlow
          connected={false}
          onConnect={() => {}}
          onComplete={() => {}}
          onboardingRead={payload}
        />
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'explorer') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <SecondaryRouter entry="/explorer">
          <ExplorerPage explorerRead={payload} />
        </SecondaryRouter>
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'ecosystem') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <SecondaryRouter entry="/ecosystem">
          <EcosystemPage ecosystemRead={payload} />
        </SecondaryRouter>
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'replay') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <SecondaryRouter entry="/replay">
          <ReplayPage replayRead={payload} />
        </SecondaryRouter>
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'history') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <main className="pc-route">
          <HistoryPanel connectedAddress={null} historyRead={payload} />
        </main>
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'vault') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <SecondaryRouter entry="/vault/blend-usdc">
          <Routes>
            <Route
              path="/vault/:protocol"
              element={<VaultDetailPage positions={{}} vaultRead={payload} />}
            />
          </Routes>
        </SecondaryRouter>
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'tx') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <SecondaryTxFixture state={state} />
      </SecondaryFixtureShell>
    )
  }
  if (branch.startsWith('developer')) {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <SecondaryRouter
          entry={branch === 'developers' ? '/developers' : `/developers/${branch.slice(11)}`}
        >
          <SecondaryDevelopersFixture branch={branch} state={state} />
        </SecondaryRouter>
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'skill-drawer') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap} title="Vault advisor skill">
        <main>
          <SkillDrawer open onClose={() => {}} skillSource="default" onSkillChange={() => {}} />
        </main>
      </SecondaryFixtureShell>
    )
  }
  if (branch === 'dev-panel') {
    return (
      <SecondaryFixtureShell fixtureId={fixtureId} cap={cap}>
        <SecondaryDevPanelFixture />
      </SecondaryFixtureShell>
    )
  }
  return null
}

function App() {
  if (fixture === 'core-money') return <CoreMoneyFixture />
  if (fixture === 'core-strategy') return <CoreStrategyFixture />
  if (fixture === 'core-crew') return <CoreCrewFixture />
  if (fixture === 'core-settings') return <CoreSettingsFixture />
  if (fixture === 'core-dialog') return <CoreDialogFixture />
  if (fixture === 'core-base-withdraw') return <CoreBaseWithdrawFixture />
  if (fixture === 'strategy') return <StrategyFixture />
  if (fixture === 'my-money') return <MyMoneyFixture />
  if (fixture === 'crew') return <CrewFixture />
  if (fixture === 'vf-wallet-home') return <VfWalletHomeFixture />
  if (fixture === 'vf-wallet-approval') return <VfWalletApprovalFixture />
  if (isSecondaryFixture) {
    const branch = secondaryBranch
    const entry = SECONDARY_ROUTE_FIXTURES[branch]
    const cap =
      secondaryClass && SECONDARY_OWNED_CLASSES.includes(secondaryClass)
        ? secondaryClass
        : entry?.cap || 'CAP-02'
    return <SecondaryFixture branch={branch} cap={cap} state={secondaryFixtureState()} />
  }
  if (fixture !== 'foundation') {
    return (
      <main data-fixture={fixture}>
        <h1>Pocket Crew visual harness</h1>
      </main>
    )
  }
  return <FoundationAtlasFixture theme={theme} />
}

// Guarded: this module is also imported directly by foundationA11y.test.jsx (jsdom, no #root
// element) so the shared `FoundationAtlasFixture` composition never duplicates markup between the
// Playwright entry and the a11y test.
const rootEl = typeof document !== 'undefined' ? document.getElementById('root') : null
if (rootEl) {
  createRoot(rootEl).render(<App />)
}

export { FoundationAtlasFixture, FoundationAtlasFixture as FoundationFixture }
