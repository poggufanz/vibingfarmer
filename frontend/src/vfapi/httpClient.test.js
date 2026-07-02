import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeVfClient } from './httpClient.js'

afterEach(() => vi.unstubAllGlobals())

describe('makeVfClient', () => {
  it('sends the Bearer key and parses JSON per method', async () => {
    const seen = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts = {}) => {
        seen.push([String(url), opts.method || 'GET', opts.headers?.Authorization])
        return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
      })
    )
    const c = makeVfClient({ apiKey: 'vf_test_k' })
    await c.prices('coingecko:stellar')
    await c.eligibility({ vault: 'C1', amount: '1' })
    await c.submit('XDR')
    expect(seen).toEqual([
      ['/api/vf/prices?coins=coingecko%3Astellar', 'GET', 'Bearer vf_test_k'],
      ['/api/vf/eligibility', 'POST', 'Bearer vf_test_k'],
      ['/api/vf/submit', 'POST', 'Bearer vf_test_k'],
    ])
  })
  it('throws the server error message on non-200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Out of scope' }), { status: 403 }))
    )
    const c = makeVfClient({ apiKey: 'vf_test_k' })
    await expect(c.scan({ target: 'G' })).rejects.toThrow('Out of scope')
  })
})
