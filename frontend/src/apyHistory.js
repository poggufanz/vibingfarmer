// apyHistory.js
// Fetches 7-day APY history per DeFiLlama pool ID.
// In-memory cache only (no localStorage) — one network fetch per pool per session.

const cache = new Map()
const TIMEOUT_MS = 8000
const CHART_ENDPOINT = 'https://yields.llama.fi/chart'
const HISTORY_DAYS = 7

/**
 * Fetch last 7 days of APY history for a single pool.
 * Never throws — returns null on any failure.
 *
 * @param {string} poolId - DeFiLlama pool UUID
 * @returns {Promise<Array<{timestamp: string, apy: number}>|null>}
 */
export async function fetchApyHistory(poolId) {
  if (!poolId) return null
  if (cache.has(poolId)) return cache.get(poolId)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`${CHART_ENDPOINT}/${encodeURIComponent(poolId)}`, { signal: controller.signal })
    clearTimeout(timeoutId)
    if (!res.ok) return null

    const json = await res.json()
    const history = (json.data || []).slice(-HISTORY_DAYS)
    cache.set(poolId, history)
    return history
  } catch {
    clearTimeout(timeoutId)
    return null
  }
}

/**
 * Fetch APY history for many pools in parallel.
 *
 * @param {string[]} poolIds
 * @returns {Promise<Object<string, Array>>} map of poolId → history (null entries dropped)
 */
export async function fetchApyHistoryBatch(poolIds) {
  const results = await Promise.all(
    poolIds.map(async (id) => [id, await fetchApyHistory(id)])
  )
  return Object.fromEntries(results.filter(([, v]) => v !== null))
}
