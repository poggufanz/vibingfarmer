import { useState, useCallback } from 'react'
import { checkConfirm } from './backupConfirm.js'
import { HonestyLabels } from '../HonestyLabels.jsx'

/* ── 3-step wizard: Reveal → Read/Copy → Confirm ── */

export default function BackupScreen({ mnemonic, indices, onConfirm, onSkip, error }) {
  const [step, setStep] = useState(1)       // 1 = reveal, 2 = read/copy, 3 = confirm
  const [saved, setSaved] = useState(false)  // checkbox gate on step 2
  const [answers, setAnswers] = useState({})
  const [copied, setCopied] = useState(false)
  const words = mnemonic.trim().split(/\s+/)

  const copyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(mnemonic.trim())
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch { /* clipboard may fail in some contexts */ }
  }, [mnemonic])

  function submit() {
    const list = indices.map((i) => ({ index: i, word: answers[i] ?? '' }))
    if (checkConfirm(mnemonic, list)) onConfirm(list)
  }

  return (
    <div className="vf-screen vf-backup">
      <BackupStyle />

      {/* ── header icon + title ── */}
      <div className="bk-header">
        <div className="bk-icon-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </div>
        <h2 style={{ margin: 0 }}>Recovery Phrase</h2>
        <p className="vf-hint" style={{ textAlign: 'center', margin: 0 }}>
          Your secret phrase is the only way to recover assets.
        </p>
      </div>

      {/* ── progress bar ── */}
      <div className="bk-progress">
        {[1, 2, 3].map((s) => (
          <div key={s} className={'bk-prog-step' + (s <= step ? ' active' : '') + (s === step ? ' current' : '')}>
            <span className="bk-prog-num">{s}</span>
            <span className="bk-prog-label">
              {s === 1 ? 'Reveal' : s === 2 ? 'Save' : 'Verify'}
            </span>
          </div>
        ))}
        <div className="bk-prog-track">
          <div
            className="bk-prog-fill"
            style={{ transform: `scaleX(${(step - 1) / 2})` }}
          />
        </div>
      </div>

      <HonestyLabels scope="global" />

      {/* ═══════════ Step 1: Reveal ═══════════ */}
      {step === 1 && (
        <div className="bk-step" key="s1">
          <p className="vf-warn">
            Write these 24 words on paper in order. Keep them offline. If you lose them, your funds cannot be recovered.
          </p>
          <div className="bk-reveal-zone">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <p className="bk-reveal-hint">Your recovery phrase is hidden</p>
            <button className="vf-btn primary" onClick={() => setStep(2)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 6 }}>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              Reveal recovery phrase
            </button>
          </div>
        </div>
      )}

      {/* ═══════════ Step 2: Read & Copy ═══════════ */}
      {step === 2 && (
        <div className="bk-step" key="s2">
          <div className="vf-phrase revealed" aria-live="polite">
            {words.map((w, i) => (
              <span key={i} className="vf-word" spellCheck={false}>
                <span className="vf-word-idx">{i + 1}.</span>{' '}
                <span className="vf-word-text">{w}</span>
              </span>
            ))}
          </div>

          {/* Copy all */}
          <button className={'bk-copy-btn' + (copied ? ' copied' : '')} onClick={copyAll}>
            {copied ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy all words
              </>
            )}
          </button>

          {/* Saved checkbox */}
          <label className="bk-saved-check">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            <span className="bk-check-box">
              {saved && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              )}
            </span>
            <span className="bk-check-text">I've saved my recovery phrase securely</span>
          </label>

          <button
            className="vf-btn primary"
            onClick={() => setStep(3)}
            disabled={!saved}
          >
            Continue to verification
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 6 }}>
              <path d="M5 12h14M12 5l7 7-7 7"></path>
            </svg>
          </button>

          <button className="vf-btn ghost" onClick={onSkip}>
            Skip for now (risky)
          </button>
        </div>
      )}

      {/* ═══════════ Step 3: Confirm ═══════════ */}
      {step === 3 && (
        <div className="bk-step" key="s3">
          <div className="bk-confirm-info">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span>Confirm you saved it by entering these words:</span>
          </div>

          <div className="bk-confirm-inputs">
            {indices.map((i) => (
              <label key={i} className="bk-input-group">
                <span className="bk-input-label">Word #{i + 1}</span>
                <input
                  aria-label={`word #${i + 1}`}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={`Enter word #${i + 1}`}
                  value={answers[i] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
                  className="bk-word-input"
                />
              </label>
            ))}
          </div>

          {error && <p className="vf-error">{error}</p>}

          <button className="vf-btn primary" onClick={submit}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            Confirm &amp; finish
          </button>

          <button className="vf-btn ghost" onClick={() => { setStep(2); setSaved(false) }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 4 }}>
              <path d="M19 12H5M12 19l-7-7 7-7"></path>
            </svg>
            Back — view phrase again
          </button>
        </div>
      )}
    </div>
  )
}


