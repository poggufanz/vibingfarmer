import { describe, it, expect, beforeEach, vi } from 'vitest'
import { submitViaRelay, getRelayerAddress } from './relay.js'

describe('stellar client relay', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs action:submit + xdr and maps { hash, status, relayer }', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ hash: 'abc', status: 'SUCCESS', relayer: 'GREL' }),
    }))
    const out = await submitViaRelay({ xdr: 'AAA>>>base64' })
    expect(out).toEqual({ hash: 'abc', status: 'SUCCESS', relayer: 'GREL' })
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body).toEqual({ action: 'submit', xdr: 'AAA>>>base64' })
    expect(global.fetch.mock.calls[0][0]).toBe('/api/stellar-relay')
  })

  it('returns null only for the real clean pre-submit unconfigured response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Stellar relay not configured', configured: false }),
    }))
    expect(await submitViaRelay({ xdr: 'x' })).toBeNull()
  })

  it.each([
    ['a bare 503', { ok: false, status: 503, body: {} }],
    ['a synthetic configured:false 200', { ok: true, status: 200, body: { configured: false } }],
  ])(
    'classifies %s as unknown rather than proven pre-submit unconfigured',
    async (_label, fixture) => {
      global.fetch = vi.fn(async () => ({
        ok: fixture.ok,
        status: fixture.status,
        json: async () => fixture.body,
      }))
      await expect(submitViaRelay({ xdr: 'x' })).rejects.toMatchObject({
        code: 'VF_SUBMISSION_UNKNOWN',
      })
    }
  )

  // Regression: a refusal used to return null, which grant.js read as "no relay" and answered by
  // billing the grant to a user who holds no XLM — a config error wearing a balance error's face.
  it('THROWS (never returns null) when the relay refuses — 403 origin', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden' }),
    }))
    await expect(submitViaRelay({ xdr: 'x' })).rejects.toThrow(/refused.*403.*Forbidden/)
  })

  it('THROWS when the relay refuses with a 200 + error body', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: 'inner tx does not target the vault' }),
    }))
    await expect(submitViaRelay({ xdr: 'x' })).rejects.toThrow(/does not target the vault/)
  })

  it('THROWS with the status even when the refusal body is not JSON', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => {
        throw new Error('not json')
      },
    }))
    await expect(submitViaRelay({ xdr: 'x' })).rejects.toThrow(/429/)
  })

  it('classifies a lost response after POST as submission-unknown, never unconfigured', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(submitViaRelay({ xdr: 'x' })).rejects.toMatchObject({
      name: 'RelaySubmissionUnknownError',
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      result: null,
    })
  })

  it.each([
    [502, { error: 'poll failed', submission: 'unknown', hash: 'H502', status: 'PENDING' }],
    [
      409,
      {
        error: 'inner tx already in flight',
        submission: 'unknown',
        hash: 'H409',
        status: 'PENDING',
      },
    ],
  ])(
    'classifies producer HTTP %s ambiguity as unknown and preserves evidence',
    async (status, body) => {
      global.fetch = vi.fn(async () => ({ ok: false, status, json: async () => body }))
      await expect(submitViaRelay({ xdr: 'x' })).rejects.toMatchObject({
        code: 'VF_SUBMISSION_UNKNOWN',
        result: { hash: body.hash, status: body.status },
      })
    }
  )

  it('never accepts a backward bare duplicate as transaction success', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hash: 'HOLD', status: 'duplicate' }),
    }))
    await expect(submitViaRelay({ xdr: 'x' })).rejects.toMatchObject({
      code: 'VF_SUBMISSION_UNKNOWN',
      result: { hash: 'HOLD', status: 'duplicate' },
    })
  })

  it.each(['SUCCESS', 'FAILED'])(
    'preserves a producer-proven cached %s duplicate',
    async (status) => {
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ hash: `H${status}`, status, duplicate: true, relayer: 'GREL' }),
      }))
      await expect(submitViaRelay({ xdr: 'x' })).resolves.toEqual({
        hash: `H${status}`,
        status,
        duplicate: true,
        relayer: 'GREL',
      })
    }
  )

  it.each([
    [
      { hash: 'HPENDING', status: 'PENDING' },
      { hash: 'HPENDING', status: 'PENDING' },
    ],
    [{ hash: 'HMALFORMED' }, { hash: 'HMALFORMED' }],
    [{ status: 'SUCCESS' }, { status: 'SUCCESS' }],
  ])(
    'classifies an unproved 2xx relay body as unknown and preserves its evidence',
    async (body, result) => {
      global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))

      await expect(submitViaRelay({ xdr: 'x' })).rejects.toEqual(
        expect.objectContaining({
          name: 'RelaySubmissionUnknownError',
          code: 'VF_SUBMISSION_UNKNOWN',
          result,
        })
      )
    }
  )

  it('getRelayerAddress returns the relayer pubkey', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ address: 'GREL' }) }))
    expect(await getRelayerAddress()).toBe('GREL')
  })
})
