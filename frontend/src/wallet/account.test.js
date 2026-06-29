import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPasskeyWallet, connectPasskeyWallet } from './account.js'

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

function fakeKit() {
  return {
    createWallet: vi.fn(async () => ({ contractId: 'CWALLET', credentialId: 'CRED1' })),
    connectWallet: vi.fn(async (opts) => ({ contractId: opts?.contractId ?? 'CWALLET' })),
  }
}

describe('passkey wallet account', () => {
  it('createPasskeyWallet returns ids and caches contractId locally', async () => {
    const kit = fakeKit()
    const out = await createPasskeyWallet({ appName: 'VF', userName: 'u', kit })
    expect(out).toEqual({ contractId: 'CWALLET', credentialId: 'CRED1' })
    expect(store['vf_wallet_contract']).toBe('CWALLET')
  })

  it('connectPasskeyWallet prefers the cached contractId (no indexer)', async () => {
    store['vf_wallet_contract'] = 'CCACHED'
    const kit = fakeKit()
    const out = await connectPasskeyWallet({ kit })
    expect(kit.connectWallet).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: 'CCACHED' })
    )
    expect(out.contractId).toBe('CCACHED')
  })
})
