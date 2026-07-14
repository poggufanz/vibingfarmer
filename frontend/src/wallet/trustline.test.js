// frontend/src/wallet/trustline.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keypair, Account, TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'
import {
  KNOWN_ASSETS,
  classifyTrustAsset,
  buildChangeTrustXdr,
  addTrustline,
} from './trustline.js'

vi.mock('./classicAccount.js', async () => {
  const { Keypair: RealKeypair } = await import('@stellar/stellar-sdk')
  return {
    horizonServer: vi.fn(() => ({})),
    withSecret: vi.fn(async (fn) => fn(RealKeypair.random())),
  }
})

vi.mock('./session.js', () => ({ getUnlocked: vi.fn() }))

import { getUnlocked } from './session.js'

const FROM = Keypair.random().publicKey()
const ISSUER = Keypair.random().publicKey()

function stubHorizon(sourceAddr = FROM) {
  return {
    loadAccount: vi.fn(async () => new Account(sourceAddr, '1')),
    submitTransaction: vi.fn(async () => ({ hash: 'deadbeef' })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('KNOWN_ASSETS', () => {
  it('lists the app USDC quick-add', () => {
    expect(KNOWN_ASSETS).toEqual([
      {
        code: 'USDC',
        issuer: 'GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56',
        label: 'USDC (Vibing Farmer testnet)',
      },
    ])
  })
})

describe('classifyTrustAsset', () => {
  it('accepts a valid code + issuer, trimmed', () => {
    const r = classifyTrustAsset(`  USDC  `, ` ${ISSUER} `)
    expect(r).toEqual({ ok: true, code: 'USDC', issuer: ISSUER })
  })

  it('rejects a code with non-alphanumeric characters', () => {
    const r = classifyTrustAsset('US-DC', ISSUER)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/alphanumeric/i)
  })

  it('rejects a code longer than 12 characters', () => {
    const r = classifyTrustAsset('ABCDEFGHIJKLM', ISSUER)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/12/)
  })

  it('rejects an empty code', () => {
    const r = classifyTrustAsset('', ISSUER)
    expect(r.ok).toBe(false)
  })

  it('rejects an invalid issuer strkey', () => {
    const r = classifyTrustAsset('USDC', 'not-a-valid-issuer')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/issuer/i)
  })
})

describe('buildChangeTrustXdr', () => {
  it('builds a changeTrust op with the given asset code/issuer, no limit', async () => {
    const horizon = stubHorizon()

    const { xdr } = await buildChangeTrustXdr({
      account: FROM,
      code: 'USDC',
      issuer: ISSUER,
      horizon,
    })

    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE)
    expect(tx.operations).toHaveLength(1)
    const op = tx.operations[0]
    expect(op.type).toBe('changeTrust')
    expect(op.line.getCode()).toBe('USDC')
    expect(op.line.getIssuer()).toBe(ISSUER)
  })

  it('passes an explicit limit through to the op', async () => {
    const horizon = stubHorizon()

    const { xdr } = await buildChangeTrustXdr({
      account: FROM,
      code: 'USDC',
      issuer: ISSUER,
      limit: '100',
      horizon,
    })

    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE)
    expect(tx.operations[0].limit).toBe('100.0000000')
  })
})

describe('addTrustline', () => {
  it('classifies, signs, and submits — returns hash/status/code/issuer', async () => {
    getUnlocked.mockResolvedValueOnce({ publicKey: FROM, key: {}, blob: {} })
    const horizon = stubHorizon()

    const result = await addTrustline({ code: 'USDC', issuer: ISSUER, horizon })

    expect(result).toEqual({ hash: 'deadbeef', status: 'SUCCESS', code: 'USDC', issuer: ISSUER })
    expect(horizon.loadAccount).toHaveBeenCalledWith(FROM)
    expect(horizon.submitTransaction).toHaveBeenCalledTimes(1)
  })

  it('throws on an invalid asset without touching horizon or session', async () => {
    const horizon = stubHorizon()

    await expect(addTrustline({ code: 'BAD CODE', issuer: ISSUER, horizon })).rejects.toThrow()

    expect(getUnlocked).not.toHaveBeenCalled()
    expect(horizon.loadAccount).not.toHaveBeenCalled()
  })

  it('throws "locked" when there is no unlocked session', async () => {
    getUnlocked.mockResolvedValueOnce(null)
    const horizon = stubHorizon()

    await expect(addTrustline({ code: 'USDC', issuer: ISSUER, horizon })).rejects.toThrow(
      'locked'
    )
  })

  it('maps op_low_reserve to a friendly "not enough XLM" message', async () => {
    getUnlocked.mockResolvedValueOnce({ publicKey: FROM, key: {}, blob: {} })
    const horizon = stubHorizon()
    horizon.submitTransaction.mockRejectedValueOnce({
      response: {
        data: {
          extras: { result_codes: { transaction: 'tx_failed', operations: ['op_low_reserve'] } },
        },
      },
    })

    await expect(addTrustline({ code: 'USDC', issuer: ISSUER, horizon })).rejects.toThrow(
      /0\.5 XLM/
    )
  })

  it('rethrows other Horizon failures with the result_codes summary', async () => {
    getUnlocked.mockResolvedValueOnce({ publicKey: FROM, key: {}, blob: {} })
    const horizon = stubHorizon()
    horizon.submitTransaction.mockRejectedValueOnce({
      response: {
        data: {
          extras: { result_codes: { transaction: 'tx_failed', operations: ['op_no_issuer'] } },
        },
      },
    })

    await expect(addTrustline({ code: 'USDC', issuer: ISSUER, horizon })).rejects.toThrow(
      /op_no_issuer/
    )
  })
})
