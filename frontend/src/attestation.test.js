import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./stellar/attestation.js', () => ({
  attestOnChain: vi.fn(),
}))

import { attestStrategyOnChain, formatAttestation, hashStrategy } from './attestation.js'
import { attestOnChain } from './stellar/attestation.js'

const strategy = {
  selected_vaults: [
    { address: 'C1', protocol: 'Blend', allocation: 100, expected_apy: 5, reasoning: 'x' },
  ],
  generatedBy: 'venice',
}

describe('attestStrategyOnChain', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls attestOnChain exactly once for one explicit action (one additional wallet confirmation)', async () => {
    attestOnChain.mockResolvedValue({ hash: 'TX123', status: 'SUCCESS' })
    const r = await attestStrategyOnChain(strategy, { attester: 'GUSER' })
    expect(attestOnChain).toHaveBeenCalledTimes(1)
    expect(attestOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ attester: 'GUSER', label: 'venice' })
    )
    expect(r.txHash).toBe('TX123')
    expect(r.strategyHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('falls back to off-chain hash when no attester (txHash null)', async () => {
    const r = await attestStrategyOnChain(strategy, {})
    expect(attestOnChain).not.toHaveBeenCalled()
    expect(r.txHash).toBeNull()
    expect(r.strategyHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('falls back when the relay returns null (non-blocking)', async () => {
    attestOnChain.mockResolvedValue(null)
    const r = await attestStrategyOnChain(strategy, { attester: 'GUSER' })
    expect(r.txHash).toBeNull()
    expect(r.strategyHash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('formatAttestation', () => {
  it('adds a stellar.expert explorer link + on-chain label when txHash present', () => {
    const f = formatAttestation({ strategyHash: '0x' + 'a'.repeat(64), txHash: 'TX123' })
    expect(f.explorerUrl).toBe('https://stellar.expert/explorer/testnet/tx/TX123')
    expect(f.label).toBe('Strategy attested on-chain')
  })
  it('keeps off-chain label when no txHash', () => {
    const f = formatAttestation({ strategyHash: '0x' + 'a'.repeat(64), txHash: null })
    expect(f.explorerUrl).toBeNull()
    expect(f.label).toBe('Strategy hash (off-chain verifiable)')
  })
})

describe('hashStrategy (off-chain, deterministic)', () => {
  it('produces a 0x-prefixed 32-byte hex digest', () => {
    expect(hashStrategy(strategy)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('hashes the same semantic plan identically across calls and object key order', () => {
    const reordered = Object.fromEntries(Object.entries(strategy).reverse())
    expect(hashStrategy(strategy)).toBe(hashStrategy(strategy))
    expect(hashStrategy(strategy)).toBe(hashStrategy(reordered))
  })

  it('never lets a wall-clock timestamp into the hash payload', () => {
    const realNow = Date.now
    Date.now = () => 1000
    const h1 = hashStrategy(strategy)
    Date.now = () => 9_999_999_999
    const h2 = hashStrategy(strategy)
    Date.now = realNow
    expect(h1).toBe(h2)
  })

  it('changes when allocation, destination, scope, or proxy truth changes', () => {
    const base = hashStrategy(strategy)
    const differentAllocation = hashStrategy({
      ...strategy,
      selected_vaults: [{ ...strategy.selected_vaults[0], allocation: 50 }],
    })
    const differentDestination = hashStrategy({
      ...strategy,
      selected_vaults: [{ ...strategy.selected_vaults[0], address: 'C2' }],
    })
    const differentScope = hashStrategy({
      ...strategy,
      selected_vaults: [{ ...strategy.selected_vaults[0], expiry: 1700000000 }],
    })
    const differentProxy = hashStrategy({
      ...strategy,
      selected_vaults: [{ ...strategy.selected_vaults[0], proxyTarget: 'compound-v3' }],
    })
    expect(differentAllocation).not.toBe(base)
    expect(differentDestination).not.toBe(base)
    expect(differentScope).not.toBe(base)
    expect(differentProxy).not.toBe(base)
  })

  it('is synchronous, off-chain -- automatic plan generation never touches attestOnChain', () => {
    attestOnChain.mockClear()
    const result = hashStrategy(strategy)
    expect(result).not.toBeInstanceOf(Promise)
    expect(attestOnChain).not.toHaveBeenCalled()
  })
})
