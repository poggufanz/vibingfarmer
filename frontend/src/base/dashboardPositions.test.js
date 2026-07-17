// frontend/src/base/dashboardPositions.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadBasePositions } from './dashboardPositions.js'
// The vitest env block (vite.config.js) overrides VITE_BASE_POOL_1_ADDRESS away from the
// hardcoded production default, so the real catalog address must be read at test time rather
// than hardcoded here (mirrors strategist.crosschain.test.js's BASE_ADDRESS pattern).
import { BASE_POOL_CATALOG } from '../config.js'

// Repo pattern (mirrors wallet/passkeyBridge.test.js): vitest's default environment here is
// 'node', which has no global localStorage. Stub it with a plain object-backed fake rather than
// adding a jsdom pragma, matching every other wallet/base unit test that touches localStorage.
const store = {}
beforeEach(() => {
  for (const k in store) delete store[k]
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = v
    },
    removeItem: (k) => {
      delete store[k]
    },
  }
})

describe('loadBasePositions', () => {
  it('returns [] when no base owner has ever been created', async () => {
    expect(await loadBasePositions({ deps: { readPositions: vi.fn() } })).toEqual([])
  })

  it('maps positions with catalog pool names', async () => {
    localStorage.setItem('vf_base_owner', JSON.stringify({ mode: 'ceremony', passkeyName: 'x' }))
    localStorage.setItem('vf_base_owner_address', '0xACC')
    const readPositions = vi
      .fn()
      .mockResolvedValue([{ pool: BASE_POOL_CATALOG[0].address, shares: 5n, minAssets: 4n }])
    const out = await loadBasePositions({ deps: { readPositions, makePublicClient: () => ({}) } })
    expect(out[0]).toMatchObject({ poolName: expect.stringContaining('Aave'), shares: 5n })
  })

  it('returns [] on RPC failure (dashboard never crashes)', async () => {
    localStorage.setItem('vf_base_owner', JSON.stringify({ mode: 'ceremony', passkeyName: 'x' }))
    localStorage.setItem('vf_base_owner_address', '0xACC')
    const readPositions = vi.fn().mockRejectedValue(new Error('rpc down'))
    expect(
      await loadBasePositions({ deps: { readPositions, makePublicClient: () => ({}) } })
    ).toEqual([])
  })
})
