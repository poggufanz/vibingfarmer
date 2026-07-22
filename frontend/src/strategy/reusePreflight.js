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
 */
function selectAgents(agentInits, candidatesByTarget, { owner, nowSec }) {
  const used = new Set()
  const agents = []
  for (const a of agentInits) {
    const candidates = (candidatesByTarget.get(a.target) || []).filter(
      (c) => !used.has(c.agentAddress)
    )
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
 * or transaction builder — `loadReceipt` / `proveAllowance` / `inspectAgents` are the only chain
 * touchpoints, all dependency-injected (default to the real implementations).
 * @param {{runId, owner, router?, planFingerprint, agentInits:Array, reviewedBudgets:Array,
 *          durationSeconds:number, nowSec?:number, network?:string, server?:object, storage?:object,
 *          loadReceipt?:Function, proveAllowance?:Function, inspectAgents?:Function}} p
 * @returns {Promise<object>} PermissionDecisionV1
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
}) {
  if (!agentInits || agentInits.length === 0) {
    throw new Error('preflightPermission requires at least one reviewed agent.')
  }

  const agentInitFingerprint = fingerprintAgentInits(agentInits)
  const base = baseDecision({
    runId,
    owner,
    planFingerprint,
    agentInitFingerprint,
    checkedAt: nowSec,
    reviewedBudgets: budgetsView(reviewedBudgets),
    durationSeconds,
    reviewedAgentInits: agentInits.map(toReviewedAgentInit),
  })

  // Base allocations are never reused, and never even attempt a proof for the rest of the run —
  // a Base leg always needs a fresh mandate + CCTP burn.
  if (agentInits.some((a) => Number(a.kind) === AGENT_KIND_BRIDGE)) {
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
  for (const a of agentInits) {
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
  const targets = [...new Set(agentInits.map((a) => a.target))]
  const candidatesByTarget = new Map()
  for (const target of targets) {
    candidatesByTarget.set(
      target,
      await inspectAgents({ owner, vault: target, network, nowSec, server, storage })
    )
  }
  const selection = selectAgents(agentInits, candidatesByTarget, { owner, nowSec })
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
 * @param {object} decision PermissionDecisionV1
 * @returns {object}
 */
export function toPermissionDecisionView(decision) {
  return {
    ...decision,
    agents: decision.agents.map(({ executionCredentialRef: _ref, ...rest }) => rest),
  }
}
