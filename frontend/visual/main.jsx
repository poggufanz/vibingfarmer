// frontend/visual/main.jsx
// Secondary Vite entry (frontend/visual/index.html) for Playwright visual regression + this
// file's own jsdom-importable `FoundationFixture` (Foundation Task 7). Reads `?fixture=<id>` and
// `?theme=forest|day-field` from the URL exactly like Task 1 established; the Playwright spec
// (../e2e/pocket-crew.visual.spec.js) drives both params, and foundationA11y.test.jsx imports
// `FoundationFixture` directly (no browser, no query string) to assert the same composition is
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
import { AgentMark } from '../src/components/pocket/AgentMark.jsx'
import { BrandLockup } from '../src/components/pocket/BrandLockup.jsx'
import { MoneyFigure, TechnicalDetails, VenueTruth } from '../src/components/pocket/Primitives.jsx'
import { NetworkBadge, NetworkRoute } from '../src/components/pocket/NetworkIdentity.jsx'
import { NETWORK_IDS } from '../src/design/networks.js'
import { StrategyRoute } from '../src/components/strategy/StrategyRoute.jsx'
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
// VF Wallet Task 14. WalletHome/WalletOnboarding/WalletActivity/WalletAdvanced/WalletSettings all
// wrap the shared WalletShell, which renders its own <style> tag inline on every mount (see
// VfWalletHomeFixture's own header comment below for why that makes it safe to import these
// statically, unlike MyMoneyRoute above) -- plain top-level imports, no lazy() needed.
import { WalletHome } from '../src/wallet/ui/WalletHome.jsx'
import { WalletOnboarding } from '../src/wallet/ui/WalletOnboarding.jsx'
import { WalletActivity } from '../src/wallet/ui/WalletActivity.jsx'
import { WalletAdvanced } from '../src/wallet/ui/WalletAdvanced.jsx'
import { WalletSettings } from '../src/wallet/ui/WalletSettings.jsx'
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

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') || 'foundation'
const theme = params.get('theme') || 'forest'

document.documentElement.dataset.theme = theme

const { STELLAR_TESTNET, BASE_SEPOLIA } = NETWORK_IDS

// Four fixed, address-shaped identities -- never a list index -- so AgentMark's crew color and
// this whole fixture stay pixel-stable across every capture. Values are invented, not real
// testnet accounts.
const AGENT_IDENTITIES = Object.freeze([
  'GAAWWQ5FGB4S3RUUY36F4FR3PPZTXVBYSTZ56MBK6IJDBTZ4D3AV3JVO',
  'GB2NHY6IPX56JS3MSXTFOA6BSFVWK4CFEXMWMHZ6HYQAAT2A6TFICZ2E',
  'GCT5U3EOQKQLLZP4YRYVK6KAY4L5UM3PN7MYWICM6QN2WJ2TRK6ZFXAC',
  'GDXTJEK4JZNSTNQAWA3VFAJZLB3AVKMLU5MRDMWEGFYWMWFB3THLYFDD',
])

// Decorative color reference only -- every swatch carries its own always-visible text label
// beside it, never a color-only identity (see the render below).
const TOKEN_SWATCHES = Object.freeze([
  { label: 'Canvas', varName: '--pc-canvas' },
  { label: 'Workspace', varName: '--pc-workspace' },
  { label: 'Owned (Rice)', varName: '--pc-owned' },
  { label: 'Harvest', varName: '--pc-harvest' },
  { label: 'Danger', varName: '--pc-danger' },
  { label: 'Warn', varName: '--warn' },
  { label: 'Muted', varName: '--pc-muted' },
  { label: 'Focus ring', varName: '--focus-ring' },
])

// Fixed, never-computed grant scope for the disclosure example -- no Date.now()/new Date() so the
// baseline never drifts.
const GRANT_SCOPE_JSON = JSON.stringify(
  {
    router: 'CCEWWRQVFA6MJUYNGL2NHOMPGH3EQNRE6WVMWDT2QTQTSDNDHVN4GQXR',
    budget: '500.0000000 USDC',
    expiresAt: '2026-01-01T00:00:00Z',
    agents: 4,
  },
  null,
  2
)

