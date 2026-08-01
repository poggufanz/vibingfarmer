// frontend/api/agent-index/recovery.js — Task 7 Chunk A.
//
// `selectRecoveryAction(receipt)` is a PURE function: given the durable, server-stored
// AllocationReceiptV2 evidence for one (network, execution, allocation, owner), it decides the
// ONE safe next action a crashed/reloaded run should take. It never performs I/O, never reads a
// clock, never accepts randomness, and never looks at anything the browser wired in beyond the
// `receipt` argument itself — a forged `custody`/`action` field sent alongside a recovery request
// is simply not part of this function's signature, so it cannot influence the decision (R7).
//
// `requestRecovery(...)` is the impure server orchestration described by task-7-brief.md's
// Interfaces line and hardened by the two operator rulings in task7-decisions.md:
//   - S2-D9: authenticated with the SAME owner-signed challenge -> proof exchange `receipt-write`
//     uses (`handleReceiptChallenge` / `issueReceiptChallenge`, unchanged). The authenticated
//     network/owner/agent come ONLY from the previously-issued, authority-validated challenge —
//     never from the caller-supplied `request` body, which carries identity (executionId,
//     allocationId, childId) and version only, per the brief's Interfaces line.
//   - S2-D8: every Base-touching receipt fails closed to `blocked-reconcile` inside
//     `selectRecoveryAction` itself (see below) — `requestRecovery` never special-cases Base.
//
// ## Why this file re-implements proof verification instead of importing it
//
// `executionReceipts.js` is NOT in Chunk A's owned-files list (task7-chunkA-brief.md's Files
// table), and the private helpers that perform identity/challenge/authority/signature verification
// there (`assertIdentity`, `validateAuthority`, `verifySignature`, `readAuthority`,
// `signerPublicKey`) are not exported — only `ReceiptAuthError`, `receiptRequestDigest`,
// `receiptIntentDigest`, `receiptProofMessage`, `issueReceiptChallenge`, and
// `applyAuthenticatedReceiptMutation` are. `applyAuthenticatedReceiptMutation` cannot be reused
// wholesale: it validates and commits a RECEIPT MUTATION (`toExecutionReceiptRow`/
// `toPhaseAttemptRow` shape, a phase/attempt append), not a lease claim, and it always consumes the
// challenge as part of committing that mutation.
//
// Rather than edit a file outside this chunk's ownership (forbidden by the brief and by
// common-constraints section 0) or invent a materially different auth scheme, this module
// reimplements the SAME verification steps `executionReceipts.js` performs internally, reusing
// every already-exported building block it can (`receiptProofMessage`, `receiptRequestDigest`,
// `ReceiptAuthError`, the exact same `authorityReader`/challenge-store contract) and mirroring the
// private helpers' logic exactly where no export exists. This is flagged as a `## Brief
// divergence` in the chunk report: it is a second copy of security-critical verification logic
// that must be kept in sync if executionReceipts.js's scheme ever changes.
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { ReceiptAuthError, receiptProofMessage, receiptRequestDigest } from './executionReceipts.js'
import { AgentIndexUnavailableError, AgentIndexValidationError } from './models.js'

const BASE_CUSTODY_LOCATIONS = new Set(['cctp-transit', 'base-kernel', 'base-vault'])
const BASE_ONLY_PHASES = ['cctp_burn', 'cctp_mint', 'base_deposit']
const DEFAULT_LEASE_TTL_MS = 60_000

function lastAttemptForPhase(attempts, phase) {
  const list = Array.isArray(attempts) ? attempts : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.phase === phase) return list[i]
  }
  return null
}

/**
 * Pure. Decides the ONE safe next action from stored receipt evidence alone. Total: every input
 * (including a malformed/contradictory receipt) maps to one of the twelve allowed action strings,
 * never `undefined`, never a throw.
 * @param {object|null} receipt - the durable receipt (`parseExecutionReceiptRow` shape:
 *   `{version, phases, custody, attempts, ...}`), or `null` when no receipt has ever been
 *   persisted for this (network, execution, allocation, owner) — "never submitted" is represented
 *   by absence, not by a `not_started` receipt (map fact A/E — the producer never writes one).
 * @returns {{action:string, phase:('pull'|'stellar_deposit'|null), reason:string}}
 */
