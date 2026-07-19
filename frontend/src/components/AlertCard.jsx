// AlertCard.jsx
// Explainable agent alert card. Extracted from AgentDashboard so the global bell
// (NotificationCenter) can import it WITHOUT pulling the whole dashboard into the
// main chunk — that import is what blocked lazy-loading AgentDashboard.
import { useState } from 'react'
import { t } from '../settingsStore.js'
import { Icon } from '../components.jsx'

const ALERT_META = {
  harvest_ready: { tone: 'ok', title: 'Harvest ready' },
  harvest_executed: { tone: 'ok', title: 'Harvested' },
  harvest_failed: { tone: 'danger', title: 'Harvest failed' },
  rebalance_proposal: { tone: 'info', title: 'Rebalance opportunity' },
  apy_drift: { tone: 'warn', title: 'APY drop' },
  risk_alert: { tone: 'danger', title: 'Risk detected' },
  // vf-autofarm keeper feed: keeper Worker compound/rebalance calls, surfaced
  // read-only. These are facts the keeper already acted on, not proposals awaiting a decision.
  compound_executed: { tone: 'ok', title: 'Compounded' },
  rebalance_executed: { tone: 'info', title: 'Rebalanced' },
  blnd_held: { tone: 'warn', title: 'BLND held' },
  // Upgrade timelock visibility (surface-only) — schedule_upgrade/execute_upgrade/
  // cancel_upgrade (soroban/contracts/autofarm_vault). No auto-derisk, no on-chain action;
  // these three kinds only ever inform the holder.
  vault_upgrade_scheduled: { tone: 'warn', title: 'Vault upgrade scheduled' },
  vault_upgrade_executed: { tone: 'info', title: 'Vault upgrade executed' },
  vault_upgrade_cancelled: { tone: 'ok', title: 'Vault upgrade cancelled' },
}

const shortHash = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '')
const etaDate = (eta) => (eta ? new Date(eta * 1000).toLocaleString() : '')

const displayLabel = (value) =>
  String(value || 'Alert')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())

const alertLine = (a) => {
  switch (a.kind) {
    case 'harvest_ready':
      return `${a.vaultName}, ${a.rewardsUsdc} USDC unclaimed`
    case 'harvest_executed':
      return `${a.vaultName}, claimed`
    case 'harvest_failed':
      return `${a.vaultName}, ${a.error}`
    case 'rebalance_proposal':
      return `${a.fromVault} ${a.fromApy}% → ${a.toProtocol} ${a.toApy}% (+${a.apyGain}%)`
    case 'apy_drift':
      return `${a.vaultName}, ${a.baselineApy}% → ${a.currentApy}% (${a.driftPct}%)`
    case 'risk_alert':
      return `${a.vaultName}, security signal detected`
    case 'compound_executed':
      return `${a.vaultName}, ${a.totalGainUsdc} USDC gained, price/share ${a.pricePerShare}`
    case 'rebalance_executed':
      return `${a.vaultName}, ${a.fromLabel} → ${a.toLabel}, ${a.amountUsdc} USDC moved`
    case 'blnd_held':
      return `${a.vaultName}, ${a.blndHeld} BLND held, not swapped`
    case 'vault_upgrade_scheduled':
      return `${a.vaultName}, executable ${etaDate(a.eta)}`
    case 'vault_upgrade_executed':
      return `${a.vaultName}, wasm ${shortHash(a.wasmHashHex)} now live`
    case 'vault_upgrade_cancelled':
      return `${a.vaultName}, upgrade cancelled`
    default:
      return a.vaultName || ''
  }
}

