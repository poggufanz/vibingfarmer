// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AlertCard } from './AlertCard.jsx'

afterEach(cleanup)

const noop = () => {}
const baseHandlers = {
  onHarvest: noop,
  onEmergencyWithdraw: noop,
  onReview: noop,
  onDismiss: vi.fn(),
}

describe('AlertCard', () => {
  it('renders the existing harvest_ready type with its icon + copy', () => {
    render(
      <AlertCard
        alert={{ id: '1', kind: 'harvest_ready', vaultName: 'Blend USDC', rewardsUsdc: '3.20' }}
        {...baseHandlers}
      />
    )
    expect(screen.getByText('Harvest ready')).toBeTruthy()
    expect(screen.getByText(/Blend USDC.*3\.20 USDC unclaimed/)).toBeTruthy()
  })

  it('renders compound_executed with the Compounded title and gain/price-per-share copy', () => {
    render(
      <AlertCard
        alert={{
          id: '2',
          kind: 'compound_executed',
          vaultName: 'Autofarm vault',
          totalGainUsdc: '4.50',
          pricePerShare: '1.0234',
        }}
        {...baseHandlers}
      />
    )
    expect(screen.getByText('Compounded')).toBeTruthy()
    expect(screen.getByText(/Autofarm vault.*4\.50 USDC gained/)).toBeTruthy()
  })

  it('renders rebalance_executed with the Rebalanced title and from/to/amount copy', () => {
    render(
      <AlertCard
        alert={{
          id: '3',
          kind: 'rebalance_executed',
          vaultName: 'Autofarm vault',
          fromLabel: 'CABCDE…WXYZ',
          toLabel: 'CFGHIJ…UVWX',
          amountUsdc: '50.00',
        }}
        {...baseHandlers}
      />
    )
    expect(screen.getByText('Rebalanced')).toBeTruthy()
    expect(screen.getByText(/CABCDE…WXYZ.*CFGHIJ…UVWX.*50\.00 USDC/)).toBeTruthy()
  })

  it('renders blnd_held with the BLND held title and held-amount copy', () => {
    render(
      <AlertCard
        alert={{
          id: '4',
          kind: 'blnd_held',
          vaultName: 'Autofarm vault',
          blndHeld: '12.0000000',
        }}
        {...baseHandlers}
      />
    )
    expect(screen.getByText('BLND held')).toBeTruthy()
    expect(screen.getByText(/Autofarm vault.*12\.0000000 BLND held, not swapped/)).toBeTruthy()
  })

  it('dismisses a compound_executed alert like any other alert kind', () => {
    render(
      <AlertCard
        alert={{
          id: '5',
          kind: 'compound_executed',
          vaultName: 'Autofarm vault',
          totalGainUsdc: '1.00',
          pricePerShare: '1.0000',
        }}
        {...baseHandlers}
      />
    )
    screen.getByLabelText('dismiss').click()
    expect(baseHandlers.onDismiss).toHaveBeenCalledWith('5')
  })
})
