// frontend/src/orchestrator.router.test.js
// Strategy Task 7 (Pocket Crew redesign, Wave 1). Covers TWO call shapes of `dispatch`, both still
// live: (1) the NEW permission-locked path, `dispatch(strategyPlan, { permissionDecision })` —
// fresh mode never opportunistically takes cache entries, reuse mode never touches the
// wallet/grant, both modes reject a stale plan/AgentInit pairing before any movement, reuse
// revalidates through a freshly captured preflight immediately before the first pull, a confirmed
// fresh grant emits grant-confirmed before worker movement, every fresh-grant failure mode throws
// PermissionPhaseError(phase:'fresh-grant'), and the queue/dispatch events carry real order; and
// (2) the LEGACY `dispatch(strategy, totalAmount)` router path (`setupViaRouter` /
// `tryReuseAllCached` / `grantFreshAgents`, unchanged — `dispatchLegacy` is a byte-for-byte rename)
// — restored here (review round 2) after an earlier pass on this file dropped its coverage.
// CORRECTION (Task 6 chunk C1 fix round 1): this path is NOT reached in production anymore.
// `dispatch()` (`orchestrator.js:361-364`) picks `dispatchLegacy` only when its second argument is
// NOT an object, and the sole production call site (`app.jsx:3296`) always passes
// `{permissionDecision}`. Kept here as defensive/regression coverage for a code path that still
// exists and is reachable by any caller that passes a bare number, not because anything in
// production still calls it that way. orchestrator.baseleg.test.js exercises adjacent scenarios
// but not these directly; orchestrator.test.js covers the separate `setupLegacy` (non-router) path.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./base/deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } = await import('./base/hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

const submitGrantMock = vi.fn()
const runAgentPullMock = vi.fn()
const readAllowanceMock = vi.fn()
const readConfirmedLedgerMock = vi.fn()
// Task 5 chunk B: buildAgentPullV3 is dynamically imported from this same module (see
// orchestrator.js's runAgentPullV3) — it must be reachable through THIS mock factory too, never a
// second vi.mock() for the same specifier.
const buildAgentPullV3Mock = vi.fn()
vi.mock('./stellar/grant.js', () => ({
  submitGrant: (...a) => submitGrantMock(...a),
  runAgentPull: (...a) => runAgentPullMock(...a),
  readAllowance: (...a) => readAllowanceMock(...a),
  readConfirmedLedger: (...a) => readConfirmedLedgerMock(...a),
  buildAgentPullV3: (...a) => buildAgentPullV3Mock(...a),
  AGENT_KIND_DEPOSIT: 0,
  AGENT_KIND_BRIDGE: 1,
}))

