// Deterministic CAP-01 presentation atlas. This is an offline fixture only: it owns no route,
// wallet, custody, or source state. Every value below is frozen so visual and semantic tests see
// the same evidence on every render.
import { useState } from 'react'
import { normalizeFact, toFreshnessView } from '../src/design/pocket-crew-foundation.js'
import { normalizeTheme } from '../src/design/theme.js'
import { NETWORK_IDS } from '../src/design/networks.js'
import { AgentMark } from '../src/components/pocket/AgentMark.jsx'
import { BrandLockup } from '../src/components/pocket/BrandLockup.jsx'
import { NetworkBadge, NetworkRoute } from '../src/components/pocket/NetworkIdentity.jsx'
import {
  Dialog,
  MoneyFigure,
  StageShell,
  StatusNotice,
  TechnicalDetails,
  VenueTruth,
} from '../src/components/pocket/Primitives.jsx'

export const FOUNDATION_CLOCK = Object.freeze({
  nowMs: 1786406400000,
  nowIso: '2026-08-11T00:00:00.000Z',
  checkedAtMs: 1786406340000,
  checkedAt: '2026-08-10T23:59:00.000Z',
  staleAfterMs: null,
  confirmedLedger: '12345',
  confirmedBlock: '67890',
})

export const FOUNDATION_PUBLIC_STRINGS = Object.freeze([
  'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS',
  'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
  'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J',
  'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77',
  'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  '0x0000000000000000000000000000000000000aa1',
  '0x00000000000000000000000000000000000000b2',
])

const BASE_PROXY_DISCLOSURE = 'Base Sepolia proxy. Custody only. No protocol yield.'
const OFFLINE_ERROR = 'Foundation visual fixtures must not access the network'

export const FOUNDATION_OFFLINE_HOOK = () => {
  throw new Error(OFFLINE_ERROR)
}

const FOUNDATION_AMOUNT = Object.freeze({ token: 'USDC', units: '123456', decimals: 2 })
const FOUNDATION_STALE_AMOUNT = Object.freeze({ token: 'USDC', units: '98765', decimals: 2 })
const FOUNDATION_FACT_SOURCE = 'Offline fixture evidence'
const FOUNDATION_FACT_CONSEQUENCE = 'The source confirmed this fact.'
const FOUNDATION_FACT_NEXT_ACTION = 'Continue with the confirmed state.'

const factInput = Object.freeze({
  phase: 'confirmed',
  state: 'confirmed',
  value: FOUNDATION_AMOUNT,
  source: FOUNDATION_FACT_SOURCE,
  checkedAt: FOUNDATION_CLOCK.checkedAt,
  staleAfterMs: FOUNDATION_CLOCK.staleAfterMs,
  confirmedLedger: FOUNDATION_CLOCK.confirmedLedger,
  confirmedBlock: FOUNDATION_CLOCK.confirmedBlock,
  consequence: FOUNDATION_FACT_CONSEQUENCE,
  safeNextAction: FOUNDATION_FACT_NEXT_ACTION,
})

export const FOUNDATION_FACT = normalizeFact(factInput)

export const FOUNDATION_STALE_FACT = normalizeFact({
  ...factInput,
  phase: 'stale',
  state: 'stale',
  value: FOUNDATION_STALE_AMOUNT,
  consequence: 'The last verified fact may be out of date.',
  safeNextAction: 'Refresh the source before moving money.',
})

export const FOUNDATION_UNAVAILABLE_FACT = normalizeFact({
  phase: 'unknown',
  state: 'unavailable',
})

export const FOUNDATION_ATLAS_MODEL = Object.freeze({
  clock: FOUNDATION_CLOCK,
  fact: FOUNDATION_FACT,
  freshness: toFreshnessView(FOUNDATION_FACT),
  sections: Object.freeze([
    'BrandLockup',
    'NetworkBadge/NetworkRoute',
    'AgentMark',
    'MoneyFigure',
    'VenueTruth',
    'StatusNotice',
    'TechnicalDetails',
    'StageShell',
    'Dialog',
  ]),
  displayStrings: FOUNDATION_PUBLIC_STRINGS,
  baseDisclosure: BASE_PROXY_DISCLOSURE,
})

