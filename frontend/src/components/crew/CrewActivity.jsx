// frontend/src/components/crew/CrewActivity.jsx
// Task 9 (Pocket Crew design alignment). Two stacked, read-only feeds: the keeper's own
// compound/rebalance history, and the crew's decision log (Task 8's selectCrewDecisions.js).
//
// Keeper row field mapping is mirrored from the RETIRED `components/console/KeeperZone.jsx`
// (reference only -- nothing is imported from `components/console/*`, D-28.3), and verified
// against the real producer in app.jsx:1104-1133: each `keeperEvents` row is
// `{id, kind:'compound_executed'|'rebalance_executed', totalGainUsdc?, pricePerShare?, fromLabel?,
// toLabel?, amountUsdc?, txHash, timestamp}`. `keeper` (classifyKeeperAutomation's output) is a
// SEPARATE prop (CrewRoute's stat strip) -- this component never reads it.
//
// Decision rows are rendered generically over whatever selectCrewDecisions.js returns
// ({id, tone, title, detail, time}) -- which production events map into that log is still under
// review (Task 8's own header comment), so nothing here assumes a specific event name is present.
function shortHash(hash) {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : ''
}

// Small local equivalent of the retired console/consoleUtils.js's agoText -- redeclared here
// rather than imported (that module lives under the retired components/console/* tree).
function agoText(timestamp, now) {
  if (!Number.isFinite(timestamp)) return ''
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} hr ago`
}

function keeperRowText(event) {
  if (event.kind === 'compound_executed') return `Compounded, +${event.totalGainUsdc} USDC`
  if (event.kind === 'rebalance_executed')
    return `Rebalanced, ${event.fromLabel} → ${event.toLabel}, ${event.amountUsdc} USDC`
  return 'Keeper activity'
}

export function CrewActivity({ keeperEvents = [], decisions = [] }) {
  const now = Date.now()
  return (
    <div className="pc-crew-activity">
      <section aria-labelledby="crew-keeper-activity-heading">
        <h2 id="crew-keeper-activity-heading" className="pc-crew-stat-label">
          Keeper activity
        </h2>
        {keeperEvents.length === 0 ? (
          <p className="pc-crew-empty-note">No keeper activity yet on this device.</p>
        ) : (
          <ul className="pc-crew-keeper-list">
            {keeperEvents.map((event) => (
              <li key={event.id} className="pc-crew-keeper-row">
                <span>{keeperRowText(event)}</span>
                <span className="pc-crew-keeper-time">
                  {shortHash(event.txHash)}
                  {event.txHash ? ', ' : ''}
                  {agoText(event.timestamp, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="crew-decision-log-heading">
        <h2 id="crew-decision-log-heading" className="pc-crew-stat-label">
          Every decision, written down
        </h2>
        {decisions.length === 0 ? (
          <p className="pc-crew-empty-note">No decisions logged yet.</p>
        ) : (
          <ul className="pc-crew-decision-list">
            {decisions.map((row) => (
              <li key={row.id} className="pc-crew-decision-row" data-tone={row.tone}>
                <span className="pc-crew-decision-dot" aria-hidden="true" />
                <div>
                  <p className="pc-crew-decision-title">{row.title}</p>
                  {row.detail && <p className="pc-crew-decision-detail">{row.detail}</p>}
                </div>
                <span className="pc-crew-decision-time">{row.time}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
