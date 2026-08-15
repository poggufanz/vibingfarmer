// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import TxDetailPage from './TxDetailPage.jsx'

const mocks = vi.hoisted(() => ({
  getTransactions: vi.fn(() => []),
  navigateTo: vi.fn(),
}))

vi.mock('../history.js', () => ({
  getTransactions: (...args) => mocks.getTransactions(...args),
}))

vi.mock('../router.js', () => ({
  useNavigateTo: () => mocks.navigateTo,
}))

const CHECKED_AT = '2026-08-11T00:00:00.000Z'
const AMOUNT = Object.freeze({ token: 'USDC', units: '1234500', decimals: 6 })
const TX_HASH = 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890'

const factFor = (state, overrides = {}) => ({
  state,
  value: ['loading', 'empty', 'error', 'unavailable'].includes(state) ? null : AMOUNT,
  source: state === 'unavailable' ? null : 'Soroban RPC',
  checkedAt: state === 'unavailable' ? null : CHECKED_AT,
  staleAfterMs: 120000,
  ...overrides,
})

const recordFor = (state = 'current', overrides = {}) => ({
  txHash: TX_HASH,
  amount: AMOUNT,
  timestamp: 1786406400000,
  vaultName: 'Autofarm Vault',
  protocol: 'blend-usdc',
  fact: factFor(state),
  ...overrides,
})

