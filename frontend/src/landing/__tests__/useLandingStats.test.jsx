// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reads = { apr: vi.fn(), tvl: vi.fn() }
vi.mock('../../stellar/vaultReads.js', () => ({
  readSupplyAprBps: (...args) => reads.apr(...args),
  readTotalAssets: (...args) => reads.tvl(...args),
}))
vi.mock('../../stellar/config.js', () => ({ SOROBAN_BLEND_POOL_ADDRESS: 'CPOOL' }))

import { formatApr, formatTvl, useLandingStats } from '../useLandingStats.js'

beforeEach(() => {
  reads.apr.mockReset()
  reads.tvl.mockReset()
})

describe('landing stats', () => {
  it('formats APR bps with two decimals and TVL as whole testnet USDC', () => {
    expect(formatApr(612)).toBe('6.12%')
    expect(formatTvl(1_234_567_890_000n)).toBe('123,457 USDC')
    expect(formatTvl(10n ** 15n)).toBe('100,000,000 USDC')
  })

  it('never renders a fake number', () => {
    expect(formatApr(null)).toBe('--')
    expect(formatTvl(null)).toBe('--')
  })

  it('goes live when the on-chain reads succeed', async () => {
    reads.apr.mockResolvedValue(612)
    reads.tvl.mockResolvedValue(50_000_000n)
    const { result } = renderHook(() => useLandingStats())
    await waitFor(() => expect(result.current.status).toBe('live'))
    expect(reads.apr).toHaveBeenCalledWith('CPOOL')
    expect(result.current.aprBps).toBe(612)
  })

  it('is unavailable when every read fails or throws', async () => {
    reads.apr.mockResolvedValue(null)
    reads.tvl.mockRejectedValue(new Error('rpc down'))
    const { result } = renderHook(() => useLandingStats())
    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.totalAssets).toBeNull()
  })
})