const whyText = (a) => {
  switch (a.kind) {
    case 'apy_drift':
      return `APY compressed ${a.driftPct}% since deposit (${a.baselineApy}% → ${a.currentApy}%). Consider rebalancing if the drop persists into the next monitoring cycle.`
    case 'rebalance_proposal':
      return `${a.toProtocol} currently offers ${a.toApy}% vs your ${a.fromVault} position at ${a.fromApy}%, a ${a.apyGain}% gap. Rebalancing would capture that extra yield (break-even after gas: ~2 days).`
    case 'risk_alert':
      return `Severity ${a.severity}, classified by Venice AI. ${(a.searchAnswer || '').slice(0, 180)}`
    case 'harvest_ready':
      return `${a.rewardsUsdc} USDC of yield has accrued and is ready to claim. Claiming resets the accrual clock.`
    case 'compound_executed':
      return `The keeper harvested every strategy and reinvested the gain automatically. No action needed. Price per share is now ${a.pricePerShare}, reflecting the real compounding.`
    case 'rebalance_executed':
      return `The keeper moved funds from ${a.fromLabel} to ${a.toLabel} to chase a better rate, within its on-chain cooldown and size-cap limits. No action needed.`
    case 'blnd_held':
      return `BLND rewards were claimed but held rather than swapped this round (no swap route or a zero min-out). No USDC value has been realized from them yet.`
    case 'vault_upgrade_scheduled':
      return `Vault upgrade scheduled, executable ${etaDate(a.eta)}. You can withdraw before then. Wasm hash ${shortHash(a.wasmHashHex)}.`
    case 'vault_upgrade_executed':
      return `Vault upgrade executed. New bytecode (wasm ${shortHash(a.wasmHashHex)}) is now live.`
    case 'vault_upgrade_cancelled':
      return `Vault upgrade cancelled. Wasm ${shortHash(a.wasmHashHex)} will not be deployed.`
    default:
      return a.error || ''
  }
}

/** Semantic tone for left edge + mark. High severity always wins over kind defaults. */
function resolveTone(alert, meta) {
  if (alert.kind === 'risk_alert' || alert.severity === 'high') return 'danger'
  if (alert.severity === 'medium') return 'warn'
  return meta.tone || 'neutral'
}

// ─── AlertCard ───────────────────────────────────────────────────────────────
// Used by NotificationCenter (the global bell modal). Alerts live in one place
// now — the top-bar bell — not inline on the dashboard page.
export function AlertCard({
  alert,
  lang = 'en',
  onHarvest,
  onEmergencyWithdraw,
  onReview,
  onDismiss,
}) {
  const [why, setWhy] = useState(false)
  const meta = ALERT_META[alert.kind] || {
    tone: 'neutral',
    title: displayLabel(alert.kind),
  }
  const tone = resolveTone(alert, meta)
  const src = alert.sources && alert.sources[0]
  const needsAction =
    alert.kind === 'harvest_ready' ||
    alert.kind === 'rebalance_proposal' ||
    alert.kind === 'risk_alert'

  return (
    <article className={`alert-card alert-card--${tone}`} data-kind={alert.kind}>
      <div className="alert-card-head">
        <span className={`alert-card-mark alert-card-mark--${tone}`} aria-hidden="true" />
        <div className="alert-card-titles">
          <div className="alert-card-title-row">
            <h4 className="alert-card-title">{meta.title}</h4>
            {alert.severity && (
              <span className={`alert-card-sev alert-card-sev--${alert.severity}`}>
                {alert.severity}
              </span>
            )}
          </div>
          <p className="alert-card-line mono">{alertLine(alert)}</p>
        </div>
        <button
          type="button"
          className="alert-card-dismiss"
          onClick={() => onDismiss(alert.id)}
          aria-label="Dismiss alert"
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="alert-card-actions">
        <button
          type="button"
          className={`alert-card-why-btn${why ? ' is-open' : ''}`}
          aria-expanded={why}
          onClick={() => setWhy((v) => !v)}
        >
          {why ? 'Hide detail' : 'Why?'}
        </button>
        {needsAction && (
          <div className="alert-card-cta">
            {alert.kind === 'harvest_ready' && (
              <button
                type="button"
                className="btn btn-chip alert-card-cta-btn alert-card-cta-btn--ok"
                onClick={() => onHarvest(alert)}
              >
                {t(lang, 'harvest')}
              </button>
            )}
            {alert.kind === 'rebalance_proposal' && (
              <button
                type="button"
                className="btn btn-chip alert-card-cta-btn"
                onClick={() => onReview(alert)}
              >
                Review
              </button>
            )}
            {alert.kind === 'risk_alert' && (
              <button
                type="button"
                className="btn btn-chip alert-card-cta-btn alert-card-cta-btn--danger"
                onClick={() => onEmergencyWithdraw(alert)}
              >
                Emergency withdraw
              </button>
            )}
          </div>
        )}
      </div>

      {why && (
        <div className="alert-card-detail">
          <p className="alert-card-detail-body mono">{whyText(alert)}</p>
          {src && (
            <div className="alert-card-source mono">
              Source:{' '}
              <a href={src.url} target="_blank" rel="noopener noreferrer">
                {(src.title || src.url).slice(0, 48)}
              </a>
            </div>
          )}
        </div>
      )}
    </article>
  )
}
