// TTL-evicting store for serializedApproval -> sessionPrivateKey. Session private keys must not
// live in process memory forever (server.mjs used a plain Map, so every mandate ever posted
// lingered until restart). Duck-types the Map get/set the httpRouter uses, so it drops in without
// touching the router, and evicts lazily on access plus on an optional periodic sweep.
//
// ttlMs (default one hour) is only the FALLBACK used when set() isn't given an explicit
// expiresAt. httpRouter's handleMandate always passes one now — the client's own `expiry`
// (unix seconds, converted to ms), durable up to 30 days — so in practice the real horizon is
// whatever the client requested (baseLeg.js requests a 7-day window), not this constant.

import { createHash, randomUUID } from 'node:crypto';

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

const USER_OP_HASH_RE = /^0x[0-9a-f]{64}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const V3_IMMUTABLE_FIELDS = [
  'approvalDigest',
  'policyDigest',
  'serializedApproval',
  'sessionKeyDigest',
  'sessionKeyAddress',
  'capabilityHash',
  'stellarOwner',
  'kernelAddress',
  'relayerOrigin',
  'validUntilSeconds',
  'bindingId',
  'bindingHash',
  'permissionId',
];

function normalizeV3Record(record) {
  if (!record || typeof record !== 'object') throw new Error('mandate record is required');
  if (typeof record.mandateId !== 'string' || !record.mandateId) {
    throw new Error('mandate ID is required');
  }
  if (!DIGEST_RE.test(record.capabilityHash || '')) {
    throw new Error('capability hash is required');
  }
  if (!DIGEST_RE.test(record.policyDigest || '')) {
    throw new Error('policy digest is required and must be canonical');
  }
  if (!DIGEST_RE.test(record.approvalDigest || '')
    || !DIGEST_RE.test(record.bindingHash || '')) {
    throw new Error('mandate digest fields are invalid');
  }
  if (!Number.isSafeInteger(record.validUntilSeconds) || record.validUntilSeconds <= 0) {
    throw new Error('mandate expiry is invalid');
  }
  if (typeof record.stellarOwner !== 'string' || !record.stellarOwner
    || typeof record.kernelAddress !== 'string' || !record.kernelAddress
    || typeof record.sessionKeyAddress !== 'string' || !record.sessionKeyAddress
    || typeof record.sessionPrivateKey !== 'string' || !record.sessionPrivateKey) {
    throw new Error('mandate identity or session authority is invalid');
  }
  return {
    ...record,
    kernelAddress: record.kernelAddress.toLowerCase(),
    sessionKeyAddress: record.sessionKeyAddress.toLowerCase(),
    relayerOrigin: record.relayerOrigin ?? null,
    bindingId: record.bindingId ?? null,
    permissionId: record.permissionId ?? null,
    sessionKeyDigest: createHash('sha256').update(record.sessionPrivateKey).digest('hex'),
    status: 'pending_activation',
  };
}

function sameV3Identity(record, identity) {
  return Boolean(record && identity
    && record.mandateId === identity.mandateId
    && record.stellarOwner === identity.stellarOwner
    && record.kernelAddress === String(identity.kernelAddress || '').toLowerCase());
}

