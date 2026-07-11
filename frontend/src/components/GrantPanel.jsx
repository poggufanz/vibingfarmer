// frontend/src/components/GrantPanel.jsx
// Single-signature grant step: budget + validity window, then "Grant & run".
// UX: plain permission receipt (money-app trust), not wizard jargon.
import { useState } from 'react'

// ~5s per ledger on Soroban testnet; labels are what the user reasons about.
export const DURATION_PRESETS = [
  { id: '1h', label: '1 hour', seconds: 3600 },
  { id: '24h', label: '24 hours', seconds: 86400 },
  { id: '7d', label: '7 days', seconds: 604800 },
]

export default function GrantPanel({
  defaultBudget = 100,
  agentCount = 0,
  onGrant,
  onRevoke,
  phase = 'idle',
  error = null,
}) {
  const [budget, setBudget] = useState(defaultBudget)
  const [durationId, setDurationId] = useState('24h')
  const preset = DURATION_PRESETS.find((d) => d.id === durationId) || DURATION_PRESETS[1]

  const budgetNum = Number(budget)
  const budgetValid = Number.isFinite(budgetNum) && budgetNum > 0
  const busy = phase === 'granting' || phase === 'revoking'
  const n = agentCount || 0

  const submit = () => {
    if (!budgetValid || busy) return
    onGrant?.({ budget: budgetNum, durationSeconds: preset.seconds, durationId })
  }

  return (
    <section className="card grant-panel enter">
      <p className="grant-kicker mono">One signature · then agents run</p>

      <h1 className="h-display">Review your spending limit</h1>
      <p className="lede">
        You authorize a budget and time window. Agents deposit only within that limit. Outside the
        budget or after it expires, nothing moves. Revoke any time.
      </p>

      <div className="grant-receipt" role="region" aria-label="Permission summary">
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Spending limit</span>
          <span className="grant-receipt-v tnum mono">
            {budgetValid ? `${budgetNum} USDC` : '--'}
          </span>
        </div>
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Valid for</span>
          <span className="grant-receipt-v">{preset.label}</span>
        </div>
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Workers</span>
          <span className="grant-receipt-v">
            {n} agent{n === 1 ? '' : 's'} · deposits only
          </span>
        </div>
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Network fees</span>
          <span className="grant-receipt-v grant-receipt-v--ok">Covered by relayer</span>
        </div>
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Your control</span>
          <span className="grant-receipt-v">Revoke anytime · funds stay yours</span>
        </div>
      </div>

      <div className="grant-controls">
        <label className="grant-field">
          <span className="grant-field-k">Budget · USDC</span>
          <input
            className="grant-budget-input mono"
            type="number"
            min="0"
            step="1"
            inputMode="decimal"
            aria-label="grant budget in USDC"
            value={budget}
            disabled={busy}
            onChange={(e) => setBudget(e.target.value)}
          />
          {!budgetValid && (
            <span className="grant-field-hint" style={{ color: 'var(--danger)' }}>
              Enter a positive amount
            </span>
          )}
        </label>

        <div className="grant-field">
          <span className="grant-field-k">Valid for</span>
          <div className="grant-presets" role="group" aria-label="grant duration">
            {DURATION_PRESETS.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`btn btn-chip${d.id === durationId ? ' is-active' : ''}`}
                aria-pressed={d.id === durationId}
                disabled={busy}
                onClick={() => setDurationId(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="action-row">
        <div className="foot-note">
          Limit is total spend. Each vault also has its own cap. Router never holds your funds.
        </div>
        <button className="btn btn-primary btn-lg" onClick={submit} disabled={!budgetValid || busy}>
          {phase === 'granting' ? 'Awaiting wallet…' : 'Grant & run'}
        </button>
      </div>

      <div className="grant-revoke-row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onRevoke?.()}
          disabled={busy}
        >
          {phase === 'revoking' ? 'Revoking…' : 'Revoke grant'}
        </button>
        <span className="annot">Sets allowance to 0 · one signature · works if relayer is down</span>
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>
          {error}
        </div>
      )}
    </section>
  )
}
