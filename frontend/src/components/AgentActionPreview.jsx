// AgentActionPreview.jsx
// Action preview modal shown before harvest / emergency-withdraw executes.
// Document-grade receipt layout, same tokens as grant / withdraw modals.
import React, { useEffect, useRef } from 'react'

export default function AgentActionPreview({ preview, onConfirm, onCancel }) {
  const confirmRef = useRef(null)
  // WCAG modal: focus primary action on open, restore focus on close, Escape dismisses.
  useEffect(() => {
    if (!preview) return
    const prev = document.activeElement
    confirmRef.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [preview])

  if (!preview) return null
  const isWithdraw = preview.kind === 'withdraw'
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal agent-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-preview-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-eyebrow">
          {isWithdraw ? 'Risk watcher: emergency exit' : 'Reward harvester'}
        </div>
        <h3 className="modal-title" id="agent-preview-title">
          {isWithdraw ? 'Emergency withdraw preview' : 'Harvest preview'}
        </h3>

        <div className="grant-receipt agent-preview-receipt" role="region" aria-label="Action summary">
          {isWithdraw ? (
            <>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">From</span>
                <span className="grant-receipt-v">{preview.vaultName}</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Amount</span>
                <span className="grant-receipt-v mono tnum">
                  {preview.amountUsdc} USDC ({preview.pctLabel})
                </span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">To</span>
                <span className="grant-receipt-v mono">{preview.toShort} (your wallet)</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Network fee</span>
                <span className="grant-receipt-v grant-receipt-v--ok">~0, fee-bump relayer</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Est. receive</span>
                <span className="grant-receipt-v mono tnum">~{preview.amountUsdc} USDC</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Time</span>
                <span className="grant-receipt-v mono">~30 seconds</span>
              </div>
            </>
          ) : (
            <>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Vault</span>
                <span className="grant-receipt-v">{preview.vaultName}</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Rewards</span>
                <span className="grant-receipt-v mono tnum">
                  {preview.rewardsUsdc} USDC unclaimed
                </span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Action</span>
                <span className="grant-receipt-v">Claim accrued yield</span>
              </div>
              <div className="grant-receipt-row">
                <span className="grant-receipt-k">Network fee</span>
                <span className="grant-receipt-v grant-receipt-v--ok">~0, fee-bump relayer</span>
              </div>
            </>
          )}
        </div>

        {isWithdraw && (
          <p className="agent-preview-note mono">Uses your active Soroban session-key scope.</p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
          >
            {isWithdraw ? 'Confirm withdraw' : 'Claim rewards'}
          </button>
        </div>
      </div>
    </div>
  )
}
