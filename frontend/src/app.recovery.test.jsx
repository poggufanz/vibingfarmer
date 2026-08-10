// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  buildRecoveryAllocationMappings,
  createAccountScopedRecoveryConfig,
  createRecoveryActionRunner,
  projectBaseOutcomeRecovery,
} from './app.jsx'
import { StartStage as _StartStage } from './components/strategy/StartStage.jsx'
import { projectRecoveryReceipt } from './strategy/receiptProjection.js'
import { createBaseRecoveryActionRunner } from './strategy/baseRecoveryClient.js'
import { baseRecoveryIdentityKey } from './strategy/baseRecoveryIdentity.js'
import {
  appendPhase,
  confirmCustody,
  createAllocationReceipt,
} from './strategy/allocationReceipt.js'

afterEach(cleanup)

const ACCOUNT = Object.freeze({
  version: 1,
  kind: 'G',
  address: 'GOWNER',
  networkPassphrase: 'Test SDF Network ; September 2015',
  connectorId: 'freighter',
  epoch: 1,
})

const PLAN = Object.freeze({
  runId: 'run-recovery-app',
  planFingerprint: 'PLAN-RECOVERY-APP',
  agents: [
    {
      allocationId: 'run-recovery-app:deposit:0',
      kind: 'deposit',
      cap: { token: 'CTOKEN', units: '7000000', decimals: 7 },
    },
    {
      allocationId: 'run-recovery-app:bridge:base',
      kind: 'bridge',
      cap: { token: 'CUSDC', units: '3000000', decimals: 7 },
      children: [{ allocationId: 'run-recovery-app:bridge:pool-a' }],
    },
  ],
})

function projection(action = 'deposit') {
  return {
    action,
    phase: action === 'deposit' ? 'stellar_deposit' : 'pull',
    version: 3,
    receipt: { agent: 'CDEPOSIT', version: 3 },
    requestIdentity: {
      executionId: 'run-recovery-app:exec:run-recovery-app:deposit:0',
      allocationId: 'run-recovery-app:deposit:0',
      expectedReceiptVersion: 3,
    },
    route: { allocationId: 'run-recovery-app:deposit:0', source: 'receipt' },
  }
}

const RECOVERY_AMOUNT = Object.freeze({ token: 'CTOKEN', units: '7000000', decimals: 7 })

// Deliberately use a historical execution/allocation pair that cannot be reconstructed from the
// plan's runId or array position. The second identity shares the allocationId but differs in every
// other identity component that a weak pending map could accidentally omit.
const BASE_IDENTITY = Object.freeze({
  networkId: 'stellar-testnet',
  bindingId: '0123456789abcdef0123456789abcdef',
  executionId: 'historical-run:exec:shared-base-allocation',
  allocationId: 'shared-base-allocation',
  childId: 'abcdef0123456789abcdef0123456789',
})
const COLLISION_IDENTITY = Object.freeze({
  networkId: 'stellar-testnet',
  bindingId: 'fedcba9876543210fedcba9876543210',
  executionId: 'newer-run:exec:shared-base-allocation',
  allocationId: 'shared-base-allocation',
  childId: '11111111111111111111111111111111',
})
const BASE_OWNER = 'GBASEOWNER'
const BASE_AGENT = 'GBASEBRIDGE'
const BASE_MANDATE_ID = '0123456789abcdef0123456789abcdef'

function baseEvidence(
  identity,
  { recoveryVersion = 1, owner = BASE_OWNER, agent = BASE_AGENT } = {}
) {
  return {
    schemaVersion: 1,
    identity,
    owner,
    agent,
    recoverable: true,
    recoveryVersion,
    intent: {
      runId: identity.executionId.split(':exec:')[0],
      grantTxHash: '66'.repeat(32),
      bindingHash: '77'.repeat(32),
      baseJobId: identity.childId,
      kernelAddress: '0x00000000000000000000000000000000000000aa',
      poolAddress: '0x00000000000000000000000000000000000000b2',
      proxyTarget: 'aave-v3',
      token: 'USDC',
      units: '1000000',
      decimals: 6,
      minShares: '900000',
    },
    phases: [],
    events: [],
  }
}

function baseProjection(identity, overrides = {}) {
  return {
    action: 'submit-mint',
    phase: 'cctp_mint',
    reasonCode: 'base-attestation-confirmed',
    identity,
    version: 1,
    phases: {},
    custody: { location: 'cctp-transit', confirmed: true },
    ...overrides,
  }
}

