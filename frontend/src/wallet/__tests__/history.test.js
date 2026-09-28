import { describe, it, expect, vi } from 'vitest'
import { fetchHistory } from '../history.js'

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

  it('resolves null when fetchImpl throws (network error is not an empty history)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network unreachable')
    })
    const out = await fetchHistory('GXYZ', { fetchImpl })
    expect(out).toBeNull()
  })

  it('resolves null when the response is not ok', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
    }))
    const out = await fetchHistory('GXYZ', { fetchImpl })
    expect(out).toBeNull()
  })

  it('carries the payment transaction hash for explorer links', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        _embedded: {
          records: [
            {
              id: '9',
              type: 'payment',
              from: 'GME',
              to: 'GYOU',
              asset_type: 'native',
              amount: '3',
              created_at: 't',
              transaction_hash: 'HASH9',
            },
          ],
        },
      }),
    }))
    const out = await fetchHistory('GME', { fetchImpl })
    expect(out[0]).toMatchObject({ txHash: 'HASH9' })
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
