// Shared display helpers for console zones. Pure — time is always a parameter.

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

export function agoText(ts, nowMs) {
  if (!ts) return '-'
  const s = Math.max(0, Math.floor((nowMs - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} hr ago`
}

export function remainText(ms) {
  if (ms <= 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const MANDATE_WINDOW_S = 86_400

/** @returns {{leftS: number, frac: number}} */
export function mandateRemaining(state, nowS) {
  const exp = state?.mandateExpiry || 0
  const leftS = Math.max(0, exp - nowS)
  return { leftS, frac: Math.min(1, leftS / MANDATE_WINDOW_S) }
}
