// frontend/src/money/ownerActions.js
// Pocket Crew "My money" Task 9: makes the owner's ACTIONS — full exit, partial exit, revoke —
// correct for both Stellar account models (G classic keypair, C passkey/VF Wallet smart account).
//
// This module owns PLANNING (which agents to target, whether a partial exit must truthfully fall
// back to a full owner exit, whether a revoke is safe to submit right now) and RECONCILING (what
// actually happened, re-read from chain — never an optimistic local guess). It does NOT re-derive
// how a transaction is signed/submitted for a G vs C owner — that adapter already exists
// (stellar/ownerAuthorization.js's resolveOwnerTxModel / submitOwnerAuthorizedTx) and every action
// this module plans for (stellar/exit.js's sweepAgents/ownerWithdraw, stellar/revoke.js's
// revokeAgentOnChain, stellar/partialWithdraw.js) already routes through it. Consuming that
// interface, not re-inventing a second G/C router, is the whole point of this file's existence.
import { MAX_AGENTS_PER_SWEEP } from '../stellar/exit.js'
import { nextReconciliationToken } from './freshness.js'

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function isKnownPositiveAmount(amount) {
  if (amount == null) return false
  try {
    return BigInt(amount.units) > 0n
  } catch {
    return false
  }
}

function isKnownZeroRead(read) {
  if (read?.state !== 'known' || read.amount == null) return false
  try {
    return BigInt(read.amount.units) === 0n
  } catch {
    return false
  }
}

