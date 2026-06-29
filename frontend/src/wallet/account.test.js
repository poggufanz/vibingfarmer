import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPasskeyWallet, connectPasskeyWallet, sendToken, depositToVault, addAgentSigner } from './account.js'

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

  it('sendToken builds an unsigned token transfer XDR scoped to the passkey account', async () => {
    const kit = { wallet: { transfer: vi.fn(async () => ({ xdr: 'TXDR' })) } }
    const out = await sendToken({ contractId: 'CWALLET', to: 'CDEST', amount: 5n, kit })
    expect(out.xdr).toBe('TXDR')
  })

  it('depositToVault refuses to build when F8 says ineligible (fail-closed)', async () => {
    const eligibility = vi.fn(async () => ({ allow: false, reasons: ['stale facts'] }))
    await expect(
      depositToVault({ contractId: 'CWALLET', amount: 10n, eligibility })
    ).rejects.toThrow(/ineligible|not eligible/i)
  })

  it('depositToVault builds an unsigned vault deposit when eligible', async () => {
    const eligibility = vi.fn(async () => ({ allow: true, reasons: [] }))
    const kit = { wallet: { deposit: vi.fn(async () => ({ xdr: 'DXDR' })) } }
    const out = await depositToVault({ contractId: 'CWALLET', amount: 10n, eligibility, kit })
    expect(out.xdr).toBe('DXDR')
  })
})

it('addAgentSigner attaches the ed25519 agent under a scoped context rule', async () => {
  const kit = {
    rules: { create: vi.fn(async () => ({ contextRuleId: 3 })) },
    signers: { addDelegated: vi.fn(async () => ({ ok: true })) },
  }
  const out = await addAgentSigner({ agentAddress: 'GAGENT', cap: 100n, vault: 'CVAULT', expiry: 999, kit })
  expect(kit.signers.addDelegated).toHaveBeenCalledWith(3, 'GAGENT')
  expect(out.ok).toBe(true)
})
