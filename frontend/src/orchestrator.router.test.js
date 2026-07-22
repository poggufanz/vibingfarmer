// frontend/src/orchestrator.router.test.js
// Strategy Task 7 (Pocket Crew redesign, Wave 1). The permission-locked dispatch path:
// `dispatch(strategyPlan, { permissionDecision })`. This file replaces its pre-Task-7 content,
// which exercised the LEGACY `dispatch(strategy, totalAmount)` router path's opportunistic
// tryReuseAllCached selection — that legacy behavior is UNCHANGED (dispatchLegacy is a
// byte-for-byte rename) and stays covered by orchestrator.test.js + orchestrator.baseleg.test.js.
// This file covers ONLY the new StrategyPlan/PermissionDecisionV1-driven path: fresh mode never
// opportunistically takes cache entries, reuse mode never touches the wallet/grant, both modes
// reject a stale plan/AgentInit pairing before any movement, reuse revalidates through a freshly
// captured preflight immediately before the first pull, a confirmed fresh grant emits
// grant-confirmed before worker movement, every fresh-grant failure mode throws
// PermissionPhaseError(phase:'fresh-grant'), and the queue/dispatch events carry real order.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const submitGrantMock = vi.fn()
const runAgentPullMock = vi.fn()
const readAllowanceMock = vi.fn()
const readConfirmedLedgerMock = vi.fn()
vi.mock('./stellar/grant.js', () => ({
  submitGrant: (...a) => submitGrantMock(...a),
  runAgentPull: (...a) => runAgentPullMock(...a),
  readAllowance: (...a) => readAllowanceMock(...a),
  readConfirmedLedger: (...a) => readConfirmedLedgerMock(...a),
  AGENT_KIND_DEPOSIT: 0,
  AGENT_KIND_BRIDGE: 1,
}))

// Legacy per-agent setup helpers must never be called on the permission-locked path.
const deployAgentForSessionMock = vi.fn()
const fundAgentMock = vi.fn()
const registryAuthorizeAgentMock = vi.fn()
vi.mock('./stellar/agentSetup.js', () => ({
  deployAgentForSession: (...a) => deployAgentForSessionMock(...a),
  fundAgent: (...a) => fundAgentMock(...a),
  registryAuthorizeAgent: (...a) => registryAuthorizeAgentMock(...a),
}))

const takeReusableAgentMock = vi.fn(async () => null)
const saveCachedAgentMock = vi.fn()
const loadCachedAgentsMock = vi.fn(() => [])
vi.mock('./stellar/agentCache.js', () => ({
  takeReusableAgent: (...a) => takeReusableAgentMock(...a),
  saveCachedAgent: (...a) => saveCachedAgentMock(...a),
  loadCachedAgents: (...a) => loadCachedAgentsMock(...a),
}))

vi.mock('./stellar/sessionKey.js', () => ({
  newSessionKey: (secret) => ({
    publicKey: secret ? `GRESTORED-${secret}` : 'GFRESH',
    secret: secret || 'SFRESH',
    rawPublicKey: new Uint8Array(32).fill(secret ? secret.length + 1 : 9),
    sign: () => new Uint8Array(64),
  }),
}))

const readTokenBalanceMock = vi.fn(async () => null)
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
}))

vi.mock('./stellar/config.js', () => ({
  SOROBAN_TOKEN_ADDRESS: 'CTOKEN',
  SOROBAN_DECIMALS: 7,
  SOROBAN_ACTIVE_VAULT_ADDRESS: 'CACTIVEVAULT',
  SOROBAN_FUNDING_ROUTER_ADDRESS: 'CROUTER',
  USE_FUNDING_ROUTER: true,
}))
vi.mock('./strategist.js', () => ({ generateAgentSkills: vi.fn(async () => ({})) }))
vi.mock('./skills.js', () => ({ saveSkill: vi.fn() }))
vi.mock('./mergeFlowHelpers.js', () => ({ readStoredBaseMandate: vi.fn() }))

const preflightPermissionMock = vi.fn()
vi.mock('./strategy/reusePreflight.js', () => ({
  preflightPermission: (...a) => preflightPermissionMock(...a),
}))

const saveGrantReceiptMock = vi.fn()
const fingerprintGrantReceiptMock = vi.fn(() => '0xRECEIPTFRESH')
vi.mock('./stellar/grantReceiptStore.js', () => ({
  buildGrantReceiptV1: (p) => ({ version: 1, ...p }),
  saveGrantReceipt: (...a) => saveGrantReceiptMock(...a),
  fingerprintGrantReceipt: (...a) => fingerprintGrantReceiptMock(...a),
}))

