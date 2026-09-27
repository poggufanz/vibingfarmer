/* ============================================
   VIBING FARMER — authenticated History
   Local records stay local; Base activity stays sourced from the Base reader.
   ============================================ */
import { useEffect, useRef, useState } from 'react'
import { toHistoryPresentation } from '../secondary/secondaryRouteAdapters.js'
import { NETWORK_IDS } from '../design/networks.js'
import {
  MoneyFigure,
  StatusNotice,
  TechnicalDetails,
  VenueTruth,
} from '../components/pocket/Primitives.jsx'
import { NetworkRoute } from '../components/pocket/NetworkIdentity.jsx'
import {
  getTransactions,
  getStrategies,
  getReasoningLog,
  clearAllHistory,
} from '../history/history.js'
import { loadSettings } from '../store/settingsStore.js'
import { useNavigateTo } from '../app/router.js'
import { fetchBaseHistory } from '../base/baseHistory.js'
import { readBaseOwner } from '../wallet/baseBinding.js'
import {
  fetchUnifiedActivity,
  mergeActivityRows,
  normalizeBaseRows,
  normalizeReceiptRows,
} from '../history/unifiedHistory.js'
import './HistoryPanel.css'

const BASE_EXPLORER_TX = 'https://base-sepolia.blockscout.com/tx/'
const TAB_IDS = Object.freeze(['transactions', 'base', 'strategies', 'reasoning', 'all'])
const TABS = Object.freeze([
  { id: 'transactions', label: 'Transactions' },
  { id: 'base', label: 'Base' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'reasoning', label: 'AI reasoning' },
  { id: 'all', label: 'All activity' },
])
const TAB_COPY = Object.freeze({
  transactions: {
    title: 'Transactions',
    lede: 'Deposits and withdrawals sent from this browser, newest first.',
  },
  base: {
    title: 'Base custody',
    lede: 'USDC moves on your Base passkey account, read from the Base indexer.',
  },
  strategies: { title: 'Strategies', lede: 'Every plan the strategist drafted for you.' },
  reasoning: { title: 'AI reasoning', lede: 'Why the strategist picked each vault.' },
  all: {
    title: 'All activity',
    lede: 'This device, Stellar, vault events and Base merged into one list.',
  },
})
// Lamp tone + plain label for the read state of the open tab. Lime (live) only for a fresh read.
const READ_STATE = Object.freeze({
  loading: { tone: 'idle', label: 'Reading' },
  current: { tone: 'live', label: 'Up to date' },
  confirmed: { tone: 'live', label: 'Up to date' },
  stale: { tone: 'warn', label: 'May be out of date' },
  partial: { tone: 'warn', label: 'Partly read' },
  empty: { tone: 'idle', label: 'Nothing recorded' },
  error: { tone: 'danger', label: 'Could not read' },
  unavailable: { tone: 'idle', label: 'Source unavailable' },
})
const PROBLEM_STATES = new Set(['error', 'stale', 'partial'])
const ITEMS_PER_PAGE = 10

const isRecord = (value) => value !== null && typeof value === 'object'
const hasOwn = (value, key) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)

function sourceOf(read) {
  if (!isRecord(read)) return {}
  return isRecord(read.readResult) ? read.readResult : read
}

function listFrom(source, keys) {
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key]
  }
  return []
}