export function selectRecoveryAction(receipt) {
  if (receipt == null) {
    return {
      action: 'pull',
      phase: 'pull',
      reason:
        'no execution receipt exists yet for this execution/allocation/owner; nothing has ever ' +
        'been submitted, so exactly one pull is permitted',
    }
  }

  const phases = receipt.phases || {}
  const custody = receipt.custody || {}

  // S2-D8: collapse EVERY Base-touching receipt to one fail-closed verdict naming the missing
  // producer, checked before anything else so it stays distinguishable from Stellar manual-review.
  const baseTouched =
    BASE_CUSTODY_LOCATIONS.has(custody.location) ||
    BASE_ONLY_PHASES.some((phase) => phases[phase] && phases[phase] !== 'not_started')
  if (baseTouched) {
    return {
      action: 'blocked-reconcile',
      phase: null,
      reason:
        'Base leg evidence is present (custody past the Stellar bridge agent, or CCTP burn/mint ' +
        'or Base deposit phase activity) but no durable producer for the CCTP nonce, the ' +
        'attestation message, or the Base UserOperation/vault-event state exists anywhere in this ' +
        'codebase (operator ruling S2-D8); recovery must go through baseLeg.js\'s stranded-funds ' +
        'path, not this selector',
    }
  }

  // Any custody evidence gap blocks. Reachable only via createAllocationReceipt's INSERT-time
  // `initialCustody:{location:'unknown'}` escape hatch today (confirmCustody never re-produces an
  // unconfirmed, non-'unknown' location once a receipt has been created) — kept as the general,
  // total fallback rather than assuming that shape can never occur.
  if (custody.confirmed !== true || custody.location === 'unknown') {
    return {
      action: 'manual-review',
      phase: null,
      reason:
        `custody evidence is unconfirmed or unknown (location=${custody.location ?? 'unknown'}` +
        `${custody.reason ? `, reason=${custody.reason}` : ''}); any evidence gap blocks ` +
        'automated recovery',
    }
  }

  // Funds have left the owner if custody itself already proves it, OR if the pull phase is
  // confirmed even though a lagging custody write has not landed yet. orchestrator.js posts
  // `pull:confirmed` (record()) and the `stellar-agent` custody update (custody()) as TWO SEPARATE
  // writes (orchestrator.js:867-876) -- a crash between them persists a receipt with
  // pull_status='confirmed' and custody_location still 'owner'. Trusting phases.pull here, not
  // custody alone, is what stops this branch from re-authorizing a second pull in exactly that
  // window -- see the chunk report's `## Brief divergences` for the verified trace. This is also
  // the single most serious defect this selector must avoid (brief): once funds have left the
  // owner, `pull` must never fire again.
  const fundsLeftOwner = custody.location !== 'owner' || phases.pull === 'confirmed'

  if (!fundsLeftOwner) {
    switch (phases.pull) {
      case 'not_started':
        return {
          action: 'pull',
          phase: 'pull',
          reason:
            'receipt exists but no pull has ever been attempted; exactly one pull is permitted',
        }
      case 'failed':
        return {
          action: 'pull',
          phase: 'pull',
          reason:
            'the previous pull attempt failed before any money moved and custody is still ' +
            'confirmed at owner; a fresh pull is safe',
        }
      case 'submitted':
      case 'unknown': {
        const lastPull = lastAttemptForPhase(receipt.attempts, 'pull')
        if (lastPull?.evidence?.v3ExecutionId) {
          return {
            action: 'resubmit-identical-envelope',
            phase: 'pull',
            reason:
              'the pending pull attempt carries a durable v3ExecutionId, proving it went ' +
              'through pull_v3 (which has an on-chain replay guard, lib.rs:503-509); resending ' +
              'the identical envelope is safe',
          }
        }
        return {
          action: 'poll',
          phase: 'pull',
          reason:
            'the pull outcome is unconfirmed and carries no v3ExecutionId; the deployed V2 ' +
            'router has no replay protection at all, so resending would risk moving money ' +
            'twice -- fail closed to poll',
        }
      }
      default:
        return {
          action: 'manual-review',
          phase: 'pull',
          reason: `unrecognized pull phase status "${phases.pull}"`,
        }
    }
  }

  // Funds are with the agent (or the deposit has already succeeded). Deposit idempotency is NOT
  // established anywhere in this codebase (verified: no dedup key, no replay guard for the deposit
  // call), so an unconfirmed deposit fails closed to poll rather than resubmit.
  if (phases.stellar_deposit === 'confirmed') {
    return {
      action: 'complete',
      phase: null,
      reason: 'the deposit phase is confirmed; execution is terminal',
    }
  }
  if (custody.location === 'stellar-vault') {
    // Defensive contradiction guard, not currently reachable via the real producer: the ONLY
    // custody() call that claims 'stellar-vault' always follows a stellar_deposit:'confirmed'
    // record() in the same code path (orchestrator.js:923-936), and (per the chunk report) that
    // custody update is never itself posted to the server today -- so a persisted row can show
    // 'stellar-vault' only via the pure producer functions directly, never via the full production
    // wire path. Kept because the SCHEMA (RECEIPT_CUSTODY_LOCATIONS) allows it.
    return {
      action: 'manual-review',
      phase: 'stellar_deposit',
      reason:
        'custody claims stellar-vault but the deposit phase is not confirmed; evidence is ' +
        'contradictory',
    }
  }
  switch (phases.stellar_deposit) {
    case 'not_started':
      return {
        action: 'deposit',
        phase: 'stellar_deposit',
        reason: 'the agent holds custody and no deposit has been attempted yet',
      }
    case 'failed':
      return {
        action: 'deposit',
        phase: 'stellar_deposit',
        reason:
          'the previous deposit attempt failed while funds remain with the agent; retrying the ' +
          'deposit does not re-move money',
      }
    case 'submitted':
    case 'unknown':
      return {
        action: 'poll',
        phase: 'stellar_deposit',
        reason:
          'the deposit outcome is unconfirmed and deposit idempotency is not established ' +
          'anywhere in this codebase; fail closed to poll rather than resubmit',
      }
    default:
      return {
        action: 'manual-review',
        phase: 'stellar_deposit',
        reason: `unrecognized stellar_deposit phase status "${phases.stellar_deposit}"`,
      }
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value) {
    throw new AgentIndexValidationError(`${field} is required`)
  }
  return value
}

