// SkillEditModal.jsx
// Form-based skill editor. Exposes only user-adjustable guards — not raw JSON.
import React, { useState, useEffect } from 'react';

export default function SkillEditModal({ agent, skill, onClose, onSave }) {
  const rawExpiry   = String(skill.guards?.expiresIn || '86400').replace(/[^0-9]/g, '');
  const initHours   = Math.floor((parseInt(rawExpiry, 10) || 86400) / 3600);
  const initAmount  = parseInt(skill.guards?.maxAmount || '0', 10) || agent.allocation || 0;
  const initRisk    = skill.guards?.riskProfile || 'medium';
  const initMaxGas  = skill.guards?.maxGas || '200000';

  const [maxAmount,    setMaxAmount]    = useState(String(initAmount));
  const [expiresHours, setExpiresHours] = useState(String(initHours));
  const [risk,         setRisk]         = useState(initRisk);
  const [maxGas,       setMaxGas]       = useState(initMaxGas);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSave = () => {
    const updatedSkill = {
      ...skill,
      guards: {
        ...skill.guards,
        maxAmount:   `${maxAmount} USDC`,
        expiresIn:   String(Math.max(1, parseInt(expiresHours, 10) || 24) * 3600),
        riskProfile: risk,
        maxGas:      maxGas,
      },
    };
    onSave(updatedSkill);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-edit-title"
        style={{ maxWidth: 440 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-eyebrow skill-detail-eyebrow">
          <span id="skill-edit-title">Edit {agent.name} Skill</span>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="skill-edit-field">
          <label className="skill-edit-label" htmlFor="se-amount">Maximum USDC</label>
          <div className="skill-edit-input-row">
            <input
              id="se-amount"
              type="number"
              min="1"
              value={maxAmount}
              onChange={(e) => setMaxAmount(e.target.value)}
              className="skill-edit-input"
              placeholder="40"
            />
            <span className="skill-edit-unit">USDC</span>
          </div>
        </div>

        <div className="skill-edit-field">
          <label className="skill-edit-label" htmlFor="se-hours">Valid for</label>
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
            />
            <span className="skill-edit-unit">hours</span>
          </div>
        </div>

        <div className="skill-edit-field">
          <span className="skill-edit-label">Risk profile</span>
          <div className="skill-edit-radio-group">
            {['low', 'medium', 'high'].map((r) => (
              <label key={r} className="skill-edit-radio">
                <input
                  type="radio"
                  name="skill-risk"
                  value={r}
                  checked={risk === r}
                  onChange={() => setRisk(r)}
                />
                <span>{r}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="skill-edit-field">
          <button
            type="button"
            className="skill-edit-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            Gas cap (advanced) {showAdvanced ? '▲' : '▼'}
          </button>
          {showAdvanced && (
            <div className="skill-edit-input-row" style={{ marginTop: 8 }}>
              <input
                type="number"
                min="21000"
                value={maxGas}
                onChange={(e) => setMaxGas(e.target.value)}
                className="skill-edit-input"
                aria-label="Gas cap"
              />
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save changes</button>
        </div>
      </div>
    </div>
  );
}
