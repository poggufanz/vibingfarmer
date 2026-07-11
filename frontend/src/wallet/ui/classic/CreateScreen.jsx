import { useState } from 'react'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function CreateScreen({ onCreate, onGoImport, busy, error }) {
  const [label, setLabel] = useState('Main')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const weak = pw.length < 12
  const mismatch = pw !== pw2

  return (
    <div className="vf-screen vf-create">
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg, var(--bg-elev) 0%, var(--bg-card) 100%)',
          border: '1px solid var(--border-strong)', marginBottom: 4,
          boxShadow: '0 4px 16px rgba(0,0,0,.25)'
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
        </div>
        <h2 style={{ margin: 0 }}>Create wallet</h2>
        <p className="vf-hint" style={{ textAlign: 'center', margin: 0 }}>
          Set a password to encrypt your keys locally.
        </p>
      </div>
      <HonestyLabels scope="global" />
      <label>
        Label
        <input placeholder="e.g. Main" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="new-password"
          placeholder="12+ characters"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </label>
      <label>
        Confirm password
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Re-enter password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
      </label>
      {weak && pw.length > 0 && <p className="vf-hint">Use 12+ characters.</p>}
      {mismatch && pw2 && <p className="vf-error">Passwords do not match.</p>}
      {error && <p className="vf-error">{error}</p>}
      <button
        className="vf-btn primary"
        disabled={busy || weak || mismatch}
        onClick={() => onCreate(label, pw)}
      >
        {busy ? 'Creating…' : 'Create wallet'}
      </button>
      <button className="vf-btn ghost" onClick={onGoImport}>
        I already have a wallet — import
      </button>
    </div>
  )
}