// Task 5 chunk B: orchestrator.js's V3 pull path dynamically imports the relay client directly
// (mirroring runAgentPull's own relayer-resolve step) — not needed by any V2 scenario in this file.
const getRelayerAddressMock = vi.fn()
const submitViaRelayMock = vi.fn()
vi.mock('./stellar/relay.js', () => ({
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
  submitViaRelay: (...a) => submitViaRelayMock(...a),
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

vi.mock('./stellar/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  SOROBAN_TOKEN_ADDRESS: 'CTOKEN',
  SOROBAN_DECIMALS: 7,
  SOROBAN_ACTIVE_VAULT_ADDRESS: 'CACTIVEVAULT',
  SOROBAN_FUNDING_ROUTER_ADDRESS: 'CROUTER',
  USE_FUNDING_ROUTER: true,
  // Task 5 chunk B — needed by stellar/activeAccount.js's own (unmocked) import of this same
  // module, so a V1-shaped activeAccount fixture can satisfy assertActiveAccountBoundary's
  // network check in the V3 threading test below. Every pre-existing test omits `activeAccount`
  // (defaults to null), so this addition changes nothing for them.
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
}))
// My Money Task 1: USE_FUNDING_ROUTER stays true for this whole file, so dispatchLegacy's
// production-cutoff gate (isLegacyDirectSetupAllowed) should never even be consulted here — the
// router branch handles everything. Mocked (not left real) so the "never consulted" assertion
// below is airtight regardless of the gate's own default.
const isLegacyDirectSetupAllowedMock = vi.fn(() => false)
vi.mock('./stellar/agentCreatorManifest.js', () => ({
  isLegacyDirectSetupAllowed: (...a) => isLegacyDirectSetupAllowedMock(...a),
}))
vi.mock('./strategist.js', () => ({ generateAgentSkills: vi.fn(async () => ({})) }))
vi.mock('./skills.js', () => ({ saveSkill: vi.fn() }))
vi.mock('./mergeFlowHelpers.js', () => ({ readStoredBaseMandate: vi.fn() }))

const preflightPermissionMock = vi.fn()
const fetchPreparedExecutionMaterialMock = vi.fn()
vi.mock('./strategy/reusePreflight.js', () => ({
  preflightPermission: (...a) => preflightPermissionMock(...a),
  fetchPreparedExecutionMaterial: (...a) => fetchPreparedExecutionMaterialMock(...a),
}))

const saveGrantReceiptMock = vi.fn()
const fingerprintGrantReceiptMock = vi.fn(() => '0xRECEIPTFRESH')
vi.mock('./stellar/grantReceiptStore.js', () => ({
  buildGrantReceiptV1: (p) => ({ version: 1, ...p }),
  saveGrantReceipt: (...a) => saveGrantReceiptMock(...a),
  fingerprintGrantReceipt: (...a) => fingerprintGrantReceiptMock(...a),
}))

// Task 6 chunk C1 fix round 1, Important 3 -- the AllocationReceiptV2 transport (Chunk B). Mocked
// the same way every other network-touching dependency in this file is: the REAL orchestrator.js
// dispatch loops run unmocked, so the V3-executionId-in-evidence test below can assert exactly
// what body was posted.
const postReceiptEvidenceMock = vi.fn()
vi.mock('./stellar/agentIndexReceiptClient.js', () => ({
  postReceiptEvidence: (...a) => postReceiptEvidenceMock(...a),
  ReceiptEvidenceError: class ReceiptEvidenceError extends Error {
    constructor(message, opts = {}) {
      super(message)
      this.name = 'ReceiptEvidenceError'
      this.step = opts.step
      this.code = opts.code
    }
  },
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

function reviewedBudgetsFor(plan) {
  const budgetsByToken = new Map()
  for (const agent of plan.agents) {
    const previous = budgetsByToken.get(agent.cap.token)
    budgetsByToken.set(agent.cap.token, {
      token: agent.cap.token,
      units: String(BigInt(previous?.units ?? 0) + BigInt(agent.cap.units)),
      decimals: agent.cap.decimals,
    })
  }
  return [...budgetsByToken.values()]
}

function freshDecisionFor(plan) {
  return {
    version: 1,
    runId: plan.runId,
    owner: 'GUSER',
    planFingerprint: plan.planFingerprint,
    agentInitFingerprint: '0xAI',
    checkedAt: 1000,
    reviewedBudgets: reviewedBudgetsFor(plan),
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

// Task 5 chunk B — a V3-shaped reuse decision, as `permissionGrantV3.proveReusablePermission`
// returns it (version:3, `executions[]`, no `agents[]`), composed with the plan-level fields
// `dispatchPermissioned`'s entry validation reads regardless of router generation
// (`planFingerprint`/`reviewedBudgets`/`reviewedAgentInits` — chunk C's job to assemble this way;
// see the task report). `router`/`permissionId`/`scopeId`/`approval` are the extra V3 identity
// fields proveReusablePermission's own `base` + return object carry.
function reuseDecisionV3For(
  plan,
  addresses,
  { permissionId = '0xPERMISSION', scopeId = '0xSCOPE' } = {}
) {
  return {
    version: 3,
    runId: plan.runId,
    owner: 'GUSER',
    router: 'CROUTERV3',
    network: 'Test SDF Network ; September 2015',
    planFingerprint: plan.planFingerprint,
    permissionId,
    mode: 'reuse',
    freshReason: null,
    scopeId,
    mandateCeilingUnits: '1000000000',
    confirmedSpentUnits: '0',
    remainingHeadroomUnits: '1000000000',
    liveUntilLedger: 987654,
    reviewedBudgets: reviewedBudgetsFor(plan),
    durationSeconds: 3600,
    reviewedAgentInits: plan.agents.map(reviewedInitFor),
    confirmationCount: 0,
    executions: plan.agents.map((a, i) => ({
      executionId: `0xEXEC${i}`,
      runId: plan.runId,
      allocationId: a.allocationId,
      scopeId,
      amountUnits: a.cap.units,
      agentAddress: addresses[i],
    })),
    approval: {
      plannedUnitsNow: '1000000000',
      mandateCeilingUnits: '1000000000',
      durationSeconds: 86400,
      currentLedger: 900000,
      secondsPerLedger: 5,
      liveUntilLedger: 987654,
    },
  }
}

beforeEach(() => {
  workerInstances.length = 0
  executeCalls.length = 0
  isLegacyDirectSetupAllowedMock.mockClear()
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
  buildAgentPullV3Mock.mockReset()
  buildAgentPullV3Mock.mockResolvedValue({ xdr: 'XDR_V3' })
  getRelayerAddressMock.mockReset()
  getRelayerAddressMock.mockResolvedValue('GRELAYER')
  submitViaRelayMock.mockReset()
  submitViaRelayMock.mockResolvedValue({ hash: 'HPV3', status: 'SUCCESS' })
  saveGrantReceiptMock.mockClear()
  fingerprintGrantReceiptMock.mockClear()
  fingerprintGrantReceiptMock.mockReturnValue('0xRECEIPTFRESH')
  fetchPreparedExecutionMaterialMock.mockReset()
  fetchPreparedExecutionMaterialMock.mockImplementation(({ allocationId }) => ({
    signer: new Uint8Array(32).fill(1),
    salt: new Uint8Array(32).fill(2),
    signerSecret: `SPREPARED-${allocationId}`,
  }))
  postReceiptEvidenceMock.mockReset()
  postReceiptEvidenceMock.mockImplementation(async ({ body }) => ({
    requestDigest: 'digest',
    challengeId: 'challenge',
    expiresAt: 0,
    written: 1,
    duplicates: 0,
    version: (body?.expectedVersion ?? 0) + 1,
  }))
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
    expect(grantArgs.reviewedExpiryUnix).toBe(2000000000)
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

  it('passes the earliest reviewed agent expiry to the fresh grant', async () => {
    const plan = {
      ...PLAN,
      agents: [
        { ...PLAN.agents[0], expiry: 2000000200 },
        { ...PLAN.agents[1], expiry: 2000000100 },
      ],
    }
    freshGrantHappyPath()
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1c', onEvent: () => {} })

    await orch.dispatch(plan, { permissionDecision: freshDecisionFor(plan) })

    expect(submitGrantMock.mock.calls[0][0].reviewedExpiryUnix).toBe(2000000100)
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

  // Critical fix (review round 2): fresh dispatch must CONSUME reviewed material, never
  // regenerate it. Missing or fingerprint-mismatched prepared material invalidates the reviewed
  // run instead of silently minting new, unreviewed signer/salt bytes.
  it('missing prepared execution material invalidates the run — VF_PREPARED_MATERIAL_MISSING, never a silent regeneration', async () => {
    freshGrantHappyPath()
    fetchPreparedExecutionMaterialMock.mockReturnValue(null)
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's7b', onEvent: () => {} })
    let caught
    try {
      await orch.dispatch(PLAN, { permissionDecision: freshDecisionFor(PLAN) })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PermissionPhaseError)
    expect(caught.phase).toBe('fresh-grant')
    expect(caught.code).toBe('VF_PREPARED_MATERIAL_MISSING')
    expect(caught.movement).toBe('none')
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(executeCalls).toHaveLength(0)
  })

  it('never regenerates a fresh signer when reviewed material is fetched — no worker.setupKey() equivalent, the fetched material IS the deployed signer', async () => {
    freshGrantHappyPath()
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-material',
      onEvent: () => {},
    })
    await orch.dispatch(PLAN, { permissionDecision: freshDecisionFor(PLAN) })
    expect(fetchPreparedExecutionMaterialMock).toHaveBeenCalledTimes(2) // once per worker
    const grantArgs = submitGrantMock.mock.calls[0][0]
    // The exact bytes fetchPreparedExecutionMaterial returned went straight into the grant —
    // never a freshly-generated Uint8Array from some other source.
    expect(grantArgs.agentInits[0].signer).toEqual(new Uint8Array(32).fill(1))
    expect(grantArgs.agentInits[0].salt).toEqual(new Uint8Array(32).fill(2))
  })

  it('a missing/unconfigured funding router fails before wallet signing — submitGrant is the single gate, never reached partway', async () => {
    submitGrantMock.mockRejectedValue(new Error('The funding router is not configured.'))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-norouter',
      onEvent: () => {},
    })
    let caught
    try {
      await orch.dispatch(PLAN, { permissionDecision: freshDecisionFor(PLAN) })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PermissionPhaseError)
    expect(caught.phase).toBe('fresh-grant')
    expect(caught.movement).toBe('none')
    expect(caught.message).toMatch(/funding router is not configured/i)
    // Nothing downstream of the grant call ever ran — no confirmation read, no pull, no deposit.
    expect(readConfirmedLedgerMock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(executeCalls).toHaveLength(0)
  })

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
    // Signer/salt are deliberately OMITTED here (review round 2 fix) — preflightPermission
    // resolves them itself from the SAME prepared-execution material this allocation's original
    // fresh review generated, so the recomputed fingerprint reproduces the review-time value
    // exactly instead of this method reconstructing (and merely hoping to match) it.
    expect(call.agentInits[0].signer).toBeUndefined()
    expect(call.agentInits[0].salt).toBeUndefined()
    expect(call.agentInits[0].target).toBe('CACTIVEVAULT')
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

  // Task 6 chunk C1 fix round 1, Important 2 -- no WorkerAgent was ever constructed with
  // activeAccount/getCurrentActiveAccount/signal, so runAgentDeposit's indeterminate-outcome check
  // (agentDeposit.js) was a permanent no-op on the deposit leg in production even though the pull
  // leg (runAgentPull, above) is armed with these same three fields everywhere it runs. Asserts
  // the REAL buildReuseWorkers code -- not a stub's own claim -- threads them onto every
  // constructed worker.
  it('threads activeAccount/getCurrentActiveAccount/signal onto every WorkerAgent constructed by buildReuseWorkers', async () => {
    const addresses = ['CCACHED1', 'CCACHED2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionFor(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue(decision)
    const activeAccount = Object.freeze({
      version: 1,
      kind: 'G',
      address: 'GUSER',
      networkPassphrase: 'Test SDF Network ; September 2015',
      connectorId: 'freighter',
      epoch: 1,
    })
    const getCurrentActiveAccount = () => activeAccount
    const signal = new AbortController().signal
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-wiring-reuse',
      onEvent: () => {},
      activeAccount,
      getCurrentActiveAccount,
      signal,
    })
    await orch.dispatch(PLAN, { permissionDecision: decision })
    expect(workerInstances.length).toBe(2)
    for (const w of workerInstances) {
      expect(w.activeAccount).toBe(activeAccount)
      expect(w.getCurrentActiveAccount).toBe(getCurrentActiveAccount)
      expect(w.signal).toBe(signal)
    }
  })
})

// Task 5 chunk B — the V3 reuse dispatch path. Unreachable in production today (THE DORMANCY
// CONTRACT: no V3 router is registered in ROUTER_SCHEMAS), reached here only by injecting a
// V3-shaped decision straight through the mocked `preflightPermission` — never by registering a
// fabricated address.
describe('dispatch(strategyPlan, { permissionDecision }) — V3 reuse mode (bounded permission)', () => {
  function cacheEntries(addresses) {
    return addresses.map((agentAddress, i) => ({
      agentAddress,
      secret: `S${i}`,
      signerPub: `GPUB${i}`,
      cap: PLAN.agents[i].cap.units,
      expiry: 2000000000,
    }))
  }

  // The known blocker (orchestrator.js ~950-952 / ~1002, per the brief): a V3 reuse decision has
  // `executions[]`, not `agents[]`. Before the fix, `revalidated.agents.length` (and
  // `revalidated.agents.map(...)` in buildReuseWorkers) threw TypeError for exactly this shape.
  it('dispatches a V3-shaped reuse decision (executions[], no agents[]) without throwing — the known blocker is fixed', async () => {
    const addresses = ['CV3AGENT1', 'CV3AGENT2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionV3For(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue(decision)
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-1', onEvent: () => {} })
    const res = await orch.dispatch(PLAN, { permissionDecision: decision })
    expect(res.completed).toBe(2)
    expect(res.failed).toBe(0)
    expect(workerInstances.map((w) => w.agentAddress)).toEqual(addresses)
  })

  it('pulls through buildAgentPullV3 (never runAgentPull/submitGrant), threading the proven router + permissionId + executionId + agentAddress + amount, matched to each allocation BY IDENTITY (not array position)', async () => {
    const addresses = ['CV3AGENT1', 'CV3AGENT2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionV3For(PLAN, addresses)
    // Fix round 1, Important 4: reverse the executions array's POSITION relative to
    // PLAN.agents/workers order (each entry keeps its own correct allocationId/agentAddress) — a
    // positional match (e.g. `[...map.values()][i]`) would now hand worker 0 allocation 1's
    // execution; only an allocationId-keyed lookup (what the production code actually does)
    // still resolves the assertions below correctly.
    decision.executions = [...decision.executions].reverse()
    preflightPermissionMock.mockResolvedValue(decision)
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-2', onEvent: () => {} })
    await orch.dispatch(PLAN, { permissionDecision: decision })

    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(buildAgentPullV3Mock).toHaveBeenCalledTimes(2)
    expect(buildAgentPullV3Mock.mock.calls[0][0]).toMatchObject({
      // Fix round 1, Important 1: the router THIS permission was proven against
      // (`reuseDecisionV3For`'s 'CROUTERV3'), never the config default ('CROUTER') buildAgentPullV3
      // would silently fall back to if orchestrator dropped it.
      router: 'CROUTERV3',
      permissionId: '0xPERMISSION',
      executionId: '0xEXEC0',
      agentAddress: 'CV3AGENT1',
      amount: BigInt(PLAN.agents[0].cap.units),
      relayer: 'GRELAYER',
    })
    expect(buildAgentPullV3Mock.mock.calls[1][0]).toMatchObject({
      router: 'CROUTERV3',
      permissionId: '0xPERMISSION',
      executionId: '0xEXEC1',
      agentAddress: 'CV3AGENT2',
      amount: BigInt(PLAN.agents[1].cap.units),
      relayer: 'GRELAYER',
    })
  })

  // Task 6 chunk C1 fix round 1, Important 3 -- the receipt's OWN `executionId` (agent-index id
  // space, `${runId}:exec:${allocationId}`) and the V3 router's OWN replay-guard id
  // (`v3Exec.executionId`, what `buildAgentPullV3` actually submits on-chain) are two SEPARATE
  // things. Before this fix the router's replay-guard id appeared nowhere in the receipt -- a V3
  // recovery could not resend the identical still-valid envelope because the id it would need was
  // unrecoverable from the persisted evidence.
  it("[Important 3] threads the V3 router replay-guard executionId into the pull attempt evidence, distinct from this receipt's own executionId", async () => {
    const addresses = ['CV3AGENT1', 'CV3AGENT2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionV3For(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue(decision)
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'v3-evidence',
      onEvent: () => {},
    })

    await orch.dispatch(PLAN, { permissionDecision: decision })

    expect(postReceiptEvidenceMock).toHaveBeenCalled()
    const confirmedPullCall = postReceiptEvidenceMock.mock.calls.find(
      ([args]) =>
        args.body.receipt.allocationId === PLAN.agents[0].allocationId &&
        args.body.attempt.phase === 'pull' &&
        args.body.attempt.status === 'confirmed'
    )
    expect(confirmedPullCall).toBeTruthy()
    const [args] = confirmedPullCall
    // The receipt's OWN executionId stays the deterministic agent-index form -- NOT the V3
    // router's replay-guard id.
    expect(args.body.receipt.executionId).toBe(`${PLAN.runId}:exec:${PLAN.agents[0].allocationId}`)
    // The V3 router's OWN replay-guard id (decision.executions[0].executionId, '0xEXEC0') is
    // recoverable from the attempt evidence.
    expect(args.body.attempt.evidence.v3ExecutionId).toBe('0xEXEC0')
  })

  it('revalidates through a freshly captured preflight immediately before the first pull, threading permissionId/approval/activeAccount', async () => {
    const addresses = ['CV3AGENT1', 'CV3AGENT2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionV3For(PLAN, addresses)
    const callOrder = []
    preflightPermissionMock.mockImplementation(async () => {
      callOrder.push('preflight')
      return decision
    })
    buildAgentPullV3Mock.mockImplementation(async () => {
      callOrder.push('pull')
      return { xdr: 'XDR_V3' }
    })
    const activeAccount = {
      version: 1,
      kind: 'G',
      address: 'GUSER',
      networkPassphrase: 'Test SDF Network ; September 2015',
      connectorId: 'freighter',
      epoch: 1,
    }
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'v3-3',
      onEvent: () => {},
      activeAccount,
      getCurrentActiveAccount: () => activeAccount,
    })
    await orch.dispatch(PLAN, { permissionDecision: decision })
    expect(preflightPermissionMock).toHaveBeenCalledTimes(1)
    expect(callOrder[0]).toBe('preflight')
    expect(callOrder.slice(1)).toEqual(['pull', 'pull'])
    const call = preflightPermissionMock.mock.calls[0][0]
    expect(call.permissionId).toBe('0xPERMISSION')
    expect(call.approval).toEqual(decision.approval)
    expect(call.activeAccount).toBe(activeAccount)
    expect(typeof call.getCurrentActiveAccount).toBe('function')
  })

  it('a drifted executionId on revalidation throws VF_REUSE_EVIDENCE_CHANGED, never a wallet/pull fallback', async () => {
    const addresses = ['CV3AGENT1', 'CV3AGENT2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionV3For(PLAN, addresses)
    const drifted = reuseDecisionV3For(PLAN, addresses)
    drifted.executions[0] = { ...drifted.executions[0], executionId: '0xDRIFTED' }
    preflightPermissionMock.mockResolvedValue(drifted)
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-4', onEvent: () => {} })
    await expect(orch.dispatch(PLAN, { permissionDecision: decision })).rejects.toMatchObject({
      phase: 'reuse-revalidation',
      code: 'VF_REUSE_EVIDENCE_CHANGED',
      movement: 'none',
    })
    expect(buildAgentPullV3Mock).not.toHaveBeenCalled()
  })

  it('a drifted scopeId on revalidation throws VF_REUSE_EVIDENCE_CHANGED', async () => {
    const addresses = ['CV3AGENT1', 'CV3AGENT2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionV3For(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue({ ...decision, scopeId: '0xSCOPEDRIFTED' })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-5', onEvent: () => {} })
    await expect(orch.dispatch(PLAN, { permissionDecision: decision })).rejects.toMatchObject({
      phase: 'reuse-revalidation',
      code: 'VF_REUSE_EVIDENCE_CHANGED',
      movement: 'none',
    })
    expect(buildAgentPullV3Mock).not.toHaveBeenCalled()
  })

  it('the router-generation flipping under revalidation (V3 reviewed, V2 re-read) throws VF_REUSE_EVIDENCE_CHANGED rather than silently mixing shapes', async () => {
    const addresses = ['CV3AGENT1', 'CV3AGENT2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionV3For(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue(reuseDecisionFor(PLAN, addresses))
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-6', onEvent: () => {} })
    await expect(orch.dispatch(PLAN, { permissionDecision: decision })).rejects.toMatchObject({
      phase: 'reuse-revalidation',
      code: 'VF_REUSE_EVIDENCE_CHANGED',
      movement: 'none',
    })
    expect(buildAgentPullV3Mock).not.toHaveBeenCalled()
  })

  // Fix round 1, Important 3: the top-level `revalidated.version === permissionDecision.version`
  // check is only load-bearing for a NON-3 version flip — both sides here take the SAME (V2/else)
  // branch of the evidence gate, with every other field held identical, so this isolates that
  // exact line from the V2 arm's own fingerprint/agents checks (which would otherwise all pass).
  it('a version-only drift where BOTH sides take the non-V3 branch (reviewed v1, re-read v2) throws VF_REUSE_EVIDENCE_CHANGED', async () => {
    const addresses = ['CCACHED1', 'CCACHED2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const decision = reuseDecisionFor(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue({ ...reuseDecisionFor(PLAN, addresses), version: 2 })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-9', onEvent: () => {} })
    await expect(orch.dispatch(PLAN, { permissionDecision: decision })).rejects.toMatchObject({
      phase: 'reuse-revalidation',
      code: 'VF_REUSE_EVIDENCE_CHANGED',
      movement: 'none',
    })
    expect(buildAgentPullV3Mock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
  })

  // Fix round 1, Minor 3: `[].length === [].length` and `[].every(...)` are both vacuously true,
  // so a zero-execution V3 decision must be rejected explicitly rather than falling through the
  // gate by accident. A zero-agent plan is the only way both sides' execution counts can be 0
  // (any real allocation count mismatch is already caught by the pre-existing length-equality
  // check, which would mask this specific gap).
  it('a V3 decision with zero proven executions is rejected, not vacuously accepted by an empty-array .every()', async () => {
    const emptyPlan = { runId: 'run-empty', planFingerprint: '0xPLANEMPTY', agents: [] }
    const decision = reuseDecisionV3For(emptyPlan, [])
    preflightPermissionMock.mockResolvedValue(decision)
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-10', onEvent: () => {} })
    await expect(orch.dispatch(emptyPlan, { permissionDecision: decision })).rejects.toMatchObject({
      phase: 'reuse-revalidation',
      code: 'VF_REUSE_EVIDENCE_CHANGED',
      movement: 'none',
    })
    expect(buildAgentPullV3Mock).not.toHaveBeenCalled()
  })

  it('a V3 decision with any Base/bridge child in reuse mode is rejected before any movement, same as V2', async () => {
    const bridgePlan = {
      runId: 'run-bridge',
      planFingerprint: '0xPLANBRIDGE',
      agents: [
        planAgent(0, '400000000'),
        {
          allocationId: 'run-bridge:bridge:0',
          kind: 'bridge',
          cap: { token: 'CTOKEN', units: '600000000', decimals: 7 },
          children: [
            {
              allocationId: 'run-bridge:bridge:0:0',
              allocation: { token: 'USDC', units: '600000000', decimals: 6 },
            },
          ],
        },
      ],
    }
    const decision = {
      ...reuseDecisionV3For(PLAN, ['CV3AGENT1']),
      planFingerprint: bridgePlan.planFingerprint,
    }
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-7', onEvent: () => {} })
    await expect(orch.dispatch(bridgePlan, { permissionDecision: decision })).rejects.toMatchObject(
      {
        phase: 'preflight',
        code: 'VF_BASE_REQUIRES_FRESH_GRANT',
        movement: 'none',
      }
    )
    expect(preflightPermissionMock).not.toHaveBeenCalled()
    expect(buildAgentPullV3Mock).not.toHaveBeenCalled()
  })

  // Fresh-mode V3: grant.js exports only `buildGrantV3Tx` (build-only — no submitGrant-equivalent
  // wallet/relay orchestration exists for V3, and grant.js is out of this chunk's file scope to
  // add one). Rather than silently misrouting a V3 fresh decision through V2's `submitGrant`
  // (which invokes the router's `grant`/grant_v2 entry point, not `grant_v3`), this fails closed.
  // See the task report for why this scope line was drawn here.
  it('a fresh V3 decision fails closed (VF_V3_FRESH_GRANT_UNSUPPORTED) instead of silently dispatching through V2 submitGrant', async () => {
    const decision = {
      ...reuseDecisionV3For(PLAN, ['CV3AGENT1', 'CV3AGENT2']),
      mode: 'fresh',
      freshReason: 'permission-missing',
      executions: [],
    }
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'v3-8', onEvent: () => {} })
    await expect(orch.dispatch(PLAN, { permissionDecision: decision })).rejects.toMatchObject({
      phase: 'fresh-grant',
      code: 'VF_V3_FRESH_GRANT_UNSUPPORTED',
      movement: 'none',
    })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(buildAgentPullV3Mock).not.toHaveBeenCalled()
  })

  // Requirement 4 from the brief: every existing V2 dispatch shape must never touch a V3-only
  // dependency. Runs the three representative shapes (permission-locked fresh, permission-locked
  // reuse, legacy router) end to end and asserts the V3-only mocks stayed untouched throughout.
  it('never calls any V3-specific dependency (buildAgentPullV3/getRelayerAddress via the V3 path) for any V2 dispatch shape', async () => {
    freshGrantHappyPath()
    const orchFresh = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'v2guard-fresh',
      onEvent: () => {},
    })
    await orchFresh.dispatch(PLAN, { permissionDecision: freshDecisionFor(PLAN) })

    const addresses = ['CCACHED1', 'CCACHED2']
    loadCachedAgentsMock.mockReturnValue(cacheEntries(addresses))
    const reuseDecision = reuseDecisionFor(PLAN, addresses)
    preflightPermissionMock.mockResolvedValue(reuseDecision)
    const orchReuse = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'v2guard-reuse',
      onEvent: () => {},
    })
    await orchReuse.dispatch(PLAN, { permissionDecision: reuseDecision })

    readTokenBalanceMock.mockImplementation(async (addr) => (addr === 'GUSER' ? null : 0n))
    submitGrantMock.mockImplementation(async ({ agentInits }) => ({
      hash: 'HG',
      status: 'SUCCESS',
      agentAddresses: agentInits.map((_, i) => `CFRESH${i + 1}`),
      expiryLedger: 9999,
    }))
    readAllowanceMock.mockResolvedValue({ amount: 0n, liveUntilLedger: null })
    const orchLegacy = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'v2guard-legacy',
      onEvent: () => {},
    })
    await orchLegacy.dispatch({ vaults: [{ address: 'CV1', allocation: 1 }] }, 50)

    expect(buildAgentPullV3Mock).not.toHaveBeenCalled()
    expect(getRelayerAddressMock).not.toHaveBeenCalled()
    expect(submitViaRelayMock).not.toHaveBeenCalled()
  })
})

