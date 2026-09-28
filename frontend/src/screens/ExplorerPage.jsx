// ExplorerPage.jsx
// Public on-chain verification surface for Vibing Farmer. No wallet required —
// judges and users can audit the static Stellar deployments and strategy
// attestations against Stellar testnet directly.
//
// Aesthetic (2026-09-28): the same grained instrument material as History, Risks and Settings.
// A recessed readout strip under the title, then the money path (the one bold element: grant ->
// agents -> vault -> strategy -> pool, each stop linked to its address row), a contract register,
// the attestation ledger and the security plate. Mono is only for real addresses and hashes.

import { useEffect, useState } from 'react'
import { getStrategies } from '../history/history.js'
import { SOROBAN_DECIMALS } from '../stellar/config.js'
import { readPendingUpgrade, readTotalAssets } from '../stellar/vaultReads.js'
import { NETWORK_IDS } from '../design/networks.js'
import { formatCoreAmount, normalizeCoreAmount } from '../core/coreRouteAdapters.js'
import { toExplorerPresentation } from '../secondary/secondaryRouteAdapters.js'
import { StatusNotice, TechnicalDetails } from '../components/pocket/Primitives.jsx'
import { NetworkBadge } from '../components/pocket/NetworkIdentity.jsx'
import {
  EXTERNAL_PROTOCOL_COUNT,
  FIRST_PARTY_DEPLOYMENT_COUNT,
  SOROBAN_SOURCE_CRATES,
  STATIC_ADDRESS_COUNT,
  STELLAR_STATIC_DEPLOYMENTS,
  VAULT_UPGRADE_SAFETY,
} from '../stellar/deploymentFacts.js'
import NavBar from '../components/NavBar.jsx'
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

// P1 G8: vault upgrade-safety facts, sourced from VAULT_UPGRADE_SAFETY (itself derived from
// deployments/stellar-testnet.json::autofarmVault — admin address verbatim, threshold/timelock
// restating its adminNote; deploymentFacts.test.js pins both). Signer labels (master,
// vf-admin-2, vf-admin-3) are that note's own names; only public addresses ever render.
const VAULT_ADMIN_SHORT = `${VAULT_UPGRADE_SAFETY.admin.slice(0, 8)}…${VAULT_UPGRADE_SAFETY.admin.slice(-4)}`

const SECURITY = [
  'Funding Router grants limit the total budget and expiry',
  'Owners can revoke the router allowance and agent access',
  'Agent account __check_auth accepts only its scoped signer and approved operations',
  'The fee-bump relay accepts allowlisted Soroban operations and rate-limits callers',
  'Soroban auth nonces and signature-expiration ledgers prevent replay',
  'SHA-256 strategy hashes make saved strategies tamper-evident',
  `Vault admin is a ${VAULT_UPGRADE_SAFETY.threshold} multisig (master ${VAULT_ADMIN_SHORT} plus vf-admin-2 and vf-admin-3); no single key can move or upgrade the vault`,
  `Vault upgrades wait ${VAULT_UPGRADE_SAFETY.timelockDays} days from schedule to executable, and can be cancelled while pending`,
  'Redeem is never pause-gated; holders can always exit',
]

const DEPLOYMENT_BY_ID = Object.fromEntries(STELLAR_STATIC_DEPLOYMENTS.map((c) => [c.id, c]))

// The route a deposit actually travels. Agent accounts have no static address (one set is
// created per run), so that stop is drawn dashed and does not link to a register row. Step
// numbers come from a CSS counter, never DOM text.
const MONEY_PATH = [
  { id: 'funding-router-v2', does: 'Holds your one signature: budget and expiry' },
  { id: 'agents', name: 'Agent accounts', does: 'Created per run; sign only scoped moves' },
  { id: 'autofarm-vault', does: 'Takes deposits and issues vault shares' },
  { id: 'blend-strategy', does: 'Moves vault USDC into lending' },
  { id: 'blend-pool', does: 'Pays the lending interest' },
]
const ON_PATH = new Set(MONEY_PATH.map(({ id }) => id))
const OFF_PATH = STELLAR_STATIC_DEPLOYMENTS.filter(({ id }) => !ON_PATH.has(id))

const CONTRACT_GROUPS = [
  {
    ownership: 'first-party',
    title: 'Vibing Farmer contracts',
    hint: 'Deployed and administered by this project',
  },
  {
    ownership: 'external',
    title: 'External protocols',
    hint: 'Third-party contracts the vault depends on',
  },
]

