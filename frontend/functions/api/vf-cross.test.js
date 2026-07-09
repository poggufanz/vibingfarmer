// frontend/functions/api/vf-cross.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import handler, { _test } from '../../api/vf-cross.js'

function fakeReq({
  method = 'POST',
  url = '/api/vf-cross/farm',
  body = { a: 1 },
  origin = 'http://localhost:5173',
} = {}) {
  return {
    method,
    url,
    body,
    headers: { origin, 'content-type': 'application/json' },
    socket: { remoteAddress: '1.2.3.4' },
  }
}
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(b) {
      this.body = b || ''
    },
  }
}

describe('/api/vf-cross proxy', () => {
  beforeEach(() => {
    process.env.RELAYER_ORIGIN = 'https://relayer.example.com'
    process.env.RELAYER_PROXY_KEY = 'sekret'
  })

  it('forwards method, sub-path, JSON body and injects the proxy key', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ jobId: 'j1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const res = fakeRes()
    await handler(fakeReq(), res, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://relayer.example.com/api/vf-cross/farm')
    expect(init.method).toBe('POST')
    expect(init.headers['x-vf-relayer-key']).toBe('sekret')
    expect(JSON.parse(init.body)).toEqual({ a: 1 })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ jobId: 'j1' })
  })

  it('GET /status/:id forwards without a body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: 'done' }), { status: 200 })
    )
    const res = fakeRes()
    await handler(
      fakeReq({ method: 'GET', url: '/api/vf-cross/status/j1', body: undefined }),
      res,
      { fetchImpl }
    )
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://relayer.example.com/api/vf-cross/status/j1')
    expect(init.body).toBeUndefined()
  })

  it('503 when RELAYER_ORIGIN unset (fail-closed, never a silent localhost default)', async () => {
    delete process.env.RELAYER_ORIGIN
    const res = fakeRes()
    await handler(fakeReq(), res, { fetchImpl: vi.fn() })
    expect(res.statusCode).toBe(503)
  })

  it('502 when the relayer is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED 10.0.0.1')
    })
    const res = fakeRes()
    await handler(fakeReq(), res, { fetchImpl })
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain('10.0.0.1') // sanitized
  })

  it('rejects disallowed origins via _guard (403)', async () => {
    const res = fakeRes()
    await handler(fakeReq({ origin: 'https://evil.example' }), res, { fetchImpl: vi.fn() })
    expect(res.statusCode).toBe(403)
  })

  it('_test.subPath extracts the relayer sub-path', () => {
    expect(_test.subPath('/api/vf-cross/status/j%201')).toBe('/status/j%201')
    expect(_test.subPath('/api/vf-cross')).toBe('/')
  })
})
