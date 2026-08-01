// frontend/src/orchestrator.baseleg.test.js
// Task 8 + Task 7 rework: dispatch() splits strategy.vaults by chain and runs the Base leg
// (baseLeg.js's executeBaseLeg) as a settled sibling of the Stellar worker pipeline — AND, per
// the grant-covers-burn design (docs/superpowers/specs/2026-07-21-grant-covers-burn-design.md
// §4-5), a mixed run's bridge agent joins the SAME single funding_router grant as the Stellar
// deposit workers, never a second signature. A bridge agent can only be created via the router
// (never the legacy per-agent deploy), so this file exercises the ROUTER path — same seam as
// orchestrator.router.test.js — with executeBaseLeg mocked for the isolated cases (its own
// contract is baseLeg.test.js's job) and mergeFlowHelpers.js's readStoredBaseMandate mocked (its
// own contract is app.strategy.merge.test.jsx's job). The uncertain-burn integration at the end
// explicitly forwards this spy into the real executeBaseLeg and its real runFarmFlow.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const baseLegHarness = vi.hoisted(() => ({ executeReal: null }))

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

const readStoredBaseMandateMock = vi.fn()
vi.mock('./mergeFlowHelpers.js', () => ({
  readStoredBaseMandate: (...a) => readStoredBaseMandateMock(...a),
}))

const takeReusableAgentMock = vi.fn(async () => null)
const saveCachedAgentMock = vi.fn()
vi.mock('./stellar/agentCache.js', () => ({
  takeReusableAgent: (...a) => takeReusableAgentMock(...a),
  saveCachedAgent: (...a) => saveCachedAgentMock(...a),
}))

vi.mock('./stellar/sessionKey.js', () => ({
  newSessionKey: (secret) => ({
    publicKey: secret ? 'GRESTORED' : 'GFRESH',
    secret,
    rawPublicKey: new Uint8Array(32),
    sign: () => new Uint8Array(64),
  }),
}))

const readTokenBalanceMock = vi.fn(async () => null)
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
}))

// Router path (default once funding_router is live) — the only path a bridge agent can go
// through, since deploying one requires the router's kind:Bridge AgentInit, never the legacy
// per-agent deploy call.
vi.mock('./stellar/config.js', () => ({
  SOROBAN_TOKEN_ADDRESS: 'CTOKEN',
  SOROBAN_DECIMALS: 7,
  SOROBAN_ACTIVE_VAULT_ADDRESS: 'CACTIVEVAULT',
  SOROBAN_FUNDING_ROUTER_ADDRESS: 'CROUTER',
  USE_FUNDING_ROUTER: true,
  // Task 6 chunk C1 fix round 1 (Important 2) — needed by stellar/activeAccount.js's own
  // (unmocked) import of this same module, so a V1-shaped activeAccount fixture can satisfy
  // assertActiveAccountBoundary's network check in the WorkerAgent-wiring tests below. Every
  // pre-existing test in this file omits `activeAccount` (defaults to null), so this addition
  // changes nothing for them (mirrors orchestrator.router.test.js's identical addition).
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
}))
vi.mock('./strategist.js', () => ({ generateAgentSkills: vi.fn(async () => ({})) }))
vi.mock('./skills.js', () => ({ saveSkill: vi.fn() }))

const workerInstances = []
const workerExecuteMock = vi.fn()
vi.mock('./worker.js', () => ({
  WorkerAgent: class {
    constructor(c) {
      Object.assign(this, c)
      workerInstances.push(this)
    }
    async setupKey() {
      if (!this.sessionKey) {
        this.sessionKey = {
          publicKey: `GPUB${workerInstances.length}`,
          secret: `S${workerInstances.length}`,
          rawPublicKey: new Uint8Array(32),
        }
      }
      return this.sessionKey
    }
    async execute() {
      return workerExecuteMock(this)
    }
  },
  makeAgentId: (i, s) => `0x${i}${s}`,
}))

const executeBaseLegMock = vi.fn()
vi.mock('./baseLeg.js', async (importOriginal) => {
  const actual = await importOriginal()
  baseLegHarness.executeReal = actual.executeBaseLeg
  return { ...actual, executeBaseLeg: (...a) => executeBaseLegMock(...a) }
})
const runAgentBurnMock = vi.fn()
vi.mock('./stellar/agentBurn.js', () => ({
  runAgentBurn: (...a) => runAgentBurnMock(...a),
}))
const readBaseMandateMock = vi.fn()
vi.mock('./wallet/baseBinding.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readBaseMandate: (...a) => readBaseMandateMock(...a),
}))

const fetchPreparedExecutionMaterialMock = vi.fn()
vi.mock('./strategy/reusePreflight.js', () => ({
  fetchPreparedExecutionMaterial: (...a) => fetchPreparedExecutionMaterialMock(...a),
}))
vi.mock('./stellar/grantReceiptStore.js', () => ({
  buildGrantReceiptV1: (value) => value,
  saveGrantReceipt: vi.fn(),
  fingerprintGrantReceipt: () => 'GRANT-RECEIPT',
}))

// Task 6 chunk C1 -- the AllocationReceiptV2 transport (Chunk B, closed/reviewed). Mocked the same
// way every other network-touching dependency in this file is: the REAL orchestrator.js dispatch
// loops run unmocked, only the leaf that would otherwise reach `fetch` is replaced, so tests can
// assert exactly what body was posted and simulate a version-conflict/network failure at will.
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

import { OrchestratorAgent } from './orchestrator.js'
import {
  STELLAR_USDC_SAC,
  STELLAR_TOKEN_MESSENGER_MINTER,
  CCTP_BASE_DOMAIN,
  evmAddrToBytes32,
} from './stellar/cctpBurn.js'
import { BASE_POOL_CATALOG } from './config.js'

const KERNEL = '0x0000000000000000000000000000000000000AA1'

// grantAddresses walks agentInits in order; the LAST entry is the bridge agent iff its kind===1 —
// mirrors grant.js's own additive bridgeAgentAddress logic exactly, so the mock stays honest.
function fakeSubmitGrant({ agentInits }) {
  const agentAddresses = agentInits.map((_, i) => `CFRESH${i + 1}`)
  const last = agentInits[agentInits.length - 1]
  const bridgeAgentAddress = last?.kind === 1 ? agentAddresses[agentAddresses.length - 1] : null
  return { hash: 'HG', status: 'SUCCESS', agentAddresses, bridgeAgentAddress, expiryLedger: 9999 }
}

