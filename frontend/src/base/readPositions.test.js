// frontend/src/base/readPositions.test.js
import { describe, test, expect, vi } from 'vitest'
import { readPositions } from './readPositions.js'

describe('readPositions', () => {
  test('reads balanceOf then convertToAssets per pool, applying the slippage tolerance', async () => {
    const readContract = vi.fn(async ({ functionName, address }) => {
      if (functionName === 'balanceOf') return address === '0xAAAA' ? 100_000_000n : 50_000_000n
      if (functionName === 'convertToAssets')
        return address === '0xAAAA' ? 101_000_000n : 49_000_000n
      throw new Error(`unexpected functionName ${functionName}`)
    })
    const publicClient = { readContract }

    const positions = await readPositions({
      pools: ['0xAAAA', '0xBBBB'],
      account: '0xACCOUNT',
      publicClient,
    })

    expect(positions).toEqual([
      { pool: '0xAAAA', shares: 100_000_000n, minAssets: 100_495_000n }, // 101_000_000 * 0.995
      { pool: '0xBBBB', shares: 50_000_000n, minAssets: 48_755_000n }, // 49_000_000 * 0.995
    ])
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'balanceOf', address: '0xAAAA', args: ['0xACCOUNT'] })
    )
  })

  test('skips pools with a zero share balance (never calls convertToAssets for them)', async () => {
    const readContract = vi.fn(async ({ functionName, address }) => {
      if (functionName === 'balanceOf') return address === '0xAAAA' ? 0n : 10_000_000n
      if (functionName === 'convertToAssets') return 9_900_000n
      throw new Error(`unexpected functionName ${functionName}`)
    })
    const publicClient = { readContract }

    const positions = await readPositions({
      pools: ['0xAAAA', '0xBBBB'],
      account: '0xACCOUNT',
      publicClient,
    })

    expect(positions).toEqual([{ pool: '0xBBBB', shares: 10_000_000n, minAssets: 9_850_500n }])
    expect(readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'convertToAssets', address: '0xAAAA' })
    )
  })

  test('respects a custom slippageBps', async () => {
    const readContract = vi.fn(async ({ functionName }) => {
      if (functionName === 'balanceOf') return 10_000_000n
      if (functionName === 'convertToAssets') return 10_000_000n
      throw new Error(`unexpected functionName ${functionName}`)
    })
    const publicClient = { readContract }

    const positions = await readPositions({
      pools: ['0xAAAA'],
      account: '0xACCOUNT',
      publicClient,
      slippageBps: 100, // 1%
    })

    expect(positions).toEqual([{ pool: '0xAAAA', shares: 10_000_000n, minAssets: 9_900_000n }])
  })

  test('rejects an empty pools list', async () => {
    await expect(
      readPositions({ pools: [], account: '0xACCOUNT', publicClient: { readContract: vi.fn() } })
    ).rejects.toThrow(/at least one pool/)
  })
})
