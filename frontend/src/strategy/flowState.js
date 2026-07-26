// frontend/src/strategy/flowState.js
// Strategy Task 6 (Pocket Crew redesign, Wave 1). The three-moment state machine: Plan (build +
// review a StrategyPlan) -> Protect (get a confirmed permission, fresh grant or revalidated
// reuse) -> Start (workers/bridge move funds, tracked to a complete receipt). Pure and
// synchronous: `strategyFlowReducer` never calls a wallet, relay, or contract -- every fact it
// holds arrives as an already-decided event (see reusePreflight.js / grant.js / worker.js for the
// I/O that produces those events). This mirrors how a normal Redux-shaped reducer stays a pure
// function of (state, event); the moment machine's whole job is refusing to move forward on
// anything but an explicit, already-confirmed fact.
//
// Gating rule that carries almost every invariant here: an event whose moment requirement isn't
// met is simply not applicable yet -- the reducer returns the exact same state reference (no
// mutation, no partial update), so a caller can always tell "nothing happened" apart from "the
// state changed" with `===`.

export const STRATEGY_MOMENTS = Object.freeze(['plan', 'protect', 'start'])

export const initialStrategyFlowState = Object.freeze({
  moment: 'plan',
  plan: null,
  planStatus: 'idle', // idle | loading | ready | failed
  planError: null,
  permission: null, // secret-free PermissionDecisionV1 view (reusePreflight.toPermissionDecisionView)
  permissionStatus: 'idle', // idle | preflight-ready | grant-requested | rejected | grant-confirmed | reuse-confirmed
  // Strategy Task 13 (decision log #22, obligation A.2/A.3): mirrors `planError`. Populated by
  // PREFLIGHT_FAILED (a PermissionPhaseError's message -- preflight OR reuse-revalidation) and by
  // WALLET_REJECTED/WALLET_FAILED (whatever reason/error string the event carries). Before this
  // field existed, WALLET_REJECTED and WALLET_FAILED wrote byte-identical state -- a caller could
  // not tell a user's deliberate decline apart from an infrastructure failure. `protectMessage`
  // stays the single user-facing "Nothing moved" string for all three; `permissionError` is the
  // detail a caller can log/branch on without re-deriving it from nothing.
  permissionError: null,
  protectMessage: null,
  retryable: false,
  custody: Object.freeze({}), // allocationId -> { status, ... }
  attestation: null, // optional, transient -- never read by isReceiptComplete
})

/** A plan reaches Protect only once expandAgentSlots/toDispatchStrategy has left at least one
 * eligible agent -- an all-ineligible plan has already been narrowed to an empty `agents` array
 * upstream (planModel.js's toDispatchStrategy), so "eligible" here is just "non-empty". */
function planHasEligibleAgent(plan) {
  return Array.isArray(plan?.agents) && plan.agents.length > 0
}

const KNOWN_BASE_JOB_STATUSES = new Set(['submitted', 'bridged', 'bridge-failed'])

// Every worker/bridge event carries `allocationId` -- the SAME id as the plan's
// `agents[].allocationId` (Task 2's stable-ID contract, never an array-position index). `custody`
// is keyed by that same allocationId, so `isReceiptComplete` below can look a plan agent's outcome
// up directly with no translation step.
function applyCustodyEvent(custody, event) {
  const { allocationId } = event
  if (!allocationId) return custody
  const row = custody[allocationId]
  switch (event.type) {
    case 'WORKER_QUEUED':
      return { ...custody, [allocationId]: { ...row, status: 'queued' } }
    case 'WORKER_STARTED':
      return { ...custody, [allocationId]: { ...row, status: 'started' } }
    case 'PULL_CONFIRMED':
      return { ...custody, [allocationId]: { ...row, status: 'pulled' } }
    case 'PULL_FAILED':
      return {
        ...custody,
        [allocationId]: { ...row, status: 'failed', error: event.error ?? null },
      }
    case 'DEPOSIT_CONFIRMED':
      return { ...custody, [allocationId]: { ...row, status: 'deposited' } }
    case 'DEPOSIT_FAILED':
      return {
        ...custody,
        [allocationId]: { ...row, status: 'failed', error: event.error ?? null },
      }
    case 'BASE_JOB_UPDATED': {
      // Unknown/garbage statuses never count as terminal -- a stray or malformed relay payload
      // must never be mistaken for 'deposited' or any other terminal state (see CUSTODY_TERMINAL).
      const status = KNOWN_BASE_JOB_STATUSES.has(event.status) ? event.status : 'unknown'
      return { ...custody, [allocationId]: { ...row, status, jobId: event.jobId } }
    }
    default:
      return custody
  }
}

