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
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
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
import { SOROBAN_TOKEN_ADDRESS } from '../src/stellar/config.js'
import { STELLAR_USDC_SAC } from '../src/stellar/cctpBurn.js'

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
  return (
    <main data-fixture="foundation" style={{ padding: '1.5rem', display: 'grid', gap: '2rem' }}>
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

async function driveSafeDefaultReady(root) {
  await fillPlanForm(root, { amount: '500', risk: 'Balanced' })
  await waitFor(() => findButton(root, 'Accept plan'))
}

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

function Section({ title, children }) {
  return (
    <section aria-labelledby={`strategy-${title.replace(/\s+/g, '-').toLowerCase()}`}>
      <h2 id={`strategy-${title.replace(/\s+/g, '-').toLowerCase()}`}>{title}</h2>
      {children}
    </section>
  )
}

function StrategyFixture() {
  // I-3 (Strategy Task 14 fix round 1, reviewer ruling): no outer padding here, scoped to THIS
  // fixture only (Foundation's own `padding: '1.5rem'` above is untouched -- its twelve baselines
  // are a completed plan's committed artifacts). Every section already wraps its content in a real
  // `StrategyRoute` (`.pc-route`, its own `--pc-route-gutter`) -- this harness's own extra 24px of
  // padding sat OUTSIDE that, so the `mobile-320` project was freezing a 272px route / 240px stack,
  // not the 320px viewport its own name promises. A project named `mobile-320` must test 320.
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
              stellarUnits: '5000000000',
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

function App() {
  if (fixture === 'strategy') return <StrategyFixture />
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
