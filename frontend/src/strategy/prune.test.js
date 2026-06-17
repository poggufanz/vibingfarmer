// frontend/src/strategy/prune.test.js
import { describe, it, expect } from 'vitest'
import { prunePass, PRUNE_CFG } from './prune.js'

const rule = (over) => ({
  id: 'r', role: 'yield', category: 'strategy', text: 't',
  helpful: 0, harmful: 0, evals: 0, status: 'active', origin: 'grown', createdAt: 1, ...over,
})

describe('prunePass', () => {
  it('keeps a rule below MIN_EVALS even if harmful-heavy', () => {
    const out = prunePass([rule({ helpful: 0, harmful: 3, evals: 3 })])
    expect(out.length).toBe(1)
  })

  it('hard-deletes a grown rule that is harmful >> helpful past MIN_EVALS', () => {
    const out = prunePass([rule({ helpful: 1, harmful: 6, evals: 7 })])
    expect(out.length).toBe(0)
  })

  it('retires (not deletes) a seed rule that underperforms', () => {
    const out = prunePass([rule({ origin: 'seed', helpful: 1, harmful: 6, evals: 7 })])
    expect(out.length).toBe(1)
    expect(out[0].status).toBe('retired')
  })

  it('does not prune a healthy rule', () => {
    const out = prunePass([rule({ helpful: 8, harmful: 1, evals: 9 })])
    expect(out[0].status).toBe('active')
    expect(out.length).toBe(1)
  })

  it('reactivates a retired rule that recovered (helpful >= harmful)', () => {
    const out = prunePass([rule({ origin: 'seed', status: 'retired', helpful: 5, harmful: 4, evals: 9 })])
    expect(out[0].status).toBe('active')
  })

  it('respects custom config', () => {
    const out = prunePass([rule({ helpful: 0, harmful: 3, evals: 3 })], { MIN_EVALS: 2, HARM_RATIO: 2 })
    expect(out.length).toBe(0)
  })

  it('exposes default config constants', () => {
    expect(PRUNE_CFG.MIN_EVALS).toBe(5)
    expect(PRUNE_CFG.HARM_RATIO).toBe(2)
  })
})
