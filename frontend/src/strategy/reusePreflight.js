// frontend/src/strategy/reusePreflight.js
// Strategy Task 5 (Pocket Crew redesign, Wave 1). The proof-carrying fresh/reuse permission
// preflight: decides whether an already-reviewed set of AgentInits can be satisfied by EXISTING,
// on-chain-verified permissions (reuse — zero further wallet signatures) or must go through a
// fresh `funding_router.grant` (one signature). ALL-OR-NOTHING: any missing, unproven, or
// mismatched element anywhere — the stored grant receipt, its re-proven allowance, or any single
// reviewed agent's on-chain scope — forces a COMPLETE fresh decision with a specific
// `freshReason`. A Base (bridge) allocation always forces fresh; it is never reused.
//
// `preflightPermission` NEVER calls a wallet, a provider, or a transaction builder — every chain
// read (`loadReceipt`, `proveAllowance`, `inspectAgents`) is dependency-injected, so this module
// degrades to a pure function under test and can never itself move funds or request a signature.
import { hash, StrKey } from '@stellar/stellar-sdk'
import { canonicalizeStrategy } from './canonicalStrategy.js'
import { AGENT_KIND_BRIDGE } from '../stellar/grant.js'
import { loadGrantReceipt, fingerprintGrantReceipt } from '../stellar/grantReceiptStore.js'
import { proveCurrentAllowance } from '../stellar/allowanceProof.js'
import {
  inspectReusableAgents,
  scopeHeadroom,
  EXPIRY_MARGIN_SECONDS,
} from '../stellar/agentCache.js'
import { newSessionKey } from '../stellar/sessionKey.js'
import { resolveRouterSchema } from '../stellar/routerSchema.js'
import { proveReusablePermission } from './permissionGrantV3.js'
import { SOROBAN_FUNDING_ROUTER_ADDRESS, NETWORK_PASSPHRASE } from '../stellar/config.js'

// Mirrors grant.js's SECONDS_PER_LEDGER (not exported there — testnet's ~5s/ledger convention).
// Used only to translate the agentCache expiry safety margin into ledger-space for the
// allowance-level expiry check (the per-agent scope check compares against wall-clock nowSec
// directly via agentCache's own EXPIRY_MARGIN_SECONDS).
const SECONDS_PER_LEDGER = 5
const ALLOWANCE_EXPIRY_MARGIN_LEDGERS = Math.ceil(EXPIRY_MARGIN_SECONDS / SECONDS_PER_LEDGER)

// Native hex-encode (no `Buffer` global — this file is not on the browser-polyfill allowlist in
// eslint.config.js, and hash()/Uint8Array already give us everything we need without it).
function bytesToHex(b) {
  return b ? Array.from(b, (byte) => byte.toString(16).padStart(2, '0')).join('') : null
}

function sha256Hex(obj) {
  const payload = JSON.stringify(canonicalizeStrategy(obj))
  return '0x' + hash(payload).toString('hex') // hash() accepts a string directly (no Buffer needed)
}

function capView(cap) {
  return { token: cap.token, units: String(cap.units), decimals: cap.decimals }
}

function hexToBytes(hex) {
  if (!hex) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}

// --- PreparedExecutionV1 (critical fix, review round 2) -------------------------------------
// A reviewed FRESH decision must bind the EXACT signer/salt a later grant deploys with — the
// review's `agentInitFingerprint`/`reviewedAgentInits[].signerFingerprint`/`.saltFingerprint`
// are meaningless promises otherwise. `preflightPermission` generates this material ONCE, the
// very first time an allocation is reviewed without caller-supplied secrets, and persists it here
// so every later call for the SAME (owner, planFingerprint, allocationId) — another preflight
// deciding fresh-vs-reuse, or dispatch actually building the grant — resolves the IDENTICAL
// material instead of silently minting a new, unreviewed one. Mirrors grantReceiptStore.js's own
// localStorage-with-in-memory-fallback pattern; kept local to this file (no new shared module)
// since only this file ever needs to generate or resolve it — dispatch only ever *fetches* and
// *verifies* it via `fetchPreparedExecutionMaterial` below, never generates its own.
const PREPARED_STORE_KEY = 'vf.preparedExecution.v1'

