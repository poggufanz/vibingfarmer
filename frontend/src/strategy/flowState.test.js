// frontend/src/strategy/flowState.test.js — Strategy Task 6 (Pocket Crew redesign, Wave 1).
// The three-moment (plan -> protect -> start) reducer. Pure, synchronous, no I/O: every invariant
// here is about which events can move the moment forward and which custody/permission facts
// survive a partial branch failure, never about calling a wallet, relay, or contract.
import { describe, it, expect } from 'vitest'
import {
  STRATEGY_MOMENTS,
  initialStrategyFlowState,
  strategyFlowReducer,
  isReceiptComplete,
} from './flowState.js'

const eligiblePlan = (agents = [{ allocationId: 'run-1:deposit:0', kind: 'deposit' }]) => ({
  runId: 'run-1',
  planFingerprint: '0xplan',
  agents,
})

const allIneligiblePlan = () => eligiblePlan([])

const decision = (over = {}) => ({
  version: 1,
  runId: 'run-1',
  mode: 'fresh',
  planFingerprint: '0xplan',
  agentInitFingerprint: '0xagents',
  grantReceiptFingerprint: null,
  agents: [],
  ...over,
})

function toProtect(state = initialStrategyFlowState) {
  let s = strategyFlowReducer(state, { type: 'PLAN_READY', plan: eligiblePlan() })
  s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
  return s
}

function toStartViaFreshGrant(state = toProtect()) {
  let s = strategyFlowReducer(state, { type: 'PREFLIGHT_READY', decision: decision() })
  s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
  s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
  return s
}

describe('STRATEGY_MOMENTS', () => {
  it('is exactly plan, protect, start in order', () => {
    expect(STRATEGY_MOMENTS).toEqual(['plan', 'protect', 'start'])
  })
})

describe('initialStrategyFlowState', () => {
  it('starts in the plan moment with nothing decided yet', () => {
    expect(initialStrategyFlowState.moment).toBe('plan')
    expect(initialStrategyFlowState.plan).toBeNull()
    expect(initialStrategyFlowState.permission).toBeNull()
    expect(initialStrategyFlowState.custody).toEqual({})
  })
})

describe('Plan moment', () => {
  it('PLAN_REQUESTED/PLAN_READY/PLAN_FAILED all stay in Plan', () => {
    let s = strategyFlowReducer(initialStrategyFlowState, { type: 'PLAN_REQUESTED' })
    expect(s.moment).toBe('plan')
    s = strategyFlowReducer(s, { type: 'PLAN_READY', plan: eligiblePlan() })
    expect(s.moment).toBe('plan')
    expect(s.plan).toEqual(eligiblePlan())
    s = strategyFlowReducer(s, { type: 'PLAN_FAILED', error: 'boom' })
    expect(s.moment).toBe('plan')
    expect(s.planError).toBe('boom')
  })

  it('an all-ineligible plan never reaches Protect', () => {
    let s = strategyFlowReducer(initialStrategyFlowState, {
      type: 'PLAN_READY',
      plan: allIneligiblePlan(),
    })
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    expect(s.moment).toBe('plan')
  })

  it('a plan with at least one eligible agent reaches Protect', () => {
    const s = toProtect()
    expect(s.moment).toBe('protect')
  })
})

