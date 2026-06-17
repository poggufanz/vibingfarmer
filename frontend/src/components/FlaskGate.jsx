// FlaskGate.jsx
// Friendly guide shown when MetaMask Flask (ERC-7715) is not detected.
// NOT an error screen — a calm, numbered setup walkthrough.
import React from 'react'
import { Icon } from '../components.jsx'

const FLASK_URL = 'https://metamask.io/flask/'

const STEPS = [
  { n: '①', title: 'Download MetaMask Flask', body: <a href={FLASK_URL} target="_blank" rel="noopener noreferrer" className="accent" style={{ textDecoration: 'none' }}>→ metamask.io/flask</a> },
  { n: '②', title: 'Open in a separate browser profile', body: 'Flask and regular MetaMask conflict if used in the same profile.' },
  { n: '③', title: 'Create or import your wallet in Flask', body: null },
  { n: '④', title: 'Come back here and connect', body: null },
]

export default function FlaskGate({ detectedType, onRetry }) {
  return (
    <section className="card enter" style={{ maxWidth: 620, margin: '0 auto', textAlign: 'center' }}>
      <div className="eyebrow" style={{ justifyContent: 'center' }}>
        <span>MetaMask Flask required</span>
      </div>

      <h1 className="h-display" style={{ marginTop: 8 }}>Set up Flask to grant advanced permissions.</h1>
      <p className="lede" style={{ margin: '12px auto 0', maxWidth: 460 }}>
        Vibing Farmer uses <span className="mono">ERC-7715</span> Advanced Permissions, which require
        MetaMask Flask · the developer build of MetaMask.
        {detectedType === 'stable' && ' We detected regular MetaMask in this profile.'}
        {detectedType === 'none' && ' We did not detect any wallet in this browser.'}
      </p>

      <div style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', margin: '24px 0', padding: '20px 0', textAlign: 'left' }}>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 14, textAlign: 'center' }}>Setup takes 2 minutes</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 420, margin: '0 auto' }}>
          {STEPS.map((s) => (
            <div key={s.n} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span className="mono accent" style={{ fontSize: 15, lineHeight: '20px', flex: 'none' }}>{s.n}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{s.title}</div>
                {s.body && <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>{s.body}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="action-row" style={{ justifyContent: 'center', gap: 10 }}>
        <a className="btn btn-primary btn-lg" href={FLASK_URL} target="_blank" rel="noopener noreferrer">
          Download MetaMask Flask <Icon name="external" size={14} />
        </a>
      </div>

      <div className="foot-note" style={{ marginTop: 16 }}>
        Already using Flask? Make sure you're in the correct browser profile.
        <button className="btn btn-ghost" style={{ marginLeft: 10 }} onClick={onRetry}>Try connecting again</button>
      </div>
    </section>
  )
}
