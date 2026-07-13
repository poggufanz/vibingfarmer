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
  const totalCap = active.reduce((sum, s) => sum + Number(s.capPerPeriod || 0), 0)
  const pages = Math.max(1, Math.ceil(scopes.length / PAGE_SIZE))
  const cur = Math.min(page, pages - 1)
  const pageScopes = scopes.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE)

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
            {s.revoked ? (
              <span className="mono mandate-revoked">Revoked</span>
            ) : (
              <button
                className="btn btn-ghost pos-cta mandate-revoke"
                onClick={() => onRevoke(s.agent)}
              >
                Revoke
              </button>
            )}
          </div>
        ))
      )}
      <Pager page={cur} pages={pages} onPage={setPage} />
      <div className="mandate-guards mono">
        Revocable: Yes, anytime on-chain. Expiry uses the SEP-41 allowance.
      </div>
    </ZoneFrame>
  )
}
