// frontend/src/components/console/KeeperZone.jsx
import ZoneFrame from './ZoneFrame.jsx'
import Dial from './instruments/Dial.jsx'
import Sparkline from './instruments/Sparkline.jsx'
import { agoText } from './consoleUtils.js'
import { selectPpsWindow, trailingApyPct, ppsDisplayValues } from '../../history/ppsHistory.js'

// Live Blend supply-APR envelope (produced from readSupplyAprBps: pool `get_reserve`
// + `get_config`; null/unavailable = RPC down, rendered as unavailable, never guessed).
// { state: 'live'|'unavailable', aprPct: number|null, asOf: ms|null }

const fmtTrailing = (v) => (v == null ? 'unavailable' : `${v.toFixed(2)}%`)
const shortHash = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '')

export default function KeeperZone({ events = [], pricePerShare = null, strategies = [], liveApr = null, ppsHistory = [], nowMs }) {
  const engaged = strategies.length > 0 && pricePerShare != null
  const aprs = strategies.map((s) => s.aprPct).filter((a) => Number.isFinite(a))
  const apr = aprs.length ? Math.max(...aprs) : null
  const liveAprPct =
    liveApr?.state === 'live' && Number.isFinite(liveApr.aprPct) ? liveApr.aprPct : null
  const apy7 = trailingApyPct(ppsHistory, { days: 7, now: nowMs })
  const apy30 = trailingApyPct(ppsHistory, { days: 30, now: nowMs })
  const sparkValues = ppsDisplayValues(selectPpsWindow(ppsHistory, { days: 30, now: nowMs }))
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
      {liveApr != null && (
        <div className="keeper-live-apr con-feed-row" role="status">
          {liveAprPct != null ? (
            <>
              <span className="txt">Live supply APY {liveAprPct.toFixed(2)}%</span>
              <span className="meta">updated {agoText(liveApr.asOf, nowMs)}</span>
            </>
          ) : (
            <span className="txt">Live APY unavailable</span>
          )}
        </div>
      )}
      <div className="keeper-pps-history">
        <Sparkline values={sparkValues} label="Price per share" />
        <span className="mono keeper-trailing" role="status">
          Trailing APY — 7d: {fmtTrailing(apy7)}, 30d: {fmtTrailing(apy30)}
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
              : `Rebalanced, ${last.fromLabel} to ${last.toLabel}, ${last.amountUsdc} USDC`}
          </span>
          <span className="meta">
            {shortHash(last.txHash)}, {agoText(last.timestamp, nowMs)}
          </span>
        </div>
      )}
    </ZoneFrame>
  )
}
