import { useState } from 'react'
import { NavLink, Routes, Route, Navigate } from 'react-router-dom'
import { signIn } from './portalClient.js'
import { connectWallet } from './walletSign.js'
import { OverviewSection, KeysSection, UsageSection, DocsSection } from './sections.jsx'

const shortAddr = (g) => (g ? `${g.slice(0, 6)}…${g.slice(-4)}` : '')

// Scope contract — shown pre-auth on gated sections (moved from DevelopersPage).
export const SCOPE_INFO = [
  { id: 'strategy', endpoints: 'POST /strategy', note: 'ai allocation · market context' },
  { id: 'market', endpoints: '/vault-facts · /prices · /eligibility', note: 'read-only market data' },
  { id: 'tx', endpoints: '/build-tx · /simulate', note: 'unsigned xdr only' },
  { id: 'submit', endpoints: 'POST /submit', note: 'fee-bump relay · deposit-only' },
  { id: 'scan', endpoints: 'POST /scan', note: 'risk verdict' },
]

export function ConnectGate({ connecting, onConnect }) {
  return (
    <div className="card">
      <div className="eyebrow">
        <span>developers</span>
        <span>·</span>
        <span>sep-10 wallet auth</span>
      </div>
      <h1 className="h-display">Connect to continue</h1>
      <p className="lede">
        Authenticate with a Stellar wallet to manage keys and view usage. Keys are hashed at rest —{' '}
        <b>plaintext appears once</b>, at issuance only.
      </p>
      <div className="perm-doc" style={{ marginTop: 24 }}>
        {SCOPE_INFO.map((s) => (
          <div className="perm-doc-row" key={s.id}>
            <span className="perm-doc-k">{s.id}</span>
            <span className="perm-doc-v">
              {s.endpoints}
              <span className="annot">{s.note}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="action-row">
        <span className="foot-note">Session lasts 1 hour · nothing leaves your wallet but a signature.</span>
        <button className="btn btn-primary btn-lg" type="button" onClick={onConnect} disabled={connecting}>
          {connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
      </div>
    </div>
  )
}

const NAV = [
  { to: '', end: true, label: 'Overview' },
  { to: 'keys', label: 'API keys' },
  { to: 'usage', label: 'Usage' },
  { to: 'docs', label: 'Docs' },
]

export default function DevelopersLayout() {
  const [session, setSession] = useState(null) // { jwt, address }
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  async function onConnect() {
    try {
      setError('')
      setConnecting(true)
      const { address, signChallenge } = await connectWallet()
      const jwt = await signIn({ account: address, signChallenge })
      setSession({ jwt, address })
    } catch (e) {
      setError(e.message)
    } finally {
      setConnecting(false)
    }
  }

  const gate = (el) => (session ? el : <ConnectGate connecting={connecting} onConnect={onConnect} />)

  return (
    <div className="portal stage enter">
      <nav className="portal-nav" aria-label="Developer portal">
        {NAV.map((n) => (
          <NavLink key={n.label} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {n.label}
          </NavLink>
        ))}
        <div className="portal-nav-foot mono faint">
          {session ? `sep-10 · ${shortAddr(session.address)}` : 'not connected'}
        </div>
      </nav>
      <div className="portal-main">
        {error && (
          <p role="alert" className="mono" style={{ marginBottom: 14, fontSize: 12, color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <Routes>
          <Route index element={<OverviewSection session={session} />} />
          <Route path="keys" element={gate(<KeysSection session={session} />)} />
          <Route path="usage" element={gate(<UsageSection session={session} />)} />
          <Route path="docs" element={<DocsSection />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </div>
    </div>
  )
}
