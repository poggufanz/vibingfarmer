import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDurableRateLimiter,
  EDGE_LIMITS,
  resolveAgentIndexCrossLimit,
  resolveVfCrossLimit,
} from './durableRateLimit.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

const MIGRATION = readFileSync(
  new URL('../migrations/0010_vf_cross_rate_limits.sql', import.meta.url),
  'utf8'
)
const LIMIT = { max: 2, windowMs: 60_000 }

function realD1({ migrated = true, yieldAfterStatement = false } = {}) {
  const database = new DatabaseSync(':memory:')
  if (migrated) database.exec(MIGRATION)
  return {
    database,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (yieldAfterStatement) await Promise.resolve()
              return database.prepare(sql).get(...params)
            },
            async run() {
              if (yieldAfterStatement) await Promise.resolve()
              return database.prepare(sql).run(...params)
            },
            async all() {
              if (yieldAfterStatement) await Promise.resolve()
              return { results: database.prepare(sql).all(...params) }
            },
          }
        },
      }
    },
  }
}

function request({ db, ip = '198.51.100.7', env = {}, pages = false } = {}) {
  const requestEnv = pages ? { VF_DB: db, NODE_ENV: 'production', ...env } : env
  return {
    env: pages ? requestEnv : undefined,
    headers: pages ? { 'cf-connecting-ip': ip } : { 'x-real-ip': ip },
    socket: { remoteAddress: ip },
  }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(body = '') {
      this.body = body
    },
  }
}

describe('durable fixed-window rate limiter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('allows requests through the configured maximum', async () => {
    const d1 = realD1()
    const limiter = createDurableRateLimiter({ now: () => 10_000 })
    const req = request({ db: d1, pages: true })
    expect(await limiter(req, response(), LIMIT)).toBe(true)
    expect(await limiter(req, response(), LIMIT)).toBe(true)
  })

  it('denies max+1 with an aligned Retry-After value', async () => {
    const d1 = realD1()
    const limiter = createDurableRateLimiter({ now: () => 10_000 })
    const req = request({ db: d1, pages: true })
    await limiter(req, response(), LIMIT)
    await limiter(req, response(), LIMIT)
    const res = response()
    expect(await limiter(req, res, LIMIT)).toBe(false)
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBe('50')
    expect(JSON.parse(res.body)).toEqual({ error: 'Too many requests' })
  })

  it('uses the shared D1 row across fresh limiter instances', async () => {
    const d1 = realD1()
    const req = request({ db: d1, pages: true })
    await createDurableRateLimiter({ now: () => 10_000 })(req, response(), LIMIT)
    await createDurableRateLimiter({ now: () => 10_000 })(req, response(), LIMIT)
    const res = response()
    expect(await createDurableRateLimiter({ now: () => 10_000 })(req, res, LIMIT)).toBe(false)
    expect(res.statusCode).toBe(429)
  })

  it('isolates route buckets for the same client IP', async () => {
    const d1 = realD1()
    const limiter = createDurableRateLimiter({ now: () => 10_000 })
    const req = request({ db: d1, pages: true })
    await limiter(req, response(), { ...LIMIT, bucket: 'farm' })
    await limiter(req, response(), { ...LIMIT, bucket: 'farm' })
    expect(await limiter(req, response(), { ...LIMIT, bucket: 'status' })).toBe(true)
  })

  it('isolates client IP buckets', async () => {
    const d1 = realD1()
    const limiter = createDurableRateLimiter({ now: () => 10_000 })
    const first = request({ db: d1, pages: true, ip: '198.51.100.7' })
    const second = request({ db: d1, pages: true, ip: '198.51.100.8' })
    await limiter(first, response(), LIMIT)
    await limiter(first, response(), LIMIT)
    expect(await limiter(second, response(), LIMIT)).toBe(true)
  })

  it('starts a new aligned window exactly at the reset boundary', async () => {
    const d1 = realD1()
    let now = 59_999
    const limiter = createDurableRateLimiter({ now: () => now })
    const req = request({ db: d1, pages: true })
    await limiter(req, response(), LIMIT)
    await limiter(req, response(), LIMIT)
    expect(await limiter(req, response(), LIMIT)).toBe(false)
    now = 60_000
    const res = response()
    expect(await limiter(req, res, LIMIT)).toBe(true)
    expect(res.statusCode).toBe(200)
    const row = d1.database
      .prepare(
        'SELECT route_bucket, client_ip, window_start_ms, request_count FROM vf_cross_rate_limits'
      )
      .all()
    expect(row).toEqual([
      {
        route_bucket: 'default',
        client_ip: '198.51.100.7',
        window_start_ms: 60_000,
        request_count: 1,
      },
    ])
  })

  it('does not move the reset trajectory when denied calls repeat', async () => {
    let now = 10_000
    const d1 = realD1()
    const limiter = createDurableRateLimiter({ now: () => now })
    const req = request({ db: d1, pages: true })
    await limiter(req, response(), LIMIT)
    await limiter(req, response(), LIMIT)
    const firstDenied = response()
    await limiter(req, firstDenied, LIMIT)
    now = 10_001
    const secondDenied = response()
    await limiter(req, secondDenied, LIMIT)
    expect(firstDenied.headers['retry-after']).toBe('50')
    expect(secondDenied.headers['retry-after']).toBe('50')
  })

  it('keeps concurrent requests atomic at the maximum', async () => {
    const d1 = realD1({ yieldAfterStatement: true })
    const limiter = createDurableRateLimiter({ now: () => 10_000 })
    const req = request({ db: d1, pages: true })
    const results = await Promise.all(
      Array.from({ length: 12 }, () => limiter(req, response(), LIMIT))
    )
    expect(results.filter(Boolean)).toHaveLength(2)
    const row = d1.database
      .prepare('SELECT request_count FROM vf_cross_rate_limits WHERE route_bucket = ?')
      .get('default')
    expect(row.request_count).toBe(12)
  })

  it('fails closed without D1 in production and Pages development', async () => {
    const limiter = createDurableRateLimiter({ memoryLimit: vi.fn(() => true) })
    for (const req of [
      request({ pages: true, db: undefined }),
      { headers: { 'x-real-ip': '198.51.100.8' }, env: { NODE_ENV: 'production' } },
    ]) {
      const res = response()
      expect(await limiter(req, res, LIMIT)).toBe(false)
      expect(res.statusCode).toBe(503)
    }
  })

  it('allows only plain Vite development to use its injected memory limiter', async () => {
    const memory = vi.fn(() => true)
    const limiter = createDurableRateLimiter({ memoryLimit: memory })
    const req = { headers: { 'x-real-ip': '198.51.100.9' }, env: undefined }
    expect(await limiter(req, response(), LIMIT)).toBe(true)
    expect(memory).toHaveBeenCalledTimes(1)
  })

  it('fails closed on D1 errors without invoking memory fallback or leaking details', async () => {
    const d1 = {
      prepare: vi.fn(() => {
        throw new Error('D1 secret connection detail')
      }),
    }
    const memory = vi.fn(() => true)
    const limiter = createDurableRateLimiter({ memoryLimit: memory })
    const res = response()
    expect(await limiter(request({ db: d1, pages: true }), res, LIMIT)).toBe(false)
    expect(res.statusCode).toBe(503)
    expect(res.body).toBe(JSON.stringify({ error: 'Rate limit unavailable' }))
    expect(res.body).not.toContain('D1 secret')
    expect(memory).not.toHaveBeenCalled()
  })

  it('fails closed when the rate-limit migration has not run', async () => {
    const d1 = realD1({ migrated: false })
    const res = response()
    expect(
      await createDurableRateLimiter({ now: () => 10_000 })(
        request({ db: d1, pages: true }),
        res,
        LIMIT
      )
    ).toBe(false)
    expect(res.statusCode).toBe(503)
  })

  it('fails closed for missing or invalid authoritative Pages IP', async () => {
    const d1 = realD1()
    const limiter = createDurableRateLimiter({ now: () => 10_000 })
    for (const headers of [{}, { 'cf-connecting-ip': 'spoofed,198.51.100.1' }]) {
      const res = response()
      expect(await limiter({ env: { VF_DB: d1 }, headers }, res, LIMIT)).toBe(false)
      expect(res.statusCode).toBe(503)
    }
  })
})

