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
    address: '0xOWNER', kernelAccount: {}, publicClient: {}, passkeyValidator: {},
  }
  it('runs register ceremony on first call, login on the next', async () => {
    const createBase = vi.fn().mockResolvedValue(fakeAccount)
    const first = await ensureBaseOwner({ connectedAddress: 'GFREIGHTER', deps: { createBaseSmartAccount: createBase } })
    expect(createBase).toHaveBeenCalledWith(expect.objectContaining({ mode: 'register' }))
    expect(first.ownerMode).toBe('ceremony')
    await ensureBaseOwner({ connectedAddress: 'GFREIGHTER', deps: { createBaseSmartAccount: createBase } })
    expect(createBase).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'login' }))
  })
})
