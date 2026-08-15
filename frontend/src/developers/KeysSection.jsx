import { useEffect, useMemo, useRef, useState } from 'react'
import { listKeys, createKey, revokeKey } from './portalClient.js'
import CodeBlock from './CodeBlock.jsx'
import { toDevelopersPresentation } from '../secondary/secondaryRouteAdapters.js'
import { Dialog, StatusNotice, TechnicalDetails } from '../components/pocket/Primitives.jsx'
import { NetworkRoute } from '../components/pocket/NetworkIdentity.jsx'
import { NETWORK_IDS } from '../design/networks.js'
import './Developers.css'
import '../components/SecondaryDialogs.css'

const SOURCE = 'Portal API'
const STALE_AFTER_MS = 120000

const NETWORK_CONTEXT = Object.freeze({
  hostNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  sourceNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  destinationNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  custodyNetworkId: NETWORK_IDS.STELLAR_TESTNET,
  transitState: 'none',
})

const factFor = (state, value = null, overrides = {}) => ({
  state,
  value,
  source: SOURCE,
  checkedAt: new Date().toISOString(),
  staleAfterMs: STALE_AFTER_MS,
  ...overrides,
})

const sourceOf = (read) => {
  if (!read || typeof read !== 'object') return {}
  if (read.readResult && typeof read.readResult === 'object') return read.readResult
  return read
}

const readInputOf = ({ developersRead, keysRead, read }) =>
  developersRead ?? keysRead ?? read ?? null

const keysFrom = (read) => {
  const source = sourceOf(read)
  return Array.isArray(source.keys) ? source.keys : []
}

const factForPrimitive = (view) => ({
  ...view.fact,
  consequence: view.notice?.consequence ?? view.fact.consequence,
  safeNextAction: view.notice?.nextAction ?? view.fact.safeNextAction,
})

