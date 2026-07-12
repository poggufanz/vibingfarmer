// SkillDetailModal.jsx
// Read-only human-readable skill detail. Opens from "View details" on a skill card.
import React, { useEffect } from 'react'
import { Icon } from '../components.jsx'
import { translateSkill, formatProtocol } from '../skills.jsx'

const STEP_LABELS = {
  router_pull: () => 'Pull USDC via funding_router (scoped allowance)',
  vault_deposit: () => 'Deposit to autofarm vault (fee-bump relay)',
  // Legacy labels kept for old skill JSON in memory
  uniswap_v3_swap: () => 'Legacy step (not used on Stellar path)',
  erc20_approve: () => 'Legacy approve (not used on Stellar path)',
  erc4626_deposit: () => 'Deposit to vault',
  erc20_transfer: () => 'Transfer USDC to vault',
}

function labelStep(step) {
  const fn = STEP_LABELS[step.action]
  return fn ? fn(step.params) : step.action
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || 'Not available'
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

const Row = ({ k, v }) => (
  <div className="skill-detail-row">
    <span>{k}</span>
    <span className="mono">{v}</span>
  </div>
)

export default function SkillDetailModal({ agent, skill, state, onClose, onApprove, onEdit }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const info = translateSkill(agent, skill)
  const vaultAddr = skill.target?.vault || agent.vault?.addr || ''
  const network = skill.target?.chain || 'stellar-testnet'
  const rawExpiry = String(skill.guards?.expiresIn || '86400').replace(/[^0-9]/g, '')
  const hours = Math.floor((parseInt(rawExpiry, 10) || 86400) / 3600)
  const isApproved = state === 'approved'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal skill-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-detail-title"
        style={{ maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-eyebrow skill-detail-eyebrow">
          <span id="skill-detail-title">
            {agent.name}, {info.risk}
          </span>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={12} />
          </button>
        </div>

        <div className="skill-detail-section">
          <div className="skill-detail-label">Vault</div>
          <div className="skill-detail-value">{formatProtocol(agent.vault?.protocol)}</div>
          <div className="skill-detail-sub mono">
            {shortAddr(vaultAddr)}, {network}
            {vaultAddr && (
              <a
                href={`https://stellar.expert/explorer/testnet/contract/${vaultAddr}`}
                target="_blank"
                rel="noopener noreferrer"
                className="skill-detail-link"
              >
                View on Stellar Expert
              </a>
            )}
          </div>
        </div>

        <div className="skill-detail-section">
          <div className="skill-detail-label">Execution steps</div>
          {(skill.steps || []).map((step, i) => (
            <div key={step.id} className="skill-detail-step">
              <span className="skill-detail-step-num">{i + 1}.</span>
              <span>{labelStep(step)}</span>
            </div>
          ))}
        </div>

        <div className="skill-detail-section">
          <div className="skill-detail-label">Security limits</div>
          <Row k="Maximum" v={skill.guards?.maxAmount || info.amountVal} />
          <Row k="Fee" v="Fee-bump sponsored" />
          <Row k="Valid for" v={`${hours} hour${hours !== 1 ? 's' : ''} from now`} />
          <Row k="Revocable" v={skill.guards?.revocable ? 'Yes, revoke anytime' : 'No'} />
          <Row k="Risk" v={info.risk} />
        </div>

        <div
          className="modal-actions"
          style={{ justifyContent: 'space-between', alignItems: 'center' }}
        >
          <button className="btn btn-text" onClick={onEdit} style={{ fontSize: 12, opacity: 0.65 }}>
            Edit skill
          </button>
          {isApproved ? (
            <button className="btn btn-ghost" disabled>
              Approved
            </button>
          ) : (
            <button className="btn btn-primary" onClick={onApprove}>
              Approve this worker
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
