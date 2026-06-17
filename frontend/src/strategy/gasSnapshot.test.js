// frontend/src/strategy/gasSnapshot.test.js
import { describe, it, expect, vi } from 'vitest'

// Mock the read provider so no real RPC call is made.
const getFeeData = vi.fn()
vi.mock('../readProvider.js', () => ({
  getReadProvider: () => ({ getFeeData }),
}))

import { fetchGasSnapshot } from './gasSnapshot.js'

describe('fetchGasSnapshot', () => {
  it('maps wei gasPrice to gwei and "normal" level', async () => {
    getFeeData.mockResolvedValueOnce({ gasPrice: 12_000_000_000n, maxFeePerGas: null })
    const snap = await fetchGasSnapshot()
    expect(snap.gwei).toBe(12)
    expect(snap.level).toBe('normal')
  })

  it('flags "elevated" at >=30 gwei', async () => {
    getFeeData.mockResolvedValueOnce({ gasPrice: 45_000_000_000n })
    expect((await fetchGasSnapshot()).level).toBe('elevated')
  })

  it('flags "high" at >=80 gwei', async () => {
    getFeeData.mockResolvedValueOnce({ gasPrice: 120_000_000_000n })
    expect((await fetchGasSnapshot()).level).toBe('high')
  })

  it('falls back to maxFeePerGas when gasPrice is null', async () => {
    getFeeData.mockResolvedValueOnce({ gasPrice: null, maxFeePerGas: 5_000_000_000n })
    expect((await fetchGasSnapshot()).gwei).toBe(5)
  })
})
