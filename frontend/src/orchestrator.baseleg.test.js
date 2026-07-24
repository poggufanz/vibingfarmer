// frontend/src/orchestrator.baseleg.test.js
// Task 8 + Task 7 rework: dispatch() splits strategy.vaults by chain and runs the Base leg
// (baseLeg.js's executeBaseLeg) as a settled sibling of the Stellar worker pipeline — AND, per
// the grant-covers-burn design (docs/superpowers/specs/2026-07-21-grant-covers-burn-design.md
// §4-5), a mixed run's bridge agent joins the SAME single funding_router grant as the Stellar
// deposit workers, never a second signature. A bridge agent can only be created via the router
// (never the legacy per-agent deploy), so this file exercises the ROUTER path — same seam as
// orchestrator.router.test.js — with executeBaseLeg mocked (its own contract is baseLeg.test.js's
// job) and mergeFlowHelpers.js's readStoredBaseMandate mocked (its own contract is
// app.strategy.merge.test.jsx's job).
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
vi.mock('./baseLeg.js', () => ({
  executeBaseLeg: (...a) => executeBaseLegMock(...a),
}))
const readBaseMandateMock = vi.fn()
vi.mock('./wallet/baseBinding.js', () => ({
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

import { OrchestratorAgent } from './orchestrator.js'
import {
  STELLAR_USDC_SAC,
  STELLAR_TOKEN_MESSENGER_MINTER,
  CCTP_BASE_DOMAIN,
  evmAddrToBytes32,
} from './stellar/cctpBurn.js'

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

function permissionedOrchestrator() {
  return new OrchestratorAgent({
    user: 'GUSER',
    sessionId: 'permissioned-regression',
    onEvent: vi.fn(),
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
        mintRecipient: Array.from(evmAddrToBytes32(KERNEL), (byte) => byte.toString(16).padStart(2, '0')).join(''),
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
    expect(summary.receipt.allocations.find((entry) => entry.allocationId === 'run-a:bridge:0')).toMatchObject({
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
    expect(summary.receipt.allocations.find((entry) => entry.allocationId.endsWith('pool-a'))).toMatchObject({
      executionStatus: 'failed',
      custody: { location: 'unknown', confirmed: false, checkedAt: null },
      error: 'base implementation rejected',
    })
    expect(summary.receipt.allocations.find((entry) => entry.allocationId.endsWith('pool-a')).custody.location).not.toBe('owner')
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
    const failed = summary.receipt.allocations.find((entry) => entry.allocationId.endsWith('pool-a'))

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
})
