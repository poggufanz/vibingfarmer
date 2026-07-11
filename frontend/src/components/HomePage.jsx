// HomePage.jsx
// Command center — context-aware home wired to wallet + position state.
// State 1: no wallet · State 2: connected, no positions · State 3: active positions.
import React, { useState, useEffect } from 'react'
import WithdrawModal from './WithdrawModal.jsx'
import { getTransactions } from '../history.js'
import { fetchDeFiLlamaVaults } from '../defiLlama.js'
import { fetchApyHistoryBatch } from '../apyHistory.js'
import { generateSparkline, calcApyStats } from '../sparkline.js'
import { VAULT_CATALOG } from '../config.js'
import { loadSettings, t } from '../settingsStore.js'
import { useNavigateTo } from '../router.js'
import { YieldLine } from './SignatureMark.jsx'
import { toDisplay } from '../stellar/format.js'

const POLL_MS = 10 * 60 * 1000
const u = toDisplay
const fmtAmt = (n) => (+Number(n || 0).toFixed(2)).toString()
const formatTime = (ts, now = Date.now()) => {
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
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return `${Math.floor(s / 3600)}h ago`
}
// Seed Market Pulse from the static catalog so rows render before the first fetch.
const SEED = VAULT_CATALOG.map((v) => ({
  name: v.name,
  protocol: v.protocol,
  apy: v.apy,
  tvlFormatted: null,
  source: 'fallback',
}))
let pulseCache = null // module-level: survives nav remount within a session

const eyebrow = {
  fontSize: 11,
  letterSpacing: '0.01em',
  color: 'var(--text-muted)',
  textTransform: 'capitalize',
  fontWeight: 500,
}
const linkBtn = {
  appearance: 'none',
  border: 0,
  background: 'transparent',
  font: 'inherit',
  fontSize: 11,
  color: 'var(--text-muted)',
  cursor: 'pointer',
  textDecoration: 'underline',
}
const card = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
}
const cardPad = { ...card, padding: '16px 18px' }
const section = { marginBottom: 28 }
const sub = { fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }
const pillBtn = {
  appearance: 'none',
  border: '.5px solid rgba(255,255,255,.18)',
  borderRadius: 5,
  background: 'rgba(255,255,255,.06)',
  color: 'inherit',
  font: 'inherit',
  fontSize: 10.5,
  padding: '4px 9px',
  cursor: 'pointer',
}
const dot = (c) => ({ width: 8, height: 8, borderRadius: '50%', background: c, flex: 'none' })

const alertText = (a) => {
  switch (a.kind) {
    case 'risk_alert':
      return `Risk detected · ${a.vaultName}`
    case 'apy_drift':
      return `APY drop detected · ${a.vaultName}`
    case 'rebalance_proposal':
      return `Rebalance proposed · +${a.apyGain}% opportunity`
    case 'harvest_ready':
      return `Harvest ready · ${a.vaultName}`
    case 'harvest_executed':
      return `Harvested · ${a.vaultName}`
    case 'harvest_failed':
      return `Harvest failed · ${a.vaultName}`
    default:
      return `${String(a.kind || 'event').replace(/_/g, ' ')} · ${a.vaultName || ''}`
  }
}
const alertIcon = (a) => {
  if (a.kind === 'risk_alert' || a.kind === 'apy_drift') return { icon: '⚠', color: 'var(--warn)' }
  if (a.kind === 'harvest_failed') return { icon: '✗', color: 'var(--danger)' }
  return { icon: '●', color: 'var(--text-muted)' }
}

const SectionHead = ({ title, action, onAction }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginBottom: 10,
      gap: 12,
    }}
  >
    <span style={eyebrow}>{title}</span>
    {action && (
      <button style={linkBtn} onClick={onAction}>
        {action}
      </button>
    )}
  </div>
)

// Vault table column template — Vault · Protocol · APY · Sparkline · TVL · Risk · Action
const GRID_COLS = '2.2fr 1.1fr 1fr .9fr .95fr .65fr .9fr'

