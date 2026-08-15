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
//
// Final-review fix, F1: the lifeboat mandate is a SINGLE vault-wide mandate -- only the
// vault's configured authority can renew it (VaultProtection.jsx:12-18's own doc comment;
// myMoneyModel.js:337-343's `choosePrimaryMoneyAction` rule 4 gates the identical action on
// `protection.ownerIsAuthority`). This card used to render "Renew for 24 hours" unconditionally
// for every visitor, which for a non-authority owner (the common case) prompts a real wallet
// signature for a `set_mandate` call the vault will reject -- and `app.jsx`'s `onGrantMandate`
// swallows that failure into `console.error` with no user-visible error, so the user sees a
// spinner then nothing. The button now renders ONLY when `protection.ownerIsAuthority === true`;
// every other visitor sees VaultProtection.jsx:77-82's own honest alternative line instead. The
// copy below also no longer frames the mandate as personal ("your money") -- it is vault-wide,
// same as VaultProtection.jsx:9-10 already insists on.
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
    line: "We can't confirm the emergency guard's state right now. It may still be armed, but this device has no evidence of it.",
  },
  armed: {
    state: 'ARMED',
    line: 'Watches the vault continuously. If it turns dangerous, the vault-wide mandate can de-risk it without waking you.',
  },
  lapsed: {
    state: 'ALARM ONLY',
    line: 'Permission expired. It will still watch and shout, but it can no longer move the vault.',
  },
  engaged: {
    state: 'ALARM ONLY',
    line: 'The vault is de-risked. The guard remains watch-only until a live mandate is confirmed.',
  },
})

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function CrewGuard({ protection = null, onRenew, pending = false, nowMs }) {
  // Number arithmetic throughout (never fed into BigInt) -- mandateExpiry is a real unix-seconds
  // integer off-chain evidence, not user input, so `* 1000` here never enters the
  // BigInt(Math.round(x*N)) overflow zone the rest of this plan has hit three times.
  const expiryMs =
    typeof protection?.mandateExpiry === 'number' &&
    Number.isInteger(protection.mandateExpiry) &&
    Number.isFinite(protection.mandateExpiry) &&
    protection.mandateExpiry > 0
      ? protection.mandateExpiry * 1000
      : null
  const [clockNowMs, setClockNowMs] = useState(() => (Number.isFinite(nowMs) ? nowMs : Date.now()))
  useEffect(() => {
    if (Number.isFinite(nowMs)) {
      setClockNowMs(nowMs)
      return undefined
    }
    const id = setInterval(() => setClockNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [nowMs])
  const now = Number.isFinite(nowMs) ? nowMs : clockNowMs
  const remaining = expiryMs == null ? 0 : (expiryMs - now) / 1000

  // `state` governs first: no evidence at all is a THIRD, honest phase (never ARMED, never the
  // confident "expired" safety claim); a confirmed-disarmed mandate is forced off regardless of
  // what its own (possibly stale) mandateExpiry number says. Only a real 'armed'/'engaged' state
  // falls through to the live countdown, which is what lets the ARMED phase decay to ALARM ONLY
  // client-side the instant the ticking clock crosses zero (both existing tests key off exactly
  // this: state:'armed' with a lapsed mandateExpiry must still show ALARM ONLY).
  const phase =
    protection?.state === 'armed'
      ? expiryMs == null
        ? 'unknown'
        : remaining > 0
          ? 'armed'
          : 'lapsed'
      : protection?.state === 'disarmed' || protection?.state === 'expired'
        ? 'lapsed'
        : protection?.state === 'engaged'
          ? 'engaged'
          : 'unknown'
  const copy = GUARD_COPY[phase]
  const canRenew = phase === 'armed' && protection?.ownerIsAuthority === true
  const reducedMotion = prefersReducedMotion()
  const sweepActive = phase === 'armed' && !reducedMotion
  const authority = typeof protection?.authority === 'string' ? protection.authority : null

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
        <span
          className={`pc-crew-radar-sweep${sweepActive ? ' pc-crew-radar-sweep--active' : ''}`}
        />
        <span className="pc-crew-radar-core" />
      </div>
      <p className="pc-crew-guard-line">{copy.line}</p>
      <p className="pc-crew-guard-scope">Scope: vault-wide</p>
      <p className="pc-crew-guard-clock">
        {phase === 'unknown' || phase === 'engaged' ? 'Unavailable' : formatClock(remaining)}
      </p>
      {canRenew ? (
        <button
          type="button"
          className="pc-button pc-button--primary pc-crew-guard-renew"
          onClick={onRenew}
          disabled={pending}
        >
          Renew for 24 hours
        </button>
      ) : (
        <p className="pc-crew-guard-renew-note">
          Only the configured authority can renew this.
          {authority ? ` Authority: ${authority}` : ''}
        </p>
      )}
    </section>
  )
}
