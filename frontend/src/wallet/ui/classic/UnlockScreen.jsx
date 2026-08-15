// frontend/src/wallet/ui/classic/UnlockScreen.jsx
// VF Wallet Task 9. Recomposed onto the shared WalletShell/pc-* primitives -- dropped the
// gradient icon box and inline styles. WalletShell's own h1 already carries the "Unlock your
// wallet" heading, so this screen renders no second, duplicate heading. Unlock wiring
// (unlockWallet via controller.js's doUnlock) is untouched -- only the markup changed.
import { useState } from 'react'
import { HonestyLabels } from '../HonestyLabels.jsx'

export default function UnlockScreen({ publicKey, onUnlock, error, busy }) {
  const [pw, setPw] = useState('')
  return (
    <div className="pc-standard-form" data-testid="standard-unlock">
      {publicKey && (
        <p className="pc-field-help pc-technical">
          {publicKey.slice(0, 6)}…{publicKey.slice(-6)}
        </p>
      )}
      <div className="pc-field">
        <label htmlFor="wallet-unlock-password">Password</label>
        <input
          id="wallet-unlock-password"
          className="pc-input"
          type="password"
          autoComplete="current-password"
          placeholder="Enter password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onUnlock(pw)}
        />
      </div>
      <p className="pc-route-intro">This password unlocks the local vault in this browser.</p>
      <HonestyLabels scope="session-key" />
      {error && <p className="pc-field-error">{error}</p>}
      <button
        type="button"
        className="pc-button pc-button--primary"
        disabled={busy || !pw}
        onClick={() => onUnlock(pw)}
      >
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </div>
  )
}
