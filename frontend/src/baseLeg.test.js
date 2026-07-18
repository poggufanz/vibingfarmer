import { describe, it, expect, vi } from 'vitest'
import { executeBaseLeg } from './baseLeg.js'

const okDeps = () => ({
  ensureBaseOwner: vi.fn().mockResolvedValue({
    address: '0xOWNER',
    kernelAccount: {},
    publicClient: {},
    passkeyValidator: {},
    ownerMode: 'ceremony',
  }),
  createMandate: vi.fn().mockResolvedValue({
    serializedApproval: 'APPROVAL',
    sessionKeyAddress: '0xSESSION',
    sessionPrivateKey: '0xPRIV',
    expiry: 9999999999,
  }),
  postMandate: vi.fn().mockResolvedValue({ ok: true }),
  runFarmFlow: vi.fn().mockResolvedValue({ burnHash: 'BURN', jobId: 'job-1', finalStatus: 'done' }),
  estimateMinShares: vi.fn(async () => 98505000n),
})

describe('executeBaseLeg', () => {
  const baseVaults = [
    { address: '0x389250872044368759D3db5C09b2706A6628d4e0', allocation: 1, expected_apy: 5.1 },
  ]
  it('happy path: owner -> mandate -> register -> farm; session key never leaks into the result', async () => {
    const deps = okDeps()
    const out = await executeBaseLeg({
      connectedAddress: 'GUSER',
      signTx: vi.fn(),
      baseVaults,
      totalAmount: 100,
      onEvent: vi.fn(),
      deps,
    })
    expect(out).toMatchObject({ success: true, burnHash: 'BURN', jobId: 'job-1' })
    expect(JSON.stringify(out)).not.toContain('0xPRIV')
    expect(deps.postMandate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPrivateKey: '0xPRIV' })
    )
  })
  it('owner ceremony cancelled -> settled failure at stage owner, nothing downstream runs', async () => {
    const deps = okDeps()
    deps.ensureBaseOwner.mockRejectedValue(new Error('user cancelled'))
    const out = await executeBaseLeg({
      connectedAddress: 'GUSER',
      signTx: vi.fn(),
      baseVaults,
      totalAmount: 100,
      onEvent: vi.fn(),
      deps,
    })
    expect(out).toMatchObject({ success: false, stage: 'owner' })
    expect(deps.createMandate).not.toHaveBeenCalled()
  })
  it('farm failure is settled, not thrown', async () => {
    const deps = okDeps()
    deps.runFarmFlow.mockRejectedValue(new Error('relayer down'))
    const out = await executeBaseLeg({
      connectedAddress: 'GUSER',
      signTx: vi.fn(),
      baseVaults,
      totalAmount: 100,
      onEvent: vi.fn(),
      deps,
    })
    expect(out).toMatchObject({ success: false, stage: 'farm' })
  })
  it('non-Error rejection (bare string, e.g. wallet-extension decline) settles, never rejects', async () => {
    const deps = okDeps()
    deps.ensureBaseOwner.mockRejectedValue('user declined')
    await expect(
      executeBaseLeg({
        connectedAddress: 'GUSER',
        signTx: vi.fn(),
        baseVaults,
        totalAmount: 100,
        onEvent: vi.fn(),
        deps,
      })
    ).resolves.toMatchObject({ success: false, stage: 'owner', error: 'user declined' })
  })
  it('minShares comes from the live quote, not a hardcoded 1n', async () => {
    const deps = okDeps()
    await executeBaseLeg({
      connectedAddress: 'GUSER',
      signTx: vi.fn(),
      baseVaults,
      totalAmount: 100,
      onEvent: vi.fn(),
      deps,
    })
    expect(deps.estimateMinShares).toHaveBeenCalledTimes(1)
    expect(deps.estimateMinShares).toHaveBeenCalledWith({
      pool: baseVaults[0].address,
      amountBaseUnits: expect.any(BigInt),
      publicClient: expect.objectContaining({}),
    })
    const call = deps.runFarmFlow.mock.calls[0][0]
    expect(call.allocations.length).toBeGreaterThan(0)
    for (const a of call.allocations) {
      expect(a.minShares).toBe(98505000n)
    }
  })
  it('a rejecting quote settles { success:false, stage:"mandate" }, never throws, and aborts before mandate submission', async () => {
    const deps = okDeps()
    deps.estimateMinShares.mockRejectedValue(new Error('rpc down'))
    const out = await executeBaseLeg({
      connectedAddress: 'GUSER',
      signTx: vi.fn(),
      baseVaults,
      totalAmount: 100,
      onEvent: vi.fn(),
      deps,
    })
    expect(out).toMatchObject({ success: false, stage: 'mandate' })
    expect(deps.createMandate).not.toHaveBeenCalled()
    expect(deps.postMandate).not.toHaveBeenCalled()
    expect(deps.runFarmFlow).not.toHaveBeenCalled()
  })
})
