// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PositionsZone from './PositionsZone.jsx'

vi.mock('../WithdrawModal.jsx', () => ({
  default: ({ vault }) => <div data-testid="withdraw-modal">{vault.name}</div>,
}))

afterEach(cleanup)

const VAULT = 'CB5VKYDUABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDJDYU'
const props = {
  positions: { [VAULT]: { balance: 500_000_000, unclaimedRewards: 1_000_000, vaultName: 'Autofarm USDC' } },
  vaultMeta: { [VAULT.toLowerCase()]: { apy: 8.2, protocol: 'blend-autofarm' } },
  lastUpdated: 1_000_000_000_000,
  nowMs: 1_000_000_000_000,
  userAddress: 'GUSER',
  withdrawEnabled: true,
  onWithdrawSuccess: () => {},
  onNewStrategy: vi.fn(),
}

describe('PositionsZone', () => {
  it('renders one asset card per vault with balance and apy', () => {
    render(<PositionsZone {...props} />)
    expect(screen.getByText('Autofarm USDC')).toBeTruthy()
    expect(screen.getByText('50.00')).toBeTruthy()
    expect(screen.getByText(/8.2% apy/)).toBeTruthy()
  })
  it('withdraw opens the modal', () => {
    render(<PositionsZone {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /withdraw/i }))
    expect(screen.getByTestId('withdraw-modal')).toBeTruthy()
  })
  it('empty state offers a strategy CTA', () => {
    render(<PositionsZone {...props} positions={{}} />)
    fireEvent.click(screen.getByRole('button', { name: /deploy from strategy flow/i }))
    expect(props.onNewStrategy).toHaveBeenCalled()
  })
})
