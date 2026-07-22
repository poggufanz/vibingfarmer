// frontend/src/strategy/councilReview.test.js
import { describe, it, expect, vi } from 'vitest'
import {
  buildCouncilInput,
  buildSpecialistPrompt,
  buildDebateInput,
  synthesize,
  councilReview,
  councilDebate,
} from './councilReview.js'

const baseInput = {
  amountUsdc: 100,
  numVaults: 2,
  blendedApy: 6.2,
  projectedAnnualUsdc: 6.1,
  riskAdjustedScore: 5.4,
  riskPenalty: 0.3,
  turbulence: 'calm',
  violations: [],
  maxDrawdown: 4,
  riskTier: 'medium',
  gasGwei: 12,
  gasLevel: 'normal',
  marketSignals: [],
  vaults: [
    { name: 'A', protocol: 'aave-v3', apy: 5, drawdown: 3, allocationPct: 60, riskTier: 'low' },
  ],
}
const w1 = () => 1.0
const ai = (role, signal, confidence, citedRules = [`${role}-c`]) => ({
  role,
  signal,
  confidence,
  reasoning: 'ai',
  citedRules,
  concerns: [],
  source: 'ai',
})

describe('buildCouncilInput', () => {
  it('derives council input from strategy + state', () => {
    const strategy = {
      total: 100,
      risk: 'med',
      blendedApy: '6.2',
      reward: { projectedAnnualUsdc: 6.1, riskAdjustedScore: 5.4, riskPenalty: 0.3 },
      mdpState: {
        turbulence: 'elevated',
        actionViolations: ['x'],
        gasGwei: 20,
        gasLevel: 'elevated',
        signals: ['s1'],
        profileRisk: 'medium',
      },
      agents: [
        {
          allocation: 60,
          vault: { name: 'A', protocol: 'aave-v3', apy: '5', drawdown: 3, risk: 'low' },
        },
      ],
    }
    const inp = buildCouncilInput(strategy, { market: { turbulence: 'calm' } })
    expect(inp.amountUsdc).toBe(100)
    expect(inp.blendedApy).toBe(6.2)
    expect(inp.turbulence).toBe('elevated') // mdpState wins over state
    expect(inp.violations).toEqual(['x'])
    expect(inp.vaults[0].allocationPct).toBe(60)
    expect(inp.maxDrawdown).toBe(3)
  })

  it('preserves null apy per vault and reports projection unavailable for a bridge/proxy row', () => {
    const strategy = {
      total: 100,
      risk: 'med',
      blendedApy: '3.1',
      reward: { projectedAnnualUsdc: 3.1, riskAdjustedScore: 2.6, riskPenalty: 0.1 },
      mdpState: { turbulence: 'calm' },
      agents: [
        {
          allocation: 40,
          vault: { name: 'Base bridge', protocol: 'cctp', apy: null, drawdown: 0, risk: 'low' },
        },
        {
          allocation: 60,
          vault: { name: 'A', protocol: 'aave-v3', apy: '5', drawdown: 3, risk: 'low' },
        },
      ],
    }
    const inp = buildCouncilInput(strategy)
    expect(inp.vaults[0].apy).toBeNull()
    expect(inp.vaults[1].apy).toBe(5)
    // Legacy reward without a `.projection` field falls back on projectedAnnualUsdc being
    // defined — buildCouncilInput itself does not invent unavailability from vault-level nulls.
    expect(inp.projection.state).toBe('known')
  })

  it('consumes reward.projection when Task 2 provides it', () => {
    const strategy = {
      total: 100,
      reward: {
        projectedAnnualUsdc: 3.1,
        riskAdjustedScore: 2.6,
        riskPenalty: 0.1,
        projection: { state: 'unavailable', value: null },
      },
      agents: [],
    }
    const inp = buildCouncilInput(strategy)
    expect(inp.projection).toEqual({ state: 'unavailable', value: null })
  })
})