function signerPublicKey(value) {
  if (typeof value === 'string' && StrKey.isValidEd25519PublicKey(value)) return value
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const raw = Buffer.from(value)
    if (raw.length === 32) return StrKey.encodeEd25519PublicKey(raw)
  }
  throw new ReceiptAuthError('authority', 'Agent signer authority is invalid')
}

async function readAuthority(authorityReader, identity) {
  try {
    return await authorityReader(identity)
  } catch (error) {
    if (error instanceof AgentIndexValidationError || error instanceof AgentIndexUnavailableError) {
      throw error
    }
    throw new AgentIndexUnavailableError('Recovery authority RPC is unavailable', { cause: error })
  }
}

// Mirrors executionReceipts.js's private `validateAuthority` exactly (see module header for why
// this cannot simply be imported).
function validateAuthority({ facts, owner }) {
  if (!facts || typeof facts !== 'object') {
    throw new ReceiptAuthError('authority', 'Agent authority is unavailable')
  }
  if (facts.routerOwner !== owner) {
    throw new ReceiptAuthError('authority', 'Router owner authority mismatch')
  }
  if (facts.scope?.owner !== owner) {
    throw new ReceiptAuthError('authority', 'Scope owner authority mismatch')
  }
  return { ...facts, signerPublicKey: signerPublicKey(facts.signer) }
}

