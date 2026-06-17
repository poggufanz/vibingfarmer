import { describe, it, expect } from 'vitest'
import { SEED_RULES, roleToCategory } from './seeds.js'

describe('seeds', () => {
  it('every seed has the required record shape', () => {
    for (const s of SEED_RULES) {
      expect(s).toMatchObject({
        id: expect.any(String),
        role: expect.stringMatching(/^(yield|risk|market)$/),
        category: expect.stringMatching(/^(strategy|risk|gas)$/),
        text: expect.any(String),
        origin: 'seed',
      })
      expect(s.text.length).toBeGreaterThan(0)
    }
  })

  it('covers BOTH id namespaces (catalog + council inline)', () => {
    const ids = SEED_RULES.map((r) => r.id)
    // playbookRules.js catalog ids
    expect(ids).toContain('yld-apy-attractive')
    expect(ids).toContain('rsk-turbulent-veto')
    expect(ids).toContain('mkt-gas-affordable')
    // council.js inline ids
    expect(ids).toContain('yield-uplift')
    expect(ids).toContain('risk-turbulent-veto')
    expect(ids).toContain('market-gas-positive')
  })

  it('ids are unique', () => {
    const ids = SEED_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('maps role to display category', () => {
    expect(roleToCategory('yield')).toBe('strategy')
    expect(roleToCategory('risk')).toBe('risk')
    expect(roleToCategory('market')).toBe('gas')
    expect(roleToCategory('unknown')).toBe('strategy')
  })

  it('category always matches roleToCategory(role)', () => {
    for (const s of SEED_RULES) expect(s.category).toBe(roleToCategory(s.role))
  })
})
