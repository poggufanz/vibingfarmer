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
      <h2>Import a wallet</h2>
      <HonestyLabels scope="global" />
      <label>
        Secret key (S…) or 12/24-word recovery phrase
        <textarea
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      {input.trim() && cls.kind === 'invalid' && <p className="vf-error">{cls.error}</p>}
      {cls.kind !== 'invalid' && <p className="vf-hint">Detected: {cls.kind}</p>}
      <label>
        Label
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </label>
      {error && <p className="vf-error">{error}</p>}
      <button
        className="vf-btn primary"
        disabled={busy || !ok}
        onClick={() => onImport(cls.normalized, pw, label)}
      >
        {busy ? 'Importing…' : 'Import'}
      </button>
    </div>
  )
}
