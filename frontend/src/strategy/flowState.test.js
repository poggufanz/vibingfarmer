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

  it('wallet rejection preserves the plan and returns Protect to a retryable state with "Nothing moved"', () => {
    let s = toProtect()
    const before = s.plan
    s = strategyFlowReducer(s, { type: 'PREFLIGHT_READY', decision: decision() })
    s = strategyFlowReducer(s, { type: 'GRANT_REQUESTED' })
    s = strategyFlowReducer(s, { type: 'WALLET_REJECTED', reason: 'user-declined' })
    expect(s.moment).toBe('protect')
    expect(s.plan).toBe(before)
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
})

describe('Start moment gating', () => {
  it('worker/bridge events cannot run before permission confirmation (Plan)', () => {
    const before = initialStrategyFlowState
    const after = strategyFlowReducer(before, {
      type: 'PULL_CONFIRMED',
      agentId: 'run-1:deposit:0',
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
      agentId: 'run-1:deposit:0',
    })
    expect(after).toBe(before)
  })

  it('worker/bridge events apply once Start is reached', () => {
    let s = toStartViaFreshGrant()
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', agentId: 'run-1:deposit:0' })
    expect(s.custody['run-1:deposit:0'].status).toBe('pulled')
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
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', agentId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', agentId: 'a' })
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', agentId: 'b' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_FAILED', agentId: 'b', error: 'relay-timeout' })
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
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', agentId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', agentId: 'a' })
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
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', agentId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', agentId: 'a' })
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', agentId: 'b' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_FAILED', agentId: 'b', error: 'relay-timeout' })
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
      agentId: 'br',
      jobId: 'job-1',
      status: 'submitted',
    })
    expect(isReceiptComplete(s)).toBe(false)
    s = strategyFlowReducer(s, {
      type: 'BASE_JOB_UPDATED',
      agentId: 'br',
      jobId: 'job-1',
      status: 'bridged',
    })
    expect(isReceiptComplete(s)).toBe(true)
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
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', agentId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', agentId: 'a' })
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
    s = strategyFlowReducer(s, { type: 'PULL_CONFIRMED', agentId: 'a' })
    s = strategyFlowReducer(s, { type: 'DEPOSIT_CONFIRMED', agentId: 'a' })
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