export function strategyFlowReducer(state = initialStrategyFlowState, event) {
  if (!event?.type) return state

  switch (event.type) {
    case 'PLAN_REQUESTED':
      if (state.moment !== 'plan') return state
      return { ...state, planStatus: 'loading', planError: null }

    case 'PLAN_READY':
      if (state.moment !== 'plan') return state
      return { ...state, plan: event.plan, planStatus: 'ready', planError: null }

    case 'PLAN_FAILED':
      if (state.moment !== 'plan') return state
      return { ...state, planStatus: 'failed', planError: event.error ?? null }

    case 'PROTECT_OPENED': {
      if (state.moment !== 'plan') return state
      if (!planHasEligibleAgent(state.plan)) {
        return { ...state, planStatus: 'failed', planError: 'no-eligible-agents' }
      }
      return {
        ...state,
        moment: 'protect',
        permissionStatus: 'idle',
        protectMessage: null,
        retryable: false,
      }
    }

    case 'PREFLIGHT_READY':
      if (state.moment !== 'protect') return state
      return {
        ...state,
        permission: event.decision,
        permissionStatus: 'preflight-ready',
        protectMessage: null,
        retryable: false,
        permissionError: null,
      }

    case 'PREFLIGHT_FAILED':
      // Strategy Task 13 (decision log #22, obligation A). A PermissionPhaseError surfaced during
      // EITHER the first permission check OR a reuse-revalidation re-check immediately before
      // authorize (ProtectStage.jsx's own header comment: "preflight OR reuse-revalidation" share
      // one failure vocabulary at the UI boundary) -- both are "the world moved since this was
      // reviewed," never a wallet-only hiccup. Deliberately gated on `moment` alone, NOT on
      // `permissionStatus`, unlike WALLET_REJECTED/WALLET_FAILED above: a first-check failure fires
      // from 'idle', a re-check failure can fire from 'preflight-ready' (reuse) or even
      // 'grant-requested' (a fresh grant's own material found stale mid-authorize) -- restricting
      // this to one permissionStatus would make it inapplicable to the exact moments it exists to
      // cover. (Considered renaming the event PERMISSION_PHASE_FAILED instead of widening the gate,
      // per the decision log's "either/or" -- kept the existing name: every producer of this event
      // is, at the protocol level, a preflight-shaped check (`preflightPermission`'s own re-run for
      // reuse-revalidation, per orchestrator.js's `revalidateReuse` doc comment), so the name was
      // never wrong, only the gate was too narrow.)
      //
      // `permission` is CLEARED, not preserved: the brief's literal "preserved decision" reading
      // does not survive ProtectStage.jsx:229-232's own handling of the identical
      // PermissionPhaseError case (`setDecision(null)` -- "the held decision is proven stale").
      // Keeping a decision here that ProtectStage itself has already discarded would let this
      // state disagree with the one surface that consumes it. `permissionStatus` resets to 'idle'
      // (not 'rejected') because retrying a preflight failure means running the check again, never
      // jumping straight to GRANT_REQUESTED -- 'rejected' is reserved for the wallet-retry path,
      // which reuses the ALREADY-preflighted decision GRANT_REQUESTED's own gate expects.
      if (state.moment !== 'protect') return state
      return {
        ...state,
        permission: null,
        permissionStatus: 'idle',
        protectMessage: 'Nothing moved',
        retryable: true,
        permissionError: event.error ?? null,
      }

    case 'GRANT_REQUESTED':
      // Symmetric with the reuse path below: only a reviewed preflight decision (or a retry after
      // a prior wallet rejection/failure, which already went through one) may request a grant --
      // never straight from 'idle', which would leave `permission` null.
      if (state.moment !== 'protect') return state
      if (!['preflight-ready', 'rejected'].includes(state.permissionStatus)) return state
      return {
        ...state,
        permissionStatus: 'grant-requested',
        protectMessage: null,
        retryable: false,
      }

    case 'WALLET_REJECTED':
    case 'WALLET_FAILED':
      // Preserves `plan` and `permission` untouched -- nothing moved, so nothing about the
      // reviewed plan or the preflight decision needs to be redone, only the wallet step retried.
      // Task 6 residual fix: also gated on a grant actually being in flight -- a wallet
      // rejection/failure event is only applicable to a request THIS state actually made; without
      // this a stray or late-arriving event could flip an idle/preflight-ready/already-rejected
      // Protect state to 'rejected' for a request it never issued.
      if (state.moment !== 'protect' || state.permissionStatus !== 'grant-requested') return state
      return {
        ...state,
        permissionStatus: 'rejected',
        protectMessage: 'Nothing moved',
        retryable: true,
        // Task 13 (obligation A.3): read whatever the caller attached -- WALLET_REJECTED's own
        // vocabulary is `reason` (a user-facing decline reason), WALLET_FAILED's is `error`. A
        // caller that supplies neither still gets a defined-but-empty signal, never `undefined`.
        permissionError: event.reason ?? event.error ?? null,
      }

    case 'GRANT_CONFIRMED':
      // Only a grant that actually went through GRANT_REQUESTED can confirm -- this is the "only
      // confirmed FRESH grant ... enters Start" half of the invariant.
      if (state.moment !== 'protect' || state.permissionStatus !== 'grant-requested') return state
      return {
        ...state,
        moment: 'start',
        permissionStatus: 'grant-confirmed',
        protectMessage: null,
      }

    case 'REUSE_CONFIRMED':
      // Only a REVALIDATED reuse decision (a preflight decision in 'reuse' mode) can confirm --
      // the "... or REVALIDATED reuse enters Start" half. No wallet step required for reuse.
      if (
        state.moment !== 'protect' ||
        state.permissionStatus !== 'preflight-ready' ||
        state.permission?.mode !== 'reuse'
      )
        return state
      return {
        ...state,
        moment: 'start',
        permissionStatus: 'reuse-confirmed',
        protectMessage: null,
      }

    case 'WORKER_STARTED': {
      // Per-lane ordering: a lane must have been queued before it can start. Gated here (not
      // inside applyCustodyEvent) so an out-of-order or pre-Start WORKER_STARTED returns the exact
      // same state reference, same as every other inapplicable event.
      if (state.moment !== 'start') return state
      if (state.custody[event.allocationId]?.status !== 'queued') return state
      return { ...state, custody: applyCustodyEvent(state.custody, event) }
    }

    case 'WORKER_QUEUED':
      // Task 6 residual fix: a stray or duplicate re-queue must never regress a lane that already
      // reached a terminal outcome (deposited/bridged) -- e.g. a late-arriving queue event from a
      // retried dispatch racing behind the deposit/bridge confirmation it was queued for.
      if (state.moment !== 'start') return state
      if (CUSTODY_TERMINAL.has(state.custody[event.allocationId]?.status)) return state
      return { ...state, custody: applyCustodyEvent(state.custody, event) }

    case 'PULL_CONFIRMED':
    case 'PULL_FAILED':
    case 'DEPOSIT_CONFIRMED':
    case 'DEPOSIT_FAILED':
    case 'BASE_JOB_UPDATED':
      // Worker/bridge events cannot run before permission confirmation -- moment only becomes
      // 'start' via a confirmed grant or a revalidated reuse (above).
      if (state.moment !== 'start') return state
      return { ...state, custody: applyCustodyEvent(state.custody, event) }

    case 'ATTESTATION_RECEIVED':
      // Optional and transient (canonicalStrategy.js excludes it from every fingerprint) -- stored
      // for display only. Never touches `custody`, so it can never change isReceiptComplete.
      return { ...state, attestation: event.attestation ?? null }

    default:
      return state
  }
}

const CUSTODY_TERMINAL = new Set(['deposited', 'failed', 'bridged', 'bridge-failed'])

/**
 * A receipt is complete only when EVERY planned allocation (state.plan.agents, post-eligibility)
 * has reached an explicit, terminal custody state -- deposited/failed for a deposit lane,
 * bridged/bridge-failed for a bridge lane. An allocation with no custody entry yet, or one stuck
 * mid-flight (e.g. only 'queued'/'started'/'pulled', or a non-terminal/'unknown' base-job status),
 * is not complete. Ignores `state.attestation` entirely (see ATTESTATION_RECEIVED above).
 * @param {object} state strategyFlowReducer state
 * @returns {boolean}
 */
export function isReceiptComplete(state) {
  const agents = state?.plan?.agents
  if (!Array.isArray(agents) || agents.length === 0) return false
  return agents.every((a) => CUSTODY_TERMINAL.has(state.custody[a.allocationId]?.status))
}
