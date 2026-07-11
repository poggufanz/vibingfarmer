/* ============================================
   VIBING FARMER — Keeper Panel (vf-autofarm Task 15)
   Presentational only — every value arrives via props from app.jsx (the Task-14
   fetchKeeperEvents feed + live price_per_share()/strategies() reads). Mirrors the Acid Yield
   design system already used by HistoryPanel.jsx / AlertCard.jsx: dark surface, mono metadata
   rows, one signature figure (DESIGN.md §9 — "every screen needs one big number").
   Never shows a fake number: a missing read renders "--", exactly like ExplorerPage/HomePage.
   ============================================ */
import { loadSettings } from '../settingsStore.js'

function formatTime(ts) {
  if (!ts) return ''
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
  const m = Math.floor(diff / 60_000)
  const h = Math.floor(diff / 3_600_000)
  const d = Math.floor(diff / 86_400_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (h < 24) return `${h} hr ago`
  return `${d}d ago`
}

const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '')

/* ---------- Last keeper action row ---------- */
const LastAction = ({ last }) => {
  if (!last) return <div className="keeper-empty mono">Keeper has not acted yet</div>
  if (last.kind === 'compound_executed') {
    return (
      <div className="keeper-action-row">
        <span className="keeper-action-dot" style={{ color: 'var(--ok)' }} aria-hidden="true">
          ✓
        </span>
        <span className="keeper-action-text">
          Compounded · +{last.totalGainUsdc} USDC · price/share {last.pricePerShare}
        </span>
        <span className="keeper-action-meta mono">
          {last.txHash ? short(last.txHash) : ''}
          {last.txHash ? ' · ' : ''}
          {formatTime(last.timestamp)}
        </span>
      </div>
    )
  }
  return (
    <div className="keeper-action-row">
      <span className="keeper-action-dot" style={{ color: 'var(--info)' }} aria-hidden="true">
        ⇄
      </span>
      <span className="keeper-action-text">
        Rebalanced · {last.fromLabel} → {last.toLabel} · {last.amountUsdc} USDC
      </span>
      <span className="keeper-action-meta mono">
        {last.txHash ? short(last.txHash) : ''}
        {last.txHash ? ' · ' : ''}
        {formatTime(last.timestamp)}
      </span>
    </div>
  )
}

/* ---------- APR per strategy ---------- */
const StrategyList = ({ strategies }) => {
  if (!strategies.length) return <div className="keeper-empty mono">No strategies registered</div>
  return (
    <div className="keeper-strategy-list">
      {strategies.map((s) => (
        <div key={s.address} className="keeper-strategy-row">
          <span className="keeper-strategy-name">{s.label}</span>
          <span className="keeper-strategy-pool mono">{s.poolLabel || '--'}</span>
          <span className="keeper-strategy-apr tnum mono">
            {s.aprPct == null ? '--' : `${s.aprPct.toFixed(2)}%`} APR
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * @param {object} p
 * @param {Array} [p.events] keeper activity, newest first — shape matches app.jsx's alert
 *   objects: { kind: 'compound_executed'|'rebalance_executed', totalGainUsdc?, pricePerShare?,
 *   fromLabel?, toLabel?, amountUsdc?, txHash?, timestamp }
 * @param {string|null} [p.pricePerShare] already-formatted display string (e.g. "1.0234"), or
 *   null when the read hasn't landed yet / failed — rendered as "--", never a guessed number
 * @param {Array} [p.strategies] [{ address, label, poolLabel, aprPct }] — aprPct is a percent
 *   number or null (best-effort Blend APR estimate; null renders "--")
 */
const KeeperPanel = ({ events = [], pricePerShare = null, strategies = [] }) => {
  const last = events[0] || null

  return (
    <section className="keeper-panel enter">
      <div className="keeper-pps">
        <span className="figure figure-md tnum">
          {pricePerShare ?? '--'}
          <span className="unit"> price / share</span>
        </span>
        <span className="label mono">Exchange rate · rises as the keeper compounds</span>
      </div>

      <div className="keeper-section">
        <div className="keeper-section-label mono">Last keeper action</div>
        <LastAction last={last} />
      </div>

      <div className="keeper-section">
        <div className="keeper-section-label mono">Strategies</div>
        <StrategyList strategies={strategies} />
      </div>
    </section>
  )
}

export default KeeperPanel
