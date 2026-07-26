// frontend/src/base/dashboardPositions.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadDeviceBasePositions, loadIndexedBasePositions } from './dashboardPositions.js'
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

describe('loadDeviceBasePositions', () => {
  it('returns [] when no base owner has ever been created', async () => {
    expect(
      await loadDeviceBasePositions({ stellarOwner: OWNER, deps: { readPositions: vi.fn() } })
    ).toEqual([])
  })

  it('returns [] without a stellarOwner (never a blind global read)', async () => {
    seedOwner(OWNER, '0xACC')
    expect(await loadDeviceBasePositions({ deps: { readPositions: vi.fn() } })).toEqual([])
  })

  it('maps positions with catalog pool names, reading through loadIndexedBasePositions', async () => {
    seedOwner(OWNER, '0xACC')
    const readPositions = vi
      .fn()
      .mockResolvedValue([{ pool: BASE_POOL_CATALOG[0].address, shares: 5n, minAssets: 4n }])
    const out = await loadDeviceBasePositions({
      stellarOwner: OWNER,
      deps: { readPositions, makePublicClient: () => ({}) },
    })
    expect(out[0]).toMatchObject({ poolName: expect.stringContaining('Aave'), shares: 5n })
    // the ONE canonical account this device's own withdraw ceremony cares about -- never a
    // second, independently-derived kernel address.
    expect(readPositions).toHaveBeenCalledWith(expect.objectContaining({ account: '0xacc' }))
  })

  it('returns [] on RPC failure (dashboard never crashes)', async () => {
    seedOwner(OWNER, '0xACC')
    const readPositions = vi.fn().mockRejectedValue(new Error('rpc down'))
    expect(
      await loadDeviceBasePositions({
        stellarOwner: OWNER,
        deps: { readPositions, makePublicClient: () => ({}) },
      })
    ).toEqual([])
  })

  it('a mandate/owner set up for a different Stellar wallet is not visible (wallet switch)', async () => {
    seedOwner('GOTHERWALLET', '0xOTHER')
    const readPositions = vi.fn()
    expect(
      await loadDeviceBasePositions({
        stellarOwner: OWNER,
        deps: { readPositions, makePublicClient: () => ({}) },
      })
    ).toEqual([])
    expect(readPositions).not.toHaveBeenCalled()
  })

  it('never reintroduces the retired local-record-only reader as an export', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./dashboardPositions.js', import.meta.url), 'utf8')
    )
    expect(src).not.toMatch(/export\s+async\s+function\s+loadBasePositions/)
  })
})

