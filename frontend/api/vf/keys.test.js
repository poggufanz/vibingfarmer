import { describe, it, expect, beforeEach } from 'vitest'
import vfRouter from './_router.js'
import { storeFrom } from './_db.js'
import { signJwt } from './_jwt.js'

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
const mk = (method, url, body, jwt) => ({
  method,
  url,
  body,
  headers: { 'x-real-ip': '8.8.8.8', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
})

let jwt
beforeEach(async () => {
  process.env.VF_JWT_SECRET = 'keys-test-secret-000'
  jwt = await signJwt({ sub: 'GOWNER' }, 'keys-test-secret-000', 3600)
})

describe('/api/vf/keys', () => {
  it('401 without JWT', async () => {
    const res = mockRes()
    await vfRouter(mk('GET', '/keys'), res)
    expect(res.statusCode).toBe(401)
  })
  it('POST issues a key (plaintext once), GET lists without plaintext/hash, DELETE revokes', async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/keys', { scopes: ['market'], env: 'test' }, jwt), res)
    expect(res.statusCode).toBe(200)
    const issued = JSON.parse(res.body)
    expect(issued.key).toMatch(/^vf_test_/)

    res = mockRes()
    await vfRouter(mk('GET', '/keys', undefined, jwt), res)
    const { keys } = JSON.parse(res.body)
    const mine = keys.find((k) => k.id === issued.id)
    expect(mine.key_hint).toBe(issued.hint)
    expect(res.body).not.toContain(issued.key)
    expect(mine.key_hash).toBeUndefined()

    res = mockRes()
    await vfRouter(mk('DELETE', '/keys', { id: issued.id }, jwt), res)
    expect(JSON.parse(res.body)).toEqual({ revoked: true })
    // revoked key no longer verifies
    const store = storeFrom({})
    const { verifyKey } = await import('./_keystore.js')
    expect((await verifyKey(store, issued.key)).reason).toBe('revoked')
  })
  it('400 on invalid scopes / env / rateLimit', async () => {
    for (const body of [
      { scopes: ['nope'], env: 'test' },
      { scopes: ['market'], env: 'prod' },
      { scopes: ['market'], env: 'test', rateLimit: 0 },
      { scopes: [], env: 'test' },
    ]) {
      const res = mockRes()
      await vfRouter(mk('POST', '/keys', body, jwt), res)
      expect(res.statusCode).toBe(400)
    }
  })
  it("DELETE another owner's key → 404", async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/keys', { scopes: ['market'], env: 'test' }, jwt), res)
    const { id } = JSON.parse(res.body)
    const other = await signJwt({ sub: 'GOTHER' }, 'keys-test-secret-000', 3600)
    res = mockRes()
    await vfRouter(mk('DELETE', '/keys', { id }, other), res)
    expect(res.statusCode).toBe(404)
  })
})
