import { describe, it, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  validateStrategyResponse,
  validateVeniceResponse,
  askStrategistJson,
  askVeniceJson,
  parseSpecialistVerdict,
  normalizeDisplayProse,
  resolveProvider,
  generateAgentSkills,
  getTokenUsageHistory,
  clearTokenUsageHistory,
} from './strategist.js'
import { AI_PROXY_URL } from './config.js'

const VAULTS = [
  { address: '0xAAAa000000000000000000000000000000000001', name: 'A' },
  { address: '0xBBBb000000000000000000000000000000000002', name: 'B' },
]

const validVault = (over = {}) => ({
  address: VAULTS[0].address,
  reasoning: 'Solid overcollateralized lending with deep liquidity and low drawdown.',
  expected_apy: 4.8,
  allocation: 1.0,
  risk_tier: 'low',
  ...over,
})

describe('validateStrategyResponse', () => {
  it('accepts a well-formed single-vault response', () => {
    const res = {
      strategy_summary: '\u{1f680} robust allocation \u2014 leverage liquidity',
      selected_vaults: [validVault()],
    }
    expect(() => validateStrategyResponse(res, VAULTS)).not.toThrow()
    expect(res.strategy_summary).toBe('Reliable allocation. Use liquidity')
  })

  it('rejects expected_apy of 0', () => {
    const res = { selected_vaults: [validVault({ expected_apy: 0 })] }
    expect(() => validateStrategyResponse(res, VAULTS)).toThrow(/expected_apy/)
  })

  it('rejects expected_apy as a string "N/A"', () => {
    const res = { selected_vaults: [validVault({ expected_apy: 'N/A' })] }
    expect(() => validateStrategyResponse(res, VAULTS)).toThrow(/expected_apy/)
  })

  it('rejects allocation > 1', () => {
    const res = { selected_vaults: [validVault({ allocation: 1.5 })] }
    expect(() => validateStrategyResponse(res, VAULTS)).toThrow(/allocation/)
  })

  it('rejects a missing/invalid risk_tier', () => {
    const res = { selected_vaults: [validVault({ risk_tier: undefined })] }
    expect(() => validateStrategyResponse(res, VAULTS)).toThrow(/risk_tier/)
  })

  it('still rejects a hallucinated address', () => {
    const res = { selected_vaults: [validVault({ address: '0xdead' })] }
    expect(() => validateStrategyResponse(res, VAULTS)).toThrow(/hallucinated/)
  })

  it('deprecated validateVeniceResponse alias matches validateStrategyResponse', () => {
    expect(validateVeniceResponse).toBe(validateStrategyResponse)
  })
})

describe('normalizeDisplayProse', () => {
  it('removes decorative punctuation, emoji, lowercase starts, and common hype', () => {
    expect(
      normalizeDisplayProse('\u{1f680} seamless growth \u2014 leverage yield \u00b7 fast')
    ).toBe('Straightforward growth. Use yield, fast')
  })
})

describe('askStrategistJson aliases', () => {
  it('deprecated askVeniceJson is the same function as askStrategistJson', () => {
    expect(askVeniceJson).toBe(askStrategistJson)
  })
})

