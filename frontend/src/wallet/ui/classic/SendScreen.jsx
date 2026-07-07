import { useState } from 'react'
import { ApproveOverlay } from '../ApproveOverlay.jsx'

export default function SendScreen({ from, onPreview, onConfirm, preview, busy, error }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [reviewed, setReviewed] = useState(null)

  const stale =
    !!preview &&
    !!reviewed &&
    (to !== reviewed.to || amount !== reviewed.amount || memo !== reviewed.memo)

  return (
    <div className="vf-screen vf-send">
      <h2>Send</h2>
      <label>
        Destination
        <input
          aria-label="destination"
          placeholder="G... or federation address"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      <label>
        Amount (XLM)
        <input
          aria-label="amount"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        Memo (optional)
        <input
          placeholder="Text, ID, or hash"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </label>
      <button
        className="vf-btn primary"
        disabled={busy || !to || !amount}
        onClick={() => {
          setReviewed({ to, amount, memo })
          onPreview({ from, to, asset: 'XLM', amount, memo })
        }}
      >
        {busy ? 'Building…' : 'Review transaction'}
      </button>

      {preview && (
        <div className="vf-confirm-card">
          <h3>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4"></path>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
            </svg>
            Confirm transaction
          </h3>
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
