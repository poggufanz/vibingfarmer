// TTL-evicting store for serializedApproval -> sessionPrivateKey. Session private keys must not
// live in process memory forever (server.mjs used a plain Map, so every mandate ever posted
// lingered until restart). Duck-types the Map get/set the httpRouter uses, so it drops in without
// touching the router, and evicts lazily on access plus on an optional periodic sweep.
//
// ttlMs (default one hour) is only the FALLBACK used when set() isn't given an explicit
// expiresAt. httpRouter's handleMandate always passes one now — the client's own `expiry`
// (unix seconds, converted to ms), durable up to 30 days — so in practice the real horizon is
// whatever the client requested (baseLeg.js requests a 7-day window), not this constant.

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {{ ttlMs?: number, now?: () => number }} [opts]
 * @returns {{ set: (k:string,v:string,expiresAt?:number)=>void, get: (k:string)=>(string|undefined),
 *   status: (k:string)=>{valid:boolean, expiresAt?:number},
 *   delete: (k:string)=>boolean, sweep: ()=>number, get size: number }}
 */
export function createMandateStore({ ttlMs = HOUR_MS, now = () => Date.now() } = {}) {
  /** @type {Map<string, { value: string, expiresAt: number }>} */
  const entries = new Map();

  function isExpired(rec, t) {
    return t >= rec.expiresAt;
  }

  return {
    // expiresAt (ms epoch), when given, overrides the now()+ttlMs default — this is how
    // handleMandate stores the client's real (client-supplied, validated) expiry.
    set(key, value, expiresAt) {
      entries.set(key, { value, expiresAt: expiresAt ?? now() + ttlMs });
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
    // Reuse-check lookup for GET /mandate/valid: reports validity + expiry WITHOUT ever handing
    // back the stored session key, so a client can poll for reuse without re-exposing key material.
    status(key) {
      const rec = entries.get(key);
      if (!rec) return { valid: false };
      if (isExpired(rec, now())) {
        entries.delete(key); // same lazy eviction as get()
        return { valid: false };
      }
      return { valid: true, expiresAt: rec.expiresAt };
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