function isKnownRead(read) {
  return read?.state === 'known' && read.amount != null
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Base bridge-agent/kernel involvement is visible on a money row two ways: a non-'idle' execution
// status (only ever set when a Base child association exists — readOwnerMoney.js's
// readOneAgentMoney), or a custody location/leg that is Base-side. Either is sufficient; neither
// is required to be BOTH known-positive — a queued/in-flight Base leg still means "this agent has
// a Base association" even before any amount there is confirmed.
function hasBaseAssociation(agent) {
  if (!agent) return false
  if (agent.executionStatus && agent.executionStatus !== 'idle') return true
  const baseish = (loc) => loc === 'base-proxy' || loc === 'in-transit'
  if (baseish(agent.custody?.location)) return true
  return (agent.custodyBreakdown ?? []).some((leg) => baseish(leg.location))
}

// ---------------------------------------------------------------------------------------------
// planFullExit
// ---------------------------------------------------------------------------------------------

// Full exit enumeration must include active, expired, revoked, AND revoked-but-funded agents —
// owner_withdraw has no scope gate on-chain (soroban/contracts/agent_account/src/lib.rs:
// owner.require_auth() only; unlike enforce()/enforce_exit(), it never checks scope.revoked or
// scope.expiry), so every one of these states remains genuinely withdrawable by the owner. This
// classification is informational only — it never filters `targets`.
function targetState(discoveryRow, moneyRow, nowSec) {
  if (discoveryRow.scopeReadStatus !== 'ok') return 'unknown'
  const revoked = Boolean(discoveryRow.revoked)
  const expiry = Number(discoveryRow.expiry ?? 0)
  const expired = Number.isFinite(expiry) && expiry > 0 && expiry <= nowSec
  const funded = isKnownPositiveAmount(moneyRow?.amount)
  if (revoked) return funded ? 'revoked-funded' : 'revoked'
  if (expired) return funded ? 'expired-funded' : 'expired'
  return 'active'
}

/**
 * Plan a full exit sweep. Pure — decides WHICH agents to target and how many owner-signed
 * confirmations that should cost; the actual chain calls stay in stellar/exit.js.
 * @param {{discovery:object, position:{agents:Array}, account:{kind:'G'|'C', address:string},
 *   now?:number}} p `discovery` is an OwnerDiscoveryV1 envelope (stellar/ownerDiscovery.js);
 *   `position` carries the raw per-agent money rows (readOwnerMoney.js's `.agents`, the same shape
 *   myMoneyModel.js's MoneySnapshot assembles) used only to flag revoked-but-funded agents.
 */
export function planFullExit({ discovery, position, account, now = Date.now() }) {
  const status = discovery?.status ?? 'unavailable'
  const rows = discovery?.agents ?? []
  const moneyByAddress = new Map((position?.agents ?? []).map((r) => [r.address, r]))
  const nowSec = Math.floor(now / 1000)

  // Targets are derived EXCLUSIVELY from the discovery envelope — never from `position` (or any
  // other externally supplied list) — so an address `position` happens to carry that discovery
  // never enumerated (a "foreign" agent, or plain stale data) can never become a sweep target.
  // Zero (blank) and duplicate addresses are dropped here too.
  const seen = new Set()
  const targets = []
  for (const row of rows) {
    const address = row?.address
    if (!address || seen.has(address)) continue
    seen.add(address)
    targets.push({ address, state: targetState(row, moneyByAddress.get(address), nowSec) })
  }

  if (status === 'unavailable' || targets.length === 0) {
    return {
      ok: false,
      kind: 'full-exit',
      known: false,
      label: null,
      limitation:
        status === 'unavailable'
          ? 'Agent discovery is unavailable — nothing can be exited right now.'
          : 'No agents were found to exit.',
      targets: [],
      batches: [],
      expectedConfirmations: 0,
      account: account ?? null,
      model: account?.kind ?? null,
    }
  }

  const known = status === 'complete'
  // The limitation is its OWN field, checked before any signing ceremony starts — never left as
  // prose in a label a caller could drop. A caller that ignores `limitation` still has it sitting
  // right next to `label`, not folded invisibly into it.
  const limitation = known
    ? null
    : 'Discovery could not enumerate every agent for this owner — this exits only the agents ' +
      'currently known, not a guaranteed full-account sweep.'

  const batches = chunk(
    targets.map((t) => t.address),
    MAX_AGENTS_PER_SWEEP
  )

  return {
    ok: true,
    kind: 'full-exit',
    known,
    label: known ? 'Exit all' : 'Exit known agents',
    limitation,
    targets,
    batches,
    // Batch splits (stellar/exit.js's MAX_AGENTS_PER_SWEEP) apply identically whichever model
    // signs — a G owner signs each batch's envelope directly, a C owner signs a Soroban auth entry
    // per batch via the relayer (ownerAuthorization.js) — the COUNT is the same either way; only
    // the ceremony per confirmation differs, which is stellar/exit.js's concern, not planning's.
    expectedConfirmations: batches.length,
    account: account ?? null,
    model: account?.kind ?? 'G',
  }
}

// ---------------------------------------------------------------------------------------------
// planPartialExit
// ---------------------------------------------------------------------------------------------

// The exit-signer's on-chain policy (enforce_exit, agent_account/src/account.rs) hard-rejects any
// context once scope.revoked or now >= scope.expiry — unlike owner_withdraw (owner.require_auth()
// only, no scope gate). A truthful plan must not attempt what the contract will refuse; it falls
// back to a full owner exit instead, which remains allowed by the contract model regardless of
// scope state.
function scopeBlocksExitSigner(agent, nowSec) {
  if (agent.scopeReadStatus !== 'ok') return 'scope-unknown'
  if (agent.revoked) return 'scope-revoked'
  const expiry = Number(agent.expiry ?? 0)
  if (Number.isFinite(expiry) && expiry > 0 && expiry <= nowSec) return 'scope-expired'
  return null
}

// Available Stellar-vault money for a partial exit, read from the per-leg breakdown FIRST — a
// split agent (Stellar + Base) reports custody.location:'unknown' by design (custody.js), and
// keying off that collapsed summary would miss real, known-positive vault money sitting right
// next to an unresolved or Base leg. Falls back to the whole-agent custody/amount only when there
// is no breakdown at all (the common, non-split case, where custody.location IS the one real
// location).
function stellarVaultMaxUnits(agent) {
  const legs = agent.custodyBreakdown?.length
    ? agent.custodyBreakdown
    : agent.custody?.location
      ? [{ location: agent.custody.location, amount: agent.amount }]
      : []
  const leg = legs.find((l) => l.location === 'stellar-vault')
  if (!leg?.amount?.units) return null
  try {
    return BigInt(leg.amount.units)
  } catch {
    return null
  }
}

/**
 * Plan a partial exit from ONE agent. Pure. Either a real partial-exit plan, a truthful fallback
 * to full exit (revoked/expired scope), or a rejection (bad amount, balance unknown/insufficient).
 * @param {{agent:object, amount:{token:string, units:string, decimals:number},
 *   account:{kind:'G'|'C', address:string}, now?:number}} p `agent` is one readOwnerMoney.js row
 *   (address, scopeReadStatus/revoked/expiry merged in from discovery, custody, custodyBreakdown).
 */
export function planPartialExit({ agent, amount, account, now = Date.now() }) {
  if (!agent?.address) return { ok: false, kind: 'partial-exit', reason: 'no-agent' }

  let amountUnits
  try {
    amountUnits = amount?.units != null ? BigInt(amount.units) : null
  } catch {
    amountUnits = null
  }
  if (amountUnits == null || amountUnits <= 0n) {
    return { ok: false, kind: 'partial-exit', reason: 'invalid-amount', agentAddress: agent.address }
  }

  const nowSec = Math.floor(now / 1000)
  const blocked = scopeBlocksExitSigner(agent, nowSec)
  if (blocked === 'scope-unknown') {
    // Ambiguity resolution: an unverifiable scope can neither be trusted safe (it might be
    // revoked/expired and hit enforce_exit) nor confidently routed to fallback — the honest
    // answer is "try again", never a guess in either direction.
    return {
      ok: false,
      kind: 'partial-exit',
      reason: 'scope-unknown',
      agentAddress: agent.address,
      message: "This agent's authorization status could not be confirmed — try again, or use full exit.",
    }
  }
  if (blocked === 'scope-revoked' || blocked === 'scope-expired') {
    return {
      ok: true,
      kind: 'partial-exit',
      mode: 'fallback-full-exit',
      reason: blocked,
      agentAddress: agent.address,
      message:
        `This agent's scope is ${blocked === 'scope-revoked' ? 'revoked' : 'expired'}, so the ` +
        'exit-signer can no longer act on it. The balance is not lost — use full exit; owner ' +
        'withdrawal is still allowed by the contract.',
    }
  }

  const maxUnits = stellarVaultMaxUnits(agent)
  if (maxUnits == null) {
    return { ok: false, kind: 'partial-exit', reason: 'balance-unavailable', agentAddress: agent.address }
  }
  if (amountUnits > maxUnits) {
    return {
      ok: false,
      kind: 'partial-exit',
      reason: 'exceeds-max',
      agentAddress: agent.address,
      maxUnits: maxUnits.toString(),
    }
  }

  return {
    ok: true,
    kind: 'partial-exit',
    mode: 'partial',
    agentAddress: agent.address,
    amount,
    account: account ?? null,
    model: account?.kind ?? 'G',
  }
}

// ---------------------------------------------------------------------------------------------
// planRevoke
// ---------------------------------------------------------------------------------------------

/**
 * Plan a revoke — balance-aware without ever removing the kill switch. The actual on-chain call
 * stays revoke.js's revokeAgentOnChain (already routed through OwnerAuthorizationV1: G signs and
 * submits directly even with the relay down; C fails BEFORE any ceremony with no funded fee
 * payer); this plan only gates on whether the agent still holds money.
 * @param {{agent:{address:string, executionStatus?:string, custody?:object, custodyBreakdown?:Array},
 *   shareRead:{state:'known'|'unavailable', amount:object|null},
 *   idleBalanceRead:{state:'known'|'unavailable', amount:object|null},
 *   account:{kind:'G'|'C', address:string}}} p
 */
export function planRevoke({ agent, shareRead, idleBalanceRead, account }) {
  if (!agent?.address) return { ok: false, kind: 'revoke', reason: 'no-agent' }

  const shareKnown = shareRead?.state === 'known'
  const idleKnown = idleBalanceRead?.state === 'known'
  const shareFunded = shareKnown && isKnownPositiveAmount(shareRead.amount)
  const idleFunded = idleKnown && isKnownPositiveAmount(idleBalanceRead.amount)

  // Base "Stop access" for a bridge agent/kernel would need the relayer's mandate-revoke route
  // (relayer/src/httpRouter.mjs), which does not exist yet — VF Wallet Task 7 owns adding it. This
  // fails closed: Base stop-access is reported unavailable, scoped Stellar-only, rather than
  // offering a button with nothing behind it. The Stellar-side revoke below is unaffected — it
  // stops FUTURE action on the AgentAccount contract regardless of what already bridged to Base.
  const baseStopAccess = hasBaseAssociation(agent)
    ? { available: false, scope: 'stellar-only', reason: 'no-relayer-mandate-revoke-route' }
    : null

  if (shareFunded || idleFunded) {
    return {
      ok: false,
      kind: 'revoke',
      reason: 'funded',
      agentAddress: agent.address,
      message: 'This agent still holds funds — withdraw first, then revoke.',
      baseStopAccess,
    }
  }

  const warning = !shareKnown || !idleKnown ? 'Funding status could not be checked' : null

  return {
    ok: true,
    kind: 'revoke',
    agentAddress: agent.address,
    account: account ?? null,
    model: account?.kind ?? 'G',
    warning,
    baseStopAccess,
  }
}

// ---------------------------------------------------------------------------------------------
// Outcome normalization + reconciliation
// ---------------------------------------------------------------------------------------------

/**
 * Normalize one action attempt's raw settled result into the outcome vocabulary this module
 * shares across full exit, partial exit, and revoke: 'confirmed-success' | 'confirmed-failed' |
 * 'not-submitted' | 'unknown'. Only a channel-level OwnerActionSubmissionError may produce
 * 'not-submitted' or 'unknown' (ownerAuthorization.js); any other thrown error reached the chain
 * (or a definite refusal) and is a confirmed failure, not a maybe.
 * @param {{agentAddress?:string, ok?:boolean, status?:string, hash?:string, txHash?:string,
 *   amount?:object|null, error?:Error|string}} r
 */
export function ownerActionOutcome(r) {
  const agentAddress = r?.agentAddress ?? null
  if (r?.ok === true || r?.status === 'SUCCESS') {
    return {
      agentAddress,
      outcome: 'confirmed-success',
      amount: r.amount ?? null,
      hash: r.hash ?? r.txHash ?? null,
    }
  }
  const err = r?.error
  const submission = err && typeof err === 'object' ? err.submission : undefined
  if (submission === 'not-submitted') return { agentAddress, outcome: 'not-submitted', message: err.message }
  if (submission === 'unknown') return { agentAddress, outcome: 'unknown', message: err.message }
  const message = typeof err === 'string' ? err : (err?.message ?? 'Action failed.')
  return { agentAddress, outcome: 'confirmed-failed', message }
}

function actionTargetAddresses(action) {
  if (!action) return []
  if (Array.isArray(action.targets)) {
    return action.targets.map((t) => (typeof t === 'string' ? t : t.address)).filter(Boolean)
  }
  if (action.agentAddress) return [action.agentAddress]
  return []
}

/**
 * Reconcile the aftermath of one owner action (full exit, partial exit, revoke) against a FRESH
 * money read — never an optimistic zero on the aggregate, and per-agent outcomes are preserved
 * independently (a successful sibling stays successful when another batch fails). Bumps a
 * monotonic revision (freshness.js's nextReconciliationToken, the SAME post-action reconciliation
 * guard myMoneyModel.js's freshness contract already establishes) only when a re-read actually
 * happens.
 * @param {{action:{kind:string, targets?:Array, agentAddress?:string},
 *   result:object|Array<object>, readOwnerMoney:() => Promise<{agents:Array}>,
 *   beforeRevision?:number}} p `result` is the raw settled outcome(s) — one object (revoke,
 *   single-agent partial exit) or an array (a full-exit sweep); `ownerActionOutcome` normalizes
 *   each entry.
 */
export async function reconcileOwnerAction({ action, result, readOwnerMoney, beforeRevision }) {
  const raw = Array.isArray(result) ? result : [result]
  const outcomes = raw.map(ownerActionOutcome)

  const allNotSubmitted = outcomes.length > 0 && outcomes.every((o) => o.outcome === 'not-submitted')
  if (allNotSubmitted) {
    // A definite refusal before/without submission — nothing changed on-chain, nothing to re-read.
    return {
      revision: beforeRevision ?? 0,
      status: 'not-submitted',
      label: 'Not submitted',
      outcomes,
      complete: false,
      retryAllowed: true,
    }
  }

  // Everything else (a confirmed success, a confirmed failure, or a post-signing unknown) can only
  // be resolved honestly against the chain — a re-read is required, and it is what may resolve an
  // 'unknown' into a proven 'complete' (e.g. an external on-chain revocation).
  const revision = nextReconciliationToken(beforeRevision)
  let fresh = null
  try {
    fresh = await readOwnerMoney()
  } catch {
    fresh = null
  }

  const targetAddresses = new Set([
    ...actionTargetAddresses(action),
    ...outcomes.map((o) => o.agentAddress).filter(Boolean),
  ])
  const freshAgents = (fresh?.agents ?? []).filter((a) => targetAddresses.has(a.address))
  const sawEveryTarget = targetAddresses.size > 0 && freshAgents.length === targetAddresses.size

  const anyUnknown = outcomes.some((o) => o.outcome === 'unknown')
  const allConfirmedSuccess = outcomes.length > 0 && outcomes.every((o) => o.outcome === 'confirmed-success')

  let complete
  if (action?.kind === 'revoke') {
    // Chain state is the source of truth for a revoke, not the submission channel — an 'unknown'
    // channel outcome still reconciles to complete once the fresh scope itself shows revoked.
    complete =
      allConfirmedSuccess ||
      (sawEveryTarget && freshAgents.every((a) => a.scope?.state === 'known' && a.scope.value?.revoked === true))
  } else {
    // Full/partial exit: complete requires BOTH a clean confirmed result across every target AND
    // chain-verified zero remaining shares/idle balance — a confirmed tx with an unread or
    // still-positive follow-up balance stays 'partial', never an optimistic 'complete'.
    const remainingKnownZero =
      sawEveryTarget && freshAgents.every((a) => isKnownZeroRead(a.vaultShares) && isKnownZeroRead(a.idleToken))
    const remainingUnknown = !sawEveryTarget || freshAgents.some((a) => !isKnownRead(a.vaultShares) || !isKnownRead(a.idleToken))
    complete = allConfirmedSuccess && remainingKnownZero && !remainingUnknown
  }

  const status = complete ? 'complete' : anyUnknown ? 'checking' : 'partial'

  return {
    revision,
    status,
    label: status === 'checking' ? 'Checking status' : null,
    outcomes, // per-agent, independent — a failed sibling never demotes a successful one here
    fresh,
    complete,
    retryAllowed: status === 'partial',
  }
}