// Format a percentage-point delta — replaces ↑↓→ arrows with actual pp numbers.
const ppMeta = (delta) => {
  if (delta === null || delta === undefined || Number.isNaN(parseFloat(delta))) return null
  const n = parseFloat(delta)
  return {
    n,
    cls: n > 0 ? 'up' : n < 0 ? 'down' : 'flat',
    text: `${n >= 0 ? '+' : ''}${n.toFixed(2)}pp`,
    color: n > 0 ? 'var(--accent)' : n < 0 ? 'var(--danger)' : 'var(--text-muted)',
  }
}

// Rank vaults by 7d APY momentum; only those with usable history survive.
function getTrendingVaults(liveVaults, apyHistories, limit = 3) {
  return liveVaults
    .map((vault) => {
      const history = apyHistories[vault.poolId]
      const stats = history ? calcApyStats(history) : null
      return { ...vault, stats, change7d: stats ? parseFloat(stats.change7d) : -999 }
    })
    .filter((v) => v.change7d > -999 && v.stats?.values)
    .sort((a, b) => b.change7d - a.change7d)
    .slice(0, limit)
}

// Collapsible section (native <details>) — default closed for compact homepage.
// Uncontrolled `open` so user toggle survives parent re-renders (poll/sort/filter).
const summaryRow = {
  cursor: 'pointer',
  listStyle: 'none',
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  marginBottom: 10,
  gap: 12,
}
const Collapsible = ({ title, count, meta, defaultOpen = false, children }) => (
  <details className="yv-collapse" style={section} {...(defaultOpen ? { open: true } : {})}>
    <summary style={summaryRow}>
      <span style={eyebrow}>
        <span className="yv-caret">▸ </span>
        {title}
        {count != null ? ` (${count})` : ''}
      </span>
      {meta}
    </summary>
    {children}
  </details>
)

