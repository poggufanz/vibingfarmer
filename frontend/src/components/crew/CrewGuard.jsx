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

// Radar geometry (SVG user units, 160 box). Pure decoration over facts stated in text beside it:
// hour ticks, the mandate's remaining share of a 24 hour window (the renew action grants 24h), and
// one blip per crew account whose money sits in the guarded vault, placed on a golden-angle spiral
// so the picture is stable between renders.
const R = 80
const DAY_S = 24 * 3600
const ARC_R = 74
const ARC_LENGTH = 2 * Math.PI * ARC_R
const MAX_BLIPS = 12
const TICKS = Array.from({ length: 24 }, (_, hour) => {
  const angle = (hour / 24) * 2 * Math.PI
  const inner = hour % 6 === 0 ? 66 : 70
  return {
    x1: R + inner * Math.sin(angle),
    y1: R - inner * Math.cos(angle),
    x2: R + 77 * Math.sin(angle),
    y2: R - 77 * Math.cos(angle),
    major: hour % 6 === 0,
  }
})

function blipPoints(count) {
  return Array.from({ length: Math.min(count, MAX_BLIPS) }, (_, index) => {
    const angle = ((index * 137.5 + 32) * Math.PI) / 180
    const radius = 22 + ((index * 17) % 38)
    return { x: R + radius * Math.sin(angle), y: R - radius * Math.cos(angle) }
  })
}

function RadarScope({ phase, remaining, vaultAccounts }) {
  const fraction = phase === 'armed' ? Math.min(1, Math.max(0, remaining / DAY_S)) : 0
  const blips = Number.isSafeInteger(vaultAccounts) ? blipPoints(vaultAccounts) : []
  return (
    <svg className="pc-crew-radar-scope" viewBox="0 0 160 160" focusable="false">
      <circle className="pc-crew-radar-arc-track" cx={R} cy={R} r={ARC_R} />
      {fraction > 0 ? (
        <circle
          className="pc-crew-radar-arc"
          cx={R}
          cy={R}
          r={ARC_R}
          strokeDasharray={`${fraction * ARC_LENGTH} ${ARC_LENGTH}`}
          transform={`rotate(-90 ${R} ${R})`}
        />
      ) : null}
      {TICKS.map((tick, hour) => (
        <line
          key={hour}
          className="pc-crew-radar-tick"
          data-major={tick.major ? 'true' : undefined}
          x1={tick.x1}
          y1={tick.y1}
          x2={tick.x2}
          y2={tick.y2}
        />
      ))}
      {blips.map((blip, index) => (
        <circle key={index} className="pc-crew-radar-blip" cx={blip.x} cy={blip.y} r="3.2" />
      ))}
    </svg>
  )
}

export function CrewGuard({ protection = null, onRenew, pending = false, nowMs, vaultAccounts }) {
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
        <h2 id="crew-guard-heading" className="pc-crew-panel-title">
          Emergency guard
        </h2>
        <span className="pc-crew-guard-state">{copy.state}</span>
      </div>
      <div className="pc-crew-guard-instrument">
        <div className="pc-crew-radar" aria-hidden="true">
          <RadarScope phase={phase} remaining={remaining} vaultAccounts={vaultAccounts} />
          <span className="pc-crew-radar-ring" />
          <span className="pc-crew-radar-ring pc-crew-radar-ring--inner" />
          <span
            className={`pc-crew-radar-sweep${sweepActive ? ' pc-crew-radar-sweep--active' : ''}`}
          >
            <svg viewBox="0 0 160 160" focusable="false">
              <path className="pc-crew-radar-wedge" d="M80 80 L32.43 23.31 A74 74 0 0 1 80 6 Z" />
              <line className="pc-crew-radar-beam" x1="80" y1="80" x2="80" y2="6" />
            </svg>
          </span>
          <span className="pc-crew-radar-core" />
        </div>
        <dl className="pc-crew-guard-readouts">
          <div>
            <dt>Time left</dt>
            <dd className="pc-crew-guard-clock">
              {phase === 'unknown' || phase === 'engaged' ? 'Unavailable' : formatClock(remaining)}
            </dd>
          </div>
          {Number.isSafeInteger(vaultAccounts) ? (
            <div>
              <dt>Accounts covered</dt>
              <dd>{vaultAccounts}</dd>
            </div>
          ) : null}
          <div>
            <dt>Scope</dt>
            <dd className="pc-crew-guard-scope">Vault-wide</dd>
          </div>
        </dl>
      </div>
      <p className="pc-crew-guard-line">{copy.line}</p>
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
          {authority ? (
            <span className="pc-crew-guard-authority">Authority: {authority}</span>
          ) : null}
        </p>
      )}
    </section>
  )
}
