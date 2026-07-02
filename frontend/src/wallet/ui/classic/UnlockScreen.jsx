import { useState } from 'react'

export default function UnlockScreen({ publicKey, onUnlock, error, busy }) {
  const [pw, setPw] = useState('')
  return (
    <div className="vf-screen vf-unlock">
      <h2>Unlock wallet</h2>
      <p className="vf-muted">
        {publicKey?.slice(0, 6)}…{publicKey?.slice(-6)}
      </p>
      <input
        type="password"
        autoComplete="current-password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onUnlock(pw)}
      />
      <p className="vf-hint">
        This password unlocks the local vault in this browser. It is not a recovery method — your 24
        words are.
      </p>
      {error && <p className="vf-error">{error}</p>}
      <button className="vf-btn primary" disabled={busy || !pw} onClick={() => onUnlock(pw)}>
        Unlock
      </button>
    </div>
  )
}
