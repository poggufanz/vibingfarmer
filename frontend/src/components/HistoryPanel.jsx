/* ============================================
   VIBING FARMER — History (Etherscan-style explorer)
   Stellar rows: localStorage via history.js.
   Base rows: Blockscout tokentx for vf_base_owner_address (on-chain, not clearable).
   ============================================ */
import React, { useState, useEffect } from 'react'
import { Icon } from '../components.jsx'
import { getTransactions, getStrategies, getReasoningLog, clearAllHistory } from '../history.js'
import { loadSettings } from '../settingsStore.js'
import { useNavigateTo } from '../router.js'
import { fetchBaseHistory } from '../base/baseHistory.js'

const BASE_EXPLORER_TX = 'https://base-sepolia.blockscout.com/tx/'

function formatTime(ts) {
  if (!ts) return '-'
  const { timestampFormat } = loadSettings()
  if (timestampFormat === 'absolute') {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60_000),
    h = Math.floor(diff / 3_600_000),
    d = Math.floor(diff / 86_400_000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m} min ago`
  if (h < 24) return `${h} hr ago`
  return `${d}d ago`
}
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '')

const TABS = [
  { id: 'transactions', label: 'Transactions' },
  { id: 'base', label: 'Base' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'reasoning', label: 'AI Reasoning' },
]

const Empty = ({ what }) => <div className="history-empty mono">No {what} yet.</div>

/* ---------- Transactions (Etherscan-like table) ---------- */
const TxList = ({ rows }) => {
  const navigateTo = useNavigateTo()
  if (!rows.length) return <Empty what="transactions" />
  return (
    <div className="tx-table">
      <div className="tx-row tx-head mono">
        <span>Status</span>
        <span>Txn hash</span>
        <span>Vault</span>
        <span>Amount</span>
        <span>Age</span>
      </div>
      {rows.map((r) => {
        const isWithdraw = r.type === 'withdraw'
        return (
          <div
            key={r.id}
            className="tx-row"
            style={{ cursor: r.txHash ? 'pointer' : 'default' }}
            onClick={() => r.txHash && navigateTo('tx', r.txHash)}
          >
            <span className="tx-status" title="Confirmed">
              <Icon name="check" size={13} />
            </span>
            <span
              className="tx-hash mono"
              style={{ cursor: 'pointer', textDecoration: 'underline', color: 'var(--text-muted)' }}
              onClick={(e) => {
                e.stopPropagation()
                navigateTo('tx', r.txHash)
              }}
            >
              {short(r.txHash)}
            </span>
            <span className="tx-vault">
              {isWithdraw ? `Withdrew ← ${r.vaultName}` : `Deposited → ${r.vaultName}`}
              <span className="tx-sub mono">
                {[
                  r.protocol,
                  r.apy ? `${r.apy}% APY` : null,
                  r.workerId || (isWithdraw ? 'manual withdraw' : null),
                ]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            </span>
            <span
              className="tx-amount mono tnum"
              style={{ color: isWithdraw ? 'var(--warn)' : 'var(--ok)' }}
            >
              {r.amountUsdc} USDC
            </span>
            <span className="tx-age mono">{formatTime(r.timestamp)}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ---------- Base activity (Blockscout tokentx) ---------- */
const BaseList = ({ rows, loading, account }) => {
  if (loading) {
    return (
      <div className="history-empty mono" role="status" aria-busy="true">
        <span className="think-spin" aria-hidden="true" style={{ marginRight: 8 }} />
        Loading Base activity…
      </div>
    )
  }
  if (!account) {
    return (
      <Empty what="Base activity (connect a Base passkey by farming or recovering positions)" />
    )
  }
  if (!rows.length) return <Empty what="Base activity" />

  return (
    <div className="tx-table">
      <div className="tx-row tx-head mono">
        <span>Dir</span>
        <span>Txn hash</span>
        <span>Transfer</span>
        <span>Amount</span>
        <span>Age</span>
      </div>
      {rows.map((h) => {
        const isIn = h.direction === 'in'
        return (
          <a
            key={h.id}
            className="tx-row tx-row-link"
            href={`${BASE_EXPLORER_TX}${h.hash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span
              className="tx-status"
              title={isIn ? 'Inbound' : 'Outbound'}
              style={{ color: isIn ? 'var(--ok)' : 'var(--warn)' }}
            >
              {isIn ? '↓' : '↑'}
            </span>
            <span className="tx-hash mono">{short(h.hash)}</span>
            <span className="tx-vault">
              {isIn ? 'Received on Base' : 'Sent from Base'}
              <span className="tx-sub mono">Base Sepolia, Blockscout</span>
            </span>
            <span
              className="tx-amount mono tnum"
              style={{ color: isIn ? 'var(--ok)' : 'var(--warn)' }}
            >
              {isIn ? '+' : '−'}
              {Number(h.amount || 0).toFixed(2)} {h.symbol}
            </span>
            <span className="tx-age mono">{formatTime(h.time)}</span>
          </a>
        )
      })}
    </div>
  )
}

