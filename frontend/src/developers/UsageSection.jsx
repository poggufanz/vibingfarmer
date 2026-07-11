import { useEffect, useMemo, useState } from 'react'
import { listKeys, getUsage } from './portalClient.js'

const fmtDay = (d) => d // YYYY-MM-DD is already the document-grade format

export default function UsageSection({ session }) {
  const [keys, setKeys] = useState([])
  const [data, setData] = useState(null) // { usage, cap, sinceDay }
  const [error, setError] = useState('')
  const [keyFilter, setKeyFilter] = useState('all')

  useEffect(() => {
    let on = true
    Promise.all([listKeys(session.jwt), getUsage(session.jwt)])
      .then(([k, u]) => {
        if (!on) return
        setKeys(k)
        setData(u)
      })
      .catch((e) => on && setError(e.message))
    return () => {
      on = false
    }
  }, [session.jwt])

  const hintOf = useMemo(() => {
    const m = new Map(keys.map((k) => [k.id, k.key_hint]))
    return (id) => m.get(id) || id
  }, [keys])

  const rows = useMemo(() => {
    if (!data) return []
    return keyFilter === 'all' ? data.usage : data.usage.filter((r) => r.key_id === keyFilter)
  }, [data, keyFilter])

  const today = new Date().toISOString().slice(0, 10)
  const todayTotal = rows.filter((r) => r.day === today).reduce((n, r) => n + r.count, 0)

  return (
    <div className="card">
      <div className="eyebrow">
        <span>developers</span>
        <span>·</span>
        <span>usage</span>
      </div>
      <h1 className="h-display">Usage</h1>
      <p className="lede">
        Daily request counts per endpoint, aggregated from the gateway log. Per-key limit is
        enforced per minute; all keys share a global daily budget.
      </p>

      {error && (
        <p
          role="alert"
          className="mono"
          style={{ marginTop: 14, fontSize: 12, color: 'var(--danger)' }}
        >
          {error}
        </p>
      )}

      {data && (
        <>
          <div className="flex" style={{ gap: 48, marginTop: 28 }}>
            <div>
              <span className="figure-md mono tnum">{todayTotal}</span>
              <p className="annot faint" style={{ marginTop: 4 }}>
                requests today · budget {data.cap.toLocaleString('en-US')}
              </p>
            </div>
            <div>
              <span className="figure-md mono tnum">
                {keyFilter === 'all'
                  ? keys.filter((k) => k.enabled).length
                  : (keys.find((k) => k.id === keyFilter)?.rate_limit ?? 60)}
              </span>
              <p className="annot faint" style={{ marginTop: 4 }}>
                {keyFilter === 'all' ? 'active keys' : 'req/min limit'}
              </p>
            </div>
          </div>

          <div
            role="tablist"
            aria-label="Filter by key"
            className="flex"
            style={{ gap: 8, marginTop: 24, flexWrap: 'wrap' }}
          >
            {[{ id: 'all', key_hint: 'All keys' }, ...keys].map((k) => (
              <button
                key={k.id}
                type="button"
                role="tab"
                aria-selected={keyFilter === k.id}
                className="btn btn-ghost"
                style={{
                  fontSize: 12,
                  padding: '6px 12px',
                  background: keyFilter === k.id ? 'var(--bg-elev-2)' : undefined,
                  borderColor: keyFilter === k.id ? 'var(--border-strong)' : undefined,
                }}
                onClick={() => setKeyFilter(k.id)}
              >
                {k.key_hint}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="mono faint" style={{ marginTop: 20, fontSize: 12.5 }}>
              No requests since {data.sinceDay}. Call the API with a key to see usage here.
            </p>
          ) : (
            <div className="perm-doc" style={{ marginTop: 20 }}>
              <div
                className="perm-doc-row"
                style={{ gridTemplateColumns: '0.8fr 1.2fr 0.9fr 0.5fr', opacity: 0.75 }}
              >
                <span className="perm-doc-k">Day</span>
                <span className="perm-doc-k">Endpoint</span>
                <span className="perm-doc-k">Key</span>
                <span className="perm-doc-k" style={{ textAlign: 'right' }}>
                  Requests
                </span>
              </div>
              {rows.map((r) => (
                <div
                  className="perm-doc-row"
                  key={`${r.key_id}|${r.day}|${r.endpoint}`}
                  style={{ gridTemplateColumns: '0.8fr 1.2fr 0.9fr 0.5fr', alignItems: 'center' }}
                >
                  <span className="perm-doc-v annot">{fmtDay(r.day)}</span>
                  <span className="perm-doc-v">{r.endpoint}</span>
                  <span className="perm-doc-v annot">{hintOf(r.key_id)}</span>
                  <span className="perm-doc-v mono tnum" style={{ textAlign: 'right' }}>
                    {r.count}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="foot-note" style={{ marginTop: 16 }}>
            Aggregates only — per-request telemetry is not stored. Window: last 30 days.
          </p>
        </>
      )}
    </div>
  )
}
