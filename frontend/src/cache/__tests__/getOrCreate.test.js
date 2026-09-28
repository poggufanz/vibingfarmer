// frontend/src/cache/__tests__/getOrCreate.test.js
import { describe, it, expect, vi } from 'vitest'
import { createCache, mapWithLimit } from '../getOrCreate.js'

describe('createCache TTL', () => {
  it('serves a hit within TTL and misses after expiry', async () => {
    let t = 0
    const c = createCache({ ttlMs: 1_000, now: () => t })
    c.set('k', 'v')
    expect(c.get('k')).toBe('v')
    t = 1_001
    expect(c.get('k')).toBeUndefined()
  })

  it('treats a future-stamped entry (clock skew) as a miss, never current', () => {
    let t = 10_000
    const c = createCache({ ttlMs: 60_000, now: () => t })
    c.set('k', 'v')
    t = 9_000 // jam mundur: umur negatif
    expect(c.get('k')).toBeUndefined()
  })

  it('evicts the oldest insert past maxEntries', () => {
    const c = createCache({ ttlMs: 60_000, maxEntries: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
  })
})

describe('createCache getOrCreate (collapse requests)', () => {
  it('dedupes concurrent factories for the same key into one call', async () => {
    const c = createCache({ ttlMs: 60_000 })
    const factory = vi.fn(async () => 'v')
    const [a, b, d] = await Promise.all([
      c.getOrCreate('k', factory),
      c.getOrCreate('k', factory),
      c.getOrCreate('k', factory),
    ])
    expect([a, b, d]).toEqual(['v', 'v', 'v'])
    expect(factory).toHaveBeenCalledOnce()
  })

  it('does not cache null/undefined factory results', async () => {
    const c = createCache({ ttlMs: 60_000 })
    expect(await c.getOrCreate('k', async () => null)).toBeNull()
    const factory = vi.fn(async () => 'v')
    expect(await c.getOrCreate('k', factory)).toBe('v')
    expect(factory).toHaveBeenCalledOnce()
  })

  it('remove() forces the next read to refetch', async () => {
    const c = createCache({ ttlMs: 60_000 })
    c.set('k', 'old')
    c.remove('k')
    expect(c.get('k')).toBeUndefined()
  })
})

describe('mapWithLimit', () => {
  it('runs all items with bounded concurrency', async () => {
    let live = 0
    let peak = 0
    const out = await mapWithLimit([1, 2, 3, 4, 5], 2, async (n) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBeLessThanOrEqual(2)
  })
})
