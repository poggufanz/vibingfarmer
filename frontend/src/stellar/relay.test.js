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

  it('returns null on a non-2xx response', async () => {
    global.fetch = vi.fn(async () => ({ ok: false }))
    expect(await submitViaRelay({ xdr: 'x' })).toBeNull()
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
