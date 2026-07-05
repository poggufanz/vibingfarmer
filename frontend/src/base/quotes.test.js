// frontend/src/base/quotes.test.js
import { describe, test, expect, vi } from 'vitest'
import { estimateMinShares } from './quotes.js'

describe('estimateMinShares', () => {
  test('reads convertToShares live and applies the slippage tolerance', async () => {
    const publicClient = { readContract: vi.fn(async () => 99_000_000n) } // pool quotes 99 shares for the amount
    const minShares = await estimateMinShares({
      pool: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      amountBaseUnits: 100_000_000n,
      slippageBps: 50, // 0.5%
      publicClient,
    })
    expect(publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'convertToShares', args: [100_000_000n] })
    )
    // 99_000_000 * 0.995 = 98_505_000
    expect(minShares).toBe(98_505_000n)
  })

  test('defaults slippageBps to 50 (0.5%) when not provided', async () => {
    const publicClient = { readContract: vi.fn(async () => 1_000_000n) }
    const minShares = await estimateMinShares({ pool: '0xAAAA', amountBaseUnits: 1_000_000n, publicClient })
    expect(minShares).toBe(995_000n)
  })

  test('rejects a non-positive amount', async () => {
    const publicClient = { readContract: vi.fn() }
    await expect(
      estimateMinShares({ pool: '0xAAAA', amountBaseUnits: 0n, publicClient })
    ).rejects.toThrow(/positive/)
  })
})
