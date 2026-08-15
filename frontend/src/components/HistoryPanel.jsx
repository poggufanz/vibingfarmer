/* ============================================
   VIBING FARMER — authenticated History
   Local records stay local; Base activity stays sourced from the Base reader.
   ============================================ */
import { useEffect, useRef, useState } from 'react'
import { toHistoryPresentation } from '../secondary/secondaryRouteAdapters.js'
import { NETWORK_IDS } from '../design/networks.js'
import { MoneyFigure, StatusNotice, TechnicalDetails, VenueTruth } from './pocket/Primitives.jsx'
import { NetworkRoute } from './pocket/NetworkIdentity.jsx'
import { getTransactions, getStrategies, getReasoningLog, clearAllHistory } from '../history.js'
import { loadSettings } from '../settingsStore.js'
import { useNavigateTo } from '../router.js'
import { fetchBaseHistory } from '../base/baseHistory.js'
import { readBaseOwner } from '../wallet/baseBinding.js'
import './HistoryPanel.css'

const BASE_EXPLORER_TX = 'https://base-sepolia.blockscout.com/tx/'
const TAB_IDS = Object.freeze(['transactions', 'base', 'strategies', 'reasoning'])
const TABS = Object.freeze([
  { id: 'transactions', label: 'Transactions' },
  { id: 'base', label: 'Base' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'reasoning', label: 'AI Reasoning' },
])
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

function fallbackHistoryRead({ data, baseRows, baseLoading, baseAccount }) {
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

  return {
    fact: localFact,
    facts: {
      transactions: localFact,
      strategies: localFact,
      reasoning: localFact,
      base: baseFact,
    },
    transactions: localRows,
    strategies: strategyRows,
    reasoning: reasoningRows,
    baseRows,
    baseAccount,
    baseLoading,
  }
}

