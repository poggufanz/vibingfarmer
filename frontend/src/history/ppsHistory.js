// ppsHistory.js
// Local price-per-share series for the KeeperZone trailing-APY sparkline (P0 item #2,
// research/defi-gap-analysis-2026-09-12.md §4.2 G2). The app's existing 15s poll records
// each fresh `price_per_share()` read here; this module throttles to one sample per
// SAMPLE_INTERVAL_MS and caps the series (MAX_SAMPLES + MAX_AGE_MS window) so the
// localStorage entry cannot grow without bound.
//
// Shape: [{ t: <ms epoch>, pps: <string base units, 7dp> }] oldest → newest. pps stays a
// string because the series crosses a JSON boundary (localStorage) where bigint dies.
// Derivations (window select, trailing CAGR, display values) are pure: series + now are
// always parameters, never Date.now() — same rule as instruments/geometry.js.
//
// Never throws: corrupt storage, missing localStorage, or a null pps all yield the
// previous series (or []), never a guessed number.

export const PPS_STORAGE_PREFIX = 'vf_pps_history_v1:'
export const PPS_SAMPLE_INTERVAL_MS = 15 * 60 * 1000 // one sample per 15 min
export const PPS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30-day window
export const PPS_MAX_SAMPLES = 2880 // 30d @ 15min cadence — hard cap even if the clock jumps
const PPS_DAY_MS = 24 * 60 * 60 * 1000
const PPS_YEAR_MS = 365 * PPS_DAY_MS
export const PPS_SCALE = 10_000_000 // vault price_per_share fixed-point scale (7dp)

function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage
  } catch {
    // private-mode Safari and friends — fall through to the memory stub
  }
  const mem = new Map()
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  }
}

const storageKey = (vaultAddress) => `${PPS_STORAGE_PREFIX}${String(vaultAddress || '').toUpperCase()}`

function validSample(s) {
  return (
    s != null &&
    Number.isFinite(s.t) &&
    typeof s.pps === 'string' &&
    /^\d+$/.test(s.pps) &&
    BigInt(s.pps) > 0n
  )
}

/**
 * Load the stored PPS series for a vault. [] on any failure (never throws).
 * @param {string} vaultAddress
 * @returns {Array<{t:number,pps:string}>} oldest → newest
 */
export function loadPpsSeries(vaultAddress, { storage = defaultStorage() } = {}) {
  try {
    const raw = storage.getItem(storageKey(vaultAddress))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(validSample)
  } catch {
    return []
  }
}

function persist(key, series, storage) {
  try {
    storage.setItem(key, JSON.stringify(series))
  } catch {
    // quota/full/blocked — the in-memory return value is still correct; next load
    // simply falls back to []. Never let persistence break the poll loop.
  }
}

/**
 * Record one `price_per_share()` read. Throttled (min interval), pruned (max age),
 * capped (max samples) — the stored series cannot grow without bound. Never throws.
 * @param {string} vaultAddress
 * @param {bigint|number|string|null} pps raw price_per_share read (7dp base units)
 * @returns {Array<{t:number,pps:string}>} the new series, oldest → newest
 */
export function recordPpsSample(
  vaultAddress,
  pps,
  {
    storage = defaultStorage(),
    now = () => Date.now(),
    minIntervalMs = PPS_SAMPLE_INTERVAL_MS,
    maxSamples = PPS_MAX_SAMPLES,
    maxAgeMs = PPS_MAX_AGE_MS,
  } = {}
) {
  let series = loadPpsSeries(vaultAddress, { storage })
  let units = null
  try {
    if (pps == null) return series
    units = BigInt(pps)
    if (units <= 0n) return series
  } catch {
    return series
  }
  const t = now()
  if (!Number.isFinite(t)) return series
  const last = series[series.length - 1]
  if (last && t - last.t < minIntervalMs) return series // throttle: poll ticks faster than this
  series = [...series, { t, pps: String(units) }]
  const cutoff = t - maxAgeMs
  series = series.filter((s) => s.t >= cutoff)
  if (series.length > maxSamples) series = series.slice(series.length - maxSamples)
  persist(storageKey(vaultAddress), series, storage)
  return series
}

/**
 * Samples within the trailing window. Pure.
 * @param {Array<{t:number,pps:string}>} series oldest → newest
 */
export function selectPpsWindow(series, { days = 30, now = Date.now() } = {}) {
  if (!Array.isArray(series)) return []
  const cutoff = now - days * PPS_DAY_MS
  return series.filter((s) => s != null && Number.isFinite(s.t) && s.t >= cutoff && s.t <= now)
}

/**
 * Trailing APY (%) as CAGR over the window: (last/first)^(year/span) - 1.
 * null when the window cannot support an honest annualization (< 2 samples, zero span,
 * non-positive prices) — callers render "unavailable", never 0% (0% is a claim).
 * @param {Array<{t:number,pps:string}>} series oldest → newest
 * @returns {number|null}
 */
export function trailingApyPct(series, { days = 30, now = Date.now() } = {}) {
  const win = selectPpsWindow(series, { days, now })
  if (win.length < 2) return null
  const first = win[0]
  const last = win[win.length - 1]
  const spanMs = last.t - first.t
  if (!Number.isFinite(spanMs) || spanMs <= 0) return null
  let firstPps = 0
  let lastPps = 0
  try {
    firstPps = Number(BigInt(first.pps))
    lastPps = Number(BigInt(last.pps))
  } catch {
    return null
  }
  if (!(firstPps > 0) || !(lastPps > 0)) return null
  const ratio = lastPps / firstPps
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null
  const apy = (Math.pow(ratio, PPS_YEAR_MS / spanMs) - 1) * 100
  return Number.isFinite(apy) ? apy : null
}

/**
 * Series → display numbers (1.0234-style) oldest → newest for the sparkline.
 * Non-finite entries are dropped, never coerced.
 */
export function ppsDisplayValues(series) {
  if (!Array.isArray(series)) return []
  const out = []
  for (const s of series) {
    try {
      const v = Number(BigInt(s?.pps)) / PPS_SCALE
      if (Number.isFinite(v)) out.push(v)
    } catch {
      // skip — one bad sample must not kill the whole trace
    }
  }
  return out
}
