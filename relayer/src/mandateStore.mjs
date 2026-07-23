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

// VF Wallet Task 7: owner/kernel-bound sibling of createMandateStore above. Untouched sibling,
// not a replacement — legacy rows created via createMandateStore's approval-only key remain
// exactly where they are (rollback safety); this store's own rows are always keyed on
// (serializedApproval, stellarOwner, kernelAddress) TOGETHER, so a lookup for the wrong owner or
// the wrong kernel simply misses, even when the approval string itself matches something on file
// (Step 5 acceptance: "owner A approval cannot execute for owner B or a second kernel").
//
// The full record (including sessionPrivateKey) is only ever returned by get() — the internal,
// pre-dispatch lookup. status() reports the canonical BaseMandateStatusV2 shape and never
// includes the key. A missing/expired/unregistered triple both report through status() as
// 'missing'/'expired' with every other field null, per the "never render unknown as healthy"
// rule — the caller must re-derive what it expected from its own request, not trust a guess.
const KEY_SEP = '|'; // safe: base64 approvals, base32 G/C StrKeys, and 0x-hex addresses never contain it

function mandateKeyV2(serializedApproval, stellarOwner, kernelAddress) {
  return `${serializedApproval}${KEY_SEP}${stellarOwner}${KEY_SEP}${kernelAddress}`;
}

const MISSING_STATUS_V2 = {
  stellarOwner: null,
  kernelAddress: null,
  sessionKeyAddress: null,
  relayerOrigin: null,
  expiresAt: null,
  status: 'missing',
  bindingId: null,
  bindingHash: null,
};

/**
 * @param {{ ttlMs?: number, now?: () => number }} [opts]
 */
export function createMandateStoreV2({ ttlMs = HOUR_MS, now = () => Date.now() } = {}) {
  /** @type {Map<string, object>} */
  const entries = new Map();

  function isExpired(rec, t) {
    return t >= rec.expiresAt;
  }

  function getRecord(serializedApproval, stellarOwner, kernelAddress) {
    const k = mandateKeyV2(serializedApproval, stellarOwner, kernelAddress);
    const rec = entries.get(k);
    if (!rec) return undefined;
    if (isExpired(rec, now())) {
      entries.delete(k); // lazy eviction, same posture as createMandateStore
      return undefined;
    }
    return rec;
  }

  function statusShape(rec, status) {
    return {
      stellarOwner: rec.stellarOwner,
      kernelAddress: rec.kernelAddress,
      sessionKeyAddress: rec.sessionKeyAddress,
      relayerOrigin: rec.relayerOrigin ?? null,
      expiresAt: rec.expiresAt,
      status,
      bindingId: rec.bindingId ?? null,
      bindingHash: rec.bindingHash ?? null,
    };
  }

  return {
    // record is the full Step-1 shape (see relayer/src/httpRouter.mjs's handleMandate) —
    // expiresAt is an ms-epoch number, same convention as createMandateStore.
    set(record) {
      const { serializedApproval, stellarOwner, kernelAddress } = record;
      entries.set(mandateKeyV2(serializedApproval, stellarOwner, kernelAddress), { ...record });
    },
    // Full record INCLUDING sessionPrivateKey — internal use only, right before the key is
    // handed to reconstructSessionClient. Never expose this return value in an HTTP response.
    get({ serializedApproval, stellarOwner, kernelAddress }) {
      const rec = getRecord(serializedApproval, stellarOwner, kernelAddress);
      return rec ? { ...rec } : undefined;
    },
    // Distinguishes 'expired' (a real row was found, just past its window) from 'missing'
    // (nothing registered under this exact approval+owner+kernel triple at all) — unlike get(),
    // this reads the raw entry itself rather than going through getRecord's evict-to-undefined,
    // so an expired row's real identity fields are still reported (never sessionPrivateKey).
    status({ serializedApproval, stellarOwner, kernelAddress }) {
      const k = mandateKeyV2(serializedApproval, stellarOwner, kernelAddress);
      const rec = entries.get(k);
      if (!rec) return { ...MISSING_STATUS_V2 };
      if (isExpired(rec, now())) {
        entries.delete(k); // same lazy eviction as get()
        return statusShape(rec, 'expired');
      }
      return statusShape(rec, rec.status === 'revoked' ? 'revoked' : 'active');
    },
    delete({ serializedApproval, stellarOwner, kernelAddress }) {
      return entries.delete(mandateKeyV2(serializedApproval, stellarOwner, kernelAddress));
    },
    sweep() {
      const t = now();
      let removed = 0;
      for (const [k, rec] of entries) {
        if (isExpired(rec, t)) {
          entries.delete(k);
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