const NETWORK_CONTEXTS = Object.freeze([
  {
    label: 'Source',
    context: {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState: 'source',
    },
  },
  {
    label: 'Transit',
    context: {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState: 'burning',
    },
  },
  {
    label: 'Arrived',
    context: {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      transitState: 'arrived',
    },
  },
  {
    label: 'Failed',
    context: {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState: 'failed',
    },
  },
  {
    label: 'Missing',
    context: {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: null,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: null,
      transitState: 'unknown',
    },
  },
  {
    label: 'Unknown',
    context: {
      hostNetworkId: 'future-network',
      sourceNetworkId: 'future-network',
      destinationNetworkId: 'future-destination',
      custodyNetworkId: 'future-network',
      transitState: 'unknown',
    },
  },
])

const Section = ({ name, title, children, className = '' }) => (
  <section
    className={`pc-foundation-atlas-section${className ? ` ${className}` : ''}`}
    data-foundation-section={name}
    aria-labelledby={`foundation-${name.replace(/[^A-Za-z0-9]+/gu, '-').toLowerCase()}-heading`}
  >
    <header className="pc-foundation-atlas-section-header">
      <h2 id={`foundation-${name.replace(/[^A-Za-z0-9]+/gu, '-').toLowerCase()}-heading`}>
        {title}
      </h2>
    </header>
    {children}
  </section>
)

function NetworkAtlas() {
  return (
    <div className="pc-foundation-atlas-stack">
      <div className="pc-foundation-atlas-grid pc-foundation-atlas-network-badges">
        <NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} />
        <NetworkBadge networkId={NETWORK_IDS.BASE_SEPOLIA} />
        <NetworkBadge networkId="unrecognized-network" />
      </div>
      <div className="pc-foundation-atlas-network-states">
        {NETWORK_CONTEXTS.map(({ label, context }) => (
          <div className="pc-foundation-atlas-network-state" key={label}>
            <h3>{label}</h3>
            <NetworkRoute context={context} />
          </div>
        ))}
      </div>
    </div>
  )
}

function AgentAtlas() {
  return (
    <div className="pc-foundation-atlas-stack">
      <div className="pc-foundation-atlas-grid pc-foundation-atlas-agent-grid">
        <div className="pc-foundation-atlas-agent-row">
          <AgentMark
            identity={{ phase: 'planned', key: 'allocation-reviewed-1', source: 'reviewed-plan' }}
            state="planned"
            label="P1"
          />
          <span>Planned allocation</span>
        </div>
        <div className="pc-foundation-atlas-agent-row">
          <AgentMark
            identity={{ phase: 'planned', key: 'run-reviewed-1', source: 'reviewed-plan' }}
            state="queued"
            label="P2"
          />
          <span>Planned run</span>
        </div>
        <div className="pc-foundation-atlas-agent-row">
          <AgentMark identity={FOUNDATION_PUBLIC_STRINGS[1]} state="active" label="D1" />
          <span>Deployed proof</span>
        </div>
        <div className="pc-foundation-atlas-agent-row">
          <AgentMark identity={{ phase: 'deployed', source: 'owner-discovery' }} state="active" />
          <span>Unavailable proof</span>
        </div>
      </div>
      <p className="pc-foundation-atlas-long-value pc-technical">{FOUNDATION_PUBLIC_STRINGS[0]}</p>
      <div className="pc-foundation-atlas-display-list">
        {FOUNDATION_PUBLIC_STRINGS.slice(2).map((display) => (
          <span className="pc-foundation-atlas-long-value pc-technical" key={display}>
            {display}
          </span>
        ))}
      </div>
    </div>
  )
}

function MoneyAtlas() {
  return (
    <div className="pc-foundation-atlas-money-list">
      <MoneyFigure state="loading" amount={null} />
      <MoneyFigure state="current" amount={FOUNDATION_AMOUNT} freshness="Confirmed" />
      <MoneyFigure state="stale" amount={FOUNDATION_STALE_AMOUNT} freshness="Stale" />
      <MoneyFigure state="empty" amount={null} />
      <MoneyFigure state="error" amount={null} />
      <MoneyFigure state="unknown" amount={null} />
    </div>
  )
}