const renderTx = (record, txHash = TX_HASH) => {
  mocks.getTransactions.mockReturnValue(record ? [record] : [])
  return render(
    <MemoryRouter initialEntries={[`/tx/${txHash}`]}>
      <Routes>
        <Route path="/tx/:txHash" element={<TxDetailPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('TxDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })

  afterEach(cleanup)

  it.each(['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable'])(
    'renders the %s fact envelope without inventing transaction metadata',
    (state) => {
      renderTx(recordFor(state))

      expect(screen.getByRole('main')).toBeTruthy()
      expect(screen.getByRole('heading', { level: 1, name: 'Transaction details' })).toBeTruthy()
      expect(document.querySelector(`[data-fact-state="${state}"]`)).toBeTruthy()
      expect(screen.queryByText(/Deposit confirmed/i)).toBeNull()
      expect(screen.queryByText(/^Stellar testnet$/i)).toBeNull()
      expect(screen.queryByText(/^Fee-bump relayer$/i)).toBeNull()
      expect(screen.getAllByText(/Unavailable/i).length).toBeGreaterThan(0)
    }
  )

  it('keeps local rows recorded locally and never upgrades stored status to Confirmed', () => {
    renderTx(
      recordFor('current', {
        status: 'confirmed',
        network: 'stellar-testnet',
        gasPayedBy: 'fee-bump-relayer',
        fact: factFor('current', { source: 'local-device' }),
      })
    )

    expect(screen.getByText('Recorded locally')).toBeTruthy()
    expect(screen.getByText('This device')).toBeTruthy()
    expect(screen.queryByText(/^Confirmed$/)).toBeNull()
    expect(screen.queryByText(/^Stellar testnet$/)).toBeNull()
    expect(screen.queryByText(/^Fee-bump relayer$/)).toBeNull()
  })

  it('converts a production scalar amountUsdc to exact canonical USDC at the detail boundary', () => {
    renderTx({
      txHash: TX_HASH,
      amountUsdc: '12.340000',
      timestamp: 1786406400000,
      vaultName: 'Autofarm Vault',
      protocol: 'blend-usdc',
      status: 'confirmed',
      network: 'stellar-testnet',
      gasPayedBy: 'fee-bump-relayer',
    })

    expect(screen.getByText('12.34 USDC')).toBeTruthy()
    expect(screen.queryByText('0.00 USDC')).toBeNull()
    expect(screen.getByText('Recorded locally')).toBeTruthy()
    expect(screen.queryByText(/^Confirmed$/)).toBeNull()
  })

  it('converts a production numeric amountUsdc without floating money arithmetic', () => {
    renderTx({
      txHash: TX_HASH,
      amountUsdc: 12.34,
      timestamp: 1786406400000,
      vaultName: 'Autofarm Vault',
      protocol: 'blend-usdc',
    })

    expect(screen.getByText('12.34 USDC')).toBeTruthy()
    expect(screen.getByText('Recorded locally')).toBeTruthy()
  })

  it.each([-0, '-1', '12.3400001', 'not-a-number'])(
    'keeps invalid scalar amountUsdc %s unavailable',
    (amountUsdc) => {
      renderTx({
        txHash: TX_HASH,
        amountUsdc,
        timestamp: 1786406400000,
        vaultName: 'Autofarm Vault',
        protocol: 'blend-usdc',
      })

      expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
      expect(screen.queryByText(/USDC/)).toBeNull()
      expect(screen.queryByText('0.00 USDC')).toBeNull()
    }
  )

  it('projects an explicit verified Stellar fee-bump record and links its matching hash', () => {
    renderTx(
      recordFor('confirmed', {
        type: 'deposit',
        status: 'confirmed',
        network: 'stellar-testnet',
        gasPayedBy: 'fee-bump-relayer',
        verified: true,
      })
    )

    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0)
    expect(screen.getByText('Deposit')).toBeTruthy()
    expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThan(0)
    expect(screen.getByText('Fee-bump relayer')).toBeTruthy()

    const explorer = screen.getByRole('link', { name: 'View on Stellar Expert' })
    expect(explorer.getAttribute('href')).toBe(
      `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`
    )
    expect(explorer.getAttribute('target')).toBe('_blank')
  })

  it('removes the explorer link and reports unavailable for a verified hash on another network', () => {
    renderTx(
      recordFor('confirmed', {
        type: 'deposit',
        status: 'confirmed',
        network: 'base-sepolia',
        verified: true,
      })
    )

    expect(screen.queryByRole('link', { name: 'View on Stellar Expert' })).toBeNull()
    expect(screen.getByText('Explorer: Unavailable')).toBeTruthy()
  })

  it('keeps a missing local record neutral while retaining the route hash', () => {
    renderTx(null, 'missing-hash')

    expect(screen.getByRole('heading', { level: 1, name: 'Transaction details' })).toBeTruthy()
    expect(screen.getByText('Transaction not found.')).toBeTruthy()
    expect(screen.getByText('missing-hash')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'View on Stellar Expert' })).toBeNull()
    expect(screen.queryByText('This device')).toBeNull()
    expect(screen.queryByText(/Deposit confirmed|Stellar testnet|Fee-bump relayer/i)).toBeNull()
  })

  it('keeps hash copy, Back fallback, and Farm strategy handoff keyboard reachable', () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    renderTx(recordFor('current'))

    const heading = screen.getByRole('heading', { level: 1, name: 'Transaction details' })
    expect(heading.hasAttribute('data-route-heading')).toBe(true)
    expect(heading.tabIndex).toBe(-1)
    heading.focus()
    expect(document.activeElement).toBe(heading)

    const copy = screen.getByRole('button', { name: 'Copy' })
    copy.focus()
    expect(document.activeElement).toBe(copy)
    fireEvent.click(copy)
    expect(writeText).toHaveBeenCalledWith(TX_HASH)

    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault again' }))
    expect(mocks.navigateTo).toHaveBeenCalledWith('strategy')
    expect(sessionStorage.getItem('yv_prefill_protocol')).toBe('blend-usdc')

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(mocks.navigateTo).toHaveBeenCalledWith('history')
  })

  it('hides legacy APY and clears stale prefill values', () => {
    sessionStorage.setItem('yv_prefill_apy', '4.8')
    renderTx(recordFor('current', { apy: 4.8 }))

    expect(screen.queryByText('4.8%')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault again' }))
    expect(sessionStorage.getItem('yv_prefill_apy')).toBeNull()
  })

  it('shows and prefills APY only for a live-venue-evidenced transaction', () => {
    renderTx(recordFor('current', { apy: 6.2, yieldEvidence: 'live-venue' }))

    expect(screen.getByText('6.2%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault again' }))
    expect(sessionStorage.getItem('yv_prefill_apy')).toBe('6.2')
  })

  it('renders exact relay, direct, and unknown fee-channel copy', () => {
    const { unmount } = renderTx(recordFor('current', { channel: 'relay' }))
    expect(screen.getByText('Sponsored by fee-bump relay')).toBeTruthy()
    unmount()

    renderTx(recordFor('current', { channel: 'direct' }))
    expect(screen.getByText('Paid by wallet')).toBeTruthy()
    expect(screen.queryByText('Sponsored by fee-bump relay')).toBeNull()
  })
})
