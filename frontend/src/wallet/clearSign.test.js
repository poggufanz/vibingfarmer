import { describe, it, expect } from 'vitest'
import {
  TransactionBuilder,
  Account,
  Operation,
  Asset,
  BASE_FEE,
  Memo,
  Keypair,
} from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'
import { decodeForConfirm } from './clearSign.js'

function paymentXdr() {
  const src = new Account('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6', '1')
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '12.5000000',
      })
    )
    .addMemo(Memo.text('hi'))
    .setTimeout(300)
    .build()
  return tx.toXDR()
}

describe('clearSign', () => {
  it('decodes a native payment to human-readable fields', () => {
    const d = decodeForConfirm(paymentXdr())
    expect(d.kind).toBe('payment')
    expect(d.decodable).toBe(true)
    expect(d.ops[0]).toMatchObject({ type: 'payment', asset: 'XLM', amount: '12.5000000' })
    expect(d.memo).toBe('hi')
  })

  it('marks a non-payment op (bumpSequence) as decodable:false, top-level decodable:false', () => {
    const src = new Account('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6', '1')
    const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(300)
      .build()
    const d = decodeForConfirm(tx.toXDR())
    expect(d.ops[0].decodable).toBe(false)
    expect(d.ops[0].type).toBeDefined()
    expect(d.decodable).toBe(false)
    expect(d.kind).toBe(d.ops[0].type)
  })

  it('decodes a createAccount op to human-readable fields', () => {
    const src = new Account('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6', '1')
    const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(
        Operation.createAccount({
          destination: Keypair.random().publicKey(),
          startingBalance: '5.0000000',
        })
      )
      .setTimeout(300)
      .build()
    const d = decodeForConfirm(tx.toXDR())
    expect(d.ops[0]).toMatchObject({ type: 'createAccount', decodable: true, amount: '5.0000000' })
    expect(d.ops[0].destination).toBeDefined()
    expect(d.decodable).toBe(true)
  })
})
