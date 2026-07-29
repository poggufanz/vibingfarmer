import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

const USER = Keypair.random().publicKey()

// Mock the lazy-loaded kit accessor so no real WebComponent/window code runs in jsdom.
const mockKit = {
  authModal: vi.fn(async () => ({ address: USER })),
  getAddress: vi.fn(async () => ({ address: USER })),
  signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED_XDR' })),
}
vi.mock('./walletKitLoader.js', () => ({ loadKit: vi.fn(async () => mockKit) }))

import {
  connectActiveAccount,
  connectWallet,
  getUserAddress,
  signReviewedTransaction,
  signTxXdr,
} from './walletKit.js'

describe('user wallet connector', () => {
  beforeEach(() => vi.clearAllMocks())

  it('connectWallet opens the modal and returns the chosen address', async () => {
    const addr = await connectWallet()
    expect(mockKit.authModal).toHaveBeenCalledOnce()
    expect(addr).toBe(USER)
  })

  it('getUserAddress returns the active address', async () => {
    expect(await getUserAddress()).toBe(USER)
  })

  it('signTxXdr signs with the pinned testnet passphrase + active address', async () => {
    const out = await signTxXdr('UNSIGNED_XDR')
    expect(out).toBe('SIGNED_XDR')
    const [xdr, opts] = mockKit.signTransaction.mock.calls[0]
    expect(xdr).toBe('UNSIGNED_XDR')
    expect(opts.networkPassphrase).toBe('Test SDF Network ; September 2015')
    expect(opts.address).toBe(USER)
  })

  it('connectActiveAccount returns the immutable address/network/connector/epoch capability', async () => {
    const account = await connectActiveAccount({ connectorId: 'freighter' })
    expect(account).toMatchObject({
      version: 1,
      kind: 'G',
      address: USER,
      networkPassphrase: 'Test SDF Network ; September 2015',
      connectorId: 'freighter',
    })
    expect(Object.isFrozen(account)).toBe(true)
  })

  it('rejects a signed envelope whose reported signer differs from the reviewed account', async () => {
    const address = Keypair.random().publicKey()
    const tx = new TransactionBuilder(new Account(address, '1'), {
      fee: '100',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build()
    const xdr = tx.toEnvelope().toXDR('base64')
    const activeAccount = Object.freeze({
      version: 1,
      kind: 'G',
      address,
      networkPassphrase: 'Test SDF Network ; September 2015',
      connectorId: 'freighter',
      epoch: 1,
    })
    const kit = {
      getAddress: vi.fn(async () => ({ address: activeAccount.address })),
      signTransaction: vi.fn(async () => ({
        signedTxXdr: xdr,
        signerAddress: 'GANOTHER',
        networkPassphrase: activeAccount.networkPassphrase,
      })),
    }

    await expect(
      signReviewedTransaction({
        xdr,
        activeAccount,
        reviewedTxHash: tx.hash().toString('hex'),
        kit,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
  })

  it('rejects a C contract as a classic transaction signer', async () => {
    await expect(
      signReviewedTransaction({
        xdr: 'not-used',
        activeAccount: Object.freeze({
          version: 1,
          kind: 'C',
          address: 'CNOTCLASSICSOURCE',
          networkPassphrase: 'Test SDF Network ; September 2015',
          connectorId: 'vf-wallet',
          epoch: 1,
        }),
        reviewedTxHash: 'not-used',
      })
    ).rejects.toThrow(/authorizer/i)
  })
})
