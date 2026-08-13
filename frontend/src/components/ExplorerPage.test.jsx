// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { normalizeAmount } from '../design/pocket-crew-foundation.js'
import manifest from '../../../deployments/stellar-testnet.json'
import ExplorerPage from './ExplorerPage.jsx'
import * as vaultReads from '../stellar/vaultReads.js'

vi.mock('../stellar/vaultReads.js', () => ({
  readTotalAssets: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../history.js', () => ({
  getStrategies: vi.fn(() => []),
}))

vi.mock('../stellar/client.js', () => ({
  rpcServer: vi.fn(() =>
    Promise.resolve({
      getLatestLedger: vi.fn(() => Promise.resolve({ sequence: 1000 })),
    })
  ),
}))

vi.mock('../stellar/events.js', () => ({
  pollEvents: vi.fn(() => Promise.resolve({ events: [] })),
}))

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(vaultReads.readTotalAssets).mockResolvedValue(null)
})

const CHECKED_AT = '2026-08-11T00:00:00.000Z'
const AMOUNT = Object.freeze({ token: 'USDC', units: '1234500', decimals: 6 })

const factFor = (state, overrides = {}) => ({
  state,
  value: ['error', 'unavailable', 'empty'].includes(state) ? null : AMOUNT,
  source: state === 'unavailable' ? null : 'Soroban RPC',
  checkedAt: state === 'unavailable' ? null : CHECKED_AT,
  staleAfterMs: 120000,
  confirmedLedger: state === 'unavailable' ? null : '1000',
  confirmedBlock: state === 'unavailable' ? null : '2000',
  ...overrides,
})

const readResult = (state, overrides = {}) => ({
  fact: factFor(state),
  facts: {
    totalAssets: factFor(state),
    catalog: factFor(['error', 'unavailable'].includes(state) ? state : 'current', {
      value: null,
      source: 'deployment manifest',
    }),
    attestations: factFor(state),
  },
  totalAssets: AMOUNT,
  strategies: [],
  ...overrides,
})

const renderExplorer = (explorerRead) =>
  render(
    <MemoryRouter
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
      initialEntries={['/explorer']}
    >
      <ExplorerPage explorerRead={explorerRead} />
    </MemoryRouter>
  )

describe('ExplorerPage', () => {
  it.each(['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable'])(
    'renders truthful RPC evidence for the %s state',
    (state) => {
      renderExplorer(readResult(state))

      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(screen.getByRole('heading', { level: 1, name: 'Explorer' })).toBeTruthy()
      expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Technical details').length).toBeGreaterThan(0)
      expect(document.querySelector(`[data-fact-state="${state}"]`)).toBeTruthy()
      expect(screen.queryByText(/updated live/i)).toBeNull()
      expect(screen.queryByText(/Exit all/i)).toBeNull()
      expect(document.querySelector('.ex-net__dot')).toBeNull()

      const copyButton = screen.getAllByRole('button', { name: /Copy address/i })[0]
      copyButton.focus()
      expect(document.activeElement).toBe(copyButton)
      expect(screen.getByRole('main')).toBeTruthy()
      expect(
        screen.getAllByRole('link', { name: /View on Stellar Expert/i }).length
      ).toBeGreaterThan(0)
    }
  )

  it('keeps successful siblings visible when attestations are the failed source', () => {
    renderExplorer(
      readResult('partial', {
        facts: {
          totalAssets: factFor('current'),
          catalog: factFor('current', { value: null, source: 'deployment manifest' }),
          attestations: factFor('error', { value: null }),
        },
        strategies: [],
      })
    )

    expect(screen.getByText('1.2345 USDC')).toBeTruthy()
    expect(screen.getByText('Attestation read')).toBeTruthy()
    expect(screen.getByText(/failed; movement is not confirmed/i)).toBeTruthy()
    expect(
      document.querySelector('[data-fact-key="attestations"][data-fact-state="error"]')
    ).toBeTruthy()
    expect(screen.queryByText('0 USDC')).toBeNull()
  })

  it('keeps the RPC value visible when only attestation discovery fails', () => {
    renderExplorer(
      readResult('current', {
        facts: {
          totalAssets: factFor('current'),
          catalog: factFor('current', { value: null, source: 'deployment manifest' }),
          attestations: factFor('error', { value: null }),
        },
      })
    )

    expect(screen.getByText('1.2345 USDC')).toBeTruthy()
    expect(screen.getByText('Attestation read')).toBeTruthy()
    expect(screen.getByText(/failed; movement is not confirmed/i)).toBeTruthy()
    expect(screen.getByText('Not available')).toBeTruthy()
  })

  it('keeps failed and unavailable values null instead of fabricating zero', () => {
    for (const state of ['error', 'unavailable']) {
      const { unmount } = renderExplorer(readResult(state))

      expect(screen.queryByText('1.2345 USDC')).toBeNull()
      expect(screen.getAllByText(/Not available|Unavailable/i).length).toBeGreaterThan(0)
      unmount()
    }
  })

  it('preserves the canonical amount at the presentation boundary', () => {
    renderExplorer(readResult('current'))

    expect(normalizeAmount(AMOUNT)).toEqual({
      token: 'USDC',
      units: '1234500',
      decimals: 6,
    })
  })

  it('renders a direct source-owned total when no nested total fact is supplied', () => {
    renderExplorer({
      fact: factFor('current'),
      totalAssets: AMOUNT,
      strategies: [],
    })

    expect(screen.getByText('1.2345 USDC')).toBeTruthy()
  })

  it('preserves a settled numeric RPC TVL without claiming current freshness', async () => {
    vi.mocked(vaultReads.readTotalAssets).mockResolvedValueOnce(123000000n)

    renderExplorer()

    expect(await screen.findByText('12 USDC')).toBeTruthy()
    expect(
      document.querySelector('[data-fact-key="explorer"][data-fact-state="unavailable"]')
    ).toBeTruthy()
  })

  it('keeps a null no-injection RPC result unavailable', async () => {
    renderExplorer()

    await waitFor(() => expect(vaultReads.readTotalAssets).toHaveBeenCalled())
    expect(screen.queryByText(/\d+ USDC/)).toBeNull()
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0)
  })
})

describe('ExplorerPage deployment facts', () => {
  it('renders the complete categorized Stellar deployment surface', () => {
    render(
      <MemoryRouter initialEntries={['/explorer']}>
        <ExplorerPage />
      </MemoryRouter>
    )

    expect(
      screen.getByText(
        '8 static Stellar testnet addresses: 6 Vibing Farmer deployments and 2 external protocol contracts. Agent accounts are created dynamically per run.'
      )
    ).toBeTruthy()
    expect(screen.getByText('Soroban source crates')).toBeTruthy()
    expect(screen.getByText('VF deployments')).toBeTruthy()
    expect(screen.getByText('Protocol contracts')).toBeTruthy()
    expect(screen.getByText('Dynamic agents')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText('6')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText('8 static addresses')).toBeTruthy()
    expect(screen.getByText('N per run')).toBeTruthy()

    const addresses = [
      manifest.fundingRouter.addressV2,
      manifest.autofarmVault.address,
      manifest.strategy1.address,
      manifest.exitRouter.address,
      manifest.attestation,
      manifest.registry,
      manifest.strategy1.pool,
      manifest.fundingRouter.token,
    ]
    for (const address of addresses) expect(screen.getByText(address)).toBeTruthy()

    expect(screen.queryByText(manifest.agentAccountWasmHash)).toBeNull()
    expect(screen.queryByText('Contract Tests')).toBeNull()
    expect(screen.queryByText('Every deployed contract')).toBeNull()
  })
})
