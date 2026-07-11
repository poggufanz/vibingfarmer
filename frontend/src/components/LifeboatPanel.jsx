/* ============================================
   VIBING FARMER — Lifeboat Panel
   Presentational only — every value arrives via props from app.jsx (readLifeboatState poll +
   keeper-event feed). Mirrors KeeperPanel's Acid Yield conventions: dark surface, mono metadata
   rows, one signature state badge. Never shows a fake state: a failed read renders "--".
   Copy rule: "reaction radar — ~1 ledger (~6 s)". The word "millisecond" is banned.
   ============================================ */
import { REASON_LABELS, panelState } from '../stellar/lifeboat.js'

// No leading "ARMED — " prefix here: the figure span above already renders the mode word
// verbatim, and testing-library's getByText(/ARMED/) etc. must resolve to exactly one node.
const BADGE_COPY = {
  ARMED: 'Reaction radar live, ~1 ledger (~6s) response',
  ENGAGED: 'Funds parked idle in the vault, safe',
  DISARMED: 'Mandate expired, lifeboat cannot act',
}

const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '')

function countdown(mandateExpiry, nowS) {
  const left = Math.max(0, mandateExpiry - nowS)
  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  return `${h}h ${m}m`
}

const EventRow = ({ ev }) => {
  if (ev.type === 'derisk') {
    return (
      <div className="keeper-action-row">
        <span className="keeper-action-dot" style={{ color: 'var(--warn)' }} aria-hidden="true">
          !
        </span>
        <span className="keeper-action-text">
          Lifeboat engaged · {REASON_LABELS[ev.reasonCode] ?? `Reason ${ev.reasonCode}`}
        </span>
        <span className="keeper-action-meta mono">{short(ev.txHash)}</span>
      </div>
    )
  }
  if (ev.type === 'resume') {
    return (
      <div className="keeper-action-row">
        <span className="keeper-action-dot" style={{ color: 'var(--ok)' }} aria-hidden="true">
          ✓
        </span>
        <span className="keeper-action-text">Resumed · funds re-entering via compound</span>
        <span className="keeper-action-meta mono">{short(ev.txHash)}</span>
      </div>
    )
  }
  return (
    <div className="keeper-action-row">
      <span className="keeper-action-dot" style={{ color: 'var(--info)' }} aria-hidden="true">
        ✎
      </span>
      <span className="keeper-action-text">Mandate updated</span>
      <span className="keeper-action-meta mono">{short(ev.txHash)}</span>
    </div>
  )
}

/**
 * @param {object} p
 * @param {{derisked: boolean, mandateExpiry: number, authority: string|null}|null} p.state
 *   null = read failed → "--", never a guessed state
 * @param {Array} [p.events] lifeboat events, newest first (decodeKeeperEvent derisk/resume/mandate)
 * @param {string|null} p.owner connected wallet G-address (grant disabled without one)
 * @param {() => void} p.onGrant grant/renew handler (app.jsx owns the tx)
 * @param {boolean} [p.busy] grant tx in flight
 */
const LifeboatPanel = ({ state = null, events = [], owner = null, onGrant, busy = false }) => {
  const nowS = Math.floor(Date.now() / 1000)
  const mode = state ? panelState({ ...state, nowS }) : null

  return (
    <section className="keeper-panel enter">
      <div className="keeper-pps">
        <span className="figure figure-md tnum">{mode ?? '--'}</span>
        <span className="label mono">{mode ? BADGE_COPY[mode] : 'Lifeboat state unavailable'}</span>
      </div>

      <div className="keeper-section">
        <div className="keeper-section-label mono">Mandate</div>
        {state && mode !== 'ENGAGED' && (
          <div className="keeper-action-row">
            <span className="keeper-action-text">
              {state.mandateExpiry > nowS
                ? `Expires in ${countdown(state.mandateExpiry, nowS)}`
                : 'Not granted'}
            </span>
          </div>
        )}
        <button
          className="mono"
          onClick={onGrant}
          disabled={busy || !owner}
          aria-label="renew 24h mandate"
        >
          {busy ? 'Signing…' : 'Renew 24h mandate'}
        </button>
      </div>

      <div className="keeper-section">
        <div className="keeper-section-label mono">Lifeboat activity</div>
        {events.length === 0 ? (
          <div className="keeper-empty mono">No lifeboat events yet</div>
        ) : (
          events.slice(0, 5).map((ev, i) => <EventRow key={`${ev.txHash}-${i}`} ev={ev} />)
        )}
      </div>
    </section>
  )
}

export default LifeboatPanel
