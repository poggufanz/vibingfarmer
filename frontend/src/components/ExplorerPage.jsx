// ExplorerPage.jsx
// Public on-chain verification surface for Vibing Farmer. No wallet required —
// judges and users can audit the static Stellar deployments and strategy
// attestations against Stellar testnet directly.
//
// Aesthetic: matches LandingHero's editorial-finance terminal — one dominant
// surface, single accent, mono for every address/hash/stat. Inherits Pocket
// Crew's semantic tokens so it re-themes with the rest of the app.

import { useEffect, useState } from 'react'
import { getStrategies } from '../history.js'
import { SOROBAN_DECIMALS } from '../stellar/config.js'
import { readTotalAssets } from '../stellar/vaultReads.js'
import { NETWORK_IDS } from '../design/networks.js'
import { formatCoreAmount, normalizeCoreAmount } from '../core/coreRouteAdapters.js'
import { toExplorerPresentation } from '../secondary/secondaryRouteAdapters.js'
import { StatusNotice, TechnicalDetails } from './pocket/Primitives.jsx'
import { NetworkRoute } from './pocket/NetworkIdentity.jsx'
import {
  EXTERNAL_PROTOCOL_COUNT,
  FIRST_PARTY_DEPLOYMENT_COUNT,
  SOROBAN_SOURCE_CRATES,
  STATIC_ADDRESS_COUNT,
  STELLAR_STATIC_DEPLOYMENTS,
} from '../stellar/deploymentFacts.js'
import NavBar from './NavBar.jsx'
import './ExplorerPage.css'

/* ----------------------------- constants ----------------------------- */

const STELLAR_EXPERT = 'https://stellar.expert/explorer/testnet/contract/'
const ACTIVE_VAULT_ADDRESS = STELLAR_STATIC_DEPLOYMENTS.find(
  ({ id }) => id === 'autofarm-vault'
).address
const DECIMALS_DIV = 10 ** SOROBAN_DECIMALS

async function fetchTotalDeposits() {
  const assets = await readTotalAssets()
  if (assets == null) return null
  return Number(assets) / DECIMALS_DIV
}

const SECURITY = [
  'Funding Router grants limit the total budget and expiry',
  'Owners can revoke the router allowance and agent access',
  'Agent account __check_auth accepts only its scoped signer and approved operations',
  'The fee-bump relay accepts allowlisted Soroban operations and rate-limits callers',
  'Soroban auth nonces and signature-expiration ledgers prevent replay',
  'SHA-256 strategy hashes make saved strategies tamper-evident',
]

/* ----------------------------- helpers ----------------------------- */

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s} sec ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`
  const d = Math.floor(h / 24)
  return `${d} day${d > 1 ? 's' : ''} ago`
}

const shortHash = (h) => (h ? `${String(h).slice(0, 10)}…` : '0x…')

/* ----------------------------- pieces ----------------------------- */

function OwnershipBadge({ ownership }) {
  return <span className={`ex-badge ex-badge--${ownership}`}>{ownership}</span>
}

function ContractCard({ contract, copied, onCopy }) {
  const isCopied = copied === contract.address
  return (
    <article className="ex-card">
      <div className="ex-card__head">
        <h3 className="ex-card__name">
          {contract.name}
          {contract.protocol && <span className="ex-card__proto">, {contract.protocol}</span>}
        </h3>
        <OwnershipBadge ownership={contract.ownership} />
      </div>

      <button
        className="ex-addr"
        onClick={() => onCopy(contract.address)}
        title="Click to copy"
        aria-label={`Copy address ${contract.address}`}
      >
        <span className="ex-addr__text">{contract.address}</span>
        <span className={`ex-addr__copy${isCopied ? ' is-copied' : ''}`}>
          {isCopied ? 'Copied' : 'Copy'}
        </span>
      </button>

      <p className="ex-card__desc">{contract.role}</p>

      <div className="ex-card__links">
        <a
          className="ex-extlink"
          href={`${STELLAR_EXPERT}${contract.address}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          View on Stellar Expert
        </a>
      </div>
    </article>
  )
}

function StatBlock({ label, value, loading, factView, factKey }) {
  const state = factView?.fact?.state
  return (
    <div
      className="ex-stat"
      data-fact-key={factKey}
      data-fact-state={state || undefined}
      data-fact-value={value == null ? 'null' : String(value)}
    >
      <div className="ex-stat__value">
        {loading ? <span className="ex-skeleton" aria-hidden="true" /> : value}
      </div>
      <div className="ex-stat__label">{label}</div>
    </div>
  )
}

