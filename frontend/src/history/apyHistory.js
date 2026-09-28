// apyHistory.js
// Fetches 7-day APY history per DeFiLlama pool ID.
// Session cache via shared getOrCreate: TTL 10 mnt + cap 100 pool + inflight
// dedupe + batch ber-concurrency-limit. Tidak pernah melempar — null saat gagal.

import { createCache, mapWithLimit } from '../cache/getOrCreate.js'

const TIMEOUT_MS = 8000
const CHART_ENDPOINT = 'https://yields.llama.fi/chart'
const HISTORY_DAYS = 7
const TTL_MS = 10 * 60 * 1000
const MAX_POOLS = 100
const BATCH_CONCURRENCY = 5

const cache = createCache({ ttlMs: TTL_MS, maxEntries: MAX_POOLS })

/**
 * Fetch last 7 days of APY history for a single pool.
 * Never throws — returns null on any failure.
 *
 * @param {string} poolId - DeFiLlama pool UUID
 * @returns {Promise<Array<{timestamp: string, apy: number}>|null>}
 */
export async function fetchApyHistory(poolId) {
  if (!poolId) return null
  return cache.getOrCreate(poolId, async () => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(`${CHART_ENDPOINT}/${encodeURIComponent(poolId)}`, {
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      if (!res.ok) return null

      const json = await res.json()
      const history = (json.data || []).slice(-HISTORY_DAYS)
      return history
    } catch {
      clearTimeout(timeoutId)
      return null
    }
  })
}

/**
 * Fetch APY history for many pools in parallel (concurrency-bounded).
 *
 * @param {string[]} poolIds
 * @returns {Promise<Object<string, Array>>} map of poolId → history (null entries dropped)
 */
export async function fetchApyHistoryBatch(poolIds) {
  const results = await mapWithLimit(poolIds, BATCH_CONCURRENCY, async (id) => [
    id,
    await fetchApyHistory(id),
  ])
  return Object.fromEntries(results.filter(([, v]) => v !== null))
}

export const _test = { clear: () => cache.clear() }
