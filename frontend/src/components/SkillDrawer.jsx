import React, { useState, useEffect, useRef } from 'react';
import { Icon } from '../components.jsx';
import { loadVaultSkill, saveUserSkill, clearUserSkill } from '../skillLoader.js';

const SkillDrawer = ({ open, onClose, skillSource, onSkillChange }) => {
  const isCustomSource = skillSource === 'user-local' || skillSource === 'user-file';
  const [mode, setMode] = useState(isCustomSource ? 'custom' : 'default');
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const taRef = useRef(null);
  const fileRef = useRef(null);

  // On open: sync mode to current source and prefill custom content
  useEffect(() => {
    if (!open) return;
    setError(null);
    setMode(isCustomSource ? 'custom' : 'default');
    if (isCustomSource) {
      loadVaultSkill().then(({ content, source }) => {
        if (source === 'user-local' || source === 'user-file') setText(content);
      });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectCustom = () => { setMode('custom'); setError(null); setTimeout(() => taRef.current?.focus(), 0); };
  const selectDefault = () => { setMode('default'); setError(null); };

  const onUpload = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setText(String(reader.result || '')); setMode('custom'); };
    reader.readAsText(f);
  };

  const apply = () => {
    if (mode === 'default') {
      clearUserSkill();
      onSkillChange('default');
      onClose();
      return;
    }
    if (!text.trim()) { setError('strategy cannot be empty'); return; }
    saveUserSkill(text);
    onSkillChange('user-local');
    onClose();
  };

  return (
    <>
      {open && <div className="skill-drawer-overlay" onClick={onClose} />}
      <div className={`skill-drawer ${open ? 'open' : ''}`} role="dialog" aria-modal="true" aria-label="Vault Advisor Skill">
        <div className="skill-drawer-head">
          <div>
            <div className="skill-drawer-title">Vault Advisor Skill</div>
            <div className="skill-drawer-sub">Choose how Venice AI selects vaults</div>
          </div>
          <button className="icon-btn" aria-label="close" onClick={onClose}><Icon name="x" /></button>
        </div>

        <div className="skill-drawer-body">
          <button className={`skill-opt ${mode === 'default' ? 'sel' : ''}`} onClick={selectDefault}>
            <span className="skill-radio" />
            <span className="skill-opt-main">
              <span className="skill-opt-title">Default Strategy by Vibing Farmer</span>
              <span className="skill-opt-desc">
                Built-in expert DeFi framework. Based on institutional vault eval methodology (Tesseract, Credora, Steakhouse Financial).
              </span>
              <span className="skill-opt-meta mono">4 vaults · always up to date</span>
            </span>
          </button>

          <button className={`skill-opt ${mode === 'custom' ? 'sel' : ''}`} onClick={selectCustom}>
            <span className="skill-radio" />
            <span className="skill-opt-main">
              <span className="skill-opt-title">Custom Strategy</span>
            </span>
          </button>

          <div className="skill-custom-area">
            <textarea
              ref={taRef}
              className="skill-textarea mono"
              placeholder={"# My Vault Strategy\nYou are a DeFi advisor..."}
              value={text}
              disabled={mode !== 'custom'}
              onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
            />
            <input ref={fileRef} type="file" accept=".md,.txt" hidden onChange={onUpload} />
            <button className="skill-upload" disabled={mode !== 'custom'} onClick={() => fileRef.current?.click()}>
              ↑ upload .md file
            </button>
            <div className="skill-hint mono">hint: paste markdown or upload file</div>
            {error && <div className="skill-error mono">{error}</div>}
          </div>
        </div>

        <div className="skill-drawer-foot">
          <button className="btn btn-primary skill-apply" onClick={apply}>Apply Strategy</button>
          <div className="skill-foot-note">Changes apply on next AI Strategy generation</div>
        </div>
      </div>
    </>
  );
};

export default SkillDrawer;
