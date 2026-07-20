// frontend/src/base/baseHistory.test.js
import { describe, it, expect, vi } from 'vitest'
import { fetchBaseHistory } from './baseHistory.js'

const K = '0x66fe3bb4ade38dd55504813cb0c8d77f3c7974e9'

describe('fetchBaseHistory', () => {
  it('maps Blockscout tokentx rows to dashboard entries with direction', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            hash: '0xmint',
            timeStamp: '1784502242',
            tokenSymbol: 'USDC',
            tokenDecimal: '6',
            value: '21000000',
            from: '0x0000000000000000000000000000000000000000',
            to: K,
          },
          {
            hash: '0xdep',
            timeStamp: '1784502246',
            tokenSymbol: 'USDC',
            tokenDecimal: '6',
            value: '12000000',
            from: K,
            to: '0xf80aa8f571e6d24ea72f051fc6f9a9c516727b6d',
          },
        ],
      }),
    })
    const rows = await fetchBaseHistory({ account: K, fetchImpl })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ symbol: 'USDC', amount: 21, direction: 'in' })
    expect(rows[1]).toMatchObject({ amount: 12, direction: 'out' })
  })

  it('fail-soft: no account, HTTP error, or non-array result -> []', async () => {
    expect(await fetchBaseHistory({})).toEqual([])
    expect(
      await fetchBaseHistory({ account: K, fetchImpl: vi.fn().mockResolvedValue({ ok: false }) })
    ).toEqual([])
    expect(
      await fetchBaseHistory({
        account: K,
        fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: 'rate limited' }) }),
      })
    ).toEqual([])
    expect(
      await fetchBaseHistory({ account: K, fetchImpl: vi.fn().mockRejectedValue(new Error('net')) })
    ).toEqual([])
  })
})
