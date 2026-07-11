// frontend/src/components/GrantPanel.jsx
// The single-signature grant step. Replaces the legacy per-agent "Grant N permissions" batch: the user
// sets a spending budget + a validity window, then a SINGLE "Grant & run" signature authorizes the
// funding_router to deploy the run's agents and pull within that budget. A small revoke control
// zeroes the on-chain allowance (kill switch) with one more signature. Presentational only — all chain
// work is done by the caller's onGrant / onRevoke (stellar/grant.js).
import { useState } from 'react'

// ~5s per ledger on Soroban testnet; the labels are what the user reasons about, the seconds are
// what the grant converts to an allowance expiry_ledger.
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

  const submit = () => {
    if (!budgetValid || busy) return
    onGrant?.({ budget: budgetNum, durationSeconds: preset.seconds, durationId })
  }

  return (
    <section className="card grant-panel enter">
      <div className="eyebrow">
        <span className="num">04</span>
        <span>One signature · router grant</span>
        <span className="rule" />
        <span>then fully autonomous · 0 further signatures</span>
      </div>

      <h1 className="h-display">Grant a budget once. Every agent funds and deposits within it.</h1>
      <p className="lede">
        A single signature approves the <span className="mono">funding router</span> to deploy this
        run’s {agentCount || ''} agent{agentCount === 1 ? '' : 's'} and move up to your budget — for
        the window you choose. Outside the budget or after it expires, the router can move{' '}
        <b>nothing</b>. Revoke any time.
      </p>

      <div className="grant-controls">
        <label className="grant-field">
          <span className="grant-field-k">budget · USDC</span>
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
              enter a positive amount
            </span>
          )}
        </label>

        <div className="grant-field">
          <span className="grant-field-k">valid for</span>
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
          Budget caps total spend · each agent still has its own per-vault cap · router holds no
          funds.
        </div>
        <button className="btn btn-primary btn-lg" onClick={submit} disabled={!budgetValid || busy}>
          {phase === 'granting' ? 'awaiting wallet…' : 'Grant & run'}
        </button>
      </div>

      <div className="grant-revoke-row">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onRevoke?.()}
          disabled={busy}
        >
          {phase === 'revoking' ? 'revoking…' : 'Revoke grant'}
        </button>
        <span className="annot">
          sets the on-chain allowance to 0 · a single signature · works even if the relayer is down
        </span>
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>
          {error}
        </div>
      )}
    </section>
  )
}
