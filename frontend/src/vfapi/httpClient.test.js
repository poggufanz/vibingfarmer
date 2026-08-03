import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeVfClient } from './httpClient.js'
import { RelaySubmissionUnknownError } from '../stellar/relay.js'

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

  it('types an unknown submit body before generic HTTP handling without changing other endpoints', async () => {
    const body = {
      submission: 'unknown',
      error: 'reconcile this hash',
      hash: 'HKNOWN',
      status: 'PENDING',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    )
    const c = makeVfClient({ apiKey: 'vf_test_k' })

    let error
    try {
      await c.submit('XDR')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(RelaySubmissionUnknownError)
    expect(error).toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      httpStatus: 200,
      result: { hash: 'HKNOWN', status: 'PENDING' },
    })
    await expect(c.scan({ target: 'G' })).resolves.toEqual(body)
  })
})
