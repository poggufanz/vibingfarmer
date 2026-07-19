// NotificationCenter.jsx
// Global notification bell + modal. Every agent alert lives behind this single
// top-bar button now — no inline banners, no per-page alert lists. Click the
// bell anywhere (home, wizard, /agent) to review and act on alerts.
import React, { useState, useEffect, useRef } from 'react'
import { AlertCard } from './AlertCard.jsx'
import AgentActionPreview from './AgentActionPreview.jsx'
import { loadSettings } from '../settingsStore.js'
import { Icon } from '../components.jsx'

export default function NotificationCenter({
  alerts = [],
  settings = {},
  positions = {},
  userAddress,
  onHarvest,
  onEmergencyWithdraw,
  onReview,
  onDismiss,
}) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const closeRef = useRef(null)
  const { alertSeverity, language: lang } = loadSettings()

  // Respect the user's severity preferences — the badge count must match the list.
  const visible = alerts.filter((a) => {
    if (a.severity === 'high') return alertSeverity?.high !== false
    if (a.severity === 'medium') return alertSeverity?.medium !== false
    if (a.severity === 'low') return alertSeverity?.low === true
    return true
  })
  const count = visible.length
  const highCount = visible.filter(
    (a) => a.severity === 'high' || a.kind === 'risk_alert'
  ).length
  const actionCount = visible.filter(
    (a) =>
      a.kind === 'harvest_ready' ||
      a.kind === 'rebalance_proposal' ||
      a.kind === 'risk_alert'
  ).length
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement
    closeRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [open])

  // Preview interceptors — actual execution runs on confirm via props (same flow
  // the dashboard used to host). onHarvest is optional; guard so a missing
  // handler never throws.
  const requestHarvest = (a) =>
    setPreview({ kind: 'harvest', alert: a, vaultName: a.vaultName, rewardsUsdc: a.rewardsUsdc })
  const requestWithdraw = (a) =>
    setPreview({
      kind: 'withdraw',
      alert: a,
      vaultName: a.vaultName || a.protocol || 'vault',
      amountUsdc: a.amountUsdc ?? a.balanceUsdc ?? a.positionUsdc ?? '-',
      pctLabel: a.pctLabel || '100%',
      toShort: a.toShort || 'your wallet',
    })
  const confirmPreview = () => {
    if (preview?.kind === 'harvest') onHarvest?.(preview.alert)
    if (preview?.kind === 'withdraw') onEmergencyWithdraw?.(preview.alert)
    setPreview(null)
  }

  const dismissAll = () => {
    visible.forEach((a) => onDismiss?.(a.id))
  }

  return (
    <>
      <button
        type="button"
        className={`icon-btn notif-bell${count > 0 ? ' has-alerts' : ''}${highCount > 0 ? ' has-high' : ''}`}
        title="Notifications"
        aria-label={count > 0 ? `Notifications, ${count} active` : 'Notifications, none'}
        onClick={() => setOpen(true)}
      >
        <Icon name="bell" />
        {count > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal notif-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notif-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="notif-head">
              <div className="modal-eyebrow skill-detail-eyebrow">
                <span className="notif-eyebrow-left">
                  {highCount > 0 && (
                    <span className="notif-live-dot" aria-hidden="true" title="High severity" />
                  )}
                  Agent alerts
                </span>
                <button
                  type="button"
                  className="modal-close-btn"
                  aria-label="Close notifications"
                  onClick={() => setOpen(false)}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>

              <div className="notif-title-row">
                <h3 className="modal-title" id="notif-title">
                  Notifications
                </h3>
                {count > 0 && (
                  <span className="notif-count-pill mono tnum" aria-hidden="true">
                    {count}
                  </span>
                )}
              </div>

              <div className="notif-stat-strip" role="group" aria-label="Alert summary">
                <div className="notif-stat">
                  <span className="notif-stat-k">Active</span>
                  <span className="notif-stat-v mono tnum">{count}</span>
                </div>
                <div className={`notif-stat${highCount > 0 ? ' notif-stat--danger' : ''}`}>
                  <span className="notif-stat-k">High</span>
                  <span className="notif-stat-v mono tnum">{highCount}</span>
                </div>
                <div className={`notif-stat${actionCount > 0 ? ' notif-stat--warn' : ''}`}>
                  <span className="notif-stat-k">Need action</span>
                  <span className="notif-stat-v mono tnum">{actionCount}</span>
                </div>
              </div>
            </div>

            <div className="modal-scroll-content notif-list">
              {count === 0 ? (
                <div className="notif-empty" role="status">
                  <span className="notif-empty-mark" aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                  <div className="notif-empty-copy">
                    <div className="notif-empty-title">All clear</div>
                    <p className="notif-empty-body mono">
                      No active alerts. Harvests, compounds, risk signals, and keeper moves surface
                      here when something needs a look.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="notif-section-label mono">
                    {actionCount > 0
                      ? `${actionCount} need your decision`
                      : 'Read-only updates from agents and keeper'}
                  </div>
                  <div className="notif-stack">
                    {visible.map((a) => (
                      <AlertCard
                        key={a.id}
                        alert={a}
                        lang={lang}
                        onHarvest={requestHarvest}
                        onEmergencyWithdraw={requestWithdraw}
                        onReview={onReview}
                        onDismiss={onDismiss}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="modal-actions notif-foot">
              {count > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={dismissAll}
                  disabled={!onDismiss}
                >
                  Dismiss all
                </button>
              ) : (
                <span className="notif-foot-hint mono">Alerts stay until you dismiss them</span>
              )}
              <button
                ref={closeRef}
                type="button"
                className="btn btn-primary"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <AgentActionPreview
        preview={preview}
        onConfirm={confirmPreview}
        onCancel={() => setPreview(null)}
      />
    </>
  )
}
