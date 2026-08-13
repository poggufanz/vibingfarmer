// Transaction detail route (/tx/:txHash).
//
// The local history reader remains the source boundary. Legacy scalar amounts are converted only
// for the Secondary presentation adapter; the source record and its verification remain intact.
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { getTransactions } from '../history.js'
import { useNavigateTo } from '../router.js'
import { toTxPresentation } from '../secondary/secondaryRouteAdapters.js'
import { formatTokenUnits } from '../secondary/secondaryRouteContracts.js'
import { NETWORK_IDS, getNetworkMeta } from '../design/networks.js'
import { NetworkBadge } from './pocket/NetworkIdentity.jsx'
import { StatusNotice, TechnicalDetails } from './pocket/Primitives.jsx'
import './TxDetailPage.css'

const STELLAR_EXPLORER_TX = 'https://stellar.expert/explorer/testnet/tx/'
const UNAVAILABLE = 'Unavailable'
const USDC_DECIMALS = 6

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')

function canonicalUsdcAmount(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || Object.is(value, -0))) {
    return null
  }
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const valueText = String(value).trim()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(valueText)
  if (!match) return null
  const whole = match[1].replace(/^0+(?=\d)/, '')
  const fraction = match[2] || ''
  const excessFraction = fraction.slice(USDC_DECIMALS)
  if (excessFraction && /[1-9]/.test(excessFraction)) return null
  const units = `${whole}${fraction.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, '0')}`.replace(
    /^0+(?=\d)/,
    ''
  )
  return { token: 'USDC', units, decimals: USDC_DECIMALS }
}

function txPresentationInput(record) {
  if (!isRecord(record) || hasOwn(record, 'amount')) return record
  const amount = canonicalUsdcAmount(record.amountUsdc)
  return amount ? { ...record, amount } : record
}

function displayHash(hash) {
  return text(hash)
}

function asDateTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function formatAbs(timestamp) {
  const numeric = asDateTimestamp(timestamp)
  if (numeric === null) return UNAVAILABLE
  return new Date(numeric).toLocaleString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatRel(timestamp) {
  const numeric = asDateTimestamp(timestamp)
  if (numeric === null) return UNAVAILABLE
  const diff = Math.max(0, Date.now() - numeric)
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  if (hours < 24) return `${hours} hr ago`
  return `${Math.floor(hours / 24)}d ago`
}

function titleCase(value) {
  const valueText = text(value)
  if (!valueText) return UNAVAILABLE
  return valueText.replace(/[_-]+/gu, ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase())
}

function hasLiveApy(tx) {
  const value = tx?.apy
  return (
    tx?.yieldEvidence === 'live-venue' &&
    ((typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))))
  )
}

function networkFeePayer(channel) {
  if (channel === 'relay') return 'Sponsored by fee-bump relay'
  if (channel === 'direct') return 'Paid by wallet'
  return 'Unavailable'
}

function networkFeeValue(tx, verified) {
  const channel = text(tx?.channel).toLowerCase()
  if (channel === 'relay' || channel === 'direct') return networkFeePayer(channel)
  if (channel) return UNAVAILABLE
  return verified ? feeLabel(tx?.gasPayedBy ?? tx?.gasPaidBy) : UNAVAILABLE
}

function feeLabel(value) {
  const valueText = text(value)
  if (!valueText) return UNAVAILABLE
  return valueText === 'fee-bump-relayer' ? 'Fee-bump relayer' : titleCase(valueText)
}

function networkIdFor(value) {
  const normalized = text(value).toLowerCase()
  if (['stellar-testnet', 'stellar testnet', 'stellar'].includes(normalized)) {
    return NETWORK_IDS.STELLAR_TESTNET
  }
  if (['base-sepolia', 'base sepolia', 'base'].includes(normalized)) {
    return NETWORK_IDS.BASE_SEPOLIA
  }
  return null
}

function sourceRecord(record) {
  if (!isRecord(record)) return null
  if (isRecord(record.source)) return record.source
  if (isRecord(record.verification)) return record.verification
  if (isRecord(record.proof)) return record.proof
  return null
}

function sourceVerified(record) {
  const source = sourceRecord(record)
  return record?.verified === true || source?.verified === true
}

function verifiedHashMatches(record, hash) {
  const source = sourceRecord(record)
  const claimedHash = record?.verifiedHash ?? source?.hash ?? source?.txHash
  return claimedHash === undefined || claimedHash === hash
}

function canonicalAmountText(amount) {
  if (!isRecord(amount)) return UNAVAILABLE
  try {
    return `${formatTokenUnits(amount.units, amount.decimals)} ${amount.token}`
  } catch {
    return UNAVAILABLE
  }
}

function factForPrimitive(presentation, verified) {
  const fact = presentation?.fact || { state: 'unavailable', value: null }
  // Local history rows may contain the legacy `status: confirmed` value. Keep that status out of
  // the shared notice unless the record carries independent source verification.
  if (!verified && fact.state === 'confirmed') {
    return { ...fact, state: 'unavailable', value: null, source: null }
  }
  return {
    ...fact,
    consequence: presentation?.notice?.consequence ?? fact.consequence,
    safeNextAction: presentation?.notice?.nextAction ?? fact.safeNextAction,
  }
}

function DetailValue({ children }) {
  return <dd>{children || UNAVAILABLE}</dd>
}

function Provenance({ record, fact, verified }) {
  if (!record) {
    return (
      <div className="tx-detail-provenance" aria-label="Confirmation source">
        <span className="tx-detail-provenance__primary">Source: {UNAVAILABLE}</span>
      </div>
    )
  }

  if (!verified) {
    return (
      <div className="tx-detail-provenance" aria-label="Confirmation source">
        <span className="tx-detail-provenance__primary">Recorded locally</span>
        <span className="tx-detail-provenance__secondary">This device</span>
      </div>
    )
  }

  const source = text(fact?.source) || text(sourceRecord(record)?.name)
  return (
    <div className="tx-detail-provenance" aria-label="Confirmation source">
      <span className="tx-detail-provenance__primary">Source: {source || UNAVAILABLE}</span>
    </div>
  )
}

