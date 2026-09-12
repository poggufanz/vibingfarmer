// frontend/src/components/strategy/PoolSafetyPanel.jsx
// P0 G3 pool-safety panel (Blend checklist: docs.blend.capital/users/choosing-pools.md).
// Mounted on the Protect review screen, right after the "background check" section: the same
// gate evidence the app already used to admit the venue, now SHOWN with per-row source +
// freshness instead of living only behind the PASSED badge.
//
// Data never blocks the review: the first paint is snapshot-only (initialPoolSafetyView is
// sync and zero-I/O, so mounting performs no fetch), and the "Refresh live figures" button
// is an explicit read-only refresh (live utilization + any newly primed TVL overlay).
// Every fetch failure degrades row-by-row to "Unavailable" — the panel always renders.
import { useState } from 'react'
import { POOL_SAFETY_LABEL, initialPoolSafetyView, loadPoolSafety } from '../../strategy/poolSafety.js'

/** YYYY-MM-DD UTC; null when the timestamp is not a finite number (the row omits it). */
function formatAsOf(asOf) {
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) return null
  const date = new Date(asOf)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

/**
 * Pure presentational panel. `safety` is buildPoolSafetyView's output
 * ({ poolLabel, rows: [{ id, label, value|null, source, asOf|null, note|null }] }).
 */
export function PoolSafetyPanel({ safety }) {
  if (!safety || !Array.isArray(safety.rows)) return null
  return (
    <section className="pc-pool-safety" aria-labelledby="pool-safety-heading">
      <h2 id="pool-safety-heading" className="pc-aside-title">
        Pool safety · {safety.poolLabel}
      </h2>
      <p className="pc-section-sub">
        What the background check verified, and where each figure came from. Anything that cannot
        be verified shows as unavailable — never a guess.
      </p>
      <dl className="pc-pool-safety-list">
        {safety.rows.map((row) => {
          const asOf = formatAsOf(row.asOf)
          return (
            <div key={row.id} className="pc-pool-safety-row">
              <dt>{row.label}</dt>
              <dd>
                {row.value ?? 'Unavailable'}
                <span className="pc-pool-safety-source">
                  {' '}
                  · {row.source}
                  {asOf ? ` · as of ${asOf}` : ''}
                </span>
                {row.note ? <span className="pc-pool-safety-note"> — {row.note}</span> : null}
              </dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}

/**
 * Stateful mount: snapshot first paint, explicit read-only refresh. `loadSafety` is injectable
 * (tests never touch the network); every failure keeps the current rows.
 */
export function PoolSafetySection({ protocol, poolLabel = POOL_SAFETY_LABEL, loadSafety = loadPoolSafety }) {
  const [safety, setSafety] = useState(() =>
    initialPoolSafetyView({ ...(protocol ? { protocol } : {}), poolLabel })
  )
  const [pending, setPending] = useState(false)

  const refresh = async () => {
    if (pending) return
    setPending(true)
    try {
      const next = await loadSafety({ ...(protocol ? { protocol } : {}), poolLabel })
      if (next && Array.isArray(next.rows)) setSafety(next)
    } catch {
      // Fail-soft: keep the snapshot rows already on screen.
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="pc-pool-safety-wrap">
      <PoolSafetyPanel safety={safety} />
      <button
        type="button"
        className="pc-button pc-button--secondary"
        disabled={pending}
        onClick={refresh}
      >
        {pending ? 'Refreshing…' : 'Refresh live figures'}
      </button>
    </div>
  )
}