// Mirrors executionReceipts.js's private `verifySignature`, reusing the exported
// `receiptProofMessage` so the signed byte string is byte-for-byte identical to receipt-write's.
function verifyRecoveryProof({ challenge, proof, publicKey }) {
  if (proof?.expiresAt !== challenge.expiresAt) {
    throw new ReceiptAuthError('proof', 'Challenge expiry does not match the signed proof')
  }
  let signature
  try {
    signature = Buffer.from(proof?.signature, 'base64url')
  } catch {
    throw new ReceiptAuthError('proof', 'Recovery proof signature is malformed')
  }
  if (signature.length !== 64) {
    throw new ReceiptAuthError('proof', 'Recovery proof signature is malformed')
  }
  const message = Buffer.from(receiptProofMessage(challenge), 'utf8')
  if (!Keypair.fromPublicKey(publicKey).verify(message, signature)) {
    throw new ReceiptAuthError(
      'proof',
      'Recovery proof signature does not match the current agent signer'
    )
  }
}

/**
 * Impure. Authenticates the caller with the SAME owner-signed challenge -> proof exchange
 * `receipt-write` uses (a challenge must already have been issued via the unchanged
 * `?action=receipt-challenge` route/`issueReceiptChallenge`, over a digest computed with
 * `receiptRequestDigest(request)`), loads the receipt under the AUTHENTICATED network/owner
 * (never from `request`), decides the action, and atomically claims the recovery lease for the
 * phase that action would act on — deriving that phase itself; it is never accepted from the
 * caller (brief A4).
 *
 * `request` accepts identity and version ONLY, per the plan's Interfaces line:
 *   `{executionId, allocationId, childId=null, expectedReceiptVersion, leaseOwner}`.
 * Any OTHER field present on `request` (a forged `custody`, an `action`, ...) is digest-bound (it
 * cannot be added or stripped without invalidating the caller's signature) but functionally inert
 * — this function never reads it, and neither does `selectRecoveryAction` (R7).
 *
 * Does NOT consume the challenge. Unlike `receipt-write` (where an unconsumed challenge would let
 * a replayed proof append a duplicate/conflicting phase attempt), replaying an identical,
 * unexpired recovery-request is safe by construction here: this route never moves money itself —
 * it only reads evidence and claims a coordination lease — and `acquireRecoveryLease`'s own UPSERT
 * is idempotent for the SAME (holder, leaseToken) re-presenting itself before expiry (map fact D).
 * A digest mismatch (a different executionId/allocationId/childId/expectedReceiptVersion/
 * leaseOwner) is rejected regardless, since the challenge is bound to the exact `request` shape.
 *
 * `leaseToken` is not part of the interface — recovery.js mints it deterministically as
 * `leaseOwner` itself, so the SAME caller (e.g. after its own crash/reload) always re-derives the
 * same token and can refresh/retake its OWN lease without having persisted the token anywhere.
 *
 * @param {{executionId:string, allocationId:string, childId?:string|null,
 *   expectedReceiptVersion:number, leaseOwner:string}} p.request
 * @param {{challengeId:string, expiresAt:number, signature:string}} p.proof
 * @param {ReturnType<import('./store').createAgentIndexStore>} p.store
 * @param {(identity:{networkId:string, agent:string}) => Promise<object>} p.authorityReader
 * @param {number} [p.now] server clock, injectable for tests — NEVER caller-supplied over the wire
 * @param {number} [p.leaseTtlMs]
 * @returns {Promise<
 *   {ok:true, action:string, reason:string, phase:string|null, version:number, receipt:object|null,
 *    lease:{holder:string, leaseToken:string, expiresAt:number, phase:string}|null} |
 *   {ok:false, status:409, code:('version-conflict'|'lease-conflict'), error:string, version:number}
 * >}
 */