function baseRunnerHarness(overrides = {}) {
  const active = { version: 1, address: BASE_OWNER, epoch: 1 }
  const claim = (identity = BASE_IDENTITY, version = 1) => ({
    identity,
    action: 'submit-mint',
    phase: 'cctp_mint',
    reasonCode: 'base-attestation-confirmed',
    evidenceVersion: version,
    lease: {
      holder: 'tab-base',
      leaseToken: '11'.repeat(32),
      expiresAt: 9e15,
    },
  })
  const accepted = (identity = BASE_IDENTITY) => ({
    accepted: true,
    workId: '22'.repeat(32),
    identity,
    action: 'submit-mint',
    evidenceVersion: 1,
    status: 'pending',
  })
  const deps = {
    getActiveAccount: vi.fn(() => active),
    getMandateId: vi.fn(() => BASE_MANDATE_ID),
    readEvidence: vi.fn(async ({ identity }) => baseEvidence(identity)),
    projectEvidence: vi.fn((evidence) =>
      baseProjection(evidence.identity, { version: evidence.recoveryVersion })
    ),
    requestClaim: vi.fn(async ({ identity }) => claim(identity)),
    executeRecovery: vi.fn(async ({ claim: currentClaim }) => accepted(currentClaim.identity)),
    pollEvidence: vi.fn(async ({ identity }) => ({
      status: 'advanced',
      bundle: baseEvidence(identity, { recoveryVersion: 2 }),
    })),
    // This callback is deliberately passed through requestClaim, just like the production bridge
    // credential seam. The Base runner must not discover or invoke the Stellar recovery executor.
    resolveCredential: vi.fn(async ({ agentAddress }) => ({
      agentAddress,
      publicKey: 'GSESSION',
      sign: vi.fn(),
    })),
    onProjection: vi.fn(),
    onPending: vi.fn(),
    onError: vi.fn(),
    leaseOwner: 'tab-base',
    pollLimit: 2,
    pollIntervalMs: 0,
    ...overrides,
  }
  return { active, claim, accepted, deps }
}

function producedReceipt(overrides = {}) {
  return createAllocationReceipt({
    networkId: 'stellar-testnet',
    executionId: 'run-recovery-app:exec:run-recovery-app:deposit:0',
    allocationId: 'run-recovery-app:deposit:0',
    owner: ACCOUNT.address,
    runId: PLAN.runId,
    worker: 'GWORKER',
    agent: 'CDEPOSIT',
    intent: { allocationId: 'run-recovery-app:deposit:0', kind: 'deposit' },
    amount: RECOVERY_AMOUNT,
    ...overrides,
  })
}

function producedPullPoll({ txHash } = {}) {
  return appendPhase(producedReceipt(), {
    attemptId: 'pull-attempt',
    phase: 'pull',
    status: 'submitted',
    evidence: txHash === undefined ? {} : { txHash },
    observedAt: 1,
  })
}

function producedAgentCustody() {
  let receipt = appendPhase(producedReceipt(), {
    attemptId: 'pull-confirmed',
    phase: 'pull',
    status: 'confirmed',
    evidence: { txHash: 'HPULL' },
    observedAt: 1,
  })
  receipt = confirmCustody(receipt, {
    location: 'stellar-agent',
    txSuccess: true,
    amount: RECOVERY_AMOUNT,
  })
  return receipt
}

function producedDepositPoll({ txHash, preShareUnits } = {}) {
  return appendPhase(producedAgentCustody(), {
    attemptId: 'deposit-attempt',
    phase: 'stellar_deposit',
    status: 'submitted',
    evidence: {
      ...(txHash === undefined ? {} : { txHash }),
      ...(preShareUnits === undefined ? {} : { preShareUnits }),
    },
    observedAt: 2,
  })
}

function producedComplete() {
  let receipt = producedAgentCustody()
  receipt = confirmCustody(receipt, {
    location: 'stellar-vault',
    txSuccess: true,
    matchingEvent: true,
    amount: RECOVERY_AMOUNT,
  })
  return appendPhase(receipt, {
    attemptId: 'deposit-confirmed',
    phase: 'stellar_deposit',
    status: 'confirmed',
    evidence: { txHash: 'HDEPOSIT', preShareUnits: '10', postShareUnits: '11' },
    observedAt: 2,
  })
}

function row(receipt, version) {
  return { receipt: receipt == null ? null : { ...receipt, version }, version }
}

function runnerHarness(overrides = {}) {
  const mapping = buildRecoveryAllocationMappings({
    plan: PLAN,
    confirmedPermission: {
      mode: 'fresh',
      agentAddresses: ['CDEPOSIT', 'CBRIDGE'],
    },
    reviewedPermission: { version: 1, mode: 'fresh' },
    owner: ACCOUNT.address,
  }).get('run-recovery-app:deposit:0')
  const projected = projection()
  const credential = { agentAddress: 'CDEPOSIT', publicKey: 'GSIGNER', sign: vi.fn() }
  const claim = {
    ok: true,
    action: 'deposit',
    phase: 'stellar_deposit',
    receipt: projected.receipt,
    version: 3,
    lease: { holder: 'tab-a', leaseToken: 'lease-a', phase: 'stellar_deposit', expiresAt: 9e15 },
  }
  const recovered = {
    receipt: { ...projected.receipt, version: 5 },
    version: 5,
  }
  const deps = {
    getActiveAccount: vi.fn(() => ACCOUNT),
    getProjection: vi.fn(() => projected),
    getMapping: vi.fn(() => mapping),
    getPermission: vi.fn(() => ({ version: 1, mode: 'fresh' })),
    resolveCredential: vi.fn(() => credential),
    requestAction: vi.fn(async () => claim),
    readReceipt: vi.fn(async () => recovered),
    projectReceipt: vi.fn(({ receipt, version }) => ({
      ...projected,
      receipt,
      version,
    })),
    recoverAllocation: vi.fn(async () => recovered),
    onProjection: vi.fn(),
    onPending: vi.fn(),
    onError: vi.fn(),
    leaseOwner: 'tab-a',
    vault: 'CVAULT',
    ...overrides,
  }
  return { mapping, projected, credential, claim, recovered, deps }
}

