// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  buildRecoveryAllocationMappings,
  createAccountScopedRecoveryConfig,
  createRecoveryActionRunner,
} from './app.jsx'
import { StartStage as _StartStage } from './components/strategy/StartStage.jsx'
import { projectRecoveryReceipt } from './strategy/receiptProjection.js'
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
