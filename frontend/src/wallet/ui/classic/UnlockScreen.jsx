import { useState } from 'react'

export default function UnlockScreen({ publicKey, onUnlock, error, busy }) {
  const [pw, setPw] = useState('')
  return (
    <div className="vf-screen vf-unlock" style={{ justifyContent: 'center', minHeight: '320px' }}>
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg, var(--bg-elev) 0%, var(--bg-card) 100%)',
          border: '1px solid var(--border-strong)', marginBottom: 4,
          boxShadow: '0 4px 16px rgba(0,0,0,.25)'
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        </div>
        <h2 style={{ margin: 0 }}>Unlock wallet</h2>
        <p className="vf-muted" style={{ margin: 0 }}>
          {publicKey?.slice(0, 6)}…{publicKey?.slice(-6)}
        </p>
      </div>
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Enter password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onUnlock(pw)}
      />
      <p className="vf-hint" style={{ textAlign: 'center' }}>
        This password unlocks the local vault in this browser.
      </p>
      {error && <p className="vf-error">{error}</p>}
      <button className="vf-btn primary" disabled={busy || !pw} onClick={() => onUnlock(pw)}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </div>
  )
}
