// frontend/src/strategy/riskProof.test.js
// Regression of the Phase-1 "honest spread" proof: one rule corpus, fed two
// distributions (calm vs panic), returns two cited verdicts. The mean is nearly
// identical both ways; only the CVaR tail diverges. Replaces __riskproof.mjs.
import { describe, test, expect } from 'vitest'
import { fuseRiskParams, runRiskSimulation } from './riskParams.js'
import { checkTailCompliance } from './complianceCorpus.js'

const BASKET = [
  { weight: 0.5, dailyVolPct: 0.3 },
  { weight: 0.5, dailyVolPct: 0.3 },
]
const OPTS = { runs: 10000, horizonDays: 30, seed: 1 }
const DRIFT = 8

function runMarket(context) {
  const fused = fuseRiskParams({ context: { ...context, apyTrendPct: DRIFT } })
  return runRiskSimulation(BASKET, fused, OPTS).metrics
}

describe('Phase-1 honest-spread proof (regression)', () => {
  test('calm market: shallow tail, CVaR passes the moderate floor', () => {
    // Arrange / Act
    const m = runMarket({ turbulence: 'calm', drawdownPct: 0 })
    const verdict = checkTailCompliance(m, { riskTier: 'moderate' })
    // Assert
    expect(m.mean).toBeGreaterThan(0)
    expect(m.cvar95).toBeGreaterThan(-3)
    expect(verdict.verdict).toBe('pass')
    expect(verdict.citedRule).toBe('CVAR_TAIL_FLOOR')
  })

  test('panic market: ~identical mean, fat tail, CVaR vetoes the moderate floor', () => {
    // Arrange / Act
    const m = runMarket({ turbulence: 'turbulent', drawdownPct: -12 })
    const verdict = checkTailCompliance(m, { riskTier: 'moderate' })
    // Assert
    expect(m.mean).toBeGreaterThan(0) // mean stays green — it hides the tail
    expect(m.cvar95).toBeLessThan(-5) // tail breaches the -5% moderate floor
    expect(verdict.verdict).toBe('veto')
    expect(verdict.citedRule).toBe('CVAR_TAIL_FLOOR')
  })

  test('same rule, two distributions, two verdicts', () => {
    // Arrange
    const calm = checkTailCompliance(runMarket({ turbulence: 'calm', drawdownPct: 0 }), {
      riskTier: 'moderate',
    })
    const panic = checkTailCompliance(runMarket({ turbulence: 'turbulent', drawdownPct: -12 }), {
      riskTier: 'moderate',
    })
    // Assert
    expect(calm.citedRule).toBe(panic.citedRule)
    expect(calm.verdict).not.toBe(panic.verdict)
  })
})
