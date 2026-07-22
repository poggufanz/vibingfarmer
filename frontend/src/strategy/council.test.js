// frontend/src/strategy/council.test.js
import { describe, it, expect, vi } from 'vitest'
import { councilVerdict } from './council.js'

const calm = { market: { turbulence: 'calm' } }
const turbulent = { market: { turbulence: 'turbulent' } }
const reward = (riskAdjustedScore, projectedAnnualUsdc) => ({
  riskAdjustedScore,
  projectedAnnualUsdc,
})
// A null-apy bridge/proxy row: mdp.scoreReward/runSimulation report this as
// projection:{state:'unavailable'} while riskAdjustedScore/projectedAnnualUsdc stay the
// legacy-coerced 0 (Strategy Task 2). Specialists must not read that 0 as a real number.
const rewardUnavailable = (riskAdjustedScore = 0, projectedAnnualUsdc = 0) => ({
  riskAdjustedScore,
  projectedAnnualUsdc,
  projection: { state: 'unavailable', value: null },
})
// neutral playbook + a resolver we can assert is/ isn't called
const deps = (resolver) => ({
  weight: () => 1.0,
  resolveConflict: resolver || vi.fn(async () => 'HOLD'),
})

describe('councilVerdict (TradingAgents council)', () => {
  it('keeps a clean profitable rebalance unanimously, no AI call', async () => {
    const resolveConflict = vi.fn()
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: [] },
        currentReward: reward(5.0, 100),
        projectedReward: reward(6.5, 140),
        state: calm,
        estGasUsdc: 0.5,
      },
      deps(resolveConflict)
    )
    expect(r.verdict).toBe('keep')
    expect(r.resolvedBy).toBe('unanimous')
    expect(r.specialists).toHaveLength(3)
    expect(r.citedRules).toContain('yield-uplift')
    expect(resolveConflict).not.toHaveBeenCalled()
  })

  it('hard-vetoes on turbulent market (Risk WITHDRAW > 0.85), no AI call', async () => {
    const resolveConflict = vi.fn()
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: [] },
        currentReward: reward(5.0, 100),
        projectedReward: reward(9.0, 300),
        state: turbulent,
        estGasUsdc: 0.5,
      },
      deps(resolveConflict)
    )
    expect(r.verdict).toBe('discard')
    expect(r.resolvedBy).toBe('veto')
    expect(r.reason).toBe('Risk Analyst')
    expect(r.citedRules).toContain('risk-turbulent-veto')
    expect(resolveConflict).not.toHaveBeenCalled()
  })

  it('hard-vetoes on gate violation', async () => {
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: ['aave-v3 exceeds low ceiling'] },
        currentReward: reward(5.0, 100),
        projectedReward: reward(9.0, 300),
        state: calm,
        estGasUsdc: 0.5,
      },
      deps()
    )
    expect(r.verdict).toBe('discard')
    expect(r.citedRules).toContain('risk-gate-violation')
  })

  it('discards when yield gives no uplift and gas negative (majority HOLD)', async () => {
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: [] },
        currentReward: reward(6.0, 120),
        projectedReward: reward(5.5, 119.9),
        state: calm,
        estGasUsdc: 0.5,
      },
      deps()
    )
    expect(r.verdict).toBe('discard')
  })

  it('keeps a harvest in calm market (free claim), no AI call', async () => {
    const resolveConflict = vi.fn()
    const r = await councilVerdict(
      {
        action: { kind: 'harvest', violations: [] },
        currentReward: reward(5.0, 100),
        projectedReward: reward(5.0, 100),
        state: calm,
        estGasUsdc: 0.5,
      },
      deps(resolveConflict)
    )
    expect(r.verdict).toBe('keep')
    expect(r.citedRules).toContain('yield-harvest-free')
    expect(resolveConflict).not.toHaveBeenCalled()
  })

  it('escalates to the AI resolver only on a genuine split', async () => {
    // Construct a split: yield says DEPOSIT (uplift), market says HOLD (gas negative),
    // risk neutral (calm, no violation) → no 2/3 majority on DEPOSIT vs HOLD.
    const resolveConflict = vi.fn(async () => 'DEPOSIT')
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: [] },
        currentReward: reward(5.0, 100),
        projectedReward: reward(6.0, 100.2), // +score, gas-negative
        state: calm,
        estGasUsdc: 0.5,
      },
      { weight: () => 1.0, resolveConflict }
    )
    expect(resolveConflict).toHaveBeenCalledOnce()
    expect(r.resolvedBy).toBe('ai-conflict')
    expect(r.verdict).toBe('keep') // resolver returned DEPOSIT
  })

  it('AI resolver returning HOLD makes the split discard', async () => {
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: [] },
        currentReward: reward(5.0, 100),
        projectedReward: reward(6.0, 100.2),
        state: calm,
        estGasUsdc: 0.5,
      },
      { weight: () => 1.0, resolveConflict: async () => 'HOLD' }
    )
    expect(r.verdict).toBe('discard')
    expect(r.resolvedBy).toBe('ai-conflict')
  })

  it('applies playbook weight to specialist confidence', async () => {
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: [] },
        currentReward: reward(5.0, 100),
        projectedReward: reward(6.5, 140),
        state: calm,
        estGasUsdc: 0.5,
      },
      { weight: (id) => (id === 'yield-uplift' ? 1.5 : 1.0), resolveConflict: vi.fn() }
    )
    const y = r.specialists.find((s) => s.role === 'yield')
    expect(y.confidence).toBeGreaterThan(0.6) // boosted by weight
  })
})

