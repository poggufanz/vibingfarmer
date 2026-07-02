// frontend/src/wallet/send.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keypair, Account } from '@stellar/stellar-sdk'
import { isKnownVault, buildPaymentXdr, previewSend, sendPayment } from './send.js'
import { decodeForConfirm } from './clearSign.js'
import { VAULT_CATALOG } from '../config.js'
import { eligibility } from '../vfapi/client.js'

// The real catalog's demo entries all point at the single deployed Soroban vault (a C-address),
// which is not a valid classic-payment destination (Operation.payment only accepts G/M ed25519
// account IDs). Swap entry 0's address for a valid G-address so "send a payment to a known vault"
// scenarios can actually build a real, signable classic transaction — name/protocol stay real.
// NOTE: the replacement address is a literal (not an outer const) because vi.mock factories are
// hoisted above the rest of the module — referencing an outer binding here throws a ReferenceError.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    VAULT_CATALOG: [
      {
        ...actual.VAULT_CATALOG[0],
        address: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6',
      },
      ...actual.VAULT_CATALOG.slice(1),
    ],
  }
})

vi.mock('../vfapi/client.js', () => ({ eligibility: vi.fn() }))

vi.mock('./classicAccount.js', async () => {
  const { Keypair: RealKeypair } = await import('@stellar/stellar-sdk')
  return {
    horizonServer: vi.fn(() => ({})),
    withSecret: vi.fn(async (fn) => fn(RealKeypair.random())),
  }
})

const FROM = Keypair.random().publicKey()

