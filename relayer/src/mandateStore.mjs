// TTL-evicting store for serializedApproval -> sessionPrivateKey. Session private keys must not
// live in process memory forever (server.mjs used a plain Map, so every mandate ever posted
// lingered until restart). Duck-types the Map get/set the httpRouter uses, so it drops in without
// touching the router, and evicts lazily on access plus on an optional periodic sweep.
//
// ttlMs defaults to one hour — the same horizon as the mandate's own on-chain expiry
// (CrossChainFarmFlow builds `expiry = now + 3600`), so a key is useless by the time it's evicted.

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {{ ttlMs?: number, now?: () => number }} [opts]
 * @returns {{ set: (k:string,v:string)=>void, get: (k:string)=>(string|undefined),
 *   delete: (k:string)=>boolean, sweep: ()=>number, get size: number }}
 */
export function createMandateStore({ ttlMs = HOUR_MS, now = () => Date.now() } = {}) {
  /** @type {Map<string, { value: string, expiresAt: number }>} */
  const entries = new Map();

  function isExpired(rec, t) {
    return t >= rec.expiresAt;
  }

  return {
    set(key, value) {
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    get(key) {
      const rec = entries.get(key);
      if (!rec) return undefined;
      if (isExpired(rec, now())) {
        entries.delete(key); // lazy eviction: an expired key is never handed back
        return undefined;
      }
      return rec.value;
    },
    delete(key) {
      return entries.delete(key);
    },
    // Drop every expired entry so keys don't sit in memory until their next (maybe never) access.
    // Returns the count removed. Call on an interval from a long-lived server.
    sweep() {
      const t = now();
      let removed = 0;
      for (const [key, rec] of entries) {
        if (isExpired(rec, t)) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    get size() {
      return entries.size;
    },
  };
}
