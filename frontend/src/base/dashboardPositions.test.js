// frontend/src/base/dashboardPositions.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadBasePositions } from './dashboardPositions.js'
// The vitest env block (vite.config.js) overrides VITE_BASE_POOL_1_ADDRESS away from the
// hardcoded production default, so the real catalog address must be read at test time rather
// than hardcoded here (mirrors strategist.crosschain.test.js's BASE_ADDRESS pattern).
import { BASE_POOL_CATALOG } from '../config.js'
import { baseOwnerStorageKey } from '../wallet/baseBinding.js'

const OWNER = 'GUSER'

function seedOwner(stellarOwner, kernelAddress) {
  localStorage.setItem(
    baseOwnerStorageKey(stellarOwner),
    JSON.stringify({
      version: 2,
      stellarOwner,
      kernelAddress,
      passkeyName: 'x',
      createdAt: 1,
      updatedAt: 1,
    })
  )
}

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
    expect(
      await loadBasePositions({ stellarOwner: OWNER, deps: { readPositions: vi.fn() } })
    ).toEqual([])
  })

  it('returns [] without a stellarOwner (never a blind global read)', async () => {
    seedOwner(OWNER, '0xACC')
    expect(await loadBasePositions({ deps: { readPositions: vi.fn() } })).toEqual([])
  })

  it('maps positions with catalog pool names', async () => {
    seedOwner(OWNER, '0xACC')
    const readPositions = vi
      .fn()
      .mockResolvedValue([{ pool: BASE_POOL_CATALOG[0].address, shares: 5n, minAssets: 4n }])
    const out = await loadBasePositions({
      stellarOwner: OWNER,
      deps: { readPositions, makePublicClient: () => ({}) },
    })
    expect(out[0]).toMatchObject({ poolName: expect.stringContaining('Aave'), shares: 5n })
    expect(readPositions).toHaveBeenCalledWith(expect.objectContaining({ account: '0xACC' }))
  })

  it('returns [] on RPC failure (dashboard never crashes)', async () => {
    seedOwner(OWNER, '0xACC')
    const readPositions = vi.fn().mockRejectedValue(new Error('rpc down'))
    expect(
      await loadBasePositions({
        stellarOwner: OWNER,
        deps: { readPositions, makePublicClient: () => ({}) },
      })
    ).toEqual([])
  })

  it('a mandate/owner set up for a different Stellar wallet is not visible (wallet switch)', async () => {
    seedOwner('GOTHERWALLET', '0xOTHER')
    const readPositions = vi.fn()
    expect(
      await loadBasePositions({
        stellarOwner: OWNER,
        deps: { readPositions, makePublicClient: () => ({}) },
      })
    ).toEqual([])
    expect(readPositions).not.toHaveBeenCalled()
  })
})
