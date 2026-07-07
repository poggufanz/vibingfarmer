import { useState } from 'react'
import { checkConfirm } from './backupConfirm.js'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function BackupScreen({ mnemonic, indices, onConfirm, onSkip, error }) {
  const [revealed, setRevealed] = useState(false)
  const [answers, setAnswers] = useState({})
  const words = mnemonic.trim().split(/\s+/)

  function submit() {
    const list = indices.map((i) => ({ index: i, word: answers[i] ?? '' }))
    if (checkConfirm(mnemonic, list)) onConfirm(list)
  }

  return (
    <div className="vf-screen vf-backup">
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg, var(--bg-elev) 0%, var(--bg-card) 100%)',
          border: '1px solid var(--border-strong)', marginBottom: 4,
          boxShadow: '0 4px 16px rgba(0,0,0,.25)'
        }}>
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

      <HonestyLabels scope="global" />

      <p className="vf-warn">
        Write these 24 words on paper in order. Keep them offline. If you lose them, your funds cannot be recovered.
      </p>

      <div className={'vf-phrase' + (revealed ? ' revealed' : ' blurred')} aria-live="polite">
        {revealed ? (
          words.map((w, i) => (
            <span key={i} className="vf-word" spellCheck={false}>
              <span className="vf-word-idx">{i + 1}.</span>{' '}
              <span className="vf-word-text">{w}</span>
            </span>
          ))
        ) : (
          <button className="vf-btn primary" onClick={() => setRevealed(true)} style={{ padding: '10px 20px' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 6 }}>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            Reveal recovery phrase
          </button>
        )}
      </div>

      {revealed && (
        <div className="vf-confirm" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <p style={{ margin: '8px 0', fontSize: '12px', color: 'var(--text-muted)' }}>Confirm you saved it by entering these words:</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {indices.map((i) => (
              <label key={i} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                Word #{i + 1}
                <input
                  aria-label={`word #${i + 1}`}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={`Enter word #${i + 1}`}
                  value={answers[i] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          {error && <p className="vf-error">{error}</p>}
          <button className="vf-btn primary" onClick={submit} style={{ marginTop: 6 }}>
            Confirm &amp; finish
          </button>
          <button className="vf-btn ghost" onClick={onSkip}>
            Skip for now (risky)
          </button>
        </div>
      )}
    </div>
  )
}
