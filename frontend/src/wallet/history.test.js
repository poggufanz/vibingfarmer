import { describe, it, expect, vi } from 'vitest'
import { fetchHistory } from './history.js'

describe('history', () => {
  it('maps Horizon payments and tags direction', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        _embedded: {
          records: [
            {
              id: '1',
              type: 'payment',
              from: 'GME',
              to: 'GYOU',
              asset_type: 'native',
              amount: '3',
              created_at: 't',
            },
          ],
        },
      }),
    }))
    const out = await fetchHistory('GME', { fetchImpl })
    expect(out[0]).toMatchObject({ asset: 'XLM', amount: '3', direction: 'out' })
  })

  it('degrades to empty list when fetchImpl throws (network error)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network unreachable')
    })
    const out = await fetchHistory('GXYZ', { fetchImpl })
    expect(out).toEqual([])
  })

  it('degrades to empty list when response is not ok', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
    }))
    const out = await fetchHistory('GXYZ', { fetchImpl })
    expect(out).toEqual([])
  })

  it('maps create_account record with correct direction', async () => {
    const publicKey = 'GYOU'
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        _embedded: {
          records: [
            {
              id: '1',
              type: 'create_account',
              funder: 'GME',
              account: publicKey,
              starting_balance: '10',
              created_at: 't',
            },
          ],
        },
      }),
    }))
    const out = await fetchHistory(publicKey, { fetchImpl })
    expect(out[0]).toMatchObject({
      asset: 'XLM',
      amount: '10',
      type: 'create_account',
      from: 'GME',
      direction: 'in',
    })
  })
})
