// frontend/src/wallet/baseBinding.js
// Owner-scoped Base client state (VF Wallet Task 6, pocket-crew-vfw-task-6; v3 mandate records
// from the cross-chain hardening plan Task 6). The web app's connected Stellar identity —
// `stellarOwner`, whatever connectWallet()/StellarWalletsKit reports (Freighter/xBull/Albedo/VF
// Wallet) — scopes every Base owner/mandate record so a wallet switch can never inherit another
// wallet's kernel or mandate, and an old global record never gets silently adopted by whichever
// wallet happens to connect first.
//
// Cryptographic-boundary note (binding plan §4): the ZeroDev kernel/session policy itself is
// cryptographically enforced on-chain. The stellarOwner <-> kernelAddress association recorded
// here is an APPLICATION/RELAYER binding, not a cryptographic one — nothing in this module signs
// that link. Never describe the association itself as cryptographic in UI copy or tests.
//
// v3 mandate records (`vf_base_mandate_v3:<normalized-owner>`) hold ONLY public, secret-free
// evidence: the mandate ID, public binding identity/evidence, and `validUntilSeconds`. They
// never contain a capability, session private key, serialized approval, bearer token, or cookie
// value — the exact top-level allowlist below is enforced on every read. Legacy global
// (`vf_base_mandate`) and owner-scoped v2 (`vf_base_mandate_v2:<owner>`) records carried a
// serialized approval, so they are actively REMOVED when encountered here, never adopted or
// dual-written; there is deliberately no global fallback reader anywhere in the app.

import { isVerifiedBaseMandateStatus } from '../base/mandateStatus.js'

const OWNER_PREFIX = 'vf_base_owner_v2:'
const MANDATE_PREFIX = 'vf_base_mandate_v3:'
const LEGACY_MANDATE_GLOBAL_KEY = 'vf_base_mandate'
const LEGACY_MANDATE_V2_PREFIX = 'vf_base_mandate_v2:'

// The exact public fields a v3 mandate record may carry (Task 6 secret-free storage contract).
// Coupling by design: the persisted active record is exactly the relayer's scrubbed status body,
// so the relayer must NOT add fields to that body without migrating this allowlist first — any
// extra field makes stored records self-delete (fail-closed) on next read.
const MANDATE_V3_KEYS = Object.freeze([
  'version',
  'mandateId',
  'stellarOwner',
  'kernelAddress',
  'sessionKeyAddress',
  'relayerOrigin',
  'validUntilSeconds',
  'status',
  'bindingId',
  'bindingHash',
  'reasonCodes',
  'expected',
  'observed',
  'checks',
])

function store(storage) {
  return storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
}

// Owner identity is normalized for stable storage addressing/comparison only (whitespace is
// never significant in a Stellar StrKey); the canonical StrKey itself is never mutated before
// being sent to the relayer. EVM addresses are case-insensitive (checksum casing carries no
// semantic meaning), so kernel/session comparisons lowercase; Stellar G-addresses are already
// canonical uppercase base32 and compare exactly.
function normalizeOwner(stellarOwner) {
  return typeof stellarOwner === 'string' ? stellarOwner.trim() : ''
}

function sameAddress(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
}

export function baseOwnerStorageKey(stellarOwner) {
  if (!stellarOwner) throw new Error('baseOwnerStorageKey: stellarOwner is required')
  return `${OWNER_PREFIX}${stellarOwner}`
}

export function baseMandateStorageKey(stellarOwner) {
  const normalized = normalizeOwner(stellarOwner)
  if (!normalized) throw new Error('baseMandateStorageKey: stellarOwner is required')
  return `${MANDATE_PREFIX}${normalized}`
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
 * Reads the owner-scoped v3 mandate record. Any record outside the exact public allowlist —
 * malformed JSON, wrong version, an unexpected field, or any secret-shaped field such as
 * `serializedApproval`/`capability`/`sessionPrivateKey` — is REMOVED and read back as null
 * rather than trusted. Legacy global/v2 mandate keys encountered along the way are removed too:
 * they carry an approval blob and must never be adopted on a wallet switch.
 * @param {string} stellarOwner
 * @param {object} [storage] injectable storage (tests); defaults to the global localStorage.
 * @returns {object|null} the stored v3 record (see MANDATE_V3_KEYS), or null
 */
export function readBaseMandate(stellarOwner, storage) {
  const s = store(storage)
  const normalized = normalizeOwner(stellarOwner)
  if (!s || !normalized) return null
  // Fail closed on legacy authority: delete on encounter, never fall back to it.
  s.removeItem(LEGACY_MANDATE_GLOBAL_KEY)
  s.removeItem(`${LEGACY_MANDATE_V2_PREFIX}${normalized}`)
  const key = baseMandateStorageKey(normalized)
  let record
  try {
    record = JSON.parse(s.getItem(key) || 'null')
  } catch {
    s.removeItem(key)
    return null
  }
  if (record === null) return null
  const allowlisted =
    !!record &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    record.version === 3 &&
    Object.keys(record).every((field) => MANDATE_V3_KEYS.includes(field))
  if (!allowlisted) {
    s.removeItem(key)
    return null
  }
  return record
}

/**
 * Fail-closed status classifier for a secret-free BaseMandateRecordV3. Binding mismatches (wrong
 * owner, wrong kernel, wrong session key, wrong relayer origin) are checked BEFORE expiry, so a
 * wrong-owner record is reported as `mismatched`, never softened to merely `expired`. A locally
 * labelled `active` record only classifies as `active` when it ALSO carries remotely verified
 * activation evidence (isVerifiedBaseMandateStatus); pending/uncertain activations and any other
 * unverified state classify as `unavailable`. `now` is injectable (tests); defaults to the wall
 * clock in unix seconds, matching the relayer's `validUntilSeconds` contract.
 * @param {object|null} record
 * @param {{stellarOwner?:string, kernelAddress?:string, sessionKeyAddress?:string, relayerOrigin?:string, now?:number}} [expected]
 * @returns {'active'|'expired'|'revoked'|'missing'|'mismatched'|'unavailable'}
 */
export function validateBaseMandate(record, expected = {}) {
  if (!record || record.version !== 3) return 'missing'
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
  if (record.status === 'expired') return 'expired'
  if (record.validUntilSeconds != null && record.validUntilSeconds <= now) return 'expired'
  if (record.status !== 'active') return 'unavailable'
  return isVerifiedBaseMandateStatus(record) ? 'active' : 'unavailable'
}
