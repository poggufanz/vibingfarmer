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
const runAgentDepositMock = vi.fn()
const readVaultSharesMock = vi.fn()
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
  runAgentDeposit: (...a) => runAgentDepositMock(...a),
  readVaultShares: (...a) => readVaultSharesMock(...a),
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
      this.status = opts.status ?? null
      this.code = opts.code
      this.body = opts.body ?? null
    }
  },
}))
const readRecoveryReceiptMock = vi.fn()
vi.mock('./strategy/recoveryClient.js', () => ({
  readRecoveryReceipt: (...args) => readRecoveryReceiptMock(...args),
}))

import { OrchestratorAgent } from './orchestrator.js'
import { ReceiptEvidenceError } from './stellar/agentIndexReceiptClient.js'
import { RelaySubmissionUnknownError } from './stellar/relay.js'
import {
  appendPhase,
  confirmCustody,
  createAllocationReceipt,
} from './strategy/allocationReceipt.js'
import { selectRecoveryAction } from '../api/agent-index/recovery.js'
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
  runAgentDepositMock.mockReset()
  runAgentDepositMock.mockResolvedValue({ hash: 'HDEPOSIT', status: 'SUCCESS' })
  readVaultSharesMock.mockReset()
  readVaultSharesMock.mockResolvedValue(0n)
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
  readRecoveryReceiptMock.mockReset()
  readRecoveryReceiptMock.mockRejectedValue(new Error('unexpected receipt read'))
})

const RECOVERY_AMOUNT = Object.freeze({ token: 'CTOKEN', units: '10000000', decimals: 7 })
const RECOVERY_CREDENTIAL = Object.freeze({
  agentAddress: 'CRECOVERY',
  publicKey: 'GRECOVERYSIGNER',
  rawPublicKey: new Uint8Array(32),
  sign: () => new Uint8Array(64),
})

function recoveryMapping(overrides = {}) {
  const runId = overrides.runId || 'run-recovery'
  const allocationId = overrides.allocationId || `${runId}:deposit:0`
  return {
    networkId: 'stellar-testnet',
    owner: 'GUSER',
    executionId: `${runId}:exec:${allocationId}`,
    allocationId,
    childId: null,
    runId,
    agentAddress: RECOVERY_CREDENTIAL.agentAddress,
    amount: RECOVERY_AMOUNT,
    permission: {
      version: 1,
      mode: 'fresh',
      reviewedAgentInits: [
        {
          allocationId,
          token: RECOVERY_AMOUNT.token,
          cap: { units: RECOVERY_AMOUNT.units, decimals: RECOVERY_AMOUNT.decimals },
        },
      ],
    },
    ...overrides,
  }
}

function persistedReceipt(receipt, version) {
  return { ...receipt, format: receipt.version, version }
}

function recoveryReceipt(mapping, attempts = []) {
  let receipt = createAllocationReceipt({
    networkId: mapping.networkId,
    executionId: mapping.executionId,
    allocationId: mapping.allocationId,
    owner: mapping.owner,
    runId: mapping.runId,
    worker: RECOVERY_CREDENTIAL.publicKey,
    agent: mapping.agentAddress,
    intent: { allocationId: mapping.allocationId, kind: 'deposit', allocation: mapping.amount },
    amount: mapping.amount,
  })
  for (const attempt of attempts) receipt = appendPhase(receipt, attempt)
  return receipt
}

function recoveryClaim({ receipt = null, version = 0, action, phase, lease } = {}) {
  const decision = selectRecoveryAction(receipt)
  const selectedAction = action ?? decision.action
  const selectedPhase = phase === undefined ? decision.phase : phase
  return {
    ok: true,
    receipt,
    version,
    action: selectedAction,
    phase: selectedPhase,
    reasonCode: decision.reasonCode,
    reason: 'test producer-backed recovery claim',
    lease:
      selectedPhase == null
        ? null
        : (lease ?? {
            holder: 'browser-tab',
            leaseToken: 'lease-token',
            expiresAt: Date.now() + 60_000,
            phase: selectedPhase,
          }),
  }
}

