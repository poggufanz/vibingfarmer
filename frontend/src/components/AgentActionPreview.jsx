// AgentActionPreview.jsx
// Action preview modal shown before harvest / emergency-withdraw executes.
// Reuses the app's existing modal tokens — no new CSS.
import React, { useEffect, useRef } from 'react'

const Row = ({ k, v }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '3px 0' }}>
    <span style={{ color: 'var(--text-muted)' }}>{k}</span>
    <span className="mono" style={{ textAlign: 'right' }}>{v}</span>
  </div>
)

export default function AgentActionPreview({ preview, onConfirm, onCancel }) {
  const confirmRef = useRef(null)
  // WCAG modal: focus primary action on open, restore focus on close, Escape dismisses.
  useEffect(() => {
    if (!preview) return
    const prev = document.activeElement
    confirmRef.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [preview])

  if (!preview) return null
  const isWithdraw = preview.kind === 'withdraw'
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="agent-preview-title" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-eyebrow">{isWithdraw ? 'risk watcher · emergency exit' : 'reward harvester'}</div>
        <h3 className="modal-title" id="agent-preview-title">{isWithdraw ? 'Emergency Withdraw Preview' : 'Harvest Preview'}</h3>

        <div style={{ margin: '12px 0' }}>
          {isWithdraw ? (
            <>
              <Row k="From" v={preview.vaultName} />
              <Row k="Amount" v={`${preview.amountUsdc} USDC (${preview.pctLabel})`} />
              <Row k="To" v={`${preview.toShort} (your wallet)`} />
              <Row k="Gas" v="~0 · 1Shot relayer" />
              <Row k="Est. receive" v={`~${preview.amountUsdc} USDC`} />
              <Row k="Time" v="~30 seconds" />
            </>
          ) : (
            <>
              <Row k="Vault" v={preview.vaultName} />
              <Row k="Rewards" v={`${preview.rewardsUsdc} USDC unclaimed`} />
              <Row k="Action" v="Claim accrued yield" />
              <Row k="Gas" v="~0 · 1Shot relayer" />
            </>
          )}
        </div>

        {isWithdraw && (
          <p className="lede" style={{ fontSize: 11, marginTop: 4 }}>
            ⚠ Uses your active ERC-7715 withdraw permission.
          </p>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} className="btn btn-primary" onClick={onConfirm}>{isWithdraw ? 'Confirm withdraw' : 'Claim rewards'}</button>
        </div>
      </div>
    </div>
  )
}
