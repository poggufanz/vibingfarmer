// frontend/src/strategy/reflector.test.js
import { describe, it, expect, vi } from 'vitest'
import { reflect } from './reflector.js'

describe('reflect (ACE counter update)', () => {
  it('marks cited rules helpful on successful execution', () => {
    const inc = vi.fn()
    reflect({ verdict: 'keep', citedRules: ['yield-uplift', 'market-gas-positive'], outcome: 'success' }, { increment: inc })
    expect(inc).toHaveBeenCalledWith('yield-uplift', 'helpful')
    expect(inc).toHaveBeenCalledWith('market-gas-positive', 'helpful')
    expect(inc).toHaveBeenCalledTimes(2)
  })

  it('marks cited rules harmful on failed execution', () => {
    const inc = vi.fn()
    reflect({ verdict: 'keep', citedRules: ['yield-uplift'], outcome: 'failure' }, { increment: inc })
    expect(inc).toHaveBeenCalledWith('yield-uplift', 'harmful')
  })

  it('no-ops for discards or empty cited rules', () => {
    const inc = vi.fn()
    reflect({ verdict: 'discard', citedRules: ['x'], outcome: 'success' }, { increment: inc })
    reflect({ verdict: 'keep', citedRules: [], outcome: 'success' }, { increment: inc })
    expect(inc).not.toHaveBeenCalled()
  })

  it('never throws if playbook increment throws', () => {
    const inc = vi.fn(() => { throw new Error('storage') })
    expect(() => reflect({ verdict: 'keep', citedRules: ['x'], outcome: 'success' }, { increment: inc })).not.toThrow()
  })
})