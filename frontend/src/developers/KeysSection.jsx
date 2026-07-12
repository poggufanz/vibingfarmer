import { useEffect, useMemo, useState } from 'react'
import { listKeys, createKey, revokeKey } from './portalClient.js'
import CodeBlock from './CodeBlock.jsx'

// Scope contract — same rows for docs (pre-auth) and permission picker (create form).
const SCOPE_INFO = [
  { id: 'strategy', endpoints: 'POST /strategy', note: 'AI allocation · market context' },
  {
    id: 'market',
    endpoints: '/vault-facts · /prices · /eligibility',
    note: 'Read-only market data',
  },
  { id: 'tx', endpoints: '/build-tx · /simulate', note: 'Unsigned XDR only' },
  { id: 'submit', endpoints: 'POST /submit', note: 'Fee-bump relay · deposit-only' },
  { id: 'scan', endpoints: 'POST /scan', note: 'Risk verdict' },
]

const EXPIRY_OPTIONS = [
  { id: 'never', label: 'Never', seconds: null },
  { id: '30d', label: '30 days', seconds: 30 * 24 * 3600 },
  { id: '90d', label: '90 days', seconds: 90 * 24 * 3600 },
  { id: '365d', label: '1 year', seconds: 365 * 24 * 3600 },
]

const shortAddr = (g) => (g ? `${g.slice(0, 6)}…${g.slice(-4)}` : '')

const fmtDate = (sec) => {
  if (!sec) return '—'
  return new Date(sec * 1000).toLocaleDateString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

const parseScopes = (raw) => {
  if (Array.isArray(raw)) return raw
  try {
    return JSON.parse(raw || '[]')
  } catch {
    return []
  }
}

const envFromHint = (hint = '') => (hint.includes('_live_') ? 'live' : 'test')

const sectionTitle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '-0.01em',
  color: 'var(--text-muted)',
}

function curlSnippet(key) {
  return `curl -s https://api.vibing.farmer/api/vf/prices \\
  -H "Authorization: Bearer ${key || 'vf_test_…'}"`
}

