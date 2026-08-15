// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import VaultDetailPage from './VaultDetailPage.jsx'

const navigateTo = vi.fn()
const fetchDeFiLlamaVaults = vi.fn()
const fetchApyHistory = vi.fn()

vi.mock('../router.js', () => ({
  useNavigateTo: () => navigateTo,
}))

vi.mock('../defiLlama.js', () => ({
  fetchDeFiLlamaVaults: (...args) => fetchDeFiLlamaVaults(...args),
}))

vi.mock('../apyHistory.js', () => ({
  fetchApyHistory: (...args) => fetchApyHistory(...args),
}))

const CHECKED_AT = '2026-08-11T00:00:00.000Z'
const VAULT_ADDRESS = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const AMOUNT = Object.freeze({ token: 'USDC', units: '1234500000', decimals: 7 })

const canonicalCatalog = Object.freeze({
  name: 'Vibing Farmer Autofarm',
  protocol: 'blend-usdc',
  address: VAULT_ADDRESS,
  venueKind: 'stellar-live',
  networkId: 'stellar-testnet',
  chain: 'stellar',
  risk: 'low',
  description: 'Source-backed Autofarm vault on Stellar testnet.',
})

const factFor = (state, overrides = {}) => ({
  state,
  value: ['loading', 'empty', 'error', 'unavailable', 'rejected'].includes(state) ? null : AMOUNT,
  source: state === 'unavailable' ? null : 'Soroban RPC',
  checkedAt: state === 'unavailable' ? null : CHECKED_AT,
  staleAfterMs: 21600000,
  confirmedLedger: '12345',
  ...overrides,
})

const readFor = (state, overrides = {}) => ({
  fact: factFor(state),
  facts: {
    tvl: factFor(state),
    apy: factFor(state, { value: null, source: 'DeFiLlama' }),
  },
  catalog: canonicalCatalog,
  venue: {
    venueKind: 'stellar-live',
    chain: 'stellar',
    yield: {
      state: 'live',
      apy: 6.25,
      source: 'DeFiLlama',
      asOf: CHECKED_AT,
      checkedAt: CHECKED_AT,
    },
  },
  ...overrides,
})

const renderVault = (protocol = 'blend-usdc', vaultRead, positions = {}) =>
  render(
    <MemoryRouter initialEntries={[`/vault/${protocol}`]}>
      <Routes>
        <Route
          path="/vault/:protocol"
          element={<VaultDetailPage positions={positions} vaultRead={vaultRead} />}
        />
      </Routes>
    </MemoryRouter>
  )

