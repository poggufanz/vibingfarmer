// frontend/src/wallet/ui/classic/AddAssetScreen.jsx
// VF Wallet Task 11 -- recomposed onto the shared WalletShell/pc-* primitives (WalletShell.jsx
// owns the CSS), the same treatment Task 9 gave BackupScreen/ImportScreen: dropped the retired
// shell classes and every inline style, no behavior change. classifyTrustAsset/KNOWN_ASSETS wiring
// (trustline.js) is untouched. Reached from Home's "Add asset" action and wrapped by popup.jsx
// in the shared WalletShell. No address/hash is ever rendered as a static block here (the issuer
// is a live, scrollable <input>, not a text node), so the .pc-address-full overflow guard does not
// apply.
import { useState } from 'react'
import { KNOWN_ASSETS, classifyTrustAsset } from '../../trustline.js'

export default function AddAssetScreen({ onAddAsset, busy, error, success }) {
  const [code, setCode] = useState('')
  const [issuer, setIssuer] = useState('')
  const cls = code.trim() || issuer.trim() ? classifyTrustAsset(code, issuer) : { ok: false }
  // Scold only once both fields are filled — typing a code shouldn't flag the untouched issuer.
  const showInvalid = code.trim() && issuer.trim() && !cls.ok && cls.error
  const ok = cls.ok

  return (
    <div className="pc-standard-form" data-testid="add-asset-screen">
      <h2>Add asset</h2>
      <p className="pc-field-help">
        Add a trustline for any Stellar asset by code + issuer (testnet).
      </p>

      {KNOWN_ASSETS.length > 0 && (
        <div className="pc-asset-quick-actions">
          {KNOWN_ASSETS.map((a) => (
            <button
              key={`${a.code}:${a.issuer}`}
              type="button"
              className="pc-button pc-button--secondary"
              onClick={() => {
                setCode(a.code)
                setIssuer(a.issuer)
              }}
            >
              + {a.label}
            </button>
          ))}
        </div>
      )}

      <div className="pc-field">
        <label htmlFor="add-asset-code">Asset code</label>
        <input
          id="add-asset-code"
          className="pc-input"
          placeholder="USDC"
          spellCheck={false}
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>

      <div className="pc-field">
        <label htmlFor="add-asset-issuer">Issuer</label>
        <input
          id="add-asset-issuer"
          className="pc-input pc-technical"
          placeholder="G..."
          spellCheck={false}
          autoComplete="off"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
        />
      </div>

      {showInvalid && <p className="pc-field-error">{cls.error}</p>}
      <p className="pc-field-help">Adding an asset reserves 0.5 XLM in your account.</p>

      {error && <p className="pc-field-error">{error}</p>}
      {success && <p className="pc-field-success">{success}</p>}

      <button
        type="button"
        className="pc-button pc-button--primary"
        disabled={busy || !ok}
        onClick={() => onAddAsset?.(cls.code, cls.issuer)}
      >
        {busy ? 'Adding…' : 'Add asset'}
      </button>
    </div>
  )
}
