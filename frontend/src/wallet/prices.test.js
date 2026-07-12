import { describe, it, expect, vi } from 'vitest'
import { fetchXlmUsd, portfolioValue } from './prices.js'

describe('prices', () => {
  it('returns null (degrades) when CoinGecko fails - no throw', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false }))
    expect(await fetchXlmUsd({ fetchImpl })).toBeNull()
  })

  it('sums XLM + pegged USDC, marks incomplete when a price is missing', () => {
    const balances = [
      { asset: 'XLM', code: 'XLM', issuer: null, balance: '100' },
      { asset: 'USDC:GX', code: 'USDC', issuer: 'GX', balance: '5' },
      { asset: 'FOO:GY', code: 'FOO', issuer: 'GY', balance: '9' },
    ]
    const pv = portfolioValue(balances, 0.1) // XLM=$0.1
    expect(pv.total).toBeCloseTo(100 * 0.1 + 5) // 15
    expect(pv.complete).toBe(false) // FOO has no price
  })
})
