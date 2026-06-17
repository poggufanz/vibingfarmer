// frontend/src/strategy/playbook.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { increment, weight, getCounters, clearPlaybook } from './playbook.js'
import { upsertSeeds } from './ruleStore.js'

describe('playbook (ACE counters)', () => {
  beforeEach(() => {
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
  })

  it('unknown rule is neutral weight 1.0', () => {
    expect(weight('yield-uplift')).toBe(1.0)
  })

  it('helpful increments raise weight above 1.0 (capped at 1.5)', () => {
    upsertSeeds()
    for (let i = 0; i < 10; i++) increment('yield-uplift', 'helpful')
    const w = weight('yield-uplift')
    expect(w).toBeGreaterThan(1.0)
    expect(w).toBeLessThanOrEqual(1.5)
  })

  it('harmful increments lower weight below 1.0 (floored at 0.5)', () => {
    upsertSeeds()
    for (let i = 0; i < 10; i++) increment('risk-calm-clear', 'harmful')
    const w = weight('risk-calm-clear')
    expect(w).toBeLessThan(1.0)
    expect(w).toBeGreaterThanOrEqual(0.5)
  })

  it('mixed history balances toward neutral', () => {
    upsertSeeds()
    increment('market-gas-positive', 'helpful')
    increment('market-gas-positive', 'harmful')
    expect(weight('market-gas-positive')).toBeCloseTo(1.0, 1)
  })

  it('getCounters round-trips and clearPlaybook resets', () => {
    upsertSeeds()
    increment('yield-uplift', 'helpful')
    expect(getCounters()['yield-uplift']).toEqual({ helpful: 1, harmful: 0 })
    clearPlaybook()
    expect(getCounters()).toEqual({})
  })

  it('never throws on corrupt storage', () => {
    localStorage.setItem('yv_playbook_v2', 'nope')
    expect(getCounters()).toEqual({})
    expect(() => increment('x', 'helpful')).not.toThrow()
    expect(weight('y')).toBe(1.0)
  })
})