// SkillEditModal.jsx
// Form-based skill editor. Exposes only user-adjustable guards — not raw JSON.
// Layout matches GrantPanel / SkillDetail: document receipt + chip presets.
import { useState, useRef } from 'react'
import { Icon } from '../components.jsx'
import { Dialog, StatusNotice } from './pocket/Primitives.jsx'
import './SecondaryDialogs.css'

const RISK_OPTS = [
  { id: 'low', label: 'Low', sub: 'Conservative' },
  { id: 'medium', label: 'Medium', sub: 'Balanced' },
  { id: 'high', label: 'High', sub: 'Aggressive' },
]

const HOUR_PRESETS = [
  { hours: 1, label: '1h' },
  { hours: 24, label: '24h' },
  { hours: 168, label: '7d' },
]

export default function SkillEditModal({ agent, skill, onClose, onSave }) {
  const rawExpiry = String(skill.guards?.expiresIn || '86400').replace(/[^0-9]/g, '')
  const initHours = Math.floor((parseInt(rawExpiry, 10) || 86400) / 3600)
  const initAmount = parseInt(skill.guards?.maxAmount || '0', 10) || agent.allocation || 0
  const initRisk = skill.guards?.riskProfile || 'medium'
  const [maxAmount, setMaxAmount] = useState(String(initAmount))
  const [expiresHours, setExpiresHours] = useState(String(initHours))
  const [risk, setRisk] = useState(initRisk)
  const amountRef = useRef(null)

  const hoursNum = Math.max(1, parseInt(expiresHours, 10) || 24)
  const amountNum = parseInt(maxAmount, 10)
  const amountValid = Number.isFinite(amountNum) && amountNum > 0
  const hoursLabel = hoursNum === 1 ? '1 hour' : hoursNum === 168 ? '7 days' : `${hoursNum} hours`
  const riskLabel = RISK_OPTS.find((r) => r.id === risk)?.label || risk

  const handleSave = () => {
    if (!amountValid) return
    const updatedSkill = {
      ...skill,
      guards: {
        ...skill.guards,
        maxAmount: `${amountNum} USDC`,
        expiresIn: String(hoursNum * 3600),
        riskProfile: risk,
        feeMode: 'fee-bump',
      },
    }
    onSave(updatedSkill)
  }

  return (
    <Dialog
      open
      title={`Edit ${agent.name}`}
      description="Tighten the deposit cap, window, and risk before you approve. These become on-chain scope bounds."
      onClose={onClose}
      initialFocusRef={amountRef}
      className="secondary-dialog secondary-dialog--wide secondary-dialog--skill-edit"
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!amountValid}
          >
            Save changes
          </button>
        </>
      }
    >
      <div className="secondary-dialog-eyebrow">
        <span>Guards for this worker</span>
        <button
          className="secondary-dialog-close"
          onClick={onClose}
          aria-label="Close"
          type="button"
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {!amountValid && (
        <div className="secondary-dialog-error" aria-live="assertive">
          <StatusNotice state="danger" title="Maximum amount required">
            Enter a positive amount.
          </StatusNotice>
        </div>
      )}

      <div className="skill-edit-fields">
        <label className="skill-edit-field" htmlFor="se-amount">
          <span className="skill-edit-label">Maximum USDC</span>
          <div className="skill-edit-amount-row">
            <input
              ref={amountRef}
              id="se-amount"
              aria-label="Maximum USDC"
              type="number"
              min="1"
              inputMode="decimal"
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              className="skill-edit-amount-input mono tnum"
              placeholder="40"
            />
            <span className="skill-edit-amount-unit">USDC</span>
          </div>
          {amountValid && (
            <span className="skill-edit-hint">Hard cap for this worker&rsquo;s deposits.</span>
          )}
        </label>

        <div className="skill-edit-field">
          <span className="skill-edit-label" id="se-hours-label">
            Valid for
          </span>
          <div className="skill-edit-presets" role="group" aria-labelledby="se-hours-label">
            {HOUR_PRESETS.map((p) => (
              <button
                key={p.hours}
                type="button"
                className={`btn btn-chip${Number(expiresHours) === p.hours ? ' is-active' : ''}`}
                aria-pressed={Number(expiresHours) === p.hours}
                onClick={() => setExpiresHours(String(p.hours))}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="skill-edit-input-row">
            <input
              id="se-hours"
              type="number"
              min="1"
              max="720"
              value={expiresHours}
              onChange={(e) => setExpiresHours(e.target.value)}
              className="skill-edit-input"
              placeholder="24"
              aria-label="Custom validity in hours"
            />
            <span className="skill-edit-unit">hours</span>
          </div>
          <span className="skill-edit-hint">
            Scope expires after this window; re-approve to renew.
          </span>
        </div>

        <div className="skill-edit-field">
          <span className="skill-edit-label" id="se-risk-label">
            Risk profile
          </span>
          <div className="risk-row skill-edit-risk" role="group" aria-labelledby="se-risk-label">
            {RISK_OPTS.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`risk-opt${risk === r.id ? ' selected' : ''}`}
                aria-pressed={risk === r.id}
                onClick={() => setRisk(r.id)}
              >
                <span className="risk-opt-label">{r.label}</span>
                <span className="risk-opt-sub">{r.sub}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grant-receipt skill-edit-receipt" role="region" aria-label="Updated limits">
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Maximum</span>
          <span className="grant-receipt-v mono tnum">
            {amountValid ? `${amountNum} USDC` : '--'}
          </span>
        </div>
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Valid for</span>
          <span className="grant-receipt-v">{hoursLabel}</span>
        </div>
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Risk</span>
          <span className="grant-receipt-v">{riskLabel}</span>
        </div>
        <div className="grant-receipt-row">
          <span className="grant-receipt-k">Network fee</span>
          <span className="grant-receipt-v grant-receipt-v--ok">Sponsored by fee-bump relay</span>
        </div>
      </div>
    </Dialog>
  )
}
