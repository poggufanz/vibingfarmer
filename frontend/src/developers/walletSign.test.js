import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the app's wallet plumbing — walletSign must delegate to it instead of
// importing @creit.tech/stellar-wallets-kit itself (walletKitLoader is the only
// allowed importer; a direct import broke /developers on kit v2.3.0).
vi.mock('../stellar/walletKit.js', () => ({
  connectWallet: vi.fn(async () => 'GCONNECTED'),
  getUserAddress: vi.fn(async () => 'GEXISTING'),
  signTxXdr: vi.fn(async (xdr) => `${xdr}:signed`),
}))

import { connectWallet } from './walletSign.js'
import { connectWallet as kitConnect, getUserAddress, signTxXdr } from '../stellar/walletKit.js'

beforeEach(() => {
  vi.clearAllMocks()
  getUserAddress.mockImplementation(async () => 'GEXISTING')
})

describe('developers walletSign', () => {
  it('reuses the already-connected wallet without opening the picker modal', async () => {
    const session = await connectWallet()
    expect(session.address).toBe('GEXISTING')
    expect(kitConnect).not.toHaveBeenCalled()
    expect(await session.signChallenge('XDR')).toBe('XDR:signed')
    expect(signTxXdr).toHaveBeenCalledWith('XDR')
  })

  it('falls back to the picker modal when no wallet is connected yet', async () => {
    getUserAddress.mockImplementation(async () => {
      throw new Error('no wallet selected')
    })
    const session = await connectWallet()
    expect(kitConnect).toHaveBeenCalled()
    expect(session.address).toBe('GCONNECTED')
  })

  it('rejects passkey smart accounts (C… address) with a clear SEP-10 explanation', async () => {
    getUserAddress.mockImplementation(async () => 'CCONTRACTWALLET')
    await expect(connectWallet()).rejects.toThrow(/classic wallet/i)
  })
})
