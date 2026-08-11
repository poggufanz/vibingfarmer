// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { clearAllHistory, saveReasoning, saveStrategy, saveTransaction } from '../history.js'

vi.mock('../base/baseHistory.js', () => ({
  fetchBaseHistory: vi.fn(async () => []),
}))
vi.mock('../wallet/baseBinding.js', () => ({
  readBaseOwner: vi.fn(() => null),
}))
vi.mock('../router.js', () => ({
  useNavigateTo: () => vi.fn(),
}))

import HistoryPanel from './HistoryPanel.jsx'

afterEach(() => {
  cleanup()
  clearAllHistory()
})

describe('HistoryPanel yield evidence', () => {
  beforeEach(() => clearAllHistory())

  it('shows APY only for evidenced transaction rows', () => {
    saveTransaction({
      txHash: 'legacy',
      vaultName: 'Legacy row',
      protocol: 'blend-usdc',
      amountUsdc: '10',
      apy: 4.8,
    })
    saveTransaction({
      txHash: 'live',
      vaultName: 'Live row',
      protocol: 'blend-usdc',
      amountUsdc: '10',
      apy: 6.2,
      yieldEvidence: 'live-venue',
    })

    render(<HistoryPanel />)

    expect(screen.getByText(/6.2% APY/)).toBeTruthy()
    expect(screen.queryByText(/4.8% APY/)).toBeNull()
  })

  it('labels non-DeFiLlama strategy rows as unavailable and hides unproven strategy APY', () => {
    saveStrategy({
      amountUsdc: 10,
      riskLevel: 'low',
      numVaults: 1,
      vaultsSelected: [{ name: 'Legacy row', protocol: 'blend-usdc', apy: 4.8, allocation: 1 }],
      blendedApy: 4.8,
      vaultDataSource: 'fallback',
    })
    render(<HistoryPanel />)

    fireEvent.click(screen.getByRole('button', { name: /Strategies/ }))
    expect(screen.getByText(/Yield unavailable/)).toBeTruthy()
    expect(screen.queryByText(/4.8% blended APY/)).toBeNull()
    expect(screen.queryByText(/Static data/)).toBeNull()
  })

  it('hides unproven reasoning APY while preserving evidenced reasoning APY', () => {
    saveReasoning({
      vaultName: 'Legacy reasoning',
      protocol: 'blend-usdc',
      reasoning: 'Legacy reasoning text',
      expectedApy: 4.8,
    })
    saveReasoning({
      vaultName: 'Live reasoning',
      protocol: 'blend-usdc',
      reasoning: 'Live reasoning text',
      expectedApy: 6.2,
      yieldEvidence: 'live-venue',
    })
    render(<HistoryPanel />)

    fireEvent.click(screen.getByRole('button', { name: /AI Reasoning/ }))
    expect(screen.getByText(/6.2% APY/)).toBeTruthy()
    expect(screen.queryByText(/4.8% APY/)).toBeNull()
  })
})
