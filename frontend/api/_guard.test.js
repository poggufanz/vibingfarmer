import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyCors } from './_guard.js'

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
})
