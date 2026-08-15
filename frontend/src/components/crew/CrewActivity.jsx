// frontend/src/components/crew/CrewActivity.jsx
// Read-only keeper and decision projections for Pocket Crew. The component consumes the
// already-decoded keeperEvents and selectCrewDecisions output; it never records activity or
// invents a missing ledger event.
import { useEffect, useRef, useState } from 'react'

function textValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function canonicalDecimal(value) {
  if (typeof value !== 'string' || value.trim() !== value) return null
  return /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) ? value : null
}

function canonicalHash(value) {
  if (typeof value !== 'string' || value.trim() !== value) return ''
  return /^(?:0x)?[A-Fa-f0-9]{16,128}$/.test(value) ? value : ''
}

function shortHash(hash) {
  const value = textValue(hash)
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : ''
}

function closedAtMs(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function keeperRowText(event) {
  if (event.kind === 'compound_executed') {
    return `Compounded, +${event.totalGainUsdc} USDC`
  }

  if (event.kind === 'rebalance_executed') {
    return `Rebalanced, ${event.fromLabel} to ${event.toLabel}, ${event.amountUsdc} USDC`
  }

  return ''
}

function normalizeKeeperEvents(events) {
  if (!Array.isArray(events)) return []
  return events
    .map((event) => {
      if (
        !event ||
        typeof event !== 'object' ||
        (typeof event.id !== 'string' && typeof event.id !== 'number')
      ) {
        return null
      }
      const id = String(event.id)
      const txHash = canonicalHash(event.txHash)
      const closedAt = closedAtMs(event.closedAt)
      if (!txHash || closedAt == null) return null
      if (event.kind === 'compound_executed') {
        const totalGainUsdc = canonicalDecimal(event.totalGainUsdc)
        return totalGainUsdc
          ? { id, kind: event.kind, totalGainUsdc, txHash, closedAt: event.closedAt }
          : null
      }
      if (event.kind === 'rebalance_executed') {
        const amountUsdc = canonicalDecimal(event.amountUsdc)
        const fromLabel = textValue(event.fromLabel)
        const toLabel = textValue(event.toLabel)
        return amountUsdc && fromLabel && toLabel
          ? {
              id,
              kind: event.kind,
              amountUsdc,
              fromLabel,
              toLabel,
              txHash,
              closedAt: event.closedAt,
            }
          : null
      }
      return null
    })
    .filter(Boolean)
}

function normalizeDecisions(decisions) {
  if (!Array.isArray(decisions)) return []
  return decisions
    .filter(
      (row) =>
        row && typeof row === 'object' && (typeof row.id === 'string' || typeof row.id === 'number')
    )
    .map((row) => {
      const title = textValue(row.title)
      const time = textValue(row.time)
      const tone = ['kept', 'watch', 'rejected'].includes(row.tone) ? row.tone : 'unknown'
      // A fully incomplete selector row remains visible as an honest neutral placeholder. A
      // titled row without its technical time is not source-complete, so it is omitted instead
      // of implying that the decision was actually logged.
      if (!title && !time) {
        return { id: String(row.id), tone, title: 'Decision unavailable', detail: '', time: '' }
      }
      if (!time) return null
      return {
        id: String(row.id),
        tone,
        title: title || 'Decision unavailable',
        detail: textValue(row.detail),
        time,
      }
    })
    .filter(Boolean)
}

function evidenceTime(value) {
  const closed = closedAtMs(value)
  return closed == null ? '' : new Date(closed).toISOString()
}

export function CrewActivity({ keeperEvents = [], decisions = [] }) {
  const keeperRows = normalizeKeeperEvents(keeperEvents)
  const decisionRows = normalizeDecisions(decisions)
  const seenIdsRef = useRef(null)
  const [liveStatus, setLiveStatus] = useState('')

  useEffect(() => {
    const currentKeeperIds = new Set(keeperRows.map((event) => event.id))
    const currentDecisionIds = new Set(
      decisionRows.filter((row) => row.time !== '').map((row) => row.id)
    )
    const previousIds = seenIdsRef.current
    if (previousIds) {
      const addedKeeper = [...currentKeeperIds].filter((id) => !previousIds.keepers.has(id)).length
      const addedDecisions = [...currentDecisionIds].filter(
        (id) => !previousIds.decisions.has(id)
      ).length
      const messages = []
      if (addedKeeper > 0) {
        messages.push(
          `${addedKeeper} new keeper activity ${addedKeeper === 1 ? 'item' : 'items'} logged.`
        )
      }
      if (addedDecisions > 0) {
        messages.push(
          `${addedDecisions} new decision ${addedDecisions === 1 ? 'item' : 'items'} logged.`
        )
      }
      if (messages.length) setLiveStatus(messages.join(' '))
    }
    seenIdsRef.current = { keepers: currentKeeperIds, decisions: currentDecisionIds }
  }, [keeperRows, decisionRows])

  return (
    <div className="pc-crew-activity">
      {liveStatus ? (
        <p className="pc-crew-activity-live" role="status" aria-live="polite">
          {liveStatus}
        </p>
      ) : null}

      <section aria-labelledby="crew-keeper-activity-heading">
        <h2 id="crew-keeper-activity-heading" className="pc-crew-stat-label">
          Keeper activity
        </h2>
        {keeperRows.length === 0 ? (
          <p className="pc-crew-empty-note">No keeper activity yet on this device.</p>
        ) : (
          <ul className="pc-crew-keeper-list">
            {keeperRows.map((event) => {
              const hash = shortHash(event.txHash)
              const closed = evidenceTime(event.closedAt)
              return (
                <li key={event.id} className="pc-crew-keeper-row">
                  <span>{keeperRowText(event)}</span>
                  <span className="pc-crew-keeper-time">
                    {hash ? <span>{hash}</span> : null}
                    {closed ? (
                      <span>
                        <span>Ledger closed </span>
                        <span>{closed}</span>
                      </span>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="crew-decision-log-heading">
        <h2 id="crew-decision-log-heading" className="pc-crew-stat-label">
          Decisions we logged
        </h2>
        {decisionRows.length === 0 ? (
          <p className="pc-crew-empty-note">No decisions logged yet.</p>
        ) : (
          <ul className="pc-crew-decision-list">
            {decisionRows.map((row) => (
              <li key={row.id} className="pc-crew-decision-row" data-tone={row.tone}>
                <span className="pc-crew-decision-dot" aria-hidden="true" />
                <div>
                  <p className="pc-crew-decision-title">{row.title}</p>
                  {row.detail ? <p className="pc-crew-decision-detail">{row.detail}</p> : null}
                </div>
                <span className="pc-crew-decision-tone">
                  {row.tone === 'kept'
                    ? 'Kept'
                    : row.tone === 'watch'
                      ? 'Watch'
                      : row.tone === 'rejected'
                        ? 'Rejected'
                        : 'Status unavailable'}
                </span>
                {row.time ? <span className="pc-crew-decision-time">{row.time}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
