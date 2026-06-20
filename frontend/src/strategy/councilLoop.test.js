// frontend/src/strategy/councilLoop.test.js
import { describe, test, expect, vi } from 'vitest'
import { councilLoop } from './councilLoop.js'

// A clean pass distribution: CVaR -2 sits well above the moderate -5 floor.
const PASS_METRICS = { cvar95: -2, worst: -4, mean: 0.6 }
// A breach: CVaR -8 is below the moderate -5 floor → Risk hard-vetoes.
const VETO_METRICS = { cvar95: -8, worst: -14, mean: 0.5 }
// Near the floor: CVaR -4.6 passes -5 but with < 1pp headroom → ambiguous.
const NEAR_METRICS = { cvar95: -4.6, worst: -9, mean: 0.4 }

const proposalFor = (m) => ({
  allocation: [{ vault: 'A', weight: 1 }],
  citedNumbers: { cvar95: m.cvar95 },
})

describe('councilLoop exits', () => {
  test('clear pass converges to proceed WITHOUT an AI call', async () => {
    // Arrange
    const decide = vi.fn()
    // Act
    const r = await councilLoop(
      { metrics: PASS_METRICS, proposal: proposalFor(PASS_METRICS), riskTier: 'moderate' },
      { decide, maxIter: 2 }
    )
    // Assert
    expect(r.outcome).toBe('converge')
    expect(r.proposal.recommend).toBe('proceed')
    expect(r.citedRules).toContain('CVAR_TAIL_FLOOR')
    expect(decide).not.toHaveBeenCalled()
  })

  test('cited veto converges to hold WITHOUT an AI call', async () => {
    // Arrange
    const decide = vi.fn()
    // Act
    const r = await councilLoop(
      { metrics: VETO_METRICS, proposal: proposalFor(VETO_METRICS), riskTier: 'moderate' },
      { decide, maxIter: 2 }
    )
    // Assert
    expect(r.outcome).toBe('converge')
    expect(r.proposal.recommend).toBe('hold')
    expect(r.citedRules).toContain('CVAR_TAIL_FLOOR')
    expect(decide).not.toHaveBeenCalled()
  })

  test('fatal when cited numbers do not match the sim output', async () => {
    // Arrange — proposer claims a friendlier CVaR than the sim produced
    const decide = vi.fn()
    const lyingProposal = { allocation: [], citedNumbers: { cvar95: -1 } }
    // Act
    const r = await councilLoop(
      { metrics: VETO_METRICS, proposal: lyingProposal, riskTier: 'moderate' },
      { decide, maxIter: 2 }
    )
    // Assert
    expect(r.outcome).toBe('fatal')
    expect(decide).not.toHaveBeenCalled()
  })

  test('ambiguous + AI says proceed → converge, decide called once', async () => {
    // Arrange
    const decide = vi.fn().mockResolvedValue('proceed')
    // Act
    const r = await councilLoop(
      { metrics: NEAR_METRICS, proposal: proposalFor(NEAR_METRICS), riskTier: 'moderate' },
      { decide, maxIter: 2 }
    )
    // Assert
    expect(r.outcome).toBe('converge')
    expect(r.proposal.recommend).toBe('proceed')
    expect(decide).toHaveBeenCalledTimes(1)
  })

  test('ambiguous + AI keeps saying hold → no-consensus, decide capped at maxIter', async () => {
    // Arrange
    const decide = vi.fn().mockResolvedValue('hold')
    // Act
    const r = await councilLoop(
      { metrics: NEAR_METRICS, proposal: proposalFor(NEAR_METRICS), riskTier: 'moderate' },
      { decide, maxIter: 2 }
    )
    // Assert
    expect(r.outcome).toBe('no-consensus')
    expect(r.proposal.recommend).toBe('hold')
    expect(decide).toHaveBeenCalledTimes(2) // hard iteration cap = cost bound
  })

  test('ambiguous with no AI dep falls back to hold, never fabricates proceed', async () => {
    // Arrange / Act
    const r = await councilLoop(
      { metrics: NEAR_METRICS, proposal: proposalFor(NEAR_METRICS), riskTier: 'moderate' },
      { maxIter: 2 }
    )
    // Assert
    expect(r.outcome).toBe('no-consensus')
    expect(r.proposal.recommend).toBe('hold')
  })
})
