import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyCors, clientIp, rateLimit } from './_guard.js'

const mockRes = () => {
  const res = { statusCode: 200, headers: {}, body: null }
  res.setHeader = vi.fn((k, v) => (res.headers[k] = v))
  res.end = vi.fn((b) => (res.body = b))
  return res
}

describe('applyCors origin resolution', () => {
  const OLD = process.env.ALLOWED_ORIGIN
  beforeEach(() => {
    process.env.ALLOWED_ORIGIN = 'https://dev.vibing-farmer.pages.dev'
  })
  afterEach(() => {
    process.env.ALLOWED_ORIGIN = OLD
  })

  it('allows an allowlisted Origin header', () => {
    const res = mockRes()
    const ok = applyCors({ headers: { origin: 'https://dev.vibing-farmer.pages.dev' } }, res)
    expect(ok).toBe(true)
    expect(res.headers['Access-Control-Allow-Credentials']).toBe('true')
  })

  it('falls back to the Referer origin on same-origin GETs (no Origin header)', () => {
    const res = mockRes()
    const ok = applyCors({ headers: { referer: 'https://dev.vibing-farmer.pages.dev/home' } }, res)
    expect(ok).toBe(true)
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://dev.vibing-farmer.pages.dev')
  })

  it('rejects when neither Origin nor Referer is present', () => {
    const res = mockRes()
    expect(applyCors({ headers: {} }, res)).toBe(false)
    expect(res.statusCode).toBe(403)
  })

  it('rejects a non-allowlisted Referer and a malformed Referer', () => {
    const res1 = mockRes()
    expect(applyCors({ headers: { referer: 'https://evil.example/page' } }, res1)).toBe(false)
    const res2 = mockRes()
    expect(applyCors({ headers: { referer: 'not a url' } }, res2)).toBe(false)
    expect(res2.statusCode).toBe(403)
  })

  it('uses request-local production mode instead of a module-load snapshot', () => {
    const production = mockRes()
    expect(
      applyCors(
        { env: { NODE_ENV: 'production' }, headers: { origin: 'http://localhost:5173' } },
        production
      )
    ).toBe(false)

    const development = mockRes()
    expect(
      applyCors(
        { env: { NODE_ENV: 'development' }, headers: { origin: 'http://localhost:5173' } },
        development
      )
    ).toBe(true)
  })

  it('does not use a stale process allowlist when a Pages environment omits it', () => {
    process.env.ALLOWED_ORIGIN = 'https://stale.example'
    const res = mockRes()
    expect(applyCors({ env: {}, headers: { origin: 'https://stale.example' } }, res)).toBe(false)
    expect(res.statusCode).toBe(403)
  })

  it('allows only exact extension origins explicitly listed by configuration', () => {
    const env = {
      NODE_ENV: 'production',
      ALLOWED_EXTENSION_ORIGINS: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }
    const allowed = mockRes()
    expect(
      applyCors(
        {
          env,
          headers: { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        allowed
      )
    ).toBe(true)

    for (const origin of [
      'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
      'chrome-extension://AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      const rejected = mockRes()
      expect(applyCors({ env, headers: { origin } }, rejected)).toBe(false)
      expect(rejected.statusCode).toBe(403)
    }
  })

  it('chooses the right-side trusted XFF hop per request', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '198.51.100.1, 198.51.100.2, 198.51.100.3' },
      })
    ).toBe('198.51.100.3')
    expect(
      clientIp({
        env: { NODE_ENV: 'development', TRUST_PROXY_HOPS: '1' },
        headers: {
          'cf-connecting-ip': '198.51.100.2',
          'x-forwarded-for': '198.51.100.1, 198.51.100.3',
        },
      })
    ).toBe('198.51.100.2')
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '198.51.100.1, 198.51.100.2, 198.51.100.3' },
      })
    ).toBe('198.51.100.3')
  })

  it('fails closed when Pages has no authoritative Cloudflare client IP', () => {
    const res = mockRes()
    expect(
      rateLimit({ env: { NODE_ENV: 'development' }, headers: { 'x-real-ip': 'spoofed' } }, res, {
        bucket: 'guard-pages-ip-test',
      })
    ).toBe(false)
    expect(res.statusCode).toBe(503)
  })
})