describe('councilVerdict — nullable yield (unavailable projection)', () => {
  it('does not read a null-apy bridge row baseline as a confirmed yield-uplift', async () => {
    // currentReward is a null-apy bridge/proxy position: riskAdjustedScore/projectedAnnualUsdc
    // are legacy-coerced to 0, but the yield is UNKNOWN, not confirmed zero. Comparing against
    // it must not read as a real 6.5-point uplift.
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: [] },
        currentReward: rewardUnavailable(),
        projectedReward: reward(6.5, 140),
        state: calm,
        estGasUsdc: 0.5,
      },
      deps()
    )
    const y = r.specialists.find((s) => s.role === 'yield')
    expect(y.citedRules).not.toContain('yield-uplift')
    expect(y.concerns.join(' ')).toMatch(/unavailable/i)
    const m = r.specialists.find((s) => s.role === 'market')
    expect(m.citedRules).not.toContain('market-gas-positive')
  })

  it('does not read the CURRENT position as a confirmed yield-uplift when the TARGET is a null-apy row', async () => {
    const r = await councilVerdict(
      {
        action: { kind: 'rebalance', violations: [] },
        currentReward: reward(5.0, 100),
        projectedReward: rewardUnavailable(),
        state: calm,
        estGasUsdc: 0.5,
      },
      deps()
    )
    const y = r.specialists.find((s) => s.role === 'yield')
    expect(y.citedRules).not.toContain('yield-no-uplift')
    expect(y.concerns.join(' ')).toMatch(/unavailable/i)
    const m = r.specialists.find((s) => s.role === 'market')
    expect(m.citedRules).not.toContain('market-gas-negative')
  })

  it('still allows a harvest to keep even when both rewards carry unavailable yield (does not block review)', async () => {
    const resolveConflict = vi.fn()
    const r = await councilVerdict(
      {
        action: { kind: 'harvest', violations: [] },
        currentReward: rewardUnavailable(),
        projectedReward: rewardUnavailable(),
        state: calm,
        estGasUsdc: 0.5,
      },
      deps(resolveConflict)
    )
    expect(r.verdict).toBe('keep')
    expect(resolveConflict).not.toHaveBeenCalled()
  })
})