// Scope contract — same rows for docs (pre-auth) and permission picker (create form).
const SCOPE_INFO = [
  { id: 'strategy', endpoints: 'POST /strategy', note: 'AI allocation using market context' },
  {
    id: 'market',
    endpoints: '/vault-facts, /prices, /eligibility',
    note: 'Read-only market data',
  },
  { id: 'tx', endpoints: '/build-tx, /simulate', note: 'Unsigned XDR only' },
  { id: 'submit', endpoints: 'POST /submit', note: 'Deposit-only fee-bump relay' },
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
  if (!sec) return 'Not available'
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

export default function KeysSection({ session, developersRead, keysRead, read, previousRead }) {
  const injectedRead = readInputOf({ developersRead, keysRead, read })
  const [keys, setKeys] = useState(() => keysFrom(injectedRead))
  const [listFilter, setListFilter] = useState('all') // all | test | live

  // Create form (Stripe-style: create → reveal once)
  const [showCreate, setShowCreate] = useState(false)
  const [scopes, setScopes] = useState(['market', 'scan'])
  const [env, setEnv] = useState('test')
  const [expiry, setExpiry] = useState('never')
  const [creating, setCreating] = useState(false)

  // Reveal-once secret (industry standard: never recoverable)
  // The full secret is held only by this one-time view model. It is never merged into the list
  // response, URL, fixture, or technical details model.
  const [oneTimeSecret, setOneTimeSecret] = useState(null) // { key, acknowledged, copied, error }

  // Revoke confirmation
  const [revokeTarget, setRevokeTarget] = useState(null) // key row
  const [revoking, setRevoking] = useState(false)

  const [error, setError] = useState('')
  const createInitialFocusRef = useRef(null)
  const secretInitialFocusRef = useRef(null)
  const revokeInitialFocusRef = useRef(null)
  const [settledRead, setSettledRead] = useState(() => ({
    fact: factFor('loading', null, { checkedAt: null }),
    facts: { keys: factFor('loading', null, { checkedAt: null }) },
  }))

  useEffect(() => {
    if (injectedRead) return undefined
    let on = true
    listKeys(session.jwt)
      .then((k) => {
        if (!on || injectedRead) return
        setKeys(k)
        setSettledRead({
          fact: factFor('current'),
          facts: { keys: factFor('current') },
          keys: k,
        })
      })
      .catch((e) => {
        if (!on || injectedRead) return
        setError(e.message)
        setSettledRead({
          fact: factFor('error', null, { error: e.message }),
          facts: { keys: factFor('error') },
        })
      })
    return () => {
      on = false
    }
  }, [session.jwt, injectedRead])

  const source = sourceOf(injectedRead ?? settledRead)
  const presentation = toDevelopersPresentation(
    injectedRead ?? settledRead,
    injectedRead?.previousRead ?? previousRead
  )
  const view = presentation.facts?.keys || presentation
  const fact = view.fact
  const statusFact = factForPrimitive(view)
  const displayedKeys = keys
  const visibleError = injectedRead ? source.error || '' : error

  const filteredKeys = useMemo(() => {
    if (listFilter === 'all') return displayedKeys
    return displayedKeys.filter((k) => envFromHint(k.key_hint) === listFilter)
  }, [displayedKeys, listFilter])

  const activeCount = displayedKeys.filter((k) => k.enabled).length

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
      setOneTimeSecret({
        key: typeof out?.key === 'string' ? out.key : '',
        acknowledged: false,
        copied: false,
        error: '',
      })
      const nextKeys = await listKeys(session.jwt)
      setKeys(nextKeys)
      setSettledRead({
        fact: factFor('current'),
        facts: { keys: factFor('current') },
        keys: nextKeys,
      })
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
      const nextKeys = await listKeys(session.jwt)
      setKeys(nextKeys)
      setSettledRead({
        fact: factFor('current'),
        facts: { keys: factFor('current') },
        keys: nextKeys,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setRevoking(false)
    }
  }

  function toggleScope(id) {
    setScopes((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  async function onCopyKey() {
    if (!oneTimeSecret?.key) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(oneTimeSecret.key)
      setOneTimeSecret((current) => (current ? { ...current, copied: true, error: '' } : current))
    } catch {
      setOneTimeSecret((current) =>
        current
          ? {
              ...current,
              copied: false,
              error: 'Could not copy the key. Select it and copy manually.',
            }
          : current
      )
    }
  }

  function closeOneTimeSecret() {
    if (!oneTimeSecret?.acknowledged) return
    setOneTimeSecret(null)
  }

  return (
    <div
      className="card developers-section"
      data-fact-state={fact.state}
      aria-busy={fact.state === 'loading' ? 'true' : undefined}
    >
      <div className="eyebrow">
        <span>Developers</span>
        <span>API keys</span>
        <span className="rule"></span>
        <span>{`SEP-10 ${shortAddr(session.address)}`}</span>
      </div>

      <h1 className="h-display" data-route-heading>
        API keys
      </h1>
      <NetworkRoute compact context={NETWORK_CONTEXT} />
      <p className="lede">
        Authenticate with a Stellar wallet, create scoped secret keys, and call strategy, risk scan,
        and sponsored deposit relay endpoints. Server-side provider credentials stay on VF. You
        receive one <span className="mono">vf_</span> key, shown <b>once</b> when created.
      </p>

      {visibleError && (
        <p
          role="alert"
          className="mono"
          style={{ marginTop: 18, fontSize: 12, color: 'var(--danger)' }}
        >
          {visibleError}
        </p>
      )}

      <section className="developers-evidence" aria-label="API keys read">
        <StatusNotice fact={statusFact} title="API keys read" />
        {fact.state === 'unavailable' && presentation.notice?.consequence && (
          <div className="developers-notice-copy" role="note">
            <p>{presentation.notice.consequence}</p>
            {presentation.notice.nextAction && <p>{presentation.notice.nextAction}</p>}
          </div>
        )}
        <TechnicalDetails summary="Technical details" fact={statusFact} open />
      </section>

      {/* Header: count + create (Stripe-style primary CTA) */}
      <div
        className="flex items-baseline justify-between"
        style={{ marginTop: 32, gap: 16, flexWrap: 'wrap' }}
      >
        <div>
          <span style={sectionTitle}>Your keys</span>
          <p className="mono faint" style={{ marginTop: 6, fontSize: 11.5 }}>
            Active: {activeCount}. Total: {displayedKeys.length}.
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
            {displayedKeys.length === 0
              ? 'No keys yet. Create a restricted secret key to call the API.'
              : `No ${listFilter} keys.`}
          </p>
          {displayedKeys.length === 0 && (
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
                    {envLabel === 'live' ? 'Live' : 'Test'}, {k.rate_limit ?? 60}/min
                    {!k.enabled ? ', revoked' : ''}
                  </span>
                </span>
                <span className="perm-doc-v" style={{ fontSize: 11.5 }}>
                  {sc.length ? sc.join(', ') : 'None'}
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
                      Revoked
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
          Send the secret key as a Bearer token and keep it server-side. Never ship a{' '}
          <span className="mono">vf_</span> key in a client bundle or public repository.
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
      <Dialog
        open={showCreate}
        title="Create secret key"
        description="Choose the environment, least-privilege permissions, and expiration."
        onClose={closeCreate}
        initialFocusRef={createInitialFocusRef}
        className="secondary-dialog secondary-dialog--wide"
        actions={
          <>
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
          </>
        }
      >
        <div className="secondary-dialog-eyebrow">API keys: New secret</div>
        {creating && (
          <div className="secondary-dialog-error" aria-live="polite">
            <StatusNotice state="info" title="Creating key">
              Waiting for the Portal API.
            </StatusNotice>
          </div>
        )}
        {error && (
          <div className="secondary-dialog-error" aria-live="assertive">
            <StatusNotice state="danger" title="Could not create key">
              {error}
            </StatusNotice>
          </div>
        )}
        <div className="secondary-dialog-fieldset">
          <span className="section-title">Environment</span>
          <div role="radiogroup" aria-label="Environment" className="secondary-dialog-option-grid">
            {['test', 'live'].map((e) => (
              <button
                key={e}
                ref={e === 'test' ? createInitialFocusRef : undefined}
                type="button"
                role="radio"
                aria-checked={env === e}
                className={`risk-opt${env === e ? ' selected' : ''}`}
                onClick={() => setEnv(e)}
              >
                <span className="risk-opt-label">{e === 'test' ? 'Test' : 'Live'}</span>
                <span className="risk-opt-sub">
                  {e === 'test' ? 'vf_test_ (sandbox)' : 'vf_live_ (production)'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="secondary-dialog-fieldset">
          <span className="section-title">Permissions</span>
          <p className="foot-note">
            Restrict scopes so a leaked key cannot call more than it needs.
          </p>
          <div className="perm-doc secondary-dialog-scope-list">
            {SCOPE_INFO.map((s, i) => {
              const on = scopes.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleScope(s.id)}
                  className="perm-doc-row"
                  data-selected={on ? 'true' : 'false'}
                >
                  <span className="perm-doc-k">{s.id}</span>
                  <span className="perm-doc-v">
                    {s.endpoints}
                    <span className="annot">{s.note}</span>
                  </span>
                  {i === SCOPE_INFO.length - 1 && <span aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </div>

        <div className="secondary-dialog-fieldset">
          <span className="section-title">Expiration</span>
          <div role="radiogroup" aria-label="Expiration" className="secondary-dialog-options">
            {EXPIRY_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={expiry === o.id}
                className={`btn btn-ghost${expiry === o.id ? ' selected' : ''}`}
                onClick={() => setExpiry(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <p className="foot-note secondary-dialog-note">
          Rate limit: <b>60 requests per minute</b>. The secret is shown once and can be revoked
          anytime.
        </p>
      </Dialog>

      {/* Reveal-once secret. The key is rendered only in this acknowledged one-time view. */}
      <Dialog
        open={Boolean(oneTimeSecret)}
        title="Save this secret key"
        description="This key is available once. Save it before closing this dialog."
        onClose={closeOneTimeSecret}
        initialFocusRef={secretInitialFocusRef}
        className="secondary-dialog secondary-dialog--wide"
        actions={
          <button
            className="btn btn-primary"
            type="button"
            onClick={closeOneTimeSecret}
            disabled={!oneTimeSecret?.acknowledged}
          >
            Done
          </button>
        }
      >
        <div className="secondary-dialog-eyebrow">API key: Shown once</div>
        <p className="secondary-dialog-secret-note">
          This is the only time the full key is available. Save it before closing; it cannot be
          recovered later.
        </p>
        {oneTimeSecret?.error && (
          <div className="secondary-dialog-error" aria-live="assertive">
            <StatusNotice state="danger" title="Copy failed">
              {oneTimeSecret.error}
            </StatusNotice>
          </div>
        )}
        <div className="secondary-dialog-secret mono tnum">{oneTimeSecret?.key}</div>
        <div className="secondary-dialog-secret-actions">
          <button className="btn btn-primary" type="button" onClick={onCopyKey}>
            {oneTimeSecret?.copied ? 'Copied' : 'Copy key'}
          </button>
        </div>
        <label className="secondary-dialog-secret-ack">
          <input
            ref={secretInitialFocusRef}
            type="checkbox"
            checked={Boolean(oneTimeSecret?.acknowledged)}
            onChange={(e) =>
              setOneTimeSecret((current) =>
                current ? { ...current, acknowledged: e.target.checked } : current
              )
            }
          />
          <span>I have saved this key in a password manager or secrets vault.</span>
        </label>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog
        open={Boolean(revokeTarget)}
        title="Revoke API key"
        description="Requests using this key will fail immediately. Create a replacement first if you need zero downtime."
        onClose={() => !revoking && setRevokeTarget(null)}
        initialFocusRef={revokeInitialFocusRef}
        className="secondary-dialog secondary-dialog--compact"
        actions={
          <>
            <button
              className="btn btn-primary"
              type="button"
              onClick={onConfirmRevoke}
              disabled={revoking}
            >
              {revoking ? 'Revoking…' : 'Revoke key'}
            </button>
            <button
              ref={revokeInitialFocusRef}
              className="btn btn-ghost"
              type="button"
              onClick={() => setRevokeTarget(null)}
              disabled={revoking}
            >
              Cancel
            </button>
          </>
        }
      >
        <div className="secondary-dialog-eyebrow">Revoke: Irreversible</div>
        {revoking && (
          <div className="secondary-dialog-error" aria-live="polite">
            <StatusNotice state="info" title="Revoking key">
              Waiting for the Portal API.
            </StatusNotice>
          </div>
        )}
        {error && (
          <div className="secondary-dialog-error" aria-live="assertive">
            <StatusNotice state="danger" title="Could not revoke key">
              {error}
            </StatusNotice>
          </div>
        )}
        <p className="secondary-dialog-copy">
          Revoke this key? Requests using <span className="mono">{revokeTarget?.key_hint}</span>{' '}
          will fail immediately. This action cannot be undone.
        </p>
      </Dialog>
    </div>
  )
}
