// frontend/src/strategy/vaultFactsLive.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { primeVaultFacts, getLiveOverlay, _test } from './vaultFactsLive.js'
import { resolve } from './vaultFacts.js'

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
    const fetchImpl = vi.fn(async (url) => ({ ok: true, json: async () => 42_000_000 }))
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
})