describe('VaultDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    fetchDeFiLlamaVaults.mockResolvedValue([])
    fetchApyHistory.mockResolvedValue(null)
  })

  afterEach(cleanup)

  it.each(['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable'])(
    'renders the %s source state without static yield or fake money',
    (state) => {
      renderVault('blend-usdc', readFor(state))

      expect(screen.getByRole('heading', { level: 1, name: 'Autofarm Vault' })).toBeTruthy()
      expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThan(0)
      expect(screen.getByText(/Yield venue:\s*Blend Capital v2/)).toBeTruthy()
      expect(screen.getByText('Technical details')).toBeTruthy()
      expect(document.querySelector(`[data-fact-state="${state}"]`)).toBeTruthy()
      expect(screen.queryByText('4.8%')).toBeNull()
      expect(screen.queryByText(/estimated/i)).toBeNull()
      expect(screen.queryByText(/^0(?:\.0+)?(?: USDC)?$/)).toBeNull()

      if (state === 'current') {
        expect(screen.getAllByText('6.25% APY').length).toBeGreaterThan(0)
        expect(screen.getAllByText('123.45 USDC').length).toBeGreaterThan(0)
      } else {
        expect(screen.queryByText('6.25% APY')).toBeNull()
      }
    }
  )

  it('keeps source-owned stale APY stale instead of presenting a live rate', () => {
    renderVault('blend-usdc', readFor('stale'))

    expect(screen.getAllByText('Stale').length).toBeGreaterThan(0)
    expect(screen.queryByText('6.25% APY')).toBeNull()
    expect(screen.getAllByText(/last known value|out of date|Refresh/i).length).toBeGreaterThan(0)
  })

  it('fails closed for rejected or missing catalog input', () => {
    renderVault('missing-vault', readFor('rejected', { catalog: null, venue: null }))

    expect(screen.getByRole('heading', { level: 1, name: 'Vault details' })).toBeTruthy()
    expect(screen.getByText('Vault not found')).toBeTruthy()
    expect(screen.getByText(/cannot verify|rejected|verified vault data/i)).toBeTruthy()
    expect(screen.queryByText('Aave')).toBeNull()
    expect(screen.queryByText('Ethereum')).toBeNull()
    expect(screen.queryByText('4.8%')).toBeNull()
  })

  it('does not relabel an Ethereum/Aave-shaped source as the Stellar venue', () => {
    renderVault(
      'blend-usdc',
      readFor('current', {
        catalog: {
          name: 'Aave v3 USDC',
          protocol: 'aave-v3',
          chain: 'Ethereum',
          networkId: 'ethereum',
        },
        venue: {
          name: 'Aave v3',
          protocol: 'aave-v3',
          chain: 'Ethereum',
          apy: 9.9,
        },
      })
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Vault details' })).toBeTruthy()
    expect(screen.getAllByText(/cannot verify|unavailable/i).length).toBeGreaterThan(0)
    expect(screen.queryByText('Aave v3')).toBeNull()
    expect(screen.queryByText('Ethereum')).toBeNull()
    expect(screen.queryByText('9.9%')).toBeNull()
    expect(screen.queryByText('6.25% APY')).toBeNull()
  })

  it('keeps a canonical position amount exact and preserves the Farm handoff', () => {
    renderVault('blend-usdc', readFor('current'), {
      [VAULT_ADDRESS]: { balance: '987654321', vaultName: 'Autofarm Vault' },
    })

    expect(screen.getAllByText('98.7654321 USDC').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault' }))

    expect(sessionStorage.getItem('yv_prefill_protocol')).toBe('blend-usdc')
    expect(sessionStorage.getItem('yv_prefill_name')).toBe('Vibing Farmer Autofarm')
    expect(sessionStorage.getItem('yv_prefill_apy')).toBe('6.25')
    expect(navigateTo).toHaveBeenCalledWith('strategy')
  })

  it('keeps Farm navigation available without an unverified APY prefill', () => {
    renderVault(
      'blend-usdc',
      readFor('current', {
        venue: {
          venueKind: 'stellar-live',
          chain: 'stellar',
          yield: { state: 'unavailable', apy: null },
        },
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault' }))

    expect(sessionStorage.getItem('yv_prefill_apy')).toBeNull()
    expect(navigateTo).toHaveBeenCalledWith('strategy')
  })

  it('keeps the reader effects on the non-injected path without treating catalog APY as live', () => {
    renderVault('blend-usdc')

    expect(fetchDeFiLlamaVaults).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Autofarm Vault' })).toBeTruthy()
    expect(screen.queryByText('4.8%')).toBeNull()
    expect(screen.queryByText(/estimated/i)).toBeNull()
  })

  it('does not use a flat fetched APY for metrics, position copy, or prefill', async () => {
    fetchDeFiLlamaVaults.mockResolvedValueOnce([
      { protocol: 'blend-usdc', apy: 4.8, tvlFormatted: '$1' },
    ])
    renderVault('blend-usdc', undefined, { [VAULT_ADDRESS]: { balance: '1000000000' } })

    await waitFor(() => expect(fetchDeFiLlamaVaults).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('4.8%')).toBeNull()
    expect(screen.queryByText(/USDC, .*APY/)).toBeNull()
    expect(screen.queryByText(/USDC\/day estimated/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault' }))
    expect(sessionStorage.getItem('yv_prefill_apy')).toBeNull()
  })

  it('renders APY and daily position estimate only for nested live yield', async () => {
    fetchDeFiLlamaVaults.mockResolvedValueOnce([
      {
        protocol: 'blend-usdc',
        apy: 4.8,
        yield: { state: 'live', apy: 6.2, asOf: Date.now() },
      },
    ])
    renderVault('blend-usdc', undefined, { [VAULT_ADDRESS]: { balance: '1000000000' } })

    await waitFor(() => expect(screen.getByText('6.2% APY')).toBeTruthy())
    expect(screen.getByText(/USDC\/day estimated/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Farm this vault' }))
    expect(sessionStorage.getItem('yv_prefill_apy')).toBe('6.2')
  })
})