function useProducedClaim({ mapping, claim, deps }, { receipt, version, phase }) {
  const authoritative = row(receipt, version)
  const projected = projectRecoveryReceipt({ ...authoritative, identity: mapping })
  Object.assign(claim, {
    action: projected.action,
    phase: phase ?? projected.phase,
    receipt: authoritative.receipt,
    version,
  })
  deps.getProjection.mockReturnValue(projected)
  deps.requestAction.mockResolvedValue(claim)
  deps.projectReceipt = projectRecoveryReceipt
  return { authoritative, projected }
}

function pollProofError(code, phase, message = 'Durable poll evidence is incomplete.') {
  return Object.assign(new Error(message), { code, phase })
}

function aggregatePollError(primary) {
  return Object.assign(
    new AggregateError([primary, new Error('mandatory reread unavailable')], 'reread failed'),
    { code: primary.code, phase: primary.phase, primaryError: primary }
  )
}

function renderRecoveryControl(mapping, projectedRecovery) {
  const amount = { token: 'CTOKEN', units: '7000000', decimals: 7 }
  const uiPlan = {
    runId: PLAN.runId,
    planFingerprint: PLAN.planFingerprint,
    amount,
    agents: [
      {
        ...PLAN.agents[0],
        hostNetworkId: 'stellar-testnet',
        allocation: amount,
        periodSeconds: 3600,
        expiry: 2_000_000_000,
        destination: 'Stellar deposit',
        children: [],
      },
    ],
    truth: {
      agentIsolationCount: 1,
      stellarVenueCount: 1,
      baseUsesProxyVaults: false,
    },
  }
  const outcome = {
    allocationId: mapping.allocationId,
    amount,
    networkContext: {
      executionNetwork: 'stellar-testnet',
      currentCustodyNetwork: null,
      transit: false,
    },
    executionStatus: 'failed',
    custody: { location: 'unknown', confirmed: false, checkedAt: null },
    txHash: null,
    error: 'Original dispatch failed.',
    evidence: { allocationId: mapping.allocationId },
  }
  const receipt = {
    version: 1,
    runId: PLAN.runId,
    planFingerprint: PLAN.planFingerprint,
    permission: {
      mode: 'fresh',
      status: 'confirmed',
      confirmationCount: 1,
      txHash: 'HGRANT',
      grantReceiptFingerprint: 'FP',
      expiryLedger: 9_001,
      agentAddresses: [mapping.agentAddress],
    },
    branches: {
      stellar: { status: 'failed', results: [outcome] },
      base: { status: 'not-planned', results: [] },
    },
    allocations: [outcome],
  }

  render(
    <_StartStage
      plan={uiPlan}
      permission={{ mode: 'fresh' }}
      receipt={receipt}
      recoveryByAllocation={{ [mapping.allocationId]: projectedRecovery }}
    />
  )
}

describe('buildRecoveryAllocationMappings', () => {
  it('pairs confirmed addresses with the same ordered top-level plan rows and never fabricates a Base child mapping', () => {
    const mappings = buildRecoveryAllocationMappings({
      plan: PLAN,
      confirmedPermission: {
        mode: 'fresh',
        agentAddresses: ['CDEPOSIT', 'CBRIDGE'],
      },
      reviewedPermission: { version: 1, mode: 'fresh' },
      owner: ACCOUNT.address,
    })

    expect([...mappings.keys()]).toEqual(['run-recovery-app:deposit:0'])
    expect(mappings.get('run-recovery-app:deposit:0')).toEqual({
      networkId: 'stellar-testnet',
      owner: ACCOUNT.address,
      executionId: 'run-recovery-app:exec:run-recovery-app:deposit:0',
      allocationId: 'run-recovery-app:deposit:0',
      childId: null,
      runId: PLAN.runId,
      agentAddress: 'CDEPOSIT',
      amount: { token: 'CTOKEN', units: '7000000', decimals: 7 },
    })
    expect(mappings.has('run-recovery-app:bridge:base')).toBe(false)
    expect(mappings.has('run-recovery-app:bridge:pool-a')).toBe(false)
    expect(JSON.stringify([...mappings.values()])).not.toMatch(/secret|privateKey|sessionKey/i)
  })

  it('fails closed when confirmed address order is incomplete or reviewed agent evidence disagrees', () => {
    expect(() =>
      buildRecoveryAllocationMappings({
        plan: PLAN,
        confirmedPermission: { mode: 'fresh', agentAddresses: ['CDEPOSIT'] },
        reviewedPermission: { version: 1, mode: 'fresh' },
        owner: ACCOUNT.address,
      })
    ).toThrow(/confirmed agent address/i)

    expect(() =>
      buildRecoveryAllocationMappings({
        plan: PLAN,
        confirmedPermission: {
          mode: 'reuse',
          agentAddresses: ['CDEPOSIT', 'CBRIDGE'],
        },
        reviewedPermission: {
          version: 2,
          mode: 'reuse',
          agents: [
            {
              allocationId: 'run-recovery-app:deposit:0',
              agentAddress: 'CDIFFERENT',
            },
          ],
        },
        owner: ACCOUNT.address,
      })
    ).toThrow(/reviewed agent evidence/i)
  })
})

