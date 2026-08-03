// frontend/src/wallet/ui/classic/BackupScreen.jsx
// VF Wallet Task 9. Recomposed onto the shared WalletShell/pc-* primitives -- dropped the
// gradient icon box, the entry-fade keyframe applied to every step, and the monospace styling on
// friendly copy ("Your recovery phrase is hidden", "I've saved my recovery phrase securely",
// "Confirm you saved it by entering these words:") that the old scoped style block carried. The
// step progress indicator (dots/labels + a transform-only fill bar, no keyframes) is KEPT --
// BackupScreen.test.jsx (pre-existing, unmodified) asserts its exact scaleX progression, and nothing
// about it was ever a flagged violation: it is a state-driven CSS transition, not an entry
// animation, matching the contract's own `.pc-agent-lane-progress > span` dynamic-value pattern.
// The 3-step Reveal -> Save -> Verify flow and its wiring (checkConfirm gates onConfirm; the
// mnemonic is only ever held in the caller's transient state, never here) are UNCHANGED --
// verification before completion still cannot be skipped. Mnemonic words themselves keep
// `.pc-technical` (monospace reserved for real secret/technical data, not prose).
//
// VF Wallet Task 11 (no functional change): re-checked this screen against the brief's "quiet
// destructive screen" contract (no decorative motion; show consequence, active account, network,
// Cancel, explicit completion). It already passes -- Task 9 already removed every animation;
// `.pc-backup-warning` states the consequence before any word is revealed; active account and
// "Stellar testnet" come for free from the WalletShell this screen is always rendered inside
// (never duplicated here); "Skip for now (risky)" is this flow's Cancel-equivalent once the
// phrase is on screen (deliberately not offered before Reveal, so a user cannot skip backup
// without having been shown the phrase at least once); and onConfirm/onSkip are the caller's
// explicit-completion signal. The one CSS finding motivated by this screen -- WalletShell.jsx's
// `.pc-backup-check input { font-family: ... }` rule guarding this file's checkbox -- was
// withdrawn by the reviewer as a false positive (a checkbox renders no glyphs, so the property
// is unobservable); see WalletShell.jsx's own comment at that rule for the resolution. Nothing in
// this file needed to change as a result.
import { useState, useCallback } from 'react'
import { checkConfirm } from './backupConfirm.js'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function BackupScreen({ mnemonic, indices, onConfirm, onSkip, error }) {
  const [step, setStep] = useState(1) // 1 = reveal, 2 = read/copy, 3 = confirm
  const [saved, setSaved] = useState(false)
  const [answers, setAnswers] = useState({})
  const [copied, setCopied] = useState(false)
  const words = mnemonic.trim().split(/\s+/)

  const copyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(mnemonic.trim())
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch {
      /* clipboard may fail in some contexts */
    }
  }, [mnemonic])

  function submit() {
    const list = indices.map((i) => ({ index: i, word: answers[i] ?? '' }))
    if (checkConfirm(mnemonic, list)) onConfirm(list)
  }

  return (
    <div className="pc-standard-form" data-testid="standard-backup">
      <div className="pc-backup-progress">
        <ol aria-label="Backup progress">
          {[1, 2, 3].map((s) => (
            <li key={s} aria-current={s === step ? 'step' : undefined}>
              {s === 1 ? 'Reveal' : s === 2 ? 'Save' : 'Verify'}
            </li>
          ))}
        </ol>
        <div className="bk-prog-track">
          <div className="bk-prog-fill" style={{ transform: `scaleX(${(step - 1) / 2})` }} />
        </div>
      </div>

      <HonestyLabels scope="global" />

      {step === 1 && (
        <div className="pc-backup-step">
          <p className="pc-backup-warning">
            Write these 24 words on paper in order. Keep them offline. If you lose them, your funds
            cannot be recovered.
          </p>
          <button type="button" className="pc-button pc-button--primary" onClick={() => setStep(2)}>
            Reveal recovery phrase
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="pc-backup-step">
          <ol className="pc-backup-phrase" aria-live="polite">
            {words.map((w, i) => (
              <li key={i} className="pc-technical">
                {w}
              </li>
            ))}
          </ol>

          <button type="button" className="pc-button pc-button--secondary" onClick={copyAll}>
            {copied ? 'Copied' : 'Copy all words'}
          </button>

          <label className="pc-backup-check">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I&rsquo;ve saved my recovery phrase securely
          </label>

          <button
            type="button"
            className="pc-button pc-button--primary"
            onClick={() => setStep(3)}
            disabled={!saved}
          >
            Continue to verification
          </button>

          <button type="button" className="pc-button pc-button--secondary" onClick={onSkip}>
            Skip for now (risky)
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="pc-backup-step">
          <p className="pc-field-help">Confirm you saved it by entering these words:</p>

          {indices.map((i) => (
            <div className="pc-field" key={i}>
              <label htmlFor={`backup-word-${i}`}>Word #{i + 1}</label>
              <input
                id={`backup-word-${i}`}
                className="pc-input pc-technical"
                spellCheck={false}
                autoComplete="off"
                placeholder={`Enter word #${i + 1}`}
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))}
              />
            </div>
          ))}

          {error && <p className="pc-field-error">{error}</p>}

          <button type="button" className="pc-button pc-button--primary" onClick={submit}>
            Confirm &amp; finish
          </button>

          <button
            type="button"
            className="pc-button pc-button--secondary"
            onClick={() => {
              setStep(2)
              setSaved(false)
            }}
          >
            View recovery phrase again
          </button>
        </div>
      )}
    </div>
  )
}