/* ─────────── scoped styles ─────────── */
function BackupStyle() {
  return (
    <style>{`
.bk-header {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.bk-icon-wrap {
  width: 48px; height: 48px; border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--bg-elev) 0%, var(--bg-card) 100%);
  border: 1px solid var(--border-strong); margin-bottom: 4px;
  box-shadow: 0 4px 16px rgba(0,0,0,.25);
}

/* ── progress bar ── */
.bk-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0;
  padding: 0 4px;
  margin: 8px 0 4px;
  position: relative;
}
.bk-prog-track {
  position: absolute;
  left: 16.67%; right: 16.67%;
  top: 12px;
  height: 2px;
  background: var(--border);
  border-radius: 2px;
  z-index: 0;
}
.bk-prog-fill {
  width: 100%;
  height: 100%;
  background: var(--accent, #cfff3d);
  border-radius: 2px;
  transform-origin: left;
  transition: transform 220ms cubic-bezier(.23,1,.32,1);
}
.bk-prog-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  z-index: 1;
  flex: 1;
}
.bk-prog-num {
  position: relative;
  z-index: 2;
  width: 24px; height: 24px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--mono);
  font-size: 11px; font-weight: 700;
  background: var(--bg-canvas, #0e100c);
  border: 1.5px solid var(--border);
  color: var(--text-faint);
  transition: border-color 220ms cubic-bezier(.23,1,.32,1), color 160ms ease, background-color 220ms cubic-bezier(.23,1,.32,1), box-shadow 220ms cubic-bezier(.23,1,.32,1);
}
.bk-prog-step.active .bk-prog-num {
  border-color: var(--accent, #cfff3d);
  color: var(--accent, #cfff3d);
  background: #11140c;
}
.bk-prog-step.current .bk-prog-num {
  box-shadow: 0 0 12px rgba(207,255,61,.3);
}
.bk-prog-label {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--text-faint);
  transition: color 160ms ease;
}
.bk-prog-step.active .bk-prog-label { color: var(--text-muted); }
.bk-prog-step.current .bk-prog-label { color: var(--text); }

/* ── step animation ── */
.bk-step {
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: bk-fade-in 220ms cubic-bezier(.23,1,.32,1) both;
}
@keyframes bk-fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── step 1: reveal zone ── */
.bk-reveal-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 28px 16px;
  background: var(--bg-card);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-lg, 14px);
}
.bk-reveal-hint {
  margin: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-faint);
}

/* ── step 2: copy button ── */
.bk-copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 9px 12px;
  font-family: var(--mono);
  font-size: 12px; font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md, 8px);
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, transform 160ms cubic-bezier(.23,1,.32,1);
}
.bk-copy-btn:hover {
  background: var(--bg-elev);
  border-color: var(--accent, #cfff3d);
  color: var(--text);
}
.bk-copy-btn.copied {
  border-color: var(--accent, #cfff3d);
  color: var(--accent, #cfff3d);
  background: rgba(207,255,61,.06);
}
.bk-copy-btn:active { transform: scale(.97); }

/* ── checkbox ── */
.bk-saved-check {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(207,255,61,.04);
  border: 1px solid rgba(207,255,61,.12);
  border-radius: var(--r-md, 8px);
  cursor: pointer;
  transition: border-color 160ms ease;
}
.bk-saved-check:hover { border-color: rgba(207,255,61,.3); }
.bk-saved-check input { display: none; }
.bk-check-box {
  width: 18px; height: 18px;
  border-radius: 4px;
  border: 1.5px solid var(--border-strong);
  background: var(--bg-card);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  transition: border-color 160ms ease, background-color 160ms ease;
}
.bk-saved-check input:checked + .bk-check-box {
  border-color: var(--accent, #cfff3d);
  background: rgba(207,255,61,.1);
}
.bk-check-text {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-muted);
  user-select: none;
}

/* ── step 3: confirm ── */
.bk-confirm-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-muted);
}
.bk-confirm-inputs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bk-input-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bk-input-label {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  letter-spacing: .03em;
}
.bk-word-input {
  font-family: var(--mono);
  font-size: 13px;
  padding: 9px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md, 8px);
  color: var(--text);
  outline: none;
  transition: border-color 200ms ease, box-shadow 200ms ease;
}
.bk-word-input:focus {
  border-color: var(--accent, #cfff3d);
  box-shadow: 0 0 0 2px rgba(207,255,61,.12);
}
.bk-word-input::placeholder { color: var(--text-faint); opacity: .6; }

@media (prefers-reduced-motion: reduce) {
  .bk-step { animation: none; }
  .bk-prog-fill,
  .bk-prog-num,
  .bk-copy-btn,
  .bk-check-box { transition: none; }
}
`}</style>
  )
}
