// frontend/src/strategy/riskParams.test.js
import { describe, test, expect, vi } from 'vitest'
import { fuseRiskParams, runRiskSimulation } from './riskParams.js'

const BASKET = [
  { weight: 0.5, dailyVolPct: 0.3 },
  { weight: 0.5, dailyVolPct: 0.3 },
]
const SIM_OPTS = { runs: 2000, horizonDays: 30, seed: 1 }

describe('fuseRiskParams', () => {
  test('calm context produces the base aggregate params, no deep rules', () => {
    // Arrange / Act
    const { params, route, rules } = fuseRiskParams({
      context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 },
    })
    // Assert
    expect(route).toBe('aggregate')
    expect(params.correlation).toBe(0.2)
    expect(params.volMultiplier).toBe(1)
    expect(params.driftPct).toBe(8)
    expect(params.tailFatten).toBeUndefined()
    expect(rules).toEqual([])
  })

  test('deep toggle merges emergent correlation bump + tailFatten and cites its rule', () => {
    // Arrange / Act
    const { params, route, rules } = fuseRiskParams({
      context: { turbulence: 'turbulent', drawdownPct: -12, rumorIntensity: 1 },
      deepRequested: true,
    })
    // Assert
    expect(route).toBe('deep')
    expect(params.correlation).toBeGreaterThan(0.85) // 0.85 aggregate + 0.10 bump
    expect(params.tailFatten).toBeCloseTo(1.6, 5)
    expect(rules).toContain('herd-turbulent')
    expect(rules).toContain('emergent-rumor-contagion')
  })
})

describe('runRiskSimulation', () => {
  test('is deterministic for a fixed seed', () => {
    // Arrange
    const fused = fuseRiskParams({ context: { turbulence: 'calm' } })
    // Act
    const a = runRiskSimulation(BASKET, fused, SIM_OPTS)
    const b = runRiskSimulation(BASKET, fused, SIM_OPTS)
    // Assert
    expect(a.metrics).toEqual(b.metrics)
  })

  test('panic tail is materially worse than calm (honest spread)', () => {
    // Arrange
    const calm = fuseRiskParams({ context: { turbulence: 'calm', drawdownPct: 0, apyTrendPct: 8 } })
    const panic = fuseRiskParams({
      context: { turbulence: 'turbulent', drawdownPct: -12, apyTrendPct: 8 },
    })
    // Act
    const calmSim = runRiskSimulation(BASKET, calm, SIM_OPTS)
    const panicSim = runRiskSimulation(BASKET, panic, SIM_OPTS)
    // Assert: CVaR is a signed % return — more negative = worse tail.
    expect(panicSim.metrics.cvar95).toBeLessThan(calmSim.metrics.cvar95)
    expect(panicSim.metrics.cvar95).toBeLessThan(-4) // panic tail breaches the moderate floor region
    expect(calmSim.metrics.cvar95).toBeGreaterThan(-3) // calm tail stays shallow
  })

  test('does not call Math.random (seeded only)', () => {
    // Arrange
    const spy = vi.spyOn(Math, 'random')
    const fused = fuseRiskParams({ context: { turbulence: 'calm' } })
    // Act
    runRiskSimulation(BASKET, fused, SIM_OPTS)
    // Assert
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
