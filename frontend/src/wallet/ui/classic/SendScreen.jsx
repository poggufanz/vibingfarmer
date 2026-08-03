import { useState } from 'react'
import { ApproveOverlay } from '../ApproveOverlay.jsx'

// VF Wallet Task 10, Step 2 -- action availability is model-specific, not a blanket "every
// account can do everything." Standard (G) Send has an existing, tested submit path (this file's
// own preview/confirm flow, exercised end-to-end by SendScreen.test.jsx). Passkey (C) Send does
// not: popup.jsx's old passkey send handler only ever built unsigned XDR and said so out loud
// ("On-chain send isn't wired in this build") -- transaction BUILDING is not a submit path. Until
// a real passkey submit path exists and is end-to-end tested, rendering the form here would be a
// dead button that fails, not fails closed. `supported` defaults to true so every existing
// Standard caller (and this file's pre-existing tests) is unaffected.
export default function SendScreen({
  from,
  onPreview,
  onConfirm,
  preview,
  busy,
  error,
  supported = true,
}) {
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

  if (!supported) {
    return (
      <div data-testid="send-screen-unsupported">
        <p className="pc-field-help">
          Send is not available yet for this account type. Use Receive to get funds instead.
        </p>
      </div>
    )
  }

  return (
    <div className="pc-standard-form" data-testid="send-screen">
      <div className="pc-field">
        <label htmlFor="send-to">Destination</label>
        <input
          id="send-to"
          className="pc-input"
          aria-label="Destination"
          placeholder="G... or federation address"
          value={to}
          onChange={(e) => {
            setTo(e.target.value)
            setLocalError('')
          }}
        />
      </div>
      <div className="pc-field">
        <label htmlFor="send-amount">Amount (XLM)</label>
        <input
          id="send-amount"
          className="pc-input"
          aria-label="Amount"
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value)
            setLocalError('')
          }}
        />
      </div>
      <div className="pc-field">
        <label htmlFor="send-memo">Memo (optional)</label>
        <input
          id="send-memo"
          className="pc-input"
          placeholder="Text, ID, or hash"
          value={memo}
          onChange={(e) => {
            setMemo(e.target.value)
            setLocalError('')
          }}
        />
      </div>
      {localError && <p className="pc-field-error">{localError}</p>}
      <button
        type="button"
        className="pc-button pc-button--primary"
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
        <div className="pc-support" data-testid="send-confirm-card">
          <h3>Confirm transaction</h3>
          {/* VF Wallet Task 10 fix loop 1 (coordinator follow-up) -- the full, untruncated
              destination address has no natural break point, same as Receive's full-address
              display; without .pc-address-full it forces .pc-wallet-main's shared implicit grid
              column (and every row sharing it, header and nav included) past 320/360px, exactly
              the mechanism WalletShell.jsx's own .pc-address-full comment documents. */}
          <p className="pc-technical pc-address-full">To: {preview.confirm.ops[0]?.destination}</p>
          <p className="pc-technical">Asset: {preview.confirm.ops[0]?.asset}</p>
          <p className="pc-technical">Amount: {preview.confirm.ops[0]?.amount}</p>
          <p className="pc-technical">Memo: {preview.confirm.memo || 'None'}</p>
          <p className="pc-technical">Fee: {preview.confirm.fee} stroops</p>
          {preview.vault?.hit && (
            <>
              <ApproveOverlay
                verdict={preview.vault}
                onApprove={() => {
                  if (!stale) onConfirm({ from, to, asset: 'XLM', amount, memo })
                }}
                onReject={() => {}}
              />
              <p className="pc-field-help">
                This is the vault "{preview.vault.name}". A plain payment does not deposit funds.
                Use Deposit instead.
              </p>
            </>
          )}
          {error && <p className="pc-field-error">{error}</p>}
          {stale && (
            <p className="pc-field-help">Inputs changed. Select Review transaction again.</p>
          )}
          <button
            type="button"
            className="pc-button pc-button--primary"
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