describe('Protect moment', () => {
  it('PROTECT_OPENED/PREFLIGHT_READY/GRANT_REQUESTED all stay in Protect', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    expect(s.moment).toBe('protect')
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    expect(s.moment).toBe('protect')
    expect(s.permission).toEqual(decision())
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    expect(s.moment).toBe('protect')
    expect(s.permissionStatus).toBe('grant-requested')
  })

  it('wallet rejection preserves the plan and permission, returns Protect to a retryable state with "Nothing moved"', () => {
    let s = toProtect()
    const before = s.plan
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    const permissionBefore = s.permission
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_REJECTED', reason: 'user-declined' })
    expect(s.moment).toBe('protect')
    expect(s.plan).toBe(before)
    expect(s.permission).toBe(permissionBefore) // NOT cleared -- only the signature attempt failed
    expect(s.protectMessage).toBe('Nothing moved')
    expect(s.permissionStatus).toBe('rejected')
    expect(s.retryable).toBe(true)
  })

  it('wallet failure behaves identically to rejection', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_FAILED', error: 'network-timeout' })
    expect(s.moment).toBe('protect')
    expect(s.protectMessage).toBe('Nothing moved')
    expect(s.retryable).toBe(true)
  })

  it('wallet rejection populates permissionError from event.reason', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_REJECTED', reason: 'user-declined' })
    expect(s.permissionError).toBe('user-declined')
  })

  it('wallet failure populates permissionError from event.error -- distinguishable from a rejection', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_FAILED', error: 'network-timeout' })
    expect(s.permissionError).toBe('network-timeout')
    // Before this field existed, a rejection and a failure produced byte-identical state --
    // proven here by showing each's permissionError reflects its OWN distinct real-world cause.
    expect(s.permissionError).not.toBe('user-declined')
  })

  it('a WALLET_REJECTED/WALLET_FAILED with no reason/error still defines permissionError (never undefined)', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_REJECTED' })
    expect(s.permissionError).toBeNull()
  })

  it('WALLET_REJECTED/WALLET_FAILED are no-ops when no grant was ever requested (same-reference ignore)', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    const before = s
    expect(strategyFlowReducer(s, { type: 'WALLET_REJECTED' })).toBe(before)
    expect(strategyFlowReducer(s, { type: 'WALLET_FAILED' })).toBe(before)
    expect(before.permissionStatus).toBe('preflight-ready') // untouched, never flipped to 'rejected'
  })

  it('WALLET_REJECTED/WALLET_FAILED are no-ops once a rejection was already retried into a fresh review', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_REJECTED' })
    // A brand-new PREFLIGHT_READY (re-review) resets permissionStatus away from 'grant-requested' —
    // a STALE WALLET_REJECTED for the earlier attempt must not retroactively apply to the new one.
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    const before = s
    expect(strategyFlowReducer(s, { type: 'WALLET_REJECTED' })).toBe(before)
  })

  it('a retryable Protect can be retried back into GRANT_REQUESTED', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_REJECTED' })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    expect(s.moment).toBe('protect')
    expect(s.permissionStatus).toBe('grant-requested')
    expect(s.protectMessage).toBeNull()
  })
})

describe('PREFLIGHT_FAILED (Task 13, decision log #22 obligation A)', () => {
  it('fires from idle (the FIRST permission check failing) -- "outside grant-requested", the case WALLET_* cannot reach', () => {
    const s = toProtect()
    expect(s.permissionStatus).toBe('idle')
    const after = strategyFlowReducer(s, { type: 'PREFLIGHT_FAILED', error: 'network-down' })
    expect(after.moment).toBe('protect')
    expect(after.permissionStatus).toBe('idle')
    expect(after.protectMessage).toBe('Nothing moved')
    expect(after.retryable).toBe(true)
    expect(after.permissionError).toBe('network-down')
    expect(after.permission).toBeNull()
  })

  it("clears an already-held decision -- proven stale, matching ProtectStage.jsx's own PermissionPhaseError handling", () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision({ mode: 'reuse' }) })
    expect(s.permission).not.toBeNull()
    const after = strategyFlowReducer(s, {
      type: 'PREFLIGHT_FAILED',
      error: 'reuse evidence changed',
    })
    expect(after.permission).toBeNull()
    expect(after.permissionStatus).toBe('idle')
  })

  it('also fires mid-authorize, from grant-requested -- a fresh grant whose prepared material went stale', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    expect(s.permissionStatus).toBe('grant-requested')
    const after = strategyFlowReducer(s, { type: 'PREFLIGHT_FAILED', error: 'material stale' })
    expect(after.moment).toBe('protect')
    expect(after.permissionStatus).toBe('idle')
    expect(after.permission).toBeNull()
  })

  it('is a no-op outside the protect moment (same-reference ignore)', () => {
    const before = initialStrategyFlowState
    expect(strategyFlowReducer(before, { type: 'PREFLIGHT_FAILED', error: 'x' })).toBe(before)
    const started = toStartViaFreshGrant()
    expect(strategyFlowReducer(started, { type: 'PREFLIGHT_FAILED', error: 'x' })).toBe(started)
  })

  it('a subsequent successful PREFLIGHT_READY clears permissionError (no stale error lingers into a fresh review)', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_FAILED', error: 'network-down' })
    expect(s.permissionError).toBe('network-down')
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    expect(s.permissionError).toBeNull()
  })

  it('after a preflight failure, retrying re-enters via a fresh PREFLIGHT_READY -- GRANT_REQUESTED alone cannot skip straight there', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_FAILED', error: 'network-down' })
    const after = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    expect(after).toBe(s) // still 'idle' -- GRANT_REQUESTED's gate only admits preflight-ready/rejected
  })
})