function valueFrom(source, keys, fallback = undefined) {
  for (const key of keys) {
    if (hasOwn(source, key)) return source[key]
  }
  return fallback
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function latestTimestamp(rows, keys) {
  const values = rows
    .map((row) => timestampOf(valueFrom(row, keys)))
    .filter((value) => value !== null)
  return values.length ? Math.max(...values) : null
}

function formatTime(ts) {
  const numericTs = timestampOf(ts)
  if (numericTs === null) return 'Unavailable'
  const { timestampFormat } = loadSettings()
  if (timestampFormat === 'absolute') {
    return new Date(numericTs).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }
  const diff = Date.now() - numericTs
  const m = Math.floor(diff / 60_000)
  const h = Math.floor(diff / 3_600_000)
  const d = Math.floor(diff / 86_400_000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m} min ago`
  if (h < 24) return `${h} hr ago`
  return `${d}d ago`
}
const hasLiveApy = (row, field) => {
  const value = row?.[field]
  if (row?.yieldEvidence !== 'live-venue' || value == null) return false
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
}

const short = (hash) =>
  typeof hash === 'string' && hash.length > 0 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : ''

const USDC_DECIMALS = 6

function canonicalUsdcAmount(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null
  if (typeof value !== 'number' && typeof value !== 'string') return null

  const text = String(value).trim()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
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

function isUsdc(value) {
  return typeof value === 'string' && value.trim().toUpperCase() === 'USDC'
}

function rowAmount(row, factView) {
  if (!isRecord(row)) return null
  if (hasOwn(row, 'fact')) return isRecord(row.fact) ? (row.fact.value ?? null) : null
  if (hasOwn(row, 'amountUsdc')) return canonicalUsdcAmount(row.amountUsdc)
  if (hasOwn(row, 'amount')) {
    if (isRecord(row.amount)) return row.amount
    const token = row.symbol || row.asset || row.token
    return isUsdc(token) ? canonicalUsdcAmount(row.amount) : null
  }
  return factView?.value ?? null
}

function rowFactState(row, factView) {
  if (isRecord(row?.fact) && typeof row.fact.state === 'string') return row.fact.state
  return factView?.fact?.state || 'unavailable'
}

function networkContextFor(network, verified) {
  if (verified !== true) return { transitState: 'unknown' }
  const transitState = 'none'
  if (
    network === NETWORK_IDS.STELLAR_TESTNET ||
    network === 'Stellar testnet' ||
    network === 'stellar'
  ) {
    return {
      hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
      transitState,
    }
  }
  if (network === NETWORK_IDS.BASE_SEPOLIA || network === 'Base Sepolia' || network === 'base') {
    return {
      hostNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      sourceNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      destinationNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      custodyNetworkId: NETWORK_IDS.BASE_SEPOLIA,
      transitState,
    }
  }
  return null
}

function sourceNetworkFor(tab, rows, source) {
  const firstRow = rows[0]
  const rowHasVerification = hasOwn(firstRow, 'verified')
  return {
    network:
      valueFrom(firstRow, ['network', 'networkId']) ??
      valueFrom(source, tab === 'base' ? ['baseNetwork', 'network'] : ['localNetwork', 'network']),
    verified: rowHasVerification ? firstRow.verified : valueFrom(source, ['verified']),
  }
}

function factForPrimitive(view) {
  if (!view?.fact) return { state: 'unavailable' }
  return {
    ...view.fact,
    consequence: view.notice?.consequence ?? view.fact.consequence,
    safeNextAction: view.notice?.nextAction ?? view.fact.safeNextAction,
  }
}

function fallbackHistoryRead({ data, baseRows, baseLoading, baseAccount, unified }) {
  const localRows = Array.isArray(data.transactions) ? data.transactions : []
  const strategyRows = Array.isArray(data.strategies) ? data.strategies : []
  const reasoningRows = Array.isArray(data.reasoning) ? data.reasoning : []
  const localTimestamp = latestTimestamp(localRows, ['timestamp', 'savedAt'])
  const localFact = {
    state: localRows.length || strategyRows.length || reasoningRows.length ? 'current' : 'empty',
    value: null,
    source: 'local-device',
    checkedAt: localTimestamp,
    staleAfterMs: null,
  }
  const baseFact = {
    state: baseLoading ? 'loading' : baseRows.length ? 'current' : 'empty',
    value: null,
    source: 'base-indexer',
    checkedAt: latestTimestamp(baseRows, ['timestamp', 'time']),
    staleAfterMs: null,
  }
  const unifiedRows = Array.isArray(unified?.rows) ? unified.rows : []
  const unifiedFact = {
    state: unified?.loading ? 'loading' : unifiedRows.length ? 'current' : 'empty',
    value: null,
    source: 'unified-feed',
    checkedAt: latestTimestamp(unifiedRows, ['time']),
    staleAfterMs: null,
  }

  return {
    fact: localFact,
    facts: {
      transactions: localFact,
      strategies: localFact,
      reasoning: localFact,
      base: baseFact,
      all: unifiedFact,
    },
    transactions: localRows,
    strategies: strategyRows,
    reasoning: reasoningRows,
    baseRows,
    baseAccount,
    baseLoading,
  }
}

// Empty, failed and loading reads share one recessed well: what happened, then what to do next.
function EmptyWell({ title, children, action, busy = false, status = false }) {
  return (
    <div
      className="history-empty"
      role={busy || status ? 'status' : undefined}
      aria-busy={busy ? 'true' : undefined}
    >
      <svg className="history-empty-mark" viewBox="0 0 40 40" aria-hidden="true">
        <rect x="9" y="5" width="22" height="30" rx="3" />
        <path d="M14 13h12M14 19h12M14 25h7" />
      </svg>
      <p className="history-empty-title">{title}</p>
      {children && <p className="history-empty-copy">{children}</p>}
      {action && <div className="history-empty-action">{action}</div>}
    </div>
  )
}

function PutToWorkButton() {
  const navigateTo = useNavigateTo()
  return (
    <button type="button" className="history-action" onClick={() => navigateTo('strategy')}>
      Put money to work
    </button>
  )
}

function HistoryEvidence({ factView, title, error }) {
  const fact = factForPrimitive(factView)
  return (
    <section className="history-evidence" aria-label={title} data-fact-state={fact.state}>
      <StatusNotice fact={fact} title={title}>
        {error && <p>{String(error)}</p>}
      </StatusNotice>
      <TechnicalDetails summary="Technical details" fact={fact} open />
    </section>
  )
}

function TransactionsList({ rows, factView }) {
  const navigateTo = useNavigateTo()
  if (!rows.length)
    return (
      <EmptyWell title="No transactions yet" action={<PutToWorkButton />}>
        Deposits you send from this browser land here with their transaction hash.
      </EmptyWell>
    )

  return (
    <div className="tx-table" aria-label="Recorded local transactions">
      <div className="tx-row tx-head" role="row">
        <span>Status</span>
        <span>Txn hash</span>
        <span>Vault</span>
        <span>Amount</span>
        <span>Age</span>
      </div>
      {rows.map((row) => {
        const hash = typeof row?.txHash === 'string' ? row.txHash : ''
        const content = (
          <>
            <span className="tx-status" data-tone="idle" title="Recorded locally">
              <span className="tx-status-label">Recorded locally</span>
              <span className="tx-sub">This device</span>
            </span>
            <span className="tx-hash mono">{short(hash) || 'Unavailable'}</span>
            <span className="tx-vault">
              {row?.vaultName || 'Unavailable'}
              <span className="tx-sub">
                {[
                  row?.protocol,
                  hasLiveApy(row, 'apy') ? `${row.apy}% APY` : null,
                  row?.workerId || (row?.type === 'withdraw' ? 'manual withdraw' : null),
                ]
                  .filter(Boolean)
                  .join(', ') || 'Source details unavailable'}
              </span>
            </span>
            <span className="tx-amount">
              <MoneyFigure
                state={rowFactState(row, factView)}
                amount={rowAmount(row, factView)}
                freshness={factView?.freshness}
              />
            </span>
            <span className="tx-age">{formatTime(row?.timestamp)}</span>
          </>
        )

        return hash ? (
          <button
            key={row.id || hash}
            type="button"
            className="tx-row tx-row-button"
            onClick={() => navigateTo('tx', hash)}
            aria-label={`Open transaction ${short(hash)}`}
          >
            {content}
          </button>
        ) : (
          <div key={row.id || `${row?.timestamp}-${row?.vaultName}`} className="tx-row">
            {content}
          </div>
        )
      })}
    </div>
  )
}
function BaseList({ rows, loading, account, factView, networkVerified, failed, onRetry }) {
  if (loading) return <EmptyWell busy title="Loading Base activity…" />
  if (!account)
    return (
      <EmptyWell title="No Base passkey linked">
        Connect a Base passkey to see custody records here.
      </EmptyWell>
    )
  // P1 G10: the indexer could not be read — "could not load", never a false "no activity".
  if (failed)
    return (
      <EmptyWell
        status
        title="Base activity could not be loaded."
        action={
          <button type="button" className="history-action" onClick={onRetry}>
            Try again
          </button>
        }
      >
        The Base indexer did not answer, so nothing is shown instead of a false empty list.
      </EmptyWell>
    )
  if (!rows.length)
    return (
      <EmptyWell title="No Base activity yet">
        USDC you bridge to Base shows up here once the indexer sees it.
      </EmptyWell>
    )

  return (
    <div className="tx-table" aria-label="Base custody activity">
      <div className="tx-row tx-head" role="row">
        <span>Direction</span>
        <span>Txn hash</span>
        <span>Asset</span>
        <span>Amount</span>
        <span>Age</span>
      </div>
      {rows.map((row) => {
        const hash = typeof row?.hash === 'string' ? row.hash : ''
        const isIn = row?.action === 'in' || row?.direction === 'in'
        const content = (
          <>
            <span className="tx-status" data-tone="live">
              <span className="tx-status-label">
                {isIn ? 'Received' : row?.action || row?.direction || 'Unavailable'}
              </span>
            </span>
            <span className="tx-hash mono">{short(hash) || 'Unavailable'}</span>
            <span className="tx-vault">
              {row?.asset || row?.symbol || 'Unavailable'}
              <span className="tx-sub">
                {networkVerified ? 'Base Sepolia' : 'Network unavailable'}
              </span>
            </span>
            <span className="tx-amount">
              <MoneyFigure
                state={rowFactState(row, factView)}
                amount={rowAmount(row, factView)}
                freshness={factView?.freshness}
              />
            </span>
            <span className="tx-age">{formatTime(row?.timestamp ?? row?.time)}</span>
          </>
        )
        const venue = <VenueTruth kind={networkVerified ? 'base-proxy' : 'unknown'} />
        const rowContent = (
          <>
            {content}
            <div className="history-row-truth">{venue}</div>
          </>
        )

        return hash ? (
          <a
            key={row.id || hash}
            className="tx-row tx-row-link"
            href={`${BASE_EXPLORER_TX}${hash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {rowContent}
          </a>
        ) : (
          <div key={row.id || `${row?.timestamp}-${row?.asset}`} className="tx-row">
            {rowContent}
          </div>
        )
      })}
    </div>
  )
}
const UNIFIED_SOURCE_LABELS = {
  local: 'this device',
  horizon: 'Horizon',
  ledger: 'deposit ledger',
  keeper: 'vault events',
  grant: 'agent index',
  base: 'Base indexer',
}

