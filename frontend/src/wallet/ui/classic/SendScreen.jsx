import { useState } from 'react'
import { ApproveOverlay } from '../ApproveOverlay.jsx'

export default function SendScreen({ from, onPreview, onConfirm, preview, busy, error }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')

  const stale =
    !!preview &&
    (preview.confirm.ops[0]?.destination !== to ||
      preview.confirm.ops[0]?.amount !== amount ||
      (preview.confirm.memo || '') !== memo)

  return (
    <div className="vf-screen vf-send">
      <h2>Send</h2>
      <label>
        Destination
        <input aria-label="destination" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <label>
        Amount (XLM)
        <input aria-label="amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        Memo (optional)
        <input value={memo} onChange={(e) => setMemo(e.target.value)} />
      </label>
      <button
        className="vf-btn"
        disabled={busy || !to || !amount}
        onClick={() => onPreview({ from, to, asset: 'XLM', amount, memo })}
      >
        Review
      </button>

      {preview && (
        <div className="vf-confirm-card">
          <h3>Confirm — you are signing this</h3>
          <dl>
            <dt>To</dt>
            <dd>{preview.confirm.ops[0]?.destination}</dd>
            <dt>Asset</dt>
            <dd>{preview.confirm.ops[0]?.asset}</dd>
            <dt>Amount</dt>
            <dd>{preview.confirm.ops[0]?.amount}</dd>
            <dt>Memo</dt>
            <dd>{preview.confirm.memo || '—'}</dd>
            <dt>Fee</dt>
            <dd>{preview.confirm.fee} stroops</dd>
          </dl>
          {preview.vault?.hit && (
            <>
              <ApproveOverlay
                verdict={preview.vault}
                onApprove={() => {
                  if (!stale) onConfirm({ from, to, asset: 'XLM', amount, memo })
                }}
                onReject={() => {}}
              />
              <p className="vf-warn">
                This is vault "{preview.vault.name}". A plain payment will NOT deposit — use
                Deposit.
              </p>
            </>
          )}
          {error && <p className="vf-error">{error}</p>}
          {stale && <p className="vf-hint">Inputs changed — click Review again.</p>}
          <button
            className="vf-btn primary"
            disabled={busy || stale}
            onClick={() => onConfirm({ from, to, asset: 'XLM', amount, memo })}
          >
            {busy ? 'Sending…' : 'Confirm & send'}
          </button>
        </div>
      )}
    </div>
  )
}