describe('resolveProvider (BYOK routing)', () => {
  const isProxy = (p) =>
    p.name === 'deepseek-proxy' && p.url === AI_PROXY_URL && Object.keys(p.headers).length === 0

  it('wallet x402 auth wins over every key and preference', () => {
    const p = resolveProvider({
      veniceAuth: 'siwe-header',
      veniceApiKey: 'vk',
      deepseekApiKey: 'dk',
      modelPreference: 'deepseek',
    })
    expect(p.name).toBe('venice-x402')
    expect(p.headers['X-Sign-In-With-X']).toBe('siwe-header')
    expect(p.isVenice).toBe(true)
  })

  it('auto: prefers the Venice key, then DeepSeek key, then host proxy', () => {
    expect(resolveProvider({ veniceApiKey: 'vk', deepseekApiKey: 'dk' }).name).toBe('venice-key')
    expect(resolveProvider({ deepseekApiKey: 'dk' }).name).toBe('deepseek-ai')
    expect(isProxy(resolveProvider({}))).toBe(true)
  })

  it('auto Venice key carries a Bearer header to the Venice endpoint', () => {
    const p = resolveProvider({ veniceApiKey: 'vk' })
    expect(p.headers.Authorization).toBe('Bearer vk')
    expect(p.isVenice).toBe(true)
  })

  it('venice preference uses the Venice key but never falls to DeepSeek - only host proxy', () => {
    expect(resolveProvider({ veniceApiKey: 'vk', modelPreference: 'venice' }).name).toBe(
      'venice-key'
    )
    // a DeepSeek key present must NOT be used when Venice is forced
    expect(isProxy(resolveProvider({ deepseekApiKey: 'dk', modelPreference: 'venice' }))).toBe(true)
  })

  it('deepseek preference uses the DeepSeek key, else host proxy', () => {
    const p = resolveProvider({ deepseekApiKey: 'dk', modelPreference: 'deepseek' })
    expect(p.name).toBe('deepseek-ai')
    expect(p.headers.Authorization).toBe('Bearer dk')
    expect(isProxy(resolveProvider({ modelPreference: 'deepseek' }))).toBe(true)
  })

  it('never returns null - empty args degrade to the host proxy', () => {
    expect(isProxy(resolveProvider())).toBe(true)
  })
})

describe('parseSpecialistVerdict', () => {
  const allowed = ['yld-apy-attractive', 'yld-projection-positive', 'yld-tvl-adequate']

  it('parses a well-formed verdict and keeps only allowed cited rules', () => {
    const v = parseSpecialistVerdict(
      {
        signal: 'DEPOSIT',
        confidence: 0.82,
        reasoning: 'APY clears target and projection is positive.',
        citedRules: ['yld-apy-attractive', 'rsk-turbulent-veto', 'bogus'],
        concerns: ['thin TVL on vault 2'],
      },
      'yield',
      allowed
    )
    expect(v.role).toBe('yield')
    expect(v.signal).toBe('DEPOSIT')
    expect(v.confidence).toBe(0.82)
    expect(v.citedRules).toEqual(['yld-apy-attractive']) // cross-role + hallucinated dropped
    expect(v.source).toBe('ai')
  })

  it('clamps confidence to [0,1] and uppercases the signal', () => {
    const v = parseSpecialistVerdict(
      { signal: 'deposit', confidence: 2, reasoning: 'x', citedRules: [] },
      'yield',
      allowed
    )
    expect(v.confidence).toBe(1)
    expect(v.signal).toBe('DEPOSIT')
  })

  it('throws on an invalid signal', () => {
    expect(() =>
      parseSpecialistVerdict({ signal: 'BUY', confidence: 0.5, reasoning: 'x' }, 'yield', allowed)
    ).toThrow(/signal/)
  })

  it('throws when reasoning is missing', () => {
    expect(() =>
      parseSpecialistVerdict({ signal: 'HOLD', confidence: 0.5 }, 'yield', allowed)
    ).toThrow(/reasoning/)
  })

  it('defaults missing citedRules/concerns to empty arrays', () => {
    const v = parseSpecialistVerdict(
      { signal: 'HOLD', confidence: 0.4, reasoning: 'cautious' },
      'risk',
      ['rsk-regime-calm']
    )
    expect(v.citedRules).toEqual([])
    expect(v.concerns).toEqual([])
  })
})