describe('buildSpecialistPrompt — honest yield text (no fabricated 0% APY)', () => {
  const inputWithNullApy = {
    ...baseInput,
    projection: { state: 'unavailable', value: null },
    vaults: [
      {
        name: 'Base bridge',
        protocol: 'cctp',
        apy: null,
        drawdown: 0,
        allocationPct: 40,
        riskTier: 'low',
      },
      { name: 'A', protocol: 'aave-v3', apy: 5, drawdown: 3, allocationPct: 60, riskTier: 'low' },
    ],
  }

  it('never renders "0% APY" for a vault whose yield is null', () => {
    const prompt = buildSpecialistPrompt('yield', inputWithNullApy, [])
    expect(prompt).not.toMatch(/Base bridge \(cctp\) 0%/)
    expect(prompt).toContain('Base bridge (cctp) APY not available')
    expect(prompt).toContain('A (aave-v3) 5% APY') // a real APY still renders as a number
  })

  it('reports the blended/projected yield line as unavailable instead of a fabricated number', () => {
    const prompt = buildSpecialistPrompt('yield', inputWithNullApy, [])
    expect(prompt).toContain('Blended APY: not available')
    expect(prompt).toContain('Projected annual (risk-adjusted): not available')
  })

  it('reports the risk-adjusted score as unavailable too — it is yield-derived (blended/riskWeighted)', () => {
    const prompt = buildSpecialistPrompt('yield', inputWithNullApy, [])
    expect(prompt).not.toMatch(/Risk-adjusted score: 5\.4/) // baseInput's real riskAdjustedScore, must not leak through
    expect(prompt).toContain('Risk-adjusted score: not available (penalty 0.3)') // riskPenalty stays numeric
  })

  it('a known projection still renders the real numbers (no regression)', () => {
    const prompt = buildSpecialistPrompt('yield', baseInput, [])
    expect(prompt).toContain(`Blended APY: ${baseInput.blendedApy}%`)
    expect(prompt).toContain(
      `Projected annual (risk-adjusted): ${baseInput.projectedAnnualUsdc} USDC`
    )
  })
})

describe('synthesize', () => {
  it('hard-vetoes when risk WITHDRAW confidence > 0.85', async () => {
    const r = await synthesize(
      [ai('yield', 'DEPOSIT', 0.9), ai('risk', 'WITHDRAW', 0.9), ai('market', 'DEPOSIT', 0.8)],
      { resolveConflict: vi.fn(), market: {} }
    )
    expect(r.verdict).toBe('discard')
    expect(r.resolvedBy).toBe('veto')
  })
  it('keeps on unanimous DEPOSIT without AI conflict call', async () => {
    const resolveConflict = vi.fn()
    const r = await synthesize(
      [ai('yield', 'DEPOSIT', 0.8), ai('risk', 'DEPOSIT', 0.7), ai('market', 'DEPOSIT', 0.75)],
      { resolveConflict, market: {} }
    )
    expect(r.verdict).toBe('keep')
    expect(r.resolvedBy).toBe('unanimous')
    expect(resolveConflict).not.toHaveBeenCalled()
  })
  it('escalates to the AI resolver only on a genuine split', async () => {
    const resolveConflict = vi.fn(async () => 'DEPOSIT')
    const r = await synthesize(
      [ai('yield', 'DEPOSIT', 0.6), ai('risk', 'DEPOSIT', 0.55), ai('market', 'HOLD', 0.7)],
      { resolveConflict, market: {} }
    )
    expect(resolveConflict).toHaveBeenCalledOnce()
    expect(r.resolvedBy).toBe('ai-conflict')
    expect(r.verdict).toBe('keep')
  })
})

describe('councilReview orchestration (AI-only)', () => {
  it('synthesizes when all three specialists return real verdicts', async () => {
    const specialist = vi.fn(async ({ role }) => ai(role, 'DEPOSIT', 0.8))
    const r = await councilReview(baseInput, {
      specialist,
      resolveConflict: vi.fn(async () => 'HOLD'),
      weight: w1,
    })
    expect(r.specialists).toHaveLength(3)
    expect(r.specialists.every((s) => s.source === 'ai')).toBe(true)
    expect(r.verdict).toBe('keep')
  })

  it('retries a failing specialist once before giving up', async () => {
    let calls = 0
    const specialist = vi.fn(async ({ role }) => {
      if (role === 'market') {
        calls++
        return calls >= 2 ? ai('market', 'DEPOSIT', 0.7) : null
      }
      return ai(role, 'DEPOSIT', 0.8)
    })
    const r = await councilReview(baseInput, {
      specialist,
      resolveConflict: vi.fn(async () => 'HOLD'),
      weight: w1,
      attempts: 2,
    })
    expect(calls).toBe(2) // failed once, succeeded on retry
    expect(r.verdict).not.toBe('unavailable')
    expect(r.specialists).toHaveLength(3)
  })

  it('returns unavailable (no fabricated verdict) when a specialist keeps failing', async () => {
    const specialist = vi.fn(async ({ role }) =>
      role === 'market' ? null : ai(role, 'DEPOSIT', 0.8)
    )
    const r = await councilReview(baseInput, {
      specialist,
      resolveConflict: vi.fn(),
      weight: w1,
      attempts: 2,
    })
    expect(r.verdict).toBe('unavailable')
    expect(r.resolvedBy).toBe('unavailable')
    expect(r.citedRules).toEqual([])
    expect(r.specialists.length).toBe(2) // only the ones that succeeded
  })
})

