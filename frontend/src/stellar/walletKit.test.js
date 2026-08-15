import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

const TESTNET = 'Test SDF Network ; September 2015'
const PUBLIC = 'Public Global Stellar Network ; September 2015'
const USER = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()

function transaction(address = USER, bumpTo = '2') {
  return new TransactionBuilder(new Account(address, '1'), {
    fee: '100',
    networkPassphrase: TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo }))
    .setTimeout(30)
    .build()
}

let selectedModule
const eventHandlers = new Map()
const moduleHandlers = new Map()
const freighter = {
  productId: 'freighter',
  getAddress: vi.fn(async () => ({ address: USER })),
  getNetwork: vi.fn(async () => ({ network: 'TESTNET', networkPassphrase: TESTNET })),
  signTransaction: vi.fn(),
  on: vi.fn((name, listener) => {
    moduleHandlers.set(name, listener)
    return () => moduleHandlers.delete(name)
  }),
}
const kitClient = {
  authModal: vi.fn(async () => ({ address: USER })),
  getAddress: vi.fn(async () => selectedModule.getAddress()),
  signTransaction: vi.fn((xdr, opts) => selectedModule.signTransaction(xdr, opts)),
  on: vi.fn((name, listener) => {
    eventHandlers.set(name, listener)
    return () => eventHandlers.delete(name)
  }),
}
const binding = {
  client: kitClient,
  getSelectedModule: () => selectedModule,
  events: {
    STATE_UPDATED: 'STATE_UPDATE',
    WALLET_SELECTED: 'WALLET_SELECTED',
    DISCONNECT: 'DISCONNECT',
  },
}

vi.mock('./walletKitLoader.js', () => ({ loadKit: vi.fn(async () => binding) }))

import {
  connectActiveAccount,
  connectWallet,
  getActiveAccount,
  getUserAddress,
  onActiveAccountChange,
  signReviewedTransaction,
  signTxXdr,
} from './walletKit.js'

const capability = (overrides = {}) =>
  Object.freeze({
    version: 1,
    kind: 'G',
    address: USER,
    networkPassphrase: TESTNET,
    connectorId: 'freighter',
    epoch: 1,
    ...overrides,
  })

