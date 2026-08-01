// frontend/src/strategy/allocationReceipt.js
//
// Pure, client-side producer for AllocationReceiptV2 -- the durable, monotonic, phase/attempt-
// journaled execution receipt whose schema and enforcement already exist server-side:
//   - api/agent-index/migrations/0005_execution_receipts.sql (DDL; CHECK constraints :26-28;
//     monotonic-version trigger `execution_receipts_monotonic_update` :49-64)
//   - api/agent-index/models.js (`toExecutionReceiptRow` :180-224, `toPhaseAttemptRow` :227-238,
//     vocabulary `RECEIPT_PHASES`/`RECEIPT_PHASE_STATUSES`/`RECEIPT_CUSTODY_LOCATIONS` :27-37)
// This module deliberately does NOT import that server code -- a pure producer with no network/DB
// dependency should not reach into api/ at runtime. The vocabulary below is copied verbatim from
// models.js and pinned against drift by allocationReceipt.test.js, which imports and runs the
// REAL `toExecutionReceiptRow`/`toPhaseAttemptRow` against this module's actual output (the
// "cross-layer check" the task brief requires, not a hand-written expectation of this test's own).
//
// No network, no chain reads, no imports from orchestrator.js/worker.js.
//
// The DB trigger, precisely (fix round 1 correction -- the trigger constrains exactly four
// things, no more, no less; `custody_location` itself is bound only by the CHECK vocabulary, not
// by this trigger, and the trigger is BEFORE UPDATE only, so it says nothing about INSERT):
//   1. `NEW.version <> OLD.version + 1`                                        -> ABORT
//   2. any `OLD.<phase>_status = 'confirmed' AND NEW.<phase>_status <> 'confirmed'` -> ABORT
//   3. `OLD.custody_confirmed = 1 AND NEW.custody_confirmed <> 1`               -> ABORT
//   4. `OLD.custody_confirmed = 1 AND OLD.custody_units IS NOT NULL
//         AND NEW.custody_units IS NULL`                                       -> ABORT
// This module mirrors all four locally, before a malformed mutation is ever built:
//   - `appendPhase` refuses (throws) to downgrade a `confirmed` phase to anything else (#2).
//   - `confirmCustody` never un-confirms a confirmed custody (#3) and never drops a confirmed
//     custody's amount once it is non-null (#4) -- both throw.
//   - `confirmCustody` never replaces a confirmed custody with a WEAKER confirmed location either
//     (funds do not move backward through owner -> stellar-agent -> stellar-vault -> cctp-transit
//     -> base-kernel -> base-vault) -- this is this module's own addition, consistent with the
//     trigger's spirit though not literally clause #3, since a same-rank-or-forward move is the
//     only physically possible one once evidence is trusted.
//
// AMBIGUOUS EVIDENCE MUST NOT THROW (fix round 1, Finding 1). Per the trigger's clause #3, custody
// can never un-confirm -- so an ambiguous/inconclusive read (a stale NOT_FOUND, an RPC gap,
// mismatched evidence) must never be treated as "downgrade to unknown," because that IS an
// un-confirm. Instead `confirmCustody` KEEPS the last proven location unchanged and records the
// ambiguity in `custody.reason` only: a confirmed custody fact never becomes unproven, you only
// ever learn more. `unknown`/`confirmed:false`/`amount:null` is therefore reachable only at
// INSERT time, via `createAllocationReceipt`'s optional `initialCustody` param, for a receipt
// reconstructed for an execution whose pre-movement position was never actually observed -- never
// as an UPDATE outcome of `confirmCustody` on a receipt that already has proven custody.
//
// Not pure in the strict sense: `appendPhase`'s `attemptId`/`observedAt` defaults
// (`crypto.randomUUID()`/`Date.now()`) are wall-clock/entropy-derived. Callers that need
// determinism (tests, replay) must pass both explicitly.

const RECEIPT_PHASES = ['pull', 'stellar_deposit', 'cctp_burn', 'cctp_mint', 'base_deposit']
const RECEIPT_PHASE_STATUSES = ['not_started', 'submitted', 'confirmed', 'failed', 'unknown']
const RECEIPT_CUSTODY_LOCATIONS = [
  'owner',
  'stellar-agent',
  'stellar-vault',
  'cctp-transit',
  'base-kernel',
  'base-vault',
  'unknown',
]
const ATTEMPT_KINDS = ['phase', 'revoked-scope-reconciliation']

