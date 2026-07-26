// frontend/src/wallet/ui/classic/ImportScreen.jsx
// VF Wallet Task 9. Recomposed onto the shared WalletShell/pc-* primitives -- dropped the
// gradient icon box and inline styles. The secret/mnemonic textarea keeps `.pc-technical`
// (monospace): that field holds real secret/technical data, which the contract's own base rule
// (`code, pre, .pc-technical`) reserves monospace for -- unlike the surrounding prose, which uses
// the body font throughout (checklist item 5: no friendly copy in monospace). Import wiring
// (classifyImport / importFromSecret / importFromMnemonic via controller.js's doImport) is
// untouched -- only the markup changed.
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
    <div className="pc-standard-form" data-testid="standard-import">
      <h2>Restore from a secret key or recovery phrase</h2>
      <HonestyLabels scope="global" />
      <div className="pc-field">
        <label htmlFor="wallet-import-secret">Secret key or recovery phrase</label>
        <textarea
          id="wallet-import-secret"
          className="pc-input pc-technical"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder="Starts with S... or 12/24 words separated by spaces"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      {input.trim() && cls.kind === 'invalid' && <p className="pc-field-error">{cls.error}</p>}
      {cls.kind !== 'invalid' && <p className="pc-field-help">Detected format: {cls.kind}</p>}

      <div className="pc-field">
        <label htmlFor="wallet-import-label">Wallet label</label>
        <input
          id="wallet-import-label"
          className="pc-input"
          placeholder="Example: Imported"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <div className="pc-field">
        <label htmlFor="wallet-import-password">Password</label>
        <input
          id="wallet-import-password"
          className="pc-input"
          type="password"
          autoComplete="new-password"
          placeholder="12+ characters to encrypt keys"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </div>

      {error && <p className="pc-field-error">{error}</p>}

      <button
        type="button"
        className="pc-button pc-button--primary"
        disabled={busy || !ok}
        onClick={() => onImport(cls.normalized, pw, label)}
      >
        {busy ? 'Importing…' : 'Import wallet'}
      </button>
    </div>
  )
}
