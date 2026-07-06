import { describe, it, expect, vi, beforeEach } from 'vitest'
import { open } from './coinbase.js'
import { PROVIDERS } from './OnRamp.js'

describe('coinbaseBaseOnRamp (documented fallback, spec §9)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('registers itself under PROVIDERS["coinbase-base"]', () => {
    expect(PROVIDERS['coinbase-base']).toBeDefined()
    expect(typeof PROVIDERS['coinbase-base'].open).toBe('function')
  })

  it('POSTs provider:coinbase-base with the Base address + amount to /api/onramp-session', async () => {
    global.fetch = vi.fn(async () => ({ ok: false })) // server route 501s (Task 4.2) — expected
    await expect(open({ address: '0xBaseAddr', amount: 20 })).rejects.toThrow(/unavailable/)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('/api/onramp-session')
    expect(JSON.parse(opts.body)).toEqual({
      provider: 'coinbase-base',
      address: '0xBaseAddr',
      amount: 20,
    })
  })
})
