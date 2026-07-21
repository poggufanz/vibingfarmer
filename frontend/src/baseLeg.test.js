import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeBaseLeg } from './baseLeg.js'

// Repo pattern (mirrors wallet/passkeyBridge.test.js): vitest's default environment here is
// 'node', which has no global localStorage. Stub it with a plain object-backed fake.
const store = {}
beforeEach(() => {
  for (const k in store) delete store[k]
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = v
    },
    removeItem: (k) => {
      delete store[k]
    },
  }
})

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
  // No stored mandate in most tests below -> readStoredMandate() short-circuits before this is
  // ever called, but every dep is stubbed so nothing accidentally reaches a real fetch.
  getMandateStatus: vi.fn().mockResolvedValue({ valid: false }),
  makePublicClient: vi.fn(() => ({})),
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

  it('ceremony run requests a 7-day mandate window, posts expiry through, and writes vf_base_mandate with NO private key', async () => {
    const deps = okDeps()
    const before = Math.floor(Date.now() / 1000)
    await executeBaseLeg({
      connectedAddress: 'GUSER',
      signTx: vi.fn(),
      baseVaults,
      totalAmount: 100,
      onEvent: vi.fn(),
      deps,
    })

    // createMandate is asked for a 7-day window (MANDATE_WINDOW_SECONDS), not the old 1-hour TTL.
    const createArgs = deps.createMandate.mock.calls[0][0]
    expect(createArgs.expiry).toBeGreaterThanOrEqual(before + 7 * 24 * 3600)
    expect(createArgs.expiry).toBeLessThanOrEqual(before + 7 * 24 * 3600 + 5) // runtime slack

    // postMandate forwards the mandate's own (mocked) expiry through to the relayer.
    expect(deps.postMandate).toHaveBeenCalledWith(expect.objectContaining({ expiry: 9999999999 }))

    const stored = JSON.parse(localStorage.getItem('vf_base_mandate'))
    expect(stored).toEqual({
      serializedApproval: 'APPROVAL',
      sessionKeyAddress: '0xSESSION',
      kernelAddress: '0xOWNER',
      expiry: 9999999999,
    })
    // Binding constraint: the persisted record must never contain the session private key.
    expect(localStorage.getItem('vf_base_mandate')).not.toContain('0xPRIV')
  })

  it('reuse: a valid stored mandate skips ensureBaseOwner + createMandate + postMandate entirely (zero ceremony)', async () => {
    const deps = okDeps()
    deps.getMandateStatus = vi.fn().mockResolvedValue({ valid: true, expiresAt: 9999999999000 })
    localStorage.setItem(
      'vf_base_mandate',
      JSON.stringify({
        serializedApproval: 'STORED-APPROVAL',
        sessionKeyAddress: '0xSTOREDSESSION',
        kernelAddress: '0xSTOREDOWNER',
        expiry: 9999999999,
      })
    )

    const out = await executeBaseLeg({
      connectedAddress: 'GUSER',
      signTx: vi.fn(),
      baseVaults,
      totalAmount: 100,
      onEvent: vi.fn(),
      deps,
    })

    expect(deps.ensureBaseOwner).not.toHaveBeenCalled()
    expect(deps.createMandate).not.toHaveBeenCalled()
    expect(deps.postMandate).not.toHaveBeenCalled()
    expect(deps.getMandateStatus).toHaveBeenCalledWith('STORED-APPROVAL')
    expect(out).toMatchObject({ success: true, baseAccount: '0xSTOREDOWNER' })

    const farmArgs = deps.runFarmFlow.mock.calls[0][0]
    expect(farmArgs.serializedApproval).toBe('STORED-APPROVAL')
    expect(farmArgs.sessionKeyAddress).toBe('0xSTOREDSESSION')
    expect(farmArgs.baseRecipientAddress).toBe('0xSTOREDOWNER')
  })

  it('a stored mandate the relayer reports invalid falls back to the full ceremony', async () => {
    const deps = okDeps()
    deps.getMandateStatus = vi.fn().mockResolvedValue({ valid: false })
    localStorage.setItem(
      'vf_base_mandate',
      JSON.stringify({
        serializedApproval: 'STALE-APPROVAL',
        sessionKeyAddress: '0xSTALESESSION',
        kernelAddress: '0xSTALEOWNER',
        expiry: 1,
      })
    )

    const out = await executeBaseLeg({
      connectedAddress: 'GUSER',
      signTx: vi.fn(),
      baseVaults,
      totalAmount: 100,
      onEvent: vi.fn(),
      deps,
    })

    expect(deps.ensureBaseOwner).toHaveBeenCalledTimes(1)
    expect(deps.createMandate).toHaveBeenCalledTimes(1)
    expect(deps.postMandate).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ success: true, baseAccount: '0xOWNER' }) // fresh ceremony owner, not the stale one
  })
})
