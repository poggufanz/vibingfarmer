import { describe, expect, it } from 'vitest'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import {
  assertCurrentActiveAccount,
  classifyActiveAccount,
} from './activeAccount.js'

const NETWORK = 'Test SDF Network ; September 2015'
const G = Keypair.random().publicKey()
const C = StrKey.encodeContract(new Uint8Array(32).fill(7))

describe('classifyActiveAccount', () => {
  it.each([
    [G, 'G'],
    [C, 'C'],
  ])('accepts a SDK-valid %s account as %s', (address, kind) => {
    const account = classifyActiveAccount({
      address,
      networkPassphrase: NETWORK,
      connectorId: 'freighter',
      epoch: 4,
    })

    expect(account).toEqual({
      version: 1,
      kind,
      address,
      networkPassphrase: NETWORK,
      connectorId: 'freighter',
      epoch: 4,
    })
    expect(Object.isFrozen(account)).toBe(true)
  })

  it.each(['Gnot-a-stellar-account', 'Cnot-a-stellar-contract', '', null])(
    'rejects an invalid Stellar address: %s',
    (address) => {
      expect(() =>
        classifyActiveAccount({
          address,
          networkPassphrase: NETWORK,
          connectorId: 'freighter',
          epoch: 0,
        })
      ).toThrow(/active account/i)
    }
  )
})

describe('assertCurrentActiveAccount', () => {
  const captured = classifyActiveAccount({
    address: G,
    networkPassphrase: NETWORK,
    connectorId: 'freighter',
    epoch: 1,
  })

  it('accepts the exact active capability', () => {
    expect(assertCurrentActiveAccount({ captured, current: captured })).toBe(captured)
  })

  it.each([
    ['G→C', C, NETWORK, 'vf-wallet', 2],
    ['network', G, 'Public Global Stellar Network ; September 2015', 'freighter', 2],
    ['connector', G, NETWORK, 'xbull', 2],
    ['disconnect', null, null, null, null],
  ])('rejects a %s transition with ACTIVE_ACCOUNT_CHANGED', (_, address, networkPassphrase, connectorId, epoch) => {
    const current = address
      ? classifyActiveAccount({ address, networkPassphrase, connectorId, epoch })
      : null
    let error
    try {
      assertCurrentActiveAccount({ captured, current })
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'ACTIVE_ACCOUNT_CHANGED' })
  })
})
