// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const fakes = vi.hoisted(() => ({
  getTransactions: vi.fn(),
  navigateTo: vi.fn(),
  useParams: vi.fn(),
}))

vi.mock('../history.js', () => ({
  getTransactions: () => fakes.getTransactions(),
}))
vi.mock('../router.js', () => ({
  useNavigateTo: () => fakes.navigateTo,
}))
vi.mock('react-router-dom', () => ({
  useParams: () => fakes.useParams(),
}))

import TxDetailPage from './TxDetailPage.jsx'

afterEach(cleanup)

describe('TxDetailPage yield evidence', () => {
  beforeEach(() => {
    fakes.getTransactions.mockReset()
    fakes.navigateTo.mockReset()
    fakes.useParams.mockReturnValue({ txHash: 'legacy' })
    sessionStorage.clear()
  })

  it('hides legacy APY and removes stale prefill when farming again', () => {
    fakes.getTransactions.mockReturnValue([
      {
        txHash: 'legacy',
        type: 'deposit',
        vaultName: 'Legacy vault',
        protocol: 'blend-usdc',
        amountUsdc: '10',
        apy: 4.8,
        timestamp: Date.now(),
      },
    ])
    sessionStorage.setItem('yv_prefill_apy', '4.8')

    render(<TxDetailPage />)

    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0)
    expect(screen.queryByText('4.8%')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault again' }))
    expect(sessionStorage.getItem('yv_prefill_apy')).toBeNull()
  })

  it('shows and prefills APY only for an explicitly live-evidenced transaction', () => {
    fakes.useParams.mockReturnValue({ txHash: 'live' })
    fakes.getTransactions.mockReturnValue([
      {
        txHash: 'live',
        type: 'deposit',
        vaultName: 'Live vault',
        protocol: 'blend-usdc',
        amountUsdc: '10',
        apy: 6.2,
        yieldEvidence: 'live-venue',
        timestamp: Date.now(),
      },
    ])

    render(<TxDetailPage />)

    expect(screen.getByText('6.2%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault again' }))
    expect(sessionStorage.getItem('yv_prefill_apy')).toBe('6.2')
  })
})
