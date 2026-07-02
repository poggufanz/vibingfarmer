import { describe, it, expect } from 'vitest'
import { Keypair, TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import { buildChallenge, verifyChallenge } from './_sep10.js'

const NET = Networks.TESTNET
const server = Keypair.random()
const client = Keypair.random()
const HOME = 'localhost:5173'

const base = () => ({
  signingSecret: server.secret(),
  homeDomain: HOME,
  networkPassphrase: NET,
})

describe('SEP-10', () => {
  it('challenge is a server-signed tx for the requested account', async () => {
    const { transaction, network_passphrase } = await buildChallenge({
      account: client.publicKey(),
      ...base(),
    })
    expect(network_passphrase).toBe(NET)
    const tx = TransactionBuilder.fromXDR(transaction, NET)
    expect(tx.signatures).toHaveLength(1)
  })
  it('client-signed challenge verifies and yields the account', async () => {
    const { transaction } = await buildChallenge({ account: client.publicKey(), ...base() })
    const tx = TransactionBuilder.fromXDR(transaction, NET)
    tx.sign(client)
    const v = await verifyChallenge({ signedXdr: tx.toXDR(), ...base() })
    expect(v).toEqual({ ok: true, account: client.publicKey() })
  })
  it('rejects a challenge signed by the wrong wallet', async () => {
    const { transaction } = await buildChallenge({ account: client.publicKey(), ...base() })
    const tx = TransactionBuilder.fromXDR(transaction, NET)
    tx.sign(Keypair.random())
    expect((await verifyChallenge({ signedXdr: tx.toXDR(), ...base() })).ok).toBe(false)
  })
  it('rejects an unsigned (server-only) challenge and garbage XDR', async () => {
    const { transaction } = await buildChallenge({ account: client.publicKey(), ...base() })
    expect((await verifyChallenge({ signedXdr: transaction, ...base() })).ok).toBe(false)
    expect((await verifyChallenge({ signedXdr: 'garbage', ...base() })).ok).toBe(false)
  })
})
