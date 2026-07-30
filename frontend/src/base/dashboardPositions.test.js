// frontend/src/base/dashboardPositions.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadDeviceBasePositions, loadIndexedBasePositions } from './dashboardPositions.js'
// The vitest env block (vite.config.js) overrides VITE_BASE_POOL_1_ADDRESS away from the
// hardcoded production default, so the real catalog address must be read at test time rather
// than hardcoded here (mirrors strategist.crosschain.test.js's BASE_ADDRESS pattern).
import { BASE_POOL_CATALOG } from '../config.js'
import { baseOwnerStorageKey } from '../wallet/baseBinding.js'

const OWNER = 'GUSER'
const POOL_A = BASE_POOL_CATALOG[0].address

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

// Task 10: loadIndexedBasePositions now delegates its actual on-chain valuation to
// baseChildPositions.js's readBasePositions (one pinned block per call) instead of readPositions.js's
// own per-account, unpinned reads (see dashboardPositions.js's header + R5/R3 in
// task-10-interface-notes.md). `deps.readBasePositions` replaces the old `deps.readPositions` seam
// everywhere in this file; readBasePositions.js itself is untouched and out of scope.
function knownResult(positions = [], blockNumber = 1n) {
  return { status: 'known', blockNumber, positions }
}

describe('loadDeviceBasePositions', () => {
  it('returns [] when no base owner has ever been created', async () => {
    expect(
      await loadDeviceBasePositions({ stellarOwner: OWNER, deps: { readBasePositions: vi.fn() } })
    ).toEqual([])
  })

  it('returns [] without a stellarOwner (never a blind global read)', async () => {
    seedOwner(OWNER, '0xACC')
    expect(await loadDeviceBasePositions({ deps: { readBasePositions: vi.fn() } })).toEqual([])
  })

  it('maps positions with catalog pool names, reading through loadIndexedBasePositions', async () => {
    seedOwner(OWNER, '0xACC')
    const readBasePositions = vi.fn().mockResolvedValue(
      knownResult([
        {
          kernelAddress: '0xacc',
          poolAddress: POOL_A.toLowerCase(),
          shares: 5n,
          assets: 5n,
          state: 'known',
        },
      ])
    )
    const out = await loadDeviceBasePositions({
      stellarOwner: OWNER,
      deps: { readBasePositions, makePublicClient: () => ({}) },
    })
    expect(out[0]).toMatchObject({ poolName: expect.stringContaining('Aave'), shares: 5n })
    // the ONE canonical account this device's own withdraw ceremony cares about -- never a
    // second, independently-derived kernel address.
    expect(readBasePositions).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: expect.arrayContaining([expect.objectContaining({ kernelAddress: '0xacc' })]),
      })
    )
  })

  it('returns [] on RPC failure (dashboard never crashes)', async () => {
    seedOwner(OWNER, '0xACC')
    // Review round 1, finding 13: a resolved {status:'unavailable'} exercises the CALLER'S own
    // status-check branch, not the `.catch` at dashboardPositions.js's own call site -- a genuine
    // rejection (a real client shape mismatch, e.g. a viem version bump dropping getBlockNumber)
    // is the actual production failure mode this file's "Never throws" header promise covers.
    const readBasePositions = vi.fn().mockRejectedValue(new Error('rpc down'))
    expect(
      await loadDeviceBasePositions({
        stellarOwner: OWNER,
        deps: { readBasePositions, makePublicClient: () => ({}) },
      })
    ).toEqual([])
  })

  it('a mandate/owner set up for a different Stellar wallet is not visible (wallet switch)', async () => {
    seedOwner('GOTHERWALLET', '0xOTHER')
    const readBasePositions = vi.fn()
    expect(
      await loadDeviceBasePositions({
        stellarOwner: OWNER,
        deps: { readBasePositions, makePublicClient: () => ({}) },
      })
    ).toEqual([])
    expect(readBasePositions).not.toHaveBeenCalled()
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
    const readBasePositions = vi.fn()
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: [],
      deps: { readBasePositions, makePublicClient: () => ({}) },
    })
    expect(out).toEqual({
      status: 'empty',
      accounts: [],
      failedAccounts: [],
      localKernelAddress: null,
    })
    expect(readBasePositions).not.toHaveBeenCalled()
  })

  it('reads public balances for a proven kernel address with no local record at all (new device)', async () => {
    const readBasePositions = vi.fn().mockResolvedValue(
      knownResult([
        {
          kernelAddress: '0xkernel',
          poolAddress: POOL_A.toLowerCase(),
          shares: 5n,
          assets: 500_000n,
          state: 'known',
        },
      ])
    )
    const readIdleUsdc = vi.fn().mockResolvedValue(1_000_000n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xKERNEL'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('known')
    expect(out.localKernelAddress).toBeNull()
    expect(out.accounts).toEqual([
      {
        kernelAddress: '0xkernel',
        positions: [
          {
            pool: POOL_A.toLowerCase(),
            shares: 5n,
            assets: 500_000n,
            minAssets: 497_500n, // 500_000 * 0.995
          },
        ],
        idleUsdc: 1_000_000n,
      },
    ])
  })

  it('a known-empty account (no positions, no idle) is still status known, not unavailable', async () => {
    const readBasePositions = vi.fn().mockResolvedValue(knownResult([]))
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xEMPTY'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('known')
    expect(out.accounts).toEqual([{ kernelAddress: '0xempty', positions: [], idleUsdc: 0n }])
  })

  it('a genuinely zero share balance never calls convertToAssets and is simply absent from positions', async () => {
    const readBasePositions = vi.fn().mockResolvedValue(
      knownResult([
        {
          kernelAddress: '0xkernel',
          poolAddress: POOL_A.toLowerCase(),
          shares: 0n,
          assets: 0n,
          state: 'known',
        },
      ])
    )
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xkernel'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.accounts).toEqual([{ kernelAddress: '0xkernel', positions: [], idleUsdc: 0n }])
  })

  it('reports unavailable when the shared block/position read resolves unavailable, never a bare []', async () => {
    const readBasePositions = vi
      .fn()
      .mockResolvedValue({ status: 'unavailable', blockNumber: null, positions: [] })
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xA', '0xB'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out).toEqual({
      status: 'unavailable',
      accounts: [],
      failedAccounts: ['0xa', '0xb'],
      localKernelAddress: null,
    })
  })

  // Review round 1, finding 13: nothing in the suite exercised the `.catch` at
  // dashboardPositions.js's own `readBasePositions({...}).catch(...)` call site -- deleting it
  // left every test green because they all injected a RESOLVED unavailable status instead of a
  // genuine rejection.
  it('reports unavailable (never throws) when readBasePositions itself rejects', async () => {
    const readBasePositions = vi.fn().mockRejectedValue(new Error('rpc down'))
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xA', '0xB'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out).toEqual({
      status: 'unavailable',
      accounts: [],
      failedAccounts: ['0xa', '0xb'],
      localKernelAddress: null,
    })
  })

  // Fix loop 1, Fix 5 (still true under Task 10's batched read): `status: 'known'` used to mean
  // "every account that succeeded", silently dropping any address whose own read failed with no
  // trace — a consumer summing `accounts` could never tell the total was missing a kernel. The
  // enum itself is unchanged (still no partial status); the gap now rides along on
  // `failedAccounts` instead. Under the new batched readBasePositions, one kernel's OWN pool read
  // coming back `state:'unavailable'` demotes just that kernel, not its sibling.
  it('one account failing does not blank out an account that succeeded, and the failure rides along visibly (fix loop 1, Fix 5)', async () => {
    const readBasePositions = vi.fn().mockResolvedValue(
      knownResult([
        {
          kernelAddress: '0xbad',
          poolAddress: POOL_A.toLowerCase(),
          shares: null,
          assets: null,
          state: 'unavailable',
        },
      ])
    )
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xBAD', '0xGOOD'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
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
  // succeeded in the same round.
  it('an idle-USDC RPC failure surfaces as unknown (null), never a fabricated zero, even though positions succeeded (fix loop 1, Fix 6)', async () => {
    const readBasePositions = vi.fn().mockResolvedValue(knownResult([]))
    const publicClient = { readContract: vi.fn().mockRejectedValue(new Error('rpc down')) }
    const out = await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xIDLEFAIL'],
      deps: { readBasePositions, makePublicClient: () => publicClient },
    })
    expect(out.status).toBe('known')
    expect(out.accounts).toEqual([{ kernelAddress: '0xidlefail', positions: [], idleUsdc: null }])
  })

  it("flags a mismatch when this device's CURRENT kernel differs from every proven kernel (still returns the proven data)", async () => {
    seedOwner(OWNER, '0xCURRENTKERNEL')
    const readBasePositions = vi.fn().mockResolvedValue(knownResult([]))
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      stellarOwner: OWNER,
      indexedBaseAccounts: ['0xHISTORICKERNEL'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('mismatched')
    expect(out.localKernelAddress).toBe('0xCURRENTKERNEL')
    expect(out.accounts).toEqual([
      { kernelAddress: '0xhistorickernel', positions: [], idleUsdc: 0n },
    ])
  })

  it('is known (not mismatched) when the local kernel IS one of the proven accounts', async () => {
    seedOwner(OWNER, '0xSAMEKERNEL')
    const readBasePositions = vi.fn().mockResolvedValue(knownResult([]))
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    const out = await loadIndexedBasePositions({
      stellarOwner: OWNER,
      indexedBaseAccounts: ['0xSameKernel'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(out.status).toBe('known')
  })

  it('passes every kernel x catalog-pool pair to readBasePositions in a single call (one shared block)', async () => {
    const readBasePositions = vi.fn().mockResolvedValue(knownResult([]))
    const readIdleUsdc = vi.fn().mockResolvedValue(0n)
    await loadIndexedBasePositions({
      indexedBaseAccounts: ['0xA', '0xB'],
      deps: { readBasePositions, readIdleUsdc, makePublicClient: () => ({}) },
    })
    expect(readBasePositions).toHaveBeenCalledTimes(1)
    const { groups } = readBasePositions.mock.calls[0][0]
    expect(groups).toHaveLength(2 * BASE_POOL_CATALOG.length)
  })
})