export default function TxDetailPage() {
  const { txHash } = useParams()
  const navigateTo = useNavigateTo()
  const [copied, setCopied] = useState(false)
  const tx = getTransactions().find((record) => record?.txHash === txHash)
  const presentation = toTxPresentation(txPresentationInput(tx))
  const verified = sourceVerified(tx)
  const fact = presentation?.fact || { state: 'unavailable', value: null }
  const statusFact = factForPrimitive(presentation, verified)
  const hash = displayHash(tx?.txHash || txHash)
  const recordHash = displayHash(tx?.txHash)
  const networkRaw = tx?.networkId ?? tx?.network
  const networkId = networkIdFor(networkRaw)
  const networkLabel = networkId ? getNetworkMeta(networkId).label : UNAVAILABLE
  const explorerAvailable =
    verified &&
    Boolean(recordHash) &&
    networkId === NETWORK_IDS.STELLAR_TESTNET &&
    verifiedHashMatches(tx, recordHash)
  const amount = canonicalAmountText(fact.value ?? presentation?.amount)
  const timestamp = tx?.timestamp ?? tx?.savedAt

  const goBack = () => {
    if (window.history.length > 1) window.history.back()
    else navigateTo('history')
  }

  const handleCopy = () => {
    if (!hash) return
    Promise.resolve(navigator.clipboard?.writeText?.(hash)).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleFarmAgain = () => {
    if (tx) {
      if (text(tx.protocol)) sessionStorage.setItem('yv_prefill_protocol', tx.protocol)
      else sessionStorage.removeItem('yv_prefill_protocol')
      if (text(tx.vaultName)) sessionStorage.setItem('yv_prefill_name', tx.vaultName)
      else sessionStorage.removeItem('yv_prefill_name')
      if (hasLiveApy(tx)) {
        sessionStorage.setItem('yv_prefill_apy', String(tx.apy))
      } else {
        sessionStorage.removeItem('yv_prefill_apy')
      }
    }
    navigateTo('strategy')
  }

  const detailItems = [
    ['Type', verified ? titleCase(tx?.type) : UNAVAILABLE],
    ['Status', verified ? titleCase(tx?.status) : UNAVAILABLE],
    ['Vault', text(tx?.vaultName)],
    ['Protocol', text(tx?.protocol)],
    ['Amount', amount],
    ['APY', hasLiveApy(tx) ? `${tx.apy}%` : UNAVAILABLE],
    ['Worker', text(tx?.workerLabel || tx?.workerId)],
    ['Network fee', networkFeeValue(tx, verified)],
    ['Network', verified ? networkLabel : UNAVAILABLE],
  ]

  return (
    <main
      className="tx-detail-page"
      data-fact-state={fact.state}
      aria-busy={fact.state === 'loading' ? 'true' : undefined}
    >
      <header className="tx-detail-page__header">
        <button className="tx-detail-page__back" type="button" onClick={goBack}>
          Back
        </button>
        <p className="tx-detail-page__eyebrow">Transaction</p>
        <h1 data-route-heading tabIndex={-1}>
          Transaction details
        </h1>
        <div className="tx-detail-page__time" aria-label="Transaction time">
          <span>{formatRel(timestamp)}</span>
          <time
            dateTime={
              asDateTimestamp(timestamp) === null ? undefined : new Date(timestamp).toISOString()
            }
          >
            {formatAbs(timestamp)}
          </time>
        </div>
      </header>

      <section className="tx-detail-page__evidence" aria-label="Transaction evidence">
        <StatusNotice fact={statusFact} title="Transaction read" />
        <Provenance record={tx} fact={fact} verified={verified} />
        <TechnicalDetails summary="Technical details" fact={statusFact} open />
      </section>

      <section className="tx-detail-page__hash" aria-labelledby="tx-detail-hash-title">
        <h2 id="tx-detail-hash-title">Transaction hash</h2>
        <div className="tx-detail-page__hash-row">
          <code title={hash || undefined}>{hash || UNAVAILABLE}</code>
          {hash && (
            <button className="tx-detail-page__text-button" type="button" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {explorerAvailable ? (
            <a
              href={`${STELLAR_EXPLORER_TX}${recordHash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Stellar Expert
            </a>
          ) : (
            <span className="tx-detail-page__unavailable">Explorer: Unavailable</span>
          )}
        </div>
      </section>

      {!tx && <p className="tx-detail-page__not-found">Transaction not found.</p>}

      <section className="tx-detail-page__details" aria-labelledby="tx-detail-facts-title">
        <h2 id="tx-detail-facts-title">Details</h2>
        <dl>
          {detailItems.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <DetailValue>{value}</DetailValue>
            </div>
          ))}
        </dl>
        <div className="tx-detail-page__network" aria-label="Transaction network">
          <span>Network identity</span>
          {verified && networkId ? (
            <NetworkBadge networkId={networkId} />
          ) : (
            <span>{UNAVAILABLE}</span>
          )}
        </div>
      </section>

      <div className="tx-detail-page__actions">
        {tx?.protocol && (
          <button
            className="pc-button pc-button--secondary"
            type="button"
            onClick={() => navigateTo('vault', tx.protocol)}
          >
            View vault
          </button>
        )}
        {tx && (
          <button className="pc-button pc-button--primary" type="button" onClick={handleFarmAgain}>
            Farm this vault again
          </button>
        )}
      </div>
    </main>
  )
}
