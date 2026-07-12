// frontend/src/components/console/KeeperZone.jsx
import ZoneFrame from './ZoneFrame.jsx'
import Dial from './instruments/Dial.jsx'
import { agoText } from './consoleUtils.js'

const shortHash = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '')

export default function KeeperZone({ events = [], pricePerShare = null, strategies = [], nowMs }) {
  const engaged = strategies.length > 0 && pricePerShare != null
  const aprs = strategies.map((s) => s.aprPct).filter((a) => Number.isFinite(a))
  const apr = aprs.length ? Math.max(...aprs) : null
  const compounds = events.filter((e) => e.kind === 'compound_executed' && e.pricePerShare != null)
  const delta =
    compounds.length >= 2
      ? Number(compounds[0].pricePerShare) - Number(compounds[1].pricePerShare)
      : null
  const last = events[0] || null

  return (
    <ZoneFrame
      title="Keeper"
      hue="ok"
      led={engaged ? 'ok' : 'idle'}
      className="console-keeper"
      meta={engaged ? 'Autopilot engaged' : 'Idle. Keeper is off.'}
    >
      <Dial aprPct={apr} size={170} />
      <div className="keeper-pps-row">
        <span className="tnum keeper-pps-val">{pricePerShare ?? '--'}</span>
        <span className="mono keeper-pps-label">
          Price per share{delta != null ? `, +${delta.toFixed(4)} since last harvest` : ''}
        </span>
      </div>
      {strategies.length === 0 ? (
        <div className="zone-empty">No strategies registered.</div>
      ) : (
        <div className="keeper-strat-list">
          {strategies.map((s) => (
            <div key={s.address} className="con-feed-row">
              <span className="txt">{s.label}</span>
              <span className="meta tnum">
                {s.poolLabel || '--'}, {s.aprPct == null ? '--' : `${s.aprPct.toFixed(2)}%`}
              </span>
            </div>
          ))}
        </div>
      )}
      {last && (
        <div className="con-feed-row">
          <span className="txt">
            {last.kind === 'compound_executed'
              ? `Compounded, +${last.totalGainUsdc} USDC`
              : `Rebalanced, ${last.fromLabel} → ${last.toLabel}, ${last.amountUsdc} USDC`}
          </span>
          <span className="meta">
            {shortHash(last.txHash)}, {agoText(last.timestamp, nowMs)}
          </span>
        </div>
      )}
    </ZoneFrame>
  )
}