describe('createRecoveryActionRunner', () => {
  it('restores the exact credential, claims a fresh lease, executes once, and publishes the reread projection', async () => {
    const { mapping, credential, claim, recovered, deps } = runnerHarness()
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run(mapping.allocationId)).resolves.toEqual(recovered)

    expect(deps.resolveCredential).toHaveBeenCalledWith({
      networkId: mapping.networkId,
      owner: mapping.owner,
      vault: 'CVAULT',
      agentAddress: mapping.agentAddress,
    })
    expect(deps.requestAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ...deps.getProjection.mock.results[0].value.requestIdentity,
        networkId: mapping.networkId,
        owner: mapping.owner,
        receipt: deps.getProjection.mock.results[0].value.receipt,
        allocationMapping: mapping,
        leaseOwner: 'tab-a',
        vault: 'CVAULT',
        resolveCredential: expect.any(Function),
      })
    )
    expect(deps.recoverAllocation).toHaveBeenCalledWith({
      claim,
      credential,
      allocationMapping: mapping,
      permissionEvidence: { version: 1, mode: 'fresh' },
    })
    expect(deps.onProjection).toHaveBeenLastCalledWith(
      mapping.allocationId,
      expect.objectContaining({ version: 5 })
    )
    expect(deps.onPending.mock.calls).toEqual([
      [mapping.allocationId, true],
      [mapping.allocationId, false],
    ])
  })

  it('suppresses a duplicate click while the exact allocation is pending', async () => {
    let release
    const wait = new Promise((resolve) => {
      release = resolve
    })
    const { mapping, claim, recovered, deps } = runnerHarness({
      requestAction: vi.fn(async () => {
        await wait
        return claim
      }),
    })
    const runner = createRecoveryActionRunner(deps)

    const first = runner.run(mapping.allocationId)
    await expect(runner.run(mapping.allocationId)).resolves.toEqual({ skipped: 'pending' })
    release()
    await first

    expect(deps.requestAction).toHaveBeenCalledOnce()
    expect(deps.recoverAllocation).toHaveBeenCalledOnce()
    expect(deps.onProjection).toHaveBeenCalledWith(
      mapping.allocationId,
      expect.objectContaining({ version: recovered.version })
    )
  })

  it('keeps a Base child display-only and never restores or executes a Stellar credential', async () => {
    const { deps } = runnerHarness({
      getProjection: vi.fn(() => ({
        action: 'blocked-reconcile',
        phase: null,
        route: {
          allocationId: 'run-recovery-app:bridge:pool-a',
          parentAllocationId: 'run-recovery-app:bridge:base',
          childId: 'run-recovery-app:bridge:pool-a',
          source: 'base-child-result',
        },
      })),
      getMapping: vi.fn(() => null),
    })
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run('run-recovery-app:bridge:pool-a')).resolves.toEqual({
      skipped: 'blocked-reconcile',
    })
    expect(deps.resolveCredential).not.toHaveBeenCalled()
    expect(deps.requestAction).not.toHaveBeenCalled()
    expect(deps.recoverAllocation).not.toHaveBeenCalled()
  })

  it('rereads and reprojects a version conflict without calling the executor', async () => {
    const conflict = Object.assign(new Error('row changed'), {
      code: 'version-conflict',
      version: 4,
    })
    const { mapping, recovered, deps } = runnerHarness({
      requestAction: vi.fn(async () => {
        throw conflict
      }),
    })
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run(mapping.allocationId)).rejects.toBe(conflict)
    expect(deps.recoverAllocation).not.toHaveBeenCalled()
    expect(deps.readReceipt).toHaveBeenCalledWith({
      networkId: mapping.networkId,
      owner: mapping.owner,
      executionId: mapping.executionId,
      allocationId: mapping.allocationId,
    })
    expect(deps.onProjection).toHaveBeenCalledWith(
      mapping.allocationId,
      expect.objectContaining({ version: recovered.version })
    )
  })

  it('drops every post-await UI callback when the active-account epoch changes', async () => {
    const switched = Object.freeze({ ...ACCOUNT, address: 'GOTHER', epoch: 2 })
    let current = ACCOUNT
    const { mapping, claim, deps } = runnerHarness({
      getActiveAccount: vi.fn(() => current),
      requestAction: vi.fn(async () => {
        current = switched
        return claim
      }),
    })
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run(mapping.allocationId)).rejects.toMatchObject({
      code: 'ACTIVE_ACCOUNT_CHANGED',
    })
    expect(deps.recoverAllocation).not.toHaveBeenCalled()
    expect(deps.readReceipt).not.toHaveBeenCalled()
    expect(deps.onProjection).not.toHaveBeenCalled()
    expect(deps.onError).not.toHaveBeenCalled()
    expect(deps.onPending.mock.calls).toEqual([[mapping.allocationId, true]])
  })

  it('lets a normal resolved mandatory reread publish newer completion over its stale poll error', async () => {
    const harness = runnerHarness()
    const { mapping, deps } = harness
    useProducedClaim(harness, { receipt: producedPullPoll(), version: 3, phase: 'pull' })
    const completed = row(producedComplete(), 4)
    const error = pollProofError(
      'RECOVERY_POLL_TX_HASH_REQUIRED',
      'pull',
      'The old poll evidence had no hash.'
    )
    deps.recoverAllocation.mockResolvedValue({ ...completed, error })
    const runner = createRecoveryActionRunner(deps)

    await runner.run(mapping.allocationId)

    expect(deps.onProjection).toHaveBeenLastCalledWith(
      mapping.allocationId,
      expect.objectContaining({
        action: 'complete',
        phase: null,
        reasonCode: 'deposit-confirmed',
        receipt: completed.receipt,
        version: completed.version,
      })
    )
  })

  it.each([
    [
      'manual-review',
      () =>
        producedReceipt({
          initialCustody: { location: 'unknown', reason: 'pre-movement evidence unavailable' },
        }),
    ],
    [
      'blocked-reconcile',
      () =>
        appendPhase(producedReceipt(), {
          attemptId: 'base-evidence',
          phase: 'cctp_burn',
          status: 'submitted',
          evidence: { txHash: 'HBASE' },
          observedAt: 3,
        }),
    ],
  ])(
    'lets a newer authoritative %s state win over a stale poll error',
    async (action, makeReceipt) => {
      const harness = runnerHarness()
      const { mapping, deps } = harness
      useProducedClaim(harness, { receipt: producedPullPoll(), version: 3, phase: 'pull' })
      const current = row(makeReceipt(), 4)
      deps.recoverAllocation.mockResolvedValue({
        ...current,
        error: pollProofError('RECOVERY_POLL_TX_HASH_REQUIRED', 'pull'),
      })
      const runner = createRecoveryActionRunner(deps)

      await runner.run(mapping.allocationId)

      expect(deps.onProjection).toHaveBeenLastCalledWith(
        mapping.allocationId,
        expect.objectContaining({ action, receipt: current.receipt, version: current.version })
      )
    }
  )

  it.each([
    ['absent', { receipt: null, version: 0 }],
    ['lower', row(producedReceipt(), 2)],
    ['same-version drift', row(producedReceipt(), 3)],
  ])('keeps the known claim disabled when the fallback reread is %s', async (_case, reread) => {
    const harness = runnerHarness()
    const { mapping, claim, deps } = harness
    useProducedClaim(harness, { receipt: producedPullPoll(), version: 3, phase: 'pull' })
    const primary = pollProofError('RECOVERY_POLL_TX_HASH_REQUIRED', 'pull')
    const aggregate = aggregatePollError(primary)
    deps.recoverAllocation.mockRejectedValue(aggregate)
    deps.readReceipt.mockResolvedValue(reread)
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run(mapping.allocationId)).rejects.toBe(aggregate)

    const next = deps.onProjection.mock.calls.at(-1)[1]
    expect(next).toMatchObject({
      action: 'manual-review',
      phase: 'pull',
      reasonCode: 'RECOVERY_POLL_TX_HASH_REQUIRED',
      receipt: claim.receipt,
      version: claim.version,
    })
  })

  it('keeps the claim disabled when a normal resolved result is non-monotonic even without an error', async () => {
    const harness = runnerHarness()
    const { mapping, claim, deps } = harness
    useProducedClaim(harness, {
      receipt: producedPullPoll({ txHash: 'HPULL' }),
      version: 3,
      phase: 'pull',
    })
    deps.recoverAllocation.mockResolvedValue({ receipt: null, version: 0 })
    const runner = createRecoveryActionRunner(deps)

    await runner.run(mapping.allocationId)

    expect(deps.onProjection).toHaveBeenLastCalledWith(
      mapping.allocationId,
      expect.objectContaining({
        action: 'manual-review',
        phase: 'pull',
        reasonCode: 'RECOVERY_RECEIPT_CHANGED',
        receipt: claim.receipt,
        version: claim.version,
      })
    )
  })

  it('disables a newer different-phase poll from the current phase proof, not the stale error', async () => {
    const harness = runnerHarness()
    const { mapping, deps } = harness
    useProducedClaim(harness, { receipt: producedPullPoll(), version: 3, phase: 'pull' })
    const aggregate = aggregatePollError(
      pollProofError('RECOVERY_POLL_TX_HASH_REQUIRED', 'pull', 'The old pull lacked a hash.')
    )
    const newerDeposit = row(producedDepositPoll({ txHash: 'HDEPOSIT' }), 4)
    deps.recoverAllocation.mockRejectedValue(aggregate)
    deps.readReceipt.mockResolvedValue(newerDeposit)
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run(mapping.allocationId)).rejects.toBe(aggregate)

    expect(deps.onProjection).toHaveBeenLastCalledWith(
      mapping.allocationId,
      expect.objectContaining({
        action: 'manual-review',
        phase: 'stellar_deposit',
        reasonCode: 'RECOVERY_POLL_SHARE_BASELINE_REQUIRED',
        receipt: newerDeposit.receipt,
        version: newerDeposit.version,
      })
    )
  })

  it('enables a newer same-phase poll once the current receipt has real proof', async () => {
    const harness = runnerHarness()
    const { mapping, deps } = harness
    useProducedClaim(harness, { receipt: producedPullPoll(), version: 3, phase: 'pull' })
    const aggregate = aggregatePollError(pollProofError('RECOVERY_POLL_TX_HASH_REQUIRED', 'pull'))
    const newerPull = row(producedPullPoll({ txHash: 'HPULL' }), 4)
    deps.recoverAllocation.mockRejectedValue(aggregate)
    deps.readReceipt.mockResolvedValue(newerPull)
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run(mapping.allocationId)).rejects.toBe(aggregate)

    expect(deps.onProjection).toHaveBeenLastCalledWith(
      mapping.allocationId,
      expect.objectContaining({
        action: 'poll',
        phase: 'pull',
        reasonCode: 'pull-v2-uncertain',
        receipt: newerPull.receipt,
        version: newerPull.version,
      })
    )
  })

  it.each([
    [
      'pull',
      () =>
        appendPhase(producedReceipt(), {
          attemptId: 'pull-failed',
          phase: 'pull',
          status: 'failed',
          evidence: { reason: 'proved pre-movement failure' },
          observedAt: 3,
        }),
    ],
    ['deposit', producedAgentCustody],
  ])('lets a safe newer %s action win over the stale poll error', async (action, makeReceipt) => {
    const harness = runnerHarness()
    const { mapping, deps } = harness
    useProducedClaim(harness, { receipt: producedPullPoll(), version: 3, phase: 'pull' })
    const aggregate = aggregatePollError(pollProofError('RECOVERY_POLL_TX_HASH_REQUIRED', 'pull'))
    const newer = row(makeReceipt(), 4)
    deps.recoverAllocation.mockRejectedValue(aggregate)
    deps.readReceipt.mockResolvedValue(newer)
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run(mapping.allocationId)).rejects.toBe(aggregate)

    expect(deps.onProjection).toHaveBeenLastCalledWith(
      mapping.allocationId,
      expect.objectContaining({ action, receipt: newer.receipt, version: newer.version })
    )
  })

  it('keeps the real claimed poll disabled when both executor and fallback reads fail', async () => {
    const harness = runnerHarness()
    const { mapping, claim, deps } = harness
    useProducedClaim(harness, {
      receipt: producedDepositPoll({ txHash: 'HDEPOSIT' }),
      version: 3,
      phase: 'stellar_deposit',
    })
    const primary = pollProofError('RECOVERY_POLL_SHARE_BASELINE_REQUIRED', 'stellar_deposit')
    const aggregate = aggregatePollError(primary)
    deps.recoverAllocation.mockRejectedValue(aggregate)
    deps.readReceipt.mockRejectedValue(new Error('fallback reread unavailable'))
    const runner = createRecoveryActionRunner(deps)

    await expect(runner.run(mapping.allocationId)).rejects.toBe(aggregate)

    const next = deps.onProjection.mock.calls.at(-1)[1]
    expect(next).toMatchObject({
      action: 'manual-review',
      phase: 'stellar_deposit',
      reasonCode: 'RECOVERY_POLL_SHARE_BASELINE_REQUIRED',
      receipt: claim.receipt,
      version: claim.version,
    })
    renderRecoveryControl(mapping, next)
    expect(screen.getByRole('button', { name: 'Manual review' }).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Poll' })).toBeNull()
  })
})

