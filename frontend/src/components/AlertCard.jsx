// AlertCard.jsx
// Explainable agent alert card. Extracted from AgentDashboard so the global bell
// (NotificationCenter) can import it WITHOUT pulling the whole dashboard into the
// main chunk — that import is what blocked lazy-loading AgentDashboard.
import { useState } from 'react'
import { t } from '../settingsStore.js'

const ALERT_META = {
  harvest_ready:      { dot: '🟢', color: 'var(--ok)',     title: 'Harvest ready' },
  harvest_executed:   { dot: '✓',  color: 'var(--ok)',     title: 'Harvested' },
  harvest_failed:     { dot: '✕',  color: 'var(--danger)', title: 'Harvest failed' },
  rebalance_proposal: { dot: '◉',  color: 'var(--info)',   title: 'Rebalance opportunity' },
  apy_drift:          { dot: '⚠',  color: 'var(--warn)',   title: 'APY drop' },
  risk_alert:         { dot: '🚨', color: 'var(--danger)', title: 'Risk detected' },
}

const alertLine = (a) => {
  switch (a.kind) {
    case 'harvest_ready':      return `${a.vaultName} · ${a.rewardsUsdc} USDC unclaimed`
    case 'harvest_executed':   return `${a.vaultName} · claimed`
    case 'harvest_failed':     return `${a.vaultName} · ${a.error}`
    case 'rebalance_proposal': return `${a.fromVault} ${a.fromApy}% → ${a.toProtocol} ${a.toApy}% (+${a.apyGain}%)`
    case 'apy_drift':          return `${a.vaultName} · ${a.baselineApy}% → ${a.currentApy}% (${a.driftPct}%)`
    case 'risk_alert':         return `${a.vaultName} · security signal detected`
    default:                   return a.vaultName || ''
  }
}

const whyText = (a) => {
  switch (a.kind) {
    case 'apy_drift':          return `APY compressed ${a.driftPct}% since deposit (${a.baselineApy}% → ${a.currentApy}%). Consider rebalancing if the drop persists into the next monitoring cycle.`
    case 'rebalance_proposal': return `${a.toProtocol} currently offers ${a.toApy}% vs your ${a.fromVault} position at ${a.fromApy}% · a ${a.apyGain}% gap. Rebalancing would capture that extra yield (break-even after gas: ~2 days).`
    case 'risk_alert':         return `Severity ${a.severity} · classified by Venice AI. ${(a.searchAnswer || '').slice(0, 180)}`
    case 'harvest_ready':      return `${a.rewardsUsdc} USDC of yield has accrued and is ready to claim. Claiming resets the accrual clock.`
    default:                   return a.error || ''
  }
}

// ─── Shared style primitives ────────────────────────────────────────────────
const mono = { fontFamily: 'var(--font-mono)', fontSize: 10.5 }
const textBtn = (color = 'var(--text-muted)') => ({
  appearance: 'none', border: 0, background: 'transparent',
  fontSize: 11, color, cursor: 'pointer', padding: 0,
  fontFamily: 'var(--font-mono)', lineHeight: 1,
})

// ─── AlertCard ───────────────────────────────────────────────────────────────
// Used by NotificationCenter (the global bell modal). Alerts live in one place
// now — the top-bar bell — not inline on the dashboard page.
export function AlertCard({ alert, lang = 'en', onHarvest, onEmergencyWithdraw, onReview, onDismiss }) {
  const [why, setWhy] = useState(false)
  const meta = ALERT_META[alert.kind] || { dot: '·', color: 'var(--text-muted)', title: alert.kind }
  const src = alert.sources && alert.sources[0]

  const borderColor =
    alert.kind === 'risk_alert'         ? 'var(--danger)' :
    alert.severity === 'high'           ? 'var(--danger)' :
    alert.kind === 'apy_drift'          ? 'var(--warn)'   :
    alert.severity === 'medium'         ? 'var(--warn)'   :
    alert.kind === 'rebalance_proposal' ? 'var(--info)'   :
    meta.color

  const bgTint =
    alert.kind === 'risk_alert'         ? 'rgba(255,116,121,0.04)' :
    alert.kind === 'apy_drift'          ? 'rgba(240,181,74,0.04)'  :
    alert.kind === 'rebalance_proposal' ? 'rgba(122,159,255,0.04)' :
    'rgba(111,227,154,0.04)'

  return (
    <div style={{
      borderLeft: `2px solid ${borderColor}`,
      background: bgTint,
      borderRadius: `0 var(--radius-sm) var(--radius-sm) 0`,
      padding: '10px 12px 10px 14px',
      marginBottom: 6,
    }}>
      {/* Title + dismiss */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden="true" style={{ fontSize: 11 }}>{meta.dot}</span>
            <span style={{ color: 'var(--text)' }}>{meta.title}</span>
            {alert.severity && (
              <span style={{ fontWeight: 400, color: 'var(--text-faint)', fontSize: 10.5 }}>· {alert.severity}</span>
            )}
          </div>
          <div style={{ ...mono, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
            {alertLine(alert)}
          </div>
        </div>
        <button
          style={{ ...textBtn('var(--text-faint)'), fontSize: 15, paddingLeft: 8, lineHeight: 1 }}
          onClick={() => onDismiss(alert.id)}
          aria-label="dismiss"
        >×</button>
      </div>

      {/* Actions row */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 8, gap: 12 }}>
        <button
          style={{ ...textBtn('var(--text-faint)'), textDecoration: 'underline', textDecorationColor: 'var(--border-strong)' }}
          aria-expanded={why}
          onClick={() => setWhy((v) => !v)}
        >
          Why? {why ? '↑' : '↗'}
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
          {alert.kind === 'harvest_ready' && (
            <button style={textBtn('var(--ok)')} onClick={() => onHarvest(alert)}>
              {t(lang, 'harvest')} →
            </button>
          )}
          {alert.kind === 'rebalance_proposal' && (
            <button style={textBtn('var(--text)')} onClick={() => onReview(alert)}>
              Review →
            </button>
          )}
          {alert.kind === 'risk_alert' && (
            <button style={textBtn('var(--danger)')} onClick={() => onEmergencyWithdraw(alert)}>
              Emergency withdraw →
            </button>
          )}
        </div>
      </div>

      {/* Why expanded */}
      {why && (
        <div style={{
          ...mono, color: 'var(--text-muted)', lineHeight: 1.55,
          marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
        }}>
          {whyText(alert)}
          {src && (
            <div style={{ marginTop: 4 }}>
              Source:{' '}
              <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--info)', textDecoration: 'none' }}>
                {(src.title || src.url).slice(0, 48)} ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
