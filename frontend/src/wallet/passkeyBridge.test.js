// frontend/src/wallet/passkeyBridge.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isVfWallet, ensureBaseOwner } from './passkeyBridge.js'

// Repo pattern (mirrors wallet/account.test.js): vitest's default environment here is 'node',
// which has no global localStorage. Stub it with a plain object-backed fake rather than adding a
// jsdom pragma, matching every other wallet unit test that touches localStorage.
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

describe('isVfWallet', () => {
  it('true only when the connected address is the stored VF contract', () => {
    localStorage.setItem('vf_wallet_contract', 'CVFWALLET')
    expect(isVfWallet('CVFWALLET')).toBe(true)
    expect(isVfWallet('GFREIGHTER')).toBe(false)
  })
})

describe('ensureBaseOwner', () => {
  const fakeAccount = {
    address: '0xOWNER',
    kernelAccount: {},
    publicClient: {},
    passkeyValidator: {},
  }
  it('runs register ceremony on first call, login on the next', async () => {
    const createBase = vi.fn().mockResolvedValue(fakeAccount)
    const first = await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    expect(createBase).toHaveBeenCalledWith(expect.objectContaining({ mode: 'register' }))
    expect(first.ownerMode).toBe('ceremony')
    // Register path persists the owner address so the dashboard can read positions later
    // without touching the passkey (see dashboardPositions.js).
    expect(localStorage.getItem('vf_base_owner_address')).toBe('0xOWNER')
    await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    expect(createBase).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'login' }))
    // Login path persists it too.
    expect(localStorage.getItem('vf_base_owner_address')).toBe('0xOWNER')
  })

  it('self-heals a corrupt stored record into a fresh register ceremony', async () => {
    localStorage.setItem('vf_base_owner', '{not valid json')
    const createBase = vi.fn().mockResolvedValue(fakeAccount)
    const out = await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    expect(createBase).toHaveBeenCalledWith(expect.objectContaining({ mode: 'register' }))
    expect(out.ownerMode).toBe('ceremony')
  })

  it('rejects with a clear message when connectedAddress is missing', async () => {
    await expect(ensureBaseOwner({ deps: { createBaseSmartAccount: vi.fn() } })).rejects.toThrow(
      'ensureBaseOwner: connectedAddress is required'
    )
  })

  it('cross-device: register refused (credential already exists) -> falls back to login, same account', async () => {
    // No stored record (fresh laptop) but the wallet's passkey exists on the phone/synced store.
    const createBase = vi
      .fn()
      .mockRejectedValueOnce(new Error('InvalidStateError: credential already registered'))
      .mockResolvedValueOnce(fakeAccount)
    const out = await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    expect(createBase).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: 'register' }))
    expect(createBase).toHaveBeenNthCalledWith(2, expect.objectContaining({ mode: 'login' }))
    expect(out.address).toBe('0xOWNER')
    expect(localStorage.getItem('vf_base_owner_address')).toBe('0xOWNER')
  })

  it('stale record: login fails (credential gone) -> falls back to a fresh register', async () => {
    localStorage.setItem('vf_base_owner', JSON.stringify({ mode: 'ceremony', passkeyName: 'x' }))
    const createBase = vi
      .fn()
      .mockRejectedValueOnce(new Error('NotAllowedError'))
      .mockResolvedValueOnce(fakeAccount)
    const out = await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      deps: { createBaseSmartAccount: createBase },
    })
    expect(createBase).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: 'login' }))
    expect(createBase).toHaveBeenNthCalledWith(2, expect.objectContaining({ mode: 'register' }))
    expect(out.address).toBe('0xOWNER')
  })

  it('preferLogin (recover path): starts with a discoverable login even with NO stored record', async () => {
    const createBase = vi.fn().mockResolvedValue(fakeAccount)
    await ensureBaseOwner({
      connectedAddress: 'GFREIGHTER',
      preferLogin: true,
      deps: { createBaseSmartAccount: createBase },
    })
    // Register-first here minted a brand-new empty kernel account on authenticators that
    // don't refuse duplicate creation — recovery must never create.
    expect(createBase).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: 'login' }))
    expect(localStorage.getItem('vf_base_owner_address')).toBe('0xOWNER')
  })

  it('double failure rethrows the ORIGINAL error (a cancel reads as a cancel)', async () => {
    const createBase = vi
      .fn()
      .mockRejectedValueOnce(new Error('original register failure'))
      .mockRejectedValueOnce(new Error('secondary login failure'))
    await expect(
      ensureBaseOwner({ connectedAddress: 'GFREIGHTER', deps: { createBaseSmartAccount: createBase } })
    ).rejects.toThrow('original register failure')
    // A failed resolution must not poison the record for the next attempt.
    expect(localStorage.getItem('vf_base_owner_address')).toBeNull()
  })
})
