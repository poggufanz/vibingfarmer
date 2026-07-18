import { describe, it, expect, vi } from 'vitest'
import { burnViaWallet } from './burnViaWallet.js'

describe('burnViaWallet', () => {
  it('submits approve then deposit_for_burn, each signed by the wallet adapter', async () => {
    const calls = []
    const deps = {
      buildAndSubmit: vi.fn(async ({ method }) => {
        calls.push(method)
        return { hash: `${method}-hash` }
      }),
    }
    const signTx = vi.fn(async (xdr) => xdr)
    const out = await burnViaWallet({
      contractId: 'GUSER',
      amountUnits: 10_000_000n,
      baseRecipientAddress: '0x34a3d1c79aD4b3030f5C3c264774D3869f16034F',
      signTx,
      deps,
    })
    expect(calls).toEqual(['approve', 'deposit_for_burn'])
    expect(out).toEqual({ approveHash: 'approve-hash', burnHash: 'deposit_for_burn-hash' })
  })
  it('throws before ANY submit on a malformed base recipient', async () => {
    const deps = { buildAndSubmit: vi.fn() }
    await expect(
      burnViaWallet({
        contractId: 'GUSER',
        amountUnits: 1n,
        baseRecipientAddress: 'not-hex',
        signTx: vi.fn(),
        deps,
      })
    ).rejects.toThrow()
    expect(deps.buildAndSubmit).not.toHaveBeenCalled()
  })
})
