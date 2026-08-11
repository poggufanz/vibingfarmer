// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllHistory,
  getReasoningLog,
  getStrategies,
  getTransactions,
  positionsFromHistory,
  saveReasoning,
  saveStrategy,
  saveTransaction,
} from './history.js'

afterEach(() => clearAllHistory())

const catalog = [
  { name: 'Autofarm legacy', protocol: 'blend-usdc', address: 'CLegacy', apy: 4.8 },
  { name: 'Autofarm live', protocol: 'blend-usdc', address: 'CLive', apy: 4.8 },
]

describe('history yield evidence', () => {
  beforeEach(() => clearAllHistory())

  it('persists transaction APY only when the caller supplies live-venue evidence', () => {
    saveTransaction({
      txHash: 'legacy',
      vaultName: 'Legacy row',
      vaultAddress: 'CLegacy',
      protocol: 'blend-usdc',
      amountUsdc: '10',
      apy: 4.8,
    })
    saveTransaction({
      txHash: 'live',
      vaultName: 'Live row',
      vaultAddress: 'CLive',
      protocol: 'blend-usdc',
      amountUsdc: '10',
      apy: 6.2,
      yieldEvidence: 'live-venue',
    })

    const rows = getTransactions()
    expect(rows[0]).toMatchObject({ apy: 6.2, yieldEvidence: 'live-venue' })
    expect(rows[1]).toMatchObject({ apy: null, yieldEvidence: null })

    const positions = positionsFromHistory(catalog)
    expect(positions.clegacy.apy).toBeNull()
  })

  it('normalizes strategy and reasoning APY unless live-venue evidence is explicit', () => {
    saveStrategy({
      amountUsdc: 10,
      riskLevel: 'low',
      numVaults: 1,
      vaultsSelected: [{ name: 'Legacy row', protocol: 'blend-usdc', apy: 4.8, allocation: 1 }],
      blendedApy: 4.8,
    })
    saveStrategy({
      amountUsdc: 10,
      riskLevel: 'low',
      numVaults: 1,
      vaultsSelected: [{ name: 'Live row', protocol: 'blend-usdc', apy: 6.2, allocation: 1 }],
      blendedApy: 6.2,
      yieldEvidence: 'live-venue',
    })
    saveReasoning({
      vaultName: 'Legacy row',
      protocol: 'blend-usdc',
      reasoning: 'Legacy reasoning',
      expectedApy: 4.8,
    })
    saveReasoning({
      vaultName: 'Live row',
      protocol: 'blend-usdc',
      reasoning: 'Live reasoning',
      expectedApy: 6.2,
      yieldEvidence: 'live-venue',
    })

    expect(getStrategies()[0]).toMatchObject({ blendedApy: 6.2, yieldEvidence: 'live-venue' })
    expect(getStrategies()[0].vaultsSelected[0].apy).toBe(6.2)
    expect(getStrategies()[1]).toMatchObject({ blendedApy: null, yieldEvidence: null })
    expect(getStrategies()[1].vaultsSelected[0].apy).toBeNull()
    expect(getReasoningLog()[0]).toMatchObject({ expectedApy: 6.2, yieldEvidence: 'live-venue' })
    expect(getReasoningLog()[1]).toMatchObject({ expectedApy: null, yieldEvidence: null })
  })

  it('keeps null, undefined, and empty APY unavailable even with a live evidence label', () => {
    saveTransaction({
      txHash: 'null-apy',
      vaultName: 'Null APY',
      protocol: 'blend-usdc',
      amountUsdc: '10',
      apy: null,
      yieldEvidence: 'live-venue',
    })
    saveTransaction({
      txHash: 'undefined-apy',
      vaultName: 'Undefined APY',
      protocol: 'blend-usdc',
      amountUsdc: '10',
      yieldEvidence: 'live-venue',
    })
    saveTransaction({
      txHash: 'empty-apy',
      vaultName: 'Empty APY',
      protocol: 'blend-usdc',
      amountUsdc: '10',
      apy: '',
      yieldEvidence: 'live-venue',
    })

    expect(getTransactions().map((row) => row.apy)).toEqual([null, null, null])
  })

  it('persists the network-fee payer only when the submission channel proves it', () => {
    saveTransaction({ txHash: 'relay', channel: 'relay' })
    saveTransaction({ txHash: 'direct', channel: 'direct' })
    saveTransaction({ txHash: 'legacy-without-channel' })

    const rows = Object.fromEntries(getTransactions().map((row) => [row.txHash, row]))
    expect(rows.relay.gasPayedBy).toBe('fee-bump-relayer')
    expect(rows.direct.gasPayedBy).toBe('wallet')
    expect(rows['legacy-without-channel'].gasPayedBy).toBe('unavailable')
    expect(rows.relay.channel).toBe('relay')
    expect(rows.direct.channel).toBe('direct')
    expect(rows['legacy-without-channel'].channel).toBeNull()
  })
})
