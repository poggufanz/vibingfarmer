import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeBaseLeg } from './baseLeg.js'

const KERNEL = '0x0000000000000000000000000000000000000AA1'
const BRIDGE_AGENT = 'CBRIDGEAGENT'

const storedMandate = () => ({
  serializedApproval: 'APPROVAL',
  sessionKeyAddress: '0xSESSION',
  kernelAddress: KERNEL,
  expiry: 9999999999,
})

const okDeps = () => ({
  readStoredMandate: vi.fn(() => storedMandate()),
  getMandateStatus: vi.fn().mockResolvedValue({ valid: true }),
  makePublicClient: vi.fn(() => ({})),
  runFarmFlow: vi.fn().mockResolvedValue({ burnHash: 'BURN', jobId: 'job-1', finalStatus: 'done' }),
  estimateMinShares: vi.fn(async () => 98505000n),
  runAgentPull: vi.fn().mockResolvedValue({ hash: 'HPULL', status: 'SUCCESS' }),
  runAgentBurn: vi.fn().mockResolvedValue({ burnHash: 'HBURNAGENT' }),
})

const baseVaults = [
  { address: '0x389250872044368759D3db5C09b2706A6628d4e0', allocation: 1, expected_apy: 5.1 },
]

const run = (overrides = {}) =>
  executeBaseLeg({
    connectedAddress: 'GUSER',
    bridgeAgentAddress: BRIDGE_AGENT,
    bridgeSessionKey: { rawPublicKey: new Uint8Array(32).fill(7), sign: vi.fn() },
    kernelAddress: KERNEL,
    baseVaults,
    totalAmount: 100,
    onEvent: vi.fn(),
    deps: okDeps(),
    ...overrides,
  })