// One lamp vocabulary for every read on the page: harvest lime only for a current chain read.
const READ_TONE = {
  loading: 'idle',
  current: 'live',
  stale: 'warn',
  empty: 'idle',
  partial: 'warn',
  error: 'danger',
  unavailable: 'idle',
}
const READ_LABEL = {
  loading: 'Checking',
  current: 'Current',
  stale: 'Stale',
  empty: 'Empty',
  partial: 'Partial',
  error: 'Failed',
  unavailable: 'Unverified',
}
const OPEN_SOURCE_STATES = new Set(['error', 'stale', 'partial'])

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

const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`
const shortHash = (h) => (h ? `${String(h).slice(0, 10)}…` : '0x…')

// P1 G8: live timelock status for the Security plate — the first UI consumer of
// vaultReads.js::readPendingUpgrade (previously read by tests only). `injected === undefined`
// means "read the chain" (public page, no wallet); any other value (including null) is the
// ExplorerPage explorerRead seam for tests. null covers BOTH "nothing scheduled" and "RPC
// failed" — readPendingUpgrade deliberately conflates them — so the copy says "found", never
// "scheduled: none", and the lamp stays grey rather than claiming a verified all-clear.
// ETA is a Unix-seconds ledger timestamp (vault.rs TIMELOCK_DELAY_S).
function formatUpgradeEta(eta) {
  if (!Number.isFinite(eta) || eta <= 0) return null
  return `${new Date(eta * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function upgradeCopy(injected, live) {
  if (injected === undefined && live === undefined) {
    return { tone: 'idle', text: 'Checking the vault for a pending upgrade…' }
  }
  const pending = injected === undefined ? live : injected
  if (pending == null) return { tone: 'idle', text: 'No pending upgrade found on the vault.' }
  const hash =
    typeof pending.wasmHashHex === 'string' && pending.wasmHashHex
      ? shortHash(`0x${pending.wasmHashHex}`)
      : 'hash unavailable'
  const when = formatUpgradeEta(pending.eta)
  return {
    tone: 'warn',
    text: `Upgrade scheduled: wasm ${hash}${
      when ? `, executable after ${when}` : '; executable date unavailable'
    }. Holders can redeem out before it executes.`,
  }
}

function PendingUpgradeStatus({ injected }) {
  const [live, setLive] = useState(undefined)
  useEffect(() => {
    if (injected !== undefined) return undefined
    let alive = true
    Promise.resolve()
      .then(() => (typeof readPendingUpgrade === 'function' ? readPendingUpgrade() : null))
      .then((v) => {
        if (alive) setLive(v ?? null)
      })
      .catch(() => {
        if (alive) setLive(null)
      })
    return () => {
      alive = false
    }
  }, [injected])
  const { tone, text } = upgradeCopy(injected, live)
  return (
    <div className="ex-upgrade" data-tone={tone}>
      <p className="ex-upgrade__label">
        <span className="ex-lamp" aria-hidden="true" />
        Upgrade queue
      </p>
      <p className="ex-upgrade__text">{text}</p>
    </div>
  )
}

/* ----------------------------- pieces ----------------------------- */

function ContractRow({ contract, copied, onCopy }) {
  const isCopied = copied === contract.address
  return (
    <li className="ex-row" id={`ex-contract-${contract.id}`}>
      <div className="ex-row__id">
        <h4 className="ex-row__name">{contract.name}</h4>
        <p className="ex-row__role">{contract.role}</p>
        <a
          className="ex-extlink"
          href={`${STELLAR_EXPERT}${contract.address}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          View on Stellar Expert
        </a>
      </div>
      <button
        type="button"
        className="ex-addr"
        onClick={() => onCopy(contract.address)}
        title="Click to copy"
        aria-label={`Copy address ${contract.address}`}
      >
        <span className="ex-addr__text pc-technical">{contract.address}</span>
        <span className={`ex-addr__copy${isCopied ? ' is-copied' : ''}`}>
          {isCopied ? 'Copied' : 'Copy'}
        </span>
      </button>
    </li>
  )
}

function MoneyPath() {
  return (
    <ol className="ex-path">
      {MONEY_PATH.map((stop) => {
        const contract = DEPLOYMENT_BY_ID[stop.id]
        const body = (
          <>
            <span className="ex-path__name">{contract?.name ?? stop.name}</span>
            <span className="ex-path__does">{stop.does}</span>
            <span className={`ex-path__addr${contract ? ' pc-technical' : ''}`}>
              {contract ? shortAddress(contract.address) : 'No fixed address'}
            </span>
          </>
        )
        return (
          <li
            key={stop.id}
            className="ex-path__stop"
            data-kind={contract ? contract.ownership : 'dynamic'}
          >
            {contract ? (
              <a className="ex-path__link" href={`#ex-contract-${contract.id}`}>
                {body}
              </a>
            ) : (
              <div className="ex-path__link">{body}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// A value in the header strip. Data attributes keep the read state auditable in the DOM.
function StatBlock({ label, value, loading, factView, factKey }) {
  const state = factView?.fact?.state
  return (
    <div
      className="ex-readout"
      data-fact-key={factKey}
      data-fact-state={state || undefined}
      data-fact-value={value == null ? 'null' : String(value)}
      data-tone={READ_TONE[state] || 'idle'}
    >
      <dt>
        <span className="ex-lamp" aria-hidden="true" />
        {label}
      </dt>
      <dd>{loading ? <span className="ex-skeleton" aria-hidden="true" /> : value}</dd>
    </div>
  )
}

function Fact({ label, value }) {
  return (
    <div className="ex-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
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

// Provenance for the strip above it. It opens by itself only when the read needs attention;
// otherwise the peek pill carries the state, so a closed drawer never hides a failure.
function ReadSource({ factView }) {
  const state = factView?.fact?.state
  if (!state) return null
  return (
    <details className="ex-source" open={OPEN_SOURCE_STATES.has(state)}>
      <summary className="ex-source__summary">
        <span className="ex-source__title">Where these numbers come from</span>
        <span className="ex-source__hint">
          Vault reads from Soroban RPC, addresses from the deployment manifest
        </span>
        <span className="ex-peek" data-tone={READ_TONE[state] || 'idle'}>
          <span className="ex-lamp" aria-hidden="true" />
          {READ_LABEL[state] || 'Unverified'}
        </span>
      </summary>
      <div className="ex-source__body">
        <ExplorerFactStatus factView={factView} title="Explorer read" factKey="explorer" />
      </div>
    </details>
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
        <p className="ex-empty__title">No attestations yet</p>
        <p className="ex-empty__next">
          Each approved strategy leaves its hash here. Start a strategy in the app to add the first
          one.
        </p>
      </div>
    )
  }
  return (
    <div className="ex-table-wrap">
      <table className="ex-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Strategy hash</th>
            <th scope="col">Protocol</th>
          </tr>
        </thead>
        <tbody>
          {onchain.map((e) => (
            <tr key={e.cursor || e.txHash}>
              <td className="ex-table__time">Ledger {e.ledger}</td>
              <td className="ex-table__hash">
                <a
                  className="pc-technical"
                  href={`${TX_BASE}${e.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortHash(hashHex(e.data?.strategy_hash))}
                </a>
              </td>
              <td className="ex-table__proto">{String(e.data?.label || 'On-chain')}</td>
            </tr>
          ))}
          {strategies.map((s) => (
            <tr key={s.id || s.strategyHash || s.timestamp}>
              <td className="ex-table__time">{timeAgo(s.timestamp || s.savedAt || Date.now())}</td>
              <td className="ex-table__hash">
                <span className="pc-technical">{shortHash(s.strategyHash)}</span>
              </td>
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
        {/* ---------- header: title, readout strip, provenance ---------- */}
        <header className="ex-header">
          <h1 className="ex-title">Explorer</h1>
          <p className="ex-lede">
            8 static Stellar testnet addresses: 6 Vibing Farmer deployments and 2 external protocol
            contracts. Agent accounts are created dynamically per run.
          </p>

          <div className="ex-console">
            <dl className="ex-strip">
              <div className="ex-readout">
                <dt>Network</dt>
                <dd>
                  <NetworkBadge networkId={NETWORK_IDS.STELLAR_TESTNET} />
                </dd>
              </div>
              <StatBlock
                label="Vault TVL"
                value={depositsLabel}
                loading={depositsLoading}
                factView={totalAssetsStatView}
                factKey="totalAssets"
              />
              <StatBlock
                label="Strategy attestations"
                value={displayedAttestationCount}
                loading={attestationLoading}
                factView={attestationView || (hasInjectedRead ? presentation : undefined)}
                factKey="attestations"
              />
              <div className="ex-readout">
                <dt>Upgrade delay</dt>
                <dd>{VAULT_UPGRADE_SAFETY.timelockDays} days</dd>
              </div>
            </dl>
            <ReadSource factView={presentation} />
          </div>
        </header>

        {/* ---------- money path ---------- */}
        <section className="ex-plate" aria-labelledby="ex-path">
          <div className="ex-plate__head">
            <h2 id="ex-path" className="ex-plate__title">
              Where a deposit goes
            </h2>
            <p className="ex-plate__lede">
              Follow one deposit from your signature to the lending pool. Select a stop to see its
              full address.
            </p>
          </div>
          <MoneyPath />
          <div className="ex-aside">
            <p className="ex-aside__label">Alongside the path</p>
            <ul className="ex-aside__list">
              {OFF_PATH.map((c) => (
                <li key={c.id}>
                  <a className="ex-aside__link" href={`#ex-contract-${c.id}`}>
                    {c.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------- contracts ---------- */}
        <section className="ex-plate" aria-labelledby="ex-contracts">
          <div className="ex-plate__head">
            <h2 id="ex-contracts" className="ex-plate__title">
              Deployed contracts
            </h2>
            <span className="ex-count">{STATIC_ADDRESS_COUNT} static addresses</span>
            <p className="ex-plate__lede">
              Every fixed address the app calls. Copy one, or open it on Stellar Expert to check its
              code and history yourself.
            </p>
            <dl className="ex-facts">
              <Fact label="Soroban source crates" value={SOROBAN_SOURCE_CRATES.length} />
              <Fact label="VF deployments" value={FIRST_PARTY_DEPLOYMENT_COUNT} />
              <Fact label="Protocol contracts" value={EXTERNAL_PROTOCOL_COUNT} />
              <Fact label="Dynamic agents" value="N per run" />
            </dl>
          </div>
          {CONTRACT_GROUPS.map((group) => (
            <div key={group.ownership} className="ex-group" data-ownership={group.ownership}>
              <div className="ex-group__head">
                <h3 className="ex-group__title">{group.title}</h3>
                <p className="ex-group__hint">{group.hint}</p>
              </div>
              <ul className="ex-rows">
                {STELLAR_STATIC_DEPLOYMENTS.filter((c) => c.ownership === group.ownership).map(
                  (c) => (
                    <ContractRow
                      key={c.address + c.name}
                      contract={c}
                      copied={copied}
                      onCopy={copy}
                    />
                  )
                )}
              </ul>
            </div>
          ))}
        </section>

        {/* ---------- attestations ---------- */}
        <section className="ex-plate" aria-labelledby="ex-attest">
          <div className="ex-plate__head">
            <h2 id="ex-attest" className="ex-plate__title">
              Strategy attestations
            </h2>
            <p className="ex-plate__lede">
              Recent strategy hashes (SHA-256, off-chain verifiable; re-derivable from the strategy
              JSON). Rows with a ledger number come from the chain; the rest were saved on this
              device.
            </p>
          </div>
          <div className="ex-plate__body">
            {attestationView && attestationState !== 'current' && (
              <ExplorerFactStatus
                factView={attestationView}
                title="Attestation read"
                factKey="attestations"
                includeDetails={false}
              />
            )}
            <AttestationsTable strategies={displayedStrategies} initialOnchain={initialOnchain} />
          </div>
          <div className="ex-plate__foot">
            <a
              className="ex-extlink"
              href={`${STELLAR_EXPERT}${ACTIVE_VAULT_ADDRESS}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              View the vault on Stellar Expert
            </a>
          </div>
        </section>

        {/* ---------- security ---------- */}
        <section className="ex-plate" aria-labelledby="ex-security">
          <div className="ex-plate__head">
            <h2 id="ex-security" className="ex-plate__title">
              Security
            </h2>
            <p className="ex-plate__lede">
              What the contracts and the gas relay enforce today, and what is still missing.
            </p>
          </div>
          <div className="ex-plate__body">
            <ul className="ex-guards">
              {SECURITY.map((item) => (
                <li key={item} className="ex-guard">
                  {item}
                </li>
              ))}
            </ul>
            <PendingUpgradeStatus
              injected={hasInjectedRead ? (explorerRead.pendingUpgrade ?? null) : undefined}
            />
          </div>
          <div className="ex-audit">
            <span className="ex-chip">Not audited</span>
            <p className="ex-disclaimer">
              Unaudited (hackathon scope). Production deployment requires third-party audit.
            </p>
          </div>
        </section>

        {/* ---------- source code ---------- */}
        <section className="ex-plate ex-plate--os" aria-labelledby="ex-os">
          <h2 id="ex-os" className="ex-plate__title">
            Source code
          </h2>
          <dl className="ex-oslist">
            <div className="ex-osrow">
              <dt>GitHub</dt>
              <dd>
                <a
                  className="ex-osrow__link pc-technical"
                  href="https://github.com/poggufanz/vibingfarmer"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  github.com/poggufanz/vibingfarmer
                </a>
              </dd>
            </div>
            <div className="ex-osrow">
              <dt>License</dt>
              <dd>MIT</dd>
            </div>
          </dl>
        </section>

        <footer className="ex-foot">
          <span className="ex-foot__mark">vibing / farmer</span>
          <span className="ex-foot__tag">Set once. Vibe forever.</span>
        </footer>
      </main>
    </div>
  )
}
