import { describe, it, expect, vi } from 'vitest'

// Mock the app's wallet plumbing — walletSign must delegate to it instead of
// importing @creit.tech/stellar-wallets-kit itself (walletKitLoader is the only
// allowed importer; a direct import broke /developers on kit v2.3.0).
vi.mock('../stellar/walletKit.js', () => ({
  connectWallet: vi.fn(async () => 'GCONNECTED'),
  signTxXdr: vi.fn(async (xdr) => `${xdr}:signed`),
}))

import { connectWallet } from './walletSign.js'
import { connectWallet as kitConnect, signTxXdr } from '../stellar/walletKit.js'

describe('developers walletSign', () => {
  it('connectWallet returns the kit address plus a signChallenge delegate', async () => {
    const session = await connectWallet()
    expect(kitConnect).toHaveBeenCalled()
    expect(session.address).toBe('GCONNECTED')
    expect(await session.signChallenge('XDR')).toBe('XDR:signed')
    expect(signTxXdr).toHaveBeenCalledWith('XDR')
  })
})
