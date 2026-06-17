import { describe, it, expect } from 'vitest'
import { normalizeRisk, deriveTurbulence, deriveSignals, buildStrategyState, RISK_RANK } from './mdp.js'

describe('normalizeRisk', () => {
  it('maps the app-internal "med" to "medium"', () => {
    expect(normalizeRisk('med')).toBe('medium')
  })
  it('lowercases and passes through canonical tiers', () => {
    expect(normalizeRisk('HIGH')).toBe('high')
    expect(normalizeRisk('low')).toBe('low')
  })
  it('defaults unknown values to "medium"', () => {
    expect(normalizeRisk(undefined)).toBe('medium')
    expect(normalizeRisk('weird')).toBe('medium')
  })
})

describe('deriveTurbulence (FinRL turbulence-index analog)', () => {
  it('returns calm for empty/benign context', () => {
    expect(deriveTurbulence(null).turbulence).toBe('calm')
    expect(deriveTurbulence('yields stable and healthy').turbulence).toBe('calm')
  })
  it('flags turbulent on exploit/hack/depeg keywords', () => {
    const r = deriveTurbulence('A major exploit drained the pool today')
    expect(r.turbulence).toBe('turbulent')
    expect(r.signals).toContain('exploit')
  })
  it('flags elevated on volatility/caution keywords', () => {
    expect(deriveTurbulence('markets are volatile, yields compressing').turbulence).toBe('elevated')
  })
})

describe('buildStrategyState', () => {
  const vaultData = [
    { address: '0xAAA', protocol: 'aave-v3', apy: 4.8, risk: 'low', yield_source: 'lending', drawdown: '-1.2', min_capital: 100 },
    { address: '0xBBB', protocol: 'pendle-v2', apy: 9.4, risk: 'high', yield_source: 'structured', drawdown: '-6.5', min_capital: 1000 },
  ]
  it('captures capital, profile, universe, and market regime', () => {
    const s = buildStrategyState({ amountUsdc: 5000, riskLevel: 'med', numVaults: 2, vaultData, marketContext: 'volatile markets' })
    expect(s.capital.amountUsdc).toBe(5000)
    expect(s.profile.riskLevel).toBe('medium')
    expect(s.universe).toHaveLength(2)
    expect(s.universe[0].riskTier).toBe('low')
    expect(s.market.turbulence).toBe('elevated')
  })
  it('derives heldUsdc from 6-decimal position balances', () => {
    const s = buildStrategyState({
      amountUsdc: 1000, riskLevel: 'low', numVaults: 1, vaultData, marketContext: null,
      positions: { '0xAAA': { balance: '2500000' } }, // 2.5 USDC
    })
    expect(s.capital.heldUsdc).toBeCloseTo(2.5, 5)
    expect(s.portfolio.heldVaultCount).toBe(1)
  })
})

import { riskCeiling, enforceActionSpace, ACTION_SPACE } from './mdp.js'

const UNIVERSE = [
  { address: '0xAAA', protocol: 'aave-v3', apy: 4.8, risk: 'low', drawdown: '-1.2', min_capital: 100 },
  { address: '0xBBB', protocol: 'morpho-blue', apy: 6.1, risk: 'medium', drawdown: '-2.8', min_capital: 500 },
  { address: '0xCCC', protocol: 'pendle-v2', apy: 9.4, risk: 'high', drawdown: '-6.5', min_capital: 1000 },
]
const stateWith = (riskLevel, marketContext) =>
  buildStrategyState({ amountUsdc: 5000, riskLevel, numVaults: 3, vaultData: UNIVERSE, marketContext })

describe('riskCeiling', () => {
  it('is the profile risk when the market is calm', () => {
    expect(riskCeiling(stateWith('high', null))).toBe('high')
    expect(riskCeiling(stateWith('low', null))).toBe('low')
  })
  it('a turbulent market forces the ceiling down to low', () => {
    expect(riskCeiling(stateWith('high', 'exploit drained the pool'))).toBe('low')
  })
  it('an elevated market caps a high-risk profile at medium', () => {
    expect(riskCeiling(stateWith('high', 'volatile, yields compressing'))).toBe('medium')
  })
})

describe('enforceActionSpace', () => {
  it('drops vaults above the ceiling and re-normalizes weights to 1.0', () => {
    const state = stateWith('medium', null) // ceiling = medium
    const proposed = [
      { address: '0xAAA', allocation: 0.5, risk_tier: 'low' },
      { address: '0xCCC', allocation: 0.5, risk_tier: 'high' }, // gated out
    ]
    const { allocations, violations } = enforceActionSpace(proposed, state)
    expect(allocations).toHaveLength(1)
    expect(allocations[0].address).toBe('0xAAA')
    expect(allocations[0].allocation).toBe(1)
    expect(violations.some((v) => v.includes('pendle-v2'))).toBe(true)
  })
  it('normalizes a valid set whose weights do not sum to 1.0', () => {
    const state = stateWith('high', null)
    const proposed = [
      { address: '0xAAA', allocation: 0.2 },
      { address: '0xBBB', allocation: 0.2 },
    ]
    const { allocations } = enforceActionSpace(proposed, state)
    const sum = allocations.reduce((s, a) => s + a.allocation, 0)
    expect(sum).toBeCloseTo(1.0, 4)
  })
  it('falls back to the safest vault when everything is gated', () => {
    const state = stateWith('low', 'exploit everywhere') // ceiling = low
    const proposed = [{ address: '0xCCC', allocation: 1, risk_tier: 'high' }]
    const { allocations, violations } = enforceActionSpace(proposed, state)
    expect(allocations).toHaveLength(1)
    expect(allocations[0].address).toBe('0xAAA') // lowest-risk in universe
    expect(violations.some((v) => v.includes('fell back'))).toBe(true)
  })
  it('exposes a static ACTION_SPACE description for the UI', () => {
    expect(ACTION_SPACE.allocate.constraint).toMatch(/sum to 1\.0/)
  })
})

