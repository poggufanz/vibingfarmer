// frontend/src/strategy/allocationReceipt.js
//
// Pure, client-side producer for AllocationReceiptV2 -- the durable, monotonic, phase/attempt-
// journaled execution receipt whose schema and enforcement already exist server-side:
//   - api/agent-index/migrations/0005_execution_receipts.sql (DDL; CHECK constraints :26-28;
//     monotonic-version trigger `execution_receipts_monotonic_update` :49-64, which aborts any
//     UPDATE that regresses `version`, a confirmed phase status, or `custody_confirmed`)
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
// Monotonicity: `appendPhase` and `confirmCustody` each return a NEW receipt -- the input is never
// mutated -- and neither a confirmed phase nor a confirmed custody can ever be replaced by weaker
// evidence. Both throw on an attempted downgrade rather than silently ignoring it: the DB's own
// trigger enforces the identical invariant by aborting the UPDATE (RAISE(ABORT, ...)), and this
// producer's job is to refuse the downgrade locally, before a malformed mutation is ever built,
// with the same "reject loudly" semantics rather than a caller believing a write succeeded when
// its evidence was silently dropped.

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
  return receipt
}

/**
 * Build a fresh AllocationReceiptV2 in its pre-movement state: every phase `not_started`, custody
 * confirmed at `owner` -- the custody rule for "before any movement" needs no evidence, since it is
 * definitionally true the owner holds funds nobody has touched yet. Matches the record shape
 * `toExecutionReceiptRow` accepts (api/agent-index/models.js:181-224) plus a local `attempts`
 * journal that `appendPhase` grows. Attempts are posted to the server one at a time
 * (`applyAuthenticatedReceiptMutation`'s write body is `{expectedVersion, receipt, attempt}`, a
 * single attempt per write, api/agent-index/executionReceipts.js:194-267) -- this array is this
 * module's own local bookkeeping of that history, not itself part of the wire body.
 * @param {{networkId:string, executionId:string, allocationId:string, owner:string, runId:string,
 *   parentAllocationId?:string|null, childId?:string|null, worker:string, agent:string,
 *   intent:object, amount:{token:string,units:string,decimals:number}|null}} p
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
    intent,
    phases: initialPhases(),
    custody: { location: 'owner', confirmed: true, amount: assertAmount(amount, 'amount'), reason: null },
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
 * module header for why throwing, not ignoring, is the deliberate choice here.
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
    evidence,
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
//  - stellar-vault: confirmed ONLY when the deposit transaction succeeded AND a matching
//    share/deposit event corroborates it -- transaction success alone is never enough.
//  - stellar-agent, and (absent a brief-specified rule) the bridge-leg locations cctp-transit/
//    base-kernel/base-vault: a reported-successful transaction is the baseline bar. "Transport
//    acceptance is never final custody" is stated as a general principle in the brief, not scoped
//    to Stellar alone, so no location is ever confirmed on transport/request acceptance by itself.
function confirmedCustodyBar(location, { txSuccess, matchingEvent }) {
  if (location === 'owner') return true
  if (location === 'stellar-vault') return txSuccess === true && matchingEvent === true
  return txSuccess === true
}

function rejectWeakerCustody(receipt, next) {
  const currentRank = receipt.custody?.confirmed
    ? CUSTODY_RANK.get(receipt.custody.location) ?? -1
    : -1
  const nextRank = next.confirmed ? CUSTODY_RANK.get(next.location) ?? -1 : -1
  if (nextRank < currentRank) {
    throw new Error(
      `confirmCustody: refusing to replace confirmed custody "${receipt.custody.location}" with ` +
        `weaker custody "${next.location}" -- confirmed evidence is never removed`
    )
  }
  return { ...receipt, custody: next }
}

/**
 * Record custody evidence and return a new receipt with `custody` updated. Refuses (throws)
 * rather than silently confirms a location whose evidence does not meet its bar, and refuses
 * (throws) rather than replaces an already-confirmed custody with a weaker one -- see the module
 * header for why throwing, not ignoring, is the deliberate choice for both cases. A direct
 * consequence of "owner/confirmed is the axiomatic state before any movement" plus "confirmed
 * custody is never replaced by something weaker" is that `unknown`/`confirmed:false` can never be
 * this producer's SUCCESSFUL output once a receipt exists (it always already carries confirmed
 * `owner` custody at minimum) -- an ambiguous/mismatched-evidence call is always refused, not
 * silently recorded as `unknown`. That mirrors the DB trigger exactly: `custody_confirmed` may
 * never regress from 1 to 0 (migrations/0005_execution_receipts.sql:57).
 * @param {object} receipt AllocationReceiptV2
 * @param {{location:string, amount?:{token:string,units:string,decimals:number}|null,
 *   reason?:string, txSuccess?:boolean, matchingEvent?:boolean}} evidence
 * @returns {object} a NEW receipt; `receipt` is never mutated
 */
export function confirmCustody(receipt, evidence) {
  requireReceipt(receipt)
  const { location, amount = null, reason = null, txSuccess = false, matchingEvent = false } =
    evidence || {}
  if (!RECEIPT_CUSTODY_LOCATIONS.includes(location)) {
    throw new Error(`confirmCustody: unknown custody location "${location}"`)
  }

  if (location === 'unknown') {
    return rejectWeakerCustody(receipt, { location: 'unknown', confirmed: false, amount: null, reason })
  }

  if (!confirmedCustodyBar(location, { txSuccess, matchingEvent })) {
    throw new Error(
      `confirmCustody: refusing to confirm "${location}" custody -- the evidence does not meet its ` +
        'confirmation bar (transport/transaction acceptance alone is never final custody)'
    )
  }

  const validatedAmount = assertAmount(amount, 'custody.amount')
  return rejectWeakerCustody(receipt, { location, confirmed: true, amount: validatedAmount, reason })
}
