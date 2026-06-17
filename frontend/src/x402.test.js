import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getX402Balance, canUseX402 } from './x402.js'
import { VENICE_BASE_URL } from './config.js'

const ADDR = '0x1234567890abcdef1234567890abcdef12345678'
const AUTH = 'base64-siwe-header'

function okJson(body) {
  return { ok: true, json: async () => body }
}

describe('getX402Balance', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null without address or auth (no fetch)', async () => {
    global.fetch = vi.fn()
    expect(await getX402Balance('', AUTH)).toBeNull()
    expect(await getX402Balance(ADDR, '')).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('GETs the balance endpoint with the X-Sign-In-With-X header', async () => {
    global.fetch = vi.fn(async () => okJson({ canConsume: true, balanceUsd: 7.5 }))
    await getX402Balance(ADDR, AUTH)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe(`${VENICE_BASE_URL}/x402/balance/${ADDR}`)
    expect(opts.method).toBe('GET')
    expect(opts.headers['X-Sign-In-With-X']).toBe(AUTH)
  })

  it('normalizes the funded response', async () => {
    global.fetch = vi.fn(async () =>
      okJson({
        canConsume: true,
        balanceUsd: 12.34,
        minimumTopUpUsd: 1,
        suggestedTopUpUsd: 5,
        diemBalanceUsd: 0,
      })
    )
    const bal = await getX402Balance(ADDR, AUTH)
    expect(bal).toEqual({
      canConsume: true,
      balanceUsd: 12.34,
      minimumTopUpUsd: 1,
      suggestedTopUpUsd: 5,
      diemBalanceUsd: 0,
    })
  })

  it('coerces missing numeric fields to 0 and canConsume to boolean', async () => {
    global.fetch = vi.fn(async () => okJson({ canConsume: undefined }))
    const bal = await getX402Balance(ADDR, AUTH)
    expect(bal.canConsume).toBe(false)
    expect(bal.balanceUsd).toBe(0)
  })

  it('returns null (fail-soft) on a non-ok response', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401 }))
    expect(await getX402Balance(ADDR, AUTH)).toBeNull()
  })

  it('returns null (fail-soft) on a network throw', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network')
    })
    expect(await getX402Balance(ADDR, AUTH)).toBeNull()
  })
})

describe('canUseX402', () => {
  it('blocks only when balance is known-unfunded (canConsume === false)', () => {
    expect(canUseX402({ canConsume: false, balanceUsd: 0 })).toBe(false)
  })

  it('allows when funded', () => {
    expect(canUseX402({ canConsume: true, balanceUsd: 5 })).toBe(true)
  })

  it('allows when balance is unknown (null) — optimistic, no regression', () => {
    expect(canUseX402(null)).toBe(true)
  })
})
