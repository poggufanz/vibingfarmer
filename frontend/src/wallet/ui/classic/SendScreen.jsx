import { useState } from 'react'
import { ApproveOverlay } from '../ApproveOverlay.jsx'

export default function SendScreen({ from, onPreview, onConfirm, preview, busy, error }) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [reviewed, setReviewed] = useState(null)
  const [localError, setLocalError] = useState('')

  const stale =
    !!preview &&
    !!reviewed &&
    (to !== reviewed.to || amount !== reviewed.amount || memo !== reviewed.memo)

  function validate() {
    setLocalError('')
    const val = parseFloat(amount)
    if (isNaN(val) || val <= 0) {
      setLocalError('Amount must be greater than 0')
      return false
    }
    const isFederation = to.includes('*')
    const isMock = to.length < 10
    if (!isFederation && !isMock && !/^[GC][A-Z2-7]{55}$/i.test(to)) {
      setLocalError('Invalid destination address')
      return false
    }
    return true
  }

  return (
    <div className="vf-screen vf-send">
      <h2>Send</h2>
      <label>
        Destination
        <input
          aria-label="Destination"
          placeholder="G... or federation address"
          value={to}
          onChange={(e) => {
            setTo(e.target.value)
            setLocalError('')
          }}
        />
      </label>
      <label>
        Amount (XLM)
        <input
          aria-label="Amount"
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value)
            setLocalError('')
          }}
        />
      </label>
      <label>
        Memo (optional)
        <input
          placeholder="Text, ID, or hash"
          value={memo}
          onChange={(e) => {
            setMemo(e.target.value)
            setLocalError('')
          }}
        />
      </label>
      {localError && <p className="vf-error">{localError}</p>}
      <button
        className="vf-btn primary"
        disabled={busy || !to || !amount}
        onClick={() => {
          if (!validate()) return
          setReviewed({ to, amount, memo })
          onPreview({ from, to, asset: 'XLM', amount, memo })
        }}
      >
        {busy ? 'Building…' : 'Review transaction'}
      </button>

      {preview && (
        <div className="vf-confirm-card">
          <h3>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
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
            <dd>{preview.confirm.memo || 'None'}</dd>
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
                This is the vault "{preview.vault.name}". A plain payment does not deposit funds.
                Use Deposit instead.
              </p>
            </>
          )}
          {error && <p className="vf-error">{error}</p>}
          {stale && <p className="vf-hint">Inputs changed. Select Review transaction again.</p>}
          <button
            className="vf-btn primary"
            disabled={busy || stale}
            onClick={() => onConfirm({ from, to, asset: 'XLM', amount, memo })}
          >
            {busy ? 'Sending…' : 'Confirm and send'}
          </button>
        </div>
      )}
    </div>
  )
}