describe('buildDebateInput — nullable yield', () => {
  const strategyWithBridgeRow = {
    total: 100,
    reward: { projectedAnnualUsdc: 3.1, riskAdjustedScore: 2.6, riskPenalty: 0.1 },
    agents: [
      {
        allocation: 100,
        vault: { name: 'Base bridge', protocol: 'cctp', apy: null, risk: 'low' },
      },
    ],
  }

  it('preserves null apy per vault', () => {
    const inp = buildDebateInput(strategyWithBridgeRow, null)
    expect(inp.vaults[0].apy).toBeNull()
  })

  it('prefers sim.projection over reward.projection when both are given', () => {
    const sim = { VaR: -1, CVaR: -2, projection: { state: 'unavailable', value: null } }
    const inp = buildDebateInput(strategyWithBridgeRow, sim)
    expect(inp.projection).toEqual({ state: 'unavailable', value: null })
  })

  it('falls back to reward.projectedAnnualUsdc when neither sim nor reward carry .projection', () => {
    const inp = buildDebateInput(strategyWithBridgeRow, null)
    expect(inp.projection.state).toBe('known') // 3.1 is defined — no invented unavailability
  })
})

describe('councilDebate — honest yield prompts end to end (no fabricated 0% APY)', () => {
  const strategyWithBridgeRow = {
    total: 100,
    reward: { projectedAnnualUsdc: 3.1, riskAdjustedScore: 2.6, riskPenalty: 0.1 },
    agents: [
      {
        allocation: 100,
        vault: { name: 'Base bridge', protocol: 'cctp', apy: null, risk: 'low' },
      },
    ],
  }
  const sim = {
    VaR: -1,
    CVaR: -2,
    expectedValue: 0,
    probProfit: 0.5,
    projection: { state: 'unavailable', value: null },
  }

  it('never sends "0% APY" / a fabricated blended APY to the proposer or risk/compliance role', async () => {
    const input = buildDebateInput(strategyWithBridgeRow, sim)
    const prompts = []
    const proposer = vi.fn(async ({ userPrompt }) => {
      prompts.push(userPrompt)
      return {
        action: 'HOLD',
        reasoning: 'no data',
        confidence: 0.5,
        arguments: [],
        citedRules: [],
      }
    })
    const riskCompliance = vi.fn(async ({ userPrompt }) => {
      prompts.push(userPrompt)
      return {
        action: 'HOLD',
        confidence: 0.5,
        violationsFound: [],
        regulationsCited: [],
        concerns: [],
        compliancePass: true,
      }
    })
    const validator = vi.fn(async ({ userPrompt }) => {
      prompts.push(userPrompt)
      return {
        consistent: true,
        VaRAcceptable: true,
        CVaRAcceptable: true,
        simMatches: true,
        concerns: [],
        confidence: 0.5,
      }
    })
    await councilDebate(input, { proposer, riskCompliance, validator, maxIterations: 1 })
    for (const p of prompts) {
      expect(p).not.toMatch(/Base bridge \(cctp\) 0%/)
      expect(p).not.toMatch(/Blended APY: 0%/)
    }
    expect(prompts.some((p) => p.includes('not available'))).toBe(true)
    // Validator prompt: expectedValue:0/probProfit:0.5 come from the SAME sim call that
    // reported projection unavailable — must not render as confirmed sim numbers either.
    const validatorPrompt = prompts[2]
    expect(validatorPrompt).not.toMatch(/Expected value \(30d\): 0 USDC/)
    expect(validatorPrompt).not.toMatch(/Probability of profit: \d/)
    expect(validatorPrompt).toContain('Expected value (30d): not available')
    expect(validatorPrompt).toContain('Probability of profit: not available')
  })
})
