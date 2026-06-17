// frontend/src/strategy/merge.test.js
import { describe, it, expect } from 'vitest'
import { mergePass, trigramCosine, MERGE_CFG } from './merge.js'

const rule = (over) => ({
  id: 'r', role: 'yield', category: 'strategy', text: 't',
  helpful: 0, harmful: 0, evals: 0, status: 'active', origin: 'grown', createdAt: 1, ...over,
})

describe('trigramCosine', () => {
  it('is 1.0 for identical text and lower for different text', () => {
    expect(trigramCosine('gas is high', 'gas is high')).toBeCloseTo(1.0, 5)
    expect(trigramCosine('gas is high now', 'gas is high right now')).toBeGreaterThan(0.6)
    expect(trigramCosine('deposit on uplift', 'turbulent regime veto')).toBeLessThan(0.3)
  })
})

describe('mergePass', () => {
  it('merges near-duplicate same-role rules: oldest id, summed counters', () => {
    const out = mergePass([
      rule({ id: 'old', text: 'Avoid deposits when gas is very high', helpful: 2, harmful: 1, evals: 3, createdAt: 1 }),
      rule({ id: 'new', text: 'Avoid deposits when gas is very high now', helpful: 3, harmful: 0, evals: 3, createdAt: 9 }),
    ])
    expect(out.length).toBe(1)
    expect(out[0].id).toBe('old')
    expect(out[0].helpful).toBe(5)
    expect(out[0].harmful).toBe(1)
    expect(out[0].evals).toBe(6)
  })

  it('never merges across roles even if text is identical', () => {
    const out = mergePass([
      rule({ id: 'a', role: 'yield', text: 'identical text here' }),
      rule({ id: 'b', role: 'risk', text: 'identical text here' }),
    ])
    expect(out.length).toBe(2)
  })

  it('a seed+grown collision keeps the seed origin', () => {
    const out = mergePass([
      rule({ id: 'seed-1', origin: 'seed', text: 'Gas cost is small relative to yield', createdAt: 1 }),
      rule({ id: 'grown-1', origin: 'grown', text: 'Gas cost is small relative to the yield', createdAt: 9 }),
    ])
    expect(out.length).toBe(1)
    expect(out[0].origin).toBe('seed')
    expect(out[0].id).toBe('seed-1')
  })

  it('leaves dissimilar rules untouched', () => {
    const out = mergePass([
      rule({ id: 'a', text: 'deposit on risk-adjusted uplift' }),
      rule({ id: 'b', text: 'withdraw in turbulent regime' }),
    ])
    expect(out.length).toBe(2)
  })

  it('exposes default config', () => {
    expect(MERGE_CFG.THRESHOLD).toBe(0.8)
  })
})