function stubHorizon(sourceAddr = FROM) {
  return {
    loadAccount: vi.fn(async () => new Account(sourceAddr, '1')),
    submitTransaction: vi.fn(async () => ({ hash: 'deadbeef' })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('send — vault detection', () => {
  it('flags a known vault address and ignores a random one', () => {
    const vaultAddr = VAULT_CATALOG[0].address
    expect(isKnownVault(vaultAddr).hit).toBe(true)
    expect(isKnownVault(vaultAddr).vault.name).toBe(VAULT_CATALOG[0].name)
    expect(isKnownVault('GRANDOMADDRESSNOTAVAULT').hit).toBe(false)
  })
})

describe('buildPaymentXdr', () => {
  it('builds a native XLM payment that decodes to the expected fields, no memo', async () => {
    const to = Keypair.random().publicKey()
    const horizon = stubHorizon()

    const { xdr } = await buildPaymentXdr({
      from: FROM,
      to,
      asset: 'XLM',
      amount: '5.0000000',
      horizon,
    })

    const decoded = decodeForConfirm(xdr)
    expect(decoded.ops[0]).toMatchObject({
      type: 'payment',
      asset: 'XLM',
      amount: '5.0000000',
      destination: to,
    })
    expect(decoded.memo).toBe('')
  })

  it('attaches a memo when one is provided', async () => {
    const to = Keypair.random().publicKey()
    const horizon = stubHorizon()

    const { xdr } = await buildPaymentXdr({
      from: FROM,
      to,
      asset: 'XLM',
      amount: '1.0000000',
      memo: 'hello',
      horizon,
    })

    expect(decodeForConfirm(xdr).memo).toBe('hello')
  })

  it('builds an issued-asset payment, decoded asset as CODE:ISSUER', async () => {
    const to = Keypair.random().publicKey()
    const issuer = Keypair.random().publicKey()
    const horizon = stubHorizon()

    const { xdr } = await buildPaymentXdr({
      from: FROM,
      to,
      asset: { code: 'USDC', issuer },
      amount: '10.0000000',
      horizon,
    })

    const decoded = decodeForConfirm(xdr)
    expect(decoded.ops[0].asset).toBe(`USDC:${issuer}`)
    expect(decoded.ops[0].amount).toBe('10.0000000')
  })
})

describe('previewSend', () => {
  it('reports the vault verdict for a known-vault destination without building a payment', async () => {
    eligibility.mockResolvedValueOnce({ allow: false, reasons: ['x'] })
    const horizon = stubHorizon()

    const result = await previewSend({
      from: FROM,
      to: VAULT_CATALOG[0].address,
      asset: 'XLM',
      amount: '1.0000000',
      horizon,
    })

    expect(result.confirm).toBeDefined()
    expect(result.confirm.kind).toBe('vault')
    expect(result.confirm.decodable).toBe(false)
    expect(result.confirm.ops[0]).toEqual({
      destination: VAULT_CATALOG[0].address,
      asset: 'XLM',
      amount: '1.0000000',
    })
    expect(horizon.loadAccount).not.toHaveBeenCalled()
    expect(result.vault).toEqual({
      hit: true,
      name: VAULT_CATALOG[0].name,
      allow: false,
      reasons: ['x'],
    })
    expect(eligibility).toHaveBeenCalledWith({
      vault: VAULT_CATALOG[0].protocol,
      amount: '1.0000000',
    })
  })

  it('does not throw for the REAL catalog C-address vault (gate step 5 regression)', async () => {
    eligibility.mockResolvedValueOnce({ allow: true, reasons: [] })
    const horizon = stubHorizon()
    // entry 1+ keep the real Soroban C-address (the file-level mock only swaps entry 0);
    // Operation.payment would throw "destination is invalid" on it if previewSend built the XDR
    const cVault = VAULT_CATALOG[1]

    const result = await previewSend({
      from: FROM,
      to: cVault.address,
      asset: 'XLM',
      amount: '5',
      horizon,
    })

    expect(result.vault.hit).toBe(true)
    expect(result.vault.name).toBe(cVault.name)
    expect(result.confirm.ops[0].destination).toBe(cVault.address)
    expect(horizon.loadAccount).not.toHaveBeenCalled()
  })

  it('does not gate a non-vault destination', async () => {
    const horizon = stubHorizon()
    const to = Keypair.random().publicKey()

    const result = await previewSend({
      from: FROM,
      to,
      asset: 'XLM',
      amount: '1.0000000',
      horizon,
    })

    expect(result.vault).toEqual({ hit: false })
    expect(eligibility).not.toHaveBeenCalled()
  })
})

describe('sendPayment', () => {
  it('signs and submits an ungated, non-vault payment', async () => {
    const horizon = stubHorizon()
    const to = Keypair.random().publicKey()

    const result = await sendPayment({
      from: FROM,
      to,
      asset: 'XLM',
      amount: '2.0000000',
      horizon,
    })

    expect(result).toEqual({ hash: 'deadbeef', status: 'SUCCESS' })
    expect(horizon.submitTransaction).toHaveBeenCalledTimes(1)
    expect(eligibility).not.toHaveBeenCalled()
  })

  it('fails closed on an ineligible vault destination — never builds or submits', async () => {
    eligibility.mockResolvedValueOnce({ allow: false, reasons: ['blocked'] })
    const horizon = stubHorizon()

    await expect(
      sendPayment({
        from: FROM,
        to: VAULT_CATALOG[0].address,
        asset: 'XLM',
        amount: '1.0000000',
        horizon,
      })
    ).rejects.toThrow(/ineligible/)

    expect(horizon.loadAccount).not.toHaveBeenCalled()
    expect(horizon.submitTransaction).not.toHaveBeenCalled()
  })

  it('proceeds to sign and submit when the vault gate allows', async () => {
    eligibility.mockResolvedValueOnce({ allow: true, reasons: [] })
    const horizon = stubHorizon()

    const result = await sendPayment({
      from: FROM,
      to: VAULT_CATALOG[0].address,
      asset: 'XLM',
      amount: '1.0000000',
      horizon,
    })

    expect(result).toEqual({ hash: 'deadbeef', status: 'SUCCESS' })
    expect(horizon.submitTransaction).toHaveBeenCalledTimes(1)
  })
})
