// frontend/src/components/console/MandateZone.jsx
// Scoped permissions ("the leash"): per-agent cap gauge + revoke. perm-doc heritage rows.
import ZoneFrame from './ZoneFrame.jsx'
import Gauge from './instruments/Gauge.jsx'
import { shortAddr } from './consoleUtils.js'
import { toDisplay } from '../../stellar/format.js'

export default function MandateZone({ scopes = [], onRevoke }) {
  const active = scopes.filter((s) => !s.revoked)
  const totalCap = scopes.reduce((sum, s) => sum + Number(s.capPerPeriod || 0), 0)

  return (
    <ZoneFrame
      title="mandate"
      hue="warn"
      led={active.length ? 'ok' : 'idle'}
      className="console-mandate"
      meta={`${active.length} scopes active · ${toDisplay(totalCap).toFixed(2)} USDC total cap`}
    >
      {scopes.length === 0 ? (
        <div className="zone-empty">no scoped agents — grant creates scopes</div>
      ) : (
        scopes.map((s, i) => (
          <div className="mandate-row" key={s.agent}>
            <span className="mono mandate-idx">{String(i + 1).padStart(2, '0')}</span>
            <div className="mandate-main">
              <span className="mono mandate-addr">{shortAddr(s.agent)}</span>
              <span className="mono mandate-caps tnum">
                max-at-risk {toDisplay(s.maxAtRisk).toFixed(2)} / cap{' '}
                {toDisplay(s.capPerPeriod).toFixed(2)} USDC
              </span>
              <Gauge value={Number(s.maxAtRisk)} max={Number(s.capPerPeriod)} />
            </div>
            {s.revoked ? (
              <span className="mono mandate-revoked">revoked</span>
            ) : (
              <button
                className="btn btn-ghost pos-cta mandate-revoke"
                onClick={() => onRevoke(s.agent)}
              >
                revoke
              </button>
            )}
          </div>
        ))
      )}
      <div className="mandate-guards mono">
        revocable · yes — anytime, on-chain · expiry · via SEP-41 allowance
      </div>
    </ZoneFrame>
  )
}
