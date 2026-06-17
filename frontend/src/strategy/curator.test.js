// frontend/src/strategy/curator.test.js
import { describe, it, expect, vi } from 'vitest'
import { proposeRule } from './curator.js'

function fakeStore(initial = []) {
  let rules = [...initial]
  return {
    getRules: () => rules,
    addRule: (r) => { if (!rules.some((x) => x.id === r.id)) rules = [...rules, { helpful: 0, harmful: 0, evals: 0, status: 'active', createdAt: Date.now(), ...r }] },
    replaceAll: (next) => { rules = next },
    _rules: () => rules,
  }
}

const ctx = { role: 'market', outcome: 'failure', concerns: ['gas exceeded gain'], turbulence: 'elevated', reason: 'execute reverted' }

describe('proposeRule', () => {
  it('adds a grown rule from a valid Venice JSON delta', async () => {
    const store = fakeStore()
    const ask = vi.fn(async () => ({ role: 'market', text: 'Skip deposits when gas exceeds the projected gain.' }))
    await proposeRule(ctx, { ask, store })
    const added = store._rules().find((r) => r.origin === 'grown')
    expect(added).toBeTruthy()
    expect(added.role).toBe('market')
    expect(added.category).toBe('gas')
    expect(added.status).toBe('active')
  })

  it('no-ops when Venice returns bad JSON / null', async () => {
    const store = fakeStore()
    const ask = vi.fn(async () => null)
    await proposeRule(ctx, { ask, store })
    expect(store._rules().length).toBe(0)
  })

  it('no-ops and never throws when Venice rejects', async () => {
    const store = fakeStore()
    const ask = vi.fn(async () => { throw new Error('timeout') })
    await expect(proposeRule(ctx, { ask, store })).resolves.toBeUndefined()
    expect(store._rules().length).toBe(0)
  })

  it('a proposed near-duplicate is merged, not double-added', async () => {
    const store = fakeStore([
      { id: 'mkt-gas-affordable', role: 'market', category: 'gas', text: 'Entry gas cost is small relative to expected yield.', helpful: 2, harmful: 0, evals: 2, status: 'active', origin: 'seed', createdAt: 1 },
    ])
    const ask = vi.fn(async () => ({ role: 'market', text: 'Entry gas cost is small relative to the expected yield.' }))
    await proposeRule(ctx, { ask, store })
    const market = store._rules().filter((r) => r.role === 'market')
    expect(market.length).toBe(1)
    expect(market[0].origin).toBe('seed') // seed survives the merge
  })

  it('ignores a delta whose role is missing or invalid', async () => {
    const store = fakeStore()
    const ask = vi.fn(async () => ({ text: 'no role here' }))
    await proposeRule(ctx, { ask, store })
    expect(store._rules().length).toBe(0)
  })
})
