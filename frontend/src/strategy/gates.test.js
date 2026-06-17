// frontend/src/strategy/gates.test.js
import { describe, it, expect } from 'vitest'
import {
  turbulenceGate, gasGate, capitalGate, universeGate, evaluateGates, OFFENSIVE_KINDS,
} from './gates.js'

// Minimal hand-built StrategyState — gates must not depend on buildStrategyState.
function makeState(over = {}) {
  return {
    capital: { amountUsdc: 1000, heldUsdc: 0 },
    profile: { riskLevel: 'high', numVaults: 3 },
    market: { turbulence: 'calm', signals: [] },
    universe: [
      { address: '0xA', riskTier: 'low' },
      { address: '0xB', riskTier: 'high' },
    ],
    ...over,
  }
}
const deposit = { kind: 'deposit', proposed: [] }
const rebalance = { kind: 'rebalance', proposed: [] }
const harvest = { kind: 'harvest' }

describe('turbulenceGate', () => {
  it('blocks an offensive idea in a turbulent market', () => {
    const r = turbulenceGate(makeState({ market: { turbulence: 'turbulent', signals: [] } }), deposit)
    expect(r.passed).toBe(false)
    expect(r.id).toBe('turbulence')
  })
  it('lets a defensive idea (harvest) through even when turbulent', () => {
    const r = turbulenceGate(makeState({ market: { turbulence: 'turbulent', signals: [] } }), harvest)
    expect(r.passed).toBe(true)
  })
  it('passes offensive ideas when calm', () => {
    expect(turbulenceGate(makeState(), deposit).passed).toBe(true)
  })
})

describe('gasGate', () => {
  it('blocks an offensive idea when a gas-spike signal is present', () => {
    const r = gasGate(makeState({ market: { turbulence: 'calm', signals: ['gas-spike'] } }), rebalance)
    expect(r.passed).toBe(false)
    expect(r.id).toBe('gas')
  })
  it('passes defensive ideas during a gas spike', () => {
    const r = gasGate(makeState({ market: { turbulence: 'calm', signals: ['gas-spike'] } }), harvest)
    expect(r.passed).toBe(true)
  })
  it('passes when no gas-spike signal', () => {
    expect(gasGate(makeState(), deposit).passed).toBe(true)
  })
})

describe('capitalGate', () => {
  it('blocks an offensive idea with no deployable capital', () => {
    const r = capitalGate(makeState({ capital: { amountUsdc: 0, heldUsdc: 0 } }), deposit)
    expect(r.passed).toBe(false)
    expect(r.id).toBe('capital')
  })
  it('passes defensive ideas regardless of capital', () => {
    expect(capitalGate(makeState({ capital: { amountUsdc: 0, heldUsdc: 0 } }), harvest).passed).toBe(true)
  })
})

describe('universeGate', () => {
  it('blocks when no vault sits within the risk ceiling', () => {
    // turbulent ceiling = 'low'; universe has only a 'high' vault → no legal allocation
    const state = makeState({
      market: { turbulence: 'turbulent', signals: [] },
      universe: [{ address: '0xB', riskTier: 'high' }],
    })
    const r = universeGate(state, deposit)
    expect(r.passed).toBe(false)
    expect(r.id).toBe('universe')
  })
  it('passes when at least one vault is within ceiling', () => {
    expect(universeGate(makeState(), deposit).passed).toBe(true)
  })
})

describe('evaluateGates', () => {
  it('passes a clean offensive idea in a calm market', () => {
    const r = evaluateGates(makeState(), deposit)
    expect(r.passed).toBe(true)
    expect(r.blockedBy).toBe(null)
    expect(r.results).toHaveLength(4)
  })
  it('fails fast on turbulence before reaching later gates', () => {
    const state = makeState({ market: { turbulence: 'turbulent', signals: ['gas-spike'] }, capital: { amountUsdc: 0, heldUsdc: 0 } })
    const r = evaluateGates(state, deposit)
    expect(r.passed).toBe(false)
    expect(r.blockedBy).toBe('turbulence') // first gate in order wins
    expect(typeof r.reason).toBe('string')
  })
  it('always passes a defensive idea (only-sell-allowed analog)', () => {
    const state = makeState({ market: { turbulence: 'turbulent', signals: ['gas-spike'] }, capital: { amountUsdc: 0, heldUsdc: 0 } })
    expect(evaluateGates(state, harvest).passed).toBe(true)
  })
  it('exposes the offensive kinds it guards', () => {
    expect(OFFENSIVE_KINDS).toEqual(['deposit', 'rebalance'])
  })
})
