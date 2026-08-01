// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { buildRecoveryAllocationMappings, createRecoveryActionRunner } from './app.jsx'

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
})