describe('executeBaseLeg — grant-covered burn (Task 7 rework: no ceremony, no second grant)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('happy path: re-validates the stored mandate, quotes, pulls + burns via the bridge agent session key', async () => {
    const deps = okDeps()
    const out = await run({ deps })
    expect(out).toMatchObject({
      success: true,
      burnHash: 'BURN',
      jobId: 'job-1',
      finalStatus: 'done',
      baseAccount: KERNEL,
    })
    expect(deps.getMandateStatus).toHaveBeenCalledWith('APPROVAL')
  })

  it('never calls ensureBaseOwner/createMandate/postMandate — those deps no longer exist on this function', async () => {
    // Regression guard: passing them (as if the old ceremony API still applied) must be silently
    // ignored, not wired to anything — proves the ceremony branch is gone, not just unused.
    const ensureBaseOwner = vi.fn()
    const createMandate = vi.fn()
    const postMandate = vi.fn()
    const deps = { ...okDeps(), ensureBaseOwner, createMandate, postMandate }
    await run({ deps })
    expect(ensureBaseOwner).not.toHaveBeenCalled()
    expect(createMandate).not.toHaveBeenCalled()
    expect(postMandate).not.toHaveBeenCalled()
  })

  it('no bridgeAgentAddress -> settled failure at stage "mandate", never throws', async () => {
    const out = await run({ bridgeAgentAddress: null })
    expect(out).toMatchObject({ success: false, stage: 'mandate' })
    expect(out.error).toMatch(/bridge agent/i)
  })

  it('no kernelAddress -> settled failure at stage "mandate", never throws', async () => {
    const out = await run({ kernelAddress: null })
    expect(out).toMatchObject({ success: false, stage: 'mandate' })
    expect(out.error).toMatch(/kernel address/i)
  })

  it('no stored mandate -> settled failure (mandate setup is its own ceremony, not run here)', async () => {
    const deps = okDeps()
    deps.readStoredMandate.mockReturnValue(null)
    const out = await run({ deps })
    expect(out).toMatchObject({ success: false, stage: 'mandate' })
    expect(out.error).toMatch(/no durable base mandate/i)
    expect(deps.getMandateStatus).not.toHaveBeenCalled()
    expect(deps.runFarmFlow).not.toHaveBeenCalled()
  })

  it('a stored-but-invalid mandate (TOCTOU: valid at strategy-generation time, revoked since) settles, never throws', async () => {
    const deps = okDeps()
    deps.getMandateStatus.mockResolvedValue({ valid: false })
    const out = await run({ deps })
    expect(out).toMatchObject({ success: false, stage: 'mandate' })
    expect(out.error).toMatch(/no longer valid/i)
  })

  it('a getMandateStatus rejection (relayer blip) degrades to invalid, never throws', async () => {
    const deps = okDeps()
    deps.getMandateStatus.mockRejectedValue(new Error('relayer timeout'))
    const out = await run({ deps })
    expect(out).toMatchObject({ success: false, stage: 'mandate' })
  })

  it('minShares comes from the live quote, not a hardcoded 1n', async () => {
    const deps = okDeps()
    await run({ deps })
    expect(deps.estimateMinShares).toHaveBeenCalledWith({
      pool: baseVaults[0].address,
      amountBaseUnits: expect.any(BigInt),
      publicClient: expect.objectContaining({}),
    })
  })

  it('a rejecting quote settles { success:false, stage:"mandate" }, never throws, and never reaches the farm step', async () => {
    const deps = okDeps()
    deps.estimateMinShares.mockRejectedValue(new Error('rpc down'))
    const out = await run({ deps })
    expect(out).toMatchObject({ success: false, stage: 'mandate' })
    expect(deps.runFarmFlow).not.toHaveBeenCalled()
  })

  it('the injected burn dep pulls funds to the bridge agent THEN burns, both via the session key', async () => {
    const deps = okDeps()
    let burnDep
    deps.runFarmFlow = vi.fn(async ({ deps: farmDeps }) => {
      burnDep = farmDeps.burn
      const out = await burnDep({ amountUnits: 12_345_670n })
      return { burnHash: out.burnHash, jobId: 'job-x', finalStatus: 'done' }
    })
    const sessionKey = { rawPublicKey: new Uint8Array(32).fill(9), sign: vi.fn() }
    const out = await run({ deps, bridgeSessionKey: sessionKey })

    expect(deps.runAgentPull).toHaveBeenCalledTimes(1)
    expect(deps.runAgentPull).toHaveBeenCalledWith({
      agentAddress: BRIDGE_AGENT,
      amount: 12_345_670n,
      sessionKey,
    })
    expect(deps.runAgentBurn).toHaveBeenCalledTimes(1)
    expect(deps.runAgentBurn).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeAgentAddress: BRIDGE_AGENT,
        amountUnits: 12_345_670n,
        sessionKey,
      })
    )
    const pullOrder = deps.runAgentPull.mock.invocationCallOrder[0]
    const burnOrder = deps.runAgentBurn.mock.invocationCallOrder[0]
    expect(pullOrder).toBeLessThan(burnOrder)
    expect(out.burnHash).toBe('HBURNAGENT')
  })

  it('mint_recipient is derived from the THREADED kernelAddress param, never re-read from storage (IMPORTANT 2 fix)', async () => {
    const deps = okDeps()
    // The stored mandate carries a DIFFERENT kernelAddress than the param — proves the burn arg
    // follows the caller's param (the value orchestrator.js actually pinned on-chain at grant
    // time), not whatever happens to be in storage right now (a mid-run rotation risk otherwise).
    const staleKernel = '0x0000000000000000000000000000000000000BB2'
    deps.readStoredMandate = vi.fn(() => ({ ...storedMandate(), kernelAddress: staleKernel }))
    let burnArgs
    deps.runAgentBurn = vi.fn(async (args) => {
      burnArgs = args
      return { burnHash: 'H' }
    })
    deps.runFarmFlow = vi.fn(async ({ deps: farmDeps }) => {
      await farmDeps.burn({ amountUnits: 1_000_000n })
      return { burnHash: 'H', jobId: 'j', finalStatus: 'done' }
    })
    const out = await run({ deps, kernelAddress: KERNEL })
    expect(Buffer.from(burnArgs.mintRecipient).toString('hex').slice(-40)).toBe(
      '0000000000000000000000000000000000000aa1'
    )
    expect(out.baseAccount).toBe(KERNEL) // not staleKernel
  })

  it('a failed relayed pull surfaces as a farm-stage failure, never silently burning zero, and carries NO stranded-funds flag (nothing moved yet)', async () => {
    const deps = okDeps()
    deps.runFarmFlow = vi.fn(async ({ deps: farmDeps }) =>
      farmDeps.burn({ amountUnits: 1_000_000n })
    )
    deps.runAgentPull.mockResolvedValue(null) // relay unavailable
    const out = await run({ deps })
    expect(out).toMatchObject({ success: false, stage: 'farm' })
    expect(out.error).toMatch(/relay is unavailable/)
    expect(deps.runAgentBurn).not.toHaveBeenCalled()
    expect(out.pulled).toBeUndefined()
    expect(out.bridgeAgentAddress).toBeUndefined()
  })

  it('pull-ok/burn-fails (stranded funds): the failure payload carries pulled:true + bridgeAgentAddress as the recovery handle, in BOTH the event and the return value', async () => {
    const deps = okDeps()
    deps.runFarmFlow = vi.fn(async ({ deps: farmDeps }) =>
      farmDeps.burn({ amountUnits: 1_000_000n })
    )
    deps.runAgentBurn.mockRejectedValue(new Error('burn tx rejected'))
    const events = []
    const onEvent = (name, data) => events.push({ name, data })
    const out = await run({ deps, onEvent })

    expect(out).toMatchObject({
      success: false,
      stage: 'burn',
      error: 'burn tx rejected',
      pulled: true,
      bridgeAgentAddress: BRIDGE_AGENT,
    })
    const failedEvent = events.find((e) => e.name === 'baseleg-failed')
    expect(failedEvent.data).toMatchObject({
      stage: 'burn',
      pulled: true,
      bridgeAgentAddress: BRIDGE_AGENT,
    })
  })

  it('farm failure is settled, not thrown', async () => {
    const deps = okDeps()
    deps.runFarmFlow.mockRejectedValue(new Error('relayer down'))
    const out = await run({ deps })
    expect(out).toMatchObject({ success: false, stage: 'farm' })
  })

  it('non-Error rejection (bare string) settles, never rejects', async () => {
    const deps = okDeps()
    deps.runFarmFlow.mockRejectedValue('relayer declined')
    await expect(run({ deps })).resolves.toMatchObject({
      success: false,
      stage: 'farm',
      error: 'relayer declined',
    })
  })
})