function readAmount(value) {
  if (value == null) return null
  try {
    return normalizeCoreAmount(value)
  } catch {
    return null
  }
}

function factForPrimitive(view) {
  if (!view?.fact) return null
  return {
    ...view.fact,
    consequence: view.notice?.consequence ?? view.fact.consequence,
    safeNextAction: view.notice?.nextAction ?? view.fact.safeNextAction,
  }
}

function ExplorerFactStatus({ factView, title, factKey, includeDetails = true }) {
  const fact = factForPrimitive(factView)
  if (!fact) return null
  const unavailableCopy = factView.notice?.consequence && (
    <div className="ex-notice-copy" role="note">
      <p>{factView.notice.consequence}</p>
      {factView.notice.nextAction && <p>{factView.notice.nextAction}</p>}
    </div>
  )

  return (
    <section
      className="ex-evidence"
      aria-label={title}
      data-fact-key={factKey}
      data-fact-state={fact.state}
    >
      <StatusNotice fact={fact} title={title} />
      {fact.state === 'unavailable' && unavailableCopy}
      {includeDetails && <TechnicalDetails summary="Technical details" fact={fact} open />}
    </section>
  )
}

// Decoded strategy_hash arrives as bytes (BytesN<32>); normalize to a 0x-hex string.
function hashHex(v) {
  if (!v) return ''
  if (typeof v === 'string') return v.startsWith('0x') ? v : '0x' + v
  try {
    return '0x' + Buffer.from(v).toString('hex')
  } catch {
    return String(v)
  }
}

const TX_BASE = 'https://stellar.expert/explorer/testnet/tx/'

