// frontend/src/stellar/grantReceiptStore.js
// Strategy Task 5 (Pocket Crew redesign, Wave 1). Persists GrantReceiptV1 — the caller's ONLY
// job is calling `saveGrantReceipt` after a confirmed submission, never before (this module has
// no way to independently verify chain confirmation; that discipline lives with the caller, e.g.
// the code driving submitGrant + grant.js's readConfirmedLedger). On every read the stored
// fingerprint is recomputed and compared, so a corrupted/tampered row is indistinguishable from
// "nothing cached" — both force a fresh decision upstream (reusePreflight.js). This store is an
// INPUT POINTER only: it is never, by itself, proof that the allowance still holds — that proof
// is allowanceProof.js re-verifying against the chain on every preflight.
import { hash } from '@stellar/stellar-sdk'
import { canonicalizeStrategy } from '../strategy/canonicalStrategy.js'
import { NETWORK_PASSPHRASE } from './config.js'

const STORE_KEY = 'vf.grantReceiptStore.v1'
// Fixed label, not the raw network passphrase — matches AllowanceExpiryProofV1.network (allowanceProof.js).
const NETWORK_ID = 'stellar-testnet'

let _memStore = null
function resolveStorage(injected) {
  if (injected) return injected
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch {
    /* SecurityError in some embeds — fall through */
  }
  if (!_memStore) {
    const m = new Map()
    _memStore = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
    }
  }
  return _memStore
}

function readAll(storage) {
  try {
    return JSON.parse(resolveStorage(storage).getItem(STORE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function writeAll(all, storage) {
  try {
    resolveStorage(storage).setItem(STORE_KEY, JSON.stringify(all))
  } catch {
    /* quota/serialization failure — best-effort, never fatal */
  }
}

function bucketKey({ owner, router, network = NETWORK_PASSPHRASE }) {
  return `${network}|${owner}|${router}`
}

/** Deterministic 0x-prefixed sha256 fingerprint of a GrantReceiptV1. GrantReceiptV1 carries no
 * secret and no self-referential field, so the whole object canonicalizes directly. */
export function fingerprintGrantReceipt(receipt) {
  const payload = JSON.stringify(canonicalizeStrategy(receipt))
  return '0x' + hash(payload).toString('hex') // hash() accepts a string directly (no Buffer needed)
}

/**
 * Assemble a GrantReceiptV1 from confirmed submission data. `confirmedAt` MUST come from the
 * confirmed ledger's close time (grant.js's `readConfirmedLedger`) — required here (never
 * defaulted to `Date.now()`) so a caller cannot silently substitute the browser clock.
 * @param {{runId, owner, router, txHash, confirmedLedger:number, expiryLedger:number,
 *          allowanceBudgets:Array<{token:string, units:bigint|string, decimals:number}>,
 *          agentInitFingerprint:string, agentAddresses:string[], confirmedAt:number}} p
 * @returns {object} GrantReceiptV1
 */
export function buildGrantReceiptV1({
  runId,
  owner,
  router,
  txHash,
  confirmedLedger,
  expiryLedger,
  allowanceBudgets,
  agentInitFingerprint,
  agentAddresses,
  confirmedAt,
}) {
  if (confirmedAt == null || !Number.isFinite(Number(confirmedAt)))
    throw new Error(
      'buildGrantReceiptV1 requires a real confirmedAt (confirmed ledger close time).'
    )
  return {
    version: 1,
    runId,
    owner,
    router,
    network: NETWORK_ID,
    txHash,
    confirmedLedger,
    expiryLedger,
    allowanceBudgets: allowanceBudgets.map((b) => ({
      token: b.token,
      units: typeof b.units === 'bigint' ? b.units.toString() : String(b.units),
      decimals: b.decimals,
    })),
    agentInitFingerprint,
    agentAddresses,
    confirmedAt: Number(confirmedAt),
  }
}

/** Persist a GrantReceiptV1, tagged with its own fingerprint for tamper detection on read. Only
 * call this after the grant's submission is confirmed on-chain (see module header). `network`
 * scopes the storage bucket (mirrors agentCache.js — typically NETWORK_PASSPHRASE) and is
 * DISTINCT from `receipt.network`, the fixed 'stellar-testnet' label inside the receipt itself. */
export function saveGrantReceipt({ receipt, network, storage }) {
  const all = readAll(storage)
  all[bucketKey({ owner: receipt.owner, router: receipt.router, network })] = {
    receipt,
    fingerprint: fingerprintGrantReceipt(receipt),
  }
  writeAll(all, storage)
}

/**
 * Load + verify the receipt for (owner, router, network). Returns null — never throws — for
 * anything that is not exactly right: nothing cached, corrupt JSON, a fingerprint mismatch
 * (tamper/corruption), or a stored receipt whose own owner/router fields disagree with the
 * bucket it was found in (cross-contamination guard). Missing/corrupt/wrong-owner/wrong-router
 * all collapse to the same null so callers cannot special-case a bad read into a good one.
 */
export function loadGrantReceipt({ owner, router, network, storage } = {}) {
  const row = readAll(storage)[bucketKey({ owner, router, network })]
  if (!row || !row.receipt) return null
  try {
    if (fingerprintGrantReceipt(row.receipt) !== row.fingerprint) return null
    if (row.receipt.owner !== owner || row.receipt.router !== router) return null
    return row.receipt
  } catch {
    return null
  }
}