describe('Entering Start', () => {
  it('a confirmed fresh grant enters Start', () => {
    const s = toStartViaFreshGrant()
    expect(s.moment).toBe('start')
    expect(s.permissionStatus).toBe('grant-confirmed')
  })

  it('a revalidated reuse decision enters Start without ever requesting a grant', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision({ mode: 'reuse' }) })
    s = strategyFlowReducer(s, { type: 'REUSE_CONFIRMED' })
    expect(s.moment).toBe('start')
    expect(s.permissionStatus).toBe('reuse-confirmed')
  })

  // Fix loop 1 (Minor, Strategy Task 13 review): reject -> retry -> success used to leave the
  // FIRST attempt's permissionError sitting in state even though GRANT_CONFIRMED is a genuine
  // success -- protectMessage was already cleared on confirm, but permissionError was not, so a
  // caller branching on permissionError (rather than protectMessage) saw a stale failure.
  it('GRANT_CONFIRMED clears a permissionError left over from an earlier rejected attempt', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_REJECTED', reason: 'user-declined' })
    expect(s.permissionError).toBe('user-declined') // sanity: the stale value really is there
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' }) // retry
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' }) // success
    expect(s.moment).toBe('start')
    expect(s.permissionError).toBeNull()
  })

  // REUSE_CONFIRMED's own gate (permissionStatus === 'preflight-ready') can only be reached via a
  // PREFLIGHT_READY, which already clears permissionError itself -- so this exact stale value is
  // not reachable through the public event chain today. Constructing the pre-confirm state
  // directly still proves the invariant the reducer's OWN case must hold on its own terms (the
  // same defensive clear GRANT_CONFIRMED needed), not merely "unreachable so untested."
  it('REUSE_CONFIRMED clears permissionError even if the incoming state somehow still carried one', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision({ mode: 'reuse' }) })
    s = { ...s, permissionError: 'stale-from-elsewhere' }
    s = strategyFlowReducer(s, { type: 'REUSE_CONFIRMED' })
    expect(s.moment).toBe('start')
    expect(s.permissionError).toBeNull()
  })

  it('GRANT_CONFIRMED without a prior GRANT_REQUESTED does not enter Start', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
    expect(s.moment).toBe('protect')
  })

  it('REUSE_CONFIRMED without a prior reuse PREFLIGHT_READY does not enter Start', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'REUSE_CONFIRMED' })
    expect(s.moment).toBe('protect')
  })

  it('a merely-requested (unconfirmed) grant does not enter Start', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    expect(s.moment).toBe('protect')
  })

  it('GRANT_REQUESTED requires a prior PREFLIGHT_READY (symmetry with the reuse path) -- idle cannot skip straight to a grant request', () => {
    const s = toProtect()
    const after = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    expect(after).toBe(s) // ignored: permissionStatus is still 'idle', permission is still null
  })
})

