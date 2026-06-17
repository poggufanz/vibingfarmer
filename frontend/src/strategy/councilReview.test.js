// frontend/src/strategy/councilReview.test.js
import { describe, it, expect, vi } from 'vitest'
import { buildCouncilInput, synthesize, councilReview } from './councilReview.js'

const baseInput = {
  amountUsdc: 100, numVaults: 2,
  blendedApy: 6.2, projectedAnnualUsdc: 6.1, riskAdjustedScore: 5.4, riskPenalty: 0.3,
  turbulence: 'calm', violations: [], maxDrawdown: 4, riskTier: 'medium',
  gasGwei: 12, gasLevel: 'normal', marketSignals: [],
  vaults: [{ name: 'A', protocol: 'aave-v3', apy: 5, drawdown: 3, allocationPct: 60, riskTier: 'low' }],
}
const w1 = () => 1.0
const ai = (role, signal, confidence, citedRules = [`${role}-c`]) =>
  ({ role, signal, confidence, reasoning: 'ai', citedRules, concerns: [], source: 'ai' })

describe('buildCouncilInput', () => {
  it('derives council input from strategy + state', () => {
    const strategy = {
      total: 100, risk: 'med', blendedApy: '6.2',
      reward: { projectedAnnualUsdc: 6.1, riskAdjustedScore: 5.4, riskPenalty: 0.3 },
      mdpState: { turbulence: 'elevated', actionViolations: ['x'], gasGwei: 20, gasLevel: 'elevated', signals: ['s1'], profileRisk: 'medium' },
      agents: [{ allocation: 60, vault: { name: 'A', protocol: 'aave-v3', apy: '5', drawdown: 3, risk: 'low' } }],
    }
    const inp = buildCouncilInput(strategy, { market: { turbulence: 'calm' } })
    expect(inp.amountUsdc).toBe(100)
    expect(inp.blendedApy).toBe(6.2)
    expect(inp.turbulence).toBe('elevated')          // mdpState wins over state
    expect(inp.violations).toEqual(['x'])
    expect(inp.vaults[0].allocationPct).toBe(60)
    expect(inp.maxDrawdown).toBe(3)
  })
})

describe('synthesize', () => {
  it('hard-vetoes when risk WITHDRAW confidence > 0.85', async () => {
    const r = await synthesize([ai('yield', 'DEPOSIT', 0.9), ai('risk', 'WITHDRAW', 0.9), ai('market', 'DEPOSIT', 0.8)], { resolveConflict: vi.fn(), market: {} })
    expect(r.verdict).toBe('discard')
    expect(r.resolvedBy).toBe('veto')
  })
  it('keeps on unanimous DEPOSIT without AI conflict call', async () => {
    const resolveConflict = vi.fn()
    const r = await synthesize([ai('yield', 'DEPOSIT', 0.8), ai('risk', 'DEPOSIT', 0.7), ai('market', 'DEPOSIT', 0.75)], { resolveConflict, market: {} })
    expect(r.verdict).toBe('keep')
    expect(r.resolvedBy).toBe('unanimous')
    expect(resolveConflict).not.toHaveBeenCalled()
  })
  it('escalates to the AI resolver only on a genuine split', async () => {
    const resolveConflict = vi.fn(async () => 'DEPOSIT')
    const r = await synthesize([ai('yield', 'DEPOSIT', 0.6), ai('risk', 'DEPOSIT', 0.55), ai('market', 'HOLD', 0.7)], { resolveConflict, market: {} })
    expect(resolveConflict).toHaveBeenCalledOnce()
    expect(r.resolvedBy).toBe('ai-conflict')
    expect(r.verdict).toBe('keep')
  })
})

describe('councilReview orchestration (AI-only)', () => {
  it('synthesizes when all three specialists return real verdicts', async () => {
    const specialist = vi.fn(async ({ role }) => ai(role, 'DEPOSIT', 0.8))
    const r = await councilReview(baseInput, { specialist, resolveConflict: vi.fn(async () => 'HOLD'), weight: w1 })
    expect(r.specialists).toHaveLength(3)
    expect(r.specialists.every((s) => s.source === 'ai')).toBe(true)
    expect(r.verdict).toBe('keep')
  })

  it('retries a failing specialist once before giving up', async () => {
    let calls = 0
    const specialist = vi.fn(async ({ role }) => {
      if (role === 'market') { calls++; return calls >= 2 ? ai('market', 'DEPOSIT', 0.7) : null }
      return ai(role, 'DEPOSIT', 0.8)
    })
    const r = await councilReview(baseInput, { specialist, resolveConflict: vi.fn(async () => 'HOLD'), weight: w1, attempts: 2 })
    expect(calls).toBe(2)                 // failed once, succeeded on retry
    expect(r.verdict).not.toBe('unavailable')
    expect(r.specialists).toHaveLength(3)
  })

  it('returns unavailable (no fabricated verdict) when a specialist keeps failing', async () => {
    const specialist = vi.fn(async ({ role }) => (role === 'market' ? null : ai(role, 'DEPOSIT', 0.8)))
    const r = await councilReview(baseInput, { specialist, resolveConflict: vi.fn(), weight: w1, attempts: 2 })
    expect(r.verdict).toBe('unavailable')
    expect(r.resolvedBy).toBe('unavailable')
    expect(r.citedRules).toEqual([])
    expect(r.specialists.length).toBe(2)  // only the ones that succeeded
  })
})
