// frontend/src/components/console/LifeboatZone.jsx
// Emergency status board + de-risk radar. Copy rule (from old panel): reaction speed is
// "~1 ledger (~6s)" — the word "millisecond" is banned. Single-escalation: ENGAGED flips
// this zone + the strip chip, nothing else.
import ZoneFrame from './ZoneFrame.jsx'
import Radar from './instruments/Radar.jsx'
import { mandateRemaining, remainText, shortAddr } from './consoleUtils.js'
import { REASON_LABELS, panelState } from '../../stellar/lifeboat.js'

const MODE_COPY = {
  ARMED: 'Reaction radar is live. Response time is about one ledger (~6s).',
  ENGAGED: 'Funds are parked safely in the vault.',
  DISARMED: 'The mandate expired. Lifeboat cannot act.',
}
const shortHash = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '')

export default function LifeboatZone({
  state = null,
  events = [],
  owner = null,
  onGrant,
  busy = false,
  nowMs,
}) {
  const nowS = Math.floor(nowMs / 1000)
  const mode = state ? panelState({ ...state, nowS }) : null
  const { leftS, frac } = mandateRemaining(state, nowS)
  const recentDerisks = events.filter((e) => e.type === 'derisk')
  const led = mode === 'ENGAGED' ? 'danger' : mode === 'ARMED' ? 'ok' : 'idle'

  return (
    <ZoneFrame
      title="Lifeboat"
      hue={mode === 'ENGAGED' ? 'danger' : 'ok'}
      led={led}
      className={`console-lifeboat${mode === 'ENGAGED' ? ' lifeboat-engaged' : ''}`}
      meta={state?.authority ? `Authority ${shortAddr(state.authority)}` : null}
    >
      <div className="lifeboat-grid" data-escalated={mode === 'ENGAGED' ? '1' : '0'}>
        <div className="lifeboat-radar">
          <Radar events={events} armed={mode === 'ARMED'} nowMs={nowMs} size={170} />
          <div className="instrument-caption">Threats: {recentDerisks.length} in 24h</div>
        </div>
        <div className="lifeboat-board">
          <span className="lifeboat-mode tnum" data-mode={mode || ''}>
            {mode ?? '--'}
          </span>
          <span className="mono lifeboat-copy">
            {mode ? MODE_COPY[mode] : 'Lifeboat state is unavailable.'}
          </span>
          <div className="lifeboat-mandate">
            <div className="lifeboat-mandate-bar">
              <div className="lifeboat-mandate-fill" style={{ transform: `scaleX(${frac})` }} />
            </div>
            <span className="mono lifeboat-mandate-text tnum">
              Mandate: {leftS > 0 ? `${remainText(leftS * 1000)} left` : 'Not granted'}
            </span>
          </div>
          <button
            className="btn btn-ghost pos-cta"
            onClick={onGrant}
            disabled={busy || !owner}
            aria-label="Renew 24-hour mandate"
          >
            {busy ? 'Signing...' : 'Renew 24-hour mandate'}
          </button>
        </div>
      </div>
      {mode === 'ENGAGED' && (
        <div className="lifeboat-runbook">
          <div className="zone-title mono">Runbook</div>
          {events
            .filter((e) => e.type === 'derisk' || e.type === 'resume')
            .slice(0, 5)
            .map((ev, i) => (
              <div className="con-feed-row" key={`${ev.txHash}-${i}`}>
                <span className="txt">
                  {ev.type === 'derisk'
                    ? `Lifeboat engaged: ${REASON_LABELS[ev.reasonCode] ?? `Reason ${ev.reasonCode}`}`
                    : 'Resumed. Funds are re-entering during compounding.'}
                </span>
                <span className="meta">{shortHash(ev.txHash)}</span>
              </div>
            ))}
        </div>
      )}
      {mode !== 'ENGAGED' && events.length > 0 && (
        <div className="lifeboat-runbook">
          {events.slice(0, 3).map((ev, i) => (
            <div className="con-feed-row" key={`${ev.txHash}-${i}`}>
              <span className="txt">
                {ev.type === 'derisk'
                  ? `Lifeboat engaged: ${REASON_LABELS[ev.reasonCode] ?? `Reason ${ev.reasonCode}`}`
                  : ev.type === 'resume'
                    ? 'Resumed. Funds are re-entering during compounding.'
                    : 'Mandate updated.'}
              </span>
              <span className="meta">{shortHash(ev.txHash)}</span>
            </div>
          ))}
        </div>
      )}
    </ZoneFrame>
  )
}