async function flushEvents() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('user wallet connector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventHandlers.clear()
    moduleHandlers.clear()
    selectedModule = freighter
    freighter.getAddress.mockResolvedValue({ address: USER })
    freighter.getNetwork.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET })
    const tx = transaction()
    freighter.signTransaction.mockResolvedValue({
      signedTxXdr: tx.toEnvelope().toXDR('base64'),
      signerAddress: USER,
    })
    kitClient.authModal.mockResolvedValue({ address: USER })
  })

  it('connectWallet opens the modal and returns the chosen address', async () => {
    const addr = await connectWallet()
    expect(kitClient.authModal).toHaveBeenCalledOnce()
    expect(addr).toBe(USER)
  })

  it('getUserAddress fresh-reads the actual selected module', async () => {
    expect(await getUserAddress()).toBe(USER)
    expect(freighter.getAddress).toHaveBeenCalledOnce()
  })

  it('signTxXdr signs with the pinned testnet passphrase + selected-module address', async () => {
    freighter.signTransaction.mockResolvedValueOnce({ signedTxXdr: 'SIGNED_XDR' })
    const out = await signTxXdr('UNSIGNED_XDR')
    expect(out).toBe('SIGNED_XDR')
    const [xdr, opts] = freighter.signTransaction.mock.calls[0]
    expect(xdr).toBe('UNSIGNED_XDR')
    expect(opts.networkPassphrase).toBe(TESTNET)
    expect(opts.address).toBe(USER)
  })

  it('connectActiveAccount derives connector identity and network from the actual selected module', async () => {
    const account = await connectActiveAccount()
    expect(account).toMatchObject({
      version: 1,
      kind: 'G',
      address: USER,
      networkPassphrase: TESTNET,
      connectorId: 'freighter',
    })
    expect(Object.isFrozen(account)).toBe(true)
  })

  it('can resume an already-selected module without opening the wallet modal', async () => {
    const account = await connectActiveAccount({ prompt: false })

    expect(account.address).toBe(USER)
    expect(kitClient.authModal).not.toHaveBeenCalled()
  })

  it('fails closed when the selected connector cannot report its network', async () => {
    selectedModule = {
      productId: 'unreliable',
      getAddress: vi.fn(async () => ({ address: USER })),
      getNetwork: vi.fn(async () => {
        throw new Error('network unavailable')
      }),
      signTransaction: vi.fn(),
    }
    await expect(connectActiveAccount()).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
  })

  it('subscribes to installed kit events and the selected VF module event source', async () => {
    selectedModule = {
      ...freighter,
      productId: 'vf-wallet',
      on: vi.fn((name, listener) => {
        moduleHandlers.set(name, listener)
        return () => moduleHandlers.delete(name)
      }),
    }
    await connectActiveAccount()

    expect([...eventHandlers.keys()]).toEqual(['STATE_UPDATE', 'WALLET_SELECTED', 'DISCONNECT'])
    expect(selectedModule.on).toHaveBeenCalledWith('accountChanged', expect.any(Function))
  })

  it('uses the documented module onChange callback when the connector offers it', async () => {
    let changed
    selectedModule = {
      ...freighter,
      on: undefined,
      onChange: vi.fn((listener) => {
        changed = listener
        return () => {
          changed = null
        }
      }),
    }
    await connectActiveAccount()

    expect(selectedModule.onChange).toHaveBeenCalledWith(expect.any(Function))
    selectedModule.getAddress.mockResolvedValue({ address: OTHER })
    changed?.({ address: OTHER })
    await flushEvents()
    expect(getActiveAccount().address).toBe(OTHER)
  })

  it('publishes null and advances the epoch when an eventless fresh read discovers drift', async () => {
    selectedModule = { ...freighter, on: undefined }
    const installed = await connectActiveAccount()
    const observed = []
    const off = onActiveAccountChange((value) => observed.push(value))
    selectedModule.getAddress.mockResolvedValue({ address: OTHER })
    const tx = transaction()
    const xdr = tx.toEnvelope().toXDR('base64')

    await expect(
      signReviewedTransaction({
        xdr,
        activeAccount: installed,
        reviewedTxHash: tx.hash().toString('hex'),
        kit: binding,
        getCurrentActiveAccount: () => installed,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })

    expect(getActiveAccount()).toBeNull()
    expect(observed.at(-1)).toBeNull()
    const replacement = await connectActiveAccount({ prompt: false })
    expect(replacement.epoch).toBeGreaterThan(installed.epoch)
    off()
  })

  it('invalidates and replaces the capability on selected connector, network, account and disconnect events', async () => {
    await connectActiveAccount()
    const first = getActiveAccount()

    const vf = {
      productId: 'vf-wallet',
      getAddress: vi.fn(async () => ({ address: OTHER })),
      getNetwork: vi.fn(async () => ({ network: 'PUBLIC', networkPassphrase: PUBLIC })),
      signTransaction: vi.fn(),
      on: vi.fn((name, listener) => {
        moduleHandlers.set(name, listener)
        return () => moduleHandlers.delete(name)
      }),
    }
    selectedModule = vf
    eventHandlers.get('WALLET_SELECTED')?.({
      eventType: 'WALLET_SELECTED',
      payload: { id: 'vf-wallet' },
    })
    await flushEvents()
    expect(getActiveAccount()).toMatchObject({
      address: OTHER,
      networkPassphrase: PUBLIC,
      connectorId: 'vf-wallet',
    })
    expect(getActiveAccount().epoch).toBeGreaterThan(first.epoch)

    vf.getNetwork.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET })
    eventHandlers.get('STATE_UPDATE')?.({
      eventType: 'STATE_UPDATE',
      payload: { address: OTHER, networkPassphrase: TESTNET },
    })
    await flushEvents()
    expect(getActiveAccount().networkPassphrase).toBe(TESTNET)

    vf.getAddress.mockResolvedValue({ address: USER })
    moduleHandlers.get('accountChanged')?.({ address: USER })
    await flushEvents()
    expect(getActiveAccount().address).toBe(USER)

    eventHandlers.get('DISCONNECT')?.({ eventType: 'DISCONNECT', payload: {} })
    expect(getActiveAccount()).toBeNull()
  })

  it('successfully signs the reviewed G envelope using the selected connector', async () => {
    const tx = transaction()
    const xdr = tx.toEnvelope().toXDR('base64')
    freighter.signTransaction.mockResolvedValue({ signedTxXdr: xdr, signerAddress: USER })
    const activeAccount = await connectActiveAccount()

    await expect(
      signReviewedTransaction({
        xdr,
        activeAccount,
        reviewedTxHash: tx.hash().toString('hex'),
        kit: binding,
        getCurrentActiveAccount: getActiveAccount,
      })
    ).resolves.toBe(xdr)
  })

  it('rejects a G execution-network mismatch before opening a signing ceremony', async () => {
    freighter.getNetwork.mockResolvedValue({ network: 'PUBLIC', networkPassphrase: PUBLIC })
    const activeAccount = await connectActiveAccount()
    const tx = transaction()
    const xdr = tx.toEnvelope().toXDR('base64')
    freighter.signTransaction.mockClear()

    await expect(
      signReviewedTransaction({
        xdr,
        activeAccount,
        reviewedTxHash: tx.hash().toString('hex'),
        kit: binding,
        getCurrentActiveAccount: () => activeAccount,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
    expect(freighter.signTransaction).not.toHaveBeenCalled()
  })

  it('rejects signer and reviewed-envelope body mismatches', async () => {
    const tx = transaction()
    const changedBody = transaction(USER, '3')
    const xdr = tx.toEnvelope().toXDR('base64')
    const activeAccount = await connectActiveAccount()

    freighter.signTransaction.mockResolvedValueOnce({ signedTxXdr: xdr, signerAddress: OTHER })
    await expect(
      signReviewedTransaction({
        xdr,
        activeAccount,
        reviewedTxHash: tx.hash().toString('hex'),
        kit: binding,
        getCurrentActiveAccount: getActiveAccount,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })

    freighter.signTransaction.mockResolvedValueOnce({
      signedTxXdr: changedBody.toEnvelope().toXDR('base64'),
      signerAddress: USER,
    })
    await expect(
      signReviewedTransaction({
        xdr,
        activeAccount,
        reviewedTxHash: tx.hash().toString('hex'),
        kit: binding,
        getCurrentActiveAccount: () => activeAccount,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
  })

  it.each([
    ['address before sign', async () => freighter.getAddress.mockResolvedValue({ address: OTHER })],
    [
      'network before sign',
      async () =>
        freighter.getNetwork.mockResolvedValue({ network: 'PUBLIC', networkPassphrase: PUBLIC }),
    ],
    [
      'connector before sign',
      async () => {
        selectedModule = { ...freighter, productId: 'other-connector' }
      },
    ],
    [
      'address after sign',
      async () =>
        freighter.signTransaction.mockImplementation(async () => {
          freighter.getAddress.mockResolvedValue({ address: OTHER })
          return { signedTxXdr: transaction().toEnvelope().toXDR('base64'), signerAddress: USER }
        }),
    ],
    [
      'network after sign',
      async () =>
        freighter.signTransaction.mockImplementation(async () => {
          freighter.getNetwork.mockResolvedValue({ network: 'PUBLIC', networkPassphrase: PUBLIC })
          return { signedTxXdr: transaction().toEnvelope().toXDR('base64'), signerAddress: USER }
        }),
    ],
    [
      'connector after sign',
      async () =>
        freighter.signTransaction.mockImplementation(async () => {
          selectedModule = { ...freighter, productId: 'other-connector' }
          return { signedTxXdr: transaction().toEnvelope().toXDR('base64'), signerAddress: USER }
        }),
    ],
  ])('rejects a %s transition around signing', async (_, mutate) => {
    const tx = transaction()
    const xdr = tx.toEnvelope().toXDR('base64')
    const activeAccount = await connectActiveAccount()
    await mutate()

    await expect(
      signReviewedTransaction({
        xdr,
        activeAccount,
        reviewedTxHash: tx.hash().toString('hex'),
        kit: binding,
        getCurrentActiveAccount: () => activeAccount,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
  })

  it.each([
    ['omitted', undefined],
    ['matching', TESTNET],
  ])(
    'accepts %s returned network metadata after all wallet snapshots agree',
    async (_, metadata) => {
      const tx = transaction()
      const xdr = tx.toEnvelope().toXDR('base64')
      const activeAccount = await connectActiveAccount()
      freighter.signTransaction.mockResolvedValue({
        signedTxXdr: xdr,
        signerAddress: USER,
        ...(metadata ? { networkPassphrase: metadata } : {}),
      })

      await expect(
        signReviewedTransaction({
          xdr,
          activeAccount,
          reviewedTxHash: tx.hash().toString('hex'),
          kit: binding,
          getCurrentActiveAccount: () => activeAccount,
        })
      ).resolves.toBe(xdr)
    }
  )

  it('rejects returned network metadata that contradicts the reviewed network', async () => {
    const tx = transaction()
    const xdr = tx.toEnvelope().toXDR('base64')
    const activeAccount = await connectActiveAccount()
    freighter.signTransaction.mockResolvedValue({
      signedTxXdr: xdr,
      signerAddress: USER,
      networkPassphrase: PUBLIC,
    })

    await expect(
      signReviewedTransaction({
        xdr,
        activeAccount,
        reviewedTxHash: tx.hash().toString('hex'),
        kit: binding,
        getCurrentActiveAccount: () => activeAccount,
      })
    ).rejects.toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
  })

  it('rejects a C contract as a classic transaction signer', async () => {
    await expect(
      signReviewedTransaction({
        xdr: 'not-used',
        activeAccount: capability({ kind: 'C', address: 'CNOTCLASSICSOURCE' }),
        reviewedTxHash: 'not-used',
      })
    ).rejects.toThrow(/authorizer/i)
  })
})