// Restored (review round 2, Important 3): the LEGACY `dispatch(strategy, totalAmount)` router
// path — `setupViaRouter` / `tryReuseAllCached` / `grantFreshAgents`, entirely UNCHANGED by Task 7
// (`dispatchLegacy` is a byte-for-byte rename) — is STILL PRODUCTION (USE_FUNDING_ROUTER gates it
// on, same as the new path's tests above) and had its coverage dropped when this file was
// repurposed for the new dispatchPermissioned path. The shared `beforeEach` above already resets
// every mock this block needs; only `readTokenBalanceMock`'s default (0n for every address,
// suited to the new path's "agent needs funding" tests) needs overriding back to the
// GUSER-precheck-skipped / agents-drained shape these legacy tests expect.
describe('dispatch(strategy, totalAmount) — LEGACY router path (setupViaRouter, still production)', () => {
  const legacyStrategy = {
    vaults: [
      { address: 'CV1', allocation: 0.4 },
      { address: 'CV2', allocation: 0.4 },
      { address: 'CV3', allocation: 0.2 },
    ],
  }
  const LEGACY_TOTAL_UNITS = 100_0000000n

  beforeEach(() => {
    readTokenBalanceMock.mockReset()
    readTokenBalanceMock.mockImplementation(async (addr) => (addr === 'GUSER' ? null : 0n))
    submitGrantMock.mockImplementation(async ({ agentInits }) => ({
      hash: 'HG',
      status: 'SUCCESS',
      agentAddresses: agentInits.map((_, i) => `CFRESH${i + 1}`),
      expiryLedger: 9999,
    }))
    readAllowanceMock.mockResolvedValue({ amount: 0n, liveUntilLedger: null }) // 0 -> forces a grant
  })

  describe('first run (a single signature)', () => {
    it('keeps a reviewed legacy permission window absolute through grant signing', async () => {
      const reviewedWindow = { checkedAt: 2_000_000_000, durationSeconds: 900 }
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-reviewed-window',
        onEvent: () => {},
        // The reviewed window must win over this legacy default, even if setup/signing is delayed.
        grantDurationSeconds: 3600,
      })

      await orch.dispatch(legacyStrategy, 100, reviewedWindow)

      const grantArgs = submitGrantMock.mock.calls[0][0]
      expect(grantArgs.durationSeconds).toBe(reviewedWindow.durationSeconds)
      expect(grantArgs.reviewedExpiryUnix).toBe(2_000_000_900)
      expect(grantArgs.agentInits.every((init) => init.expiry === 2_000_000_900)).toBe(true)
    })

    it('issues exactly a single grant signature for N=3 agents, then a relayed pull per worker', async () => {
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s1',
        onEvent: () => {},
      })
      const res = await orch.dispatch(legacyStrategy, 100)

      expect(submitGrantMock).toHaveBeenCalledTimes(1)
      const grantArgs = submitGrantMock.mock.calls[0][0]
      expect(grantArgs.agentInits).toHaveLength(3)
      expect(grantArgs.budgets).toEqual([{ budget: LEGACY_TOTAL_UNITS, token: 'CTOKEN' }])
      expect(grantArgs.agentInits).toEqual([
        expect.objectContaining({
          cap: 40_0000000n,
          token: 'CTOKEN',
          target: 'CACTIVEVAULT',
          kind: 0,
        }),
        expect.objectContaining({ cap: 40_0000000n, kind: 0, target: 'CACTIVEVAULT' }),
        expect.objectContaining({ cap: 20_0000000n, kind: 0, target: 'CACTIVEVAULT' }),
      ])

      expect(runAgentPullMock).toHaveBeenCalledTimes(3)
      expect(deployAgentForSessionMock).not.toHaveBeenCalled()
      expect(fundAgentMock).not.toHaveBeenCalled()
      expect(workerInstances.map((w) => w.agentAddress)).toEqual(['CFRESH1', 'CFRESH2', 'CFRESH3'])
      expect(res.completed).toBe(3)
    })

    it('pulls funds to every agent BEFORE any worker deposit runs', async () => {
      const callOrder = []
      runAgentPullMock.mockImplementation(async ({ agentAddress }) => {
        callOrder.push(`pull:${agentAddress}`)
        return { hash: 'HP', status: 'SUCCESS' }
      })
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s2',
        onEvent: () => {},
      })
      const res = await orch.dispatch(legacyStrategy, 100)
      // setupViaRouter (unchanged) pulls funds for every agent BEFORE dispatch's own serial loop
      // ever calls a worker's execute() — proven by both completing successfully with exactly one
      // pull per agent, never a deposit attempted against an unfunded agent.
      expect(callOrder).toEqual(['pull:CFRESH1', 'pull:CFRESH2', 'pull:CFRESH3'])
      expect(res.completed).toBe(3)
    })

    it('caches every freshly granted agent (address + session secret) for reuse', async () => {
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s3',
        onEvent: () => {},
      })
      await orch.dispatch(legacyStrategy, 100)
      expect(saveCachedAgentMock).toHaveBeenCalledTimes(3)
      expect(saveCachedAgentMock.mock.calls[0][0]).toMatchObject({
        owner: 'GUSER',
        vault: 'CACTIVEVAULT',
        entry: expect.objectContaining({ agentAddress: 'CFRESH1', cap: '400000000' }),
      })
    })

    it('honors a user-chosen budget larger than the run total (signature-free repeat headroom)', async () => {
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s4',
        onEvent: () => {},
        grantBudgetUnits: 500_0000000n, // 5x total
      })
      await orch.dispatch(legacyStrategy, 100)
      expect(submitGrantMock.mock.calls[0][0].budgets).toEqual([
        { budget: 500_0000000n, token: 'CTOKEN' },
      ])
    })
  })

  describe('repeat run (zero further signatures)', () => {
    it('skips the grant entirely when allowance covers the run AND every worker reuses a cached agent', async () => {
      readAllowanceMock.mockResolvedValue({ amount: 500_0000000n, liveUntilLedger: null })
      let n = 0
      takeReusableAgentMock.mockImplementation(async () => {
        n += 1
        return { agentAddress: `CCACHED${n}`, secret: `SCACHED${n}` }
      })
      const events = []
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s5',
        onEvent: (e, d) => events.push({ e, d }),
      })
      const res = await orch.dispatch(legacyStrategy, 100)

      expect(submitGrantMock).not.toHaveBeenCalled()
      expect(runAgentPullMock).toHaveBeenCalledTimes(3)
      expect(workerInstances.map((w) => w.agentAddress)).toEqual([
        'CCACHED1',
        'CCACHED2',
        'CCACHED3',
      ])
      const deployed = events.filter((x) => x.e === 'AgentDeployed')
      expect(deployed.every((x) => x.d.reused === true)).toBe(true)
      expect(res.completed).toBe(3)
    })

    it('falls back to the grant signature when allowance is insufficient even if agents are cached', async () => {
      readAllowanceMock.mockResolvedValue({ amount: 1n, liveUntilLedger: null }) // below run total
      takeReusableAgentMock.mockResolvedValue({ agentAddress: 'CCACHED', secret: 'S' })
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s6',
        onEvent: () => {},
      })
      await orch.dispatch(legacyStrategy, 100)
      expect(submitGrantMock).toHaveBeenCalledTimes(1) // grant signature required
    })

    it('falls back to the grant signature when even one worker has no reusable cached agent', async () => {
      readAllowanceMock.mockResolvedValue({ amount: 500_0000000n, liveUntilLedger: null })
      // Two workers reuse, the third cannot -> all-or-nothing: a grant is required (grant is the
      // only way to create the missing agent).
      takeReusableAgentMock
        .mockResolvedValueOnce({ agentAddress: 'CCACHED1', secret: 'S1' })
        .mockResolvedValueOnce({ agentAddress: 'CCACHED2', secret: 'S2' })
        .mockResolvedValue(null)
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s7',
        onEvent: () => {},
      })
      await orch.dispatch(legacyStrategy, 100)
      expect(submitGrantMock).toHaveBeenCalledTimes(1)
      // Fresh grant deploys all three (the two cached picks are not committed on a partial reuse).
      expect(workerInstances.map((w) => w.agentAddress)).toEqual(['CFRESH1', 'CFRESH2', 'CFRESH3'])
    })
  })

  describe('failure isolation', () => {
    it('aborts the whole run when the single grant fails (no agents get deployed)', async () => {
      submitGrantMock.mockRejectedValue(new Error('grant signature timed out after 120s'))
      const events = []
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s8',
        onEvent: (e, d) => events.push({ e, d }),
      })
      await expect(orch.dispatch(legacyStrategy, 100)).rejects.toThrow(
        /Agent setup failed for all 3 agents/
      )
      expect(runAgentPullMock).not.toHaveBeenCalled()
      const err = events.find((x) => x.e === 'orchestrator-step' && x.d.status === 'error')
      expect(err.d.step).toBe('authorizing-scope')
    })

    it("one worker's pull failure isolates that worker; the rest of the run continues", async () => {
      runAgentPullMock.mockImplementation(async ({ agentAddress }) => {
        if (agentAddress === 'CFRESH2') throw new Error('router pull reported FAILED')
        return { hash: 'HP', status: 'SUCCESS' }
      })
      const orch = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'legacy-s9',
        onEvent: () => {},
      })
      const res = await orch.dispatch(legacyStrategy, 100)
      expect(res.completed).toBe(2)
      expect(res.failed).toBe(1)
      const failed = res.results.find((r) => !r.success)
      expect(failed.error).toMatch(/Setup failed: .*router pull reported FAILED/)
    })
  })

  // My Money Task 1: the production cutoff gate must never even be consulted while the router
  // (USE_FUNDING_ROUTER, fixed true for this whole file) is available — it exists only to guard
  // the OTHER branch (the router unset/unhealthy). This is the router-healthy counterpart to the
  // "production-mode router outage" cutoff behavior covered in orchestrator.test.js.
  it('never consults the legacy cutoff gate while the funding router is available', async () => {
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'legacy-s10',
      onEvent: () => {},
    })
    await orch.dispatch(legacyStrategy, 100)
    expect(isLegacyDirectSetupAllowedMock).not.toHaveBeenCalled()
  })
})
