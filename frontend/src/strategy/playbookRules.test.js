// frontend/src/strategy/playbookRules.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rulesForRole, ruleIdsForRole, allRuleIds, isValidRuleForRole } from './playbookRules.js'
import { upsertSeeds, addRule, retireRule } from './ruleStore.js'

describe('playbookRules (store-backed catalog)', () => {
  beforeEach(() => {
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
    upsertSeeds()
  })

  it('rulesForRole returns active rules for that role with id + description', () => {
    const r = rulesForRole('risk')
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]).toHaveProperty('id')
    expect(r[0]).toHaveProperty('description')
  })

  it('a grown rule shows up in its role; a retired rule does not', () => {
    addRule({ id: 'grown-x', role: 'market', text: 'New gas heuristic.', origin: 'grown' })
    expect(ruleIdsForRole('market')).toContain('grown-x')
    retireRule('mkt-gas-affordable')
    expect(ruleIdsForRole('market')).not.toContain('mkt-gas-affordable')
  })

  it('isValidRuleForRole rejects cross-role citation', () => {
    expect(isValidRuleForRole('risk', 'rsk-gates-clear')).toBe(true)
    expect(isValidRuleForRole('risk', 'mkt-gas-affordable')).toBe(false)
  })

  it('allRuleIds spans every role', () => {
    const ids = allRuleIds()
    expect(ids).toContain('yld-apy-attractive')
    expect(ids).toContain('rsk-turbulent-veto')
    expect(ids).toContain('mkt-gas-affordable')
  })
})
