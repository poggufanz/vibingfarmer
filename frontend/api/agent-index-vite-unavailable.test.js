import { describe, expect, it, vi } from 'vitest'
import unavailable from './agent-index-vite-unavailable.js'

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

describe('plain Vite Agent Index unavailable handler', () => {
  it.each([
    ['GET', '/api/agent-index?action=receipt-challenge', undefined],
    ['POST', '/api/agent-index?action=receipt-challenge', { secret: 'must-not-reflect' }],
  ])('returns a generic JSON 503 for %s %s', (method, url, body) => {
    const res = response()
    const next = vi.fn()
    unavailable({ method, url, body }, res, next)
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(res.body)).toEqual({
      error: 'Agent index requires Pages+D1; use npm run pages:dev',
    })
    expect(res.body).not.toContain('must-not-reflect')
    expect(next).not.toHaveBeenCalled()
  })
})
