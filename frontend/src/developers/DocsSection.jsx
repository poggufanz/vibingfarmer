import { useRef } from 'react'
import { ENDPOINTS, ERRORS, SCOPES } from './docsData.js'
import CodeBlock from './CodeBlock.jsx'

// pre look only — right padding leaves room for the copy button; spacing lives on the wrapper.
const codeBlock = {
  background: 'var(--bg-elev)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '12px 44px 12px 14px',
  fontSize: 11.5,
  lineHeight: 1.55,
  overflowX: 'auto',
  color: 'var(--text-muted)',
  margin: 0,
}

const endpointsOf = (scopeId) => ENDPOINTS.filter((e) => e.scope === scopeId)

export default function DocsSection() {
  const listRef = useRef(null)

  // Native <details> stay uncontrolled so per-row toggling keeps working; the toolbar
  // just flips every disclosure at once via the DOM. No controlled-component friction.
  const setAll = (open) => {
    listRef.current?.querySelectorAll('details').forEach((d) => {
      d.open = open
    })
  }

  return (
    <div className="card">
      <div className="eyebrow">
        <span>Developers</span>
        <span>API reference</span>
      </div>
      <h1 className="h-display">API documentation</h1>
      <p className="lede">
        All endpoints live under <span className="mono">/api/vf</span> on this origin and
        authenticate with a secret key as a Bearer token. Responses are JSON.
      </p>

      <CodeBlock
        style={{ marginTop: 8 }}
        preStyle={codeBlock}
        code={`Authorization: Bearer vf_test_…

curl -s https://api.vibing.farmer/api/vf/prices \\
  -H "Authorization: Bearer vf_test_…"`}
      />

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

      <div className="docs-endpoints-head">
        <h2 className="h-sub">Endpoints</h2>
        <div className="docs-toolbar">
          <button type="button" className="btn btn-text" onClick={() => setAll(true)}>
            Expand all
          </button>
          <button type="button" className="btn btn-text" onClick={() => setAll(false)}>
            Collapse all
          </button>
        </div>
      </div>
      <p className="foot-note" style={{ marginTop: 4 }}>
        Grouped by scope. Open a row for its request and response shape.
      </p>

      <div className="docs-endpoints" ref={listRef}>
        {SCOPES.map((s) => {
          const eps = endpointsOf(s.id)
          if (eps.length === 0) return null
          return (
            <section className="docs-scope" key={s.id}>
              <div className="docs-scope-head">
                <span className="docs-scope-name mono">{s.id}</span>
                <span className="docs-scope-grant">{s.grant}</span>
              </div>
              {eps.map((e) => (
                <details className="docs-endpoint" key={e.path}>
                  <summary className="docs-endpoint-sum">
                    <span
                      className={`docs-method mono ${e.method === 'GET' ? 'is-get' : 'is-post'}`}
                    >
                      {e.method}
                    </span>
                    <span className="docs-path mono">{e.path}</span>
                    <span className="docs-desc">{e.desc}</span>
                  </summary>
                  <div className="docs-endpoint-body">
                    {e.req && (
                      <>
                        <span className="annot faint">Request</span>
                        <CodeBlock style={{ marginTop: 8 }} preStyle={codeBlock} code={e.req} />
                      </>
                    )}
                    <span className="annot faint">Response</span>
                    <CodeBlock style={{ marginTop: 8 }} preStyle={codeBlock} code={e.resp} />
                  </div>
                </details>
              ))}
            </section>
          )
        })}
      </div>

      <p className="foot-note" style={{ marginTop: 24 }}>
        Each key defaults to 60 requests per minute. All keys share the testnet daily budget.
      </p>
    </div>
  )
}
