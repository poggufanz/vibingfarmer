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
      <h2>Back up your recovery phrase</h2>
      <HonestyLabels scope="global" />
      <p className="vf-warn">
        These 24 words are the only way to recover this wallet. VF cannot restore them. Write them
        on paper — never photograph, cloud-sync, message, or store in a password manager.
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
          <button className="vf-btn" onClick={() => setRevealed(true)}>
            Reveal phrase
          </button>
        )}
      </div>
      {/* No Copy button by design (clipboard is malware-readable). */}

      {revealed && (
        <div className="vf-confirm">
          <p>Confirm you saved it — re-enter these words:</p>
          {indices.map((i) => (
            <label key={i}>
              Word #{i + 1}
              <input
                aria-label={`word #${i + 1}`}
                spellCheck={false}
                autoComplete="off"
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
              />
            </label>
          ))}
          {error && <p className="vf-error">{error}</p>}
          <button className="vf-btn primary" onClick={submit}>
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
