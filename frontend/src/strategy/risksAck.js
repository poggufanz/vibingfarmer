// frontend/src/strategy/risksAck.js
// P1 G7: the once-per-wallet "I understand the risks" acknowledgement behind the first grant.
// The gate predicate reuses the grant receipt as its first-grant detector — the same
// loadGrantReceipt seam money/activeGrant.js reads for the persistent widget — instead of
// inventing a second one: no receipt for this owner means this wallet never completed a grant,
// so the Risks gate must show once. An owner who granted on another device (receipt absent but
// allowance live) still sees it once here; that is consent recorded on THIS device, not a
// second grant flow.
//
// Storage mirrors grantReceiptStore.js's own shape (one JSON object under one key, fingerprint
// discipline unnecessary here — the value is a timestamp, and a tampered row can only force the
// modal to show again, never skip it). Every function is fail-closed and never throws:
// unreadable storage reads as "no ack" (show the gate), unwritable storage just skips the
// persist (the gate reappears next time, the grant itself is never blocked by a cache write).
import { loadGrantReceipt } from '../stellar/grantReceiptStore.js'
import { SOROBAN_FUNDING_ROUTER_ADDRESS } from '../stellar/config.js'

const ACK_STORE_KEY = 'vf.risksAck.v1'

let _memFallback = null

function resolveStorage(injected) {
  if (injected) return injected
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch {
    // Private-mode/SSR: fall through to memory.
  }
  if (!_memFallback) _memFallback = new Map()
  return {
    getItem: (k) => (_memFallback.has(k) ? _memFallback.get(k) : null),
    setItem: (k, v) => {
      _memFallback.set(k, String(v))
    },
  }
}

function ackKey(owner) {
  return `${ACK_STORE_KEY}:${owner}`
}

/**
 * Load this wallet's acknowledgement ({ ackedAt: ms } or null). Never throws.
 */
export function loadRisksAck({ owner, storage } = {}) {
  if (!owner) return null
  try {
    const raw = resolveStorage(storage).getItem(ackKey(owner))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !Number.isFinite(parsed.ackedAt)) return null
    return { ackedAt: parsed.ackedAt }
  } catch {
    return null
  }
}

/**
 * Record this wallet's acknowledgement. Returns true when persisted; false (never a throw)
 * when storage is unwritable — the grant proceeds, the gate simply reappears next time.
 */
export function saveRisksAck({ owner, storage, nowMs = Date.now() } = {}) {
  if (!owner) return false
  try {
    resolveStorage(storage).setItem(ackKey(owner), JSON.stringify({ ackedAt: nowMs }))
    return true
  } catch {
    return false
  }
}

export function hasRisksAck({ owner, storage } = {}) {
  return loadRisksAck({ owner, storage }) !== null
}

/**
 * Does this owner still owe the Risks acknowledgement before a fresh grant? True only when
 * BOTH are missing: no stored ack on this device AND no grant receipt for (owner, router)
 * (loadGrantReceipt is fingerprint-verified and null-safe, so a corrupt row reads as "first
 * grant", the safe side). A wallet switch changes `owner`, so each wallet acknowledges on its
 * own — never inherited, never skipped. Never throws.
 */
export function needsRisksAck({
  owner,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  storage,
} = {}) {
  if (!owner) return false
  try {
    if (hasRisksAck({ owner, storage })) return false
    return loadGrantReceipt({ owner, router, storage }) === null
  } catch {
    return true
  }
}