describe('Start moment gating', () => {
  it('worker/bridge events cannot run before permission confirmation (Plan)', () => {
    const before = initialStrategyFlowState
    const after = strategyFlowReducer(before, {
      type: 'PULL_CONFIRMED',
      allocationId: 'run-1:deposit:0',
    })
    expect(after).toBe(before) // untouched — the event is simply not applicable yet
  })

  it('worker/bridge events cannot run before permission confirmation (Protect, mid-review)', () => {
    let s = toProtect()
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    const before = s
    const after = strategyFlowReducer(s, {
      type: 'DEPOSIT_CONFIRMED',
      allocationId: 'run-1:deposit:0',
    })
    expect(after).toBe(before)
  })

  it('worker/bridge events apply once Start is reached', () => {
    let s = toStartViaFreshGrant()
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', allocationId: 'run-1:deposit:0' })
    expect(s.custody['run-1:deposit:0'].status).toBe('pulled')
  })

  it('WORKER_QUEUED/WORKER_STARTED cannot run before permission confirmation', () => {
    const before = initialStrategyFlowState
    expect(strategyFlowReducer(before, { type: 'WORKER_QUEUED', allocationId: 'a' })).toBe(before)
    expect(strategyFlowReducer(before, { type: 'WORKER_STARTED', allocationId: 'a' })).toBe(before)
  })

  it('a lane must be queued before it can start (same-reference ignore otherwise)', () => {
    const s = toStartViaFreshGrant()
    const after = strategyFlowReducer(s, {
      type: 'WORKER_STARTED',
      allocationId: 'run-1:deposit:0',
    })
    expect(after).toBe(s) // never queued -- ignored
  })

  it('WORKER_QUEUED then WORKER_STARTED tracks per-lane progress in order', () => {
    let s = toStartViaFreshGrant()
    s = strategyFlowReducer(s, { type: 'WORKER_QUEUED', allocationId: 'run-1:deposit:0' })
    expect(s.custody['run-1:deposit:0'].status).toBe('queued')
    s = strategyFlowReducer(s, { type: 'WORKER_STARTED', allocationId: 'run-1:deposit:0' })
    expect(s.custody['run-1:deposit:0'].status).toBe('started')
  })

  it('WORKER_QUEUED cannot regress an already-deposited lane (same-reference ignore)', () => {
    let s = toStartViaFreshGrant()
    s = strategyFlowReducer(s, { type: 'WORKER_QUEUED', allocationId: 'run-1:deposit:0' })
    s = strategyFlowReducer(s, { type: 'WORKER_STARTED', allocationId: 'run-1:deposit:0' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', allocationId: 'run-1:deposit:0' })
    expect(s.custody['run-1:deposit:0'].status).toBe('deposited')
    const before = s
    const after = strategyFlowReducer(s, { type: 'WORKER_QUEUED', allocationId: 'run-1:deposit:0' })
    expect(after).toBe(before)
    expect(after.custody['run-1:deposit:0'].status).toBe('deposited')
  })

  it('WORKER_QUEUED cannot regress an already-bridged lane', () => {
    let s = toStartViaFreshGrant()
    s = strategyFlowReducer(s, {
      type: 'BASE_JOB_UPDATED',
      allocationId: 'run-1:deposit:0',
      status: 'bridged',
      jobId: 'j1',
    })
    expect(s.custody['run-1:deposit:0'].status).toBe('bridged')
    const before = s
    const after = strategyFlowReducer(s, { type: 'WORKER_QUEUED', allocationId: 'run-1:deposit:0' })
    expect(after).toBe(before)
  })
})

describe('Partial branch results', () => {
  it('a failed lane does not erase an already-successful sibling lane', () => {
    const plan = eligiblePlan([
      { allocationId: 'a', kind: 'deposit' },
      { allocationId: 'b', kind: 'deposit' },
    ])
    let s = strategyFlowReducer(initialStrategyFlowState, { type: 'PLAN_READY', plan })
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', allocationId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', allocationId: 'a' })
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', allocationId: 'b' })
    s = strategyFlowReducer(s, {
      type: 'DEPOSIT_FAILED',
      allocationId: 'b',
      error: 'relay-timeout',
    })
    expect(s.custody.a.status).toBe('deposited')
    expect(s.custody.b.status).toBe('failed')
  })
})