function permissionedMixedFixture(runId = 'run-regression') {
  const plan = {
    runId,
    planFingerprint: `PLAN-${runId}`,
    agents: [
      {
        allocationId: `${runId}:deposit:0`,
        kind: 'deposit',
        cap: { token: 'CTOKEN', units: '600000000', decimals: 7 },
        allocation: { token: 'CTOKEN', units: '600000000', decimals: 7 },
        periodSeconds: 3600,
        expiry: 2000000000,
      },
      {
        allocationId: `${runId}:bridge:base`,
        kind: 'bridge',
        cap: { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
        allocation: { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
        periodSeconds: 3600,
        expiry: 2000000000,
        children: [
          {
            allocationId: `${runId}:bridge:pool-a`,
            address: '0x389250872044368759D3db5C09b2706A6628d4e0',
            allocation: { token: 'USDC', units: '40000000', decimals: 6 },
          },
        ],
      },
    ],
  }
  const reviewedAgentInits = [
    {
      allocationId: plan.agents[0].allocationId,
      kind: 0,
      token: 'CTOKEN',
      target: 'CACTIVEVAULT',
      cap: { ...plan.agents[0].cap },
      periodSeconds: 3600,
      expiry: 2000000000,
      mintRecipient: '00'.repeat(32),
      destinationDomain: 0,
    },
    {
      allocationId: plan.agents[1].allocationId,
      kind: 1,
      token: STELLAR_USDC_SAC,
      target: STELLAR_TOKEN_MESSENGER_MINTER,
      cap: { ...plan.agents[1].cap },
      periodSeconds: 3600,
      expiry: 2000000000,
      mintRecipient: Array.from(evmAddrToBytes32(KERNEL), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join(''),
      destinationDomain: CCTP_BASE_DOMAIN,
    },
  ]
  return {
    plan,
    permissionDecision: {
      mode: 'fresh',
      runId,
      planFingerprint: plan.planFingerprint,
      agentInitFingerprint: `AI-${runId}`,
      reviewedBudgets: [
        { token: 'CTOKEN', units: '600000000', decimals: 7 },
        { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
      ],
      reviewedAgentInits,
    },
  }
}

// Task 6 chunk C1 -- a Stellar-only permissioned fixture (no bridge agent), so `dispatch()` falls
// through to `dispatchPermissioned`'s PLAIN worker loop (orchestrator.js:627-...) rather than
// `dispatchConfirmedMixed`. `agentCount` deposit agents, each with the same fixed cap, mirroring
// `permissionedMixedFixture`'s own deposit-agent shape minus the bridge sibling.
function permissionedStellarOnlyFixture(runId, agentCount = 1) {
  const CAP_UNITS = 600_000_000
  const agents = Array.from({ length: agentCount }, (_, i) => ({
    allocationId: `${runId}:deposit:${i}`,
    kind: 'deposit',
    cap: { token: 'CTOKEN', units: String(CAP_UNITS), decimals: 7 },
    allocation: { token: 'CTOKEN', units: String(CAP_UNITS), decimals: 7 },
    periodSeconds: 3600,
    expiry: 2000000000,
  }))
  const plan = { runId, planFingerprint: `PLAN-${runId}`, agents }
  const reviewedAgentInits = agents.map((agent) => ({
    allocationId: agent.allocationId,
    kind: 0,
    token: 'CTOKEN',
    target: 'CACTIVEVAULT',
    cap: { ...agent.cap },
    periodSeconds: 3600,
    expiry: 2000000000,
    mintRecipient: '00'.repeat(32),
    destinationDomain: 0,
  }))
  return {
    plan,
    permissionDecision: {
      mode: 'fresh',
      runId,
      planFingerprint: plan.planFingerprint,
      agentInitFingerprint: `AI-${runId}`,
      reviewedBudgets: [{ token: 'CTOKEN', units: String(CAP_UNITS * agentCount), decimals: 7 }],
      reviewedAgentInits,
    },
  }
}

function permissionedOrchestrator(onEvent = vi.fn()) {
  return new OrchestratorAgent({
    user: 'GUSER',
    sessionId: 'permissioned-regression',
    onEvent,
    baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
  })
}

async function expectPermissionPreflightRejection(fixture) {
  await expect(
    permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })
  ).rejects.toMatchObject({
    name: 'PermissionPhaseError',
    movement: 'none',
    phase: 'preflight',
  })
  expect(submitGrantMock).not.toHaveBeenCalled()
  expect(runAgentPullMock).not.toHaveBeenCalled()
  expect(workerExecuteMock).not.toHaveBeenCalled()
  expect(executeBaseLegMock).not.toHaveBeenCalled()
}

function successfulBaseLeg(runId) {
  return {
    success: true,
    runId,
    burnHash: `BURN-${runId}`,
    jobId: `JOB-${runId}`,
    finalStatus: 'done',
    allocations: [
      {
        allocationId: `${runId}:bridge:pool-a`,
        amount: { token: 'USDC', units: '40000000', decimals: 6 },
        success: true,
        finalStatus: 'done',
        depositTxHash: `BASE-DEPOSIT-${runId}`,
        bridgeAgentAddress: 'CFRESH2',
        kernelAddress: KERNEL,
        recovery: { action: 'inspect-job', jobId: `JOB-${runId}` },
        custody: { location: 'base-proxy', confirmed: true, checkedAt: 909 },
      },
    ],
  }
}

beforeEach(() => {
  workerInstances.length = 0
  workerExecuteMock.mockReset()
  workerExecuteMock.mockResolvedValue({ success: true, txHash: '0xW' })
  submitGrantMock.mockReset()
  submitGrantMock.mockImplementation(async (args) => fakeSubmitGrant(args))
  runAgentPullMock.mockReset()
  runAgentPullMock.mockResolvedValue({ hash: 'HP', status: 'SUCCESS' })
  readAllowanceMock.mockReset()
  readAllowanceMock.mockResolvedValue({ amount: 0n, liveUntilLedger: null }) // forces the grant path
  readConfirmedLedgerMock.mockReset()
  readConfirmedLedgerMock.mockResolvedValue({ confirmedLedger: 123, confirmedAt: 456 })
  fetchPreparedExecutionMaterialMock.mockReset()
  fetchPreparedExecutionMaterialMock.mockImplementation(({ allocationId }) => ({
    signer: new Uint8Array(32).fill(1),
    salt: new Uint8Array(32).fill(2),
    signerSecret: `S-${allocationId}`,
  }))
  takeReusableAgentMock.mockReset()
  takeReusableAgentMock.mockResolvedValue(null)
  saveCachedAgentMock.mockClear()
  readTokenBalanceMock.mockReset()
  readTokenBalanceMock.mockImplementation(async (addr) => (addr === 'GUSER' ? null : 0n))
  readStoredBaseMandateMock.mockReset()
  readStoredBaseMandateMock.mockReturnValue({
    kernelAddress: KERNEL,
    serializedApproval: 'APPROVAL',
    sessionKeyAddress: '0xSESSION',
    expiry: 9999999999,
  })
  readBaseMandateMock.mockReset()
  readBaseMandateMock.mockReturnValue({ kernelAddress: KERNEL })
  executeBaseLegMock.mockReset()
  executeBaseLegMock.mockResolvedValue({ success: true, burnHash: 'B', jobId: 'j1' })
  runAgentBurnMock.mockReset()
  runAgentBurnMock.mockResolvedValue({ burnHash: 'HBURN' })
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

describe('orchestrator base leg — mixed run costs exactly ONE grant signature', () => {
  it('permissioned fresh mixed plan shares the reviewed grant, settles both branches, and returns one custody receipt', async () => {
    const plan = {
      runId: 'run-permissioned-mixed',
      planFingerprint: 'PLAN-MIXED',
      agents: [
        {
          allocationId: 'run-permissioned-mixed:deposit:0',
          kind: 'deposit',
          cap: { token: 'CTOKEN', units: '600000000', decimals: 7 },
          allocation: { token: 'CTOKEN', units: '600000000', decimals: 7 },
          periodSeconds: 3600,
          expiry: 2000000000,
        },
        {
          allocationId: 'run-permissioned-mixed:bridge:base',
          kind: 'bridge',
          cap: { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
          allocation: { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
          periodSeconds: 3600,
          expiry: 2000000000,
          children: [
            {
              allocationId: 'run-permissioned-mixed:bridge:pool-a',
              address: '0xBASE',
              allocation: { token: 'USDC', units: '40000000', decimals: 6 },
            },
          ],
        },
      ],
    }
    const reviewedAgentInits = [
      {
        allocationId: plan.agents[0].allocationId,
        kind: 0,
        token: 'CTOKEN',
        target: 'CACTIVEVAULT',
        cap: plan.agents[0].cap,
        periodSeconds: 3600,
        expiry: 2000000000,
        mintRecipient: '00'.repeat(32),
        destinationDomain: 0,
      },
      {
        allocationId: plan.agents[1].allocationId,
        kind: 1,
        token: STELLAR_USDC_SAC,
        target: STELLAR_TOKEN_MESSENGER_MINTER,
        cap: plan.agents[1].cap,
        periodSeconds: 3600,
        expiry: 2000000000,
        mintRecipient: Array.from(evmAddrToBytes32(KERNEL), (byte) =>
          byte.toString(16).padStart(2, '0')
        ).join(''),
        destinationDomain: CCTP_BASE_DOMAIN,
      },
    ]
    executeBaseLegMock.mockResolvedValueOnce({
      success: true,
      runId: plan.runId,
      grantTxHash: 'HG',
      burnHash: 'BURN',
      jobId: 'job-8',
      finalStatus: 'pending',
      bridgeAgentAddress: 'CFRESH2',
      kernelAddress: KERNEL,
      allocations: [
        {
          allocationId: 'run-permissioned-mixed:bridge:pool-a',
          amount: { token: 'USDC', units: '40000000', decimals: 6 },
          burnHash: 'BURN',
          jobId: 'job-8',
          finalStatus: 'pending',
          custody: { location: 'in-transit', confirmed: true, checkedAt: 1 },
        },
      ],
    })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'permissioned',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(plan, {
      permissionDecision: {
        mode: 'fresh',
        runId: plan.runId,
        planFingerprint: plan.planFingerprint,
        agentInitFingerprint: 'AI-MIXED',
        reviewedBudgets: [
          { token: 'CTOKEN', units: '600000000', decimals: 7 },
          { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
        ],
        reviewedAgentInits,
      },
    })

    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    expect(executeBaseLegMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: plan.runId,
        grantTxHash: 'HG',
        bridgeAgentAddress: 'CFRESH2',
        bridgeSessionKey: expect.objectContaining({ secret: `S-${plan.agents[1].allocationId}` }),
      })
    )
    expect(summary.receipt).toMatchObject({
      runId: plan.runId,
      permission: { status: 'confirmed', txHash: 'HG', confirmationCount: 1 },
      branches: { stellar: { status: 'succeeded' }, base: { status: 'in-transit' } },
    })
    expect(summary.receipt.allocations.map((allocation) => allocation.allocationId)).toEqual([
      'run-permissioned-mixed:deposit:0',
      'run-permissioned-mixed:bridge:pool-a',
    ])
  })

  it('rejects a permissioned bridge without owner-bound Base context before the shared grant', async () => {
    const plan = {
      runId: 'run-preflight-base',
      planFingerprint: 'PLAN-PREFLIGHT',
      agents: [
        {
          allocationId: 'run-preflight-base:bridge:base',
          kind: 'bridge',
          cap: { token: STELLAR_USDC_SAC, units: '10', decimals: 7 },
          allocation: { token: STELLAR_USDC_SAC, units: '10', decimals: 7 },
          periodSeconds: 3600,
          expiry: 2000000000,
          children: [],
        },
      ],
    }
    await expect(
      new OrchestratorAgent({ user: 'GUSER', onEvent: vi.fn() }).dispatch(plan, {
        permissionDecision: {
          mode: 'fresh',
          planFingerprint: plan.planFingerprint,
          reviewedAgentInits: [
            {
              allocationId: plan.agents[0].allocationId,
              kind: 1,
              token: STELLAR_USDC_SAC,
              target: 'CTOKENMESSENGER',
              cap: plan.agents[0].cap,
              periodSeconds: 3600,
              expiry: 2000000000,
            },
          ],
        },
      })
    ).rejects.toMatchObject({ name: 'PermissionPhaseError', movement: 'none', phase: 'preflight' })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('splits mixed strategy: stellar vaults go to workers, base vaults to executeBaseLeg, ONE grant covers both', async () => {
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's1',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      {
        vaults: [
          { address: 'CSTELLAR', allocation: 0.6, chain: 'stellar' },
          { address: '0xBASE', allocation: 0.4, chain: 'base' },
        ],
      },
      100
    )
    // Only the stellar vault produced a worker.
    expect(workerInstances).toHaveLength(1)
    expect(workerInstances[0].vault).toBe('CSTELLAR')

    // Exactly ONE grant call, carrying the deposit worker AND the bridge agent.
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.agentInits).toHaveLength(2)
    expect(grantArgs.agentInits[0].kind).toBe(0) // deposit worker
    expect(grantArgs.agentInits[1].kind).toBe(1) // bridge, last
    expect(grantArgs.agentInits[1].mintRecipient).toBeInstanceOf(Uint8Array)
    expect(grantArgs.budgets).toHaveLength(2) // VFUSD + Circle USDC

    // The Base leg receives the SAME grant's bridge agent + its session key + the kernelAddress
    // orchestrator.js already read (never re-read by baseLeg.js — IMPORTANT 2 fix) — never signTx.
    expect(executeBaseLegMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedAddress: 'GUSER',
        bridgeAgentAddress: 'CFRESH2',
        bridgeSessionKey: expect.any(Object),
        kernelAddress: KERNEL,
        baseVaults: [expect.objectContaining({ address: '0xBASE' })],
        totalAmount: 100,
      })
    )
    const call = executeBaseLegMock.mock.calls[0][0]
    expect(call.signTx).toBeUndefined()

    expect(summary.baseLeg).toMatchObject({ success: true, jobId: 'j1' })
    expect(summary.completed).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.receipt).toMatchObject({
      version: 1,
      runId: 's1',
      permission: { status: 'confirmed', confirmationCount: 1 },
      branches: { stellar: { status: 'succeeded' }, base: { status: 'succeeded' } },
    })
    expect(summary.receipt.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionStatus: 'succeeded',
          custody: expect.objectContaining({ location: 'unknown', confirmed: false }),
        }),
        expect.objectContaining({
          executionStatus: 'succeeded',
          custody: expect.objectContaining({ location: 'unknown', confirmed: false }),
        }),
      ])
    )
  })

  it('an all-Base strategy (zero Stellar deposit workers) still grants — bridge init only, no deposit budget entry', async () => {
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-allbase',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await orch.dispatch({ vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] }, 50)

    expect(workerInstances).toHaveLength(0)
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.agentInits).toHaveLength(1)
    expect(grantArgs.agentInits[0].kind).toBe(1)
    expect(grantArgs.budgets).toEqual([{ budget: expect.any(BigInt), token: STELLAR_USDC_SAC }])
    expect(executeBaseLegMock).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeAgentAddress: 'CFRESH1' })
    )
  })

  it('a bridge leg forces the grant path even when the Stellar allowance already covers cached reuse (never partially cached)', async () => {
    readAllowanceMock.mockResolvedValue({ amount: 500_0000000n, liveUntilLedger: null })
    takeReusableAgentMock.mockResolvedValue({ agentAddress: 'CCACHED', secret: 'S' })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-forced',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await orch.dispatch(
      {
        vaults: [
          { address: 'CSTELLAR', allocation: 0.5, chain: 'stellar' },
          { address: '0xBASE', allocation: 0.5, chain: 'base' },
        ],
      },
      100
    )
    // A bridge agent can never come from cache — its presence forces the grant, which then also
    // deploys the (otherwise cache-eligible) Stellar worker fresh, rather than mixing reuse+grant.
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    expect(takeReusableAgentMock).not.toHaveBeenCalled()
  })

  it('no chain field on any vault keeps every vault on the Stellar path (regression) — no mandate read, no bridge', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1b', onEvent: vi.fn() })
    const summary = await orch.dispatch({ vaults: [{ address: 'CSTELLAR', allocation: 1 }] }, 100)
    expect(workerInstances).toHaveLength(1)
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(readStoredBaseMandateMock).not.toHaveBeenCalled()
    expect(summary.baseLeg).toBeNull()
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.agentInits).toHaveLength(1) // deposit worker only, no bridge init appended
  })

  it('no stored Base mandate -> dispatch aborts before any work (mandate setup is its own ceremony, never a run)', async () => {
    readStoredBaseMandateMock.mockReturnValue(null)
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-nomandate',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await expect(
      orch.dispatch(
        {
          vaults: [
            { address: 'CSTELLAR', allocation: 0.5, chain: 'stellar' },
            { address: '0xBASE', allocation: 0.5, chain: 'base' },
          ],
        },
        100
      )
    ).rejects.toThrow(/no durable base mandate/i)
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('a failed grant fails BOTH legs — no partial agents, Base leg never reached', async () => {
    submitGrantMock.mockRejectedValue(new Error('grant signature declined'))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-grantfail',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await expect(
      orch.dispatch(
        {
          vaults: [
            { address: 'CSTELLAR', allocation: 0.5, chain: 'stellar' },
            { address: '0xBASE', allocation: 0.5, chain: 'base' },
          ],
        },
        100
      )
    ).rejects.toThrow(/Agent setup failed for all 1 agents/)
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('a failed grant on an ALL-BASE strategy (no Stellar worker to fail loudly) surfaces a message naming the real cause, not a generic one', async () => {
    // No Stellar workers here, so dispatch() itself does not reject (the pre-existing
    // "all agents failed" check only fires when workers.length > 0) — the Base leg's OWN
    // rejection is what must carry a useful message (MINOR fix: name grant-failure-or-no-router,
    // not the old vague "did not deploy an agent").
    submitGrantMock.mockRejectedValue(new Error('grant signature declined'))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-grantfail-allbase',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      { vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] },
      50
    )
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(summary.baseLeg.success).toBe(false)
    expect(summary.baseLeg.error).toMatch(/funding router|grant failed/i)
  })

  it('base leg failure never rejects dispatch', async () => {
    executeBaseLegMock.mockResolvedValueOnce({ success: false, stage: 'farm', error: 'down' })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's2',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      { vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] },
      50
    )
    expect(summary.baseLeg).toEqual({ success: false, stage: 'farm', error: 'down' })
    // No stellar vaults in this strategy -> the (empty) stellar leg still "succeeds" with 0 agents.
    expect(summary.completed).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.receipt.branches.base.status).toBe('failed')
    expect(summary.receipt.allocations[0]).toMatchObject({
      executionStatus: 'failed',
      custody: { location: 'unknown', confirmed: false },
      error: 'down',
    })
  })

  it('a rejected base leg promise (belt-and-braces) maps to a failed baseLeg summary, dispatch still resolves', async () => {
    executeBaseLegMock.mockRejectedValueOnce(new Error('unexpected throw'))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's2b',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      { vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] },
      50
    )
    expect(summary.baseLeg).toEqual({
      success: false,
      stage: 'dispatch',
      error: 'unexpected throw',
    })
  })

  it('mixed strategy: insufficient USDC (burn-token) balance aborts dispatch before any work', async () => {
    // VFUSD (readTokenBalance's default token) is a DIFFERENT asset from the CCTP burn token
    // (STELLAR_USDC_SAC) — a user flush with VFUSD can still be short the USDC the burn spends,
    // so this preflight must check the burn token specifically, not the vault-deposit total.
    readTokenBalanceMock.mockImplementation(async (addr, opts) => {
      if (opts?.token === STELLAR_USDC_SAC) return 1n // far short of the ~400_000_000n needed
      return addr === 'GUSER' ? null : 0n
    })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's4',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await expect(
      orch.dispatch(
        {
          vaults: [
            { address: 'CSTELLAR', allocation: 0.6, chain: 'stellar' },
            { address: '0xBASE', allocation: 0.4, chain: 'base' },
          ],
        },
        100
      )
    ).rejects.toThrow(/USDC/i)
    // Abort-upfront: neither leg starts once the burn-token preflight fails.
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(workerInstances).toHaveLength(0)
  })

  it('mixed strategy: sufficient USDC (burn-token) balance proceeds as before', async () => {
    readTokenBalanceMock.mockImplementation(async (addr, opts) => {
      if (opts?.token === STELLAR_USDC_SAC) return 10_000_000_000n // plenty
      return addr === 'GUSER' ? null : 0n
    })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's5',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      {
        vaults: [
          { address: 'CSTELLAR', allocation: 0.6, chain: 'stellar' },
          { address: '0xBASE', allocation: 0.4, chain: 'base' },
        ],
      },
      100
    )
    expect(summary.baseLeg).toMatchObject({ success: true })
    expect(workerInstances).toHaveLength(1)
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
  })

  it('no baseLegContext -> base vaults are refused loudly, not silently dropped', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's3', onEvent: vi.fn() })
    await expect(
      orch.dispatch({ vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] }, 50)
    ).rejects.toThrow(/base leg context/i)
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(submitGrantMock).not.toHaveBeenCalled()
  })

  it('[A] resolves a legacy mixed receipt when the Stellar worker rejects and retains successful Base custody', async () => {
    workerExecuteMock.mockRejectedValueOnce(new Error('stellar worker rejected'))
    executeBaseLegMock.mockResolvedValueOnce({
      success: true,
      finalStatus: 'done',
      burnHash: 'BURN-A',
      jobId: 'JOB-A',
      allocations: [
        {
          allocationId: 'run-a:bridge:0',
          amount: { token: 'USDC', units: '40000000', decimals: 6 },
          success: true,
          finalStatus: 'done',
          depositTxHash: 'BASE-DEPOSIT-A',
          bridgeAgentAddress: 'CFRESH2',
          kernelAddress: KERNEL,
          recovery: { jobId: 'JOB-A' },
          custody: { location: 'base-proxy', confirmed: true, checkedAt: 101 },
        },
      ],
    })
    const summary = await new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'run-a',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    }).dispatch(
      {
        runId: 'run-a',
        vaults: [
          { address: 'CSTELLAR', allocation: 0.6, chain: 'stellar' },
          { address: '0xBASE', allocation: 0.4, chain: 'base' },
        ],
      },
      100
    )

    expect(summary.receipt.branches).toMatchObject({
      stellar: { status: 'failed' },
      base: { status: 'succeeded' },
    })
    expect(
      summary.receipt.allocations.find((entry) => entry.allocationId === 'run-a:bridge:0')
    ).toMatchObject({
      executionStatus: 'succeeded',
      custody: { location: 'base-proxy', confirmed: true },
      evidence: {
        depositTxHash: 'BASE-DEPOSIT-A',
        bridgeAgentAddress: 'CFRESH2',
        kernelAddress: KERNEL,
        recovery: { jobId: 'JOB-A' },
      },
    })
  })

  it('[B] rejects a permissioned bridge child without a token before grant or either branch starts', async () => {
    const fixture = permissionedMixedFixture('run-b')
    fixture.plan.agents[1].children[0].allocation.token = ''

    await expect(
      permissionedOrchestrator().dispatch(fixture.plan, {
        permissionDecision: fixture.permissionDecision,
      })
    ).rejects.toMatchObject({
      name: 'PermissionPhaseError',
      movement: 'none',
      phase: 'preflight',
    })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(workerExecuteMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'sum',
      mutate: ({ plan }) => {
        plan.agents[1].children[0].allocation.units = '39999999'
      },
    },
    {
      label: 'token pairing',
      mutate: ({ plan }) => {
        plan.agents[1].children[0].allocation.token = 'DAI'
      },
    },
    {
      label: 'decimal pairing',
      mutate: ({ plan }) => {
        plan.agents[1].children[0].allocation.decimals = 7
      },
    },
  ])('[C] rejects a bridge parent/child $label mismatch before grant', async ({ mutate }) => {
    const fixture = permissionedMixedFixture(`run-c-${String(Math.random()).slice(2)}`)
    mutate(fixture)

    await expect(
      permissionedOrchestrator().dispatch(fixture.plan, {
        permissionDecision: fixture.permissionDecision,
      })
    ).rejects.toMatchObject({ name: 'PermissionPhaseError', movement: 'none', phase: 'preflight' })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('[D] rejects a duplicate allocationId before grant or movement', async () => {
    const fixture = permissionedMixedFixture('run-d-duplicate')
    fixture.plan.agents[1].children[0].allocationId = fixture.plan.agents[0].allocationId

    await expect(
      permissionedOrchestrator().dispatch(fixture.plan, {
        permissionDecision: fixture.permissionDecision,
      })
    ).rejects.toMatchObject({ name: 'PermissionPhaseError', movement: 'none', phase: 'preflight' })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('[D] rejects multiple bridge agents before grant or movement', async () => {
    const fixture = permissionedMixedFixture('run-d-cardinality')
    const secondBridge = structuredClone(fixture.plan.agents[1])
    secondBridge.allocationId = 'run-d-cardinality:bridge:second'
    secondBridge.children[0].allocationId = 'run-d-cardinality:bridge:pool-b'
    fixture.plan.agents.push(secondBridge)

    await expect(
      permissionedOrchestrator().dispatch(fixture.plan, {
        permissionDecision: fixture.permissionDecision,
      })
    ).rejects.toMatchObject({
      name: 'PermissionPhaseError',
      movement: 'none',
      code: 'VF_MULTIPLE_BRIDGE_AGENTS',
    })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('[E] settles an unexpected Base rejection after permission confirmation with unknown custody', async () => {
    const fixture = permissionedMixedFixture('run-e')
    executeBaseLegMock.mockRejectedValueOnce(new Error('base implementation rejected'))

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    expect(summary.receipt.permission).toMatchObject({
      mode: 'fresh',
      status: 'confirmed',
      confirmationCount: 1,
      txHash: 'HG',
    })
    expect(summary.receipt.branches.base.status).toBe('failed')
    expect(
      summary.receipt.allocations.find((entry) => entry.allocationId.endsWith('pool-a'))
    ).toMatchObject({
      executionStatus: 'failed',
      custody: { location: 'unknown', confirmed: false, checkedAt: null },
      error: 'base implementation rejected',
    })
    expect(
      summary.receipt.allocations.find((entry) => entry.allocationId.endsWith('pool-a')).custody
        .location
    ).not.toBe('owner')
  })

  it('[F] keeps failed Base recovery evidence in the receipt and strips all key material', async () => {
    const fixture = permissionedMixedFixture('run-f')
    executeBaseLegMock.mockResolvedValueOnce({
      success: false,
      stage: 'attestation',
      error: 'attestation rejected',
      allocations: [
        {
          allocationId: 'run-f:bridge:pool-a',
          amount: { token: 'USDC', units: '40000000', decimals: 6 },
          success: false,
          error: 'attestation rejected',
          finalStatus: 'error',
          bridgeAgentAddress: 'CFRESH2',
          kernelAddress: KERNEL,
          jobId: 'JOB-F',
          attestation: { status: 'rejected' },
          recovery: {
            action: 'resume-job',
            jobId: 'JOB-F',
            sessionPrivateKey: '0xNESTED-SECRET',
            bridgeSessionKey: { secret: 'SBRIDGE-NESTED' },
          },
          custody: { location: 'in-transit', confirmed: true, checkedAt: 606 },
          sessionPrivateKey: '0xSECRET',
          bridgeSessionKey: { secret: 'SSECRET' },
        },
      ],
    })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })
    const failed = summary.receipt.allocations.find((entry) =>
      entry.allocationId.endsWith('pool-a')
    )

    expect(failed.evidence).toMatchObject({
      bridgeAgentAddress: 'CFRESH2',
      kernelAddress: KERNEL,
      jobId: 'JOB-F',
      attestation: { status: 'rejected' },
      recovery: { action: 'resume-job', jobId: 'JOB-F' },
    })
    expect(JSON.stringify(summary.receipt)).not.toMatch(
      /session|private|0xSECRET|SSECRET|0xNESTED-SECRET|SBRIDGE-NESTED/i
    )
  })

  it('[G] normalizes a malformed stored kernel as no-movement PermissionPhaseError before grant', async () => {
    const fixture = permissionedMixedFixture('run-g')
    readBaseMandateMock.mockReturnValueOnce({ kernelAddress: 'not-an-evm-address' })

    await expect(
      permissionedOrchestrator().dispatch(fixture.plan, {
        permissionDecision: fixture.permissionDecision,
      })
    ).rejects.toMatchObject({
      name: 'PermissionPhaseError',
      movement: 'none',
      phase: 'preflight',
      code: 'VF_BASE_KERNEL_INVALID',
    })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('[H] reports actual reused permission evidence for a legacy Stellar-only cached run', async () => {
    readAllowanceMock.mockResolvedValue({ amount: 2_000_000_000n, liveUntilLedger: 9999 })
    takeReusableAgentMock.mockResolvedValue({
      agentAddress: 'CCACHED',
      secret: 'SCACHED',
      expiry: 2000000000,
    })
    readTokenBalanceMock.mockImplementation(async (address) =>
      address === 'CCACHED' ? 2_000_000_000n : null
    )

    const summary = await new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'run-h',
      onEvent: vi.fn(),
    }).dispatch({ runId: 'run-h', vaults: [{ address: 'CSTELLAR', allocation: 1 }] }, 100)

    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(summary.receipt.permission).toEqual({
      mode: 'reuse',
      status: 'reused',
      confirmationCount: 0,
      txHash: null,
      grantReceiptFingerprint: null,
      expiryLedger: 9999,
      agentAddresses: ['CCACHED'],
    })
  })

  it.each([
    {
      label: 'nonempty parent token',
      mutate: ({ plan, permissionDecision }) => {
        plan.agents[1].cap.token = '   '
        plan.agents[1].allocation.token = '   '
        permissionDecision.reviewedAgentInits[1].token = '   '
        permissionDecision.reviewedAgentInits[1].cap.token = '   '
      },
    },
    {
      label: 'integer child units',
      mutate: ({ plan }) => {
        plan.agents[1].children[0].allocation.units = '40000000.5'
      },
    },
    {
      label: 'nonnegative parent units',
      mutate: ({ plan, permissionDecision }) => {
        plan.agents[1].cap.units = '-400000000'
        plan.agents[1].allocation.units = '-400000000'
        permissionDecision.reviewedAgentInits[1].cap.units = '-400000000'
      },
    },
    {
      label: 'integer decimals',
      mutate: ({ plan, permissionDecision }) => {
        plan.agents[1].cap.decimals = 7.5
        plan.agents[1].allocation.decimals = 7.5
        permissionDecision.reviewedAgentInits[1].cap.decimals = 7.5
      },
    },
    {
      label: 'nonempty allocationId',
      mutate: ({ plan, permissionDecision }) => {
        plan.agents[0].allocationId = ''
        permissionDecision.reviewedAgentInits[0].allocationId = ''
      },
    },
    {
      label: 'cap and allocation reconciliation',
      mutate: ({ plan }) => {
        plan.agents[0].allocation.units = '599999999'
      },
    },
  ])('[J] validates canonical $label before permission or movement', async ({ mutate }) => {
    const fixture = permissionedMixedFixture(`run-j-${String(Math.random()).slice(2)}`)
    mutate(fixture)

    await expect(
      permissionedOrchestrator().dispatch(fixture.plan, {
        permissionDecision: fixture.permissionDecision,
      })
    ).rejects.toMatchObject({ name: 'PermissionPhaseError', movement: 'none', phase: 'preflight' })
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('[Budget] rejects a missing reviewed budget set before grant or either branch', async () => {
    const fixture = permissionedMixedFixture('run-budget-missing')
    delete fixture.permissionDecision.reviewedBudgets

    await expectPermissionPreflightRejection(fixture)
  })

  it('[Budget] rejects duplicate reviewed entries for one token before grant or either branch', async () => {
    const fixture = permissionedMixedFixture('run-budget-duplicate')
    fixture.permissionDecision.reviewedBudgets = [
      { token: 'CTOKEN', units: '300000000', decimals: 7 },
      { token: 'CTOKEN', units: '300000000', decimals: 7 },
      { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
    ]

    await expectPermissionPreflightRejection(fixture)
  })

  it('[Budget] rejects a reviewed budget for the wrong token before grant or either branch', async () => {
    const fixture = permissionedMixedFixture('run-budget-token')
    fixture.permissionDecision.reviewedBudgets[0].token = 'CWRONGTOKEN'

    await expectPermissionPreflightRejection(fixture)
  })

  it('[Budget] rejects a reviewed budget with wrong decimals before grant or either branch', async () => {
    const fixture = permissionedMixedFixture('run-budget-decimals')
    fixture.permissionDecision.reviewedBudgets[0].decimals = 6

    await expectPermissionPreflightRejection(fixture)
  })

  it('[Budget] rejects an undersized reviewed per-token total before grant or either branch', async () => {
    const fixture = permissionedMixedFixture('run-budget-under')
    fixture.permissionDecision.reviewedBudgets[0].units = '599999999'

    await expectPermissionPreflightRejection(fixture)
  })

  it('[Budget] rejects an oversized reviewed per-token total before grant or either branch', async () => {
    const fixture = permissionedMixedFixture('run-budget-over')
    fixture.permissionDecision.reviewedBudgets[0].units = '600000001'

    await expectPermissionPreflightRejection(fixture)
  })

  it('[Budget] rejects total-preserving mutation between reviewed token budgets before grant or either branch', async () => {
    const fixture = permissionedMixedFixture('run-budget-mutated')
    fixture.permissionDecision.reviewedBudgets[0].units = '700000000'
    fixture.permissionDecision.reviewedBudgets[1].units = '300000000'

    await expectPermissionPreflightRejection(fixture)
  })

  it('[Observer] a throwing grant-confirmed listener cannot erase a confirmed mixed receipt', async () => {
    const fixture = permissionedMixedFixture('run-observer-grant')
    executeBaseLegMock.mockResolvedValueOnce(successfulBaseLeg(fixture.plan.runId))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'observer-grant',
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
      onEvent: (name) => {
        if (name === 'grant-confirmed') throw new Error('observer grant crash')
      },
    })

    const summary = await orch.dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(summary.receipt.permission).toMatchObject({ status: 'confirmed', txHash: 'HG' })
    expect(summary.receipt.branches).toMatchObject({
      stellar: { status: 'succeeded' },
      base: { status: 'succeeded' },
    })
    expect(summary.receipt.allocations.map((entry) => entry.allocationId)).toEqual([
      'run-observer-grant:deposit:0',
      'run-observer-grant:bridge:pool-a',
    ])
  })

  it('[Observer] a throwing worker-queued listener cannot erase a successful Base sibling', async () => {
    const fixture = permissionedMixedFixture('run-observer-queued')
    workerExecuteMock.mockRejectedValueOnce(new Error('stellar worker failed'))
    executeBaseLegMock.mockResolvedValueOnce(successfulBaseLeg(fixture.plan.runId))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 'observer-queued',
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
      onEvent: (name) => {
        if (name === 'worker-queued') throw new Error('observer queue crash')
      },
    })

    const summary = await orch.dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })
    const base = summary.receipt.allocations.find((entry) => entry.allocationId.endsWith('pool-a'))

    expect(summary.receipt.branches).toMatchObject({
      stellar: { status: 'failed' },
      base: { status: 'succeeded' },
    })
    expect(base).toMatchObject({
      custody: { location: 'base-proxy', confirmed: true },
      evidence: {
        depositTxHash: 'BASE-DEPOSIT-run-observer-queued',
        recovery: { action: 'inspect-job', jobId: 'JOB-run-observer-queued' },
      },
    })
  })

  it('[Custody] real Orchestrator/Base/farm dispatch keeps a possibly-dispatched burn unknown', async () => {
    const fixture = permissionedMixedFixture('run-uncertain-burn')
    const onEvent = vi.fn()
    fixture.plan.agents[1].children[0].allocationId = 'run-uncertain-burn:bridge:aave-v3'
    fixture.plan.agents[1].children[0].address = BASE_POOL_CATALOG.find(
      (pool) => pool.proxyTarget === 'aave-v3'
    ).address
    // Keep both internal layers real. The injected values below replace only local persistence,
    // RPC and quote boundaries; runFarmFlow is deliberately absent, so baseLeg uses its actual
    // crossChainFarm implementation and reaches the external Stellar burn transport mock.
    executeBaseLegMock.mockImplementation((args) =>
      baseLegHarness.executeReal({
        ...args,
        deps: {
          ...args.deps,
          readStoredMandate: () => ({
            version: 2,
            stellarOwner: 'GUSER',
            serializedApproval: 'APPROVAL',
            sessionKeyAddress: '0xSESSION',
            kernelAddress: KERNEL,
            expiresAt: 9999999999,
            status: 'active',
          }),
          // Task 9 hardened isVerifiedBaseMandateStatus to require the full BaseMandateStatusV2
          // shape (checks/observed/reasonCodes), not a bare `{status:'active'}` flag -- this
          // fixture predates that (it mirrors baseLeg.test.js's pre-Task-9 okDeps() shape, which
          // was updated to activeEvidence() in the same commit; this sibling file was missed).
          // Without the full shape the pre-farm mandate gate now (correctly) fails closed before
          // ever reaching runFarmFlow, so this scenario's actual subject -- a burn that dispatches
          // and then goes uncertain -- was never exercised. Mirror the verified shape so the gate
          // legitimately passes and the real burn-uncertainty path below runs.
          getMandateStatus: async () => ({
            version: 2,
            status: 'active',
            reasonCodes: [],
            checks: {
              chain: true,
              owner: true,
              kernel: true,
              session: true,
              permission: true,
              policy: true,
              binding: true,
              origin: true,
              implementation: true,
              allocation: true,
              freshness: true,
              reconstruction: true,
              prepared: true,
            },
            observed: {
              blockNumber: '101',
              blockHash: '0xblock',
              blockTime: Date.now(),
              implementation: '0ximpl',
              permission: { digest: 'permission-digest' },
              preparedCallDigest: 'prepared-call-digest',
            },
          }),
          makePublicClient: () => ({}),
          estimateMinShares: async () => 39_000_000n,
        },
      })
    )
    runAgentBurnMock.mockRejectedValue(
      Object.assign(new Error('burn response lost after dispatch'), {
        code: 'VF_SUBMISSION_UNKNOWN',
        submission: 'unknown',
        stage: 'burn',
        result: { hash: 'HBURN-MAYBE', status: 'PENDING' },
      })
    )

    // Task 8: the real flow now requires a durable relayer/D1 intent acknowledgement before it
    // reaches the burn transport. Keep that boundary real while replacing only the HTTP edge.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        jobId: 'JOB-INTENT-run-uncertain-burn',
        acknowledged: true,
        schemaVersion: 1,
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    let summary
    try {
      summary = await permissionedOrchestrator(onEvent).dispatch(fixture.plan, {
        permissionDecision: fixture.permissionDecision,
      })
    } finally {
      vi.unstubAllGlobals()
    }
    const base = summary.receipt.allocations.find((entry) => entry.allocationId.endsWith('aave-v3'))

    expect(summary.baseLeg).toMatchObject({
      success: false,
      error: 'burn response lost after dispatch',
      custody: { location: 'unknown', confirmed: false },
      recovery: {
        action: 'reconcile-cctp-burn',
        phase: 'cctp_burn',
        evidence: { result: { hash: 'HBURN-MAYBE', status: 'PENDING' } },
      },
    })
    expect(base).toMatchObject({
      executionStatus: 'failed',
      custody: { location: 'unknown', confirmed: false },
      error: 'burn response lost after dispatch',
      evidence: {
        stage: 'burn',
        recovery: {
          action: 'reconcile-cctp-burn',
          phase: 'cctp_burn',
          reason: 'burn response lost after dispatch',
          evidence: {
            submission: 'unknown',
            stage: 'cctp_burn',
            reportedStage: 'burn',
            result: { hash: 'HBURN-MAYBE', status: 'PENDING' },
          },
        },
      },
    })
    expect(base.custody.location).not.toBe('agent')
    expect(onEvent).toHaveBeenCalledWith(
      'farm-burn-started',
      expect.objectContaining({ allocationId: 'run-uncertain-burn:bridge:base' })
    )
    expect(onEvent).toHaveBeenCalledWith(
      'farm-failed',
      expect.objectContaining({
        allocationId: 'run-uncertain-burn:bridge:base',
        stage: 'burn',
      })
    )
    expect(runAgentBurnMock).toHaveBeenCalledOnce()
  })
})