/* ---------- Strategy sessions ---------- */
const StratList = ({ rows }) => {
  if (!rows.length) return <Empty what="strategies" />
  return (
    <div className="hist-list">
      {rows.map((r) => (
        <div key={r.id} className="hist-card">
          <div className="hist-card-head">
            <span className="hist-dot" />
            <b>
              {r.riskLevel} risk, {r.amountUsdc} USDC
            </b>
            <span className="hist-age mono">{formatTime(r.timestamp)}</span>
          </div>
          <div className="hist-card-meta mono">
            {r.numVaults} vault{r.numVaults === 1 ? '' : 's'}, {r.blendedApy}% blended APY
          </div>
          <div className="hist-card-tags mono">
            {r.strategySource},{' '}
            {r.vaultDataSource === 'defiLlama' ? 'DeFiLlama data' : 'Static data'}
            {r.marketContextUsed ? ', live market' : ''}
          </div>
          {r.dagTimings && (
            <div className="hist-card-meta mono">
              DAG {r.dagWallMs}ms,{' '}
              {Object.entries(r.dagTimings)
                .map(([id, ms]) => `${id} ${Math.round(ms)}ms`)
                .join(', ')}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/* ---------- AI reasoning log ---------- */
const ReasonList = ({ rows }) => {
  if (!rows.length) return <Empty what="reasoning" />
  return (
    <div className="hist-list">
      {rows.map((r) => (
        <div key={r.id} className="hist-card">
          <div className="hist-card-head">
            <b>{r.vaultName}</b>
            <span className="hist-age mono">{formatTime(r.timestamp)}</span>
          </div>
          <div className="hist-reason">“{r.reasoning}”</div>
          <div className="hist-card-meta mono">
            {r.riskTier} risk, {r.yieldSource}, {r.expectedApy}% APY, {r.modelUsed}
          </div>
        </div>
      ))}
    </div>
  )
}

const HistoryPanel = () => {
  const [tab, setTab] = useState('transactions')
  const [nonce, setNonce] = useState(0) // bump to re-read local history after clear
  const [data, setData] = useState({ transactions: [], strategies: [], reasoning: [] })
  const [baseRows, setBaseRows] = useState([])
  const [baseLoading, setBaseLoading] = useState(false)
  const [baseAccount, setBaseAccount] = useState(null)
  const [page, setPage] = useState(1)

  const ITEMS_PER_PAGE = 10

  useEffect(() => {
    setData({
      transactions: getTransactions(),
      strategies: getStrategies(),
      reasoning: getReasoningLog(),
    })
  }, [nonce])

  // On-chain Base activity lives on History now (was a Home strip). Fetch when the tab is
  // shown or after Clear (nonce) so post-farm visits still get a fresh read without app-level state.
  useEffect(() => {
    if (tab !== 'base') return
    const account = localStorage.getItem('vf_base_owner_address')
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
  }, [tab, nonce])

  const handleTabChange = (newTab) => {
    setTab(newTab)
    setPage(1)
  }

  const counts = {
    transactions: data.transactions.length,
    base: baseRows.length,
    strategies: data.strategies.length,
    reasoning: data.reasoning.length,
  }

  const tabRows =
    tab === 'base'
      ? baseRows
      : tab === 'transactions'
        ? data.transactions
        : tab === 'strategies'
          ? data.strategies
          : data.reasoning

  const totalPages = Math.max(1, Math.ceil((counts[tab] || 0) / ITEMS_PER_PAGE))
  const onClear = () => {
    clearAllHistory()
    setNonce((n) => n + 1)
    setPage(1)
  }

  const currentRows = tabRows.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE)

  return (
    <section className="history-page enter">
      <div className="history-head">
        <div className="eyebrow">
          <span>History, on-chain explorer</span>
        </div>
        <button className="perm-revoke" onClick={onClear} title="Clears Stellar local history only">
          Clear all
        </button>
      </div>

      <div className="history-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`history-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => handleTabChange(t.id)}
          >
            {t.label}
            {t.id === 'base' && baseLoading ? (
              <span className="history-tab-count" aria-label="loading">
                …
              </span>
            ) : (
              <span className="history-tab-count">{counts[t.id]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="history-body">
        {tab === 'transactions' && <TxList rows={currentRows} />}
        {tab === 'base' && (
          <BaseList rows={currentRows} loading={baseLoading} account={baseAccount} />
        )}
        {tab === 'strategies' && <StratList rows={currentRows} />}
        {tab === 'reasoning' && <ReasonList rows={currentRows} />}
      </div>

      {!baseLoading && counts[tab] > ITEMS_PER_PAGE && (
        <div className="history-pagination">
          <button
            className="btn btn-ghost history-page-btn"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <span className="mono history-page-label">
            Page {page} of {totalPages}
          </span>
          <button
            className="btn btn-ghost history-page-btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      )}
    </section>
  )
}

export default HistoryPanel