describe('createAccountScopedRecoveryConfig', () => {
  it('drops a recovery recorder event that arrives after the captured account epoch changes', () => {
    let current = ACCOUNT
    const onEvent = vi.fn()
    const config = createAccountScopedRecoveryConfig({
      captured: ACCOUNT,
      getCurrent: () => current,
      onEvent,
      sessionId: 'recovery-event-epoch',
    })

    config.onEvent('receipt-before-switch', { allocationId: PLAN.agents[0].allocationId })
    current = Object.freeze({ ...ACCOUNT, epoch: ACCOUNT.epoch + 1 })
    config.onEvent('receipt-after-switch', { allocationId: PLAN.agents[0].allocationId })

    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith('receipt-before-switch', {
      allocationId: PLAN.agents[0].allocationId,
    })
  })
})

describe('Base recovery app controller seams', () => {
  it('projects only the exact identity carried by the failed Task-13 outcome and never synthesizes one', async () => {
    const readEvidence = vi.fn(async ({ identity }) => baseEvidence(identity))
    const projectEvidence = vi.fn((evidence) => baseProjection(evidence.identity))
    const outcome = {
      allocationId: BASE_IDENTITY.allocationId,
      identity: BASE_IDENTITY,
      custody: { location: 'cctp-transit', confirmed: true },
    }

    await expect(
      projectBaseOutcomeRecovery({
        outcome,
        owner: BASE_OWNER,
        readEvidence,
        projectEvidence,
      })
    ).resolves.toEqual({
      key: baseRecoveryIdentityKey(BASE_IDENTITY),
      projection: baseProjection(BASE_IDENTITY),
    })
    expect(readEvidence).toHaveBeenCalledWith({ identity: BASE_IDENTITY, signal: undefined })

    readEvidence.mockClear()
    await expect(
      projectBaseOutcomeRecovery({
        outcome: { allocationId: BASE_IDENTITY.allocationId, custody: outcome.custody },
        owner: BASE_OWNER,
        readEvidence,
        projectEvidence,
      })
    ).resolves.toBeNull()
    expect(readEvidence).not.toHaveBeenCalled()
  })

  it('preserves already-known public Base hashes and Kernel custody when the Agent Index read is unavailable', async () => {
    const burnTxHash = '66'.repeat(32)
    const mintTxHash = `0x${'aa'.repeat(32)}`
    const userOpHash = `0x${'bb'.repeat(32)}`
    const transactionHash = `0x${'cc'.repeat(32)}`

    await expect(
      projectBaseOutcomeRecovery({
        outcome: {
          allocationId: BASE_IDENTITY.allocationId,
          identity: BASE_IDENTITY,
          custody: { location: 'base-kernel', confirmed: true },
          evidence: {
            burnHash: burnTxHash,
            mintTxHash,
            userOpHash,
            depositTxHash: transactionHash,
          },
        },
        owner: BASE_OWNER,
        readEvidence: vi.fn(async () => {
          throw new Error('poisoned capability=must-not-surface')
        }),
      })
    ).resolves.toMatchObject({
      key: baseRecoveryIdentityKey(BASE_IDENTITY),
      projection: {
        action: 'manual-review',
        reasonCode: 'base-evidence-unavailable',
        custody: { location: 'base-kernel', confirmed: true },
        phases: {
          cctp_burn: { evidence: { burnTxHash } },
          cctp_mint: { evidence: { mintTxHash } },
          base_deposit: { evidence: { userOpHash, transactionHash } },
        },
      },
    })
  })

  it('uses the failed outcome identity verbatim and keeps the original bridge credential seam separate from Stellar recovery', async () => {
    const credentialArgs = []
    const stellarRecoverAllocation = vi.fn(() => {
      throw new Error('Stellar recovery must never execute for a Base child.')
    })
    const { deps } = baseRunnerHarness({
      recoverAllocation: stellarRecoverAllocation,
      requestClaim: vi.fn(async (args) => {
        const credential = await args.resolveCredential({
          networkId: args.identity.networkId,
          owner: args.owner,
          agentAddress: args.agentAddress,
        })
        credentialArgs.push({ args, credential })
        return {
          identity: args.identity,
          action: 'submit-mint',
          phase: 'cctp_mint',
          reasonCode: 'base-attestation-confirmed',
          evidenceVersion: args.expectedRecoveryVersion,
          lease: {
            holder: args.leaseOwner,
            leaseToken: '11'.repeat(32),
            expiresAt: 9e15,
          },
        }
      }),
    })
    const runner = createBaseRecoveryActionRunner(deps)

    await expect(runner.run(BASE_IDENTITY)).resolves.toMatchObject({
      identity: BASE_IDENTITY,
      action: 'submit-mint',
    })

    const key = baseRecoveryIdentityKey(BASE_IDENTITY)
    expect(deps.readEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ identity: BASE_IDENTITY })
    )
    expect(deps.requestClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: BASE_IDENTITY,
        owner: BASE_OWNER,
        agentAddress: BASE_AGENT,
        evidence: expect.objectContaining({ identity: BASE_IDENTITY }),
      })
    )
    expect(deps.executeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ claim: expect.objectContaining({ identity: BASE_IDENTITY }) })
    )
    expect(deps.pollEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ identity: BASE_IDENTITY })
    )
    expect(credentialArgs).toHaveLength(1)
    expect(credentialArgs[0].args.identity).toEqual(BASE_IDENTITY)
    expect(credentialArgs[0].args.agentAddress).toBe(BASE_AGENT)
    expect(deps.resolveCredential).toHaveBeenCalledWith({
      networkId: BASE_IDENTITY.networkId,
      owner: BASE_OWNER,
      agentAddress: BASE_AGENT,
    })
    expect(stellarRecoverAllocation).not.toHaveBeenCalled()
    expect(deps.onProjection.mock.calls.every(([publishedKey]) => publishedKey === key)).toBe(true)
  })

  it('keeps same-allocation historical Base children isolated by their complete identity key', async () => {
    const gates = new Map(
      [BASE_IDENTITY, COLLISION_IDENTITY].map((identity) => {
        let release
        const promise = new Promise((resolve) => {
          release = resolve
        })
        return [identity.executionId, { promise, release }]
      })
    )
    const published = new Map()
    const { deps } = baseRunnerHarness({
      requestClaim: vi.fn(async ({ identity }) => {
        await gates.get(identity.executionId).promise
        return {
          identity,
          action: 'submit-mint',
          phase: 'cctp_mint',
          reasonCode: 'base-attestation-confirmed',
          evidenceVersion: 1,
          lease: {
            holder: 'tab-base',
            leaseToken: '11'.repeat(32),
            expiresAt: 9e15,
          },
        }
      }),
      executeRecovery: vi.fn(async ({ claim }) => ({
        accepted: true,
        workId: claim.identity.childId.padEnd(64, '0'),
        identity: claim.identity,
        action: claim.action,
        evidenceVersion: 1,
        status: 'pending',
      })),
      onProjection: vi.fn((key, projection) => published.set(key, projection)),
    })
    const runner = createBaseRecoveryActionRunner(deps)

    const first = runner.run(BASE_IDENTITY)
    const second = runner.run(COLLISION_IDENTITY)
    expect(first).not.toBe(second)
    await waitFor(() => expect(deps.requestClaim).toHaveBeenCalledTimes(2))
    gates.get(BASE_IDENTITY.executionId).release()
    gates.get(COLLISION_IDENTITY.executionId).release()
    await Promise.all([first, second])

    const firstKey = baseRecoveryIdentityKey(BASE_IDENTITY)
    const secondKey = baseRecoveryIdentityKey(COLLISION_IDENTITY)
    expect(firstKey).not.toBe(secondKey)
    expect(published).toHaveProperty('size', 2)
    expect(published.get(firstKey).identity).toEqual(BASE_IDENTITY)
    expect(published.get(secondKey).identity).toEqual(COLLISION_IDENTITY)
    expect(deps.onPending.mock.calls).toEqual(
      expect.arrayContaining([
        [firstKey, true],
        [secondKey, true],
        [firstKey, false],
        [secondKey, false],
      ])
    )
  })

  it('suppresses Base projections, errors, and pending cleanup after an account epoch switch', async () => {
    let releaseRead
    const readBarrier = new Promise((resolve) => {
      releaseRead = resolve
    })
    const { active, deps } = baseRunnerHarness({
      readEvidence: vi.fn(async ({ identity }) => {
        await readBarrier
        return baseEvidence(identity)
      }),
    })
    const runner = createBaseRecoveryActionRunner(deps)
    const pending = runner.run(BASE_IDENTITY)
    await Promise.resolve()
    active.epoch = 2
    releaseRead()

    await expect(pending).rejects.toMatchObject({ code: 'active-account-changed' })
    expect(deps.onProjection).not.toHaveBeenCalled()
    expect(deps.onError).not.toHaveBeenCalled()
    expect(deps.onPending.mock.calls).toEqual([[baseRecoveryIdentityKey(BASE_IDENTITY), true]])
    expect(deps.requestClaim).not.toHaveBeenCalled()
    expect(deps.executeRecovery).not.toHaveBeenCalled()
  })

  it('passes the exact Base child identity from a failed receipt row to StartStage callback props', () => {
    const plan = {
      runId: 'historical-run',
      planFingerprint: 'BASE-APP-RECOVERY',
      amount: { token: 'USDC', units: '1000000', decimals: 6 },
      agents: [
        {
          allocationId: 'historical-run:bridge:base',
          kind: 'bridge',
          hostNetworkId: 'stellar-testnet',
          allocation: { token: 'USDC', units: '1000000', decimals: 6 },
          cap: { token: 'USDC', units: '1000000', decimals: 6 },
          periodSeconds: 3600,
          expiry: 2_000_000_000,
          destination: 'Base Sepolia bridge',
          children: [
            {
              allocationId: BASE_IDENTITY.allocationId,
              proxyTarget: 'aave-v3',
              destination: 'aave-v3',
              allocation: { token: 'USDC', units: '1000000', decimals: 6 },
            },
          ],
        },
      ],
      truth: { agentIsolationCount: 1, stellarVenueCount: 1, baseUsesProxyVaults: true },
    }
    const outcome = {
      allocationId: BASE_IDENTITY.allocationId,
      identity: BASE_IDENTITY,
      amount: { token: 'USDC', units: '1000000', decimals: 6 },
      networkContext: {
        executionNetwork: 'stellar-testnet',
        destinationNetwork: 'base-sepolia',
        currentCustodyNetwork: 'base-sepolia',
        transit: false,
      },
      executionStatus: 'failed',
      custody: { location: 'base-kernel', confirmed: true, checkedAt: 1 },
      txHash: null,
      error: 'Base deposit needs recovery.',
      evidence: { allocationId: BASE_IDENTITY.allocationId },
    }
    const receipt = {
      version: 1,
      runId: plan.runId,
      planFingerprint: plan.planFingerprint,
      permission: {
        mode: 'fresh',
        status: 'confirmed',
        confirmationCount: 1,
        txHash: 'HGRANT',
        grantReceiptFingerprint: 'FP',
        expiryLedger: 9_001,
        agentAddresses: ['CBRIDGE'],
      },
      branches: {
        stellar: { status: 'not-planned', results: [] },
        base: { status: 'failed', results: [outcome] },
      },
      allocations: [outcome],
    }
    const onRecoverAllocation = vi.fn()
    const onRecoverBaseChild = vi.fn()
    const key = baseRecoveryIdentityKey(BASE_IDENTITY)

    render(
      <_StartStage
        plan={plan}
        permission={receipt.permission}
        receipt={receipt}
        baseRecoveryByIdentity={{
          [key]: baseProjection(BASE_IDENTITY, { action: 'submit-mint', version: 7 }),
        }}
        baseRecoveryPendingIdentities={new Set()}
        onRecoverAllocation={onRecoverAllocation}
        onRecoverBaseChild={onRecoverBaseChild}
      />
    )

    const button = screen.getByRole('button', { name: 'Resume transfer to Base' })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onRecoverBaseChild).toHaveBeenCalledOnce()
    expect(onRecoverBaseChild).toHaveBeenCalledWith(BASE_IDENTITY)
    expect(onRecoverAllocation).not.toHaveBeenCalled()
  })
})
