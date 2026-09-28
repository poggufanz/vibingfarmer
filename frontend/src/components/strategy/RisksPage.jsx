// frontend/src/components/strategy/RisksPage.jsx
// P1 G7: the permanent /risks page — the one risks summary the deposit flow was missing,
// reachable any time from the shell footer's Risks link. Reads only strategy/risks.js via
// RisksContent; no wallet, no chain reads, no props.
// P1 G8: renders the AUDIT_PLAN line under the six risks — honestly unaudited, with the
// mainnet audit scope and no "audited" claim.
// Layout (2026-09-28): state strip, risk register plate, audit plate. Same instrument material
// as History and Settings. app.jsx already wraps this in `.pc-route`, so the root is not one.
import { AUDIT_PLAN, RISKS } from '../../strategy/risks.js'
import { RisksContent } from './RisksContent.jsx'

const AUDIT_SCOPE = ['Router', 'Vault', 'Strategy', 'Agent auth']

export function RisksPage() {
  const guarded = RISKS.filter((risk) => risk.mitigation).length
  const state = [
    { label: 'Network', value: 'Testnet only', tone: 'warn' },
    { label: 'Audit', value: 'Not audited', tone: 'danger' },
    { label: 'Risks disclosed', value: String(RISKS.length), tone: 'idle' },
    { label: 'Mitigations shipped', value: `${guarded} of ${RISKS.length}`, tone: 'live' },
  ]

  return (
    <div className="pc-risks-route">
      <header className="pc-risks-head">
        <h1 className="pc-risks-title">Risks</h1>
        <p className="pc-risks-intro">
          Everything here is testnet-grade only. Read these six risks before your first grant; each
          names the mitigation that already ships.
        </p>
        <dl className="pc-risks-state">
          {state.map((item) => (
            <div key={item.label} className="pc-risks-state-item" data-tone={item.tone}>
              <dt>
                <span className="pc-risks-lamp" aria-hidden="true" />
                {item.label}
              </dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <section className="pc-risks-plate" aria-labelledby="pc-risks-register-title">
        <div className="pc-risks-plate-head">
          <h2 id="pc-risks-register-title" className="pc-risks-plate-title">
            Risk register
          </h2>
          <p className="pc-risks-plate-lede">What can go wrong, and the guard already in place.</p>
        </div>
        <RisksContent />
      </section>

      <section
        className="pc-risks-plate pc-risks-audit"
        aria-labelledby="pc-risks-audit-title"
        data-tone="danger"
      >
        <div className="pc-risks-plate-head">
          <h2 id="pc-risks-audit-title" className="pc-risks-plate-title">
            Audit status
          </h2>
          <span className="pc-risks-chip">
            <span className="pc-risks-lamp" aria-hidden="true" />
            Unaudited
          </span>
        </div>
        <div className="pc-risks-audit-body">
          <p className="pc-risks-audit-copy">{AUDIT_PLAN}</p>
          <div className="pc-risks-scope">
            <p className="pc-risks-scope-label">Mainnet audit scope</p>
            <ul className="pc-risks-scope-list">
              {AUDIT_SCOPE.map((part) => (
                <li key={part}>{part}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  )
}
