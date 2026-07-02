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

  it('captures txHash when an attester is given and the relay succeeds', async () => {
    attestOnChain.mockResolvedValue({ hash: 'TX123', status: 'SUCCESS' })
    const r = await attestStrategyOnChain(strategy, { attester: 'GUSER' })
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

// hashStrategy is re-exported here only to keep the import surface stable for app.jsx.
describe('hashStrategy', () => {
  it('produces a 0x-prefixed 32-byte hex digest', () => {
    expect(hashStrategy(strategy)).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