import { scoreReward, realizedReward } from './mdp.js'

describe('scoreReward (projected reward)', () => {
  const state = buildStrategyState({ amountUsdc: 10000, riskLevel: 'high', numVaults: 2, vaultData: UNIVERSE, marketContext: null })
  it('computes the allocation-weighted blended APY', () => {
    const r = scoreReward([
      { address: '0xAAA', allocation: 0.5, expected_apy: 4.8, risk_tier: 'low', drawdown: -1.2 },
      { address: '0xCCC', allocation: 0.5, expected_apy: 9.4, risk_tier: 'high', drawdown: -6.5 },
    ], state)
    expect(r.blendedApy).toBeCloseTo(7.1, 2)
  })
  it('projects annual USDC yield on deployed capital', () => {
    const r = scoreReward([{ address: '0xAAA', allocation: 1, expected_apy: 5, risk_tier: 'low', drawdown: -1 }], state)
    expect(r.projectedAnnualUsdc).toBeCloseTo(500, 2) // 5% of 10000
  })
  it('a turbulent market inflates the risk penalty', () => {
    const calm = buildStrategyState({ amountUsdc: 1000, riskLevel: 'high', numVaults: 1, vaultData: UNIVERSE, marketContext: null })
    const turbulent = buildStrategyState({ amountUsdc: 1000, riskLevel: 'high', numVaults: 1, vaultData: UNIVERSE, marketContext: 'exploit drained pool' })
    const alloc = [{ address: '0xCCC', allocation: 1, expected_apy: 9.4, risk_tier: 'high', drawdown: -6.5 }]
    expect(scoreReward(alloc, turbulent).riskPenalty).toBeGreaterThan(scoreReward(alloc, calm).riskPenalty)
  })
  it('risk-adjusted score rewards safer allocations per unit of risk', () => {
    const lowOnly = scoreReward([{ address: '0xAAA', allocation: 1, expected_apy: 4.8, risk_tier: 'low', drawdown: -1.2 }], state)
    expect(lowOnly.riskAdjustedScore).toBeGreaterThan(0)
  })
})

describe('realizedReward (closes the RL loop from memory)', () => {
  it('returns zeros for no entries', () => {
    expect(realizedReward([])).toEqual({ successRate: 0, avgSlippage: 0, totalGas: 0 })
  })
  it('aggregates success rate, avg slippage, and total gas', () => {
    const r = realizedReward([
      { status: 'success', slippageActual: 0.12, gasUsed: 45000 },
      { status: 'failed', slippageActual: 0.30, gasUsed: 21000 },
    ])
    expect(r.successRate).toBe(0.5)
    expect(r.avgSlippage).toBeCloseTo(0.21, 3)
    expect(r.totalGas).toBe(66000)
  })
})

describe('deriveSignals (market context + on-chain gas)', () => {
  it('returns calm with no signals when market is benign and gas normal', () => {
    const r = deriveSignals('yields stable', { level: 'normal', gwei: 10 })
    expect(r.turbulence).toBe('calm')
    expect(r.signals).toEqual([])
  })

  it('adds a gas-spike signal and bumps calm -> elevated on high gas', () => {
    const r = deriveSignals('yields stable', { level: 'high', gwei: 95 })
    expect(r.turbulence).toBe('elevated')
    expect(r.signals).toContain('gas-spike')
  })

  it('keeps turbulent from market context even when gas is high', () => {
    const r = deriveSignals('exploit drained the pool', { level: 'high', gwei: 95 })
    expect(r.turbulence).toBe('turbulent')
    expect(r.signals).toContain('exploit')
    expect(r.signals).toContain('gas-spike')
  })

  it('tolerates a null gas snapshot (chain read failed)', () => {
    const r = deriveSignals('markets volatile', null)
    expect(r.turbulence).toBe('elevated')
    expect(r.signals).not.toContain('gas-spike')
  })
})

describe('buildStrategyState gas awareness', () => {
  it('adds a gas-spike signal when a high gas snapshot is supplied', () => {
    const state = buildStrategyState({
      amountUsdc: 1000, riskLevel: 'high', numVaults: 2,
      vaultData: [], marketContext: 'markets calm', positions: {},
      gas: { level: 'high', gwei: 120 },
    })
    expect(state.market.signals).toContain('gas-spike')
  })
  it('omits gas-spike when no gas snapshot is supplied', () => {
    const state = buildStrategyState({
      amountUsdc: 1000, riskLevel: 'high', numVaults: 2,
      vaultData: [], marketContext: 'markets calm', positions: {},
    })
    expect(state.market.signals).not.toContain('gas-spike')
  })
})
