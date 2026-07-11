import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the lazy-loaded kit accessor so no real WebComponent/window code runs in jsdom.
const mockKit = {
  authModal: vi.fn(async () => ({ address: 'GUSER...' })),
  getAddress: vi.fn(async () => ({ address: 'GUSER...' })),
  signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED_XDR' })),
}
vi.mock('./walletKitLoader.js', () => ({ loadKit: vi.fn(async () => mockKit) }))

import { connectWallet, getUserAddress, signTxXdr } from './walletKit.js'

describe('user wallet connector', () => {
  beforeEach(() => vi.clearAllMocks())

  it('connectWallet opens the modal and returns the chosen address', async () => {
    const addr = await connectWallet()
    expect(mockKit.authModal).toHaveBeenCalledOnce()
    expect(addr).toBe('GUSER...')
  })

  it('getUserAddress returns the active address', async () => {
    expect(await getUserAddress()).toBe('GUSER...')
  })

  it('signTxXdr signs with the pinned testnet passphrase + active address', async () => {
    const out = await signTxXdr('UNSIGNED_XDR')
    expect(out).toBe('SIGNED_XDR')
    const [xdr, opts] = mockKit.signTransaction.mock.calls[0]
    expect(xdr).toBe('UNSIGNED_XDR')
    expect(opts.networkPassphrase).toBe('Test SDF Network ; September 2015')
    expect(opts.address).toBe('GUSER...')
  })
})