// Custody rank mirrors the real owner -> stellar-agent -> stellar-vault -> cctp-transit ->
// base-kernel -> base-vault progression funds actually move through (the same order
// RECEIPT_CUSTODY_LOCATIONS is declared in, server-side). 'unknown' is intentionally excluded --
// an unconfirmed/ambiguous custody read is always weaker than any confirmed location.
const CUSTODY_RANK = new Map(
  RECEIPT_CUSTODY_LOCATIONS.filter((location) => location !== 'unknown').map((location, index) => [
    location,
    index,
  ])
)

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value) {
  return value == null ? null : requireString(value, 'value')
}

// One level of copy is enough to stop a caller's later in-place edit of an object it handed us
// from silently rewriting a journaled "never removed" attempt or the receipt's own intent -- see
// "Also fix" round 1 review note. Not a deep clone (deliberately -- see the module header: this
// module does the minimum the review asked for, not speculative generality).
function shallowCopy(value) {
  if (value == null || typeof value !== 'object') return value
  return Array.isArray(value) ? [...value] : { ...value }
}

// Mirrors models.js's `requireAmount` (api/agent-index/models.js:162-179) so a malformed amount is
// rejected here, locally, rather than only at the server boundary. `units` is compared against
// /^\d+$/ as a STRING and returned as the same string -- it is never routed through Number(),
// which silently loses precision above Number.MAX_SAFE_INTEGER (2^53-1).
function assertAmount(amount, field) {
  if (amount == null) return null
  if (typeof amount !== 'object' || Array.isArray(amount)) {
    throw new Error(`${field} must be an object or null`)
  }
  const token = requireString(amount.token, `${field}.token`)
  if (typeof amount.units !== 'string' || !/^\d+$/.test(amount.units)) {
    throw new Error(`${field}.units must be an exact non-negative integer string`)
  }
  if (!Number.isInteger(amount.decimals) || amount.decimals < 0) {
    throw new Error(`${field}.decimals must be a non-negative integer`)
  }
  return { token, units: amount.units, decimals: amount.decimals }
}

function initialPhases() {
  return Object.fromEntries(RECEIPT_PHASES.map((phase) => [phase, 'not_started']))
}

function requireReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') throw new Error('receipt must be an object')
  if (!receipt.phases || typeof receipt.phases !== 'object') {
    throw new Error('receipt.phases must be an object')
  }
  if (!receipt.custody || typeof receipt.custody !== 'object') {
    throw new Error('receipt.custody must be an object')
  }
  if (!Array.isArray(receipt.attempts)) {
    throw new Error('receipt.attempts must be an array')
  }
  return receipt
}

// `initialCustody` is either omitted (the ordinary case: owner/confirmed, the axiomatic
// pre-movement state, no evidence needed) or `{location:'unknown', reason?}` -- the ONE
// INSERT-time-only escape hatch for a receipt reconstructed for an execution whose pre-movement
// position was never actually observed (fix round 1, Finding 1 / controller ruling point 3). No
// other initial location is accepted: any other location would need evidence `confirmCustody`
// exists to evaluate, not a construction-time assertion.
function initialCustodyState(initialCustody, amount) {
  if (initialCustody == null) {
    return {
      location: 'owner',
      confirmed: true,
      amount: assertAmount(amount, 'amount'),
      reason: null,
    }
  }
  if (initialCustody.location !== 'unknown') {
    throw new Error(
      'createAllocationReceipt: initialCustody only supports "unknown" (a reconstructed ' +
        'execution whose pre-movement position was never observed) -- omit it entirely for the ' +
        'default owner/confirmed pre-movement state'
    )
  }
  return {
    location: 'unknown',
    confirmed: false,
    amount: null,
    reason: optionalString(initialCustody.reason),
  }
}

