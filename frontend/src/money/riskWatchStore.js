// frontend/src/money/riskWatchStore.js
// Pocket Crew "My money" Task 8: personal, OBSERVE-ONLY risk-watch history. Every entry here is a
// RECOMMENDATION surfaced to the owner — never an instruction any code path executes. This module
// has exactly three exports (record/get/clear) and imports nothing capable of signing or sending
// a transaction: risk watch is a read-and-recommend loop, full stop (see
// backgroundAgent.worker.js's own header: "Does NOT execute transactions"). History is
// local-device, per network + owner ("This device" — see automationEvidence.js's
// describeRiskWatchProvenance) — never a shared/global bucket, and never silently attributed to
// whichever wallet happens to be connected first (same discipline as cycleJournal.js /
// decisionLog.js's own scoped forms).
const PREFIX = 'yv_risk_watch'
const MAX_ROWS = 100

function scopedKey(networkId, owner) {
  if (!networkId || !owner) return null
  return `${PREFIX}:${networkId}:${owner}`
}

function read(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(key, rows) {
  try {
    localStorage.setItem(key, JSON.stringify(rows.slice(-MAX_ROWS)))
  } catch (err) {
    console.warn('[RiskWatchStore] write failed:', err.message)
  }
}

/**
 * Record one observe-only recommendation. `recommendation` should carry its own evidence —
 * `source` (where the fact/search result came from) and enough context to explain WHY — never a
 * bare severity number with no provenance. Dropped silently (never throws, never guesses an
 * owner/network) when either key is missing.
 */
export function recordRecommendation(networkId, owner, recommendation, { now = Date.now() } = {}) {
  const key = scopedKey(networkId, owner)
  if (!key) return
  try {
    const rows = read(key)
    rows.push({ ...recommendation, recordedAt: now, scope: 'local' })
    write(key, rows)
  } catch (err) {
    console.warn('[RiskWatchStore] recordRecommendation failed:', err.message)
  }
}

/** @returns newest-first array of recommendations for this network+owner. Never falls back to
 *  another wallet's history or a shared bucket when either key is missing — just []. */
export function getRecommendations(networkId, owner) {
  const key = scopedKey(networkId, owner)
  if (!key) return []
  return read(key).reverse()
}

export function clearRecommendations(networkId, owner) {
  const key = scopedKey(networkId, owner)
  if (!key) return
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
