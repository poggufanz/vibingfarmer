import { describe, it, expect } from 'vitest'
import { mergePositions, applyChainPositions } from './positionsStore.js'

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