// P1 G10: the unified feed — every source newest-first in one table. Rows carry only
// source-provided hashes, so the explorer link rule is structural: a row with `url` links,
// a row without one renders plain (same convention as TransactionsList/BaseList above).
// Unavailable sources are named explicitly, never folded into an empty state. The row
// sub-line names the DATA SOURCE (Horizon, this device, …), never a settled route — an
// unverified row must not claim one (same rule BaseList enforces via `networkVerified`).
function UnifiedList({ rows, sources, loading }) {
  const navigateTo = useNavigateTo()
  if (loading) return <EmptyWell busy title="Loading all activity…" />
  const unavailable = Object.entries(sources || {})
    .filter(([, state]) => state === 'unavailable')
    .map(([source]) => UNIFIED_SOURCE_LABELS[source] || source)
  if (rows.length === 0) {
    if (unavailable.length > 0)
      return (
        <EmptyWell status title="All activity is unavailable right now">
          {unavailable.join(', ')} could not be loaded, so nothing is shown instead of a false empty
          list.
        </EmptyWell>
      )
    return (
      <EmptyWell title="No activity yet" action={<PutToWorkButton />}>
        Once you deposit, every source reports here, newest first.
      </EmptyWell>
    )
  }
  return (
    <>
      {unavailable.length > 0 && (
        <p className="history-partial" role="status">
          Some sources could not be loaded ({unavailable.join(', ')}). Showing the rest, nothing
          below is guessed.
        </p>
      )}
      <div className="tx-table tx-table--unified" aria-label="All activity, newest first">
        <div className="tx-row tx-head" role="row">
          <span>Status</span>
          <span>Txn hash</span>
          <span>Details</span>
          <span>Age</span>
        </div>
        {rows.map((row) => {
          const hash = typeof row?.hash === 'string' ? row.hash : ''
          const content = (
            <>
              <span className="tx-status" data-tone={row?.source === 'local' ? 'idle' : 'live'}>
                <span className="tx-status-label">{row?.label || 'Unavailable'}</span>
                <span className="tx-sub">
                  {UNIFIED_SOURCE_LABELS[row?.source] || 'Source unavailable'}
                </span>
              </span>
              <span className="tx-hash mono">{short(hash) || 'Unavailable'}</span>
              <span className="tx-vault">
                {row?.detail || 'Details unavailable'}
                <span className="tx-sub">
                  {row?.time == null ? 'date unavailable' : 'chain-confirmed'}
                </span>
              </span>
              <span className="tx-age">{formatTime(row?.time)}</span>
            </>
          )
          if (row?.url && row.network === 'base')
            return (
              <a
                key={row.id || hash}
                className="tx-row tx-row-link"
                href={row.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {content}
              </a>
            )
          if (row?.url)
            return (
              <button
                key={row.id || hash}
                type="button"
                className="tx-row tx-row-button"
                onClick={() => navigateTo('tx', hash)}
                aria-label={`Open transaction ${short(hash)}`}
              >
                {content}
              </button>
            )
          return (
            <div key={row.id || `${row?.label}-${row?.detail}`} className="tx-row">
              {content}
            </div>
          )
        })}
      </div>
    </>
  )
}

function Readouts({ items }) {
  return (
    <dl className="hist-readouts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function StrategiesList({ rows, factView }) {
  if (!rows.length)
    return (
      <EmptyWell title="No strategies yet" action={<PutToWorkButton />}>
        Each plan the strategist drafts for you is kept here.
      </EmptyWell>
    )
  return (
    <div className="hist-list">
      {rows.map((row) => (
        <article key={row.id} className="hist-card">
          <header className="hist-card-head">
            <h3 className="hist-card-title">
              {row.riskLevel ? `${row.riskLevel} risk` : 'Risk unavailable'}
            </h3>
            {(hasOwn(row, 'amountUsdc') || hasOwn(row, 'amount')) && (
              <MoneyFigure
                state={rowFactState(row, factView)}
                amount={rowAmount(row, factView)}
                freshness={factView?.freshness}
                className="hist-card-money"
              />
            )}
            <span className="hist-age">{formatTime(row.timestamp)}</span>
          </header>
          <Readouts
            items={[
              ['Vaults', row.numVaults ?? 'Unavailable'],
              [
                'Yield',
                hasLiveApy(row, 'blendedApy')
                  ? `${row.blendedApy}% blended APY`
                  : 'APY unavailable',
              ],
              ['Planned by', row.strategySource || 'Strategy source unavailable'],
              [
                'Market data',
                row.vaultDataSource === 'defiLlama' || row.vaultDataSource === 'DeFiLlama'
                  ? 'DeFiLlama data'
                  : 'Yield unavailable',
              ],
              ...(row.marketContextUsed ? [['Context', 'Source context available']] : []),
            ]}
          />
          {row.dagTimings && (
            <p className="hist-card-foot mono">
              DAG {row.dagWallMs ?? 'Unavailable'}ms,{' '}
              {Object.entries(row.dagTimings)
                .map(([id, ms]) => `${id} ${Math.round(ms)}ms`)
                .join(', ')}
            </p>
          )}
        </article>
      ))}
    </div>
  )
}

function ReasoningList({ rows }) {
  if (!rows.length)
    return (
      <EmptyWell title="No AI reasoning yet">
        When the strategist picks a vault, its reasons are kept here.
      </EmptyWell>
    )
  return (
    <div className="hist-list">
      {rows.map((row) => (
        <article key={row.id} className="hist-card">
          <header className="hist-card-head">
            <h3 className="hist-card-title">{row.vaultName || 'Vault unavailable'}</h3>
            <span className="hist-age">{formatTime(row.timestamp)}</span>
          </header>
          {row.reasoning ? (
            <blockquote className="hist-reason">{row.reasoning}</blockquote>
          ) : (
            <p className="hist-reason hist-reason--missing">Reasoning unavailable</p>
          )}
          <Readouts
            items={[
              ['Risk', row.riskTier || 'Risk unavailable'],
              [
                'Yield source',
                hasLiveApy(row, 'expectedApy')
                  ? row.yieldSource || 'Yield source unavailable'
                  : 'Yield source unavailable',
              ],
              [
                'Expected',
                hasLiveApy(row, 'expectedApy') ? `${row.expectedApy}% APY` : 'APY unavailable',
              ],
              ['Model', row.modelUsed || 'Model unavailable'],
            ]}
          />
        </article>
      ))}
    </div>
  )
}

function tabRowsFor(tab, lists) {
  return lists[tab] || []
}

function HistoryPanel({ connectedAddress, historyRead }) {
  const [tab, setTab] = useState('transactions')
  const [nonce, setNonce] = useState(0)
  const [data, setData] = useState({ transactions: [], strategies: [], reasoning: [] })
  const [baseRows, setBaseRows] = useState([])
  const [baseLoading, setBaseLoading] = useState(false)
  const [baseAccount, setBaseAccount] = useState(null)
  const [baseFailed, setBaseFailed] = useState(false)
  const [unified, setUnified] = useState({ rows: [], sources: {}, partial: false, loading: false })
  const [page, setPage] = useState(1)
  const tabRefs = useRef({})

  useEffect(() => {
    setData({
      transactions: getTransactions(),
      strategies: getStrategies(),
      reasoning: getReasoningLog(),
    })
  }, [nonce])

  useEffect(() => {
    if (tab !== 'base') return
    const account = readBaseOwner(connectedAddress)?.kernelAddress || null
    setBaseAccount(account)
    if (!account) {
      setBaseRows([])
      setBaseFailed(false)
      setBaseLoading(false)
      return
    }
    let dead = false
    setBaseLoading(true)
    setBaseFailed(false)
    // `null` = the indexer could not be read (not a proven-empty history).
    fetchBaseHistory({ account, limit: 40 }).then((rows) => {
      if (!dead) {
        setBaseRows(rows ?? [])
        setBaseFailed(rows == null)
        setBaseLoading(false)
      }
    })
    return () => {
      dead = true
    }
  }, [tab, nonce, connectedAddress])

  // P1 G10: the unified feed loads lazily like the Base tab — only when selected, and only
  // off live readers when no fixture envelope is injected (tests inject `historyRead`).
  useEffect(() => {
    if (historyRead != null || tab !== 'all') return
    const account = readBaseOwner(connectedAddress)?.kernelAddress || null
    let dead = false
    setUnified((prev) => ({ ...prev, loading: true }))
    fetchUnifiedActivity({ owner: connectedAddress, baseAccount: account }).then((out) => {
      if (!dead) {
        setUnified({
          rows: out.rows,
          sources: out.sources,
          partial: out.partial,
          loading: false,
        })
      }
    })
    return () => {
      dead = true
    }
  }, [historyRead, tab, nonce, connectedAddress])

  const fallbackRead = fallbackHistoryRead({ data, baseRows, baseLoading, baseAccount, unified })
  const source = sourceOf(historyRead)
  const injected = historyRead != null
  const settledRead = injected ? historyRead : fallbackRead
  const presentation = toHistoryPresentation(settledRead, source.previousRead)
  const factViews = presentation.facts || {}
  const liveLists = {
    transactions: data.transactions,
    base: baseRows,
    strategies: data.strategies,
    reasoning: data.reasoning,
    all: unified.rows,
  }
  const lists = injected
    ? {
        transactions: listFrom(source, ['transactions', 'localTransactions', 'local']),
        base: listFrom(source, ['baseRows', 'base', 'baseActivity']),
        strategies: listFrom(source, ['strategies']),
        reasoning: listFrom(source, ['reasoning', 'reasoningLog']),
        // Injected envelopes carry raw per-tab rows (a test seam, never live readers):
        // the unified tab merges the injected Stellar + Base rows through the same pure
        // merger the live feed uses, so the tab always means "everything, newest first".
        all: mergeActivityRows({
          local: normalizeReceiptRows(
            listFrom(source, ['transactions', 'localTransactions', 'local'])
          ),
          base: normalizeBaseRows(listFrom(source, ['baseRows', 'base', 'baseActivity'])),
        }),
      }
    : liveLists
  const accounts = injected ? valueFrom(source, ['baseAccount', 'account'], null) : baseAccount
  const loading = injected
    ? Boolean(valueFrom(source, ['baseLoading', 'loading'], false)) ||
      factViews.base?.fact?.state === 'loading'
    : baseLoading
  const errors = injected ? valueFrom(source, ['errors', 'error'], null) : null
  const counts = Object.fromEntries(TAB_IDS.map((id) => [id, lists[id].length]))
  const activeFactView = factViews[tab] || presentation
  const activeFact = factForPrimitive(activeFactView)
  const totalPages = Math.max(1, Math.ceil((counts[tab] || 0) / ITEMS_PER_PAGE))
  const currentRows = tabRowsFor(tab, lists).slice(
    (page - 1) * ITEMS_PER_PAGE,
    page * ITEMS_PER_PAGE
  )
  const activeRows = tabRowsFor(tab, lists)
  const networkClaim = sourceNetworkFor(tab, activeRows, source)
  const accountAllowsNetwork = tab !== 'base' || Boolean(accounts)
  const factAllowsNetwork = ['current', 'confirmed', 'stale'].includes(activeFact.state)
  const networkVerified =
    accountAllowsNetwork &&
    !loading &&
    factAllowsNetwork &&
    Boolean(networkClaim.network) &&
    networkClaim.verified === true
  const networkContext = networkVerified
    ? (networkContextFor(networkClaim.network, true) ?? { transitState: 'unknown' })
    : { transitState: 'unknown' }
  const firstStellarRow = lists.transactions.find((row) => row?.vaultName || row?.vaultAddress)
  const hasStellarVenue =
    networkVerified &&
    tab !== 'base' &&
    Boolean(firstStellarRow?.vaultName || presentation.venue?.state === 'live')
  const stellarVenue =
    firstStellarRow?.vaultName ||
    (presentation.venue?.state === 'live' ? 'Autofarm Vault' : undefined)

  const handleTabChange = (nextTab) => {
    if (!TAB_IDS.includes(nextTab)) return
    setTab(nextTab)
    setPage(1)
  }

  const focusAndActivate = (nextTab) => {
    handleTabChange(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  const handleTabKeyDown = (event, id) => {
    const index = TAB_IDS.indexOf(id)
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      focusAndActivate(TAB_IDS[(index + 1) % TAB_IDS.length])
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusAndActivate(TAB_IDS[(index - 1 + TAB_IDS.length) % TAB_IDS.length])
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAndActivate(TAB_IDS[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAndActivate(TAB_IDS[TAB_IDS.length - 1])
    } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      handleTabChange(id)
    }
  }

  const onClear = () => {
    clearAllHistory()
    setNonce((value) => value + 1)
    setPage(1)
  }

  const titleForTab = {
    transactions: 'Local history read',
    base: 'Base activity read',
    strategies: 'Strategy history read',
    reasoning: 'AI reasoning read',
    all: 'Unified activity read',
  }[tab]
  const readState = loading
    ? READ_STATE.loading
    : READ_STATE[activeFact.state] || READ_STATE.unavailable
  const localTotal = counts.transactions + counts.strategies + counts.reasoning
  const lastMove = latestTimestamp(
    [...lists.transactions, ...lists.strategies, ...lists.reasoning],
    ['timestamp', 'savedAt']
  )
  const baseLinked = injected
    ? Boolean(accounts)
    : Boolean(readBaseOwner(connectedAddress)?.kernelAddress)
  const stateStrip = [
    {
      label: 'On this device',
      value: localTotal ? `${localTotal} record${localTotal === 1 ? '' : 's'}` : 'No records',
      tone: localTotal ? 'live' : 'idle',
    },
    {
      label: 'Last move',
      value: lastMove === null ? 'Nothing yet' : formatTime(lastMove),
      tone: lastMove === null ? 'idle' : 'live',
    },
    {
      label: 'Base custody',
      value: baseLinked ? 'Passkey linked' : 'Not linked',
      tone: baseLinked ? 'live' : 'idle',
    },
  ]

  return (
    <section
      className="history-page enter"
      data-fact-state={activeFact.state}
      aria-busy={activeFact.state === 'loading' || loading ? 'true' : undefined}
    >
      <header className="history-head">
        <div className="history-head-copy">
          <h1 className="history-title">History</h1>
          <p className="history-intro">Every recorded move and decision, newest first.</p>
        </div>
        {localTotal > 0 && (
          <button
            className="history-clear"
            onClick={onClear}
            title="Clears local history only"
            type="button"
          >
            Clear local history
          </button>
        )}
        <dl className="history-state">
          {stateStrip.map((item) => (
            <div key={item.label} className="history-state-item" data-tone={item.tone}>
              <dt>
                <span className="history-lamp" aria-hidden="true" />
                {item.label}
              </dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="history-tabs" role="tablist" aria-label="History views">
        {TABS.map((item) => {
          const isActive = tab === item.id
          const tabId = `history-tab-${item.id}`
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) tabRefs.current[item.id] = node
              }}
              id={tabId}
              className={`history-tab${isActive ? ' active' : ''}`}
              type="button"
              role="tab"
              aria-controls={`history-panel-${item.id}`}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => handleTabChange(item.id)}
              onKeyDown={(event) => handleTabKeyDown(event, item.id)}
            >
              {item.label}
              {item.id === 'base' && loading ? (
                <span className="history-tab-count" aria-label="loading">
                  …
                </span>
              ) : counts[item.id] > 0 ? (
                <span className="history-tab-count">{counts[item.id]}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="history-ledger">
        <div className="history-ledger-head">
          <div>
            <h2 className="history-ledger-title">{TAB_COPY[tab].title}</h2>
            <p className="history-ledger-lede">{TAB_COPY[tab].lede}</p>
          </div>
          <div className="history-ledger-meta">
            {activeFact.value != null && (
              <MoneyFigure
                state={activeFact.state}
                amount={activeFact.value}
                freshness={activeFactView.freshness}
                className="history-ledger-money"
              />
            )}
            <span className="history-read" data-tone={readState.tone}>
              <span className="history-lamp" aria-hidden="true" />
              {readState.label}
            </span>
          </div>
        </div>

        {/* Only the open panel renders rows; hidden panels stay mounted (tab/panel ids are pinned). */}
        <div className="history-body">
          <div
            id="history-panel-transactions"
            role="tabpanel"
            aria-labelledby="history-tab-transactions"
            tabIndex="0"
            hidden={tab !== 'transactions'}
            className="history-panel"
          >
            {tab === 'transactions' && (
              <TransactionsList
                rows={currentRows}
                factView={factViews.transactions || presentation}
              />
            )}
          </div>
          <div
            id="history-panel-base"
            role="tabpanel"
            aria-labelledby="history-tab-base"
            tabIndex="0"
            hidden={tab !== 'base'}
            className="history-panel"
          >
            {tab === 'base' && (
              <BaseList
                rows={currentRows}
                loading={loading}
                account={accounts}
                factView={factViews.base || presentation}
                networkVerified={networkVerified}
                failed={injected ? false : baseFailed}
                onRetry={() => setNonce((value) => value + 1)}
              />
            )}
          </div>
          <div
            id="history-panel-strategies"
            role="tabpanel"
            aria-labelledby="history-tab-strategies"
            tabIndex="0"
            hidden={tab !== 'strategies'}
            className="history-panel"
          >
            {tab === 'strategies' && (
              <StrategiesList rows={currentRows} factView={factViews.strategies || presentation} />
            )}
          </div>
          <div
            id="history-panel-reasoning"
            role="tabpanel"
            aria-labelledby="history-tab-reasoning"
            tabIndex="0"
            hidden={tab !== 'reasoning'}
            className="history-panel"
          >
            {tab === 'reasoning' && <ReasoningList rows={currentRows} />}
          </div>
          <div
            id="history-panel-all"
            role="tabpanel"
            aria-labelledby="history-tab-all"
            tabIndex="0"
            hidden={tab !== 'all'}
            className="history-panel"
          >
            {tab === 'all' && (
              <UnifiedList
                rows={currentRows}
                sources={injected ? {} : unified.sources}
                loading={injected ? false : unified.loading}
              />
            )}
          </div>
        </div>

        {!loading && counts[tab] > ITEMS_PER_PAGE && (
          <div className="history-pagination">
            <button
              className="history-page-btn"
              disabled={page === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              type="button"
            >
              Previous
            </button>
            <span className="history-page-label">
              Page {page} of {totalPages}
            </span>
            <button
              className="history-page-btn"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              type="button"
            >
              Next
            </button>
          </div>
        )}

        {/* Provenance stays one click away instead of leading the page; problem reads open it. */}
        <details className="history-source" open={PROBLEM_STATES.has(activeFact.state)}>
          <summary className="history-source-summary">
            <span className="history-source-title">Where this data comes from</span>
            <span className="history-source-hint">Network, venue and read freshness</span>
          </summary>
          <div className="history-source-body">
            <NetworkRoute compact context={networkContext} />
            <VenueTruth
              kind={
                networkVerified && tab === 'base'
                  ? 'base-proxy'
                  : hasStellarVenue
                    ? 'stellar-live'
                    : 'unknown'
              }
              venue={stellarVenue}
              fact={activeFact}
            />
            {hasStellarVenue && (
              <p className="history-venue-label">Yield venue: Blend Capital v2</p>
            )}
            <HistoryEvidence
              factView={activeFactView}
              title={titleForTab}
              error={isRecord(errors) ? errors[tab] : errors}
            />
          </div>
        </details>
      </div>
    </section>
  )
}

export default HistoryPanel
