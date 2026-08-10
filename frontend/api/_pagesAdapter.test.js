import { describe, expect, it, vi } from 'vitest'
import { toPagesFunction } from './_pagesAdapter.js'

const LIMIT = 64 * 1024

async function invoke(handler, { method = 'POST', body, headers = {}, env = {} } = {}) {
  const request = new Request('https://app.example/api/test?x=a%2Bb', {
    method,
    headers,
    ...(body === undefined ? {} : { body, duplex: 'half' }),
  })
  return toPagesFunction(handler)({ request, env })
}

describe('Cloudflare Pages Node-style adapter', () => {
  it('keeps Pages bindings request-local and preserves the exact request URL', async () => {
    const binding = { prepare: vi.fn() }
    let seen
    const response = await invoke(
      (req, res) => {
        seen = req
        res.end('{}')
      },
      { method: 'GET', env: { VF_DB: binding } }
    )

    expect(response.status).toBe(200)
    expect(seen.env.VF_DB).toBe(binding)
    expect(process.env.VF_DB).toBeUndefined()
    expect(seen.url).toBe('https://app.example/api/test?x=a%2Bb')
  })

  it('overwrites spoofed x-real-ip with Cloudflare’s authoritative client IP', async () => {
    let seen
    await invoke(
      (req, res) => {
        seen = req
        res.end('{}')
      },
      {
        method: 'GET',
        headers: {
          'x-real-ip': '198.51.100.99',
          'cf-connecting-ip': '203.0.113.7',
        },
      }
    )
    expect(seen.headers['x-real-ip']).toBe('203.0.113.7')
    expect(seen.headers['cf-connecting-ip']).toBe('203.0.113.7')
  })

  it('keeps multiple Set-Cookie values independent and ordered', async () => {
    const response = await invoke(
      (_req, res) => {
        res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/'])
        res.end('{}')
      },
      { method: 'GET' }
    )
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
  })

  it('preserves ordinary header array behavior', async () => {
    const response = await invoke(
      (_req, res) => {
        res.setHeader('X-Example', ['one', 'two'])
        res.end('{}')
      },
      { method: 'GET' }
    )
    expect(response.headers.get('x-example')).toBe('one,two')
  })

  it('rejects a declared body over the edge byte ceiling before invoking the handler', async () => {
    const handler = vi.fn()
    const response = await invoke(handler, {
      body: JSON.stringify({ value: 'x'.repeat(LIMIT) }),
      headers: { 'content-length': String(LIMIT + 1) },
    })
    expect(response.status).toBe(413)
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    expect(await response.json()).toEqual({ error: 'Request body too large' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('stops a chunked body when streamed bytes exceed the ceiling', async () => {
    const handler = vi.fn()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(LIMIT)))
        controller.enqueue(new TextEncoder().encode('y'))
        controller.close()
      },
    })
    const request = new Request('https://app.example/api/test', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    })
    const response = await toPagesFunction(handler)({ request, env: {} })
    expect(response.status).toBe(413)
    expect(handler).not.toHaveBeenCalled()
  })

  it('counts UTF-8 bytes rather than JavaScript characters', async () => {
    let seen
    const body = JSON.stringify({ value: 'é'.repeat(20_000) })
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(LIMIT)
    const response = await invoke(
      (req, res) => {
        seen = req.body
        res.end('{}')
      },
      { body }
    )
    expect(response.status).toBe(200)
    expect(seen.value).toHaveLength(20_000)
  })

  it('parses valid JSON at the byte ceiling and invokes the handler once', async () => {
    let calls = 0
    const value = 'z'.repeat(LIMIT - 15)
    const body = JSON.stringify({ value })
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(LIMIT)
    const response = await invoke(
      (req, res) => {
        calls += 1
        expect(req.body.value).toBe(value)
        res.end('{}')
      },
      { body }
    )
    expect(response.status).toBe(200)
    expect(calls).toBe(1)
  })

  it('rejects malformed JSON under the ceiling before invoking the handler', async () => {
    const handler = vi.fn((_req, res) => res.end('{}'))
    const response = await invoke(handler, { body: '{not-json' })
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    expect(await response.json()).toEqual({ error: 'Invalid request' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not read a GET body', async () => {
    let seen
    const response = await invoke(
      (req, res) => {
        seen = req.body
        res.end('{}')
      },
      { method: 'GET' }
    )
    expect(response.status).toBe(200)
    expect(seen).toBeUndefined()
  })

  it('returns a generic JSON error when the handler throws', async () => {
    const response = await invoke(
      () => {
        throw new Error('secret internal detail')
      },
      { method: 'GET' }
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Server error' })
  })
})
