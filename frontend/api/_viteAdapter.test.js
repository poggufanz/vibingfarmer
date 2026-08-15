import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withJsonBody } from './_viteAdapter.js'
import vfCrossProxy from './vf-cross.js'

const LIMIT = 64 * 1024

function rawRequest({
  method = 'POST',
  url = '/api/vf-cross/mandate',
  body = '',
  headers = {},
} = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = { ...headers }
  request.pause = vi.fn()
  if (body !== undefined && !('content-length' in request.headers)) {
    request.headers['content-length'] = String(Buffer.byteLength(body))
  }
  return request
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end(body = '') {
      this.body = body
    },
  }
}

async function invoke(handler, options = {}) {
  const req = rawRequest(options)
  const res = response()
  const next = vi.fn()
  const pending = withJsonBody(handler)(req, res, next)
  if (options.body !== undefined && Number(req.headers['content-length']) <= LIMIT) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(options.body))
      req.emit('end')
    })
  }
  await pending
  return { req, res, next }
}

describe('Vite raw Node JSON adapter', () => {
  beforeEach(() => {
    process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
    process.env.RELAYER_ORIGIN = 'https://relayer.example.com'
    process.env.RELAYER_PROXY_KEY = 'current-proxy-key'
  })

  afterEach(() => {
    delete process.env.ALLOWED_ORIGIN
    delete process.env.RELAYER_ORIGIN
    delete process.env.RELAYER_PROXY_KEY
  })

  it('forwards a canonical raw-node POST through the real vf-cross handler after parsing', async () => {
    const mandateId = '11'.repeat(16)
    const upstream = vi.fn(async (url, init) => {
      expect(url).toBe('https://relayer.example.com/api/vf-cross/mandate')
      expect(JSON.parse(init.body)).toMatchObject({ mandateId })
      return {
        status: 202,
        headers: {
          getSetCookie: () => [
            `__Host-vf-mandate-${mandateId}=${'22'.repeat(32)}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
          ],
        },
        text: async () => '{}',
      }
    })
    const handler = (req, res) =>
      vfCrossProxy(req, res, { fetchImpl: upstream, rateLimitImpl: async () => true })
    const { res } = await invoke(handler, {
      body: JSON.stringify({ mandateId, capability: '33'.repeat(32) }),
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
    })

    expect(res.statusCode).toBe(202)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('does not enter the real vf-cross handler for malformed or oversized raw bodies', async () => {
    const upstream = vi.fn()
    const handler = (req, res) =>
      vfCrossProxy(req, res, { fetchImpl: upstream, rateLimitImpl: async () => true })
    const malformed = await invoke(handler, {
      body: '{not-json',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
    })
    expect(malformed.res.statusCode).toBe(400)
    const oversized = await invoke(handler, {
      body: '',
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'content-length': String(LIMIT + 1),
      },
    })
    expect(oversized.res.statusCode).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('parses a canonical cross-chain POST before invoking the injected handler', async () => {
    const handler = vi.fn((req, res) => {
      expect(req.body).toEqual({ mandateId: 'mandate-123', action: 'status' })
      res.statusCode = 201
      res.end(JSON.stringify({ ok: true }))
    })

    const { res } = await invoke(handler, {
      body: JSON.stringify({ mandateId: 'mandate-123', action: 'status' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(res.statusCode).toBe(201)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('returns generic 400 for malformed JSON without invoking the handler', async () => {
    const handler = vi.fn()
    const { res } = await invoke(handler, {
      body: '{not-json',
      headers: { 'content-type': 'application/json' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid request' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 413 for an oversized declared body without invoking the handler', async () => {
    const handler = vi.fn()
    const { res } = await invoke(handler, {
      body: '',
      headers: { 'content-length': String(LIMIT + 1) },
    })

    expect(res.statusCode).toBe(413)
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large' })
    expect(handler).not.toHaveBeenCalled()
  })
})
