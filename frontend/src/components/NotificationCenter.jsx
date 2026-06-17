// NotificationCenter.jsx
// Global notification bell + modal. Every agent alert lives behind this single
// top-bar button now — no inline banners, no per-page alert lists. Click the
// bell anywhere (home, wizard, /agent) to review and act on alerts.
import React, { useState, useEffect } from 'react'
import { AlertCard } from './AlertCard.jsx'
import AgentActionPreview from './AgentActionPreview.jsx'
import { loadSettings } from '../settingsStore.js'
import { Icon } from '../components.jsx'

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

export default function NotificationCenter({
  alerts = [], settings = {}, positions = {}, userAddress,
  onHarvest, onEmergencyWithdraw, onReview, onDismiss,
}) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  const { alertSeverity, language: lang } = loadSettings()

  // Respect the user's severity preferences — the badge count must match the list.
  const visible = alerts.filter((a) => {
    if (a.severity === 'high')   return alertSeverity?.high !== false
    if (a.severity === 'medium') return alertSeverity?.medium !== false
    if (a.severity === 'low')    return alertSeverity?.low === true
    return true
  })
  const count = visible.length

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Preview interceptors — actual execution runs on confirm via props (same flow
  // the dashboard used to host). onHarvest is optional; guard so a missing
  // handler never throws.
  const requestHarvest = (a) => setPreview({ kind: 'harvest', alert: a, vaultName: a.vaultName, rewardsUsdc: a.rewardsUsdc })
  const requestWithdraw = (a) => {
    const bal = Number(positions[a.vaultAddress]?.balance || 0)
    const amtUnits = settings.emergencyFull ? bal : Math.floor(bal * (settings.emergencyPct || 50) / 100)
    setPreview({
      kind: 'withdraw', alert: a, vaultName: a.vaultName,
      amountUsdc: (amtUnits / 1e6).toFixed(2),
      pctLabel: settings.emergencyFull ? 'full position' : `${settings.emergencyPct || 50}% · your setting`,
      toShort: short(userAddress),
    })
  }
  const confirmPreview = () => {
    if (preview?.kind === 'harvest') onHarvest?.(preview.alert)
    else if (preview?.kind === 'withdraw') onEmergencyWithdraw?.(preview.alert)
    setPreview(null)
  }

  return (
    <>
      <button
        className="icon-btn"
        title="notifications"
        aria-label={count > 0 ? `notifications · ${count} active` : 'notifications · none'}
        onClick={() => setOpen(true)}
        style={{ position: 'relative' }}
      >
        <Icon name="bell" />
        {count > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', top: -3, right: -3,
              minWidth: 15, height: 15, padding: '0 3px', boxSizing: 'border-box',
              borderRadius: 8, background: 'var(--danger)', color: '#fff',
              fontSize: 9, fontWeight: 700, lineHeight: '15px', textAlign: 'center',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notif-title"
            style={{ maxWidth: 460, width: '100%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-eyebrow">agent · alerts</div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <h3 className="modal-title" id="notif-title">Notifications{count > 0 ? ` · ${count}` : ''}</h3>
              <button className="icon-btn" aria-label="close notifications" onClick={() => setOpen(false)}>
                <Icon name="x" />
              </button>
            </div>

            <div style={{ marginTop: 12, maxHeight: '60vh', overflowY: 'auto' }}>
              {count === 0 ? (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  borderLeft: '2px solid var(--ok)',
                  background: 'rgba(111,227,154,0.04)',
                  borderRadius: `0 var(--radius-sm) var(--radius-sm) 0`,
                  padding: '12px 14px',
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ok)', marginTop: 5, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 3 }}>All clear</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                      No active alerts. The agent surfaces anything that needs your decision right here.
                    </div>
                  </div>
                </div>
              ) : (
                visible.map((a) => (
                  <AlertCard
                    key={a.id}
                    alert={a}
                    lang={lang}
                    onHarvest={requestHarvest}
                    onEmergencyWithdraw={requestWithdraw}
                    onReview={onReview}
                    onDismiss={onDismiss}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <AgentActionPreview preview={preview} onConfirm={confirmPreview} onCancel={() => setPreview(null)} />
    </>
  )
}
