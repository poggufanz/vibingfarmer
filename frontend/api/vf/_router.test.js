import { describe, it, expect, beforeEach } from 'vitest'
import { Keypair, TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import vfRouter, { subPath } from './_router.js'
import { verifyJwt } from './_jwt.js'

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
const mk = (method, url, body) => ({
  method, url, body,
  headers: { origin: 'http://localhost:5173', 'x-real-ip': '9.9.9.9' },
})

const server = Keypair.random()
const client = Keypair.random()

beforeEach(() => {
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  process.env.VF_AUTH_SIGNING_KEY = server.secret()
  process.env.VF_JWT_SECRET = 'router-test-secret-00'
  process.env.VF_HOME_DOMAIN = 'localhost:5173'
  process.env.STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET
})

describe('subPath', () => {
  it('handles vite-mounted and full Pages URLs', () => {
    expect(subPath({ url: '/auth/challenge?account=G' })).toBe('/auth/challenge')
    expect(subPath({ url: 'https://x.pages.dev/api/vf/prices?coins=a' })).toBe('/prices')
  })
})

describe('vf router', () => {
  it('404 on unknown route', async () => {
    const res = mockRes()
    await vfRouter(mk('GET', '/nope'), res)
    expect(res.statusCode).toBe(404)
  })
  it('SEP-10 flow: challenge → sign → token → valid JWT', async () => {
    let res = mockRes()
    await vfRouter(mk('GET', `/auth/challenge?account=${client.publicKey()}`), res)
    expect(res.statusCode).toBe(200)
    const { transaction } = JSON.parse(res.body)
    const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET)
    tx.sign(client)
    res = mockRes()
    await vfRouter(mk('POST', '/auth/token', { transaction: tx.toXDR() }), res)
    expect(res.statusCode).toBe(200)
    const { token } = JSON.parse(res.body)
    const claims = await verifyJwt(token, 'router-test-secret-00')
    expect(claims.sub).toBe(client.publicKey())
  })
  it('challenge 400 on bad account, token 401 on unsigned challenge', async () => {
    let res = mockRes()
    await vfRouter(mk('GET', '/auth/challenge?account=not-a-g-address'), res)
    expect(res.statusCode).toBe(400)
    res = mockRes()
    await vfRouter(mk('GET', `/auth/challenge?account=${client.publicKey()}`), res)
    const { transaction } = JSON.parse(res.body)
    res = mockRes()
    await vfRouter(mk('POST', '/auth/token', { transaction }), res)
    expect(res.statusCode).toBe(401)
  })
  it('challenge 503 when VF_AUTH_SIGNING_KEY unset', async () => {
    delete process.env.VF_AUTH_SIGNING_KEY
    const res = mockRes()
    await vfRouter(mk('GET', `/auth/challenge?account=${client.publicKey()}`), res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })
})