describe('Receipt completion', () => {
  it('is incomplete while any planned allocation has no explicit custody state', () => {
    const plan = eligiblePlan([
      { allocationId: 'a', kind: 'deposit' },
      { allocationId: 'b', kind: 'deposit' },
    ])
    let s = strategyFlowReducer(initialStrategyFlowState, { type: 'PLAN_READY', plan })
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', allocationId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', allocationId: 'a' })
    expect(isReceiptComplete(s)).toBe(false) // b has no custody state at all yet
  })

  it('is complete once every planned allocation has an explicit terminal custody state, mixed outcomes included', () => {
    const plan = eligiblePlan([
      { allocationId: 'a', kind: 'deposit' },
      { allocationId: 'b', kind: 'deposit' },
    ])
    let s = strategyFlowReducer(initialStrategyFlowState, { type: 'PLAN_READY', plan })
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', allocationId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', allocationId: 'a' })
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', allocationId: 'b' })
    s = strategyFlowReducer(s, {
      type: 'DEPOSIT_FAILED',
      allocationId: 'b',
      error: 'relay-timeout',
    })
    expect(isReceiptComplete(s)).toBe(true)
  })

  it('a bridge lane needs a terminal base-job status, not merely an in-flight one', () => {
    const plan = eligiblePlan([{ allocationId: 'br', kind: 'bridge' }])
    let s = strategyFlowReducer(initialStrategyFlowState, { type: 'PLAN_READY', plan })
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
    s = strategyFlowReducer(s, {
      type: 'BASE_JOB_UPDATED',
      allocationId: 'br',
      jobId: 'job-1',
      status: 'submitted',
    })
    expect(isReceiptComplete(s)).toBe(false)
    s = strategyFlowReducer(s, {
      type: 'BASE_JOB_UPDATED',
      allocationId: 'br',
      jobId: 'job-1',
      status: 'bridged',
    })
    expect(isReceiptComplete(s)).toBe(true)
  })

  it('an unrecognized base-job status is stored as "unknown", never terminal -- even if it spoofs a terminal word like "deposited"', () => {
    const plan = eligiblePlan([{ allocationId: 'br', kind: 'bridge' }])
    let s = strategyFlowReducer(initialStrategyFlowState, { type: 'PLAN_READY', plan })
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
    s = strategyFlowReducer(s, {
      type: 'BASE_JOB_UPDATED',
      allocationId: 'br',
      jobId: 'job-1',
      status: 'deposited', // not a real base-job status -- must not be trusted verbatim
    })
    expect(s.custody.br.status).toBe('unknown')
    expect(isReceiptComplete(s)).toBe(false)
  })
})

describe('Attestation never changes deposit completion', () => {
  it('ATTESTATION_RECEIVED before completion does not flip isReceiptComplete', () => {
    const plan = eligiblePlan([{ allocationId: 'a', kind: 'deposit' }])
    let s = strategyFlowReducer(initialStrategyFlowState, { type: 'PLAN_READY', plan })
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
    s = strategyFlowReducer(s, {
      type: 'ATTESTATION_RECEIVED',
      attestation: { proof: '0xdeadbeef' },
    })
    expect(s.attestation).toEqual({ proof: '0xdeadbeef' })
    expect(isReceiptComplete(s)).toBe(false)
    const before = isReceiptComplete(s)
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', allocationId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', allocationId: 'a' })
    expect(isReceiptComplete(s)).toBe(true)
    expect(before).toBe(false) // attestation alone never moved the needle
  })

  it('ATTESTATION_RECEIVED after completion does not un-complete the receipt', () => {
    const plan = eligiblePlan([{ allocationId: 'a', kind: 'deposit' }])
    let s = strategyFlowReducer(initialStrategyFlowState, { type: 'PLAN_READY', plan })
    s = strategyFlowReducer(s, { type: 'PROTECT_OPENED' })
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'GRANT_CONFIRMED' })
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', allocationId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', allocationId: 'a' })
    expect(isReceiptComplete(s)).toBe(true)
    s = strategyFlowReducer(s, { type: 'ATTESTATION_RECEIVED', attestation: { proof: '0xabc' } })
    expect(isReceiptComplete(s)).toBe(true)
  })
})

describe('Unknown events', () => {
  it('are ignored and return the same state reference', () => {
    const before = initialStrategyFlowState
    const after = strategyFlowReducer(before, { type: 'NOT_A_REAL_EVENT' })
    expect(after).toBe(before)
  })
})
