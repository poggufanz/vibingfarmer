import { useState } from 'react'
import { KNOWN_ASSETS, classifyTrustAsset } from '../../trustline.js'

export default function AddAssetScreen({ onAddAsset, busy, error }) {
  const [code, setCode] = useState('')
  const [issuer, setIssuer] = useState('')
  const cls = code.trim() || issuer.trim() ? classifyTrustAsset(code, issuer) : { ok: false }
  // Scold only once both fields are filled — typing a code shouldn't flag the untouched issuer.
  const showInvalid = code.trim() && issuer.trim() && !cls.ok && cls.error
  const ok = cls.ok

  return (
    <div className="vf-screen vf-add-asset">
      <h2>Add asset</h2>
      <p className="vf-hint">Add a trustline for any Stellar asset by code + issuer (testnet).</p>

      {KNOWN_ASSETS.length > 0 && (
        <div className="vf-actions" style={{ flexWrap: 'wrap' }}>
          {KNOWN_ASSETS.map((a) => (
            <button
              key={`${a.code}:${a.issuer}`}
              type="button"
              className="vf-btn ghost"
              style={{ flex: 'none', padding: '6px 12px' }}
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

      <label>
        Asset code
        <input
          aria-label="Asset code"
          placeholder="USDC"
          spellCheck={false}
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <label>
        Issuer
        <input
          aria-label="Issuer"
          placeholder="G..."
          spellCheck={false}
          autoComplete="off"
          className="tnum"
          style={{ fontFamily: 'var(--mono)' }}
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
        />
      </label>

      {showInvalid && <p className="vf-error">{cls.error}</p>}
      <p className="vf-hint">Adding an asset reserves 0.5 XLM in your account.</p>

      {error && <p className="vf-error">{error}</p>}

      <button
        className="vf-btn primary"
        disabled={busy || !ok}
        onClick={() => onAddAsset(cls.code, cls.issuer)}
        style={{ marginTop: 8 }}
      >
        {busy ? 'Adding…' : 'Add asset'}
      </button>
    </div>
  )
}
