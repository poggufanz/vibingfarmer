/* ============================================
   VIBING FARMER — History (Etherscan-style explorer)
   Reads localStorage directly (history.js). No prop drilling.
   ============================================ */
import React, { useState, useEffect } from 'react';
import { Icon } from '../components.jsx';
import {
  getTransactions, getStrategies, getReasoningLog, clearAllHistory,
} from '../history.js';
import { loadSettings } from '../settingsStore.js';
import { useNavigateTo } from '../router.js';

function formatTime(ts) {
  const { timestampFormat } = loadSettings()
  if (timestampFormat === 'absolute') {
    return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  }
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000), h = Math.floor(diff / 3_600_000), d = Math.floor(diff / 86_400_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (h < 24) return `${h} hr ago`;
  return `${d}d ago`;
}
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '');

const TABS = [
  { id: 'transactions', label: 'Transactions' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'reasoning', label: 'AI Reasoning' },
];

const Empty = ({ what }) => <div className="history-empty mono">no {what} yet</div>;

/* ---------- Transactions (Etherscan-like table) ---------- */
const TxList = ({ rows }) => {
  const navigateTo = useNavigateTo();
  if (!rows.length) return <Empty what="transactions" />;
  return (
    <div className="tx-table">
      <div className="tx-row tx-head mono">
        <span>status</span><span>txn hash</span><span>vault</span><span>amount</span><span>age</span>
      </div>
      {rows.map((r) => {
        const isWithdraw = r.type === 'withdraw';
        return (
        <div key={r.id} className="tx-row" style={{ cursor: r.txHash ? 'pointer' : 'default' }} onClick={() => r.txHash && navigateTo('tx', r.txHash)}>
          <span className="tx-status" title="confirmed"><Icon name="check" size={13} /></span>
          <span className="tx-hash mono" style={{ cursor: 'pointer', textDecoration: 'underline', color: 'var(--text-muted)' }}
            onClick={(e) => { e.stopPropagation(); navigateTo('tx', r.txHash); }}>
            {short(r.txHash)}
          </span>
          <span className="tx-vault">
            {isWithdraw ? `Withdrew ← ${r.vaultName}` : `Deposited → ${r.vaultName}`}
            <span className="tx-sub mono">{[r.protocol, r.apy ? `${r.apy}% APY` : null, r.workerId || (isWithdraw ? 'manual withdraw' : null)].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="tx-amount mono tnum" style={{ color: isWithdraw ? 'var(--warn)' : 'var(--ok)' }}>{isWithdraw ? '↑' : '↓'} {r.amountUsdc} USDC</span>
          <span className="tx-age mono">{formatTime(r.timestamp)}</span>
        </div>
        );
      })}
    </div>
  );
};

/* ---------- Strategy sessions ---------- */
const StratList = ({ rows }) => {
  if (!rows.length) return <Empty what="strategies" />;
  return (
    <div className="hist-list">
      {rows.map((r) => (
        <div key={r.id} className="hist-card">
          <div className="hist-card-head">
            <span className="hist-dot" />
            <b>{r.riskLevel} risk · {r.amountUsdc} USDC</b>
            <span className="hist-age mono">{formatTime(r.timestamp)}</span>
          </div>
          <div className="hist-card-meta mono">
            {r.numVaults} vault{r.numVaults === 1 ? '' : 's'} · {r.blendedApy}% blended APY
          </div>
          <div className="hist-card-tags mono">
            {r.strategySource} · {r.vaultDataSource === 'defiLlama' ? 'DeFiLlama data' : 'static data'}
            {r.marketContextUsed ? ' · live market' : ''}
          </div>
feat: surface DAG timing, ERC-7715 context, and skill errors to UIfeat: surface DAG timing, ERC-7715 context, and skill errors to UI          {r.dagTimings && (
            <div className="hist-card-meta mono">
              dag {r.dagWallMs}ms · {Object.entries(r.dagTimings)
                .map(([id, ms]) => `${id} ${Math.round(ms)}ms`)
                .join(' · ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

/* ---------- AI reasoning log ---------- */
const ReasonList = ({ rows }) => {
  if (!rows.length) return <Empty what="reasoning" />;
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
            {r.riskTier} risk · {r.yieldSource} · {r.expectedApy}% APY · {r.modelUsed}
          </div>
        </div>
      ))}
    </div>
  );
};

const HistoryPanel = () => {
  const [tab, setTab] = useState('transactions');
  const [nonce, setNonce] = useState(0); // bump to re-read after clear
  const [data, setData] = useState({ transactions: [], strategies: [], reasoning: [] });
  const [page, setPage] = useState(1);

  const ITEMS_PER_PAGE = 10;

  useEffect(() => {
    setData({
      transactions: getTransactions(),
      strategies: getStrategies(),
      reasoning: getReasoningLog(),
    });
  }, [nonce]);

  const handleTabChange = (newTab) => {
    setTab(newTab);
    setPage(1);
  };

  const counts = {
    transactions: data.transactions.length,
    strategies: data.strategies.length,
    reasoning: data.reasoning.length,
  };

  const totalPages = Math.ceil(counts[tab] / ITEMS_PER_PAGE);
  const onClear = () => { clearAllHistory(); setNonce((n) => n + 1); setPage(1); };

  const currentRows = data[tab].slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);

  return (
    <section className="history-page enter">
      <div className="history-head">
        <div className="eyebrow">
          <span>History · on-chain explorer</span>
        </div>
        <button className="perm-revoke" onClick={onClear}>clear all</button>
      </div>

      <div className="history-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`history-tab ${tab === t.id ? 'active' : ''}`} onClick={() => handleTabChange(t.id)}>
            {t.label}<span className="history-tab-count">{counts[t.id]}</span>
          </button>
        ))}
      </div>

      <div className="history-body">
        {tab === 'transactions' && <TxList rows={currentRows} />}
        {tab === 'strategies' && <StratList rows={currentRows} />}
        {tab === 'reasoning' && <ReasonList rows={currentRows} />}
      </div>

      {counts[tab] > ITEMS_PER_PAGE && (
        <div className="history-pagination" style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 20,
          paddingTop: 16,
          borderTop: '1px solid var(--border)',
        }}>
          <button
            className="btn btn-ghost"
            style={{
              padding: '6px 14px',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.04em'
            }}
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Prev
          </button>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            Page {page} of {totalPages}
          </span>
          <button
            className="btn btn-ghost"
            style={{
              padding: '6px 14px',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.04em'
            }}
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next →
          </button>
        </div>
      )}
    </section>
  );
};

export default HistoryPanel;