function FoundationFixture() {
  // Fix round 2 (Strategy Task 14, owner ruling superseding the earlier "leave Foundation alone"
  // stance): no outer padding here. Unlike Strategy, Foundation has no `.pc-route` at all --
  // `document.querySelector('.pc-route')` is null on this fixture at every width -- so the removed
  // 24px was its ONLY gutter. This freezes Foundation's primitives at full bleed, not "fixes a
  // 272px route" (that framing is Strategy's own, whose sections each wrap a real `.pc-route` with
  // its own `--pc-route-gutter`; see StrategyFixture's comment below). A compulsory Foundation
  // re-freeze (owner decision #19's font change, unrelated to this fix) made bundling this in the
  // same pass strictly better than a second one later.
  return (
    <main data-fixture="foundation" style={{ display: 'grid', gap: '2rem' }}>
      {/* ponytail: fake, permanent focus ring for the demo buttons below -- a real DOM focus is
          singular per document, so only one of the two surfaces could ever hold a genuine
          :focus-visible at screenshot time. This reproduces the exact same rule pocket-crew.css
          already applies (see `:focus-visible` and its owned/harvest override there) via a
          fixture-only attribute, so both surfaces are provably ring-visible in one frozen frame.
          Real focus-trap/keyboard behavior is already covered by Primitives.test.jsx (Dialog). */}
      <style>{`
        [data-demo-focus-ring] {
          outline: 3px solid var(--focus-ring);
          outline-offset: 3px;
          box-shadow: 0 0 0 5px var(--focus-ring-contrast);
        }
        .pc-owned [data-demo-focus-ring],
        .pc-harvest [data-demo-focus-ring] {
          outline-color: var(--pc-focus-on-light);
          box-shadow: 0 0 0 5px var(--pc-owned);
        }
      `}</style>

      <h1>Pocket Crew visual harness</h1>

      <section aria-labelledby="lockups-heading">
        <h2 id="lockups-heading">Brand lockups</h2>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <BrandLockup variant="full" tone="auto" />
          <BrandLockup variant="compact" tone="auto" />
          <BrandLockup variant="full" tone="mono" />
        </div>
      </section>

      <section aria-labelledby="marks-heading">
        <h2 id="marks-heading">Product mark and agent marks</h2>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <BrandLockup variant="compact" />
          <AgentMark identity={AGENT_IDENTITIES[0]} state="active" label="A1" size={16} />
          <AgentMark identity={AGENT_IDENTITIES[1]} state="confirmed" label="A2" size={16} />
          <AgentMark identity={AGENT_IDENTITIES[2]} state="idle" label="A3" size={20} />
          <AgentMark identity={AGENT_IDENTITIES[3]} state="failed" label="A4" size={32} />
        </div>
      </section>

      <section aria-labelledby="tokens-heading">
        <h2 id="tokens-heading">Theme tokens</h2>
        <ul
          style={{
            display: 'flex',
            gap: '1rem',
            flexWrap: 'wrap',
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          {TOKEN_SWATCHES.map((token) => (
            <li
              key={token.label}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.35rem',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: 'block',
                  width: 48,
                  height: 48,
                  borderRadius: 8,
                  background: `var(${token.varName})`,
                  border: '1px solid var(--pc-muted)',
                }}
              />
              <span style={{ fontSize: 11 }}>{token.label}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="badges-heading">
        <h2 id="badges-heading">Network badges</h2>
        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <NetworkBadge networkId={STELLAR_TESTNET} size={16} />
          <NetworkBadge networkId={STELLAR_TESTNET} size={14} />
          <NetworkBadge networkId={BASE_SEPOLIA} size={16} />
          <NetworkBadge networkId={BASE_SEPOLIA} size={14} />
        </div>
      </section>

      <section aria-labelledby="routes-heading">
        <h2 id="routes-heading">Network routes</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Source</h3>
            <NetworkRoute
              context={{
                hostNetworkId: STELLAR_TESTNET,
                sourceNetworkId: STELLAR_TESTNET,
                destinationNetworkId: BASE_SEPOLIA,
                custodyNetworkId: STELLAR_TESTNET,
                transitState: 'source',
              }}
            />
          </div>
          <div>
            <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Transit</h3>
            <NetworkRoute
              context={{
                hostNetworkId: STELLAR_TESTNET,
                sourceNetworkId: STELLAR_TESTNET,
                destinationNetworkId: BASE_SEPOLIA,
                custodyNetworkId: STELLAR_TESTNET,
                transitState: 'burning',
              }}
            />
          </div>
          <div>
            <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Arrived</h3>
            <NetworkRoute
              context={{
                hostNetworkId: STELLAR_TESTNET,
                sourceNetworkId: STELLAR_TESTNET,
                destinationNetworkId: BASE_SEPOLIA,
                custodyNetworkId: BASE_SEPOLIA,
                transitState: 'arrived',
              }}
            />
          </div>
          <div>
            <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Failed</h3>
            <NetworkRoute
              context={{
                hostNetworkId: STELLAR_TESTNET,
                sourceNetworkId: STELLAR_TESTNET,
                destinationNetworkId: BASE_SEPOLIA,
                custodyNetworkId: STELLAR_TESTNET,
                transitState: 'failed',
              }}
            />
          </div>
          <div>
            <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Missing asset</h3>
            <NetworkRoute
              context={{
                sourceNetworkId: 'unrecognized-testnet-chain',
                destinationNetworkId: BASE_SEPOLIA,
                transitState: 'burning',
              }}
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="money-heading">
        <h2 id="money-heading">Money figures</h2>
        <ul
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          <li>
            <MoneyFigure state="loading" value={null} currency="USDC" />
          </li>
          <li>
            <MoneyFigure state="current" value={1234.56} currency="USDC" freshness="Just now" />
          </li>
          <li>
            <MoneyFigure state="stale" value={987.65} currency="USDC" freshness="5m ago" />
          </li>
          <li>
            <MoneyFigure state="empty" value={null} currency="USDC" />
          </li>
          <li>
            <MoneyFigure state="error" value={null} currency="USDC" />
          </li>
          <li>
            <MoneyFigure state="unknown" value={undefined} currency="USDC" />
          </li>
        </ul>
      </section>

      <section aria-labelledby="venue-heading">
        <h2 id="venue-heading">Venue truth</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <VenueTruth
            kind="stellar-live"
            venue="Autofarm Vault"
            apy={{ state: 'live', value: 8.2 }}
            networkContext={{
              hostNetworkId: STELLAR_TESTNET,
              sourceNetworkId: STELLAR_TESTNET,
              destinationNetworkId: STELLAR_TESTNET,
              custodyNetworkId: STELLAR_TESTNET,
              transitState: 'none',
            }}
          />
          <VenueTruth
            kind="base-proxy"
            networkContext={{
              hostNetworkId: STELLAR_TESTNET,
              sourceNetworkId: STELLAR_TESTNET,
              destinationNetworkId: BASE_SEPOLIA,
              custodyNetworkId: BASE_SEPOLIA,
              transitState: 'arrived',
            }}
          />
        </div>
      </section>

      <section aria-labelledby="interactive-heading">
        <h2 id="interactive-heading">Interactive states</h2>

        <div
          className="pc-harvest"
          style={{ padding: '1rem', borderRadius: 12, display: 'inline-flex' }}
        >
          <button type="button" className="btn-primary" data-demo-focus-ring="true">
            Confirm deposit
          </button>
        </div>

        <div
          className="pc-owned"
          style={{
            padding: '1rem',
            borderRadius: 12,
            display: 'inline-flex',
            marginTop: '0.75rem',
          }}
        >
          <button
            type="button"
            data-demo-focus-ring="true"
            style={{
              color: 'var(--pc-owned-ink)',
              background: 'transparent',
              border: '1px solid var(--pc-owned-ink)',
              borderRadius: 8,
              padding: '0.5rem 0.9rem',
              font: 'inherit',
            }}
          >
            Revoke agent
          </button>
        </div>

        <TechnicalDetails summary="Raw grant scope" open>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {GRANT_SCOPE_JSON}
          </pre>
        </TechnicalDetails>

        <p style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all', margin: 0 }}>
          {AGENT_IDENTITIES[0]}
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', alignItems: 'center' }}>
          <NetworkBadge networkId={STELLAR_TESTNET} size={16} />
          <NetworkBadge networkId={BASE_SEPOLIA} size={16} />
          <AgentMark identity={AGENT_IDENTITIES[1]} size={16} />
          <AgentMark identity={AGENT_IDENTITIES[2]} size={16} />
          <AgentMark identity={AGENT_IDENTITIES[3]} size={16} />
          <span>Wraps onto multiple lines at 320px; one line at desktop widths.</span>
        </div>
      </section>
    </main>
  )
}

// -------------------------------------------------------------------------------------------
// Strategy Task 14 (Pocket Crew redesign, Wave 6 snapshot freeze). One deterministic composite
// covering every state Strategy Tasks 10-13 shipped: Plan input, safe-default generating/review,
// mixed Stellar/Base truth review, Protect fresh/reuse/rejected, Start queued/partial-failure/
// in-transit, all-success and mixed-partial receipts, long address/technical details, and (via the
// e2e spec's separate `prefers-reduced-motion` capture of this SAME fixture, exactly like
// Foundation's own `foundation-reduced-motion.png`) reduced motion.
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
  setNativeValue(root.querySelector('#plan-amount'), amount)
  const radio = Array.from(root.querySelectorAll('[role="radio"]')).find(
    (r) => r.textContent.trim() === risk
  )
  radio.click()
  const submit = await waitFor(() => {
    const btn = findButton(root, 'Build my plan')
    return btn && !btn.disabled ? btn : null
  })
  submit.click()
}

// Runs `drive(rootEl)` once against the real mounted subtree, then clears `data-fixture-pending`
// once it settles (success or failure -- a fixture-authoring mistake must never hang the
// Playwright wait forever; it is logged loudly instead). Blurs any element the driven interaction
// left focused so a captured frame never depends on the nondeterministic :focus-visible heuristic
// for a click nobody performed with a real pointer.
function AutopilotSection({ drive, children }) {
  const ref = useRef(null)
  const [pending, setPending] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => drive(ref.current))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('strategy fixture autopilot failed:', err)
      })
      .finally(() => {
        if (cancelled) return
        if (document.activeElement && ref.current?.contains(document.activeElement)) {
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
    <div ref={ref} data-fixture-pending={pending ? 'true' : undefined}>
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
// unlike `FoundationFixture`). Marking sections 2-4 `aria-hidden="true"` removes their whole subtree
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

function StrategyFixture() {
  // I-3 (Strategy Task 14 fix round 1, reviewer ruling): no outer padding here, scoped to THIS
  // fixture only. (Fix round 2 later removed FoundationFixture's own padding the same way and
  // re-froze its twelve baselines -- see that function's comment above; the two removals are
  // independent edits to separate functions/JSX literals and neither leaks into the other.) Every
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
            plan={PLAN_ONE_DEPOSIT}
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
// VF Wallet Task 14 (Pocket Crew redesign, Wave 6 snapshot freeze -- LAST of the three shared-
// harness fixtures; this file's last owner). Split into TWO composites, never rendered on the
// same page load, for two INDEPENDENTLY VERIFIED reasons (not an arbitrary split):
//
// 1. CSS isolation. WalletHome/WalletOnboarding/WalletActivity/WalletAdvanced/WalletSettings all
//    wrap the shared WalletShell (src/wallet/ui/WalletShell.jsx), which renders its own <style>
//    tag INLINE on every mount -- its own header: "No MV3 page has ever loaded
//    frontend/extension/wallet.css or pocket-crew.css ... this component is therefore its own
//    COMPLETE, self-sufficient copy". So `VfWalletHomeFixture` needs no stylesheet import at all
//    and carries zero cascade risk, exactly like Strategy/My Money's own real components carry
//    their CSS via a route-level import, just inlined instead. The consent/grant/ceremony
//    screens are different: extension/approvalView.js and extension/ceremonyView.js are pure
//    vanilla-DOM renderers with NO self-contained styling -- in production they are styled only
//    by extension/approval.css, loaded via a <link> in approve.html/ceremony.html, two MV3
//    documents that never coexist with popup.html (confirmed by reading both files' own header
//    comments: "popup.html does not load [wallet.css]" / "approve.html and ceremony.html each
//    load [approval.css] as their only stylesheet"). approval.css re-declares the SAME
//    `.pc-wallet`/`.pc-wallet-shell/header/main/balance/actions/consequence`/`.pc-button` etc
//    selectors WalletShell.jsx's inline STYLE defines -- confirmed NOT byte-identical between the
//    two (approval.css carries an extra money-figure-style treatment WalletShell.jsx's copy
//    lacks) -- so a plain top-level `import '../extension/approval.css'` would execute on EVERY
//    `/visual/` page load regardless of `?fixture=` (ES imports are hoisted and always evaluated,
//    not conditional on which branch of App() actually renders), repeating My Money's own cascade
//    defect but WIDER: approval.css's `.pc-button`/`.pc-technical`/`.pc-field-help`/
//    `.pc-network-badge` selectors are also live in Strategy/My Money/Foundation's own fixtures via
//    pocket-crew.css/strategy.css/my-money.css. Fixed the same way MM14 fixed its own version of
//    this: a dynamic `import()`, deferred until `VfWalletApprovalFixture` itself actually mounts
//    (see that function's own `useEffect` below) -- never a static top-level import.
// 2. Day Field theme support genuinely differs between the two families -- this is not a
//    convenience choice, it is what "Forest is default; verify Day Field where supported" (this
//    task's own brief) resolves to once checked. WalletShell.jsx's inline STYLE (read in full)
//    hardcodes forest hex values with NO `:root[data-theme='day-field']` branch anywhere in it, so
//    every Home/Onboarding/Advanced/Settings screen renders IDENTICALLY regardless of `?theme=` --
//    a real, pre-existing production gap (WalletShell.jsx has no Day Field port at all), reported
//    in the task report, not fixed here (WalletShell.jsx is outside this task's authorized file
//    list). extension/approval.css DOES carry a `:root[data-theme='day-field']` block
//    (approval.css:65) -- confirmed by grep. So Day Field is captured for `vf-wallet-approval`
//    only; there would be nothing for a `vf-wallet-home` Day Field capture to show that Forest
//    doesn't already show byte-for-byte.
//
// A third, smaller finding from the same read-through, reported rather than silently routed
// around: WalletAdvanced.jsx's "Advanced direct vault action" section renders `ApproveOverlay`
// (src/wallet/ui/ApproveOverlay.jsx) once `depositVerdict` is set -- that component's own header
// comment says "Classes resolve from the popup's injected Acid Yield stylesheet" (`.approve`,
// `.btn-primary`, ...), none of which are Pocket Crew `.pc-*` classes and none of which this
// harness (or, per wallet.css's own header, popup.html itself) ever loads -- it would render
// completely unstyled raw HTML inside an otherwise Pocket-Crew-styled screen. `depositVerdict`
// stays `null` below so this fixture never freezes that known defect into a baseline; a null
// verdict (before the user has clicked "Check eligibility") is itself a state production can
// genuinely emit, not an evasion.
//
// Both approve.html and ceremony.html reference their header logo as the same-directory-relative
// `./vibing_farmer.logo.svg` -- correct from the extension's own popup.html/approve.html location,
// but this harness serves every fixture from `/visual/`, so that same relative reference 404s
// here (confirmed: WalletShell.jsx's header uses the identical relative path, so this affects
// BOTH composites below, not just the approval-styled markup this file authors itself). The
// underlying file is real and unmodified; only the request path differs by page location, so
// vf-wallet.visual.spec.js's own `page.route()` serves the on-disk asset back for that one
// filename, regardless of the (wrong-but-harmless) directory prefix the browser resolves it to --
// a harness-only network fixture, never a production file change. See that spec's own comment.

const VFW_STANDARD_ADDR = 'GVFWALLETSTANDARDFIXTUREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const VFW_PASSKEY_ADDR = 'CVFWALLETPASSKEYFIXTUREBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
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

// Not valid XDR/auth-entry bytes -- long, base64-shaped, no natural break points, so the raw
// technical-details disclosure genuinely exercises the 360px long-identifier wrap column this
// task's brief names as its own trap, never a short stand-in that would hide that defect class.
const VFW_FAKE_XDR =
  'AAAAAgAAAABWRldhbGxldEZpeHR1cmVPbmx5TmV2ZXJBUmVhbFNpZ25lZFRyYW5zYWN0aW9uRW52ZWxvcGVOb3RWYWxpZFhEUg' +
  'AAAABkAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAA=='
const VFW_FAKE_AUTH_ENTRY =
  'AAAAAQAAAABWRldhbGxldEZpeHR1cmVPbmx5TmV2ZXJBUmVhbFNpZ25lZEF1dGhFbnRyeU5vdFZhbGlkWERSAAAAAGQAAAAA' +
  'AAAAAQAAAAAAAAAYAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAA'

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
          routeLabel: 'Autofarm Vault → Blend Capital v2',
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
          routeLabel: 'Stellar testnet → Circle CCTP → Base Sepolia',
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

// Every screen here mounts through WalletShell (see this section's own header) -- self-contained
// CSS, no stylesheet import, no lazy() needed. Unlike Strategy's PlanStage/ProtectStage, none of
// these components hold an internal "review"/"generating" phase reached only through driven
// interaction (WalletOnboarding's own header: "a PURE presentational router... holds no state of
// its own") -- every state below is reached directly by props, so no AutopilotSection is needed
// anywhere in this fixture.
// VFW14 fix round 3 (owner decision #44): the same explicit `data-fixture-pending` readiness
// gate `VfWalletApprovalFixture` already carries (below), copied rather than invented -- this
// fixture has no async CSS import to wait on (self-contained WalletShell styling, see this
// section's own header), so there is nothing for the gate to await except the identical double
// `requestAnimationFrame` proof-of-paint that fixture's own comment already justifies: a promise
// resolving is not itself proof the browser has completed a style/layout pass, two rAFs guarantee
// at least one full paint has happened since mount. Previously this fixture had no explicit
// readiness signal at all and relied on incidental delay from the geometry sweeps that happen to
// run before the frozen capture -- harmless today (the real test passes), but not a real gate.
function VfWalletHomeFixture() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!cancelled) setReady(true)
      })
    )
    return () => {
      cancelled = true
    }
  }, [])

  return (
    // Fix round 1 (real-Chromium overflow sweep, self-caught before review): NO outer padding
    // here, the same trap Foundation Task 7/Strategy Task 14 both already hit and fixed on this
    // exact file (see FoundationFixture/StrategyFixture's own comments) -- padding on a
    // content-box <main> with no explicit width ADDS to the 360px viewport width rather than
    // eating into it (no box-sizing:border-box reset applies out here; that reset is scoped to
    // `.pc-wallet` and its descendants, not this fixture root above it), so `padding: '2rem'`
    // measured as a genuine 392px maxRight at the 360 viewport, caught by this task's own
    // overflow guard before a screenshot was ever frozen with it.
    <main
      data-fixture="vf-wallet-home"
      data-fixture-pending={ready ? undefined : 'true'}
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

  const connectView = buildApprovalView(
    { method: 'getAddress', params: {}, origin: VFW_DAPP_ORIGIN },
    { address: VFW_STANDARD_ADDR, kind: 'classic', submissionState: SUBMISSION_STATE.REVIEWING }
  )
  const grantView = buildApprovalView(
    { method: 'signTransaction', params: { xdr: VFW_FAKE_XDR }, origin: VFW_DAPP_ORIGIN },
    {
      address: VFW_PASSKEY_ADDR,
      kind: 'passkey',
      summary: VFW_GRANT_SUMMARY,
      submissionState: SUBMISSION_STATE.REVIEWING,
    }
  )
  const mismatchView = buildApprovalView(
    { method: 'signTransaction', params: { xdr: VFW_FAKE_XDR }, origin: VFW_DAPP_ORIGIN },
    {
      address: VFW_STANDARD_ADDR,
      kind: 'classic',
      unlocked: true,
      summary: VFW_MISMATCH_SUMMARY,
      submissionState: SUBMISSION_STATE.REVIEWING,
    }
  )
  const wrongPasswordView = buildApprovalView(
    { method: 'signTransaction', params: { xdr: VFW_FAKE_XDR }, origin: VFW_DAPP_ORIGIN },
    {
      address: VFW_STANDARD_ADDR,
      kind: 'classic',
      unlocked: false,
      submissionState: SUBMISSION_STATE.WAITING_PASSWORD,
      detail: 'Wrong password.',
    }
  )

  const signingGrantView = buildCeremonyView(
    { action: 'signTransaction', params: { xdr: VFW_FAKE_XDR } },
    {
      address: VFW_PASSKEY_ADDR,
      decodedSummary: VFW_GRANT_SUMMARY,
      submissionState: CEREMONY_STATE.WAITING_PASSKEY,
    }
  )
  const passkeyMismatchView = buildCeremonyView(
    { action: 'connect', params: {} },
    {
      address: VFW_PASSKEY_ADDR,
      submissionState: CEREMONY_STATE.FAILED,
      detail: VFW_ACCOUNT_CHANGED_DETAIL,
    }
  )
  const notSubmittedView = buildCeremonyView(
    { action: 'signAuthEntry', params: { authEntry: VFW_FAKE_AUTH_ENTRY } },
    {
      address: VFW_PASSKEY_ADDR,
      submissionState: CEREMONY_STATE.NOT_SUBMITTED,
      detail: VFW_CONTEXT_CHANGED_DETAIL,
    }
  )
  const submittedView = buildCeremonyView(
    { action: 'deposit', params: {} },
    {
      address: VFW_PASSKEY_ADDR,
      amountUnits: 50_0000000n,
      submissionState: CEREMONY_STATE.SUBMITTED,
    }
  )

  return (
    // Fix round 1: no outer padding here either -- see VfWalletHomeFixture's own comment above
    // for the exact same trap (Foundation/Strategy's own precedent), caught here by the identical
    // real-Chromium overflow sweep.
    <main
      data-fixture="vf-wallet-approval"
      data-fixture-pending={cssReady ? undefined : 'true'}
      style={{ display: 'grid', gap: '2rem' }}
    >
      <h1>Pocket Crew visual harness — VF Wallet (approval / ceremony)</h1>

      <Section title="Connection consent">
        <VfwApprovalCard view={connectView} />
      </Section>

      <Section ariaHidden title="Decoded multi-agent grant (technical details open)">
        <VfwApprovalCard view={grantView} openRawDetails />
      </Section>

      <Section ariaHidden title="Raw / schema-mismatch approval">
        <VfwApprovalCard view={mismatchView} />
      </Section>

      <Section ariaHidden title="Passkey ceremony (signing a decoded grant, Base mandate visible)">
        <VfwCeremonyCard view={signingGrantView} />
      </Section>

      <Section ariaHidden title="Wrong password">
        <VfwApprovalCard view={wrongPasswordView} />
      </Section>

      <Section ariaHidden title="Passkey mismatch">
        <VfwCeremonyCard view={passkeyMismatchView} />
      </Section>

      <Section ariaHidden title="Relay not submitted">
        <VfwCeremonyCard view={notSubmittedView} />
      </Section>

      <Section ariaHidden title="Submission unknown">
        <VfwCeremonyCard
          view={submittedView}
          statusOverride="Submitted (unknown). Not yet confirmed — check the shares balance before relying on this number."
        />
      </Section>
    </main>
  )
}

function App() {
  if (fixture === 'strategy') return <StrategyFixture />
  if (fixture === 'my-money') return <MyMoneyFixture />
  if (fixture === 'vf-wallet-home') return <VfWalletHomeFixture />
  if (fixture === 'vf-wallet-approval') return <VfWalletApprovalFixture />
  if (fixture !== 'foundation') {
    return (
      <main data-fixture={fixture}>
        <h1>Pocket Crew visual harness</h1>
      </main>
    )
  }
  return <FoundationFixture />
}

// Guarded: this module is also imported directly by foundationA11y.test.jsx (jsdom, no #root
// element) so the shared `FoundationFixture` composition never duplicates markup between the
// Playwright entry and the a11y test.
const rootEl = typeof document !== 'undefined' ? document.getElementById('root') : null
if (rootEl) {
  createRoot(rootEl).render(<App />)
}

export { FoundationFixture }
