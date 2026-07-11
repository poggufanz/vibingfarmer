import { ENDPOINTS, ERRORS } from './docsData.js'

const codeBlock = {
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '12px 14px',
  fontSize: 11.5,
  lineHeight: 1.55,
  overflowX: 'auto',
  color: 'var(--text-muted)',
  marginTop: 8,
}

export default function DocsSection() {
  return (
    <div className="card">
      <div className="eyebrow">
        <span>developers</span>
        <span>·</span>
        <span>api reference</span>
      </div>
      <h1 className="h-display">API documentation</h1>
      <p className="lede">
        All endpoints live under <span className="mono">/api/vf</span> on this origin and
        authenticate with a secret key as a Bearer token. Responses are JSON.
      </p>

      <pre className="mono" style={codeBlock}>
        {`Authorization: Bearer vf_test_…

curl -s https://api.vibing.farmer/api/vf/prices \\
  -H "Authorization: Bearer vf_test_…"`}
      </pre>

      <h2 className="h-sub" style={{ marginTop: 32 }}>
        Errors
      </h2>
      <div className="perm-doc" style={{ marginTop: 10 }}>
        {ERRORS.map((e) => (
          <div className="perm-doc-row" key={e.status}>
            <span className="perm-doc-k mono tnum">{e.status}</span>
            <span className="perm-doc-v">
              {e.error}
              <span className="annot">{e.when}</span>
            </span>
          </div>
        ))}
      </div>

      <h2 className="h-sub" style={{ marginTop: 32 }}>
        Endpoints
      </h2>
      {ENDPOINTS.map((e) => (
        <div
          key={e.path}
          style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--border)' }}
        >
          <p className="mono" style={{ fontSize: 13 }}>
            <span style={{ color: 'var(--accent)' }}>{e.method}</span> {e.path}
            <span className="annot" style={{ marginLeft: 10 }}>
              scope: {e.scope}
            </span>
          </p>
          <p style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>{e.desc}</p>
          {e.req && (
            <>
              <span className="annot faint">request</span>
              <pre className="mono" style={codeBlock}>
                {e.req}
              </pre>
            </>
          )}
          <span className="annot faint">response</span>
          <pre className="mono" style={codeBlock}>
            {e.resp}
          </pre>
        </div>
      ))}

      <p className="foot-note" style={{ marginTop: 24 }}>
        Rate limit: per-key req/min (set at issuance, default 60) · global daily budget shared
        across keys · testnet.
      </p>
    </div>
  )
}