let _preparedMemStore = null
function resolvePreparedStorage(injected) {
  if (injected) return injected
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch {
    /* SecurityError in some embeds — fall through */
  }
  if (!_preparedMemStore) {
    const m = new Map()
    _preparedMemStore = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
    }
  }
  return _preparedMemStore
}

function readAllPrepared(storage) {
  try {
    return JSON.parse(resolvePreparedStorage(storage).getItem(PREPARED_STORE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function writeAllPrepared(all, storage) {
  try {
    resolvePreparedStorage(storage).setItem(PREPARED_STORE_KEY, JSON.stringify(all))
  } catch {
    /* quota/serialization failure — best-effort, never fatal */
  }
}

function preparedKey({ owner, planFingerprint, allocationId }) {
  return `${owner}|${planFingerprint}|${allocationId}`
}

/**
 * Load previously-prepared execution material for one (owner, planFingerprint, allocationId), or
 * null if nothing has been generated yet. `signer`/`salt` are raw bytes ready to hand straight to
 * `agentInitScVal`/`fingerprintAgentInits`; `signerSecret` is the S... secret dispatch needs to
 * actually sign with (never returned in any PermissionDecisionV1 — see `fetchPreparedExecutionMaterial`).
 * @returns {{signer:Uint8Array, salt:Uint8Array, signerSecret:string}|null}
 */
export function loadPreparedExecutionMaterial({ owner, planFingerprint, allocationId, storage }) {
  const row = readAllPrepared(storage)[preparedKey({ owner, planFingerprint, allocationId })]
  if (!row) return null
  return {
    signer: hexToBytes(row.signerRawHex),
    salt: hexToBytes(row.saltHex),
    signerSecret: row.signerSecret,
  }
}

function savePreparedExecutionMaterial({ owner, planFingerprint, allocationId, storage }) {
  const sessionKey = newSessionKey()
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const all = readAllPrepared(storage)
  all[preparedKey({ owner, planFingerprint, allocationId })] = {
    signerRawHex: bytesToHex(sessionKey.rawPublicKey),
    saltHex: bytesToHex(salt),
    signerSecret: sessionKey.secret,
  }
  writeAllPrepared(all, storage)
  return { signer: sessionKey.rawPublicKey, salt, signerSecret: sessionKey.secret }
}

/**
 * For every agentInit the caller did NOT already supply real signer+salt for (reuse-revalidation
 * always supplies both, restored from agentCache.js — that always wins here, untouched), resolve
 * previously-prepared material for its (owner, planFingerprint, allocationId), or generate +
 * persist NEW material now. Generation happens AT MOST ONCE per allocation, ever — a second call
 * for the same (owner, planFingerprint, allocationId) always finds the row this wrote.
 */
function resolvePreparedMaterial(agentInits, { owner, planFingerprint, storage }) {
  return agentInits.map((a) => {
    if (a.signer && a.salt) return a
    const existing = loadPreparedExecutionMaterial({
      owner,
      planFingerprint,
      allocationId: a.allocationId,
      storage,
    })
    const material =
      existing ||
      savePreparedExecutionMaterial({
        owner,
        planFingerprint,
        allocationId: a.allocationId,
        storage,
      })
    return { ...a, signer: material.signer, salt: material.salt }
  })
}

/**
 * Fetch + verify previously-prepared execution material against an already-reviewed
 * `reviewedAgentInit` (a `PermissionDecisionV1.reviewedAgentInits[i]` entry). Returns null — never
 * throws — when nothing is stored OR when the stored material's own fingerprints no longer equal
 * `reviewedAgentInit.signerFingerprint`/`.saltFingerprint`: dispatch's ONLY correct response to a
 * null here is to invalidate the reviewed run (`PermissionPhaseError`), never to generate new
 * material and proceed — that would be exactly the poisoning bug this store exists to prevent.
 * @returns {{signer:Uint8Array, salt:Uint8Array, signerSecret:string}|null}
 */
export function fetchPreparedExecutionMaterial({
  owner,
  planFingerprint,
  allocationId,
  reviewedAgentInit,
  storage,
}) {
  const material = loadPreparedExecutionMaterial({ owner, planFingerprint, allocationId, storage })
  if (!material) return null
  const signerFingerprint = sha256Hex(bytesToHex(material.signer))
  const saltFingerprint = sha256Hex(bytesToHex(material.salt))
  if (
    signerFingerprint !== reviewedAgentInit?.signerFingerprint ||
    saltFingerprint !== reviewedAgentInit?.saltFingerprint
  ) {
    return null
  }
  return material
}

/** Plain hashable record for one raw AgentInit — raw signer/salt/mintRecipient bytes hex-encoded
 * (canonicalizeStrategy has no bigint/byte-array awareness beyond what it is handed). */
function agentInitCanonical(a) {
  return {
    allocationId: a.allocationId,
    kind: Number(a.kind),
    token: a.token,
    target: a.target,
    cap: capView(a.cap),
    periodSeconds: Number(a.periodSeconds),
    expiry: Number(a.expiry),
    signer: bytesToHex(a.signer),
    salt: bytesToHex(a.salt),
    destinationDomain: Number(a.destinationDomain ?? 0),
    mintRecipient: bytesToHex(a.mintRecipient),
  }
}

/**
 * Deterministic 0x-prefixed sha256 fingerprint of an exact reviewed AgentInit list. Array order
 * is preserved (agent order is semantically meaningful — matches canonicalizeStrategy's rule).
 * @param {Array<object>} agentInits raw AgentInit specs (grant.js-shaped, plus allocationId/cap)
 * @returns {string}
 */
export function fingerprintAgentInits(agentInits) {
  return sha256Hex(agentInits.map(agentInitCanonical))
}

/** Journal/UI-safe projection of one raw AgentInit: raw signer/salt bytes replaced by fingerprints. */
function toReviewedAgentInit(a) {
  return {
    allocationId: a.allocationId,
    kind: Number(a.kind),
    token: a.token,
    target: a.target,
    cap: capView(a.cap),
    periodSeconds: Number(a.periodSeconds),
    expiry: Number(a.expiry),
    signerFingerprint: sha256Hex(bytesToHex(a.signer)),
    saltFingerprint: a.salt ? sha256Hex(bytesToHex(a.salt)) : null,
    destinationDomain: Number(a.destinationDomain ?? 0),
    mintRecipient: bytesToHex(a.mintRecipient),
  }
}
// Note: `reviewedAgentInits[i].allocationId` (above) already IS the prepared-execution store's
// lookup key (`fetchPreparedExecutionMaterial({owner, planFingerprint, allocationId, ...})`) — no
// separate `executionCredentialRef` field is needed here, unlike the reuse-selection `agents[]`
// array below, whose ref (a deployed agentAddress) genuinely isn't derivable from anything else
// already on that row.

function budgetsView(budgets) {
  return (budgets || []).map((b) => ({
    token: b.token,
    units: String(b.units),
    decimals: b.decimals,
  }))
}

function baseDecision({
  runId,
  owner,
  planFingerprint,
  agentInitFingerprint,
  checkedAt,
  reviewedBudgets,
  durationSeconds,
  reviewedAgentInits,
}) {
  return {
    version: 1,
    runId,
    owner,
    planFingerprint,
    agentInitFingerprint,
    checkedAt,
    reviewedBudgets,
    durationSeconds,
    reviewedAgentInits,
  }
}

function freshDecision(base, freshReason) {
  return {
    ...base,
    mode: 'fresh',
    confirmationCount: 1,
    grantReceiptFingerprint: null,
    allowanceExpiryProof: null,
    agents: [],
    freshReason,
  }
}

function reuseDecision(base, { grantReceiptFingerprint, allowanceExpiryProof, agents }) {
  return {
    ...base,
    mode: 'reuse',
    confirmationCount: 0,
    grantReceiptFingerprint,
    allowanceExpiryProof,
    agents,
    freshReason: null,
  }
}

/** Does the cached entry's LOCAL session pubkey (a G... strkey) equal the on-chain `signer()`
 * read (raw ed25519 bytes)? Verifies we still hold the working key for this on-chain scope —
 * never trust a cache hit whose local key has silently drifted from the chain's own record. */
function signerMatches(entrySignerPub, onChainSigner) {
  if (!entrySignerPub || !onChainSigner) return false
  try {
    const local = StrKey.decodeEd25519PublicKey(entrySignerPub)
    return bytesToHex(local) === bytesToHex(onChainSigner)
  } catch {
    return false
  }
}

/** Structural validity of one candidate row against one reviewed AgentInit — everything scope_of()
 * itself asserts before a deposit would succeed, plus the signer-possession check above. */
function scopeStructurallyValid(row, agentInit, { owner, nowSec }) {
  const s = row.scope
  return (
    String(s.owner) === String(owner) &&
    String(s.target ?? s.vault) === String(agentInit.target) &&
    String(s.token) === String(agentInit.token) &&
    Number(s.kind) === Number(agentInit.kind) &&
    Number(s.period_duration) === Number(agentInit.periodSeconds) &&
    BigInt(s.cap_per_period ?? 0) >= BigInt(agentInit.cap.units) &&
    !s.revoked &&
    Number(s.expiry ?? 0) > nowSec + EXPIRY_MARGIN_SECONDS &&
    signerMatches(row.entry?.signerPub, row.signer)
  )
}

/**
 * For every reviewed AgentInit (array order), find one on-chain-verified, not-yet-claimed cached
 * agent that structurally satisfies it. ALL-OR-NOTHING: the first AgentInit that cannot be
 * satisfied determines the single freshReason for the WHOLE decision (a partially-reusable set is
 * never partially accepted). Priority per AgentInit when multiple candidates fail differently:
 * no candidates at all > an unread (null) scope > a structural mismatch > insufficient headroom —
 * "do we have anything" before "could we read it" before "is it the right shape" before "enough
 * left to spend."
 *
 * `candidatesByTarget`'s per-target list is not part of any contract — it is whatever order
 * `inspectAgents` (a chain read) happened to return. Candidates are therefore canonicalized here
 * (sorted by `agentAddress`, the same convention permissionGrantV3.js's V3 assignment uses) before
 * the claim loop below runs, so which agent an allocation binds to is a pure function of the
 * candidate SET, never of read order — a reordered re-read of the identical set can never
 * reassign which agent serves which allocation.
 */
function selectAgents(agentInits, candidatesByTarget, { owner, nowSec }) {
  const used = new Set()
  const agents = []
  for (const a of agentInits) {
    const candidates = (candidatesByTarget.get(a.target) || [])
      .filter((c) => !used.has(c.agentAddress))
      .sort((x, y) => (x.agentAddress < y.agentAddress ? -1 : 1))
    if (candidates.length === 0) return { ok: false, reason: 'agent-missing' }
    if (candidates.some((c) => c.scope == null)) return { ok: false, reason: 'scope-unavailable' }
    const structural = candidates.filter((c) => scopeStructurallyValid(c, a, { owner, nowSec }))
    if (structural.length === 0) return { ok: false, reason: 'scope-invalid' }
    const required = BigInt(a.cap.units)
    const withHeadroom = structural.find((c) => scopeHeadroom(c.scope, nowSec) >= required)
    if (!withHeadroom) return { ok: false, reason: 'headroom-insufficient' }

    used.add(withHeadroom.agentAddress)
    const headroom = scopeHeadroom(withHeadroom.scope, nowSec)
    agents.push({
      allocationId: a.allocationId,
      workerId: a.allocationId,
      agentAddress: withHeadroom.agentAddress,
      headroom: { token: a.token, units: headroom.toString(), decimals: a.cap.decimals },
      scopeExpiry: Number(withHeadroom.scope.expiry),
      scopeFingerprint: withHeadroom.scopeFingerprint,
      // The credential store is agentCache.js itself (keyed by agentAddress) — this REFERENCE is
      // the address, never the secret. See module header + toPermissionDecisionView below.
      executionCredentialRef: withHeadroom.agentAddress,
    })
  }
  return { ok: true, agents }
}

/**
 * Decide fresh vs. reuse for an exact reviewed set of AgentInits. Never calls a wallet, provider,
 * or transaction builder — `loadReceipt` / `proveAllowance` / `inspectAgents` are the only V2
 * chain touchpoints, all dependency-injected (default to the real implementations).
 *
 * Router-generation branch (Task 5 chunk A): when `resolveSchema(router)` resolves version 3,
 * this function does none of the above and instead delegates whole-hog to
 * `permissionGrantV3.proveReusablePermission`, threading through the params below it (distinct
 * names from the V2 seam because the signatures/return shapes differ — V2 reads a stored
 * GrantReceiptV1, V3 reads a bounded on-chain permission record directly). `resolveSchema`
 * defaults to the real `resolveRouterSchema`, which resolves NO V3 address today (THE DORMANCY
 * CONTRACT, permissionGrantV3.js's own header) — every V2 caller of this function is therefore
 * unaffected, and the V3 branch is reachable only by injecting `resolveSchema` in a test.
 * @param {{runId, owner, router?, planFingerprint, agentInits:Array, reviewedBudgets:Array,
 *          durationSeconds:number, nowSec?:number, network?:string, server?:object, storage?:object,
 *          loadReceipt?:Function, proveAllowance?:Function, inspectAgents?:Function,
 *          resolveSchema?:Function, permissionId?:string, activeAccount?:object,
 *          getCurrentActiveAccount?:Function, approval?:object, currentLedger?:number,
 *          readPermissionGrant?:Function, readRemainingBudget?:Function,
 *          proveAllowanceV3?:Function, inspectAgentsV3?:Function, fetchCredential?:Function}} p
 * @returns {Promise<object>} PermissionDecisionV1 (V2 router) or permissionGrantV3's decision (V3 router)
 */
export async function preflightPermission({
  runId,
  owner,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  planFingerprint,
  agentInits,
  reviewedBudgets,
  durationSeconds,
  nowSec = Math.floor(Date.now() / 1000),
  network = NETWORK_PASSPHRASE,
  server,
  storage,
  loadReceipt = loadGrantReceipt,
  proveAllowance = proveCurrentAllowance,
  inspectAgents = inspectReusableAgents,
  // --- V3 router-generation branch only (Task 5 chunk A) — untouched by, and never read on, the
  // V2 path below. See THE DORMANCY CONTRACT note above.
  resolveSchema = resolveRouterSchema,
  permissionId,
  activeAccount,
  getCurrentActiveAccount,
  approval,
  currentLedger,
  readPermissionGrant,
  readRemainingBudget,
  proveAllowanceV3,
  inspectAgentsV3,
  fetchCredential,
}) {
  if (!agentInits || agentInits.length === 0) {
    throw new Error('preflightPermission requires at least one reviewed agent.')
  }

  if (resolveSchema(router)?.version === 3) {
    return proveReusablePermission({
      runId,
      owner,
      router,
      network,
      planFingerprint,
      permissionId,
      activeAccount,
      getCurrentActiveAccount,
      approval,
      agentInits,
      currentLedger,
      nowSec,
      server,
      storage,
      resolveSchema,
      readPermissionGrant,
      readRemainingBudget,
      proveAllowance: proveAllowanceV3,
      inspectAgents: inspectAgentsV3,
      fetchCredential,
    })
  }

  // Critical fix (review round 2): resolve real signer/salt material BEFORE fingerprinting or
  // deciding anything. A caller that already supplied real signer+salt (reuse-revalidation,
  // restored from agentCache.js) is used exactly as given; anything else gets previously-prepared
  // material back, or fresh material generated + persisted right now — either way, every fact
  // this function returns (the fingerprint, `reviewedAgentInits[].signerFingerprint/saltFingerprint`)
  // describes the SAME material a later `fetchPreparedExecutionMaterial` call will resolve, never
  // a placeholder that a subsequent grant then silently replaces.
  const resolvedAgentInits = resolvePreparedMaterial(agentInits, {
    owner,
    planFingerprint,
    storage,
  })

  const agentInitFingerprint = fingerprintAgentInits(resolvedAgentInits)
  const base = baseDecision({
    runId,
    owner,
    planFingerprint,
    agentInitFingerprint,
    checkedAt: nowSec,
    reviewedBudgets: budgetsView(reviewedBudgets),
    durationSeconds,
    reviewedAgentInits: resolvedAgentInits.map(toReviewedAgentInit),
  })

  // Base allocations are never reused, and never even attempt a proof for the rest of the run —
  // a Base leg always needs a fresh mandate + CCTP burn.
  if (resolvedAgentInits.some((a) => Number(a.kind) === AGENT_KIND_BRIDGE)) {
    return freshDecision(base, 'base-required')
  }

  const receipt = loadReceipt({ owner, router, network, storage })
  if (!receipt || receipt.agentInitFingerprint !== agentInitFingerprint) {
    return freshDecision(base, 'allowance-proof-missing')
  }

  const { proven, reason, proof } = await proveAllowance({ receipt, server, storage })
  if (!proven) {
    return freshDecision(
      base,
      reason === 'mutated' ? 'allowance-mutated' : 'allowance-proof-gapped'
    )
  }

  // Allowance sufficiency: the proven current amount per token must cover what THIS reviewed set
  // now needs, and the receipt's own expiry must still clear the ledger-space safety margin.
  const requiredByToken = new Map()
  for (const a of resolvedAgentInits) {
    requiredByToken.set(a.token, (requiredByToken.get(a.token) ?? 0n) + BigInt(a.cap.units))
  }
  for (const [token, required] of requiredByToken) {
    const approval = proof.approvals.find((ap) => ap.amount.token === token)
    if (!approval || BigInt(approval.amount.units) < required) {
      return freshDecision(base, 'allowance-insufficient')
    }
  }
  if (receipt.expiryLedger <= proof.latestLedger + ALLOWANCE_EXPIRY_MARGIN_LEDGERS) {
    return freshDecision(base, 'allowance-insufficient')
  }

  // Per-agent on-chain scope validation, ALL-OR-NOTHING across every reviewed allocation.
  const targets = [...new Set(resolvedAgentInits.map((a) => a.target))]
  const candidatesByTarget = new Map()
  for (const target of targets) {
    candidatesByTarget.set(
      target,
      await inspectAgents({ owner, vault: target, network, nowSec, server, storage })
    )
  }
  const selection = selectAgents(resolvedAgentInits, candidatesByTarget, { owner, nowSec })
  if (!selection.ok) return freshDecision(base, selection.reason)

  return reuseDecision(base, {
    grantReceiptFingerprint: fingerprintGrantReceipt(receipt),
    allowanceExpiryProof: proof,
    agents: selection.agents,
  })
}

/**
 * Secret-free projection of a PermissionDecisionV1 for UI state, journal records, events, and
 * logs. Strips `executionCredentialRef` from every agent row — the ONLY field on this object
 * that is a lookup key into secret material (agentCache.js), never the secret itself.
 *
 * Fix round 1 (Important 2): `decision.agents` is a V1-only field — a V3 decision
 * (permissionGrantV3.proveReusablePermission) carries `executions[]` instead and has no `agents`
 * at all, so this defaults to `[]` rather than assuming the V1 shape unconditionally. Note:
 * `orchestrator.js:950-952` has the SAME `decision.agents` assumption for a reuse decision and is
 * NOT fixed here — out of this chunk's scope (orchestrator.js is not in the file list) — see the
 * task report for that callout.
 * @param {object} decision PermissionDecisionV1 (or a V3 decision, which has no `agents`)
 * @returns {object}
 */
export function toPermissionDecisionView(decision) {
  return {
    ...decision,
    agents: (decision.agents ?? []).map(({ executionCredentialRef: _ref, ...rest }) => rest),
  }
}