export async function requestRecovery({
  request,
  proof,
  store,
  authorityReader,
  now = Date.now(),
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
}) {
  if (!request || typeof request !== 'object') {
    throw new AgentIndexValidationError('recovery request body is required')
  }
  const executionId = requireText(request.executionId, 'executionId')
  const allocationId = requireText(request.allocationId, 'allocationId')
  const childId =
    request.childId == null || request.childId === ''
      ? ''
      : requireText(request.childId, 'childId')
  const leaseOwner = requireText(request.leaseOwner, 'leaseOwner')
  if (!Number.isSafeInteger(request.expectedReceiptVersion) || request.expectedReceiptVersion < 0) {
    throw new AgentIndexValidationError('expectedReceiptVersion must be a non-negative safe integer')
  }
  if (!store?.readReceiptChallenge || !store?.readExecutionReceipt || !store?.acquireRecoveryLease) {
    throw new AgentIndexUnavailableError('Recovery store is unavailable')
  }
  if (typeof authorityReader !== 'function') {
    throw new AgentIndexUnavailableError('Recovery authority is not configured')
  }

  const challenge = await store.readReceiptChallenge({ challengeId: proof?.challengeId })
  if (!challenge) throw new ReceiptAuthError('proof', 'Recovery proof challenge does not exist')
  if (challenge.consumedAt != null) {
    throw new ReceiptAuthError('replay', 'Recovery proof challenge was already consumed')
  }
  if (now >= challenge.expiresAt) {
    throw new ReceiptAuthError('expired', 'Recovery proof challenge expired')
  }
  const digest = receiptRequestDigest(request)
  if (challenge.requestDigest !== digest) {
    throw new ReceiptAuthError('proof', 'Recovery proof challenge request digest mismatch')
  }

  const facts = await readAuthority(authorityReader, {
    networkId: challenge.networkId,
    agent: challenge.agent,
  })
  const currentAuthority = validateAuthority({ facts, owner: challenge.owner })
  verifyRecoveryProof({ challenge, proof, publicKey: currentAuthority.signerPublicKey })
  // Map fact A: a scope revoked between dispatch and recovery has no client-constructible
  // reconciliation path (the `revoked-scope-reconciliation` attempt kind is never built by this
  // client) -- unlike receipt-write, recovery has no attempt at all to carry one, so ANY revoked
  // scope unconditionally blocks. "Missing original credential blocks without a replacement
  // signer" (R13).
  if (currentAuthority.scope?.revoked === true) {
    throw new ReceiptAuthError(
      'authority',
      'Agent scope was revoked; recovery cannot proceed without a replacement signer'
    )
  }

  const receipt = await store.readExecutionReceipt({
    networkId: challenge.networkId,
    executionId,
    allocationId,
    owner: challenge.owner,
  })
  if (receipt && receipt.agent !== challenge.agent) {
    throw new ReceiptAuthError(
      'authority',
      'Recovery agent does not match the receipt agent of record'
    )
  }

  const actualVersion = receipt?.version ?? 0
  if (request.expectedReceiptVersion !== actualVersion) {
    // Brief A4: a stale expectedReceiptVersion is a conflict -- claim NO lease, and make it
    // distinguishable from a lease conflict (map fact C) so Chunk B can route on it correctly.
    return {
      ok: false,
      status: 409,
      code: 'version-conflict',
      error: 'Receipt version has moved on since the caller last observed it',
      version: actualVersion,
    }
  }

  const decision = selectRecoveryAction(receipt)

  if (!decision.phase) {
    return {
      ok: true,
      action: decision.action,
      reason: decision.reason,
      phase: null,
      version: actualVersion,
      receipt,
      lease: null,
    }
  }

  const leaseResult = await store.acquireRecoveryLease({
    networkId: challenge.networkId,
    owner: challenge.owner,
    executionId,
    allocationId,
    childId,
    phase: decision.phase,
    holder: leaseOwner,
    leaseToken: leaseOwner,
    now,
    ttlMs: leaseTtlMs,
  })
  if (!leaseResult.acquired) {
    return {
      ok: false,
      status: 409,
      code: 'lease-conflict',
      error: 'Recovery lease is already held',
      version: actualVersion,
    }
  }

  return {
    ok: true,
    action: decision.action,
    reason: decision.reason,
    phase: decision.phase,
    version: actualVersion,
    receipt,
    lease: {
      holder: leaseOwner,
      leaseToken: leaseResult.leaseToken,
      expiresAt: leaseResult.expiresAt,
      phase: decision.phase,
    },
  }
}