function Empty({ what }) {
  return <div className="history-empty">No {what} yet.</div>
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
  if (!rows.length) return <Empty what="transactions" />

  return (
    <div className="tx-table" aria-label="Recorded local transactions">
      <div className="tx-row tx-head mono" role="row">
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
            <span className="tx-status" title="Recorded locally">
              <span>Recorded locally</span>
              <span className="tx-sub mono">This device</span>
            </span>
            <span className="tx-hash mono">{short(hash) || 'Unavailable'}</span>
            <span className="tx-vault">
              {row?.vaultName || 'Unavailable'}
              <span className="tx-sub mono">
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
            <span className="tx-age mono">{formatTime(row?.timestamp)}</span>
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

function BaseList({ rows, loading, account, factView, networkVerified }) {
  if (loading)
    return (
      <div className="history-empty mono" role="status" aria-busy="true">
        Loading Base activity…
      </div>
    )
  if (!account)
    return <Empty what="Base activity (connect a Base passkey to view custody records)" />
  if (!rows.length) return <Empty what="Base activity" />

  return (
    <div className="tx-table" aria-label="Base custody activity">
      <div className="tx-row tx-head mono" role="row">
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
            <span className="tx-status">
              {isIn ? 'Received' : row?.action || row?.direction || 'Unavailable'}
            </span>
            <span className="tx-hash mono">{short(hash) || 'Unavailable'}</span>
            <span className="tx-vault">
              {row?.asset || row?.symbol || 'Unavailable'}
              <span className="tx-sub mono">
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
            <span className="tx-age mono">{formatTime(row?.timestamp ?? row?.time)}</span>
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

function StrategiesList({ rows, factView }) {
  if (!rows.length) return <Empty what="strategies" />
  return (
    <div className="hist-list">
      {rows.map((row) => (
        <div key={row.id} className="hist-card">
          <div className="hist-card-head">
            <span className="hist-dot" />
            <b>
              {row.riskLevel || 'Risk unavailable'}
              {(hasOwn(row, 'amountUsdc') || hasOwn(row, 'amount')) && (
                <>
                  {' · '}
                  <MoneyFigure
                    state={rowFactState(row, factView)}
                    amount={rowAmount(row, factView)}
                    freshness={factView?.freshness}
                  />
                </>
              )}{' '}
              risk
            </b>
            <span className="hist-age mono">{formatTime(row.timestamp)}</span>
          </div>
          <div className="hist-card-meta mono">
            {row.numVaults ?? 'Unavailable'} vault{row.numVaults === 1 ? '' : 's'}
            {hasLiveApy(row, 'blendedApy')
              ? `, ${row.blendedApy}% blended APY`
              : ', APY unavailable'}
          </div>
          <div className="hist-card-tags mono">
            {row.strategySource || 'Strategy source unavailable'},{' '}
            {row.vaultDataSource === 'defiLlama' || row.vaultDataSource === 'DeFiLlama'
              ? 'DeFiLlama data'
              : 'Yield unavailable'}
            {row.marketContextUsed ? ', source context available' : ''}
          </div>
          {row.dagTimings && (
            <div className="hist-card-meta mono">
              DAG {row.dagWallMs ?? 'Unavailable'}ms,{' '}
              {Object.entries(row.dagTimings)
                .map(([id, ms]) => `${id} ${Math.round(ms)}ms`)
                .join(', ')}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function ReasoningList({ rows }) {
  if (!rows.length) return <Empty what="reasoning" />
  return (
    <div className="hist-list">
      {rows.map((row) => (
        <div key={row.id} className="hist-card">
          <div className="hist-card-head">
            <b>{row.vaultName || 'Vault unavailable'}</b>
            <span className="hist-age mono">{formatTime(row.timestamp)}</span>
          </div>
          <div className="hist-reason">
            {row.reasoning ? `“${row.reasoning}”` : 'Reasoning unavailable'}
          </div>
          <div className="hist-card-meta mono">
            {row.riskTier || 'Risk unavailable'},{' '}
            {hasLiveApy(row, 'expectedApy')
              ? row.yieldSource || 'Yield source unavailable'
              : 'Yield source unavailable'}
            , {hasLiveApy(row, 'expectedApy') ? `${row.expectedApy}% APY` : 'APY unavailable'},{' '}
            {row.modelUsed || 'Model unavailable'}
          </div>
        </div>
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
      setBaseLoading(false)
      return
    }
    let dead = false
    setBaseLoading(true)
    fetchBaseHistory({ account, limit: 40 }).then((rows) => {
      if (!dead) {
        setBaseRows(rows)
        setBaseLoading(false)
      }
    })
    return () => {
      dead = true
    }
  }, [tab, nonce, connectedAddress])

  const fallbackRead = fallbackHistoryRead({ data, baseRows, baseLoading, baseAccount })
  const source = sourceOf(historyRead)
  const injected = historyRead != null
  const settledRead = injected ? historyRead : fallbackRead
  const presentation = toHistoryPresentation(settledRead, source.previousRead)
  const factViews = presentation.facts || {}
  const lists = injected
    ? {
        transactions: listFrom(source, ['transactions', 'localTransactions', 'local']),
        base: listFrom(source, ['baseRows', 'base', 'baseActivity']),
        strategies: listFrom(source, ['strategies']),
        reasoning: listFrom(source, ['reasoning', 'reasoningLog']),
      }
    : {
        transactions: data.transactions,
        base: baseRows,
        strategies: data.strategies,
        reasoning: data.reasoning,
      }
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
  }[tab]

  return (
    <section
      className="history-page enter"
      data-fact-state={activeFact.state}
      aria-busy={activeFact.state === 'loading' || loading ? 'true' : undefined}
    >
      <header className="history-head">
        <div>
          <h1 className="history-title">History</h1>
          <p className="history-intro">Every recorded move and decision, newest first.</p>
        </div>
        {counts.transactions + counts.strategies + counts.reasoning > 0 && (
          <button
            className="perm-revoke"
            onClick={onClear}
            title="Clears local history only"
            type="button"
          >
            Clear all
          </button>
        )}
      </header>

      {networkContext && <NetworkRoute compact context={networkContext} />}

      <div className="history-summary">
        <MoneyFigure
          state={activeFact.state}
          amount={activeFact.value}
          freshness={activeFactView.freshness}
          className="history-summary-money"
        />
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
        {hasStellarVenue && <p className="history-venue-label">Yield venue: Blend Capital v2</p>}
        <HistoryEvidence
          factView={activeFactView}
          title={titleForTab}
          error={isRecord(errors) ? errors[tab] : errors}
        />
      </div>

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

      <div className="history-body">
        <div
          id="history-panel-transactions"
          role="tabpanel"
          aria-labelledby="history-tab-transactions"
          tabIndex="0"
          hidden={tab !== 'transactions'}
          className="history-panel"
        >
          <TransactionsList rows={currentRows} factView={factViews.transactions || presentation} />
        </div>
        <div
          id="history-panel-base"
          role="tabpanel"
          aria-labelledby="history-tab-base"
          tabIndex="0"
          hidden={tab !== 'base'}
          className="history-panel"
        >
          <BaseList
            rows={currentRows}
            loading={loading}
            account={accounts}
            factView={factViews.base || presentation}
            networkVerified={networkVerified}
          />
        </div>
        <div
          id="history-panel-strategies"
          role="tabpanel"
          aria-labelledby="history-tab-strategies"
          tabIndex="0"
          hidden={tab !== 'strategies'}
          className="history-panel"
        >
          <StrategiesList rows={currentRows} factView={factViews.strategies || presentation} />
        </div>
        <div
          id="history-panel-reasoning"
          role="tabpanel"
          aria-labelledby="history-tab-reasoning"
          tabIndex="0"
          hidden={tab !== 'reasoning'}
          className="history-panel"
        >
          <ReasoningList rows={currentRows} />
        </div>
      </div>

      {!loading && counts[tab] > ITEMS_PER_PAGE && (
        <div className="history-pagination">
          <button
            className="btn btn-ghost history-page-btn"
            disabled={page === 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            type="button"
          >
            Previous
          </button>
          <span className="mono history-page-label">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn btn-ghost history-page-btn"
            disabled={page >= totalPages}
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            type="button"
          >
            Next
          </button>
        </div>
      )}
    </section>
  )
}

export default HistoryPanel
