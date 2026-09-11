import { describe, it, expect, beforeEach } from 'vitest'
import { memoryStore } from './_db.js'
import { issueKey } from './_keystore.js'
import { signJwt } from './_jwt.js'
import { requireVfKey, requireJwt } from './_vfauth.js'

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
const reqWith = (auth) => ({ method: 'POST', headers: auth ? { authorization: auth } : {} })

let store, key, now
beforeEach(async () => {
  store = memoryStore()
  now = Date.now()
  process.env.VF_JWT_SECRET = 'test-jwt-secret-0000'
  process.env.VF_GLOBAL_DAILY_CAP = '5000'
  process.env.VF_OWNER_DAILY_CAP = '1000'
  ;({ key } = await issueKey(store, {
    owner: 'GAAA',
    scopes: ['market'],
    rateLimit: 3,
    env: 'test',
    expiresAt: null,
  }))
})

describe('requireVfKey', () => {
  it('accepts a valid key with the right scope', async () => {
    const res = mockRes()
    const ctx = await requireVfKey(reqWith(`Bearer ${key}`), res, store, {
      scope: 'market',
      nowMs: now,
    })
    expect(ctx).toMatchObject({ scopes: ['market'] })
    expect(res.statusCode).toBe(200)
  })
  it('401 without / with unknown key; 403 wrong scope', async () => {
    let res = mockRes()
    expect(
      await requireVfKey(reqWith(null), res, store, { scope: 'market', nowMs: now })
    ).toBeNull()
    expect(res.statusCode).toBe(401)
    res = mockRes()
    expect(
      await requireVfKey(reqWith('Bearer vf_test_' + 'a'.repeat(43)), res, store, {
        scope: 'market',
        nowMs: now,
      })
    ).toBeNull()
    expect(res.statusCode).toBe(401)
    res = mockRes()
    expect(
      await requireVfKey(reqWith(`Bearer ${key}`), res, store, { scope: 'submit', nowMs: now })
    ).toBeNull()
    expect(res.statusCode).toBe(403)
  })
  it('429 past the per-key limit, with Retry-After', async () => {
    for (let i = 0; i < 3; i++) {
      expect(
        await requireVfKey(reqWith(`Bearer ${key}`), mockRes(), store, {
          scope: 'market',
          nowMs: now,
        })
      ).not.toBeNull()
    }
    const res = mockRes()
    expect(
      await requireVfKey(reqWith(`Bearer ${key}`), res, store, { scope: 'market', nowMs: now })
    ).toBeNull()
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0)
  })
  it('503 when the global daily budget for the scope is spent', async () => {
    process.env.VF_GLOBAL_DAILY_CAP = '2'
    const k2 = (
      await issueKey(store, {
        owner: 'GBBB',
        scopes: ['market'],
        rateLimit: 100,
        env: 'test',
        expiresAt: null,
      })
    ).key
    expect(
      await requireVfKey(reqWith(`Bearer ${k2}`), mockRes(), store, { scope: 'market', nowMs: now })
    ).not.toBeNull()
    expect(
      await requireVfKey(reqWith(`Bearer ${k2}`), mockRes(), store, { scope: 'market', nowMs: now })
    ).not.toBeNull()
    const res = mockRes()
    expect(
      await requireVfKey(reqWith(`Bearer ${k2}`), res, store, { scope: 'market', nowMs: now })
    ).toBeNull()
    expect(res.statusCode).toBe(503)
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0)
  })
})

describe('requireJwt', () => {
  it('accepts a valid JWT and returns claims; 401 otherwise', async () => {
    const jwt = await signJwt({ sub: 'GAAA' }, 'test-jwt-secret-0000', 3600)
    const ok = await requireJwt(reqWith(`Bearer ${jwt}`), mockRes())
    expect(ok.sub).toBe('GAAA')
    const res = mockRes()
    expect(await requireJwt(reqWith('Bearer nope'), res)).toBeNull()
    expect(res.statusCode).toBe(401)
  })
})


describe('daily-budget fairness', () => {
  it('503 carries Retry-After and the per-owner cap shelters other owners', async () => {
    process.env.VF_GLOBAL_DAILY_CAP = '5000'
    process.env.VF_OWNER_DAILY_CAP = '2'
    const a = (
      await issueKey(store, { owner: 'GAAA', scopes: ['market'], rateLimit: 100, env: 'test', expiresAt: null })
    ).key
    const b = (
      await issueKey(store, { owner: 'GBBB', scopes: ['market'], rateLimit: 100, env: 'test', expiresAt: null })
    ).key
    expect(await requireVfKey(reqWith('Bearer ' + a), mockRes(), store, { scope: 'market', nowMs: now })).not.toBeNull()
    expect(await requireVfKey(reqWith('Bearer ' + a), mockRes(), store, { scope: 'market', nowMs: now })).not.toBeNull()
    const res = mockRes()
    expect(await requireVfKey(reqWith('Bearer ' + a), res, store, { scope: 'market', nowMs: now })).toBeNull()
    expect(res.statusCode).toBe(503)
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0)
    expect(await requireVfKey(reqWith('Bearer ' + b), mockRes(), store, { scope: 'market', nowMs: now })).not.toBeNull()
  })
  it('owner over cap returns 503 without consuming the shared global budget', async () => {
    process.env.VF_GLOBAL_DAILY_CAP = '5000'
    process.env.VF_OWNER_DAILY_CAP = '1'
    const a = (
      await issueKey(store, { owner: 'GAAA', scopes: ['market'], rateLimit: 100, env: 'test', expiresAt: null })
    ).key
    expect(await requireVfKey(reqWith('Bearer ' + a), mockRes(), store, { scope: 'market', nowMs: now })).not.toBeNull()
    let globalBumps = 0
    const origBump = store.counters.bump.bind(store.counters)
    store.counters.bump = async (k, w) => {
      if (String(k).startsWith('__global:')) globalBumps++
      return origBump(k, w)
    }
    const res = mockRes()
    expect(await requireVfKey(reqWith('Bearer ' + a), res, store, { scope: 'market', nowMs: now })).toBeNull()
    expect(res.statusCode).toBe(503)
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0)
    expect(globalBumps).toBe(0)
  })
})

describe('requireJwt throttle', () => {
  it('429 + Retry-After past the per-session limit', async () => {
    const token = await signJwt({ sub: 'GAAA' }, 'test-jwt-secret-0000', 3600)
    const opts = { max: 2, bucket: 'test-jwt-throttle' }
    expect(await requireJwt(reqWith('Bearer ' + token), mockRes(), opts)).not.toBeNull()
    expect(await requireJwt(reqWith('Bearer ' + token), mockRes(), opts)).not.toBeNull()
    const res = mockRes()
    expect(await requireJwt(reqWith('Bearer ' + token), res, opts)).toBeNull()
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0)
  })
})