export function FoundationAtlasFixture({ theme = 'forest' }) {
  const normalizedTheme = normalizeTheme(theme)
  const [isStale, setIsStale] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const fact = isStale ? FOUNDATION_STALE_FACT : FOUNDATION_FACT

  return (
    <main
      className="pc-foundation-atlas"
      data-fixture="foundation"
      data-theme={normalizedTheme}
      data-foundation-state={fact.state}
    >
      <a className="pc-foundation-atlas-skip-link" href="#foundation-atlas-content">
        Skip to foundation atlas
      </a>
      <aside className="pc-foundation-atlas-sidebar" data-foundation-sidebar>
        <BrandLockup variant="compact" tone={normalizedTheme} />
        <nav aria-label="Foundation atlas sections">
          <a href="#foundation-atlas-content">Atlas</a>
          <a href="#foundation-dialog-heading">Dialog</a>
        </nav>
      </aside>
      <div className="pc-foundation-atlas-shell">
        <header className="pc-foundation-atlas-topbar" data-foundation-topbar>
          <BrandLockup variant="full" tone={normalizedTheme} />
          <span className="pc-foundation-atlas-topbar-status">Offline evidence fixture</span>
        </header>
        <div className="pc-foundation-atlas-content" id="foundation-atlas-content">
          <Section name="BrandLockup" title="Brand lockup">
            <div className="pc-foundation-atlas-grid pc-foundation-atlas-lockups">
              <BrandLockup variant="full" tone={normalizedTheme} />
              <BrandLockup variant="compact" tone={normalizedTheme} />
            </div>
          </Section>

          <Section name="NetworkBadge/NetworkRoute" title="Network badges and routes">
            <NetworkAtlas />
          </Section>

          <Section name="AgentMark" title="Agent marks">
            <AgentAtlas />
          </Section>

          <Section name="MoneyFigure" title="Money figures">
            <MoneyAtlas />
          </Section>

          <Section name="VenueTruth" title="Venue truth">
            <div className="pc-foundation-atlas-stack">
              <VenueTruth
                kind="stellar-live"
                venue="Autofarm Vault"
                fact={fact}
                networkContext={{
                  hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                  sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                  destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                  custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                  transitState: 'none',
                }}
              />
              <p className="pc-venue-truth-apy pc-venue-truth-apy--unavailable">
                Authoritative yield: Unavailable
              </p>
              <VenueTruth
                kind="base-proxy"
                fact={fact}
                networkContext={{
                  hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                  sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                  destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
                  custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
                  transitState: 'arrived',
                }}
              />
              <VenueTruth kind="unavailable" fact={FOUNDATION_UNAVAILABLE_FACT} />
            </div>
          </Section>

          <Section name="StatusNotice" title="Status notice">
            <div className="pc-foundation-atlas-stack" aria-live="polite">
              <StatusNotice fact={fact} title="Source-owned status" />
              <button
                className="pc-foundation-atlas-control"
                type="button"
                onClick={() => setIsStale((current) => !current)}
              >
                {isStale ? 'Restore confirmed status' : 'Show stale status'}
              </button>
            </div>
          </Section>

          <Section name="TechnicalDetails" title="Technical details">
            <TechnicalDetails summary="Technical evidence" fact={fact} open>
              <p className="pc-foundation-atlas-long-value pc-technical">
                {FOUNDATION_PUBLIC_STRINGS[3]}
              </p>
              <p className="pc-foundation-atlas-clock">
                Read at {FOUNDATION_CLOCK.nowIso} ({FOUNDATION_CLOCK.nowMs})
              </p>
            </TechnicalDetails>
          </Section>

          <Section name="StageShell" title="Stage shell">
            <StageShell
              eyebrow="Foundation evidence"
              title="Pocket Crew foundation atlas"
              description="A deterministic, offline atlas for Pocket Crew presentation primitives."
              state={fact.state}
            >
              <p>One source-owned fact is shown in friendly and technical views.</p>
            </StageShell>
          </Section>

          <Section name="Dialog" title="Dialog">
            <button
              className="pc-foundation-atlas-control"
              type="button"
              onClick={() => setDialogOpen(true)}
            >
              Open evidence dialog
            </button>
            <Dialog
              open={dialogOpen}
              title="Foundation evidence dialog"
              description="This dialog keeps focus inside the offline atlas until it is closed."
              onClose={() => setDialogOpen(false)}
              actions={
                <button
                  className="pc-foundation-atlas-control"
                  type="button"
                  onClick={() => setDialogOpen(false)}
                >
                  Close dialog
                </button>
              }
            >
              <p>Evidence is fixed at ledger {FOUNDATION_CLOCK.confirmedLedger}.</p>
            </Dialog>
          </Section>
        </div>
      </div>
    </main>
  )
}