const workerInstances = []
const executeCalls = []
vi.mock('./worker.js', () => ({
  WorkerAgent: class {
    constructor(c) {
      Object.assign(this, c)
      workerInstances.push(this)
    }
    async setupKey() {
      if (!this.sessionKey) {
        const n = workerInstances.indexOf(this)
        this.sessionKey = {
          publicKey: `GPUB${n}`,
          secret: `SFRESH${n}`,
          rawPublicKey: new Uint8Array(32).fill(n + 1),
        }
      }
      return this.sessionKey
    }
    async execute() {
      executeCalls.push(this.allocationId)
      return { success: true, txHash: `0xW${this.allocationId}` }
    }
  },
  makeAgentId: (i, s) => `0x${i}${s}`,
}))

import { OrchestratorAgent } from './orchestrator.js'
import { PermissionPhaseError } from './strategy/permissionError.js'

function planAgent(i, units) {
  return {
    allocationId: `run1:deposit:${i}`,
    kind: 'deposit',
    hostNetworkId: 'stellar-testnet',
    allocation: { token: 'CTOKEN', units: String(units), decimals: 7 },
    cap: { token: 'CTOKEN', units: String(units), decimals: 7 },
    periodSeconds: 3600,
    expiry: 2000000000,
    destination: 'Stellar deposit',
    children: [],
  }
}

const PLAN = Object.freeze({
  runId: 'run1',
  planFingerprint: '0xPLAN',
  agents: [planAgent(0, '400000000'), planAgent(1, '600000000')],
})

function reviewedInitFor(agent) {
  return {
    allocationId: agent.allocationId,
    kind: 0,
    token: agent.cap.token,
    target: 'CACTIVEVAULT',
    cap: { token: agent.cap.token, units: agent.cap.units, decimals: agent.cap.decimals },
    periodSeconds: agent.periodSeconds,
    expiry: agent.expiry,
    signerFingerprint: '0xsig',
    saltFingerprint: null,
    destinationDomain: 0,
    mintRecipient: '00'.repeat(32),
  }
}

function freshDecisionFor(plan) {
  return {
    version: 1,
    runId: plan.runId,
    owner: 'GUSER',
    planFingerprint: plan.planFingerprint,
    agentInitFingerprint: '0xAI',
    checkedAt: 1000,
    reviewedBudgets: [{ token: 'CTOKEN', units: '1000000000', decimals: 7 }],
    durationSeconds: 3600,
    reviewedAgentInits: plan.agents.map(reviewedInitFor),
    mode: 'fresh',
    confirmationCount: 1,
    grantReceiptFingerprint: null,
    allowanceExpiryProof: null,
    agents: [],
    freshReason: 'allowance-proof-missing',
  }
}

function reuseDecisionFor(plan, addresses) {
  return {
    version: 1,
    runId: plan.runId,
    owner: 'GUSER',
    planFingerprint: plan.planFingerprint,
    agentInitFingerprint: '0xAI',
    checkedAt: 1000,
    reviewedBudgets: [{ token: 'CTOKEN', units: '1000000000', decimals: 7 }],
    durationSeconds: 3600,
    reviewedAgentInits: plan.agents.map(reviewedInitFor),
    mode: 'reuse',
    confirmationCount: 0,
    grantReceiptFingerprint: '0xRECEIPT',
    allowanceExpiryProof: {
      version: 1,
      latestLedger: 5000,
      approvals: [{ token: 'CTOKEN', units: '1000000000', decimals: 7, expiryLedger: 9999 }],
    },
    agents: plan.agents.map((a, i) => ({
      allocationId: a.allocationId,
      workerId: a.allocationId,
      agentAddress: addresses[i],
      headroom: { token: 'CTOKEN', units: a.cap.units, decimals: 7 },
      scopeExpiry: 9999,
      scopeFingerprint: `0xSF${i}`,
      executionCredentialRef: addresses[i],
    })),
    freshReason: null,
  }
}

