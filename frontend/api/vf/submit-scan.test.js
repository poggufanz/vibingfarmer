import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import vfRouter from './_router.js'
import { submitCore } from './submit.js'
import { storeFrom } from './_db.js'
import { issueKey } from './_keystore.js'

const VAULT = 'CBZNITAPHCLSPEXC3UKIERYRUJR56GISM2G2Z5XD6KZH3U4ZZ76XNQOU'

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
  headers: { 'x-real-ip': '5.5.5.5', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

let submitKey, scanKey
beforeEach(async () => {
  process.env.STELLAR_RELAYER_SECRET = ''
  process.env.SOROBAN_VAULT_ADDRESS = VAULT
  const s = storeFrom({})
  submitKey = (
    await issueKey(s, {
      owner: 'GS',
      scopes: ['submit'],
      rateLimit: 50,
      env: 'test',
      expiresAt: null,
    })
  ).key
  scanKey = (
    await issueKey(s, {
      owner: 'GS',
      scopes: ['scan'],
      rateLimit: 50,
      env: 'test',
      expiresAt: null,
    })
  ).key
})

describe('/submit', () => {
  it('503 configured:false without relayer secret', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/submit', { xdr: 'AAA' }, submitKey), res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })
  it('submitCore delegates to the injected relay fn and returns its result', async () => {
    const relay = vi.fn(async () => ({ hash: 'H', status: 'SUCCESS', relayer: 'GRELAY' }))
    const out = await submitCore({ xdr: 'XDR64', deps: { relay } })
    expect(relay).toHaveBeenCalledWith(expect.objectContaining({ xdr: 'XDR64' }))
    expect(out).toEqual({ hash: 'H', status: 'SUCCESS', relayer: 'GRELAY' })
  })
  it('401 without key', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/submit', { xdr: 'AAA' }), res)
    expect(res.statusCode).toBe(401)
  })
})

describe('/scan', () => {
  it('classifies targets and flags the known vault', async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: VAULT }, scanKey), res)
    let out = JSON.parse(res.body)
    expect(out).toMatchObject({ kind: 'contract', isKnownVault: true })
    expect(out.eligibility).toBeDefined()

    res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: Keypair.random().publicKey() }, scanKey), res)
    out = JSON.parse(res.body)
    expect(out).toMatchObject({ kind: 'account', isKnownVault: false })

    res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: 'garbage' }, scanKey), res)
    expect(JSON.parse(res.body).kind).toBe('invalid')
  })
})
