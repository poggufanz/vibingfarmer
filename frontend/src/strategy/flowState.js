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

function applyCustodyEvent(custody, event) {
  const { agentId } = event
  if (!agentId) return custody
  const row = custody[agentId]
  switch (event.type) {
    case 'PULL_CONFIRMED':
      return { ...custody, [agentId]: { ...row, status: 'pulled' } }
    case 'PULL_FAILED':
      return { ...custody, [agentId]: { ...row, status: 'failed', error: event.error ?? null } }
    case 'DEPOSIT_CONFIRMED':
      return { ...custody, [agentId]: { ...row, status: 'deposited' } }
    case 'DEPOSIT_FAILED':
      return { ...custody, [agentId]: { ...row, status: 'failed', error: event.error ?? null } }
    case 'BASE_JOB_UPDATED':
      return { ...custody, [agentId]: { ...row, status: event.status, jobId: event.jobId } }
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
      }

    case 'GRANT_REQUESTED':
      if (state.moment !== 'protect') return state
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
      if (state.moment !== 'protect') return state
      return {
        ...state,
        permissionStatus: 'rejected',
        protectMessage: 'Nothing moved',
        retryable: true,
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
 * mid-flight (e.g. only 'pulled', or a non-terminal base-job status), is not complete. Ignores
 * `state.attestation` entirely (see ATTESTATION_RECEIVED above).
 * @param {object} state strategyFlowReducer state
 * @returns {boolean}
 */
export function isReceiptComplete(state) {
  const agents = state?.plan?.agents
  if (!Array.isArray(agents) || agents.length === 0) return false
  return agents.every((a) => CUSTODY_TERMINAL.has(state.custody[a.allocationId]?.status))
}