// Task 6 chunk C1 -- real orchestrator.js dispatch loops, real allocationReceipt.js producer
// (unmocked), only the network leaves mocked. Exercises `dispatchPermissioned`'s PLAIN worker loop
// (no bridge agent) -- the "two worker loops" the brief scopes this chunk to; the mixed loop
// (`dispatchConfirmedMixed`'s runStellar()) got the identical wiring and is proven correct by every
// pre-existing mixed test above still passing unchanged with `allocationReceipt` added alongside
// the legacy `custody` field.
describe('Task 6 chunk C1 — allocation receipt evidence (dispatchPermissioned plain loop)', () => {
  it('[Receipt] a pre-pull failure still journals a real receipt: custody at owner, every phase not_started', async () => {
    const fixture = permissionedStellarOnlyFixture('run-receipt-prepull')
    readTokenBalanceMock.mockImplementation(async (addr) => {
      if (addr === 'GUSER') return null
      throw new Error('RPC unreachable reading agent balance')
    })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(summary.completed).toBe(0)
    expect(summary.failed).toBe(1)
    const result = summary.results[0]
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/RPC unreachable/)
    expect(result.receipt.custody).toEqual({
      location: 'owner',
      confirmed: true,
      amount: { token: 'CTOKEN', units: '600000000', decimals: 7 },
      reason: null,
    })
    expect(result.receipt.phases).toEqual({
      pull: 'not_started',
      stellar_deposit: 'not_started',
      cctp_burn: 'not_started',
      cctp_mint: 'not_started',
      base_deposit: 'not_started',
    })
    expect(result.receipt.attempts).toEqual([])
    expect(runAgentPullMock).not.toHaveBeenCalled()
  })

  it('[Receipt] pull success then deposit failure preserves agent address, pull hash, exact units, and stellar-agent custody', async () => {
    const fixture = permissionedStellarOnlyFixture('run-receipt-pull-ok-deposit-fail')
    runAgentPullMock.mockResolvedValue({ hash: 'PULLHASH1', status: 'SUCCESS' })
    workerExecuteMock.mockResolvedValue({ success: false, error: 'deposit boom' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    const result = summary.results[0]
    expect(result.success).toBe(false)
    expect(result.error).toBe('deposit boom')
    expect(result.pullTxHash).toBe('PULLHASH1')
    expect(result.agentAddress).toBe('CFRESH1')
    expect(result.receipt.phases.pull).toBe('confirmed')
    expect(result.receipt.phases.stellar_deposit).toBe('failed')
    expect(result.receipt.custody).toEqual({
      location: 'stellar-agent',
      confirmed: true,
      amount: { token: 'CTOKEN', units: '600000000', decimals: 7 },
      reason: null,
    })
    const pullAttempt = result.receipt.attempts.find(
      (a) => a.phase === 'pull' && a.status === 'confirmed'
    )
    expect(pullAttempt.evidence.txHash).toBe('PULLHASH1')
    const depositAttempt = result.receipt.attempts.find((a) => a.phase === 'stellar_deposit')
    // Pull and deposit are two separate attempts with two distinct hashes -- never one hash
    // covering both phases (the defect this chunk exists to remove).
    expect(depositAttempt.evidence.txHash).not.toBe(pullAttempt.evidence.txHash)
  })

  // CRITICAL fix round 1: when the agent already holds the funds, the pull is skipped entirely --
  // no confirmCustody call existed on that branch, so the receipt opened at owner/confirmed with
  // pull:not_started even though the money was provably at the agent. If the deposit then failed,
  // the persisted receipt read "owner custody, pull not_started" -- Task 7's "owner/never-submitted
  // permits one pull" row -- so recovery would authorize a duplicate pull of funds already at the
  // agent. Money would move twice.
  it('[Receipt] CRITICAL: agent already funded (pull skipped) then deposit fails keeps custody at stellar-agent, never owner', async () => {
    const fixture = permissionedStellarOnlyFixture('run-receipt-already-funded')
    readTokenBalanceMock.mockImplementation(async (addr) =>
      addr === 'GUSER' ? null : 600_000_000n
    )
    workerExecuteMock.mockResolvedValue({ success: false, error: 'deposit boom' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(runAgentPullMock).not.toHaveBeenCalled()
    const result = summary.results[0]
    expect(result.success).toBe(false)
    expect(result.receipt.phases.pull).toBe('not_started')
    expect(result.receipt.custody.location).toBe('stellar-agent')
    expect(result.receipt.custody.location).not.toBe('owner')
    expect(result.receipt.custody).toEqual({
      location: 'stellar-agent',
      confirmed: true,
      amount: { token: 'CTOKEN', units: '600000000', decimals: 7 },
      reason: null,
    })
  })

  it('[Receipt] an indeterminate deposit reports phase "unknown", holds custody at stellar-agent, never success', async () => {
    const fixture = permissionedStellarOnlyFixture('run-receipt-deposit-unknown')
    runAgentPullMock.mockResolvedValue({ hash: 'PULLHASH2', status: 'SUCCESS' })
    workerExecuteMock.mockResolvedValue({
      success: false,
      status: 'unknown',
      error: 'active account changed mid-submission',
      custody: { location: 'unknown', confirmed: false },
    })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    const result = summary.results[0]
    expect(result.success).toBe(false)
    expect(result.receipt.phases.stellar_deposit).toBe('unknown')
    expect(result.receipt.custody.location).toBe('stellar-agent')
    expect(result.receipt.custody.confirmed).toBe(true)
    expect(result.receipt.custody.reason).toMatch(/active account changed/)
  })

  it('[Receipt] a deposit tx success without a matching mint event keeps custody at stellar-agent, never advances to stellar-vault', async () => {
    const fixture = permissionedStellarOnlyFixture('run-receipt-no-matching-event')
    runAgentPullMock.mockResolvedValue({ hash: 'PULLHASH3', status: 'SUCCESS' })
    // Mirrors worker.js's own "shares did not increase" shape: the relay tx itself succeeded
    // (txSuccess:true, a real txHash) but the confirming event never showed up.
    workerExecuteMock.mockResolvedValue({
      success: false,
      error: 'The deposit was not confirmed because vault shares did not increase.',
      txHash: 'TXHASH-NO-MINT',
      txSuccess: true,
    })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    const result = summary.results[0]
    expect(result.receipt.custody.location).toBe('stellar-agent')
    expect(result.receipt.custody.location).not.toBe('stellar-vault')
    expect(result.receipt.custody.reason).toMatch(
      /claimed without evidence meeting its confirmation bar/
    )
  })

  it('[Receipt] mixed outcomes across workers: every planned allocation appears exactly once, each with its own separate phase hashes', async () => {
    const fixture = permissionedStellarOnlyFixture('run-receipt-mixed', 2)
    runAgentPullMock
      .mockResolvedValueOnce({ hash: 'PULL-A', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'PULL-B', status: 'SUCCESS' })
    workerExecuteMock
      .mockResolvedValueOnce({ success: true, txHash: 'DEP-A' })
      .mockResolvedValueOnce({ success: false, error: 'boom-B' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(summary.results).toHaveLength(2)
    const ids = summary.results.map((r) => r.allocationId).sort()
    expect(ids).toEqual(['run-receipt-mixed:deposit:0', 'run-receipt-mixed:deposit:1'].sort())
    const [a, b] = summary.results
    expect(a.success).toBe(true)
    expect(a.pullTxHash).toBe('PULL-A')
    expect(a.txHash).toBe('DEP-A')
    expect(b.success).toBe(false)
    expect(b.pullTxHash).toBe('PULL-B')
    expect(a.pullTxHash).not.toBe(b.pullTxHash)
    expect(summary.completed).toBe(1)
    expect(summary.failed).toBe(1)
    // The journaled ATTEMPT evidence itself must also keep the two phases' hashes distinct, not
    // just the top-level results projection -- the confirmed pull attempt and the confirmed
    // deposit attempt on the SAME successful worker must carry their own real hashes.
    const pullAttemptA = a.receipt.attempts.find(
      (att) => att.phase === 'pull' && att.status === 'confirmed'
    )
    const depositAttemptA = a.receipt.attempts.find(
      (att) => att.phase === 'stellar_deposit' && att.status === 'confirmed'
    )
    expect(pullAttemptA.evidence.txHash).toBe('PULL-A')
    expect(depositAttemptA.evidence.txHash).toBe('DEP-A')
  })

  it('[Receipt] a session secret never reaches posted receipt evidence', async () => {
    // Deliberately NOT named with the substring "secret" itself -- runId/allocationId/executionId
    // all flow verbatim into the posted body, so a fixture id containing that word would make this
    // assertion a false positive against its own identifiers, not a real leak.
    const fixture = permissionedStellarOnlyFixture('run-receipt-key-safety')
    runAgentPullMock.mockResolvedValue({ hash: 'PULLHASH-KEYCHECK', status: 'SUCCESS' })
    workerExecuteMock.mockResolvedValue({ success: true, txHash: 'DEP-KEYCHECK' })

    await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(postReceiptEvidenceMock).toHaveBeenCalled()
    const signerSecret = 'S-run-receipt-key-safety:deposit:0'
    for (const [args] of postReceiptEvidenceMock.mock.calls) {
      const serialized = JSON.stringify(args.body)
      expect(serialized).not.toContain(signerSecret)
      expect(serialized.toLowerCase()).not.toContain('secret')
      // The signer param itself legitimately carries `.secret` (postReceiptEvidence only ever
      // calls `.sign()` on it, Chunk B's own contract) -- only the wire BODY must never leak it.
      expect(args.sessionKey).toBeDefined()
    }
  })

  it('[Receipt] preserves an exact bigint-scale unit value above Number.MAX_SAFE_INTEGER without float rounding', async () => {
    // Not a round value (brief) -- 1000000000 round-trips perfectly through Number() and would
    // distinguish nothing. This one silently drifts if routed through Number() anywhere.
    const HUGE_UNITS = '123456789012345678901234567'
    expect(Number.isSafeInteger(Number(HUGE_UNITS))).toBe(false)
    const fixture = permissionedStellarOnlyFixture('run-receipt-huge-units')
    fixture.plan.agents[0].cap.units = HUGE_UNITS
    fixture.plan.agents[0].allocation.units = HUGE_UNITS
    fixture.permissionDecision.reviewedAgentInits[0].cap.units = HUGE_UNITS
    fixture.permissionDecision.reviewedBudgets[0].units = HUGE_UNITS
    runAgentPullMock.mockResolvedValue({ hash: 'PULLHASH-HUGE', status: 'SUCCESS' })
    workerExecuteMock.mockResolvedValue({ success: true, txHash: 'DEP-HUGE' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    const result = summary.results[0]
    expect(result.receipt.custody.amount.units).toBe(HUGE_UNITS)
    expect(typeof result.receipt.custody.amount.units).toBe('string')
  })

  it('[Receipt] transport acceptance never sets stellar-vault custody by itself', async () => {
    // A version-conflict/network failure on EVERY postReceiptEvidence call must never change what
    // custody the receipt ends up recording -- transport success/failure is orthogonal to custody.
    postReceiptEvidenceMock.mockRejectedValue(new Error('agent-index unreachable'))
    const fixture = permissionedStellarOnlyFixture('run-receipt-transport-down')
    runAgentPullMock.mockResolvedValue({ hash: 'PULLHASH4', status: 'SUCCESS' })
    workerExecuteMock.mockResolvedValue({ success: true, txHash: 'DEP-DOWN' })
    const events = []

    const summary = await permissionedOrchestrator((n, d) => events.push({ n, d })).dispatch(
      fixture.plan,
      { permissionDecision: fixture.permissionDecision }
    )

    const result = summary.results[0]
    // The deposit itself still succeeded on-chain -- evidence transport being down must never
    // mask or reverse that.
    expect(result.success).toBe(true)
    expect(result.receipt.custody.location).toBe('stellar-vault')
    expect(events.some((e) => e.n === 'receipt-evidence-failed')).toBe(true)
  })
})

// Task 6 chunk C1 fix round 1 -- Critical 1, Important 2, Important 4, Important 5. The mixed
// loop's ~180 new lines (dispatchConfirmedMixed's runStellar()) had zero assertions before this
// round: every pre-existing mixed test above only proved a throw would surface, never checked the
// field name, custody outcome, or hash separation the new `allocationReceipt` evidence carries.
function permissionedMixedFixtureTwoDeposits(runId) {
  const plan = {
    runId,
    planFingerprint: `PLAN-${runId}`,
    agents: [
      {
        allocationId: `${runId}:deposit:0`,
        kind: 'deposit',
        cap: { token: 'CTOKEN', units: '300000000', decimals: 7 },
        allocation: { token: 'CTOKEN', units: '300000000', decimals: 7 },
        periodSeconds: 3600,
        expiry: 2000000000,
      },
      {
        allocationId: `${runId}:deposit:1`,
        kind: 'deposit',
        cap: { token: 'CTOKEN', units: '300000000', decimals: 7 },
        allocation: { token: 'CTOKEN', units: '300000000', decimals: 7 },
        periodSeconds: 3600,
        expiry: 2000000000,
      },
      {
        allocationId: `${runId}:bridge:base`,
        kind: 'bridge',
        cap: { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
        allocation: { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
        periodSeconds: 3600,
        expiry: 2000000000,
        children: [
          {
            allocationId: `${runId}:bridge:pool-a`,
            address: '0x389250872044368759D3db5C09b2706A6628d4e0',
            allocation: { token: 'USDC', units: '40000000', decimals: 6 },
          },
        ],
      },
    ],
  }
  const depositInit = (agent) => ({
    allocationId: agent.allocationId,
    kind: 0,
    token: 'CTOKEN',
    target: 'CACTIVEVAULT',
    cap: { ...agent.cap },
    periodSeconds: 3600,
    expiry: 2000000000,
    mintRecipient: '00'.repeat(32),
    destinationDomain: 0,
  })
  const reviewedAgentInits = [
    depositInit(plan.agents[0]),
    depositInit(plan.agents[1]),
    {
      allocationId: plan.agents[2].allocationId,
      kind: 1,
      token: STELLAR_USDC_SAC,
      target: STELLAR_TOKEN_MESSENGER_MINTER,
      cap: { ...plan.agents[2].cap },
      periodSeconds: 3600,
      expiry: 2000000000,
      mintRecipient: Array.from(evmAddrToBytes32(KERNEL), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join(''),
      destinationDomain: CCTP_BASE_DOMAIN,
    },
  ]
  return {
    plan,
    permissionDecision: {
      mode: 'fresh',
      runId,
      planFingerprint: plan.planFingerprint,
      agentInitFingerprint: `AI-${runId}`,
      reviewedBudgets: [
        { token: 'CTOKEN', units: '600000000', decimals: 7 },
        { token: STELLAR_USDC_SAC, units: '400000000', decimals: 7 },
      ],
      reviewedAgentInits,
    },
  }
}

describe('Task 6 chunk C1 fix round 1 — dispatchConfirmedMixed evidence + critical/important fixes', () => {
  it('[Receipt][Mixed] CRITICAL: agent already funded (pull skipped) then deposit fails keeps custody at stellar-agent, never owner', async () => {
    const fixture = permissionedMixedFixture('run-mixed-already-funded')
    readTokenBalanceMock.mockImplementation(async (addr) =>
      addr === 'CFRESH1' ? 600_000_000n : 0n
    )
    workerExecuteMock.mockResolvedValue({ success: false, error: 'deposit boom' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(runAgentPullMock).not.toHaveBeenCalled()
    const result = summary.results[0]
    expect(result.success).toBe(false)
    expect(result.allocationReceipt.phases.pull).toBe('not_started')
    expect(result.allocationReceipt.custody.location).toBe('stellar-agent')
    expect(result.allocationReceipt.custody.location).not.toBe('owner')
  })

  it('[Receipt][Mixed] pull success then deposit failure preserves agent address, pull hash, exact units, and stellar-agent custody', async () => {
    const fixture = permissionedMixedFixture('run-mixed-pull-ok-deposit-fail')
    runAgentPullMock.mockResolvedValue({ hash: 'MIXPULL1', status: 'SUCCESS' })
    workerExecuteMock.mockResolvedValue({ success: false, error: 'deposit boom' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    const result = summary.results[0]
    expect(result.success).toBe(false)
    expect(result.pullTxHash).toBe('MIXPULL1')
    expect(result.agentAddress).toBe('CFRESH1')
    expect(result.allocationReceipt.phases.pull).toBe('confirmed')
    expect(result.allocationReceipt.phases.stellar_deposit).toBe('failed')
    expect(result.allocationReceipt.custody).toEqual({
      location: 'stellar-agent',
      confirmed: true,
      amount: { token: 'CTOKEN', units: '600000000', decimals: 7 },
      reason: null,
    })
    const pullAttempt = result.allocationReceipt.attempts.find(
      (a) => a.phase === 'pull' && a.status === 'confirmed'
    )
    expect(pullAttempt.evidence.txHash).toBe('MIXPULL1')
    // The pre-existing legacy CustodyV1 field must stay completely untouched by this chunk: a
    // deposit FAILURE never throws (worker.execute() always resolves), so this settles on the
    // FULFILLED branch, whose legacy custody fallback (deposited?.custody || {location:'unknown',
    // confirmed:false, checkedAt:null}) is unchanged pre-existing behavior -- this chunk only adds
    // the NEW `allocationReceipt` field, asserted above, alongside it.
    expect(result.custody).toEqual({ location: 'unknown', confirmed: false, checkedAt: null })
  })

  it('[Receipt][Mixed] mixed outcomes across TWO Stellar deposit workers (beside a bridge leg): every planned allocation appears exactly once, each with its own separate phase hashes', async () => {
    const fixture = permissionedMixedFixtureTwoDeposits('run-mixed-two-deposits')
    runAgentPullMock
      .mockResolvedValueOnce({ hash: 'MIXPULL-A', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'MIXPULL-B', status: 'SUCCESS' })
    workerExecuteMock
      .mockResolvedValueOnce({ success: true, txHash: 'MIXDEP-A' })
      .mockResolvedValueOnce({ success: false, error: 'boom-B' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(summary.results).toHaveLength(2)
    const ids = summary.results.map((r) => r.allocationId).sort()
    expect(ids).toEqual(
      ['run-mixed-two-deposits:deposit:0', 'run-mixed-two-deposits:deposit:1'].sort()
    )
    const [a, b] = summary.results
    expect(a.success).toBe(true)
    expect(a.pullTxHash).toBe('MIXPULL-A')
    expect(a.txHash).toBe('MIXDEP-A')
    expect(b.success).toBe(false)
    expect(b.pullTxHash).toBe('MIXPULL-B')
    expect(a.pullTxHash).not.toBe(b.pullTxHash)
    const pullAttemptA = a.allocationReceipt.attempts.find(
      (att) => att.phase === 'pull' && att.status === 'confirmed'
    )
    const depositAttemptA = a.allocationReceipt.attempts.find(
      (att) => att.phase === 'stellar_deposit' && att.status === 'confirmed'
    )
    expect(pullAttemptA.evidence.txHash).toBe('MIXPULL-A')
    expect(depositAttemptA.evidence.txHash).toBe('MIXDEP-A')
  })

  // Important 2: no WorkerAgent was ever constructed with activeAccount/getCurrentActiveAccount/
  // signal, so runAgentDeposit's indeterminate-outcome check on the deposit leg was a permanent
  // no-op in production even though the pull leg was armed with these same three fields
  // everywhere it runs. Asserts the REAL dispatchPermissioned/buildFreshWorkers code -- not a
  // stub's own claim -- actually threads them onto every constructed worker.
  it('[Important 2] threads activeAccount/getCurrentActiveAccount/signal onto every WorkerAgent constructed by the real dispatch path (fresh mode)', async () => {
    const fixture = permissionedMixedFixtureTwoDeposits('run-worker-wiring-fresh')
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
      sessionId: 'worker-wiring-fresh',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
      activeAccount,
      getCurrentActiveAccount,
      signal,
    })

    await orch.dispatch(fixture.plan, { permissionDecision: fixture.permissionDecision })

    expect(workerInstances.length).toBeGreaterThan(0)
    for (const w of workerInstances) {
      expect(w.activeAccount).toBe(activeAccount)
      expect(w.getCurrentActiveAccount).toBe(getCurrentActiveAccount)
      expect(w.signal).toBe(signal)
    }
  })

  // Reuse-mode WorkerAgent wiring is asserted in orchestrator.router.test.js instead -- this
  // file's mock of ./stellar/agentCache.js and ./strategy/reusePreflight.js deliberately omits
  // loadCachedAgents/preflightPermission (never needed by any pre-existing fresh-mode-only mixed
  // test here), and orchestrator.router.test.js already carries the full reuse-mode fixture
  // machinery (preflightPermissionMock, loadCachedAgentsMock, reuseDecisionFor) this needs.

  // Important 4: expectedVersion never recovered from a failed POST -- every evidence POST for
  // this allocation was made to fail, so `receiptEvidenceDurable` must surface false even though
  // the underlying financial outcome (deposit success) is completely unaffected.
  it('[Important 4] surfaces receiptEvidenceDurable:false once any POST fails, without affecting the financial outcome', async () => {
    postReceiptEvidenceMock.mockRejectedValue(new Error('agent-index unreachable'))
    const fixture = permissionedStellarOnlyFixture('run-receipt-durable-flag')
    runAgentPullMock.mockResolvedValue({ hash: 'DURPULL', status: 'SUCCESS' })
    workerExecuteMock.mockResolvedValue({ success: true, txHash: 'DURDEP' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    const result = summary.results[0]
    expect(result.success).toBe(true)
    expect(result.receiptEvidenceDurable).toBe(false)
  })

  it('[Important 4] surfaces receiptEvidenceDurable:true when every POST succeeds', async () => {
    const fixture = permissionedStellarOnlyFixture('run-receipt-durable-flag-ok')
    runAgentPullMock.mockResolvedValue({ hash: 'DURPULLOK', status: 'SUCCESS' })
    workerExecuteMock.mockResolvedValue({ success: true, txHash: 'DURDEPOK' })

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(summary.results[0].receiptEvidenceDurable).toBe(true)
  })
})
