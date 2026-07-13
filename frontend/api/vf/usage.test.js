import { describe, it, expect, beforeEach } from 'vitest'
import usage from './usage.js'
import { storeFrom } from './_db.js'
import { signJwt } from './_jwt.js'

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: '' }
  res.setHeader = (k, v) => (res.headers[k] = v)
  res.end = (s) => (res.body = s || '')
  return res
}

let jwt
beforeEach(async () => {
  process.env.VF_JWT_SECRET = 'usage-test-secret-000'
  jwt = await signJwt({ sub: 'G_ME' }, 'usage-test-secret-000', 3600)
})

describe('GET /usage', () => {
  it('401 without jwt', async () => {
    const res = makeRes()
    await usage({ method: 'GET', headers: {}, url: '/api/vf/usage' }, res)
    expect(res.statusCode).toBe(401)
  })

  it('returns only own usage rows + cap', async () => {
    const store = storeFrom({}) // dev memory store singleton
    await store.keys.insert({
      id: 'km',
      key_hash: 'hm',
      key_hint: 'm…',
      owner: 'G_ME',
      scopes: '["market"]',
      rate_limit: 60,
      expires_at: null,
      enabled: 1,
      created_at: 1,
      last_used_at: null,
    })
    await store.keys.insert({
      id: 'ko',
      key_hash: 'ho',
      key_hint: 'o…',
      owner: 'G_OTHER',
      scopes: '["market"]',
      rate_limit: 60,
      expires_at: null,
      enabled: 1,
      created_at: 1,
      last_used_at: null,
    })
    const today = new Date().toISOString().slice(0, 10)
    await store.usage.log('km', today, 'GET /prices')
    await store.usage.log('ko', today, 'GET /prices')
    const res = makeRes()
    await usage(
      { method: 'GET', headers: { authorization: `Bearer ${jwt}` }, url: '/api/vf/usage' },
      res
    )
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.usage).toEqual([{ key_id: 'km', day: today, endpoint: 'GET /prices', count: 1 }])
    expect(typeof body.cap).toBe('number')
    expect(body.sinceDay <= today).toBe(true)
  })
})
