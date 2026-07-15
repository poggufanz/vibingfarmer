import { describe, it, expect, vi } from 'vitest'
import { getTestUsdc, PER_CALL_BASE_UNITS } from './faucet.js'

const tok = (n) => BigInt(n) * 10n ** 7n
const okRes = (hash = 'H') => ({ ok: true, status: 200, json: async () => ({ hash }) })

describe('getTestUsdc (client loop over the 100-cap faucet)', () => {
  it('loops to reach a >100 amount, one call per 100 cap', async () => {
    const fetchImpl = vi.fn(async () => okRes('HASH'))
    const out = await getTestUsdc({ to: 'GDEST', amount: tok(300), fetchImpl })
    expect(out.dispensed).toBe(tok(300))
    expect(out.calls).toBe(3) // 100 + 100 + 100
    expect(out.capped).toBe(false)
    expect(out.lastHash).toBe('HASH')
    // Each request body never exceeds the per-call cap:
    for (const call of fetchImpl.mock.calls) {
      const body = JSON.parse(call[1].body)
      expect(BigInt(body.amount) <= PER_CALL_BASE_UNITS).toBe(true)
    }
  })

  it('sends a sub-cap remainder on the last call (250 = 100+100+50)', async () => {
    const fetchImpl = vi.fn(async () => okRes())
    const out = await getTestUsdc({ to: 'GDEST', amount: tok(250), fetchImpl })
    expect(out.calls).toBe(3)
    expect(out.dispensed).toBe(tok(250))
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).amount).toBe(tok(50).toString())
  })

  it('stops early and reports capped when the server returns 429', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okRes())
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'cap' })
    const out = await getTestUsdc({ to: 'GDEST', amount: tok(300), fetchImpl })
    expect(out.capped).toBe(true)
    expect(out.dispensed).toBe(tok(100)) // only the first call landed
    expect(out.calls).toBe(1)
  })

  it('throws on a non-429 HTTP failure', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }))
    await expect(getTestUsdc({ to: 'GDEST', amount: tok(100), fetchImpl })).rejects.toThrow(/503/)
  })

  it('defaults a non-positive amount to one 100 dispense', async () => {
    const fetchImpl = vi.fn(async () => okRes())
    const out = await getTestUsdc({ to: 'GDEST', amount: 0n, fetchImpl })
    expect(out.calls).toBe(1)
    expect(out.dispensed).toBe(PER_CALL_BASE_UNITS)
  })
})
