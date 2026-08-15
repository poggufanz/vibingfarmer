// frontend/src/wallet/passkeyBridge.binding.test.js
// VF Wallet Task 6 regression coverage for ensureBaseOwner's owner-scoped dual-write. Kept
// separate from passkeyBridge.test.js (owner-modified, left untouched by this task) per the
// task brief's worktree-collision note.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ensureBaseOwner } from './passkeyBridge.js'
import { readBaseOwner, baseOwnerStorageKey } from './baseBinding.js'

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

const fakeAccount = {
  address: '0xOWNER',
  kernelAccount: {},
  publicClient: {},
  passkeyValidator: {},
}

describe('ensureBaseOwner — owner-scoped v2 dual-write (VF Wallet Task 6)', () => {
  it('writes a BaseOwnerRecordV2 scoped to connectedAddress alongside the legacy keys', async () => {
    const createBase = vi.fn().mockResolvedValue(fakeAccount)
    await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    const record = readBaseOwner('GFREIGHTER')
    expect(record).toMatchObject({
      version: 2,
      stellarOwner: 'GFREIGHTER',
      kernelAddress: '0xOWNER',
    })
    expect(record.passkeyName).toMatch(/^vibing-farmer-base-/)
    expect(record.createdAt).toBe(record.updatedAt)
    // Legacy keys still present — no consumer has migrated off them by construction here.
    expect(localStorage.getItem('vf_base_owner_address')).toBe('0xOWNER')
    expect(localStorage.getItem('vf_base_owner')).not.toBeNull()
  })

  it('a second (login-mode) resolution preserves createdAt and only bumps updatedAt', async () => {
    const createBase = vi.fn().mockResolvedValue(fakeAccount)
    await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    const first = readBaseOwner('GFREIGHTER')
    // Simulate real elapsed time between the two ceremonies.
    await new Promise((r) => setTimeout(r, 5))
    await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    const second = readBaseOwner('GFREIGHTER')
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
  })

  it('owner A and owner B get independently-scoped records — no cross-talk', async () => {
    const createA = vi.fn().mockResolvedValue({ ...fakeAccount, address: '0xAAA' })
    const createB = vi.fn().mockResolvedValue({ ...fakeAccount, address: '0xBBB' })
    await ensureBaseOwner({
      connectedAddress: 'GOWNERA',
      deps: { createBaseSmartAccount: createA },
    })
    await ensureBaseOwner({
      connectedAddress: 'GOWNERB',
      deps: { createBaseSmartAccount: createB },
    })
    expect(readBaseOwner('GOWNERA').kernelAddress).toBe('0xAAA')
    expect(readBaseOwner('GOWNERB').kernelAddress).toBe('0xBBB')
  })

  it('a corrupt existing v2 record does not crash resolution — createdAt just defaults fresh', async () => {
    localStorage.setItem(baseOwnerStorageKey('GFREIGHTER'), '{not valid json')
    const createBase = vi.fn().mockResolvedValue(fakeAccount)
    const out = await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    expect(out.address).toBe('0xOWNER')
    expect(readBaseOwner('GFREIGHTER')).toMatchObject({ stellarOwner: 'GFREIGHTER' })
  })

  it('double failure (both modes reject) writes NEITHER the legacy address key NOR the v2 record', async () => {
    const createBase = vi
      .fn()
      .mockRejectedValueOnce(new Error('original register failure'))
      .mockRejectedValueOnce(new Error('secondary login failure'))
    await expect(
      ensureBaseOwner({
        connectedAddress: 'GFREIGHTER',
        deps: { createBaseSmartAccount: createBase },
      })
    ).rejects.toThrow('original register failure')
    expect(localStorage.getItem('vf_base_owner_address')).toBeNull()
    expect(readBaseOwner('GFREIGHTER')).toBeNull()
  })
})
