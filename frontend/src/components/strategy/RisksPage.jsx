// frontend/src/components/strategy/RisksPage.jsx
// P1 G7: the permanent /risks page — the one risks summary the deposit flow was missing,
// reachable any time from the shell footer's Risks link. Reads only strategy/risks.js via
// RisksContent; no wallet, no chain reads, no props.
// P1 G8: renders the AUDIT_PLAN line under the six risks — honestly unaudited, with the
// mainnet audit scope and no "audited" claim.
import { AUDIT_PLAN } from '../../strategy/risks.js'
import { RisksContent } from './RisksContent.jsx'

export function RisksPage() {
  return (
    <div className="pc-route pc-risks-route">
      <div className="pc-route-stack">
        <h1>Risks</h1>
        <p>
          Everything here is testnet-grade only. Read these six risks before your first grant;
          each names the mitigation that already ships.
        </p>
        <RisksContent />
        <p className="pc-risks-audit">{AUDIT_PLAN}</p>
      </div>
    </div>
  )
}
