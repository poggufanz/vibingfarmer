import { useState } from 'react'
import { signIn, listKeys, createKey, revokeKey } from './portalClient.js'
import { connectWallet } from './walletSign.js'

// Scope contract — rendered as a read-only document pre-connect, and as the
// selectable picker post-connect (same rows, same truth).
const SCOPE_INFO = [
  { id: 'strategy', endpoints: 'POST /strategy', note: 'ai allocation · market context' },
  {
    id: 'market',
    endpoints: '/vault-facts · /prices · /eligibility',
    note: 'read-only market data',
  },
  { id: 'tx', endpoints: '/build-tx · /simulate', note: 'unsigned xdr only' },
  { id: 'submit', endpoints: 'POST /submit', note: 'fee-bump relay · deposit-only' },
  { id: 'scan', endpoints: 'POST /scan', note: 'risk verdict' },
]

const shortAddr = (g) => (g ? `${g.slice(0, 6)}…${g.slice(-4)}` : '')
const fmtDate = (sec) =>
  new Date(sec * 1000).toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })

const sectionTitle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '-0.01em',
  color: 'var(--text-muted)',
}

export default function DevelopersPage() {
  const [session, setSession] = useState(null) // { jwt, address }
  const [keys, setKeys] = useState([])
  const [freshKey, setFreshKey] = useState(null) // { key, hint } — show-once modal
  const [scopes, setScopes] = useState(['market', 'scan'])
  const [env, setEnv] = useState('test')
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [copied, setCopied] = useState(false)

  async function onConnect() {
    try {
      setError('')
      setConnecting(true)
      const { address, signChallenge } = await connectWallet()
      const jwt = await signIn({ account: address, signChallenge })
      setSession({ jwt, address })
      setKeys(await listKeys(jwt))
    } catch (e) {
      setError(e.message)
    } finally {
      setConnecting(false)
    }
  }

  async function onGenerate() {
    try {
      setError('')
      const out = await createKey(session.jwt, { scopes, env, rateLimit: 60 })
      setFreshKey(out)
      setCopied(false)
      setKeys(await listKeys(session.jwt))
    } catch (e) {
      setError(e.message)
    }
  }

  async function onRevoke(id) {
    try {
      await revokeKey(session.jwt, id)
      setKeys(await listKeys(session.jwt))
    } catch (e) {
      setError(e.message)
    }
  }

  function toggleScope(id) {
    setScopes((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  function onCopy() {
    navigator.clipboard?.writeText(freshKey.key).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="stage enter" style={{ maxWidth: 820, margin: '0 auto', padding: 28 }}>
      <div className="card">
        <div className="eyebrow">
          <span>developers</span>
          <span>·</span>
          <span>api access</span>
          <span className="rule"></span>
          <span>{session ? `sep-10 · ${shortAddr(session.address)}` : 'sep-10 wallet auth'}</span>
        </div>

        <h1 className="h-display">Satu key, semua service.</h1>
        <p className="lede">
          Sign-in pakai wallet Stellar, generate API key ber-scope, lalu panggil strategy, risk
          scan, sampai gasless deposit relay. Upstream secrets tetap di server VF — yang kamu pegang
          cuma satu key <span className="mono">vf_</span>.
        </p>

        {error && (
          <p
            role="alert"
            className="mono"
            style={{ marginTop: 18, fontSize: 12, color: 'var(--danger)' }}
          >
            {error}
          </p>
        )}

        {!session ? (
          <>
            <div style={{ marginTop: 32 }}>
              <span style={sectionTitle}>scope contract</span>
              <div className="perm-doc" style={{ marginTop: 12 }}>
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
            </div>
            <div className="action-row">
              <span className="foot-note">
                Key di-hash di server. <b>Plaintext muncul sekali</b> — pas issuance doang.
              </span>
              <button className="btn btn-primary btn-lg" onClick={onConnect} disabled={connecting}>
                {connecting ? 'Connecting…' : 'Connect wallet'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginTop: 32 }}>
              <span style={sectionTitle}>issue key · pilih scope</span>
              <div className="perm-doc" style={{ marginTop: 12 }}>
                {SCOPE_INFO.map((s, i) => {
                  const on = scopes.includes(s.id)
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleScope(s.id)}
                      className="perm-doc-row"
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        background: on ? 'var(--bg-elev-2)' : 'transparent',
                        border: 'none',
                        borderBottom:
                          i === SCOPE_INFO.length - 1 ? 'none' : '1px solid var(--border)',
                        cursor: 'pointer',
                        font: 'inherit',
                        color: 'inherit',
                        transition: 'background 0.12s ease',
                      }}
                    >
                      <span
                        className="perm-doc-k"
                        style={{ color: on ? 'var(--text)' : undefined }}
                      >
                        {on ? '✓ ' : ''}
                        {s.id}
                      </span>
                      <span
                        className="perm-doc-v"
                        style={{ color: on ? undefined : 'var(--text-faint)' }}
                      >
                        {s.endpoints}
                        <span className="annot">{s.note}</span>
                      </span>
                    </button>
                  )
                })}
              </div>

              <div
                role="radiogroup"
                aria-label="environment"
                className="risk-row"
                style={{ marginTop: 14, gridTemplateColumns: 'repeat(2, 1fr)' }}
              >
                {['test', 'live'].map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={env === e}
                    className={`risk-opt${env === e ? ' selected' : ''}`}
                    onClick={() => setEnv(e)}
                  >
                    <span className="risk-opt-label">{e === 'test' ? 'Test' : 'Live'}</span>
                    <span className="risk-opt-sub">
                      {e === 'test' ? 'vf_test_ · sandbox' : 'vf_live_ · production'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="action-row">
              <span className="foot-note">
                rate limit 60 req/min · <b>revocable</b> kapan aja
              </span>
              <button
                className="btn btn-primary"
                onClick={onGenerate}
                disabled={scopes.length === 0}
              >
                Generate key
              </button>
            </div>

            <div style={{ marginTop: 36 }}>
              <div className="flex items-baseline justify-between">
                <span style={sectionTitle}>your keys</span>
                <span className="mono faint" style={{ fontSize: 10.5 }}>
                  {keys.length} issued
                </span>
              </div>
              {keys.length === 0 ? (
                <p className="mono muted" style={{ marginTop: 14, fontSize: 12 }}>
                  Belum ada key — generate yang pertama di atas.
                </p>
              ) : (
                <div className="perm-doc" style={{ marginTop: 12 }}>
                  {keys.map((k) => (
                    <div
                      className="perm-doc-row"
                      key={k.id}
                      style={{ gridTemplateColumns: '1fr auto', alignItems: 'baseline' }}
                    >
                      <span className="perm-doc-v" style={{ opacity: k.enabled ? 1 : 0.6 }}>
                        <span className={k.enabled ? '' : 'struck'}>{k.key_hint}</span>
                        <span className="annot">{JSON.parse(k.scopes).join(' · ')}</span>
                        <span className="annot">{fmtDate(k.created_at)}</span>
                      </span>
                      <span className="flex items-baseline gap-3">
                        <span
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: k.enabled ? 'var(--text-muted)' : 'var(--text-faint)',
                          }}
                        >
                          {k.enabled ? 'active' : 'revoked'}
                        </span>
                        {k.enabled ? (
                          <button
                            className="btn btn-text"
                            style={{ color: 'var(--danger)', fontSize: 12, padding: '4px 8px' }}
                            onClick={() => onRevoke(k.id)}
                          >
                            Revoke
                          </button>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {freshKey && (
        <div className="modal-backdrop" onClick={() => setFreshKey(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="new api key"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-eyebrow">api key · shown once</div>
            <div className="modal-title">Simpan key ini sekarang</div>
            <div
              className="mono tnum"
              style={{
                background: 'var(--bg-elev)',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                padding: '14px 16px',
                fontSize: 13,
                wordBreak: 'break-all',
                userSelect: 'all',
              }}
            >
              {freshKey.key}
            </div>
            <p className="foot-note" style={{ marginTop: 14 }}>
              Server cuma nyimpen hash-nya — this key <b>will not be shown again</b>.
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={onCopy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="btn btn-ghost" onClick={() => setFreshKey(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
