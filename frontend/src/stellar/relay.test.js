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

  it('returns null when the relay is unconfigured (configured:false)', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ configured: false }) }))
    expect(await submitViaRelay({ xdr: 'x' })).toBeNull()
  })

  it('returns null when the relay reports itself unconfigured (503)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    expect(await submitViaRelay({ xdr: 'x' })).toBeNull()
  })

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

  it('returns null on a network throw (never crashes the worker)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await submitViaRelay({ xdr: 'x' })).toBeNull()
  })

  it('getRelayerAddress returns the relayer pubkey', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ address: 'GREL' }) }))
    expect(await getRelayerAddress()).toBe('GREL')
  })
})