describe('skill cap is 7-dp', () => {
  // Stub storage (so loadSettings works in node) + reject fetch -> AI call fails ->
  // generateAgentSkills returns its fallback skill, whose deposit cap we assert.
  const memStore = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    }
  }

  it('encodes deposit maxAmount in 7-dp base units', async () => {
    vi.stubGlobal('localStorage', memStore())
    vi.stubGlobal('sessionStorage', memStore())
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network')))
    )
    try {
      const skill = await generateAgentSkills({ agentId: 'w1', vault: '0xAAA', amount: 100 })
      const maxAmount = skill.skills?.deposit?.maxAmount
      expect(String(maxAmount)).toBe('1000000000') // 100 USDC at 7-dp, not the legacy 6-dp scale
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// --- Base pool allocation (Approach C, SP3) ---
describe('allocateBasePools', () => {
  // resolveProviderFromSettings -> loadSettings reads localStorage/sessionStorage; node env has
  // neither. Stub them (same approach as the AI-fallback test above) so allocation reaches its
  // provider decision and, with no configured AI, its deterministic fallback.
  const memStore = () => {
    const m = {}
    return {
      getItem: (k) => m[k] ?? null,
      setItem: (k, v) => {
        m[k] = v
      },
      removeItem: (k) => {
        delete m[k]
      },
    }
  }
  beforeEach(() => {
    vi.stubGlobal('localStorage', memStore())
    vi.stubGlobal('sessionStorage', memStore())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('fallback (no provider configured) splits amount equally across only whitelisted pools, each within its own cap-eligible amount', async () => {
    const { allocateBasePools } = await import('./strategist.js')
    const result = await allocateBasePools({ amount: 300, riskLevel: 'medium', nPools: 3 })

    expect(result).toHaveLength(3)
    const { BASE_POOL_CATALOG } = await import('./config.js')
    const allowedAddresses = new Set(BASE_POOL_CATALOG.map((p) => p.address.toLowerCase()))
    for (const entry of result) {
      expect(allowedAddresses.has(entry.pool.toLowerCase())).toBe(true)
      expect(entry.amount).toBeCloseTo(100, 5)
      expect(entry.minShares).toBeGreaterThan(0n)
      expect(entry.skill).toMatchObject({
        vaultAddress: entry.pool,
        maxAmount: expect.any(String),
        expiresAt: expect.any(Number),
      })
    }
    const total = result.reduce((s, e) => s + e.amount, 0)
    expect(total).toBeCloseTo(300, 5)
  })

  test('clamps nPools to the catalog size', async () => {
    const { allocateBasePools } = await import('./strategist.js')
    const result = await allocateBasePools({ amount: 100, riskLevel: 'low', nPools: 50 })
    const { BASE_POOL_CATALOG } = await import('./config.js')
    expect(result.length).toBeLessThanOrEqual(BASE_POOL_CATALOG.length)
  })

  test('every skill has a future expiresAt and a maxAmount matching the allocated amount at 6dp', async () => {
    const { allocateBasePools } = await import('./strategist.js')
    const nowSec = Math.floor(Date.now() / 1000)
    const result = await allocateBasePools({ amount: 60, riskLevel: 'high', nPools: 2 })
    for (const entry of result) {
      expect(entry.skill.expiresAt).toBeGreaterThan(nowSec)
      expect(BigInt(entry.skill.maxAmount)).toBe(BigInt(Math.round(entry.amount * 1_000_000)))
    }
  })
})

describe('AI token usage telemetry', () => {
  const memStore = () => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    }
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', memStore())
    vi.stubGlobal('sessionStorage', memStore())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('getTokenUsageHistory defaults to empty array and saves usage correctly', async () => {
    expect(getTokenUsageHistory()).toEqual([])

    // Simulate calling generateAgentSkills with mock fetch returning usage data
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      agentId: 'w1',
                      vaultAddress: '0x123',
                      skills: { deposit: {} },
                      generatedBy: 'test-model',
                      approvedByUser: false,
                    }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 150,
                completion_tokens: 50,
                total_tokens: 200,
              },
            }),
        })
      )
    )

    const skill = await generateAgentSkills({
      agentId: 'w1',
      vault: '0x123',
      amount: 100,
      devApiKey: 'test-key',
    })
    expect(skill.generatedBy).toBe('test-model')

    const history = getTokenUsageHistory()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      promptTokens: 150,
      completionTokens: 50,
      totalTokens: 200,
    })
    expect(history[0].timestamp).toBeGreaterThan(0)

    clearTokenUsageHistory()
    expect(getTokenUsageHistory()).toEqual([])
  })
})

