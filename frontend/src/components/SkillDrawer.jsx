import { useState, useEffect, useRef } from 'react'
import { Icon } from '../components.jsx'
import { loadVaultSkill, saveUserSkill, clearUserSkill } from '../skillLoader.js'
import { Dialog, StatusNotice } from './pocket/Primitives.jsx'
import './SecondaryDialogs.css'

const SkillDrawer = ({ open, onClose, skillSource, onSkillChange }) => {
  const isCustomSource = skillSource === 'user-local' || skillSource === 'user-file'
  const [mode, setMode] = useState(isCustomSource ? 'custom' : 'default')
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const taRef = useRef(null)
  const fileRef = useRef(null)
  const closeRef = useRef(null)

  // On open: sync mode to current source and prefill custom content
  useEffect(() => {
    if (!open) return
    setError(null)
    setMode(isCustomSource ? 'custom' : 'default')
    if (isCustomSource) {
      loadVaultSkill().then(({ content, source }) => {
        if (source === 'user-local' || source === 'user-file') setText(content)
      })
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectCustom = () => {
    setMode('custom')
    setError(null)
    setTimeout(() => taRef.current?.focus(), 0)
  }
  const selectDefault = () => {
    setMode('default')
    setError(null)
  }

  const onUpload = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      setText(String(reader.result || ''))
      setMode('custom')
    }
    reader.readAsText(f)
  }

  const apply = () => {
    if (mode === 'default') {
      clearUserSkill()
      onSkillChange('default')
      onClose()
      return
    }
    if (!text.trim()) {
      setError('strategy cannot be empty')
      return
    }
    saveUserSkill(text)
    onSkillChange('user-local')
    onClose()
  }

  return (
    <Dialog
      open={open}
      title="Vault Advisor Skill"
      description="Choose how Venice AI selects vaults. Changes apply to the next strategy generation."
      onClose={onClose}
      mode="sheet"
      initialFocusRef={closeRef}
      className="secondary-dialog secondary-dialog--drawer"
      actions={
        <>
          <button className="btn btn-primary" onClick={apply}>
            Apply strategy
          </button>
          <span className="secondary-dialog-drawer-hint">
            Changes apply to the next strategy generation
          </span>
        </>
      }
    >
      <div className="secondary-dialog-eyebrow">
        <span>Strategy source</span>
        <button
          ref={closeRef}
          className="secondary-dialog-close icon-btn"
          aria-label="Close"
          type="button"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="secondary-dialog-drawer-body">
        <button
          type="button"
          className={`secondary-dialog-drawer-option${mode === 'default' ? ' is-selected' : ''}`}
          onClick={selectDefault}
        >
          <span className="secondary-dialog-drawer-radio" aria-hidden="true" />
          <span className="secondary-dialog-drawer-option-main">
            <span className="secondary-dialog-drawer-option-title">
              Default Strategy by Vibing Farmer
            </span>
            <span className="secondary-dialog-drawer-option-description">
              Built-in rules for vault eligibility, allocation, and risk.
            </span>
            <span className="secondary-dialog-drawer-option-meta">
              Uses the current eligible vault set
            </span>
          </span>
        </button>

        <button
          type="button"
          className={`secondary-dialog-drawer-option${mode === 'custom' ? ' is-selected' : ''}`}
          onClick={selectCustom}
        >
          <span className="secondary-dialog-drawer-radio" aria-hidden="true" />
          <span className="secondary-dialog-drawer-option-main">
            <span className="secondary-dialog-drawer-option-title">Custom Strategy</span>
          </span>
        </button>

        <div className="secondary-dialog-drawer-custom">
          <textarea
            ref={taRef}
            className="secondary-dialog-drawer-textarea mono"
            placeholder={'# My Vault Strategy\nYou are a DeFi advisor...'}
            value={text}
            disabled={mode !== 'custom'}
            onChange={(e) => {
              setText(e.target.value)
              if (error) setError(null)
            }}
          />
          <input ref={fileRef} type="file" accept=".md,.txt" hidden onChange={onUpload} />
          <button
            type="button"
            className="btn btn-ghost"
            disabled={mode !== 'custom'}
            onClick={() => fileRef.current?.click()}
          >
            Upload .md file
          </button>
          <div className="secondary-dialog-drawer-hint">Hint: paste Markdown or upload a file</div>
          {error && (
            <div className="secondary-dialog-error" aria-live="assertive">
              <StatusNotice state="danger" title="Strategy unavailable">
                {error}
              </StatusNotice>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

export default SkillDrawer
