// frontend/src/wallet/ui/classic/CreateScreen.jsx
// VF Wallet Task 9. Recomposed onto the shared WalletShell/pc-* primitives -- dropped the
// gradient icon box and inline styles (checklist non-negotiable: no gradients; MyMoneyRoute.
// test.jsx's item 6 guard establishes the same "no inline style" discipline this file now
// follows). Key-generation wiring (createClassicWallet via controller.js's doCreate) is
// untouched -- only the markup changed.
import { useState } from 'react'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function CreateScreen({ onCreate, onGoImport, busy, error }) {
  const [label, setLabel] = useState('Main')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const weak = pw.length < 12
  const mismatch = pw !== pw2

  return (
    <div className="pc-standard-form" data-testid="standard-create">
      <h2>Set a password</h2>
      <p className="pc-route-intro">This password encrypts your keys on this device only.</p>
      <HonestyLabels scope="global" />
      <div className="pc-field">
        <label htmlFor="wallet-label">Label</label>
        <input
          id="wallet-label"
          className="pc-input"
          placeholder="Example: Main"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="pc-field">
        <label htmlFor="wallet-password">Password</label>
        <input
          id="wallet-password"
          className="pc-input"
          type="password"
          autoComplete="new-password"
          placeholder="12+ characters"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </div>
      <div className="pc-field">
        <label htmlFor="wallet-password-confirm">Confirm password</label>
        <input
          id="wallet-password-confirm"
          className="pc-input"
          type="password"
          autoComplete="new-password"
          placeholder="Re-enter password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
        />
      </div>
      {weak && pw.length > 0 && <p className="pc-field-help">Use 12+ characters.</p>}
      {mismatch && pw2 && <p className="pc-field-error">Passwords do not match.</p>}
      {error && <p className="pc-field-error">{error}</p>}
      <button
        type="button"
        className="pc-button pc-button--primary"
        disabled={busy || weak || mismatch}
        onClick={() => onCreate(label, pw)}
      >
        {busy ? 'Creating…' : 'Create wallet'}
      </button>
      <button type="button" className="pc-button pc-button--secondary" onClick={onGoImport}>
        Import an existing wallet
      </button>
    </div>
  )
}
