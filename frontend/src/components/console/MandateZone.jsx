// frontend/src/components/console/MandateZone.jsx
// Scoped permissions ("the leash"): per-agent cap gauge + revoke. perm-doc heritage rows.
import { useState } from 'react'
import ZoneFrame from './ZoneFrame.jsx'
import Gauge from './instruments/Gauge.jsx'
import Pager from './Pager.jsx'
import { shortAddr } from './consoleUtils.js'
import { toDisplay } from '../../stellar/format.js'

const PAGE_SIZE = 3

export default function MandateZone({ scopes = [], onRevoke }) {
  const [page, setPage] = useState(0)
  const active = scopes.filter((s) => !s.revoked)
  const exited = scopes.length - active.length
  const totalCap = active.reduce((sum, s) => sum + Number(s.capPerPeriod || 0), 0)
  // Paginate ACTIVE scopes only — the header already counts only active, and a revoked scope is
  // terminal (owner_withdraw sweeps then revokes). Rendering dead agents as "Max at risk 40.00
  // USDC" cards read as money still allocated: a user who swept 100 USDC home saw three of these
  // summing to exactly 100 and reported the withdraw as never having happened.
  const pages = Math.max(1, Math.ceil(active.length / PAGE_SIZE))
  const cur = Math.min(page, pages - 1)
  const pageScopes = active.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE)

  return (
    <ZoneFrame
      title="Mandate"
      hue="warn"
      led={active.length ? 'ok' : 'idle'}
      className="console-mandate"
      meta={`${active.length} active scopes, ${toDisplay(totalCap).toFixed(2)} USDC total cap`}
    >
      {scopes.length === 0 ? (
        <div className="zone-empty">No scoped agents. Create a grant to add scopes.</div>
      ) : active.length === 0 ? (
        <div className="zone-empty">
          All {exited} agents exited — funds swept back to your wallet. Create a grant to farm
          again.
        </div>
      ) : (
        pageScopes.map((s, i) => (
          <div className="mandate-row" key={s.agent}>
            <span className="mono mandate-idx">
              {String(cur * PAGE_SIZE + i + 1).padStart(2, '0')}
            </span>
            <div className="mandate-main">
              <span className="mono mandate-addr">{shortAddr(s.agent)}</span>
              <span className="mono mandate-caps tnum">
                Max at risk {toDisplay(s.maxAtRisk).toFixed(2)} / Cap{' '}
                {toDisplay(s.capPerPeriod).toFixed(2)} USDC
              </span>
              <Gauge value={Number(s.maxAtRisk)} max={Number(s.capPerPeriod)} />
            </div>
            <button
              className="btn btn-ghost pos-cta mandate-revoke"
              onClick={() => onRevoke(s.agent)}
            >
              Revoke
            </button>
          </div>
        ))
      )}
      <Pager page={cur} pages={pages} onPage={setPage} />
      {exited > 0 && active.length > 0 && (
        <div className="mono mandate-exited" style={{ opacity: 0.5, fontSize: 10 }}>
          {exited} exited agent{exited === 1 ? '' : 's'} hidden (revoked on-chain, nothing at
          risk).
        </div>
      )}
      <div className="mandate-guards mono">
        Revocable: Yes, anytime on-chain. Expiry uses the SEP-41 allowance.
      </div>
    </ZoneFrame>
  )
}