beforeEach(() => {
  workerInstances.length = 0
  executeCalls.length = 0
  submitGrantMock.mockReset()
  runAgentPullMock.mockReset()
  runAgentPullMock.mockResolvedValue({ hash: 'HP', status: 'SUCCESS' })
  readAllowanceMock.mockReset()
  readConfirmedLedgerMock.mockReset()
  readConfirmedLedgerMock.mockResolvedValue({ confirmedLedger: 123, confirmedAt: 555 })
  deployAgentForSessionMock.mockClear()
  fundAgentMock.mockClear()
  registryAuthorizeAgentMock.mockClear()
  takeReusableAgentMock.mockReset()
  takeReusableAgentMock.mockResolvedValue(null)
  saveCachedAgentMock.mockClear()
  loadCachedAgentsMock.mockReset()
  loadCachedAgentsMock.mockReturnValue([])
  readTokenBalanceMock.mockReset()
  readTokenBalanceMock.mockResolvedValue(0n)
  preflightPermissionMock.mockReset()
  saveGrantReceiptMock.mockClear()
  fingerprintGrantReceiptMock.mockClear()
  fingerprintGrantReceiptMock.mockReturnValue('0xRECEIPTFRESH')
})

function freshGrantHappyPath(addresses = ['CFRESH1', 'CFRESH2']) {
  submitGrantMock.mockResolvedValue({
    hash: 'HG',
    status: 'SUCCESS',
    agentAddresses: addresses,
    expiryLedger: 9999,
  })
}