// Task 7: a new device (no local BaseOwnerRecordV2, no passkey ceremony ever run here) must
// still be able to see confirmed historical Base custody, keyed off the exact kernel addresses
// Task 5's durable relayer-attested association already proved for this owner — never the local
// wallet record. loadDeviceBasePositions (above) is now built ON TOP of this reader (My Money
// Task 13), rather than duplicating its own gate.
describe('loadIndexedBasePositions', () => {
  it('reports empty (not unavailable, not a silent []) when there are no proven kernel addresses to check', async () => {
    const readPositions = vi.fn()
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: [],
      deps: { readPositions, makePublicClient: () => ({}) },
    })
    expect(out).toEqual({
      status: 'empty',
      accounts: [],
      failedAccounts: [],
      localKernelAddress: null,
    })
    expect(readPositions).not.toHaveBeenCalled()
  })

  it('reads public balances for a proven kernel address with no local record at all (new device)', async () => {
    const readPositions = vi
      .fn()
      .mockResolvedValue([
        { pool: BASE_POOL_CATALOG[0].address, shares: 5n, assets: 500_000n, minAssets: 495_000n },
      ])
    const readIdleUsdc = vi.fn().mockResolvedValue(1_000_000n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xKERNEL'],
      deps: { readPositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('known')
    expect(out.localKernelAddress).toBeNull()
    expect(out.accounts).toEqual([
      {
        kernelAddress: '0xkernel',
        positions: [
          { pool: BASE_POOL_CATALOG[0].address, shares: 5n, assets: 500_000n, minAssets: 495_000n },
        ],
        idleUsdc: 1_000_000n,
      },
    ])
  })

  it('a known-empty account (no positions, no idle) is still status known, not unavailable', async () => {
    const readPositions = vi.fn().mockResolvedValue([])
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xEMPTY'],
      deps: { readPositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('known')
    expect(out.accounts).toEqual([{ kernelAddress: '0xempty', positions: [], idleUsdc: 0n }])
  })

  it('reports unavailable when every account read fails, never a bare []', async () => {
    const readPositions = vi.fn().mockRejectedValue(new Error('rpc down'))
    const readIdleUsdc = vi.fn().mockRejectedValue(new Error('rpc down'))
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xA', '0xB'],
      deps: { readPositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out).toEqual({
      status: 'unavailable',
      accounts: [],
      failedAccounts: ['0xa', '0xb'],
      localKernelAddress: null,
    })
  })

  // Fix loop 1, Fix 5: `status: 'known'` used to mean "every account that succeeded", silently
  // dropping any address whose own read failed with no trace — a consumer summing `accounts`
  // could never tell the total was missing a kernel. The enum itself is unchanged (still no
  // partial status); the gap now rides along on `failedAccounts` instead.
  it('one account failing does not blank out an account that succeeded, and the failure rides along visibly (fix loop 1, Fix 5)', async () => {
    const readPositions = vi
      .fn()
      .mockImplementation(({ account }) =>
        account === '0xbad' ? Promise.reject(new Error('rpc down')) : Promise.resolve([])
      )
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xBAD', '0xGOOD'],
      deps: { readPositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('known')
    expect(out.accounts).toEqual([{ kernelAddress: '0xgood', positions: [], idleUsdc: 0n }])
    expect(out.failedAccounts).toEqual(['0xbad'])
  })

  // Fix loop 1, Fix 6: readIdleUsdc() (readPositions.js) fails soft to 0n internally on ANY RPC
  // error — readPositions.js/its test carry an unstaged owner diff this loop must not touch (see
  // fix brief), so the gap is closed at this seam instead: loadIndexedBasePositions no longer
  // uses that fail-soft default for its idle-USDC read; a failure surfaces as `idleUsdc: null`
  // (unknown), never a fabricated zero, even though the pool-position read for the same account
  // succeeded in the same allSettled round.
  it('an idle-USDC RPC failure surfaces as unknown (null), never a fabricated zero, even though positions succeeded (fix loop 1, Fix 6)', async () => {
    const readPositions = vi.fn().mockResolvedValue([])
    const publicClient = { readContract: vi.fn().mockRejectedValue(new Error('rpc down')) }
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xIDLEFAIL'],
      deps: { readPositions, makePublicClient: () => publicClient },
    })
    expect(out.status).toBe('known')
    expect(out.accounts).toEqual([{ kernelAddress: '0xidlefail', positions: [], idleUsdc: null }])
  })

  it("flags a mismatch when this device's CURRENT kernel differs from every proven kernel (still returns the proven data)", async () => {
    seedOwner(OWNER, '0xCURRENTKERNEL')
    const readPositions = vi.fn().mockResolvedValue([])
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      stellarOwner: OWNER,
      indexedBaseAccounts: ['0xHISTORICKERNEL'],
      deps: { readPositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('mismatched')
    expect(out.localKernelAddress).toBe('0xCURRENTKERNEL')
    expect(out.accounts).toEqual([
      { kernelAddress: '0xhistorickernel', positions: [], idleUsdc: 0n },
    ])
  })

  it('is known (not mismatched) when the local kernel IS one of the proven accounts', async () => {
    seedOwner(OWNER, '0xSAMEKERNEL')
    const readPositions = vi.fn().mockResolvedValue([])
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      stellarOwner: OWNER,
      indexedBaseAccounts: ['0xSameKernel'],
      deps: { readPositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('known')
  })
})
