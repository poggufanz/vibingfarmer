// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from '../stellar/config.js'

const calls = vi.hoisted(() => ({
  fetchDeFiLlamaVaults: vi.fn(),
  navigateTo: vi.fn(),
  useParams: vi.fn(() => ({ protocol: 'blend-usdc' })),
}))

vi.mock('../defiLlama.js', () => ({
  fetchDeFiLlamaVaults: (...args) => calls.fetchDeFiLlamaVaults(...args),
}))
vi.mock('../router.js', () => ({
  useNavigateTo: () => calls.navigateTo,
}))
vi.mock('react-router-dom', () => ({
  useParams: () => calls.useParams(),
}))
vi.mock('../apyHistory.js', () => ({
  fetchApyHistory: vi.fn(async () => null),
}))

import VaultDetailPage from './VaultDetailPage.jsx'

afterEach(cleanup)

const props = {
  positions: {
    [SOROBAN_ACTIVE_VAULT_ADDRESS]: { balance: '1000000000' },
  },
}

describe('VaultDetailPage yield evidence', () => {
  beforeEach(() => {
    calls.fetchDeFiLlamaVaults.mockReset()
    calls.fetchDeFiLlamaVaults.mockResolvedValue([])
    calls.navigateTo.mockReset()
    calls.useParams.mockReturnValue({ protocol: 'blend-usdc' })
    sessionStorage.clear()
  })

  it('does not use catalog or flat fetched APY for metrics, position copy, or prefill', async () => {
    calls.fetchDeFiLlamaVaults.mockResolvedValueOnce([
      { protocol: 'blend-usdc', apy: 4.8, tvlFormatted: '$1' },
    ])
    render(<VaultDetailPage {...props} />)

    expect(screen.getByText('Not available')).toBeTruthy()
    expect(screen.queryByText('4.8%')).toBeNull()
    expect(screen.queryByText(/USDC, .*APY/)).toBeNull()
    expect(screen.queryByText(/USDC\/day estimated/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault' }))
    expect(sessionStorage.getItem('yv_prefill_apy')).toBeNull()
    await waitFor(() => expect(screen.queryByText('4.8%')).toBeNull())
  })

  it('renders metrics and daily estimate only for nested live venue evidence', async () => {
    calls.fetchDeFiLlamaVaults.mockResolvedValueOnce([
      {
        protocol: 'blend-usdc',
        apy: 4.8,
        yield: { state: 'live', apy: 6.2, asOf: Date.now() },
        tvlFormatted: '$1',
      },
    ])
    render(<VaultDetailPage {...props} />)

    await waitFor(() => expect(screen.getByText('6.2%')).toBeTruthy())
    expect(screen.getByText(/USDC, 6.2% APY/)).toBeTruthy()
    expect(screen.getByText(/USDC\/day estimated/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault' }))
    expect(sessionStorage.getItem('yv_prefill_apy')).toBe('6.2')
  })
})