describe('dispatch(strategyPlan, { permissionDecision }) — fresh mode', () => {
  it('never opportunistically takes cache entries', async () => {
    freshGrantHappyPath()
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1', onEvent: () => {} })
    await orch.dispatch(PLAN, { permissionDecision: freshDecisionFor(PLAN) })
    expect(takeReusableAgentMock).not.toHaveBeenCalled()
    expect(loadCachedAgentsMock).not.toHaveBeenCalled()
    expect(preflightPermissionMock).not.toHaveBeenCalled()
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
  })

  it('builds exactly reviewedBudgets/reviewedAgentInits, never regenerating cap/expiry/period', async () => {
    freshGrantHappyPath()
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1b', onEvent: () => {} })
    const decision = freshDecisionFor(PLAN)
    await orch.dispatch(PLAN, { permissionDecision: decision })
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.budgets).toEqual([{ budget: 1000000000n, token: 'CTOKEN' }])
    expect(grantArgs.durationSeconds).toBe(3600)
    expect(grantArgs.agentInits).toEqual([
      expect.objectContaining({
        cap: 400000000n,
        target: 'CACTIVEVAULT',
        kind: 0,
        periodDuration: 3600,
        expiry: 2000000000,
      }),
      expect.objectContaining({
        cap: 600000000n,
        target: 'CACTIVEVAULT',
        kind: 0,
        periodDuration: 3600,
        expiry: 2000000000,
      }),
    ])
  })

  it("executes exactly the plan's bigint units — never a float re-multiplication", async () => {
    const oddPlan = {
      runId: 'run1',
      planFingerprint: '0xPLANODD',
      agents: [
        {
          ...planAgent(0, '123456789'),
        },
      ],
    }
    freshGrantHappyPath(['CFRESH1'])
    let capturedPullAmount
    runAgentPullMock.mockImplementation(async ({ amount }) => {
      capturedPullAmount = amount
      return { hash: 'HP', status: 'SUCCESS' }
    })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's-units', onEvent: () => {} })
    await orch.dispatch(oddPlan, { permissionDecision: freshDecisionFor(oddPlan) })
    expect(workerInstances[0].amount).toBe(123456789n)
    expect(capturedPullAmount).toBe(123456789n)
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.agentInits[0].cap).toBe(123456789n)
  })

  it('rejects a stale plan fingerprint before any wallet/provider or movement', async () => {
    const decision = { ...freshDecisionFor(PLAN), planFingerprint: '0xSTALE' }
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's3', onEvent: () => {} })
    let caught
    try {
      await orch.dispatch(PLAN, { permissionDecision: decision })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PermissionPhaseError)
    expect(caught.phase).toBe('preflight')
    expect(caught.movement).toBe('none')
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(workerInstances).toHaveLength(0)
  })

  it('rejects an edited reviewed AgentInit (cap drift) before any wallet/provider or movement', async () => {
    const decision = freshDecisionFor(PLAN)
    decision.reviewedAgentInits[0] = {
      ...decision.reviewedAgentInits[0],
      cap: { ...decision.reviewedAgentInits[0].cap, units: '999' },
    }
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's3b', onEvent: () => {} })
    let caught
    try {
      await orch.dispatch(PLAN, { permissionDecision: decision })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PermissionPhaseError)
    expect(caught.phase).toBe('preflight')
    expect(caught.movement).toBe('none')
    expect(submitGrantMock).not.toHaveBeenCalled()
  })

  it('emits grant-confirmed with PermissionConfirmedV1, budgets, and deployed addresses before worker movement', async () => {
    freshGrantHappyPath()
    const callOrder = []
    saveGrantReceiptMock.mockImplementation(() => callOrder.push('receipt-saved'))
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's6',
      onEvent: (n, d) => {
        if (n === 'grant-confirmed') callOrder.push('grant-confirmed')
        if (n === 'worker-queued') callOrder.push('worker-queued')
        events.push({ n, d })
      },
    })
    const decision = freshDecisionFor(PLAN)
    await orch.dispatch(PLAN, { permissionDecision: decision })

    expect(callOrder.indexOf('receipt-saved')).toBeGreaterThanOrEqual(0)
    expect(callOrder.indexOf('receipt-saved')).toBeLessThan(callOrder.indexOf('grant-confirmed'))
    expect(callOrder.indexOf('grant-confirmed')).toBeLessThan(callOrder.indexOf('worker-queued'))

    const ev = events.find((e) => e.n === 'grant-confirmed').d
    expect(ev.confirmed).toMatchObject({
      version: 1,
      runId: 'run1',
      mode: 'fresh',
      planFingerprint: '0xPLAN',
      agentInitFingerprint: '0xAI',
      grantReceiptFingerprint: '0xRECEIPTFRESH',
      confirmationCount: 1,
      txHash: 'HG',
      expiryLedger: 9999,
      agentAddresses: ['CFRESH1', 'CFRESH2'],
    })
    expect(ev.budgets).toEqual(decision.reviewedBudgets)
    expect(ev.agentAddresses).toEqual(['CFRESH1', 'CFRESH2'])
  })

  it.each([
    [
      'wallet rejection / build / simulation / submission failure (one submitGrant call site)',
      () => submitGrantMock.mockRejectedValue(new Error('User declined the request')),
    ],
    [
      'unconfirmed deployment',
      () => {
        freshGrantHappyPath()
        readConfirmedLedgerMock.mockRejectedValue(
          new Error('Transaction HG is not confirmed: FAILED.')
        )
      },
    ],
  ])(
    '%s throws PermissionPhaseError(phase:fresh-grant) and starts no worker',
    async (_label, arrange) => {
      arrange()
      const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's7', onEvent: () => {} })
      let caught
      try {
        await orch.dispatch(PLAN, { permissionDecision: freshDecisionFor(PLAN) })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(PermissionPhaseError)
      expect(caught.phase).toBe('fresh-grant')
      expect(caught.movement).toBe('none')
      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(executeCalls).toHaveLength(0)
    }
  )

  it('emits worker-queued with real queue index for every worker before serial dispatch begins', async () => {
    freshGrantHappyPath()
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's8',
      onEvent: (n, d) => events.push({ n, d }),
    })
    await orch.dispatch(PLAN, { permissionDecision: freshDecisionFor(PLAN) })
    const queued = events.filter((e) => e.n === 'worker-queued')
    expect(queued.map((e) => e.d.queueIndex)).toEqual([0, 1])
    expect(queued.map((e) => e.d.allocationId)).toEqual(['run1:deposit:0', 'run1:deposit:1'])
    const lastQueuedIdx = events.map((e) => e.n).lastIndexOf('worker-queued')
    const firstStartedIdx = events.findIndex((e) => e.n === 'worker-started')
    expect(lastQueuedIdx).toBeLessThan(firstStartedIdx)
  })

  it('dispatches worker-started in plan order through the real 2,000ms relay-safe gap', async () => {
    vi.useFakeTimers()
    try {
      freshGrantHappyPath()
      const events = []
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 's9',
        onEvent: (n, d) => events.push({ n, d }),
      })
      const done = orch.dispatch(PLAN, { permissionDecision: freshDecisionFor(PLAN) })
      await vi.runAllTimersAsync()
      const res = await done
      const started = events.filter((e) => e.n === 'worker-started')
      expect(started.map((e) => e.d.allocationId)).toEqual(['run1:deposit:0', 'run1:deposit:1'])
      expect(res.completed).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('dispatch(strategyPlan, { permissionDecision }) — reuse mode', () => {
  function cacheEntries(addresses) {
    return addresses.map((agentAddress, i) => ({
      agentAddress,
      secret: `S${i}`,
      signerPub: `GPUB${i}`,
      cap: PLAN.agents[i].cap.units,
      expiry: 2000000000,
    }))
  }

  it('never builds/submits funding_router.grant or invokes the wallet/provider', async () => {
    const addresses = ['CCACHED1', 'CCACHED2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionFor(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue(decision)
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's2', onEvent: () => {} })
    const res = await orch.dispatch(PLAN, { permissionDecision: decision })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(res.completed).toBe(2)
    expect(workerInstances.map((w) => w.agentAddress)).toEqual(addresses)
    expect(res.permission).toMatchObject({ mode: 'reuse', txHash: null })
  })

  it('revalidates through a freshly captured preflight immediately before the first pull', async () => {
    const addresses = ['CCACHED1', 'CCACHED2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionFor(PLAN, addresses)
    const callOrder = []
    preflightPermissionMock.mockImplementation(async () => {
      callOrder.push('preflight')
      return decision
    })
    runAgentPullMock.mockImplementation(async () => {
      callOrder.push('pull')
      return { hash: 'HP', status: 'SUCCESS' }
    })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's4', onEvent: () => {} })
    await orch.dispatch(PLAN, { permissionDecision: decision })
    expect(preflightPermissionMock).toHaveBeenCalledTimes(1)
    expect(callOrder[0]).toBe('preflight')
    expect(callOrder.slice(1)).toEqual(['pull', 'pull'])
    const call = preflightPermissionMock.mock.calls[0][0]
    expect(call.agentInits).toHaveLength(2)
    expect(call.agentInits[0].signer).toBeInstanceOf(Uint8Array)
    expect(call.reviewedBudgets).toEqual(decision.reviewedBudgets)
    expect(call.durationSeconds).toBe(decision.durationSeconds)
  })

  it('changed reuse evidence (mode flips away from reuse) throws VF_REUSE_EVIDENCE_CHANGED, never a wallet fallback', async () => {
    const addresses = ['CCACHED1', 'CCACHED2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionFor(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue({
      ...decision,
      mode: 'fresh',
      freshReason: 'allowance-mutated',
      agents: [],
    })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's5', onEvent: () => {} })
    let caught
    try {
      await orch.dispatch(PLAN, { permissionDecision: decision })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PermissionPhaseError)
    expect(caught.phase).toBe('reuse-revalidation')
    expect(caught.code).toBe('VF_REUSE_EVIDENCE_CHANGED')
    expect(caught.movement).toBe('none')
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
  })

  it('a changed scope fingerprint on revalidation throws VF_REUSE_EVIDENCE_CHANGED', async () => {
    const addresses = ['CCACHED1', 'CCACHED2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionFor(PLAN, addresses)
    const drifted = reuseDecisionFor(PLAN, addresses)
    drifted.agents[0] = { ...drifted.agents[0], scopeFingerprint: '0xDRIFTED' }
    preflightPermissionMock.mockResolvedValue(drifted)
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's5c', onEvent: () => {} })
    await expect(orch.dispatch(PLAN, { permissionDecision: decision })).rejects.toMatchObject({
      phase: 'reuse-revalidation',
      code: 'VF_REUSE_EVIDENCE_CHANGED',
      movement: 'none',
    })
  })

  it('a missing cached session key for a reviewed reuse credential is evidence-changed, not a fresh fallback', async () => {
    loadCachedAgentsMock.mockReturnValue([]) // the cache was cleared since preflight
    const decision = reuseDecisionFor(PLAN, ['CCACHED1', 'CCACHED2'])
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's5b', onEvent: () => {} })
    await expect(orch.dispatch(PLAN, { permissionDecision: decision })).rejects.toMatchObject({
      phase: 'reuse-revalidation',
      code: 'VF_REUSE_EVIDENCE_CHANGED',
      movement: 'none',
    })
    expect(preflightPermissionMock).not.toHaveBeenCalled()
    expect(submitGrantMock).not.toHaveBeenCalled()
  })

  it('isolates one worker pull failure from the rest', async () => {
    const addresses = ['CCACHED1', 'CCACHED2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionFor(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue(decision)
    runAgentPullMock.mockImplementation(async ({ agentAddress }) => {
      if (agentAddress === 'CCACHED2') throw new Error('router pull reported FAILED')
      return { hash: 'HP', status: 'SUCCESS' }
    })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's-iso', onEvent: () => {} })
    const res = await orch.dispatch(PLAN, { permissionDecision: decision })
    expect(res.completed).toBe(1)
    expect(res.failed).toBe(1)
    expect(res.results.find((r) => !r.success).error).toMatch(/router pull reported FAILED/)
  })
})
