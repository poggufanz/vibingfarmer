// @vitest-environment jsdom
// KeeperPanel — vf-autofarm Task 15. Presentational: all data arrives via props (last keeper
// action from Task-14's fetchKeeperEvents feed, live price-per-share, APR per strategy). Mirrors
// the render/assert shape of AlertCard.test.jsx / HistoryPanel's empty-state convention.
import { afterEach, describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import KeeperPanel from './KeeperPanel.jsx'

afterEach(cleanup)

describe('KeeperPanel', () => {
  it('shows the empty state when the keeper has never acted', () => {
    render(<KeeperPanel events={[]} pricePerShare={null} strategies={[]} />)
    expect(screen.getByText(/keeper has not acted yet/i)).toBeTruthy()
  })

  it('renders the last compound action row', () => {
    render(
      <KeeperPanel
        events={[
          {
            id: 'compound:100',
            kind: 'compound_executed',
            totalGainUsdc: '4.50',
            pricePerShare: '1.0234',
            txHash: 'abc123',
            timestamp: Date.now(),
          },
        ]}
        pricePerShare="1.0234"
        strategies={[]}
      />
    )
    expect(screen.getByText(/Compounded/i)).toBeTruthy()
    expect(screen.getByText(/4\.50 USDC/)).toBeTruthy()
  })

  it('renders the last rebalance action row', () => {
    render(
      <KeeperPanel
        events={[
          {
            id: 'rebalance:200',
            kind: 'rebalance_executed',
            fromLabel: 'CABCDE…WXYZ',
            toLabel: 'CFGHIJ…UVWX',
            amountUsdc: '50.00',
            txHash: 'def456',
            timestamp: Date.now(),
          },
        ]}
        pricePerShare="1.0000"
        strategies={[]}
      />
    )
    expect(screen.getByText(/Rebalanced/i)).toBeTruthy()
    expect(screen.getByText(/CABCDE…WXYZ.*CFGHIJ…UVWX.*50\.00 USDC/)).toBeTruthy()
  })

  it('renders the price-per-share signature figure', () => {
    render(<KeeperPanel events={[]} pricePerShare="1.0234" strategies={[]} />)
    expect(screen.getByText('1.0234')).toBeTruthy()
    expect(screen.getByText(/price.*share/i)).toBeTruthy()
  })

  it('shows a placeholder, never a fake number, when price-per-share is unavailable', () => {
    render(<KeeperPanel events={[]} pricePerShare={null} strategies={[]} />)
    expect(screen.getByText('--')).toBeTruthy()
  })

  it('renders APR per strategy', () => {
    render(
      <KeeperPanel
        events={[]}
        pricePerShare="1.0000"
        strategies={[
          { address: 'CSTRAT1', label: 'Strategy 1', poolLabel: 'TestnetV2 pool', aprPct: 3.42 },
        ]}
      />
    )
    expect(screen.getByText('Strategy 1')).toBeTruthy()
    expect(screen.getByText('TestnetV2 pool')).toBeTruthy()
    expect(screen.getByText(/3\.42% APR/)).toBeTruthy()
  })

  it('shows an honest placeholder when a strategy APR read failed rather than 0%', () => {
    render(
      <KeeperPanel
        events={[]}
        pricePerShare="1.0000"
        strategies={[
          { address: 'CSTRAT1', label: 'Strategy 1', poolLabel: 'TestnetV2 pool', aprPct: null },
        ]}
      />
    )
    expect(screen.getByText(/--\s*APR/)).toBeTruthy()
  })
})