function AttestationsTable({ strategies, initialOnchain = [] }) {
  // On-chain strategy_attested events — the public, immutable proof. Polled best-effort;
  // the localStorage rows below stay as a fallback so the table is never empty pre-attest.
  const [onchain, setOnchain] = useState(() =>
    Array.isArray(initialOnchain) ? initialOnchain : []
  )
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { rpcServer } = await import('../stellar/client.js')
        const { pollEvents } = await import('../stellar/events.js')
        const server = await rpcServer()
        const { sequence } = await server.getLatestLedger()
        const startLedger = Math.max(1, sequence - 8000)
        const { events } = await pollEvents({ server, startLedger })
        if (alive) setOnchain(events.filter((e) => e.type === 'strategy_attested'))
      } catch {
        /* non-blocking — table still shows localStorage rows */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  if (!strategies.length && !onchain.length) {
    return (
      <div className="ex-empty">
        No attestations yet. Start a strategy to see on-chain evidence.
      </div>
    )
  }
  return (
    <div className="ex-table-wrap">
      <table className="ex-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Strategy Hash</th>
            <th>Protocol</th>
          </tr>
        </thead>
        <tbody>
          {onchain.map((e) => (
            <tr key={e.cursor || e.txHash}>
              <td className="ex-table__time">Ledger {e.ledger}</td>
              <td className="ex-table__hash">
                <a href={`${TX_BASE}${e.txHash}`} target="_blank" rel="noreferrer">
                  {shortHash(hashHex(e.data?.strategy_hash))}
                </a>
              </td>
              <td className="ex-table__proto">{String(e.data?.label || 'On-chain')}</td>
            </tr>
          ))}
          {strategies.map((s) => (
            <tr key={s.id || s.strategyHash || s.timestamp}>
              <td className="ex-table__time">{timeAgo(s.timestamp || s.savedAt || Date.now())}</td>
              <td className="ex-table__hash">{shortHash(s.strategyHash)}</td>
              <td className="ex-table__proto">
                {s.vaultsSelected?.[0]?.protocol || 'Not available'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------ page ------------------------------ */

export default function ExplorerPage({ explorerRead } = {}) {
  const [copied, setCopied] = useState(null)
  const [totalDeposits, setTotalDeposits] = useState(undefined)
  const [strategies] = useState(() => getStrategies().slice(0, 5))
  const attestationCount = getStrategies().length

  useEffect(() => {
    if (explorerRead != null) return undefined
    let alive = true
    fetchTotalDeposits()
      .then((value) => {
        if (alive) setTotalDeposits(value)
      })
      .catch(() => {
        if (alive) setTotalDeposits(null)
      })
    return () => {
      alive = false
    }
  }, [explorerRead])

  const copy = (address) => {
    navigator.clipboard
      ?.writeText(address)
      .then(() => {
        setCopied(address)
        setTimeout(() => setCopied((c) => (c === address ? null : c)), 2000)
      })
      .catch(() => {})
  }

  const loadingDeposits = totalDeposits === undefined
  const fallbackState = loadingDeposits ? 'loading' : 'unavailable'
  const fallbackRead = {
    fact: {
      state: fallbackState,
      value: null,
      source: 'Soroban RPC',
      checkedAt: null,
      staleAfterMs: null,
    },
    facts: {
      totalAssets: {
        state: fallbackState,
        value: null,
        source: 'Soroban RPC',
        checkedAt: null,
        staleAfterMs: null,
      },
    },
    totalDeposits,
    strategies,
  }
  const settledRead = explorerRead ?? fallbackRead
  const presentation = toExplorerPresentation(settledRead)
  const factViews = presentation.facts || {}
  const totalAssetsView = factViews.totalAssets || factViews.tvl || factViews.rpc
  const totalAssetsStatView = totalAssetsView || presentation
  const directTotalAssets = readAmount(explorerRead?.totalAssets ?? explorerRead?.amount)
  const totalAssetsState = totalAssetsView?.fact?.state || presentation.fact.state
  const totalAssetsValue = totalAssetsView
    ? totalAssetsView.value
    : ['loading', 'error', 'unavailable'].includes(totalAssetsState)
      ? null
      : (directTotalAssets ?? presentation.value)
  const hasInjectedRead = explorerRead != null
  const depositsLabel = hasInjectedRead
    ? totalAssetsValue
      ? formatCoreAmount(totalAssetsValue)
      : 'Not available'
    : totalDeposits == null
      ? 'Not available'
      : `${totalDeposits.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC`
  const depositsLoading = hasInjectedRead ? totalAssetsState === 'loading' : loadingDeposits
  const displayedStrategies = Array.isArray(explorerRead?.strategies)
    ? explorerRead.strategies
    : strategies
  const attestationView =
    factViews.attestations || factViews.attestation || factViews.strategyAttestations
  const attestationState = attestationView?.fact?.state
  const effectiveAttestationState =
    attestationState || (hasInjectedRead ? presentation.fact.state : null)
  const attestationUnavailable = ['error', 'unavailable', 'partial'].includes(
    effectiveAttestationState
  )
  const attestationLoading = effectiveAttestationState === 'loading'
  const displayedAttestationCount = hasInjectedRead
    ? attestationUnavailable
      ? 'Not available'
      : String(displayedStrategies.length)
    : attestationCount > 0
      ? `${attestationCount}`
      : 'Not available'
  const initialOnchain = Array.isArray(explorerRead?.onchain) ? explorerRead.onchain : []
  return (
    <div className="ex-page">
      <NavBar />

      <main className="ex-main">
        {/* ---------- header ---------- */}
        <header className="ex-header">
          <div className="ex-header__top">
            <h1 className="ex-title">Explorer</h1>
            <NetworkRoute
              compact
              context={{
                hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
                transitState: 'none',
              }}
            />
          </div>
          <p className="ex-lede">
            8 static Stellar testnet addresses: 6 Vibing Farmer deployments and 2 external protocol
            contracts. Agent accounts are created dynamically per run.
          </p>
        </header>

        <ExplorerFactStatus factView={presentation} title="Explorer read" factKey="explorer" />

        {/* ---------- contracts ---------- */}
        <section className="ex-section" aria-labelledby="ex-contracts">
          <h2 id="ex-contracts" className="ex-section__title">
            Deployed Contracts
          </h2>
          <div className="ex-cards">
            {STELLAR_STATIC_DEPLOYMENTS.map((c) => (
              <ContractCard key={c.address + c.name} contract={c} copied={copied} onCopy={copy} />
            ))}
          </div>
        </section>

        {/* ---------- read stats ---------- */}
        <section className="ex-section" aria-labelledby="ex-stats">
          <div className="ex-section__head">
            <h2 id="ex-stats" className="ex-section__title">
              Deployment Facts
            </h2>
            <span className="ex-section__note">{STATIC_ADDRESS_COUNT} static addresses</span>
          </div>
          <div className="ex-stats">
            <StatBlock label="Soroban source crates" value={SOROBAN_SOURCE_CRATES.length} />
            <StatBlock label="VF deployments" value={FIRST_PARTY_DEPLOYMENT_COUNT} />
            <StatBlock label="Protocol contracts" value={EXTERNAL_PROTOCOL_COUNT} />
            <StatBlock label="Dynamic agents" value="N per run" />
            <StatBlock
              label="Vault TVL"
              value={depositsLabel}
              loading={depositsLoading}
              factView={totalAssetsStatView}
              factKey="totalAssets"
            />
            <StatBlock
              label="Strategy Attestations"
              value={displayedAttestationCount}
              loading={attestationLoading}
              factView={attestationView || (hasInjectedRead ? presentation : undefined)}
              factKey="attestations"
            />
          </div>
        </section>

        {/* ---------- attestations ---------- */}
        <section className="ex-section" aria-labelledby="ex-attest">
          <h2 id="ex-attest" className="ex-section__title">
            Strategy Attestations
          </h2>
          <p className="ex-section__sub">
            Recent strategy hashes (SHA-256, off-chain verifiable; re-derivable from the strategy
            JSON):
          </p>
          {attestationView && attestationState !== 'current' && (
            <ExplorerFactStatus
              factView={attestationView}
              title="Attestation read"
              factKey="attestations"
              includeDetails={false}
            />
          )}
          <AttestationsTable strategies={displayedStrategies} initialOnchain={initialOnchain} />
          <a
            className="ex-extlink ex-extlink--block"
            href={`${STELLAR_EXPERT}${ACTIVE_VAULT_ADDRESS}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            View the vault on Stellar Expert
          </a>
        </section>

        {/* ---------- security ---------- */}
        <section className="ex-section" aria-labelledby="ex-security">
          <h2 id="ex-security" className="ex-section__title">
            Security
          </h2>
          <ul className="ex-seclist">
            {SECURITY.map((item) => (
              <li key={item} className="ex-secitem">
                {item}
              </li>
            ))}
          </ul>
          <p className="ex-disclaimer">
            Unaudited (hackathon scope). Production deployment requires third-party audit.
          </p>
        </section>

        {/* ---------- open source ---------- */}
        <section className="ex-section ex-section--os" aria-labelledby="ex-os">
          <h2 id="ex-os" className="ex-section__title">
            Open Source
          </h2>
          <div className="ex-oslist">
            <div className="ex-osrow">
              <span className="ex-osrow__k">GitHub</span>
              <a
                className="ex-osrow__v"
                href="https://github.com/poggufanz/vibingfarmer"
                target="_blank"
                rel="noreferrer noopener"
              >
                github.com/poggufanz/vibingfarmer
              </a>
            </div>
            <div className="ex-osrow">
              <span className="ex-osrow__k">License</span>
              <span className="ex-osrow__v">MIT</span>
            </div>
          </div>
        </section>

        <footer className="ex-foot">
          <span className="ex-foot__mark">vibing / farmer</span>
          <span className="ex-foot__tag">Set once. Vibe forever.</span>
        </footer>
      </main>
    </div>
  )
}
/* ------------------------------ styles ------------------------------ */

function ExplorerStyle() {
  return (
    <style>{`
/* Own scroll container - the app locks body/#root (overflow:hidden, height:100vh),
   so normal document flow can't scroll. Fixed + overflow-y:auto, same as the hero. */
.ex-page {
  position: fixed;
  inset: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background: var(--bg-base);
  color: var(--text);
  font-family: var(--font-body);
}
/* Grid-texture ::before removed: a linear-gradient pair masked by a radial-gradient is still
   a gradient (contract rule 7 bans them outright), and it was decorative, not load-bearing. */

.ex-main {
  position: relative;
  z-index: 1;
  max-width: 1040px;
  margin: 0 auto;
  padding: calc(64px + clamp(2.5rem, 7vw, 5rem)) clamp(1.1rem, 5vw, 2.6rem) 4rem;
}

/* ---------- header ---------- */
.ex-header { padding-bottom: clamp(2rem, 5vw, 3.4rem); border-bottom: 1px solid var(--border); }
.ex-header__top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.ex-title {
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1;
  font-size: clamp(2.6rem, 7vw, 4.6rem);
  color: var(--text);
}
.ex-net {
  display: inline-flex;
  align-items: center;
  gap: 0.55ch;
  font-family: var(--font-body);
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.ex-net__dot {
  position: relative;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent);
}
.ex-net__dot::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: inherit;
  animation: ex-pulse 2.4s var(--ease-out) infinite;
}
@keyframes ex-pulse {
  0% { opacity: 0.55; transform: scale(1); }
  70%, 100% { opacity: 0; transform: scale(2.8); }
}
.ex-lede {
  margin-top: 1.1rem;
  max-width: 60ch;
  font-family: var(--font-body);
  font-size: clamp(0.82rem, 1.1vw, 0.95rem);
  line-height: 1.7;
  color: var(--text-muted);
}

/* ---------- sections ---------- */
.ex-section { padding: clamp(2.2rem, 5vw, 3.6rem) 0; border-bottom: 1px solid var(--border); }
.ex-section--os { border-bottom: none; }
.ex-section__head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.ex-section__title {
  font-family: var(--font-body);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent-text);
  margin-bottom: 1.5rem;
}
.ex-section__head .ex-section__title { margin-bottom: 0; }
.ex-section__note, .ex-section__sub {
  font-family: var(--font-body);
  font-size: 0.72rem;
  letter-spacing: 0.02em;
  color: var(--text-faint);
}
.ex-section__sub { display: block; margin: -0.6rem 0 1.3rem; font-size: 0.8rem; color: var(--text-muted); }

/* ---------- contract cards ---------- */
.ex-cards { display: flex; flex-direction: column; gap: 0.7rem; }
.ex-card {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  padding: clamp(1.05rem, 2.4vw, 1.5rem);
  transition: border-color 220ms ease, transform 220ms cubic-bezier(0.16,1,0.3,1);
}
.ex-card:hover { border-color: var(--border-accent); }
.ex-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.ex-card__name {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.02rem, 1.6vw, 1.2rem);
  letter-spacing: -0.01em;
  color: var(--text);
}
/* Mono: a protocol/version string ("Blend v2", "SAC"), not prose. */
.ex-card__proto { font-family: var(--font-mono); font-weight: 400; font-size: 0.82em; color: var(--text-muted); }
/* Badge chrome ("CORE CONTRACT" / "VAULT" / "TOKEN"), not a raw value -- body face. */
.ex-badge {
  flex-shrink: 0;
  font-family: var(--font-body);
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  padding: 0.3rem 0.6rem;
  border-radius: var(--radius-sm);
  text-transform: uppercase;
  white-space: nowrap;
}
.ex-badge--first-party { color: var(--accent-fg); background: var(--accent); }
.ex-badge--external { color: var(--text-muted); background: var(--bg-elev); border: 1px solid var(--border); }

.ex-addr {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 0.7ch;
  margin: 0.85rem 0 0.7rem;
  max-width: 100%;
  cursor: pointer;
  background: var(--bg-base);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.45rem 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text);
  transition: border-color 180ms ease, background 180ms ease;
}
.ex-addr:hover { border-color: var(--border-accent); }
.ex-addr:active { transform: scale(0.97); }
.ex-addr__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* "Copy"/"Copied" is a UI action word, not a raw value -- override the mono inherited from
   .ex-addr (which is correctly mono for the address text itself). */
.ex-addr__copy {
  flex-shrink: 0;
  font-family: var(--font-body);
  font-size: 0.64rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
  transition: color 180ms ease;
}
.ex-addr:hover .ex-addr__copy { color: var(--text-muted); }
.ex-addr__copy.is-copied { color: var(--accent-text); }
.ex-addr:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.ex-card__desc {
  font-family: var(--font-body);
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--text-muted);
}
.ex-card__links { display: flex; flex-wrap: wrap; gap: 1.2rem; margin-top: 1rem; }

.ex-extlink {
  font-family: var(--font-body);
  font-size: 0.76rem;
  letter-spacing: 0.01em;
  color: var(--accent-text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  transition: opacity 160ms ease;
}
.ex-extlink span { transition: transform 200ms cubic-bezier(0.16,1,0.3,1); }
.ex-extlink:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ex-extlink--block { margin-top: 1.3rem; }

/* ---------- live stats ---------- */
.ex-stats {
  margin-top: 1.5rem;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.7rem;
}
.ex-stat {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  padding: 1.3rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.ex-stat__value {
  font-family: var(--font-mono);
  font-size: clamp(1.35rem, 2.6vw, 1.85rem);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text);
  line-height: 1;
  min-height: 1.1em;
  display: flex;
  align-items: center;
}
.ex-stat__label {
  font-family: var(--font-body);
  font-size: 0.68rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.ex-skeleton {
  display: inline-block;
  width: 60%;
  height: 1em;
  border-radius: var(--radius-sm);
  background: var(--bg-elev-2);
  opacity: 0.72;
}

/* ---------- attestations table ---------- */
.ex-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--border-strong); border-radius: var(--radius-lg); }
.ex-table { width: 100%; border-collapse: collapse; min-width: 460px; }
/* Base cell rule carries layout only; mono/body split lives on thead th vs. the per-column
   classes below so a raw hash can stay mono while its header caption reads as prose. */
.ex-table th, .ex-table td { text-align: left; padding: 0.85rem 1.1rem; font-size: 0.78rem; }
.ex-table thead th {
  font-family: var(--font-body);
  font-size: 0.66rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.ex-table tbody tr { border-bottom: 1px solid var(--border); transition: background 160ms ease; }
.ex-table tbody tr:last-child { border-bottom: none; }
.ex-table tbody tr:hover { background: var(--bg-elev); }
/* Ledger sequence numbers / relative-time strings -- a real ledger reference at least some of
   the time, so left mono rather than risk demoting a genuine identifier. */
.ex-table__time { font-family: var(--font-mono); color: var(--text-muted); white-space: nowrap; }
.ex-table__hash { font-family: var(--font-mono); color: var(--accent-text); }
/* Protocol/category name (e.g. "Blend v2", "On-chain"), same identifier role as .ex-card__proto. */
.ex-table__proto { font-family: var(--font-mono); color: var(--text); }
.ex-empty {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  padding: 2.2rem 1.5rem;
  text-align: center;
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--text-faint);
}

/* ---------- security ---------- */
.ex-seclist { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0.55rem 1.6rem; }
.ex-secitem {
  position: relative;
  padding-left: 1.4rem;
  font-family: var(--font-body);
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-muted);
}
.ex-secitem::before {
  content: "";
  position: absolute;
  left: 0; top: 0.5em;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
.ex-disclaimer {
  margin-top: 1.6rem;
  padding: 0.85rem 1.1rem;
  border-left: 2px solid var(--border-accent);
  font-family: var(--font-body);
  font-size: 0.76rem;
  line-height: 1.6;
  color: var(--text-faint);
  background: var(--accent-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

/* ---------- open source ---------- */
.ex-oslist { display: flex; flex-direction: column; gap: 0.1rem; }
.ex-osrow {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border);
}
.ex-osrow:last-child { border-bottom: none; }
.ex-osrow__k {
  flex-shrink: 0;
  width: 110px;
  font-family: var(--font-body);
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
/* Mono: renders a URL or a license identifier ("MIT") -- both raw values. */
.ex-osrow__v {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  color: var(--text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
}
a.ex-osrow__v { color: var(--accent-text); }
a.ex-osrow__v span { transition: transform 200ms cubic-bezier(0.16,1,0.3,1); }

@media (hover: hover) and (pointer: fine) {
  .ex-card:hover { transform: translateY(-2px); }
  .ex-extlink:hover span,
  a.ex-osrow__v:hover span { transform: translate(2px, -2px); }
}

@media (prefers-reduced-motion: reduce) {
  .ex-net__dot::after { animation: none; opacity: 0; }
  .ex-card,
  .ex-addr,
  .ex-extlink span,
  a.ex-osrow__v span { transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease; }
  .ex-card:hover,
  .ex-addr:active,
  .ex-extlink:hover span,
  a.ex-osrow__v:hover span { transform: none; }
}

/* ---------- footer ---------- */
.ex-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 3rem;
  padding-top: 1.8rem;
  border-top: 1px solid var(--border);
}
.ex-foot__mark { font-family: var(--font-body); font-size: 0.78rem; color: var(--text-muted); }
.ex-foot__tag { font-family: var(--font-script); font-style: italic; font-size: 0.95rem; color: var(--text-faint); }

/* ---------- responsive ---------- */
@media (max-width: 760px) {
  .ex-stats { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 420px) {
  .ex-stats { grid-template-columns: 1fr; }
  .ex-addr__text { font-size: 0.7rem; }
}
`}</style>
  )
}
