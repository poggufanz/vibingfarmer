// keeper/src/refprices.js — reference prices for the oracle-divergence detector, extracted from
// radar-runner.mjs and hardened for real feeds: per-URL JSON dot-path (URL fragment), 60s cache
// (the radar evaluates every ~6s ledger — free price APIs would rate-limit at that cadence), and
// all-failed -> null so radar.js raises its fail-closed alarm instead of acting on nothing.
const CACHE_MS = 60_000;

export function pickPath(obj, path) {
  if (!path) return obj?.price;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export function createRefPrices(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cache = null; // { at, prices }
  return async function refPrices() {
    if (env.LIFEBOAT_REF_PRICE) return [Number(env.LIFEBOAT_REF_PRICE)];
    if (!env.LIFEBOAT_REF_URLS) return null;
    if (cache && now() - cache.at < CACHE_MS) return cache.prices;

    const entries = env.LIFEBOAT_REF_URLS.split(',').filter(Boolean).map((raw) => {
      const hash = raw.indexOf('#');
      return hash >= 0 ? { url: raw.slice(0, hash), path: raw.slice(hash + 1) } : { url: raw, path: '' };
    });
    const settled = await Promise.allSettled(entries.map(async ({ url, path }) => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      const n = Number(pickPath(await res.json(), path));
      if (!Number.isFinite(n)) throw new Error('non-numeric ref price');
      return n;
    }));
    const prices = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    if (prices.length === 0) return null; // no cache poisoning with an empty result
    cache = { at: now(), prices };
    return prices;
  };
}
