import { describe, it, expect, vi } from 'vitest'
import {
  mergePositions,
  applyChainPositions,
  reconcilePositionsFromChain,
} from './positionsStore.js'
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from './stellar/config.js'

vi.mock('./stellar/agentDeposit.js', () => ({ readVaultShares: vi.fn() }))
vi.mock('./stellar/vaultReads.js', () => ({ readPricePerShare: vi.fn() }))
import { readVaultShares } from './stellar/agentDeposit.js'
import { readPricePerShare } from './stellar/vaultReads.js'

describe('reconcilePositionsFromChain (autofarm pps conversion)', () => {
  it('converts the share balance to asset units via price_per_share', async () => {
    readVaultShares.mockResolvedValue(100_0000000n) // 100 shares (7-dp)
    readPricePerShare.mockResolvedValue(10_500_000n) // pps = 1.05
    const out = await reconcilePositionsFromChain('GOWNER')
    const pos = out[SOROBAN_ACTIVE_VAULT_ADDRESS]
    expect(pos.balance).toBe('1050000000') // 105 USDC in base units
    expect(pos.shares).toBe('1000000000')
  })

  it('returns null (keep cached snapshot) when the pps read fails', async () => {
    readVaultShares.mockResolvedValue(100_0000000n)
    readPricePerShare.mockResolvedValue(null)
    expect(await reconcilePositionsFromChain('GOWNER')).toBeNull()
  })

  it('skips the pps read entirely for a zero share balance', async () => {
    readVaultShares.mockResolvedValue(0n)
    readPricePerShare.mockResolvedValue(null) // would fail — must not be consulted
    const out = await reconcilePositionsFromChain('GOWNER')
    expect(out[SOROBAN_ACTIVE_VAULT_ADDRESS].balance).toBe('0')
  })
})

describe('mergePositions (raise-only)', () => {
  it('keeps the larger balance and ignores a lower incoming value (case-insensitive key)', () => {
    const merged = mergePositions(
      { '0xAbC': { vaultName: 'A', balance: '930000000' } },
      { '0xabc': { balance: '120000000' } },
    )
    expect(merged['0xAbC'].balance).toBe('930000000')
  })

  it('raises to the larger incoming balance and merges metadata', () => {
    const merged = mergePositions(
      { '0xabc': { balance: '120000000' } },
      { '0xabc': { vaultName: 'A', balance: '930000000' } },
    )
    expect(merged['0xabc']).toEqual({ vaultName: 'A', balance: '930000000' })
  })

  it('handles uint256-scale values without precision loss', () => {
    const big = (10n ** 30n).toString()
    expect(mergePositions({}, { '0x1': { balance: big } })['0x1'].balance).toBe(big)
  })
})

describe('applyChainPositions (authoritative)', () => {
  it('replaces balance even when lower (withdraw) and leaves untracked vaults untouched', () => {
    const next = applyChainPositions(
      { '0xA': { balance: '930000000' }, '0xB': { balance: '50000000' } },
      { '0xa': { balance: '730000000' } },
    )
    expect(next['0xA'].balance).toBe('730000000')
    expect(next['0xB'].balance).toBe('50000000')
  })

  it('PRUNES a vault the chain reports as 0 (fully withdrawn — heals stale cache)', () => {
    const next = applyChainPositions(
      { '0xA': { balance: '1000000' }, '0xB': { balance: '50000000' } },
      { '0xa': { balance: '0' } },
    )
    expect(next['0xA']).toBeUndefined()
    expect(next['0xB'].balance).toBe('50000000')
  })

  it('does NOT prune a vault absent from the chain map (read failed, not a withdrawal)', () => {
    const next = applyChainPositions(
      { '0xA': { balance: '1000000' } },
      {},
    )
    expect(next['0xA'].balance).toBe('1000000')
  })
})
