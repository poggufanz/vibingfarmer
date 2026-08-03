// frontend/src/wallet/baseBinding.js
// Owner-scoped Base client state (VF Wallet Task 6, pocket-crew-vfw-task-6). The web app's
// connected Stellar identity — `stellarOwner`, whatever connectWallet()/StellarWalletsKit
// reports (Freighter/xBull/Albedo/VF Wallet) — scopes every Base owner/mandate record so a
// wallet switch can never inherit another wallet's kernel or mandate, and an old global record
// never gets silently adopted by whichever wallet happens to connect first.
//
// Cryptographic-boundary note (binding plan §4): the ZeroDev kernel/session policy itself is
// cryptographically enforced on-chain. The stellarOwner <-> kernelAddress association recorded
// here is an APPLICATION/RELAYER binding, not a cryptographic one — nothing in this module signs
// that link. Never describe the association itself as cryptographic in UI copy or tests.
//
// This module only replaces the READ side of the old global keys (`vf_base_owner`,
// `vf_base_owner_address`, `vf_base_mandate`). Those keys are not deleted by this file — the
// writers (wallet/passkeyBridge.js, mergeFlowHelpers.js) dual-write both shapes until every
// consumer has migrated onto readBaseOwner/readBaseMandate (task Step 2). A pre-migration owner
// therefore has no v2 record yet: reads return null rather than falling back to the old global
// key, so the UI can prompt "Set up Base testnet again" instead of guessing which wallet a
// leftover global record belonged to.

const OWNER_PREFIX = 'vf_base_owner_v2:'
const MANDATE_PREFIX = 'vf_base_mandate_v2:'

function store(storage) {
  return storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
}

// EVM addresses are case-insensitive (checksum casing carries no semantic meaning); Stellar
// G-addresses are already canonical uppercase base32. A plain lowercase compare is safe for both,
// so one helper covers stellarOwner, kernelAddress, and sessionKeyAddress comparisons alike.
function sameAddress(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
}

export function baseOwnerStorageKey(stellarOwner) {
  if (!stellarOwner) throw new Error('baseOwnerStorageKey: stellarOwner is required')
  return `${OWNER_PREFIX}${stellarOwner}`
}

export function baseMandateStorageKey(stellarOwner) {
  if (!stellarOwner) throw new Error('baseMandateStorageKey: stellarOwner is required')
  return `${MANDATE_PREFIX}${stellarOwner}`
}

// Shared self-heal: a corrupt record (malformed JSON, or a pre-v2 shape written before this task)
// reads back as "nothing stored" rather than throwing or being trusted half-parsed.
function readV2(key, storage) {
  const s = store(storage)
  if (!s || !key) return null
  let record
  try {
    record = JSON.parse(s.getItem(key) || 'null')
  } catch {
    return null
  }
  if (!record || record.version !== 2) return null
  return record
}

/**
 * @param {string} stellarOwner
 * @param {object} [storage] injectable storage (tests); defaults to the global localStorage.
 * @returns {{version:2, stellarOwner:string, kernelAddress:string, passkeyName:string, createdAt:number, updatedAt:number}|null}
 */
export function readBaseOwner(stellarOwner, storage) {
  if (!stellarOwner) return null
  return readV2(baseOwnerStorageKey(stellarOwner), storage)
}

/**
 * @param {string} stellarOwner
 * @param {object} [storage] injectable storage (tests); defaults to the global localStorage.
 * @returns {{version:2, stellarOwner:string, kernelAddress:string, serializedApproval:string,
 *   sessionKeyAddress:string, relayerOrigin:string|null, expiresAt:number, status:string,
 *   bindingId:string|null, bindingHash:string|null, createdAt:number}|null}
 */
export function readBaseMandate(stellarOwner, storage) {
  if (!stellarOwner) return null
  return readV2(baseMandateStorageKey(stellarOwner), storage)
}

/**
 * Fail-closed status classifier for a BaseMandateRecordV2. Binding mismatches (wrong owner,
 * wrong kernel, wrong session key, wrong relayer origin) are checked BEFORE expiry, so a
 * wrong-owner record is reported as `mismatched`, never softened to merely `expired`. `now` is
 * injectable (tests); defaults to the wall clock in unix seconds, matching every other expiry
 * field in this codebase (mergeFlowHelpers.js's `expiry`, wallet/mandate.js's `expiry`).
 * @param {object|null} record
 * @param {{stellarOwner?:string, kernelAddress?:string, sessionKeyAddress?:string, relayerOrigin?:string, now?:number}} [expected]
 * @returns {'active'|'expired'|'revoked'|'missing'|'mismatched'|'unknown'}
 */
export function validateBaseMandate(record, expected = {}) {
  if (!record || record.version !== 2) return 'missing'
  const {
    stellarOwner,
    kernelAddress,
    sessionKeyAddress,
    relayerOrigin,
    now = Math.floor(Date.now() / 1000),
  } = expected
  if (stellarOwner && record.stellarOwner !== stellarOwner) return 'mismatched'
  if (kernelAddress && !sameAddress(record.kernelAddress, kernelAddress)) return 'mismatched'
  if (sessionKeyAddress && !sameAddress(record.sessionKeyAddress, sessionKeyAddress)) {
    return 'mismatched'
  }
  if (relayerOrigin && record.relayerOrigin && record.relayerOrigin !== relayerOrigin) {
    return 'mismatched'
  }
  if (record.status === 'revoked') return 'revoked'
  if (record.expiresAt != null && record.expiresAt <= now) return 'expired'
  if (record.status && record.status !== 'active') return 'unknown'
  return 'active'
}