describe('durable limiter route policies', () => {
  it('freezes strict write, status, and public/readiness tiers', () => {
    expect(EDGE_LIMITS.strictWrite.max).toBe(30)
    expect(EDGE_LIMITS.authenticatedStatus.max).toBe(120)
    expect(EDGE_LIMITS.publicRead.max).toBe(240)
    expect(EDGE_LIMITS.strictWrite.max).toBeLessThan(EDGE_LIMITS.authenticatedStatus.max)
    expect(EDGE_LIMITS.authenticatedStatus.max).toBeLessThan(EDGE_LIMITS.publicRead.max)
  })

  it('assigns each vf-cross route its own policy bucket', () => {
    const farm = resolveVfCrossLimit({ method: 'POST', path: '/farm' })
    const status = resolveVfCrossLimit({ method: 'POST', path: '/status' })
    const config = resolveVfCrossLimit({ method: 'GET', path: '/config' })
    expect(farm.max).toBe(30)
    expect(status.max).toBe(120)
    expect(config.max).toBe(240)
    expect(farm.bucket).not.toBe(status.bucket)
    expect(config.bucket).not.toBe(farm.bucket)
    expect(resolveVfCrossLimit({ method: 'GET', path: '/unknown' })).toBeNull()
  })

  it('covers Base cross-chain Agent Index actions and rejects unknown actions', () => {
    for (const action of [
      'base-child-intent-batch',
      'base-child-evidence',
      'base-recovery-request',
      'base-recovery-claim',
      'base-recovery-renew',
      'base-recovery-release',
      'lease-acquire',
      'lease-release',
      'associate',
    ]) {
      expect(resolveAgentIndexCrossLimit({ method: 'POST', action }).max).toBe(30)
    }
    expect(resolveAgentIndexCrossLimit({ method: 'POST', action: 'base-child-ready' }).max).toBe(
      240
    )
    expect(resolveAgentIndexCrossLimit({ method: 'GET', action: 'base-child-evidence' }).max).toBe(
      240
    )
    expect(resolveAgentIndexCrossLimit({ method: 'POST', action: 'not-real' })).toBeNull()
  })
})
