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
