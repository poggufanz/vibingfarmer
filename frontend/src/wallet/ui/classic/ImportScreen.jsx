import { useState } from 'react'
import { classifyImport } from './importValidate.js'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function ImportScreen({ onImport, busy, error }) {
  const [input, setInput] = useState('')
  const [pw, setPw] = useState('')
  const [label, setLabel] = useState('Imported')
  const cls = input.trim() ? classifyImport(input) : { kind: 'invalid', error: '' }
  const ok = cls.kind !== 'invalid' && pw.length >= 12

  return (
    <div className="vf-screen vf-import">
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg, var(--bg-elev) 0%, var(--bg-card) 100%)',
          border: '1px solid var(--border-strong)', marginBottom: 4,
          boxShadow: '0 4px 16px rgba(0,0,0,.25)'
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="21 15 16 10 11 15"></polyline>
            <line x1="16" y1="10" x2="16" y2="22"></line>
            <path d="M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h4"></path>
          </svg>
        </div>
        <h2 style={{ margin: 0 }}>Import wallet</h2>
        <p className="vf-hint" style={{ textAlign: 'center', margin: 0 }}>
          Restore using a secret key or recovery phrase.
        </p>
      </div>

      <HonestyLabels scope="global" />

      <label>
        Secret key or recovery phrase
        <textarea
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder="Starts with S... or 12/24 words separated by spaces"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      {input.trim() && cls.kind === 'invalid' && <p className="vf-error">{cls.error}</p>}
      {cls.kind !== 'invalid' && (
        <p className="vf-hint" style={{ color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: '500' }}>
          ✓ Detected format: {cls.kind}
        </p>
      )}

      <label>
        Wallet Label
        <input placeholder="e.g. Imported" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>

      <label>
        Password
        <input
          type="password"
          autoComplete="new-password"
          placeholder="12+ characters to encrypt keys"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </label>

      {error && <p className="vf-error">{error}</p>}

      <button
        className="vf-btn primary"
        disabled={busy || !ok}
        onClick={() => onImport(cls.normalized, pw, label)}
        style={{ marginTop: 8 }}
      >
        {busy ? 'Importing…' : 'Import wallet'}
      </button>
    </div>
  )
}
