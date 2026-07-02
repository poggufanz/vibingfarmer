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
      <h2>Create a classic wallet</h2>
      <HonestyLabels scope="global" />
      <label>
        Label
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Password (unlocks this wallet on this browser — not a recovery method)
        <input
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </label>
      <label>
        Confirm password
        <input
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
      </label>
      {weak && <p className="vf-hint">Use 12+ characters.</p>}
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
