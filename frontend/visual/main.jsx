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

function App() {
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
