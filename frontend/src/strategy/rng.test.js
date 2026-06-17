// frontend/src/strategy/rng.test.js
import { describe, it, expect } from 'vitest'
import { makeRng, gaussian } from './rng.js'

describe('makeRng', () => {
  it('is deterministic — same seed yields the same sequence', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('different seeds yield different sequences', () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)())
  })

  it('returns values in [0, 1)', () => {
    const rng = makeRng(7)
    for (let i = 0; i < 1000; i++) {
      const x = rng()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })
})

describe('gaussian', () => {
  it('large-sample mean approximates the requested mean', () => {
    const rng = makeRng(99)
    let sum = 0
    const N = 20000
    for (let i = 0; i < N; i++) sum += gaussian(rng, 5, 2)
    expect(Math.abs(sum / N - 5)).toBeLessThan(0.1)
  })

  it('is deterministic for a given seed', () => {
    expect(gaussian(makeRng(3))).toBe(gaussian(makeRng(3)))
  })
})
