// frontend/src/strategy/vaultFactsLive.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { primeVaultFacts, getLiveOverlay, _test } from '../vaultFactsLive.js'
import { resolve } from '../vaultFacts.js'

function memStorage() {
  const m = new Map()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  }
}

describe('vaultFactsLive', () => {
  beforeEach(() => _test.reset())

  it('fetches DeFiLlama TVL per catalog slug and exposes an overlay', async () => {
    const fetchImpl = vi.fn(async (_url) => ({ ok: true, json: async () => 42_000_000 }))
    await primeVaultFacts({ fetchImpl, storage: memStorage(), now: () => 1_000 })
    const overlay = getLiveOverlay('aave-v3')
    expect(overlay.refreshed.tvl).toBe(42_000_000)
    expect(overlay.asOf).toBe(1_000)
    expect(fetchImpl.mock.calls.map(([u]) => u)).toContain('https://api.llama.fi/tvl/aave-v3')
  })

  it('resolve() merges live tvl with source:live; qualitative facts stay snapshot', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => 42_000_000 }))
    await primeVaultFacts({ fetchImpl, storage: memStorage(), now: () => 1_000 })
    const { facts } = resolve('aave-v3')
    expect(facts.tvl).toEqual({ value: 42_000_000, source: 'live', asOf: 1_000 })
    expect(facts.audit.source).toBe('snapshot') // curated, never live-fetched
  })

  it('fetch failure -> no overlay, snapshot provenance intact (never crashes the gate)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    await primeVaultFacts({ fetchImpl, storage: memStorage(), now: () => 1_000 })
    expect(getLiveOverlay('aave-v3')).toBeNull()
    expect(resolve('aave-v3').facts.tvl.source).toBe('snapshot')
  })

  it('6h TTL cache: second prime within TTL does not refetch; after TTL it does', async () => {
    const storage = memStorage()
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => 1 }))
    await primeVaultFacts({ fetchImpl, storage, now: () => 0 })
    const n = fetchImpl.mock.calls.length
    await primeVaultFacts({ fetchImpl, storage, now: () => 5 * 60 * 60 * 1000 }) // +5h
    expect(fetchImpl.mock.calls.length).toBe(n) // served from cache
    await primeVaultFacts({ fetchImpl, storage, now: () => 7 * 60 * 60 * 1000 }) // +7h
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(n)
  })

  it('fixture protocols are never fetched', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => 1 }))
    await primeVaultFacts({ fetchImpl, storage: memStorage(), now: () => 0 })
    expect(fetchImpl.mock.calls.map(([u]) => u).some((u) => u.includes('hyperfarm'))).toBe(false)
  })
  it('rejects an unversioned envelope (pre-versioning shape) as a miss, never trusted data', async () => {
    const storage = memStorage()
    storage.setItem('vf_vault_facts_live_v1', JSON.stringify({ fetchedAt: 0, overlays: {} }))
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => 7 }))
    await primeVaultFacts({ fetchImpl, storage, now: () => 1_000 })
    expect(fetchImpl).toHaveBeenCalled() // cache miss -> refetch
    expect(getLiveOverlay('aave-v3').refreshed.tvl).toBe(7)
  })

  it('rejects a future-stamped envelope (clock skew) as a miss', async () => {
    const storage = memStorage()
    storage.setItem(
      'vf_vault_facts_live_v1',
      JSON.stringify({ version: 1, fetchedAt: 10_000_000, overlays: {} })
    )
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => 9 }))
    await primeVaultFacts({ fetchImpl, storage, now: () => 1_000 })
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('rejects a partially-corrupt overlay map instead of trusting its good half', async () => {
    const storage = memStorage()
    storage.setItem(
      'vf_vault_facts_live_v1',
      JSON.stringify({
        version: 1,
        fetchedAt: 500,
        overlays: {
          'aave-v3': { refreshed: { tvl: 42 }, asOf: 500 },
          'blend-usdc': { refreshed: { tvl: 'NaN-bogus' }, asOf: 500 },
        },
      })
    )
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => 11 }))
    await primeVaultFacts({ fetchImpl, storage, now: () => 1_000 })
    expect(fetchImpl).toHaveBeenCalled() // whole envelope distrusted, not partially trusted
  })

  it('a total fetch failure after a success drops the overlay (snapshot, never stale-live)', async () => {
    const storage = memStorage()
    await primeVaultFacts({
      fetchImpl: async () => ({ ok: true, json: async () => 42_000_000 }),
      storage,
      now: () => 1_000,
    })
    expect(getLiveOverlay('aave-v3')).not.toBeNull()
    _test.reset()
    // Storage kosong + fetch gagal total -> tidak ada overlay basi yang disajikan sebagai live.
    await primeVaultFacts({
      fetchImpl: async () => {
        throw new Error('offline')
      },
      storage: memStorage(),
      now: () => 2_000,
    })
    expect(getLiveOverlay('aave-v3')).toBeNull()
    expect(resolve('aave-v3').facts.tvl.source).toBe('snapshot')
  })

  it('collapses concurrent primes into a single fetch fan-out', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return { ok: true, json: async () => 5 }
    })
    const storage = memStorage()
    await Promise.all([
      primeVaultFacts({ fetchImpl, storage, now: () => 1_000 }),
      primeVaultFacts({ fetchImpl, storage, now: () => 1_000 }),
    ])
    // 5 slug non-fixture x 1 fan-out, bukan x2.
    expect(fetchImpl.mock.calls.length).toBe(calls)
    expect(calls).toBe(5)
  })
})