function publicMandateV3(record, status = record.status) {
  if (!record) return { status: 'missing' };
  return {
    mandateId: record.mandateId,
    approvalDigest: record.approvalDigest,
    policyDigest: record.policyDigest,
    stellarOwner: record.stellarOwner,
    kernelAddress: record.kernelAddress,
    sessionKeyAddress: record.sessionKeyAddress ?? null,
    relayerOrigin: record.relayerOrigin ?? null,
    validUntilSeconds: record.validUntilSeconds ?? null,
    status,
    bindingId: record.bindingId ?? null,
    bindingHash: record.bindingHash ?? null,
    permissionId: record.permissionId ?? null,
    activationUserOpHash: record.activationUserOpHash ?? null,
    activationTxHash: record.activationTxHash ?? null,
    activatedAt: record.activatedAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function internalMandateV3(record, { includeSession = true } = {}) {
  if (!record) return null;
  const result = {
    mandateId: record.mandateId,
    approvalDigest: record.approvalDigest,
    policyDigest: record.policyDigest,
    serializedApproval: record.serializedApproval,
    stellarOwner: record.stellarOwner,
    kernelAddress: record.kernelAddress,
    sessionKeyAddress: record.sessionKeyAddress ?? null,
    relayerOrigin: record.relayerOrigin ?? null,
    validUntilSeconds: record.validUntilSeconds ?? null,
    status: record.status,
    bindingId: record.bindingId ?? null,
    bindingHash: record.bindingHash ?? null,
    permissionId: record.permissionId ?? null,
    activationUserOpHash: record.activationUserOpHash ?? null,
    activationTxHash: record.activationTxHash ?? null,
    activatedAt: record.activatedAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (includeSession && record.sessionPrivateKey) {
    Object.defineProperty(result, 'sessionPrivateKey', {
      value: record.sessionPrivateKey,
      enumerable: false,
    });
  }
  if (record.capabilityHash) {
    Object.defineProperty(result, 'capabilityHash', {
      value: record.capabilityHash,
      enumerable: false,
    });
  }
  return result;
}

function internalMandateAuthorityV3(record, status = record?.status) {
  if (!record) return null;
  const result = {
    mandateId: record.mandateId,
    stellarOwner: record.stellarOwner,
    kernelAddress: record.kernelAddress,
    relayerOrigin: record.relayerOrigin ?? null,
    validUntilSeconds: record.validUntilSeconds ?? null,
    status,
    bindingId: record.bindingId ?? null,
    bindingHash: record.bindingHash ?? null,
  };
  if (record.capabilityHash) {
    Object.defineProperty(result, 'capabilityHash', {
      value: record.capabilityHash,
      enumerable: false,
    });
  }
  return result;
}

function publicActivationWork(work) {
  if (!work) return null;
  return {
    mandateId: work.mandateId,
    stellarOwner: work.stellarOwner,
    kernelAddress: work.kernelAddress,
    status: work.status,
    attempts: work.attempts,
    leaseToken: work.leaseToken ?? null,
    leaseExpiresAt: work.leaseExpiresAt ?? null,
    userOpHash: work.userOpHash ?? null,
    txHash: work.txHash ?? null,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
  };
}

function v3Conflict(existing, incoming) {
  return V3_IMMUTABLE_FIELDS.some((field) => existing[field] !== incoming[field]);
}

/**
 * In-memory behavioral peer of the durable SQLite v3 mandate stores.
 */
export function createMandateStoresV3({
  nowSeconds = () => Math.floor(Date.now() / 1000),
  leaseToken = randomUUID,
} = {}) {
  const records = new Map();
  const workRows = new Map();
  const issuedLeaseTokens = new Set();
  let tokenCounter = 0;

  function recordFor(identity) {
    const record = records.get(identity?.mandateId);
    return sameV3Identity(record, identity) ? record : null;
  }

  function workFor(identity) {
    return recordFor(identity) ? (workRows.get(identity.mandateId) ?? null) : null;
  }

  function effectiveNow(value) {
    const result = value ?? nowSeconds();
    if (!Number.isSafeInteger(result)) throw new Error('activation time is invalid');
    return result;
  }

  function assertMandateLive(record, at) {
    if (at >= record.validUntilSeconds) {
      expireRecord(record, at);
      throw new Error('mandate expiry has been reached');
    }
  }

  function assertLease(work, token, at) {
    if (!work || !work.leaseToken || token !== work.leaseToken) {
      throw new Error('stale activation lease token');
    }
    if (!Number.isSafeInteger(work.leaseExpiresAt) || at >= work.leaseExpiresAt) {
      throw new Error('activation lease has expired');
    }
  }

  function nextLeaseToken(previous) {
    let candidate = String(leaseToken());
    while (!candidate || candidate === previous || issuedLeaseTokens.has(candidate)) {
      tokenCounter += 1;
      candidate = `${candidate || 'lease'}-${tokenCounter}`;
    }
    issuedLeaseTokens.add(candidate);
    return candidate;
  }

  function expireRecord(record, at) {
    if (!record || at < record.validUntilSeconds) return false;
    record.sessionPrivateKey = undefined;
    const work = workRows.get(record.mandateId);
    if (work?.status === 'pending' || work?.status === 'running') {
      workRows.delete(record.mandateId);
    } else if (work?.status === 'submitting' || work?.status === 'submitted') {
      work.status = 'uncertain';
      work.leaseToken = null;
      work.leaseExpiresAt = null;
      work.updatedAt = at;
      record.status = 'activation_uncertain';
      record.updatedAt = at;
    }
    return true;
  }

  const mandatesV3 = {
    authority(mandateId) {
      const record = records.get(mandateId);
      if (!record) return null;
      const expired = expireRecord(record, effectiveNow());
      return internalMandateAuthorityV3(record, expired ? 'expired' : record.status);
    },
    get(identity) {
      const record = recordFor(identity);
      if (!record) return null;
      const expired = expireRecord(record, effectiveNow());
      return internalMandateV3(record, { includeSession: !expired && record.status !== 'revoked' });
    },
    status(identity) {
      const record = recordFor(identity);
      if (!record) return { status: 'missing' };
      const status = expireRecord(record, effectiveNow()) ? 'expired' : record.status;
      return publicMandateV3(record, status);
    },
    revoke(identity) {
      const record = recordFor(identity);
      if (!record) return null;
      const at = effectiveNow();
      const expired = expireRecord(record, at);
      if (expired) return publicMandateV3(record, 'expired');
      record.status = 'revoked';
      record.sessionPrivateKey = undefined;
      record.updatedAt = at;
      workRows.delete(record.mandateId);
      return publicMandateV3(record, 'revoked');
    },
    get size() {
      return records.size;
    },
  };

  const mandateActivations = {
    enqueue({ record: input }) {
      const incoming = normalizeV3Record(input);
      const existing = records.get(incoming.mandateId);
      if (existing) {
        const expired = expireRecord(existing, effectiveNow());
        if (v3Conflict(existing, incoming)) throw new Error('immutable mandate conflict');
        return {
          duplicate: true,
          mandate: publicMandateV3(existing, expired ? 'expired' : existing.status),
          work: publicActivationWork(workRows.get(existing.mandateId)),
        };
      }
      const at = effectiveNow();
      assertMandateLive(incoming, at);
      const stored = {
        ...incoming,
        createdAt: at,
        updatedAt: at,
        activationUserOpHash: null,
        activationTxHash: null,
        activatedAt: null,
      };
      const work = {
        mandateId: stored.mandateId,
        stellarOwner: stored.stellarOwner,
        kernelAddress: stored.kernelAddress,
        status: 'pending',
        attempts: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        userOpHash: null,
        txHash: null,
        createdAt: at,
        updatedAt: at,
      };
      records.set(stored.mandateId, stored);
      workRows.set(stored.mandateId, work);
      return {
        duplicate: false,
        mandate: publicMandateV3(stored),
        work: publicActivationWork(work),
      };
    },
    get(identity) {
      const record = recordFor(identity);
      if (!record) return null;
      expireRecord(record, effectiveNow());
      return publicActivationWork(workRows.get(record.mandateId));
    },
    claim({ nowSeconds: atValue, leaseSeconds = 30, ...identity }) {
      const record = recordFor(identity);
      const work = workFor(identity);
      if (!record || !work || work.status !== 'pending') return null;
      const at = effectiveNow(atValue);
      assertMandateLive(record, at);
      if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
        throw new Error('activation lease duration is invalid');
      }
      const previous = work.leaseToken;
      const token = nextLeaseToken(previous);
      work.status = 'running';
      work.attempts += 1;
      work.leaseToken = token;
      work.leaseExpiresAt = Math.min(at + leaseSeconds, record.validUntilSeconds);
      work.updatedAt = at;
      return publicActivationWork(work);
    },
    renew({ leaseToken: token, nowSeconds: atValue, leaseSeconds = 30, ...identity }) {
      const record = recordFor(identity);
      const work = workFor(identity);
      if (!record || !work) throw new Error('stale or missing activation lease');
      const at = effectiveNow(atValue);
      assertMandateLive(record, at);
      assertLease(work, token, at);
      if (!['running', 'submitting', 'submitted'].includes(work.status)) {
        throw new Error('activation lease is terminal or not renewable');
      }
      if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
        throw new Error('activation lease duration is invalid');
      }
      work.leaseExpiresAt = Math.min(at + leaseSeconds, record.validUntilSeconds);
      work.updatedAt = at;
      return publicActivationWork(work);
    },
    checkpoint({ leaseToken: token, status, userOpHash, nowSeconds: atValue, ...identity }) {
      const record = recordFor(identity);
      const work = workFor(identity);
      if (!record || !work) throw new Error('activation work is missing');
      const at = effectiveNow(atValue);
      assertMandateLive(record, at);
      assertLease(work, token, at);
      if (status === 'submitting') {
        if (work.status !== 'running') throw new Error('invalid activation transition');
      } else if (status === 'submitted') {
        if (work.status !== 'submitting') throw new Error('invalid activation transition to submitted');
        if (!USER_OP_HASH_RE.test(userOpHash || '')) throw new Error('submitted user operation hash is invalid');
      } else {
        throw new Error('invalid activation checkpoint state');
      }
      work.status = status;
      if (status === 'submitted') work.userOpHash = userOpHash;
      work.updatedAt = at;
      return publicActivationWork(work);
    },
    finishActive({
      leaseToken: token,
      userOpHash,
      txHash,
      activatedAt,
      nowSeconds: atValue,
      ...identity
    }) {
      const record = recordFor(identity);
      const work = workFor(identity);
      if (!record || !work) throw new Error('stale or terminal activation lease');
      const at = effectiveNow(atValue);
      assertMandateLive(record, at);
      assertLease(work, token, at);
      if (work.status !== 'submitted') throw new Error('activation must be submitted before finish');
      if (!USER_OP_HASH_RE.test(userOpHash || '') || userOpHash !== work.userOpHash) {
        throw new Error('submitted user operation hash disagreement');
      }
      if (!TX_HASH_RE.test(txHash || '')) throw new Error('activation transaction hash is not canonical');
      if (!Number.isSafeInteger(activatedAt) || activatedAt <= 0) {
        throw new Error('activation time is invalid');
      }
      if (activatedAt >= record.validUntilSeconds) {
        throw new Error('activation time must precede mandate expiry');
      }
      record.status = 'active';
      record.activationUserOpHash = userOpHash;
      record.activationTxHash = txHash;
      record.activatedAt = activatedAt;
      record.updatedAt = at;
      work.status = 'done';
      work.txHash = txHash;
      work.leaseToken = null;
      work.leaseExpiresAt = null;
      work.updatedAt = at;
      return { mandate: publicMandateV3(record), work: publicActivationWork(work) };
    },
    finishUncertain({
      leaseToken: token,
      userOpHash,
      txHash,
      nowSeconds: atValue,
      ...identity
    }) {
      const record = recordFor(identity);
      const work = workFor(identity);
      if (!record || !work) throw new Error('stale or terminal activation lease');
      const at = effectiveNow(atValue);
      assertMandateLive(record, at);
      assertLease(work, token, at);
      if (work.status !== 'submitting' && work.status !== 'submitted') {
        throw new Error('activation must cross the submitting or submitted fence');
      }
      if (userOpHash !== undefined && !USER_OP_HASH_RE.test(userOpHash)) {
        throw new Error('user operation hash is not canonical');
      }
      if (work.status === 'submitted' && userOpHash !== undefined
        && userOpHash !== work.userOpHash) {
        throw new Error('submitted user operation hash mismatch');
      }
      const retainedUserOpHash = userOpHash ?? work.userOpHash;
      if (txHash !== undefined && !TX_HASH_RE.test(txHash)) {
        throw new Error('activation transaction hash is not canonical');
      }
      if (txHash !== undefined && !retainedUserOpHash) {
        throw new Error('transaction evidence requires a canonical user operation hash');
      }
      record.status = 'activation_uncertain';
      record.updatedAt = at;
      work.status = 'uncertain';
      if (retainedUserOpHash) work.userOpHash = retainedUserOpHash;
      if (txHash !== undefined) work.txHash = txHash;
      work.leaseToken = null;
      work.leaseExpiresAt = null;
      work.updatedAt = at;
      return { mandate: publicMandateV3(record), work: publicActivationWork(work) };
    },
    finishRevoked({
      leaseToken: token,
      userOpHash,
      txHash,
      activatedAt,
      nowSeconds: atValue,
      ...identity
    }) {
      const record = recordFor(identity);
      const work = workFor(identity);
      if (!record || !work) throw new Error('stale or terminal activation lease');
      const at = effectiveNow(atValue);
      assertMandateLive(record, at);
      assertLease(work, token, at);
      if (work.status !== 'submitted') {
        throw new Error('activation must be submitted before receipt revocation');
      }
      if (!USER_OP_HASH_RE.test(userOpHash || '') || userOpHash !== work.userOpHash) {
        throw new Error('submitted user operation hash mismatch');
      }
      if (!TX_HASH_RE.test(txHash || '')) {
        throw new Error('activation transaction hash is not canonical');
      }
      if (!Number.isSafeInteger(activatedAt) || activatedAt <= 0) {
        throw new Error('activation timestamp is invalid');
      }
      if (activatedAt >= record.validUntilSeconds) {
        throw new Error('activation timestamp must precede mandate expiry');
      }
      record.status = 'revoked';
      record.activationUserOpHash = userOpHash;
      record.activationTxHash = txHash;
      record.activatedAt = activatedAt;
      record.sessionPrivateKey = undefined;
      record.updatedAt = at;
      workRows.delete(record.mandateId);
      return { mandate: publicMandateV3(record), work: null };
    },
    listRecoverable({ nowSeconds: atValue } = {}) {
      const at = effectiveNow(atValue);
      const recoverable = [];
      for (const record of records.values()) {
        if (expireRecord(record, at) || record.status !== 'pending_activation') continue;
        const work = workRows.get(record.mandateId);
        if (work?.status === 'pending') recoverable.push(publicActivationWork(work));
      }
      return recoverable;
    },
    reconcileExpired({ nowSeconds: atValue } = {}) {
      const at = effectiveNow(atValue);
      const reconciled = [];
      for (const work of [...workRows.values()]) {
        const record = records.get(work.mandateId);
        if (record && expireRecord(record, at)) continue;
        if (!['running', 'submitting', 'submitted'].includes(work.status)
          || !Number.isSafeInteger(work.leaseExpiresAt) || work.leaseExpiresAt > at) continue;
        if (work.status === 'running') {
          work.status = 'pending';
        } else {
          work.status = 'uncertain';
          if (record) {
            record.status = 'activation_uncertain';
            record.updatedAt = at;
          }
        }
        work.leaseToken = null;
        work.leaseExpiresAt = null;
        work.updatedAt = at;
        reconciled.push(publicActivationWork(work));
      }
      return reconciled;
    },
  };

  return { mandatesV3, mandateActivations };
}
