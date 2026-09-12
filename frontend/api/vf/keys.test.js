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

  it('caps self-chosen rateLimit per scope sensitivity (submit 600 -> 400, market 600 ok)', async () => {
    const jwtRate = await signJwt({ sub: 'GRATE' }, 'keys-test-secret-000', 3600)
    let res = mockRes()
    await vfRouter(
      mk('POST', '/keys', { scopes: ['submit'], env: 'test', rateLimit: 600 }, jwtRate),
      res
    )
    expect(res.statusCode).toBe(400)
    res = mockRes()
    await vfRouter(
      mk('POST', '/keys', { scopes: ['market'], env: 'test', rateLimit: 600 }, jwtRate),
      res
    )
    expect(res.statusCode).toBe(200)
    res = mockRes()
    await vfRouter(
      mk('POST', '/keys', { scopes: ['market', 'submit'], env: 'test', rateLimit: 61 }, jwtRate),
      res
    )
    expect(res.statusCode).toBe(400)
  })
  it('403 once the owner key cap is reached', async () => {
    process.env.VF_MAX_KEYS_PER_OWNER = '2'
    try {
      const jwtCap = await signJwt({ sub: 'GCAP' }, 'keys-test-secret-000', 3600)
      for (let i = 0; i < 2; i += 1) {
        const res = mockRes()
        await vfRouter(mk('POST', '/keys', { scopes: ['market'], env: 'test' }, jwtCap), res)
        expect(res.statusCode).toBe(200)
      }
      const res = mockRes()
      await vfRouter(mk('POST', '/keys', { scopes: ['market'], env: 'test' }, jwtCap), res)
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'Key limit reached' })
    } finally {
      delete process.env.VF_MAX_KEYS_PER_OWNER
    }
  })
  it('throttles rapid issuance per session with 429 + Retry-After', async () => {
    const jwtT = await signJwt({ sub: 'GTHROTTLE' }, 'keys-test-secret-000', 3600)
    let last
    for (let i = 0; i < 11; i += 1) {
      const res = mockRes()
      await vfRouter(mk('POST', '/keys', { scopes: ['market'], env: 'test' }, jwtT), res)
      last = res
    }
    expect(last.statusCode).toBe(429)
    expect(Number(last.headers['Retry-After'])).toBeGreaterThan(0)
  })
})
