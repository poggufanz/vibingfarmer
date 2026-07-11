import { describe, it, expect, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import vfRouter from './_router.js'
import { buildDepositCore } from './build-tx.js'
import { simulateCore } from './simulate.js'
import { storeFrom } from './_db.js'
import { issueKey } from './_keystore.js'

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(s) {
      this.body = s ?? ''
      return this
    },
  }
}
const mk = (method, url, body, key) => ({
  method,
  url,
  body,
  headers: { 'x-real-ip': '6.6.6.6', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

const user = Keypair.random()
let key
beforeEach(async () => {
  process.env.SOROBAN_VAULT_ADDRESS = 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU'
  process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
  ;({ key } = await issueKey(storeFrom({}), {
    owner: 'GTX',
    scopes: ['tx'],
    rateLimit: 100,
    env: 'test',
    expiresAt: null,
  }))
})

describe('buildDepositCore', () => {
  it('produces an UNSIGNED prepared deposit tx XDR', async () => {
    const fakeRpc = {
      async getAccount(g) {
        const { Account } = await import('@stellar/stellar-sdk')
        return new Account(g, '1')
      },
      async prepareTransaction(tx) {
        return tx
      }, // pass-through: skip live simulation
    }
    const { xdr } = await buildDepositCore({
      from: user.publicKey(),
      amount: 10000000n,
      vault: process.env.SOROBAN_VAULT_ADDRESS,
      passphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
      rpcServer: fakeRpc,
    })
    const { TransactionBuilder } = await import('@stellar/stellar-sdk')
    const tx = TransactionBuilder.fromXDR(xdr, process.env.STELLAR_NETWORK_PASSPHRASE)
    expect(tx.signatures).toHaveLength(0) // UNSIGNED — non-custodial rule
    expect(tx.operations[0].type).toBe('invokeHostFunction')
  })
})

describe('simulateCore', () => {
  it('returns the sim status without internals', async () => {
    const fakeRpc = {
      async simulateTransaction() {
        return { id: 'x', latestLedger: 1, events: [], _parsed: true, error: undefined }
      },
    }
    const out = await simulateCore({
      xdr: 'AAA',
      passphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
      rpcServer: fakeRpc,
      parse: () => ({}),
    })
    expect(out.ok).toBe(true)
  })
})

describe('endpoint auth + validation', () => {
  it('401 without key; 403 with wrong-scope key; 400 bad input', async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/build-tx', {}), res)
    expect(res.statusCode).toBe(401)
    const { key: mktKey } = await issueKey(storeFrom({}), {
      owner: 'GM',
      scopes: ['market'],
      rateLimit: 10,
      env: 'test',
      expiresAt: null,
    })
    res = mockRes()
    await vfRouter(mk('POST', '/build-tx', {}, mktKey), res)
    expect(res.statusCode).toBe(403)
    res = mockRes()
    await vfRouter(
      mk('POST', '/build-tx', { kind: 'deposit', from: 'not-a-g', amount: '1' }, key),
      res
    )
    expect(res.statusCode).toBe(400)
    res = mockRes()
    await vfRouter(mk('POST', '/simulate', {}, key), res)
    expect(res.statusCode).toBe(400)
  })
})
