import { describe, it, expect, vi, afterEach } from 'vitest'
import { signIn, listKeys, createKey, revokeKey } from './portalClient.js'

afterEach(() => vi.unstubAllGlobals())

const okJson = (obj) => new Response(JSON.stringify(obj), { status: 200 })

describe('portalClient', () => {
  it('signIn: challenge → wallet sign → token', async () => {
    const calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        calls.push([String(url), opts])
        if (String(url).includes('/auth/challenge')) return okJson({ transaction: 'CHAL_XDR' })
        return okJson({ token: 'JWT123' })
      })
    )
    const signChallenge = vi.fn(async (xdr) => `${xdr}:signed`)
    const jwt = await signIn({ account: 'GAAA', signChallenge })
    expect(signChallenge).toHaveBeenCalledWith('CHAL_XDR')
    expect(jwt).toBe('JWT123')
    expect(JSON.parse(calls[1][1].body)).toEqual({ transaction: 'CHAL_XDR:signed' })
  })
  it('key CRUD sends the JWT bearer and parses results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, opts) => {
        expect(opts.headers.Authorization).toBe('Bearer J')
        if (opts.method === 'POST')
          return okJson({ id: 'vfk_1', key: 'vf_test_x', hint: 'vf_test_x…' })
        if (opts.method === 'DELETE') return okJson({ revoked: true })
        return okJson({ keys: [{ id: 'vfk_1' }] })
      })
    )
    expect((await createKey('J', { scopes: ['market'], env: 'test', rateLimit: 60 })).key).toBe(
      'vf_test_x'
    )
    expect(await listKeys('J')).toEqual([{ id: 'vfk_1' }])
    expect(await revokeKey('J', 'vfk_1')).toBe(true)
  })
  it('throws a readable error on non-200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401 }))
    )
    await expect(listKeys('bad')).rejects.toThrow('Invalid session')
  })
})
