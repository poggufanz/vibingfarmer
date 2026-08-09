import { describe, expect, it, vi } from 'vitest'
import { executeBaseLeg } from './baseLeg.js'
import { runFarmFlow } from './crossChainFarm.js'
import {
  applyBaseLegOutcome,
  needsBaseMandateSetup,
  resolveBaseAvailability,
  setupBaseMandate,
} from './mergeFlowHelpers.js'
import { postFarm, postFarmAttach, postMandate, postUnwind } from './base/relayerClient.js'

describe('legacy Base deployment global execution fence', () => {
  it('settles the Base leg unavailable before mandate reads, quotes, pulls, or burns', async () => {
    const deps = {
      readStoredMandate: vi.fn(),
      makePublicClient: vi.fn(),
      estimateMinShares: vi.fn(),
      runAgentPull: vi.fn(),
      runAgentBurn: vi.fn(),
      runFarmFlow: vi.fn(),
    }

    const result = await executeBaseLeg({ deps })

    expect(result).toMatchObject({ success: false, stage: 'availability' })
    expect(result.custody).toMatchObject({ location: 'owner', confirmed: true })
    Object.values(deps).forEach((dependency) => expect(dependency).not.toHaveBeenCalled())
  })

  it('rejects direct farm orchestration before validation, events, intent, or burn', async () => {
    const onEvent = vi.fn()
    const deps = {
      postFarm: vi.fn(),
      burn: vi.fn(),
      postFarmAttach: vi.fn(),
      pollFarmStatus: vi.fn(),
    }

    await expect(
      runFarmFlow({ burnUnits7: 1, allocations: null, onEvent, deps })
    ).rejects.toMatchObject({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' })
    expect(onEvent).not.toHaveBeenCalled()
    Object.values(deps).forEach((dependency) => expect(dependency).not.toHaveBeenCalled())
  })

  it('blocks mandate setup before owner/passkey, policy construction, registration, or storage', async () => {
    const storage = { setItem: vi.fn(), removeItem: vi.fn(), getItem: vi.fn() }
    const deps = {
      ensureBaseOwner: vi.fn(),
      createMandate: vi.fn(),
      postMandate: vi.fn(),
      waitForMandateActivation: vi.fn(),
      storage,
    }

    await expect(setupBaseMandate({ connectedAddress: 'GOWNER', deps })).rejects.toMatchObject({
      code: 'BASE_CROSS_CHAIN_UNAVAILABLE',
    })
    expect(deps.ensureBaseOwner).not.toHaveBeenCalled()
    expect(deps.createMandate).not.toHaveBeenCalled()
    expect(deps.postMandate).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('hard-disables strategy eligibility and mandate setup without probing health', async () => {
    const health = vi.fn().mockResolvedValue(true)
    const result = resolveBaseAvailability({
      health,
      connection: { connected: true },
      mandate: { status: 'active' },
    })

    await expect(result.baseAvailable).resolves.toBe(false)
    expect(health).not.toHaveBeenCalled()
    expect(needsBaseMandateSetup({ healthy: true, mandateOk: false })).toBe(false)
  })

  it('blocks successful-outcome recovery writes while preserving a safe status result', () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
    const result = applyBaseLegOutcome(
      { success: true, baseAccount: '0xunsafe', finalStatus: 'done', jobId: 'job-1' },
      { storage, stellarOwner: 'GOWNER' }
    )

    expect(result).toMatchObject({ event: 'AgentFailed' })
    expect(result.meta).toMatch(/unavailable/i)
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it.each([
    ['farm', postFarm],
    ['farm attach', postFarmAttach],
    ['mandate', postMandate],
    ['unwind', postUnwind],
  ])('blocks the low-level %s client before validation or fetch', async (_name, client) => {
    const fetchImpl = vi.fn()
    await expect(client({ deps: { fetchImpl } })).rejects.toMatchObject({
      code: 'BASE_CROSS_CHAIN_UNAVAILABLE',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