export default function KeysSection({ session }) {
  const [keys, setKeys] = useState([])
  const [listFilter, setListFilter] = useState('all') // all | test | live

  // Create form (Stripe-style: create → reveal once)
  const [showCreate, setShowCreate] = useState(false)
  const [scopes, setScopes] = useState(['market', 'scan'])
  const [env, setEnv] = useState('test')
  const [expiry, setExpiry] = useState('never')
  const [creating, setCreating] = useState(false)

  // Reveal-once secret (industry standard: never recoverable)
  const [freshKey, setFreshKey] = useState(null) // { id, key, hint }
  const [copied, setCopied] = useState(false)
  const [savedAck, setSavedAck] = useState(false)
  const [snippetCopied, setSnippetCopied] = useState(false)

  // Revoke confirmation
  const [revokeTarget, setRevokeTarget] = useState(null) // key row
  const [revoking, setRevoking] = useState(false)

  const [error, setError] = useState('')

  useEffect(() => {
    let on = true
    listKeys(session.jwt)
      .then((k) => on && setKeys(k))
      .catch((e) => on && setError(e.message))
    return () => {
      on = false
    }
  }, [session.jwt])

  const filteredKeys = useMemo(() => {
    if (listFilter === 'all') return keys
    return keys.filter((k) => envFromHint(k.key_hint) === listFilter)
  }, [keys, listFilter])

  const activeCount = keys.filter((k) => k.enabled).length

  function openCreate() {
    setError('')
    setScopes(['market', 'scan'])
    setEnv('test')
    setExpiry('never')
    setShowCreate(true)
  }

  function closeCreate() {
    if (creating) return
    setShowCreate(false)
  }

  async function onCreate() {
    try {
      setError('')
      setCreating(true)
      const exp = EXPIRY_OPTIONS.find((o) => o.id === expiry)
      const expiresAt = exp?.seconds != null ? Math.floor(Date.now() / 1000) + exp.seconds : null
      const out = await createKey(session.jwt, {
        scopes,
        env,
        rateLimit: 60,
        expiresAt,
      })
      setShowCreate(false)
      setFreshKey(out)
      setCopied(false)
      setSavedAck(false)
      setSnippetCopied(false)
      setKeys(await listKeys(session.jwt))
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  async function onConfirmRevoke() {
    if (!revokeTarget) return
    try {
      setRevoking(true)
      setError('')
      await revokeKey(session.jwt, revokeTarget.id)
      setRevokeTarget(null)
      setKeys(await listKeys(session.jwt))
    } catch (e) {
      setError(e.message)
    } finally {
      setRevoking(false)
    }
  }

  function toggleScope(id) {
    setScopes((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  function onCopyKey() {
    if (!freshKey?.key) return
    navigator.clipboard?.writeText(freshKey.key).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  function onCopySnippet() {
    if (!freshKey?.key) return
    navigator.clipboard?.writeText(curlSnippet(freshKey.key)).catch(() => {})
    setSnippetCopied(true)
    setTimeout(() => setSnippetCopied(false), 1600)
  }

  function closeFreshKey() {
    if (!savedAck) return
    setFreshKey(null)
    setSavedAck(false)
  }

  return (
    <div className="card">
      <div className="eyebrow">
        <span>Developers</span>
        <span>·</span>
        <span>API keys</span>
        <span className="rule"></span>
        <span>{`SEP-10 · ${shortAddr(session.address)}`}</span>
      </div>

      <h1 className="h-display">API keys</h1>
      <p className="lede">
        Authenticate with a Stellar wallet, create scoped secret keys, and call strategy, risk scan,
        and gasless deposit relay. Server-side secrets stay on VF — you hold one{' '}
        <span className="mono">vf_</span> key. Secret values are shown <b>once</b> at creation.
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

      {/* Header: count + create (Stripe-style primary CTA) */}
      <div
        className="flex items-baseline justify-between"
        style={{ marginTop: 32, gap: 16, flexWrap: 'wrap' }}
      >
        <div>
          <span style={sectionTitle}>Your keys</span>
          <p className="mono faint" style={{ marginTop: 6, fontSize: 11.5 }}>
            {activeCount} active · {keys.length} total
          </p>
        </div>
        <button className="btn btn-primary" type="button" onClick={openCreate}>
          Create secret key
        </button>
      </div>

      {/* Env filter */}
      <div
        role="tablist"
        aria-label="Filter by environment"
        className="flex gap-2"
        style={{ marginTop: 18 }}
      >
        {[
          { id: 'all', label: 'All' },
          { id: 'test', label: 'Test' },
          { id: 'live', label: 'Live' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={listFilter === t.id}
            className={`btn btn-ghost${listFilter === t.id ? ' selected' : ''}`}
            style={{
              fontSize: 12,
              padding: '6px 12px',
              background: listFilter === t.id ? 'var(--bg-elev-2)' : undefined,
              borderColor: listFilter === t.id ? 'var(--border-strong)' : undefined,
            }}
            onClick={() => setListFilter(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Key table */}
      {filteredKeys.length === 0 ? (
        <div
          style={{
            marginTop: 16,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elev)',
            padding: '28px 22px',
            textAlign: 'center',
          }}
        >
          <p className="mono" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {keys.length === 0
              ? 'No keys yet. Create a restricted secret key to call the API.'
              : `No ${listFilter} keys.`}
          </p>
          {keys.length === 0 && (
            <button
              className="btn btn-primary"
              type="button"
              style={{ marginTop: 16 }}
              onClick={openCreate}
            >
              Create secret key
            </button>
          )}
        </div>
      ) : (
        <div className="perm-doc" style={{ marginTop: 16 }}>
          <div
            className="perm-doc-row"
            style={{
              gridTemplateColumns: '1.2fr 1fr 0.7fr 0.7fr auto',
              opacity: 0.75,
              paddingTop: 12,
              paddingBottom: 12,
            }}
          >
            <span className="perm-doc-k">Token</span>
            <span className="perm-doc-k">Permissions</span>
            <span className="perm-doc-k">Created</span>
            <span className="perm-doc-k">Last used</span>
            <span className="perm-doc-k"> </span>
          </div>
          {filteredKeys.map((k) => {
            const sc = parseScopes(k.scopes)
            const envLabel = envFromHint(k.key_hint)
            return (
              <div
                className="perm-doc-row"
                key={k.id}
                style={{
                  gridTemplateColumns: '1.2fr 1fr 0.7fr 0.7fr auto',
                  alignItems: 'center',
                  opacity: k.enabled ? 1 : 0.55,
                }}
              >
                <span className="perm-doc-v" style={{ flexDirection: 'column', gap: 4 }}>
                  <span className={k.enabled ? '' : 'struck'}>{k.key_hint}</span>
                  <span className="annot">
                    {envLabel} · {k.rate_limit ?? 60}/min
                    {!k.enabled ? ' · revoked' : ''}
                  </span>
                </span>
                <span className="perm-doc-v" style={{ fontSize: 11.5 }}>
                  {sc.length ? sc.join(' · ') : '—'}
                </span>
                <span className="perm-doc-v annot" style={{ fontSize: 11.5 }}>
                  {fmtDate(k.created_at)}
                </span>
                <span className="perm-doc-v annot" style={{ fontSize: 11.5 }}>
                  {fmtDate(k.last_used_at)}
                </span>
                <span>
                  {k.enabled ? (
                    <button
                      type="button"
                      className="btn btn-text"
                      style={{ color: 'var(--danger)', fontSize: 12, padding: '4px 8px' }}
                      onClick={() => setRevokeTarget(k)}
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="mono faint" style={{ fontSize: 11 }}>
                      revoked
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Auth usage (always visible when signed in) */}
      <div style={{ marginTop: 36 }}>
        <span style={sectionTitle}>Authenticate requests</span>
        <p className="lede" style={{ marginTop: 10, fontSize: 13.5, maxWidth: 560 }}>
          Send the secret key as a Bearer token. Keep it server-side only — never ship a{' '}
          <span className="mono">vf_</span> key in client bundles or public repos.
        </p>
        <CodeBlock
          style={{ marginTop: 14 }}
          preStyle={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '14px 44px 14px 16px',
            fontSize: 12,
            lineHeight: 1.55,
            overflowX: 'auto',
            color: 'var(--text-muted)',
            margin: 0,
          }}
          code={`Authorization: Bearer vf_test_…\n\n${curlSnippet()}`}
        />
        <p className="foot-note" style={{ marginTop: 12 }}>
          Prefer least privilege: create separate keys per service, revoke the old key after
          rotation.
        </p>
      </div>

      {/* Create key dialog */}
      {showCreate && (
        <div className="modal-backdrop" onClick={closeCreate}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Create secret key"
            style={{ maxWidth: 520 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-eyebrow">API keys · New secret</div>
            <div className="modal-title">Create secret key</div>
            <div className="modal-scroll-content">
              <span style={sectionTitle}>Environment</span>
              <div
                role="radiogroup"
                aria-label="environment"
                className="risk-row"
                style={{ marginTop: 10, gridTemplateColumns: 'repeat(2, 1fr)' }}
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

              <div style={{ marginTop: 22 }}>
                <span style={sectionTitle}>Permissions</span>
                <p className="foot-note" style={{ marginTop: 6, marginBottom: 10 }}>
                  Restrict scopes so a leaked key cannot call more than it needs.
                </p>
                <div className="perm-doc">
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
              </div>

              <div style={{ marginTop: 22 }}>
                <span style={sectionTitle}>Expiration</span>
                <div
                  role="radiogroup"
                  aria-label="expiration"
                  className="flex gap-2"
                  style={{ marginTop: 10, flexWrap: 'wrap' }}
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={expiry === o.id}
                      className="btn btn-ghost"
                      style={{
                        fontSize: 12,
                        padding: '6px 12px',
                        background: expiry === o.id ? 'var(--bg-elev-2)' : undefined,
                        borderColor: expiry === o.id ? 'var(--border-strong)' : undefined,
                      }}
                      onClick={() => setExpiry(o.id)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <p className="foot-note" style={{ marginTop: 18 }}>
                Rate limit <b>60 req/min</b> · secret shown once · revocable anytime
              </p>
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={onCreate}
                disabled={scopes.length === 0 || creating}
              >
                {creating ? 'Creating…' : 'Create key'}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={closeCreate}
                disabled={creating}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reveal-once secret (Stripe / GitHub pattern) */}
      {freshKey && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="New API key"
            style={{ maxWidth: 520 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-eyebrow">API key · Shown once</div>
            <div className="modal-title">Save this secret key</div>

            <div
              style={{
                borderLeft: '2px solid var(--warn)',
                background: 'var(--bg-elev)',
                padding: '12px 14px',
                marginBottom: 16,
                fontSize: 12.5,
                color: 'var(--text-muted)',
                lineHeight: 1.45,
              }}
            >
              This is the only time the full key is available. We store a hash only — if you lose
              it, create a new key and revoke the old one.
            </div>

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

            <div className="flex gap-2" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" type="button" onClick={onCopyKey}>
                {copied ? 'Copied' : 'Copy key'}
              </button>
              <button className="btn btn-ghost" type="button" onClick={onCopySnippet}>
                {snippetCopied ? 'Snippet copied' : 'Copy curl'}
              </button>
            </div>

            <pre
              className="mono"
              style={{
                marginTop: 16,
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
                fontSize: 11.5,
                lineHeight: 1.5,
                overflowX: 'auto',
                color: 'var(--text-muted)',
              }}
            >
              {curlSnippet(freshKey.key)}
            </pre>

            <label
              className="flex gap-2"
              style={{
                marginTop: 18,
                alignItems: 'flex-start',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--text-muted)',
                lineHeight: 1.4,
              }}
            >
              <input
                type="checkbox"
                checked={savedAck}
                onChange={(e) => setSavedAck(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>I have saved this key in a password manager or secrets vault.</span>
            </label>

            <div className="modal-actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={closeFreshKey}
                disabled={!savedAck}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revoke confirmation */}
      {revokeTarget && (
        <div className="modal-backdrop" onClick={() => !revoking && setRevokeTarget(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Revoke API key"
            style={{ maxWidth: 420 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-eyebrow">Revoke · Irreversible</div>
            <div className="modal-title">Revoke this key?</div>
            <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Requests using{' '}
              <span className="mono" style={{ color: 'var(--text)' }}>
                {revokeTarget.key_hint}
              </span>{' '}
              will fail immediately. Create a replacement first if you need zero downtime.
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-primary"
                type="button"
                style={{ background: 'var(--danger)', color: '#0e0f0c' }}
                onClick={onConfirmRevoke}
                disabled={revoking}
              >
                {revoking ? 'Revoking…' : 'Revoke key'}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => setRevokeTarget(null)}
                disabled={revoking}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