/**
 * Build a fresh AllocationReceiptV2. By default it opens in its pre-movement state: every phase
 * `not_started`, custody confirmed at `owner` -- no evidence needed, since it is definitionally
 * true the owner holds funds nobody has touched yet. Pass `initialCustody:{location:'unknown',
 * reason}` instead ONLY for a receipt reconstructed for an execution whose pre-movement position
 * was never actually observed -- that is the one case `unknown`/`confirmed:false` is reachable at
 * all (see module header). Matches the record shape `toExecutionReceiptRow` accepts
 * (api/agent-index/models.js:181-224) plus a local `attempts` journal that `appendPhase` grows.
 * Attempts are posted to the server one at a time (`applyAuthenticatedReceiptMutation`'s write
 * body is `{expectedVersion, receipt, attempt}`, a single attempt per write,
 * api/agent-index/executionReceipts.js:194-267) -- this array is this module's own local
 * bookkeeping of that history, not itself part of the wire body.
 * @param {{networkId:string, executionId:string, allocationId:string, owner:string, runId:string,
 *   parentAllocationId?:string|null, childId?:string|null, worker:string, agent:string,
 *   intent:object, amount?:{token:string,units:string,decimals:number}|null,
 *   initialCustody?:{location:'unknown', reason?:string}}} p
 * @returns {object} AllocationReceiptV2
 */
export function createAllocationReceipt({
  networkId,
  executionId,
  allocationId,
  owner,
  runId,
  parentAllocationId = null,
  childId = null,
  worker,
  agent,
  intent,
  amount = null,
  initialCustody = null,
} = {}) {
  return {
    version: 2,
    networkId: requireString(networkId, 'networkId'),
    executionId: requireString(executionId, 'executionId'),
    allocationId: requireString(allocationId, 'allocationId'),
    owner: requireString(owner, 'owner'),
    runId: requireString(runId, 'runId'),
    parentAllocationId: optionalString(parentAllocationId),
    childId: optionalString(childId),
    worker: requireString(worker, 'worker'),
    agent: requireString(agent, 'agent'),
    intent: shallowCopy(intent),
    phases: initialPhases(),
    custody: initialCustodyState(initialCustody, amount),
    attempts: [],
  }
}

function assertPhaseNotDowngraded(currentStatus, nextStatus, phase) {
  if (currentStatus === 'confirmed' && nextStatus !== 'confirmed') {
    throw new Error(
      `appendPhase: refusing to downgrade confirmed phase "${phase}" to "${nextStatus}" -- ` +
        'confirmed evidence is never removed'
    )
  }
}

/**
 * Append ONE phase attempt and return a new receipt with that attempt journaled and
 * `phases[phase]` set to the attempt's status. Pull and deposit are always separate calls with
 * separate `attemptId`s and separate evidence -- never collapse two phases into one attempt (the
 * exact defect this module exists to remove; see map-task6-refreshed.md section 3, where a single
 * `res.txHash` silently absorbs both the pull's and the deposit's outcome today). Throws rather
 * than silently drops an attempt that would downgrade an already-`confirmed` phase -- see the
 * module header for why throwing, not ignoring, is the deliberate choice here. `evidence` is
 * shallow-copied at journal time so a caller mutating its own object afterward cannot rewrite
 * history it already handed us.
 * @param {object} receipt AllocationReceiptV2
 * @param {{attemptId?:string, kind?:'phase'|'revoked-scope-reconciliation', phase:string,
 *   status:string, evidence?:object, observedAt?:number}} attempt
 * @returns {object} a NEW receipt; `receipt` is never mutated
 */
export function appendPhase(receipt, attempt) {
  requireReceipt(receipt)
  const {
    attemptId = crypto.randomUUID(),
    kind = 'phase',
    phase,
    status,
    evidence = {},
    observedAt = Date.now(),
  } = attempt || {}

  if (!RECEIPT_PHASES.includes(phase)) throw new Error(`appendPhase: unknown phase "${phase}"`)
  if (!RECEIPT_PHASE_STATUSES.includes(status)) {
    throw new Error(`appendPhase: unknown phase status "${status}"`)
  }
  if (!ATTEMPT_KINDS.includes(kind)) throw new Error(`appendPhase: unknown attempt kind "${kind}"`)
  if (!Number.isInteger(observedAt)) throw new Error('appendPhase: observedAt must be an integer')

  assertPhaseNotDowngraded(receipt.phases[phase], status, phase)

  const record = {
    attemptId: requireString(attemptId, 'attemptId'),
    kind,
    phase,
    status,
    evidence: shallowCopy(evidence),
    observedAt,
  }

  return {
    ...receipt,
    phases: { ...receipt.phases, [phase]: status },
    attempts: [...receipt.attempts, record],
  }
}