export default function HomePage({
  userAddress,
  positions = {},
  alerts = [],
  vaultMeta = {},
  lastUpdated = null,
  agentActive = false,
  autoHarvest = false,
  sessionResumed = false,
  onDismissResumed,
  onConnect,
  onStartStrategy,
  onOpenAgent,
  onViewHistory,
  onWithdrawSuccess,
}) {
  const navigateTo = useNavigateTo()
  const [withdrawVault, setWithdrawVault] = useState(null)
  const [estimateAmount, setEstimateAmount] = useState(1000)
  const [pulse, setPulse] = useState(
    () => pulseCache || { vaults: SEED, prev: [], fetchedAt: null, live: false }
  )
  const [sortBy, setSortBy] = useState('tvl')
  const [sortDir, setSortDir] = useState('desc')
  const [filterRisk, setFilterRisk] = useState('all')
  const [apyHistories, setApyHistories] = useState({})

  // Read settings once, before any early return (was declared after the no-wallet return → TDZ crash)
  const settings = loadSettings()
  const lang = settings.language

  const posList = Object.entries(positions)

  // Market Pulse: fetch on mount if not cached/stale, refresh every 10 min, cleanup on unmount.
  useEffect(() => {
    if (!userAddress) return
    let alive = true
    const load = async () => {
      const vaults = await fetchDeFiLlamaVaults()
      if (!alive) return
      setPulse((prev) => {
        const next = {
          vaults,
          prev: prev.vaults || [],
          fetchedAt: Date.now(),
          live: vaults[0]?.source === 'defiLlama',
        }
        pulseCache = next
        return next
      })
    }
    if (!pulseCache || !pulseCache.fetchedAt || Date.now() - pulseCache.fetchedAt > POLL_MS) load()
    const id = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [userAddress])

  // APY history: fetch after vault list loads. Non-blocking — sparklines fill in
  // progressively as data arrives; apyHistory.js caches so nav doesn't re-fetch.
  const poolKey = (pulse.vaults || [])
    .map((v) => v.poolId)
    .filter(Boolean)
    .join(',')
  useEffect(() => {
    if (!poolKey) return
    let alive = true
    fetchApyHistoryBatch(poolKey.split(',')).then((map) => {
      if (alive) setApyHistories(map)
    })
    return () => {
      alive = false
    }
  }, [poolKey])

  // ── STATE 1: no wallet ──────────────────────────────────────────────
  if (!userAddress) {
    return (
      <div
        className="enter"
        style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 28, textAlign: 'center' }}
      >
        <div style={{ maxWidth: 440 }}>
          <div style={{ width: 300, maxWidth: '100%', margin: '0 auto 26px' }}>
            <YieldLine height={120} />
          </div>
          <div className="brand brand--hero" style={{ justifyContent: 'center' }}>
            <span>vibing</span>
            <span className="slash">/</span>
            <span className="vibing">farmer</span>
          </div>
          <p className="lede" style={{ margin: '18px auto 0', fontSize: 14 }}>
            Autonomous yield farming. Set your permission once, and the agent farms for you.
          </p>
          <button className="btn btn-primary btn-lg" style={{ marginTop: 24 }} onClick={onConnect}>
            {t(lang, 'connectWallet')}
          </button>
          <div
            className="mono"
            style={{
              marginTop: 22,
              fontSize: 11,
              color: 'var(--text-faint)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <span className="live-dot" />
            relayer fee-bump · gas 0 · Stellar testnet
          </div>
        </div>
      </div>
    )
  }

  const now = Date.now()
  const apyOf = (addr) => vaultMeta[addr.toLowerCase()]?.apy || 0
  const totalUnits = posList.reduce((s, [, p]) => s + Number(p.balance || 0), 0)
  const earnedToday = posList.reduce((s, [a, p]) => s + (u(p.balance) * (apyOf(a) / 100)) / 365, 0)
  const mode = autoHarvest ? 'autopilot' : 'co-pilot'

  // Risk/agent alerts now surface only through the top-bar bell (NotificationCenter);
  // the inline home banner was removed so alerts live in one place.

  // Recent activity: transactions + agent events, merged, newest 5.
  const txItems = getTransactions().map((t) => ({
    icon: t.status === 'failed' ? '✗' : '✓',
    color: t.status === 'failed' ? 'var(--danger)' : 'var(--ok)',
    text: `${t.type === 'withdraw' ? 'Withdrew' : 'Deposited'} ${fmtAmt(t.amountUsdc)} USDC → ${t.vaultName}`,
    ts: t.timestamp,
  }))
  const alertItems = alerts.map((a) => ({
    ...alertIcon(a),
    text: alertText(a),
    ts: a.timestamp || lastUpdated,
  }))
  const activity = [...txItems, ...alertItems].sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 5)

  const lastAlert = alerts[0]
  const fresh = pulse.fetchedAt && now - pulse.fetchedAt < POLL_MS
  const live = fresh && pulse.live

  const loading = !!userAddress && !pulse.fetchedAt
  const posEntries = Object.entries(positions)
  const isActive = (v) =>
    v.address && posEntries.some(([a]) => a.toLowerCase() === v.address.toLowerCase())
  const getPositionBalance = (v) => {
    const entry = v.address
      ? posEntries.find(([a]) => a.toLowerCase() === v.address.toLowerCase())
      : null
    return entry ? u(entry[1].balance) : null
  }
  const handleFarm = (v) => {
    sessionStorage.setItem('yv_prefill_protocol', v.protocol)
    sessionStorage.setItem('yv_prefill_name', v.name)
    sessionStorage.setItem('yv_prefill_apy', String(v.apy))
    onStartStrategy()
  }
  const handleSort = (key) => {
    if (sortBy === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    else {
      setSortBy(key)
      setSortDir('desc')
    }
  }
  const riskOrder = { low: 0, medium: 1, high: 2 }
  const sortedVaults = [...pulse.vaults]
    .filter((v) => filterRisk === 'all' || v.risk === filterRisk)
    .sort((a, b) => {
      let cmp = 0
      if (sortBy === 'tvl') cmp = (b.tvlUsd || 0) - (a.tvlUsd || 0)
      else if (sortBy === 'apy') cmp = b.apy - a.apy
      else if (sortBy === 'risk') {
        const ra = riskOrder[a.risk] ?? 1
        const rb = riskOrder[b.risk] ?? 1
        cmp = ra - rb
      }
      return sortDir === 'asc' ? -cmp : cmp
    })

  // Trending Now — ranked by 7d APY momentum. Only render when ≥1 history loaded.
  const trending = getTrendingVaults(pulse.vaults || [], apyHistories, 3)
  const hasHistories = Object.keys(apyHistories).length > 0

  // Per-vault stats lookup for table sparkline + 1d pp change.
  const statsFor = (v) => {
    const h = v.poolId ? apyHistories[v.poolId] : null
    return h ? calcApyStats(h) : null
  }

  // Market Pulse aggregate — stablecoin avg APY + best opportunity, with pp deltas.
  const vaultsForAgg = pulse.vaults || []
  const stableAvgApy = vaultsForAgg.length
    ? vaultsForAgg.reduce((s, v) => s + Number(v.apy || 0), 0) / vaultsForAgg.length
    : null
  const dayDeltas = vaultsForAgg
    .map((v) => statsFor(v))
    .filter(Boolean)
    .map((s) => parseFloat(s.change1d))
  const stableAvgPp = dayDeltas.length
    ? ppMeta(dayDeltas.reduce((a, b) => a + b, 0) / dayDeltas.length)
    : null
  const bestVault = vaultsForAgg.length ? [...vaultsForAgg].sort((a, b) => b.apy - a.apy)[0] : null
  const bestPp = bestVault ? ppMeta(statsFor(bestVault)?.change7d) : null

  const handleOpenVault = (v) => {
    if (v.protocol) navigateTo('vault', v.protocol)
  }

  return (
    <div className="enter" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 28 }}>
      <div style={{ maxWidth: 820, margin: '0 auto', width: '100%' }}>
        {sessionResumed && (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginBottom: 20,
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              borderLeft: '2px solid var(--accent)',
              background: 'var(--bg-card)',
            }}
          >
            <span style={dot('var(--accent)')} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>Session resumed</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                Reconnected your wallet and restarted the monitor agent for your active vaults.
              </div>
            </div>
            {onOpenAgent && (
              <button style={pillBtn} onClick={onOpenAgent}>
                View agent →
              </button>
            )}
            <button
              aria-label="Dismiss"
              style={{ ...linkBtn, textDecoration: 'none', fontSize: 15, lineHeight: 1 }}
              onClick={onDismissResumed}
            >
              ×
            </button>
          </div>
        )}

        {posList.length === 0 ? (
          /* ── STATE 2: connected, no positions ── */
          <div style={section}>
            <SectionHead title="Portfolio" />
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 20, marginBottom: 20 }} className="vf-empty-grid">
              
              {/* Left card: Start Farming & Yield Estimator */}
              <div style={{ ...cardPad, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 290 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                    <span style={eyebrow}>Total Balance</span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Stellar Testnet</span>
                  </div>
                  <div className="tnum" style={{ fontSize: '2.2rem', fontWeight: 600, lineHeight: 1, letterSpacing: '-0.03em', color: 'var(--text)' }}>
                    0.00 <span style={{ fontSize: 13, color: 'var(--text-faint)', fontWeight: 400 }}>USDC</span>
                  </div>
                  
                  {/* Estimator Tool */}
                  <div style={{ marginTop: 24, padding: '12px 14px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.04)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Projected Yearly Yield</span>
                      <span className="mono tnum" style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 'bold' }}>{estimateAmount.toLocaleString()} USDC</span>
                    </div>
                    
                    <input 
                      type="range" 
                      min="100" 
                      max="10000" 
                      step="100"
                      value={estimateAmount} 
                      onChange={(e) => setEstimateAmount(Number(e.target.value))}
                      style={{ 
                        width: '100%', 
                        accentColor: 'var(--accent)', 
                        height: 4, 
                        background: 'rgba(255,255,255,0.1)', 
                        borderRadius: 2,
                        cursor: 'pointer',
                        marginBottom: 14
                      }}
                    />
                    
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, textAlign: 'center' }}>
                      <div style={{ padding: '6px 4px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                        <div style={{ fontSize: 9, textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.05em' }}>Low Risk</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>4.8% APY</div>
                        <div className="tnum" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>+{(estimateAmount * 0.048).toFixed(2)}</div>
                      </div>
                      <div style={{ padding: '6px 4px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                        <div style={{ fontSize: 9, textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.05em' }}>Medium Risk</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>6.1% APY</div>
                        <div className="tnum" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>+{(estimateAmount * 0.061).toFixed(2)}</div>
                      </div>
                      <div style={{ padding: '6px 4px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                        <div style={{ fontSize: 9, textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.05em' }}>High Risk</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>9.4% APY</div>
                        <div className="tnum" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--accent)', marginTop: 2 }}>+{(estimateAmount * 0.094).toFixed(2)}</div>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div style={{ marginTop: 20 }}>
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', padding: '10px 16px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6 }}
                    onClick={() => onStartStrategy(estimateAmount)}
                  >
                    Start Strategy <span style={{ fontSize: 14 }}>→</span>
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, fontSize: 10, color: 'var(--text-faint)' }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)' }} />
                    Gasless deposits via fee-bump relayer
                  </div>
                </div>
              </div>
              
              {/* Right card: Featured Opportunities (clickable vaults) */}
              <div style={cardPad}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                  <span style={eyebrow}>Featured Strategies</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click to farm</span>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {VAULT_CATALOG.slice(0, 3).map((v) => (
                    <div 
                      key={v.protocol}
                      onClick={() => handleFarm(v)}
                      style={{
                        padding: '12px 14px',
                        background: 'linear-gradient(135deg, var(--bg-elev) 0%, var(--bg-card) 100%)',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 'var(--radius-md, 8px)',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        transition: 'all 0.2s ease',
                      }}
                      className="hover-scale-subtle"
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{v.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{v.yield_source} · min {v.min_capital} USDC</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="tnum" style={{ fontSize: 14, fontWeight: 600, color: 'var(--ok)' }}>{v.apy.toFixed(1)}% APY</div>
                        <span style={{ 
                          fontSize: 9, 
                          textTransform: 'uppercase', 
                          padding: '1px 6px', 
                          borderRadius: 4, 
                          border: `1.5px solid ${v.risk === 'low' ? 'var(--ok)' : v.risk === 'medium' ? 'var(--warn)' : 'var(--accent)'}`,
                          color: v.risk === 'low' ? 'var(--ok)' : v.risk === 'medium' ? 'var(--warn)' : 'var(--accent)',
                          fontWeight: 600,
                          letterSpacing: '0.02em',
                          display: 'inline-block',
                          marginTop: 3
                        }}>
                          {v.risk}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 3-Layer Protection Graphic */}
            <div style={{ ...cardPad }}>
              <div style={{ ...eyebrow, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>Built-in Security: The 3-Layer Yield Protection</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }} className="vf-empty-protection">
                <div style={{ padding: '4px 8px', borderLeft: '2px solid var(--warn)' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>1. Pre-Flight Verification</div>
                  <p style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
                    Vets yield authenticity. Instantly filters out ponzi-yield architectures and un-audited smart contracts.
                  </p>
                </div>
                <div style={{ padding: '4px 8px', borderLeft: '2px solid var(--accent)' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>2. Active Risk Guardian</div>
                  <p style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
                    Continuous monitor loops monitor Blend pool utilization, volatility, and protocol TVL changes in real time.
                  </p>
                </div>
                <div style={{ padding: '4px 8px', borderLeft: '2px solid var(--ok)' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>3. Scoped Keeper Auto-Exit</div>
                  <p style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
                    On-chain scoped session keys execute automatic emergency withdrawals directly back to your address if targets trip.
                  </p>
                </div>
              </div>
            </div>

            <style>{`
              @media (max-width: 768px) {
                .vf-empty-grid { grid-template-columns: 1fr !important; }
                .vf-empty-protection { grid-template-columns: 1fr !important; }
              }
              .hover-scale-subtle:hover {
                transform: translateY(-1px);
                border-color: var(--accent) !important;
                box-shadow: 0 4px 12px rgba(207, 255, 61, 0.05);
              }
            `}</style>
          </div>
        ) : (
          <>
            {/* ── PORTFOLIO STRIP (compact — totals + agent merged into one row) ── */}
            <div style={section}>
              <SectionHead title="Portfolio" />
              <div
                style={{
                  ...cardPad,
                  padding: '13px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <span className="tnum" style={{ fontSize: 20, fontWeight: 500 }}>
                    {fmtAmt(u(totalUnits))}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 5 }}>
                    USDC
                  </span>
                </div>
                <span style={{ width: 1, height: 22, background: 'var(--border)' }} />
                <div>
                  <span
                    className="tnum"
                    style={{ fontSize: 14, fontWeight: 500, color: 'var(--ok)' }}
                  >
                    +{earnedToday.toFixed(2)}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
                    /day
                  </span>
                </div>
                <span style={{ width: 1, height: 22, background: 'var(--border)' }} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {posList.length} vault{posList.length === 1 ? '' : 's'}
                </span>
                <button
                  onClick={onOpenAgent}
                  title="Open Agent Dashboard"
                  style={{
                    ...linkBtn,
                    textDecoration: 'none',
                    marginLeft: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    fontSize: 12,
                  }}
                >
                  <span style={dot(agentActive ? 'var(--ok)' : 'var(--text-faint)')} />
                  {agentActive ? 'monitoring' : 'stopped'} · {mode} →
                </button>
              </div>
            </div>

            {/* ── SECTION 2: Active positions ── */}
            <div style={section}>
              <SectionHead
                title={t(lang, 'activePositions')}
                action={`+ ${t(lang, 'newStrategy')}`}
                onAction={onStartStrategy}
              />
              <div style={{ ...card }}>
                {posList.map(([addr, p], i) => {
                  const apy = apyOf(addr)
                  const bal = u(p.balance)
                  const daily = (bal * (apy / 100)) / 365
                  const pct = totalUnits > 0 ? (Number(p.balance) / totalUnits) * 100 : 0
                  return (
                    <div
                      key={addr}
                      style={{
                        padding: '14px 18px',
                        borderTop: i ? '1px solid var(--border)' : 'none',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          gap: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{p.vaultName}</span>
                        <span className="mono tnum" style={{ fontSize: 12 }}>
                          {bal.toFixed(2)} USDC · {apy.toFixed(1)}% APY ·{' '}
                          <span style={{ color: 'var(--ok)' }}>+{daily.toFixed(3)}/day</span>
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                        <div
                          style={{
                            flex: 1,
                            height: 4,
                            background: 'rgba(255,255,255,.08)',
                            borderRadius: 3,
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${pct}%`,
                              background: 'var(--ok)',
                              borderRadius: 3,
                            }}
                          />
                        </div>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10,
                            color: 'var(--text-faint)',
                            minWidth: 32,
                            textAlign: 'right',
                          }}
                        >
                          {pct.toFixed(0)}%
                        </span>
                        <button
                          style={pillBtn}
                          onClick={() =>
                            setWithdrawVault({
                              vault: {
                                name: p.vaultName,
                                address: addr,
                                protocol: vaultMeta[addr.toLowerCase()]?.protocol || '',
                                apy,
                              },
                              balance: p.balance,
                              unclaimedRewards: p.unclaimedRewards,
                            })
                          }
                        >
                          {t(lang, 'withdraw')}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── TOP MOVERS (inline — 7d APY momentum, replaces Trending cards) ── */}
            {(pulse.vaults || []).some((v) => v.poolId) && (
              <div
                style={{
                  ...section,
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 9,
                  flexWrap: 'wrap',
                }}
              >
                <span style={eyebrow}>Top Movers</span>
                {!hasHistories ? (
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                    fetching APY momentum…
                  </span>
                ) : trending.length > 0 ? (
                  trending.map((v, i) => {
                    const pp = ppMeta(v.stats?.change7d)
                    return (
                      <React.Fragment key={v.poolId || `${v.name}-${i}`}>
                        {i > 0 && (
                          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>·</span>
                        )}
                        <button
                          onClick={() => handleOpenVault(v)}
                          style={{
                            ...linkBtn,
                            textDecoration: 'none',
                            display: 'inline-flex',
                            alignItems: 'baseline',
                            gap: 5,
                            fontSize: 12,
                          }}
                        >
                          <span>{v.protocol}</span>
                          {pp && (
                            <span className="mono" style={{ fontSize: 11, color: pp.color }}>
                              {pp.text}
                            </span>
                          )}
                        </button>
                      </React.Fragment>
                    )
                  })
                ) : null}
              </div>
            )}

            {/* ── MARKET PULSE (collapsed by default) ── */}
            <Collapsible
              title={t(lang, 'marketPulse')}
              count={(pulse.vaults || []).length}
              meta={
                <span
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: loading ? 'var(--text-faint)' : live ? 'var(--ok)' : 'var(--text-faint)',
                  }}
                >
                  {loading
                    ? 'fetching live data…'
                    : live
                      ? `live · updated ${formatTime(pulse.fetchedAt, now)}`
                      : 'cached'}
                </span>
              }
            >
              {/* Aggregate stats — stablecoin avg APY + best opportunity, with pp deltas */}
              {stableAvgApy !== null && (
                <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 12 }}>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      Stablecoin avg APY
                    </span>
                    <span
                      className="mono tnum"
                      style={{ marginLeft: 8, fontSize: 13, fontWeight: 600 }}
                    >
                      {stableAvgApy.toFixed(1)}%
                    </span>
                    {stableAvgPp && (
                      <span
                        className="mono"
                        style={{ marginLeft: 6, fontSize: 11, color: stableAvgPp.color }}
                      >
                        {stableAvgPp.text} 1d
                      </span>
                    )}
                  </div>
                  {bestVault && (
                    <div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        Best opportunity
                      </span>
                      <span className="mono" style={{ marginLeft: 8, fontSize: 12 }}>
                        {bestVault.protocol}
                      </span>
                      <span
                        className="mono tnum"
                        style={{ marginLeft: 6, fontSize: 13, fontWeight: 600 }}
                      >
                        {Number(bestVault.apy).toFixed(1)}%
                      </span>
                      {bestPp && (
                        <span
                          className="mono"
                          style={{ marginLeft: 6, fontSize: 11, color: bestPp.color }}
                        >
                          {bestPp.text} 7d
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Sort + Filter controls */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  marginBottom: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  className="mono"
                  style={{ fontSize: 10.5, color: 'var(--text-faint)', marginRight: 2 }}
                >
                  Sort:
                </span>
                {[
                  ['tvl', 'TVL'],
                  ['apy', 'APY'],
                  ['risk', 'Risk'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => handleSort(key)}
                    style={{
                      ...pillBtn,
                      color: sortBy === key ? 'var(--text-primary, #e8e8e8)' : 'var(--text-muted)',
                      borderColor:
                        sortBy === key ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.12)',
                    }}
                  >
                    {label}
                    {sortBy === key ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''}
                  </button>
                ))}
                <span
                  style={{
                    width: 1,
                    height: 12,
                    background: 'var(--border)',
                    margin: '0 5px',
                    display: 'inline-block',
                    verticalAlign: 'middle',
                  }}
                />
                {[
                  ['all', 'All'],
                  ['low', 'Low risk'],
                  ['medium', 'Medium'],
                  ['high', 'High'],
                ].map(([k, lbl]) => (
                  <button
                    key={k}
                    onClick={() => setFilterRisk(k)}
                    style={{
                      ...pillBtn,
                      color:
                        filterRisk === k ? 'var(--text-primary, #e8e8e8)' : 'var(--text-muted)',
                      borderColor:
                        filterRisk === k ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.12)',
                    }}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {/* Table */}
              <div style={{ ...card }}>
                {/* Column headers */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: GRID_COLS,
                    gap: 8,
                    padding: '7px 18px',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {['Vault', 'Protocol', 'APY', 'Trend', 'TVL', 'Risk', 'Action'].map((h) => (
                    <span
                      key={h}
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color: 'var(--text-faint)',
                        textTransform: 'lowercase',
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {h}
                    </span>
                  ))}
                </div>

                {loading ? (
                  [0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: GRID_COLS,
                        gap: 8,
                        alignItems: 'center',
                        padding: '11px 18px',
                        borderTop: '1px solid var(--border)',
                      }}
                    >
                      {[130, 75, 42, 48, 52, 28, 40].map((w, j) => (
                        <div
                          key={j}
                          className="skeleton-bar"
                          style={{ height: 10, width: w, borderRadius: 3 }}
                        />
                      ))}
                    </div>
                  ))
                ) : sortedVaults.length === 0 ? (
                  <div
                    style={{
                      padding: '16px 18px',
                      textAlign: 'center',
                      fontSize: 12,
                      color: 'var(--text-faint)',
                    }}
                  >
                    no vaults match this filter
                  </div>
                ) : (
                  sortedVaults.map((v, i) => {
                    const active = isActive(v)
                    const bal = getPositionBalance(v)
                    const stats = statsFor(v)
                    const prevP = pulse.prev.find((x) => x.name === v.name)
                    const prevDelta = prevP ? +(v.apy - prevP.apy).toFixed(2) : null
                    const pp1d = ppMeta(stats?.change1d ?? prevDelta)
                    const riskColor =
                      v.risk === 'low' ? 'var(--ok)' : v.risk === 'medium' ? '#f59e0b' : '#f97316'
                    return (
                      <div
                        key={v.poolId || `${v.name}-${i}`}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: GRID_COLS,
                          alignItems: 'center',
                          gap: 8,
                          padding: '11px 18px',
                          paddingLeft: active ? 16 : 18,
                          borderTop: i ? '1px solid var(--border)' : 'none',
                          borderLeft: `2px solid ${active ? 'var(--ok)' : 'transparent'}`,
                          background: active ? 'rgba(255,255,255,.02)' : undefined,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12.5,
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            textDecorationColor: 'var(--border)',
                          }}
                          onClick={() => v.protocol && navigateTo('vault', v.protocol)}
                        >
                          {active && (
                            <span style={{ color: 'var(--ok)', marginRight: 5, fontSize: 9 }}>
                              ●
                            </span>
                          )}
                          {v.name}
                        </span>
                        <span
                          className="mono"
                          style={{ fontSize: 10.5, color: 'var(--text-muted)' }}
                        >
                          {v.protocol}
                        </span>
                        <span className="vault-apy">
                          <span
                            className="mono tnum apy-value"
                            style={{ fontSize: 12.5, fontWeight: v.apy > 8 ? 600 : 400 }}
                          >
                            {Number(v.apy).toFixed(1)}%
                          </span>
                          {pp1d && <span className={`apy-change ${pp1d.cls}`}>{pp1d.text}</span>}
                        </span>
                        <span className="vault-sparkline">
                          {stats ? (
                            <span
                              dangerouslySetInnerHTML={{
                                __html: generateSparkline(stats.values, { width: 64, height: 24 }),
                              }}
                            />
                          ) : v.poolId ? (
                            <span className="sparkline-loading">····</span>
                          ) : (
                            <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>-</span>
                          )}
                        </span>
                        <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                          {v.tvlFormatted || '-'}
                        </span>
                        <span className="mono" style={{ fontSize: 11, color: riskColor }}>
                          {v.risk === 'medium' ? 'med' : v.risk || '-'}
                        </span>
                        <span>
                          {active && bal !== null ? (
                            <span
                              className="mono tnum"
                              style={{ fontSize: 11, color: 'var(--ok)' }}
                            >
                              {bal.toFixed(2)} USDC
                            </span>
                          ) : (
                            <button style={linkBtn} onClick={() => handleFarm(v)}>
                              Farm
                            </button>
                          )}
                        </span>
                      </div>
                    )
                  })
                )}
              </div>

              <button
                className="btn btn-primary"
                style={{ marginTop: 14 }}
                onClick={onStartStrategy}
              >
                Start New Strategy →
              </button>
            </Collapsible>

            {/* ── RECENT ACTIVITY (collapsed by default) ── */}
            <Collapsible
              title={t(lang, 'recentActivity')}
              count={activity.length}
              meta={
                <button
                  style={linkBtn}
                  onClick={(e) => {
                    e.preventDefault()
                    onViewHistory()
                  }}
                >
                  View all →
                </button>
              }
            >
              <div style={{ ...card }}>
                {activity.length === 0 ? (
                  <div className="empty" style={{ padding: '14px 18px' }}>
                    No activity yet.
                  </div>
                ) : (
                  activity.map((e, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '11px 18px',
                        borderTop: i ? '1px solid var(--border)' : 'none',
                      }}
                    >
                      <span
                        className="mono"
                        style={{ color: e.color, width: 14, textAlign: 'center' }}
                      >
                        {e.icon}
                      </span>
                      <span style={{ flex: 1, fontSize: 12.5 }}>{e.text}</span>
                      <span
                        className="mono"
                        style={{ fontSize: 10.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}
                      >
                        {formatTime(e.ts, now)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Collapsible>
          </>
        )}
      </div>

      {withdrawVault && (
        <WithdrawModal
          vault={withdrawVault.vault}
          balance={withdrawVault.balance}
          unclaimedRewards={withdrawVault.unclaimedRewards}
          userAddress={userAddress}
          onClose={() => setWithdrawVault(null)}
          onSuccess={onWithdrawSuccess || (() => {})}
        />
      )}
    </div>
  )
}
