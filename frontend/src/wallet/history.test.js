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
})