// Custody state rules (task-6a-brief.md "The custody state rules"), applied precisely:
//  - owner: confirmed with no evidence required -- the state before any movement.
//  - stellar-vault / base-vault: confirmed ONLY when the deposit transaction succeeded AND a
//    matching share/deposit event corroborates it -- transaction success alone is never enough.
//    Both are the same "final landing pool" role, one chain over -- fix round 1 gave base-vault
//    the same bar as stellar-vault instead of the weaker one it had before.
//  - stellar-agent, cctp-transit, base-kernel: a reported-successful transaction is the baseline
//    bar. "Transport acceptance is never final custody" is stated as a general principle in the
//    brief, not scoped to Stellar alone, so no location is ever confirmed on transport/request
//    acceptance by itself.
function confirmedCustodyBar(location, { txSuccess, matchingEvent }) {
  if (location === 'owner') return true
  if (location === 'stellar-vault' || location === 'base-vault') {
    return txSuccess === true && matchingEvent === true
  }
  return txSuccess === true
}

function rejectWeakerCustody(receipt, next) {
  const currentRank = receipt.custody?.confirmed
    ? (CUSTODY_RANK.get(receipt.custody.location) ?? -1)
    : -1
  const nextRank = next.confirmed ? (CUSTODY_RANK.get(next.location) ?? -1) : -1
  if (nextRank < currentRank) {
    throw new Error(
      `confirmCustody: refusing to replace confirmed custody "${receipt.custody.location}" with ` +
        `weaker custody "${next.location}" -- confirmed evidence is never removed`
    )
  }
  // Mirrors the DB trigger's clause #4 exactly: once a confirmed custody carries a real amount,
  // that amount can never be dropped back to null by a later confirmation (fix round 1, Finding 2).
  if (receipt.custody?.confirmed && receipt.custody.amount != null && next.amount == null) {
    throw new Error(
      `confirmCustody: refusing to drop the confirmed custody amount for "${next.location}" -- ` +
        'confirmed evidence is never removed'
    )
  }
  return { ...receipt, custody: next }
}

// Ambiguous/insufficient evidence must never throw and must never un-confirm the last PROVEN
// custody -- see the module header's "AMBIGUOUS EVIDENCE MUST NOT THROW". If a confirmed custody
// already exists, it is returned unchanged except for `reason` (the ambiguity is recorded, the
// fact is not). If none exists yet (the INSERT-time-only unknown/unconfirmed state), there is
// nothing to preserve, so the ambiguity itself becomes the -- already unconfirmed -- custody value.
function custodyAfterAmbiguousEvidence(receipt, { location, reason }) {
  const fallbackReason =
    location === 'unknown'
      ? reason
      : (reason ?? `${location} custody claimed without evidence meeting its confirmation bar`)
  if (receipt.custody?.confirmed) {
    return {
      ...receipt,
      custody: { ...receipt.custody, reason: fallbackReason ?? receipt.custody.reason },
    }
  }
  return {
    ...receipt,
    custody: { location: 'unknown', confirmed: false, amount: null, reason: fallbackReason },
  }
}

/**
 * Record custody evidence and return a new receipt with `custody` updated. NEVER throws on
 * ambiguous/insufficient evidence (fix round 1, Finding 1) -- it keeps the last PROVEN location
 * unchanged and records the ambiguity in `custody.reason` only, because a confirmed custody fact
 * never becomes unproven; you only ever learn more. It DOES throw when evidence is sufficient but
 * would replace an already-confirmed custody with a weaker one, or would drop an already-confirmed
 * amount to null -- both are refused locally, matching the DB trigger's clauses #3/#4 (module
 * header) rather than depending on the database to catch what this producer should have refused.
 * @param {object} receipt AllocationReceiptV2
 * @param {{location:string, amount?:{token:string,units:string,decimals:number}|null,
 *   reason?:string, txSuccess?:boolean, matchingEvent?:boolean}} evidence
 * @returns {object} a NEW receipt; `receipt` is never mutated
 */
export function confirmCustody(receipt, evidence) {
  requireReceipt(receipt)
  const {
    location,
    amount = null,
    reason = null,
    txSuccess = false,
    matchingEvent = false,
  } = evidence || {}
  if (!RECEIPT_CUSTODY_LOCATIONS.includes(location)) {
    throw new Error(`confirmCustody: unknown custody location "${location}"`)
  }

  if (location === 'unknown' || !confirmedCustodyBar(location, { txSuccess, matchingEvent })) {
    return custodyAfterAmbiguousEvidence(receipt, { location, reason })
  }

  const validatedAmount = assertAmount(amount, 'custody.amount')
  return rejectWeakerCustody(receipt, {
    location,
    confirmed: true,
    amount: validatedAmount,
    reason,
  })
}
