// frontend/src/strategy/riskCouncil.test.js
import { describe, test, expect, vi } from 'vitest'
import { runRiskCouncil } from './riskCouncil.js'

const BASKET = [
  { weight: 0.5, dailyVolPct: 0.3 },
  { weight: 0.5, dailyVolPct: 0.3 },
]
const BASE = {
  basket: BASKET,
  riskTier: 'moderate',
  proposal: { allocation: [{ vault: 'A', weight: 1 }], payload: { kind: 'rebalance', to: 'B' } },
}
const OPTS = { runs: 4000, horizonDays: 30, seed: 1, maxIter: 2 }

describe('runRiskCouncil end to end', () => {
  test('calm market converges to proceed and stops for the human', async () => {
    // Arrange / Act
    const out = await runRiskCouncil(
      { ...BASE, context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 } },
      OPTS
    )
    // Assert
    expect(out.sim.metrics.cvar95).toBeGreaterThan(-3)
    expect(out.council.outcome).toBe('converge')
    expect(out.permission.recommend).toBe('proceed')
    expect(out.awaitingHuman).toBe(true)
    expect(out.executed).toBe(false)
  })

  test('panic market converges to hold on a cited veto', async () => {
    // Arrange / Act
    const out = await runRiskCouncil(
      { ...BASE, context: { turbulence: 'turbulent', drawdownPct: -12, apyTrendPct: 8 } },
      OPTS
    )
    // Assert
    expect(out.sim.metrics.cvar95).toBeLessThan(-5)
    expect(out.council.citedRules).toContain('CVAR_TAIL_FLOOR')
    expect(out.permission.recommend).toBe('hold')
    expect(out.executed).toBe(false)
  })

  test('WAJIB BERHENTI: the orchestrator never receives or calls an executor', async () => {
    // Arrange — even if a stray execute leaks into deps, the orchestrator must ignore it
    const execute = vi.fn()
    // Act
    const out = await runRiskCouncil(
      { ...BASE, context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 } },
      { ...OPTS, execute }
    )
    // Assert
    expect(execute).not.toHaveBeenCalled()
    expect(out.executed).toBe(false)
    expect(out.awaitingHuman).toBe(true)
  })

  test('proposer cited numbers are taken from the sim, so the validator never goes fatal', async () => {
    // Arrange / Act
    const out = await runRiskCouncil(
      { ...BASE, context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 } },
      OPTS
    )
    // Assert
    expect(out.council.outcome).not.toBe('fatal')
    expect(out.proposalCited.cvar95).toBe(out.sim.metrics.cvar95)
  })
})
