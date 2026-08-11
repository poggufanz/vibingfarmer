import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from './stellar/config.js'

const fakes = vi.hoisted(() => ({
  buildMergedCatalog: vi.fn(),
  loadSettings: vi.fn(),
  runStrategyFetchDag: vi.fn(),
  saveReasoning: vi.fn(),
  saveStrategy: vi.fn(),
}))

vi.mock('./history.js', () => ({
  saveReasoning: (...args) => fakes.saveReasoning(...args),
  saveStrategy: (...args) => fakes.saveStrategy(...args),
}))
vi.mock('./settingsStore.js', () => ({
  loadSettings: () => fakes.loadSettings(),
}))
vi.mock('./strategy/fetchDag.js', () => ({
  runStrategyFetchDag: (...args) => fakes.runStrategyFetchDag(...args),
}))
vi.mock('./strategy/mergedCatalog.js', () => ({
  buildMergedCatalog: (...args) => fakes.buildMergedCatalog(...args),
}))

import { generateStrategy } from './strategist.js'

const liveApy = 6.2
const sharedAddress = SOROBAN_ACTIVE_VAULT_ADDRESS

const liveVenue = (over = {}) => ({
  address: sharedAddress,
  protocol: 'blend-usdc',
  name: 'Autofarm to Blend',
  risk: 'low',
  yield_source: 'lending',
  apy: 4.8,
  venueKind: 'stellar-live',
  chain: 'stellar',
  yield: { state: 'live', apy: liveApy, asOf: Date.now() },
  ...over,
})

const aiSelection = (over = {}) => ({
  strategy_summary: 'Reliable allocation',
  rationale: 'Use the matched execution venue',
  selected_vaults: [
    {
      address: sharedAddress,
      protocol: 'blend-usdc',
      name: 'Autofarm to Blend',
      reasoning: 'The matched venue reports a current measured yield.',
      expected_apy: 99.9,
      allocation: 1,
      risk_tier: 'low',
      ...over,
    },
  ],
})

function prepareStrategy(vaultData, response = aiSelection()) {
  fakes.loadSettings.mockReturnValue({
    vaultDataSource: 'live',
    marketContext: false,
    modelPreference: 'auto',
    veniceApiKey: '',
    deepseekApiKey: '',
  })
  fakes.runStrategyFetchDag.mockResolvedValue({
    skill: {
      content: 'Recommend from [VAULT_CATALOG_JSON]. Respond in JSON only.',
      source: 'test',
    },
    pools: vaultData,
    gas: { gwei: 0, level: 'normal' },
    positions: null,
    marketContext: null,
    signals: { turbulence: 'calm', signals: [] },
    timings: {},
    wallMs: 0,
  })
  fakes.buildMergedCatalog.mockReturnValue(vaultData)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(response) } }],
      }),
    }))
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generateStrategy yield provenance', () => {
  it('persists the matched live APY instead of the model-provided expected_apy', async () => {
    const vaultData = [liveVenue()]
    prepareStrategy(vaultData)

    await generateStrategy({ amount: 100, riskLevel: 'low', numVaults: 1 })

    const strategy = fakes.saveStrategy.mock.calls[0][0]
    const reasoning = fakes.saveReasoning.mock.calls[0][0]
    expect(strategy.yieldEvidence).toBe('live-venue')
    expect(strategy.vaultsSelected[0].apy).toBe(liveApy)
    expect(Number(strategy.blendedApy)).toBeCloseTo(liveApy, 6)
    expect(reasoning.expectedApy).toBe(liveApy)
    expect(reasoning.yieldEvidence).toBe('live-venue')
    expect(strategy.vaultsSelected[0].apy).not.toBe(99.9)
  })

  it('matches by protocol as well as shared address for reference rows', async () => {
    const vaultData = [liveVenue({ protocol: 'reference-market', yield: undefined }), liveVenue()]
    prepareStrategy(vaultData)

    await generateStrategy({ amount: 100, riskLevel: 'low', numVaults: 1 })

    const strategy = fakes.saveStrategy.mock.calls[0][0]
    const reasoning = fakes.saveReasoning.mock.calls[0][0]
    expect(strategy.yieldEvidence).toBe('live-venue')
    expect(strategy.vaultsSelected[0].apy).toBe(liveApy)
    expect(reasoning.expectedApy).toBe(liveApy)
  })
})