function recoveryServer() {
  let receipt = null
  let version = 0
  postReceiptEvidenceMock.mockImplementation(async ({ body }) => {
    receipt = body.receipt
    version += 1
    return { version }
  })
  readRecoveryReceiptMock.mockImplementation(async () => ({
    receipt: receipt ? persistedReceipt(receipt, version) : null,
    version,
  }))
  return {
    set(nextReceipt, nextVersion) {
      receipt = nextReceipt
      version = nextVersion
    },
  }
}

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

  it('[Receipt][Write-ahead] an unverifiable pull intent aborts before runAgentPull', async () => {
    postReceiptEvidenceMock.mockRejectedValue(new Error('agent-index unreachable'))
    readRecoveryReceiptMock.mockResolvedValue({ receipt: null, version: 0 })
    const fixture = permissionedStellarOnlyFixture('run-receipt-transport-down')

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    const result = summary.results[0]
    expect(result.success).toBe(false)
    expect(result.receiptEvidenceDurable).toBe(false)
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(workerExecuteMock).not.toHaveBeenCalled()
    expect(postReceiptEvidenceMock).toHaveBeenCalledTimes(2)
    expect(readRecoveryReceiptMock).toHaveBeenCalledTimes(2)
    const attempts = postReceiptEvidenceMock.mock.calls.map(([args]) => args.body.attempt)
    expect(attempts[0]).toEqual(attempts[1])
    expect(attempts[0]).toMatchObject({ phase: 'pull', status: 'submitted' })
  })

  it('[Receipt][Write-ahead] an unverifiable deposit intent aborts before worker.execute', async () => {
    let serverReceipt = null
    let serverVersion = 0
    postReceiptEvidenceMock.mockImplementation(async ({ body }) => {
      if (body.attempt.phase === 'stellar_deposit' && body.attempt.status === 'submitted') {
        throw new Error('deposit intent response lost')
      }
      serverReceipt = body.receipt
      serverVersion += 1
      return { version: serverVersion }
    })
    readRecoveryReceiptMock.mockImplementation(async () => ({
      receipt: serverReceipt && {
        ...serverReceipt,
        format: serverReceipt.version,
        version: serverVersion,
      },
      version: serverVersion,
    }))
    const fixture = permissionedStellarOnlyFixture('run-receipt-deposit-intent-down')

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(runAgentPullMock).toHaveBeenCalledOnce()
    expect(workerExecuteMock).not.toHaveBeenCalled()
    expect(summary.results[0]).toMatchObject({ success: false, receiptEvidenceDurable: false })
    const depositWrites = postReceiptEvidenceMock.mock.calls
      .map(([args]) => args.body)
      .filter((body) => body.attempt.phase === 'stellar_deposit')
    expect(depositWrites).toHaveLength(2)
    expect(depositWrites[0].attempt).toEqual(depositWrites[1].attempt)
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

  it('[Write-ahead][Mixed] an unverifiable pull intent aborts before runAgentPull', async () => {
    postReceiptEvidenceMock.mockRejectedValue(new Error('agent-index unreachable'))
    readRecoveryReceiptMock.mockResolvedValue({ receipt: null, version: 0 })
    const fixture = permissionedMixedFixture('run-mixed-pull-intent-down')

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    const result = summary.results[0]
    expect(result.success).toBe(false)
    expect(result.receiptEvidenceDurable).toBe(false)
    expect(runAgentPullMock).not.toHaveBeenCalled()
    expect(workerExecuteMock).not.toHaveBeenCalled()
  })

  it('[Write-ahead][Mixed] an unverifiable deposit intent aborts before worker.execute', async () => {
    let serverReceipt = null
    let serverVersion = 0
    postReceiptEvidenceMock.mockImplementation(async ({ body }) => {
      if (body.attempt.phase === 'stellar_deposit' && body.attempt.status === 'submitted') {
        throw new Error('deposit intent response lost')
      }
      serverReceipt = body.receipt
      serverVersion += 1
      return { version: serverVersion }
    })
    readRecoveryReceiptMock.mockImplementation(async () => ({
      receipt: serverReceipt && {
        ...serverReceipt,
        format: serverReceipt.version,
        version: serverVersion,
      },
      version: serverVersion,
    }))
    const fixture = permissionedMixedFixture('run-mixed-deposit-intent-down')

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(runAgentPullMock).toHaveBeenCalledOnce()
    expect(workerExecuteMock).not.toHaveBeenCalled()
    expect(summary.results[0]).toMatchObject({ success: false, receiptEvidenceDurable: false })
  })

  it('[Write-ahead] adopts a nonzero authoritative row without losing its attempts or custody', async () => {
    let authoritativeReceipt = null
    let serverVersion = 7
    let firstAttemptId = null
    postReceiptEvidenceMock.mockImplementation(async ({ body }) => {
      if (!authoritativeReceipt) {
        firstAttemptId = body.attempt.attemptId
        const amount = body.receipt.custody.amount
        authoritativeReceipt = confirmCustody(
          appendPhase(
            createAllocationReceipt({
              networkId: body.receipt.networkId,
              executionId: body.receipt.executionId,
              allocationId: body.receipt.allocationId,
              owner: body.receipt.owner,
              runId: body.receipt.runId,
              worker: body.receipt.worker,
              agent: body.receipt.agent,
              intent: body.receipt.intent,
              amount,
            }),
            {
              attemptId: 'authoritative-attempt',
              phase: 'pull',
              status: 'submitted',
              evidence: { source: 'other-tab' },
              observedAt: 1_999_999_999_999,
            }
          ),
          { location: 'stellar-agent', txSuccess: true, amount }
        )
        throw new ReceiptEvidenceError('receipt version conflict', {
          step: 'write',
          status: 409,
        })
      }
      authoritativeReceipt = body.receipt
      serverVersion += 1
      return { version: serverVersion }
    })
    readRecoveryReceiptMock.mockImplementation(async () => ({
      receipt: {
        ...authoritativeReceipt,
        format: authoritativeReceipt.version,
        version: serverVersion,
      },
      version: serverVersion,
    }))
    const fixture = permissionedStellarOnlyFixture('run-receipt-nonzero-adoption')

    const summary = await permissionedOrchestrator().dispatch(fixture.plan, {
      permissionDecision: fixture.permissionDecision,
    })

    expect(summary.results[0]).toMatchObject({ success: true, receiptEvidenceDurable: true })
    expect(runAgentPullMock).toHaveBeenCalledOnce()
    expect(workerExecuteMock).toHaveBeenCalledOnce()
    expect(readRecoveryReceiptMock).toHaveBeenCalledOnce()
    const writes = postReceiptEvidenceMock.mock.calls.map(([args]) => args.body)
    expect(writes[1]).toMatchObject({ expectedVersion: 7 })
    expect(writes[1].receipt).toMatchObject({
      version: 2,
      custody: { location: 'stellar-agent', confirmed: true },
    })
    expect(writes[1].receipt.attempts.map(({ attemptId }) => attemptId)).toEqual([
      'authoritative-attempt',
      firstAttemptId,
    ])
    expect(writes[2]).toMatchObject({ expectedVersion: 8 })
    expect(writes[2].receipt.custody).toMatchObject({
      location: 'stellar-agent',
      confirmed: true,
    })
    expect(writes[2].receipt.attempts.map(({ attemptId }) => attemptId)).toEqual([
      'authoritative-attempt',
      firstAttemptId,
      writes[2].attempt.attemptId,
    ])
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

  describe('Task 7 Chunk C recovery execution', () => {
    it('records a PENDING V2 pull as durable unknown and never makes it replayable', async () => {
      const mapping = recoveryMapping()
      recoveryServer()
      runAgentPullMock.mockResolvedValue({ hash: 'HPULLPENDING', status: 'PENDING' })

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(result.receipt.phases.pull).toBe('unknown')
      expect(result.receipt.attempts.at(-1)).toMatchObject({
        phase: 'pull',
        status: 'unknown',
        evidence: { txHash: 'HPULLPENDING' },
      })
      expect(selectRecoveryAction(result.receipt)).toMatchObject({ action: 'poll', phase: 'pull' })
      expect(runAgentPullMock).toHaveBeenCalledOnce()
    })

    it('records a PENDING deposit as unknown with its hash and share baseline, never deposit again', async () => {
      const mapping = recoveryMapping()
      let receipt = recoveryReceipt(mapping, [
        {
          attemptId: 'pull-confirmed-before-pending-deposit',
          phase: 'pull',
          status: 'confirmed',
          evidence: { txHash: 'HPULLCONFIRMED' },
          observedAt: 1_999_999_999_010,
        },
      ])
      receipt = confirmCustody(receipt, {
        location: 'stellar-agent',
        txSuccess: true,
        amount: RECOVERY_AMOUNT,
      })
      const server = recoveryServer()
      server.set(receipt, 3)
      readVaultSharesMock.mockResolvedValueOnce(17n)
      runAgentDepositMock.mockResolvedValue({ hash: 'HDEPOSITPENDING', status: 'PENDING' })

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(receipt, 3),
          version: 3,
          action: 'deposit',
          phase: 'stellar_deposit',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(result.receipt.phases.stellar_deposit).toBe('unknown')
      expect(result.receipt.attempts.at(-1)).toMatchObject({
        phase: 'stellar_deposit',
        status: 'unknown',
        evidence: {
          txHash: 'HDEPOSITPENDING',
          preShareUnits: '17',
        },
      })
      expect(selectRecoveryAction(result.receipt)).toMatchObject({
        action: 'poll',
        phase: 'stellar_deposit',
      })
      expect(runAgentDepositMock).toHaveBeenCalledOnce()
    })

    it('never confirms custody from a backward bare duplicate relay response', async () => {
      const mapping = recoveryMapping()
      recoveryServer()
      runAgentPullMock.mockResolvedValue({ hash: 'HBAREDUPLICATE', status: 'duplicate' })

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(result.receipt).toMatchObject({
        phases: { pull: 'unknown' },
        custody: { location: 'owner', confirmed: true },
      })
      expect(result.receipt.attempts.at(-1)).toMatchObject({
        phase: 'pull',
        status: 'unknown',
        evidence: { txHash: 'HBAREDUPLICATE' },
      })
      expect(selectRecoveryAction(result.receipt)).toMatchObject({ action: 'poll', phase: 'pull' })
      expect(runAgentPullMock).toHaveBeenCalledOnce()
    })

    it('never confirms vault custody from a backward bare duplicate deposit response', async () => {
      const mapping = recoveryMapping()
      let receipt = recoveryReceipt(mapping, [
        {
          attemptId: 'pull-confirmed-before-bare-duplicate-deposit',
          phase: 'pull',
          status: 'confirmed',
          evidence: { txHash: 'HPULLBEFOREDUPLICATE' },
          observedAt: 1_999_999_999_009,
        },
      ])
      receipt = confirmCustody(receipt, {
        location: 'stellar-agent',
        txSuccess: true,
        amount: RECOVERY_AMOUNT,
      })
      const server = recoveryServer()
      server.set(receipt, 3)
      readVaultSharesMock.mockResolvedValueOnce(19n).mockResolvedValueOnce(20n)
      runAgentDepositMock.mockResolvedValue({ hash: 'HBAREDEPOSITDUPLICATE', status: 'duplicate' })

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(receipt, 3),
          version: 3,
          action: 'deposit',
          phase: 'stellar_deposit',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(result.receipt).toMatchObject({
        phases: { stellar_deposit: 'unknown' },
        custody: { location: 'stellar-agent', confirmed: true },
      })
      expect(result.receipt.attempts.at(-1)).toMatchObject({
        phase: 'stellar_deposit',
        status: 'unknown',
        evidence: { txHash: 'HBAREDEPOSITDUPLICATE', preShareUnits: '19' },
      })
      expect(runAgentDepositMock).toHaveBeenCalledOnce()
      expect(readVaultSharesMock).toHaveBeenCalledOnce()
    })

    it('keeps a producer-shaped cached PENDING duplicate unknown and a cached FAILED duplicate definitive', async () => {
      const mapping = recoveryMapping()
      const server = recoveryServer()
      runAgentPullMock.mockRejectedValueOnce(
        new RelaySubmissionUnknownError('cached transaction remains pending', {
          hash: 'HCACHEDPENDING',
          status: 'PENDING',
          duplicate: true,
        })
      )

      const pending = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })
      expect(pending.receipt).toMatchObject({
        phases: { pull: 'unknown' },
        custody: { location: 'owner', confirmed: true },
      })
      expect(selectRecoveryAction(pending.receipt)).toMatchObject({ action: 'poll', phase: 'pull' })

      server.set(null, 0)
      runAgentPullMock.mockResolvedValueOnce({
        hash: 'HCACHEDFAILED',
        status: 'FAILED',
        duplicate: true,
      })
      const failed = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })
      expect(failed.receipt).toMatchObject({
        phases: { pull: 'failed' },
        custody: { location: 'owner', confirmed: true },
      })
      expect(selectRecoveryAction(failed.receipt)).toMatchObject({ action: 'pull', phase: 'pull' })
      expect(runAgentPullMock).toHaveBeenCalledTimes(2)
    })

    it('writes a durable pull intent before one V2 pull with the original credential, then rereads the row', async () => {
      const mapping = recoveryMapping()
      recoveryServer()
      const claim = recoveryClaim()
      const orchestrator = permissionedOrchestrator()

      const result = await orchestrator.recoverAllocation({
        claim,
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(runAgentPullMock).toHaveBeenCalledOnce()
      expect(runAgentPullMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentAddress: mapping.agentAddress,
          amount: 10_000_000n,
          sessionKey: RECOVERY_CREDENTIAL,
        })
      )
      expect(postReceiptEvidenceMock.mock.invocationCallOrder[0]).toBeLessThan(
        runAgentPullMock.mock.invocationCallOrder[0]
      )
      expect(postReceiptEvidenceMock.mock.calls[0][0].body).toMatchObject({
        expectedVersion: 0,
        attempt: { phase: 'pull', status: 'submitted' },
      })
      expect(result).toMatchObject({
        version: 2,
        receipt: {
          phases: { pull: 'confirmed' },
          custody: { location: 'stellar-agent', confirmed: true, amount: RECOVERY_AMOUNT },
        },
      })
      expect(readRecoveryReceiptMock).toHaveBeenCalled()
    })

    it('does not move money when the write-ahead evidence cannot be durably verified', async () => {
      const mapping = recoveryMapping()
      postReceiptEvidenceMock.mockRejectedValue(new Error('agent-index unreachable'))
      readRecoveryReceiptMock.mockResolvedValue({ receipt: null, version: 0 })

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(runAgentDepositMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ receipt: null, version: 0, error: expect.any(Error) })
      expect(readRecoveryReceiptMock).toHaveBeenCalled()
    })

    it('aborts a recovery 409 when the authoritative row contains a different attempt', async () => {
      const mapping = recoveryMapping()
      const changed = recoveryReceipt(mapping, [
        {
          attemptId: 'different-authoritative-attempt',
          phase: 'pull',
          status: 'submitted',
          evidence: { source: 'other-claim-holder' },
          observedAt: 1_999_999_999_011,
        },
      ])
      postReceiptEvidenceMock
        .mockRejectedValueOnce(
          new ReceiptEvidenceError('receipt version conflict', {
            step: 'write',
            status: 409,
            code: 'version-conflict',
          })
        )
        .mockResolvedValue({ version: 2 })
      readRecoveryReceiptMock.mockResolvedValue({
        receipt: persistedReceipt(changed, 1),
        version: 1,
      })

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        receipt: { version: 1, attempts: [{ attemptId: 'different-authoritative-attempt' }] },
        version: 1,
        error: expect.any(Error),
      })
    })

    it.each([
      ['network loss', () => new Error('receipt-write response lost')],
      [
        'write 5xx',
        () =>
          new ReceiptEvidenceError('receipt-write upstream failed', {
            step: 'write',
            status: 502,
            code: 'server-error',
          }),
      ],
    ])(
      'aborts an ambiguous %s when the authoritative receipt advanced with another attempt',
      async (_label, makeError) => {
        const mapping = recoveryMapping()
        const changed = recoveryReceipt(mapping, [
          {
            attemptId: 'other-holder-advanced-attempt',
            phase: 'pull',
            status: 'submitted',
            evidence: { holder: 'other-tab' },
            observedAt: 1_999_999_999_021,
          },
        ])
        postReceiptEvidenceMock.mockRejectedValueOnce(makeError()).mockResolvedValue({ version: 2 })
        readRecoveryReceiptMock.mockResolvedValue({
          receipt: persistedReceipt(changed, 1),
          version: 1,
        })

        const result = await permissionedOrchestrator().recoverAllocation({
          claim: recoveryClaim(),
          credential: RECOVERY_CREDENTIAL,
          allocationMapping: mapping,
          permissionEvidence: mapping.permission,
        })

        expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
        expect(runAgentPullMock).not.toHaveBeenCalled()
        expect(runAgentDepositMock).not.toHaveBeenCalled()
        expect(result).toMatchObject({
          version: 1,
          receipt: { attempts: [{ attemptId: 'other-holder-advanced-attempt' }] },
          error: { code: 'RECOVERY_RECEIPT_CHANGED' },
        })
      }
    )

    it('does not retry an ambiguous write when the row version is unchanged but its receipt changed', async () => {
      const mapping = recoveryMapping()
      let baseline = recoveryReceipt(mapping, [
        {
          attemptId: 'same-version-baseline-pull',
          phase: 'pull',
          status: 'confirmed',
          evidence: { txHash: 'HSAMEVERSIONBASELINE' },
          observedAt: 1_999_999_999_023,
        },
      ])
      baseline = confirmCustody(baseline, {
        location: 'stellar-agent',
        txSuccess: true,
        amount: RECOVERY_AMOUNT,
      })
      const changed = appendPhase(baseline, {
        attemptId: 'same-version-different-receipt',
        phase: 'stellar_deposit',
        status: 'submitted',
        evidence: { holder: 'corrupt-concurrent-writer' },
        observedAt: 1_999_999_999_024,
      })
      postReceiptEvidenceMock
        .mockRejectedValueOnce(new Error('receipt-write response lost'))
        .mockResolvedValue({ version: 4 })
      readRecoveryReceiptMock.mockResolvedValue({
        receipt: persistedReceipt(changed, 3),
        version: 3,
      })

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(baseline, 3),
          version: 3,
          action: 'deposit',
          phase: 'stellar_deposit',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
      expect(runAgentDepositMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        version: 3,
        error: { code: 'RECOVERY_RECEIPT_CHANGED' },
      })
      expect(result.receipt.attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ attemptId: 'same-version-different-receipt' }),
        ])
      )
    })

    it('rejects an exact attempted write when a later authoritative attempt also advanced the row', async () => {
      const mapping = recoveryMapping()
      let authoritative
      postReceiptEvidenceMock.mockImplementationOnce(async ({ body }) => {
        authoritative = appendPhase(body.receipt, {
          attemptId: 'later-authoritative-attempt',
          phase: 'pull',
          status: 'submitted',
          evidence: { holder: 'later-claim-holder' },
          observedAt: 1_999_999_999_025,
        })
        throw new Error('receipt-write response lost after later advancement')
      })
      readRecoveryReceiptMock.mockImplementation(async () => ({
        receipt: persistedReceipt(authoritative, 2),
        version: 2,
      }))

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        version: 2,
        error: { code: 'RECOVERY_RECEIPT_CHANGED' },
      })
      expect(result.receipt.attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ attemptId: 'later-authoritative-attempt' }),
        ])
      )
    })

    it('retries one ambiguous recovery write only when the authoritative row is exactly unchanged', async () => {
      const mapping = recoveryMapping()
      let unchanged = recoveryReceipt(mapping, [
        {
          attemptId: 'safe-retry-pull-confirmed',
          phase: 'pull',
          status: 'confirmed',
          evidence: { txHash: 'HSAFEPRIORPULL' },
          observedAt: 1_999_999_999_022,
        },
      ])
      unchanged = confirmCustody(unchanged, {
        location: 'stellar-agent',
        txSuccess: true,
        amount: RECOVERY_AMOUNT,
      })
      let authoritative = unchanged
      let version = 3
      let posts = 0
      postReceiptEvidenceMock.mockImplementation(async ({ body }) => {
        posts += 1
        if (posts === 1) throw new Error('first write response lost')
        authoritative = body.receipt
        version += 1
        return { version }
      })
      readRecoveryReceiptMock.mockImplementation(async () => ({
        receipt: persistedReceipt(authoritative, version),
        version,
      }))
      readVaultSharesMock.mockResolvedValueOnce(10n).mockResolvedValueOnce(11n)

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(unchanged, 3),
          version: 3,
          action: 'deposit',
          phase: 'stellar_deposit',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(postReceiptEvidenceMock).toHaveBeenCalledTimes(3)
      expect(postReceiptEvidenceMock.mock.calls[0][0].body).toEqual(
        postReceiptEvidenceMock.mock.calls[1][0].body
      )
      expect(postReceiptEvidenceMock.mock.calls[1][0].body.expectedVersion).toBe(3)
      expect(runAgentDepositMock).toHaveBeenCalledOnce()
      expect(result).toMatchObject({
        version: 5,
        receipt: { phases: { stellar_deposit: 'confirmed' } },
      })
    })

    it('rechecks an expiring lease inside the writer boundary before receipt-write or movement', async () => {
      const mapping = recoveryMapping()
      const claim = recoveryClaim()
      let releaseChallenge
      let observedBeforeWrite
      const challengeDelay = new Promise((resolve) => {
        releaseChallenge = resolve
      })
      postReceiptEvidenceMock.mockImplementation(async ({ beforeWrite, body }) => {
        observedBeforeWrite = beforeWrite
        await challengeDelay
        await beforeWrite?.()
        return { version: body.expectedVersion + 1 }
      })
      readRecoveryReceiptMock.mockResolvedValue({ receipt: null, version: 0 })

      const recovery = permissionedOrchestrator().recoverAllocation({
        claim,
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })
      await vi.waitFor(() => expect(postReceiptEvidenceMock).toHaveBeenCalledOnce())
      claim.lease.expiresAt = Date.now() - 1
      releaseChallenge()
      const result = await recovery

      expect(observedBeforeWrite).toBeTypeOf('function')
      expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(runAgentDepositMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ receipt: null, version: 0, error: expect.any(Error) })
    })

    it('rechecks the account epoch inside the writer boundary before receipt-write or movement', async () => {
      const mapping = recoveryMapping()
      const captured = Object.freeze({
        version: 1,
        kind: 'G',
        address: 'GUSER',
        networkPassphrase: 'Test SDF Network ; September 2015',
        connectorId: 'freighter',
        epoch: 71,
      })
      let current = captured
      let releaseChallenge
      let observedBeforeWrite
      const challengeDelay = new Promise((resolve) => {
        releaseChallenge = resolve
      })
      postReceiptEvidenceMock.mockImplementation(async ({ beforeWrite, body }) => {
        observedBeforeWrite = beforeWrite
        await challengeDelay
        await beforeWrite?.()
        return { version: body.expectedVersion + 1 }
      })
      readRecoveryReceiptMock.mockResolvedValue({ receipt: null, version: 0 })
      const orchestrator = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'recovery-account-write-boundary',
        activeAccount: captured,
        getCurrentActiveAccount: () => current,
        onEvent: vi.fn(),
      })

      const recovery = orchestrator.recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })
      await vi.waitFor(() => expect(postReceiptEvidenceMock).toHaveBeenCalledOnce())
      current = Object.freeze({ ...captured, epoch: 72 })
      releaseChallenge()
      const result = await recovery

      expect(observedBeforeWrite).toBeTypeOf('function')
      expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(runAgentDepositMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ receipt: null, version: 0, error: expect.any(Error) })
    })

    it('checks lease expiry immediately before a recorder retry POST', async () => {
      const mapping = recoveryMapping()
      const claim = recoveryClaim()
      postReceiptEvidenceMock
        .mockRejectedValueOnce(new Error('write response lost'))
        .mockResolvedValue({ version: 1 })
      readRecoveryReceiptMock.mockImplementation(async () => {
        claim.lease.expiresAt = Date.now() - 1
        return { receipt: null, version: 0 }
      })

      const result = await permissionedOrchestrator().recoverAllocation({
        claim,
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ receipt: null, version: 0, error: expect.any(Error) })
    })

    it('checks the account epoch immediately before a recorder retry POST', async () => {
      const mapping = recoveryMapping()
      const captured = Object.freeze({
        version: 1,
        kind: 'G',
        address: 'GUSER',
        networkPassphrase: 'Test SDF Network ; September 2015',
        connectorId: 'freighter',
        epoch: 51,
      })
      let current = captured
      postReceiptEvidenceMock
        .mockRejectedValueOnce(new Error('write response lost'))
        .mockResolvedValue({ version: 1 })
      readRecoveryReceiptMock.mockImplementation(async () => {
        current = Object.freeze({ ...captured, epoch: 52 })
        return { receipt: null, version: 0 }
      })
      const orchestrator = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'recovery-account-retry',
        activeAccount: captured,
        getCurrentActiveAccount: () => current,
        onEvent: vi.fn(),
      })

      const result = await orchestrator.recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ receipt: null, version: 0, error: expect.any(Error) })
    })

    it('never emits a late recorder failure after the actual orchestrator account epoch switches', async () => {
      const mapping = recoveryMapping()
      const captured = Object.freeze({
        version: 1,
        kind: 'G',
        address: 'GUSER',
        networkPassphrase: 'Test SDF Network ; September 2015',
        connectorId: 'freighter',
        epoch: 61,
      })
      let current = captured
      let rejectWrite
      postReceiptEvidenceMock.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            rejectWrite = reject
          })
      )
      readRecoveryReceiptMock.mockResolvedValue({ receipt: null, version: 0 })
      const observer = vi.fn()
      const orchestrator = new OrchestratorAgent({
        user: 'GUSER',
        sessionId: 'recovery-late-recorder-event',
        activeAccount: captured,
        getCurrentActiveAccount: () => current,
        onEvent: observer,
      })

      const recovery = orchestrator.recoverAllocation({
        claim: recoveryClaim(),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })
      await vi.waitFor(() => expect(rejectWrite).toBeTypeOf('function'))
      current = Object.freeze({ ...captured, epoch: 62 })
      rejectWrite(new Error('late recorder response loss'))

      await expect(recovery).resolves.toMatchObject({
        receipt: null,
        version: 0,
        error: expect.any(Error),
      })
      expect(observer).not.toHaveBeenCalled()
      expect(postReceiptEvidenceMock).toHaveBeenCalledOnce()
      expect(runAgentPullMock).not.toHaveBeenCalled()
    })

    it.each([
      { source: 'mapping', field: 'token', value: 'COTHER' },
      { source: 'mapping', field: 'units', value: '9999999' },
      { source: 'mapping', field: 'decimals', value: 6 },
      { source: 'permission', field: 'token', value: 'COTHER' },
      { source: 'permission', field: 'units', value: '9999999' },
      { source: 'permission', field: 'decimals', value: 6 },
    ])(
      'rejects receipt-present $source $field amount drift before writes, reads, or movement',
      async ({ source, field, value }) => {
        const durableMapping = recoveryMapping()
        let receipt = recoveryReceipt(durableMapping, [
          {
            attemptId: 'amount-authority-pull-confirmed',
            phase: 'pull',
            status: 'confirmed',
            evidence: { txHash: 'HAMOUNTPULL' },
            observedAt: 1_999_999_999_012,
          },
        ])
        receipt = confirmCustody(receipt, {
          location: 'stellar-agent',
          txSuccess: true,
          amount: RECOVERY_AMOUNT,
        })
        const server = recoveryServer()
        server.set(receipt, 3)

        const mapping = {
          ...durableMapping,
          amount:
            source === 'mapping'
              ? { ...durableMapping.amount, [field]: value }
              : durableMapping.amount,
        }
        const reviewed = durableMapping.permission.reviewedAgentInits[0]
        const permissionEvidence =
          source === 'permission'
            ? {
                ...durableMapping.permission,
                reviewedAgentInits: [
                  field === 'token'
                    ? { ...reviewed, token: value }
                    : { ...reviewed, cap: { ...reviewed.cap, [field]: value } },
                ],
              }
            : durableMapping.permission

        const result = await permissionedOrchestrator().recoverAllocation({
          claim: recoveryClaim({
            receipt: persistedReceipt(receipt, 3),
            version: 3,
            action: 'deposit',
            phase: 'stellar_deposit',
          }),
          credential: RECOVERY_CREDENTIAL,
          allocationMapping: mapping,
          permissionEvidence,
        })

        expect(result).toMatchObject({ version: 3, error: expect.any(Error) })
        expect(postReceiptEvidenceMock).not.toHaveBeenCalled()
        expect(readVaultSharesMock).not.toHaveBeenCalled()
        expect(runAgentPullMock).not.toHaveBeenCalled()
        expect(runAgentDepositMock).not.toHaveBeenCalled()
      }
    )

    it('never resubmits an uncertain V2 pull, but reuses the exact durable V3 execution id', async () => {
      const mapping = recoveryMapping()
      const v2Receipt = recoveryReceipt(mapping, [
        {
          attemptId: 'v2-uncertain',
          phase: 'pull',
          status: 'unknown',
          evidence: { txHash: 'HV2UNKNOWN' },
          observedAt: 1_999_999_999_001,
        },
      ])
      const server = recoveryServer()
      server.set(v2Receipt, 4)

      await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(v2Receipt, 4),
          version: 4,
          action: 'poll',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(readConfirmedLedgerMock).toHaveBeenCalledWith({ hash: 'HV2UNKNOWN' })

      const v3ExecutionId = `0x${'ab'.repeat(32)}`
      const v3Receipt = recoveryReceipt(mapping, [
        {
          attemptId: 'v3-uncertain',
          phase: 'pull',
          status: 'unknown',
          evidence: { txHash: 'HV3UNKNOWN', v3ExecutionId },
          observedAt: 1_999_999_999_002,
        },
      ])
      server.set(v3Receipt, 7)
      const orchestrator = permissionedOrchestrator()
      const v3Pull = vi
        .spyOn(orchestrator, 'runAgentPullV3')
        .mockResolvedValue({ hash: 'HV3RECOVERED', status: 'SUCCESS' })

      const result = await orchestrator.recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(v3Receipt, 7),
          version: 7,
          action: 'resubmit-identical-envelope',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: {
          version: 3,
          mode: 'reuse',
          router: 'CV3ROUTER',
          permissionId: `0x${'cd'.repeat(32)}`,
          reviewedAgentInits: mapping.permission.reviewedAgentInits,
          executions: [
            {
              allocationId: mapping.allocationId,
              executionId: v3ExecutionId,
              agentAddress: mapping.agentAddress,
              amountUnits: RECOVERY_AMOUNT.units,
            },
          ],
        },
      })

      expect(v3Pull).toHaveBeenCalledOnce()
      expect(v3Pull).toHaveBeenCalledWith({
        permissionId: `0x${'cd'.repeat(32)}`,
        executionId: v3ExecutionId,
        agentAddress: mapping.agentAddress,
        amount: 10_000_000n,
        sessionKey: RECOVERY_CREDENTIAL,
        router: 'CV3ROUTER',
      })
      expect(result.receipt.phases.pull).toBe('confirmed')
    })

    it('captures a deposit share baseline before submission and keeps no-increase outcomes unknown', async () => {
      const mapping = recoveryMapping()
      let receipt = recoveryReceipt(mapping, [
        {
          attemptId: 'pull-confirmed',
          phase: 'pull',
          status: 'confirmed',
          evidence: { txHash: 'HPULL' },
          observedAt: 1_999_999_999_003,
        },
      ])
      receipt = confirmCustody(receipt, {
        location: 'stellar-agent',
        txSuccess: true,
        amount: RECOVERY_AMOUNT,
      })
      const server = recoveryServer()
      server.set(receipt, 3)
      readVaultSharesMock.mockResolvedValueOnce(5n).mockResolvedValueOnce(5n)

      const result = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(receipt, 3),
          version: 3,
          action: 'deposit',
          phase: 'stellar_deposit',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(readVaultSharesMock).toHaveBeenNthCalledWith(1, mapping.agentAddress)
      expect(postReceiptEvidenceMock.mock.calls[0][0].body.attempt).toMatchObject({
        phase: 'stellar_deposit',
        status: 'submitted',
        evidence: { preShareUnits: '5' },
      })
      expect(readVaultSharesMock.mock.invocationCallOrder[0]).toBeLessThan(
        runAgentDepositMock.mock.invocationCallOrder[0]
      )
      expect(postReceiptEvidenceMock.mock.invocationCallOrder[0]).toBeLessThan(
        runAgentDepositMock.mock.invocationCallOrder[0]
      )
      expect(result.receipt.phases.stellar_deposit).toBe('unknown')
      expect(result.receipt.custody).toMatchObject({ location: 'stellar-agent', confirmed: true })
    })

    it('blocks missing poll evidence and a lease that expires after write-ahead before movement', async () => {
      const mapping = recoveryMapping()
      const missingHash = recoveryReceipt(mapping, [
        {
          attemptId: 'missing-hash',
          phase: 'pull',
          status: 'unknown',
          evidence: {},
          observedAt: 1_999_999_999_004,
        },
      ])
      const server = recoveryServer()
      server.set(missingHash, 2)

      const missingResult = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(missingHash, 2),
          version: 2,
          action: 'poll',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(readConfirmedLedgerMock).not.toHaveBeenCalled()
      expect(missingResult).toMatchObject({
        version: 2,
        error: { code: 'RECOVERY_POLL_TX_HASH_REQUIRED', phase: 'pull' },
      })

      let missingBaseline = recoveryReceipt(mapping, [
        {
          attemptId: 'baseline-pull-confirmed',
          phase: 'pull',
          status: 'confirmed',
          evidence: { txHash: 'HPULLBEFOREBASELINE' },
          observedAt: 1_999_999_999_005,
        },
        {
          attemptId: 'missing-share-baseline',
          phase: 'stellar_deposit',
          status: 'unknown',
          evidence: { txHash: 'HDEPOSITWITHOUTBASELINE' },
          observedAt: 1_999_999_999_006,
        },
      ])
      missingBaseline = confirmCustody(missingBaseline, {
        location: 'stellar-agent',
        txSuccess: true,
        amount: RECOVERY_AMOUNT,
      })
      server.set(missingBaseline, 4)

      const missingBaselineResult = await permissionedOrchestrator().recoverAllocation({
        claim: recoveryClaim({
          receipt: persistedReceipt(missingBaseline, 4),
          version: 4,
          action: 'poll',
          phase: 'stellar_deposit',
        }),
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(missingBaselineResult).toMatchObject({
        version: 4,
        error: {
          code: 'RECOVERY_POLL_SHARE_BASELINE_REQUIRED',
          phase: 'stellar_deposit',
        },
      })
      expect(readConfirmedLedgerMock).not.toHaveBeenCalled()
      expect(readVaultSharesMock).not.toHaveBeenCalled()

      const expiringClaim = recoveryClaim()
      server.set(null, 0)
      postReceiptEvidenceMock.mockImplementation(async ({ body }) => {
        server.set(body.receipt, 1)
        expiringClaim.lease.expiresAt = Date.now() - 1
        return { version: 1 }
      })

      const expiredResult = await permissionedOrchestrator().recoverAllocation({
        claim: expiringClaim,
        credential: RECOVERY_CREDENTIAL,
        allocationMapping: mapping,
        permissionEvidence: mapping.permission,
      })

      expect(runAgentPullMock).not.toHaveBeenCalled()
      expect(runAgentDepositMock).not.toHaveBeenCalled()
      expect(expiredResult).toMatchObject({ version: 1, error: expect.any(Error) })
      expect(expiredResult.receipt.phases.pull).toBe('submitted')
    })

    it.each([
      ['RECOVERY_POLL_TX_HASH_REQUIRED', 'pull', 'missing-hash'],
      ['RECOVERY_POLL_SHARE_BASELINE_REQUIRED', 'stellar_deposit', 'missing-baseline'],
    ])(
      'preserves %s and its phase when the mandatory reread also fails',
      async (code, phase, fixtureKind) => {
        const mapping = recoveryMapping()
        let receipt
        let version
        if (fixtureKind === 'missing-hash') {
          receipt = recoveryReceipt(mapping, [
            {
              attemptId: 'aggregate-missing-hash',
              phase: 'pull',
              status: 'unknown',
              evidence: {},
              observedAt: 1_999_999_999_031,
            },
          ])
          version = 2
        } else {
          receipt = recoveryReceipt(mapping, [
            {
              attemptId: 'aggregate-prior-pull',
              phase: 'pull',
              status: 'confirmed',
              evidence: { txHash: 'HAGGREGATEPULL' },
              observedAt: 1_999_999_999_032,
            },
            {
              attemptId: 'aggregate-missing-baseline',
              phase: 'stellar_deposit',
              status: 'unknown',
              evidence: { txHash: 'HAGGREGATEDEPOSIT' },
              observedAt: 1_999_999_999_033,
            },
          ])
          receipt = confirmCustody(receipt, {
            location: 'stellar-agent',
            txSuccess: true,
            amount: RECOVERY_AMOUNT,
          })
          version = 4
        }
        readRecoveryReceiptMock.mockRejectedValue(new Error('mandatory reread unavailable'))

        await expect(
          permissionedOrchestrator().recoverAllocation({
            claim: recoveryClaim({
              receipt: persistedReceipt(receipt, version),
              version,
              action: 'poll',
              phase,
            }),
            credential: RECOVERY_CREDENTIAL,
            allocationMapping: mapping,
            permissionEvidence: mapping.permission,
          })
        ).rejects.toMatchObject({
          name: 'AggregateError',
          code,
          phase,
          primaryError: { code, phase },
        })
        expect(readConfirmedLedgerMock).not.toHaveBeenCalled()
        expect(readVaultSharesMock).not.toHaveBeenCalled()
      }
    )
  })
})
