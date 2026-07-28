// frontend/src/components/crew/CrewGuard.jsx
// Task 9 (Pocket Crew design alignment). The emergency guard card: ARMED with a live countdown
// while `model.protection.mandateExpiry` (unix SECONDS -- confirmed against
// myMoneyModel.js:36-38/121 and resolveProtection's own `nowS = Math.floor(now / 1000)`) is still
// in the future, ALARM ONLY once it has lapsed. Local UI clock tick only (allowed: "Local UI
// timers (clock ticks) are allowed" -- no app state owned here).
//
// Fix round 1, F3: `protection.state` (ProtectionSnapshot: 'engaged'|'armed'|'disarmed'|
// 'unavailable', myMoneyModel.js:36) is now checked FIRST, before the live countdown math --
// a failed read (`state:'unavailable'`, `mandateExpiry:null`) used to coerce to `(null ?? 0) *
// 1000 = 0`, which rendered a confident "ALARM ONLY / Permission expired" safety claim out of
// pure absence. Mirrors Primitives.jsx's own MoneyFigure rule: "a missing/non-numeric value...
// is never silently displayed as 0; it is truthfully unknown instead." `state:'disarmed'` is
// likewise forced OFF regardless of any stale `mandateExpiry` it might still carry -- an owner-
// or system-disarmed mandate must never read as ARMED just because its old expiry timestamp
// happens to still be in the future.
import { useEffect, useState } from 'react'

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

const GUARD_COPY = Object.freeze({
  unknown: {
    state: 'STATUS UNKNOWN',
    line: "We can't confirm the emergency guard's state right now -- it may still be armed, this device just has no evidence of it.",
  },
  armed: {
    state: 'ARMED',
    line: 'Watches the pool continuously. If it turns dangerous it can pull everything to safety without waking you.',
  },
  lapsed: {
    state: 'ALARM ONLY',
    line: 'Permission expired. It will still watch and shout, but it will not move your money.',
  },
})

export function CrewGuard({ protection = null, onRenew, pending = false }) {
  // Number arithmetic throughout (never fed into BigInt) -- mandateExpiry is a real unix-seconds
  // integer off-chain evidence, not user input, so `* 1000` here never enters the
  // BigInt(Math.round(x*N)) overflow zone the rest of this plan has hit three times.
  const expiryMs = (protection?.mandateExpiry ?? 0) * 1000
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const remaining = (expiryMs - now) / 1000

  // `state` governs first: no evidence at all is a THIRD, honest phase (never ARMED, never the
  // confident "expired" safety claim); a confirmed-disarmed mandate is forced off regardless of
  // what its own (possibly stale) mandateExpiry number says. Only a real 'armed'/'engaged' state
  // falls through to the live countdown, which is what lets the ARMED phase decay to ALARM ONLY
  // client-side the instant the ticking clock crosses zero (both existing tests key off exactly
  // this: state:'armed' with a lapsed mandateExpiry must still show ALARM ONLY).
  const hasState = Boolean(protection?.state) && protection.state !== 'unavailable'
  const phase = !hasState
    ? 'unknown'
    : protection.state === 'disarmed'
      ? 'lapsed'
      : remaining > 0
        ? 'armed'
        : 'lapsed'
  const copy = GUARD_COPY[phase]

  return (
    <section
      className="pc-crew-guard"
      data-guard-phase={phase}
      aria-labelledby="crew-guard-heading"
    >
      <div className="pc-crew-guard-head">
        <h2 id="crew-guard-heading" className="pc-crew-stat-label">
          Emergency guard
        </h2>
        <span className="pc-crew-guard-state">{copy.state}</span>
      </div>
      <div className="pc-crew-radar" aria-hidden="true">
        <span className="pc-crew-radar-ring" />
        <span className="pc-crew-radar-ring pc-crew-radar-ring--inner" />
        <span className="pc-crew-radar-sweep" />
        <span className="pc-crew-radar-core" />
      </div>
      <p className="pc-crew-guard-line">{copy.line}</p>
      <p className="pc-crew-guard-clock">
        {phase === 'unknown' ? 'Unavailable' : formatClock(remaining)}
      </p>
      <button
        type="button"
        className="pc-button pc-button--primary pc-crew-guard-renew"
        onClick={onRenew}
        disabled={pending}
      >
        Renew for 24 hours
      </button>
    </section>
  )
}
