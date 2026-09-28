// frontend/src/cache/getOrCreate.js
// Satu-satunya tempat logika TTL + dedupe tinggal (terjemahan JS dari prinsip
// HybridCache di skill caching: GetOrCreate + Expiration + stampede protection
// bawaan, bukan lock manual per call-site). Semua cache in-memory modul
// (apyHistory, overlay singleflight, dsb.) wajib memakai ini, bukan Map telanjang.
//
// Kontrak:
// - get() melewatkan hit hanya bila 0 <= umur <= ttlMs. Umur negatif (clock skew
//   ke masa depan) = miss, bukan current — searah freshness.js MAX_CLOCK_SKEW.
// - getOrCreate() mendedupe factory konkuren per key (collapse requests, RFC 9111 §4).
// - Kapasitas dibatasi maxEntries (evict FIFO kasar = insert tertua keluar dulu).
// - remove() = invalidasi eksplisit pasca-mutasi. Tidak ada expiry = tidak ada cache.

export const DEFAULT_TTL_MS = 10 * 60 * 1000
export const DEFAULT_MAX_ENTRIES = 100

export function createCache({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const store = new Map() // key -> { at, data }
  const inflight = new Map() // key -> Promise (collapse requests)

  function get(key) {
    const hit = store.get(key)
    if (!hit) return undefined
    const age = now() - hit.at
    if (!Number.isFinite(age) || age < 0 || age > ttlMs) {
      store.delete(key)
      return undefined
    }
    return hit.data
  }

  function set(key, data) {
    if (store.size >= maxEntries && !store.has(key)) {
      store.delete(store.keys().next().value) // evict insert tertua
    }
    store.set(key, { at: now(), data })
  }

  function remove(key) {
    store.delete(key)
    // inflight yang sedang jalan dibiarkan selesai; hasilnya tetap ditulis agar
    // pembaca berikutnya dapat nilai segar, tapi caller pasca-mutasi wajib
    // me-refetch eksplisit bila butuh konsistensi baca-setelah-tulis.
  }

  function clear() {
    store.clear()
    inflight.clear()
  }

  async function getOrCreate(key, factory) {
    const hit = get(key)
    if (hit !== undefined) return hit
    if (inflight.has(key)) return inflight.get(key)
    const p = Promise.resolve()
      .then(() => factory())
      .then((data) => {
        if (data !== undefined && data !== null) set(key, data)
        return data
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, p)
    return p
  }

  return { get, set, remove, clear, getOrCreate, _size: () => store.size }
}

/** Batasi konkurensi fan-out (batch fetch) agar tidak memborbardir upstream. */
export async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}
