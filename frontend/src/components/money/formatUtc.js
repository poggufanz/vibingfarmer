// frontend/src/components/money/formatUtc.js
// Deterministic human UTC timestamp for FRIENDLY money surfaces ("Last checked", "Expires",
// "Mandate expiry", "Last keeper heartbeat"). The components here previously rendered raw
// `Date#toISOString()` output ("2027-01-15T08:15:00.000Z") -- technically correct, but it reads
// like debug output to a first-time money user. This renders "15 Jan 2027, 08:15 UTC" instead:
// same unambiguous instant, no milliseconds, an explicit zone label.
//
// Deliberately NOT Intl.DateTimeFormat: PlanStage.jsx's own header documents why -- Intl output
// varies with the runtime's locale/timezone, which makes component tests and the visual harness
// non-deterministic across machines (the e2e config pins locale+TZ for exactly this hazard).
// Fixed English month abbreviations + UTC getters keep every render identical everywhere.
//
// Local to the money route's components (same sharing boundary as my-money.css); strategy
// surfaces keep their own established formatters.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatUtcDate(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`
}

/** @param {number} checkedAtMs epoch milliseconds; non-finite -> 'Unavailable' (never a guess) */
export function formatUtcMs(checkedAtMs) {
  return Number.isFinite(checkedAtMs) ? formatUtcDate(new Date(checkedAtMs)) : 'Unavailable'
}

/** @param {number} epochSeconds epoch seconds; non-finite/<=0 -> 'Unavailable' */
export function formatUtcSeconds(epochSeconds) {
  return Number.isFinite(epochSeconds) && epochSeconds > 0
    ? formatUtcDate(new Date(epochSeconds * 1000))
    : 'Unavailable'
}
