// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { normalizeAmount } from '../design/pocket-crew-foundation.js'
import { fetchDeFiLlamaVaults } from '../defiLlama.js'
import OnboardingFlow from './OnboardingFlow.jsx'

vi.mock('../defiLlama.js', () => ({
  fetchDeFiLlamaVaults: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../apyHistory.js', () => ({
  fetchApyHistoryBatch: vi.fn(() => Promise.resolve({})),
}))

const CHECKED_AT = '2026-08-11T00:00:00.000Z'
const AMOUNT = Object.freeze({ token: 'USDC', units: '1234500', decimals: 6 })

const vault = Object.freeze({
  name: 'Vibing Farmer Autofarm',
  protocol: 'blend-usdc',
  apy: 4.8,
  poolId: null,
})

const liveVault = Object.freeze({
  ...vault,
  source: 'defiLlama',
  dataFetchedAt: CHECKED_AT,
})

const fallbackVault = Object.freeze({
  ...vault,
  source: 'fallback',
})

function readResult(state, overrides = {}) {
  return Object.freeze({
    fact: Object.freeze({
      state,
      value: ['unavailable', 'error', 'empty'].includes(state) ? null : AMOUNT,
      source: state === 'unavailable' ? null : 'DeFiLlama',
      checkedAt: state === 'unavailable' ? null : CHECKED_AT,
      staleAfterMs: 21600000,
    }),
    vaults: Object.freeze([vault]),
    histories: Object.freeze({}),
    ...overrides,
  })
}

describe('OnboardingFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it.each(['loading', 'current', 'stale', 'empty', 'partial', 'error', 'unavailable'])(
    'shows truthful Stellar/Blend identity and %s read state',
    (state) => {
      render(
        <OnboardingFlow
          connected={false}
          onConnect={() => {}}
          onComplete={() => {}}
          onboardingRead={readResult(state)}
        />
      )

      expect(screen.getAllByText('Stellar testnet').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Autofarm Vault').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Blend Capital v2').length).toBeGreaterThan(0)
      expect(document.querySelector(`[data-fact-state="${state}"]`)).toBeTruthy()
      expect(
        screen.getAllByText(
          state === 'current'
            ? /Verified from/i
            : /not confirmed|unverified|wait|source confirmed|last known|some sources|refresh missing/i
        ).length
      ).toBeGreaterThan(0)
      expect(screen.getAllByText(/Source/i).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/Checked at/i).length).toBeGreaterThan(0)
      expect(screen.queryByText(/Ethereum/i)).toBeNull()
      expect(screen.queryByText(/0\.0%/)).toBeNull()
      expect(screen.queryByText(/Live vault rates/i)).toBeNull()
      expect(screen.queryByText(/4\.8/)).toBeNull()
    }
  )

  it('keeps APY unavailable when the supplied fact is unavailable', () => {
    const unavailable = readResult('unavailable', {
      venue: {
        venueKind: 'stellar-live',
        chain: 'stellar',
        yield: {
          state: 'live',
          apy: 9.9,
          source: 'untrusted fixture',
          asOf: CHECKED_AT,
          checkedAt: CHECKED_AT,
        },
      },
    })

    render(
      <OnboardingFlow
        connected={false}
        onConnect={() => {}}
        onComplete={() => {}}
        onboardingRead={unavailable}
      />
    )

    expect(screen.getAllByText(/Unavailable/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/9\.9/)).toBeNull()
    expect(screen.queryByText(/untrusted fixture/i)).toBeNull()
  })

  it('preserves connect, screen order, skip, and completion callbacks', () => {
    const onConnect = vi.fn()
    const onComplete = vi.fn()
    const props = {
      connected: false,
      onConnect,
      onComplete,
      onboardingRead: readResult('unavailable'),
    }
    const view = render(<OnboardingFlow {...props} />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your USDC can earn yield.')
    fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }))
    expect(onConnect).toHaveBeenCalledTimes(1)

    view.rerender(<OnboardingFlow {...props} connected />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('How Vibing Farmer works')
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Skip intro' }))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('keeps the injected amount canonical at the presentation boundary', () => {
    const input = readResult('current')
    render(
      <OnboardingFlow
        connected={false}
        onConnect={() => {}}
        onComplete={() => {}}
        onboardingRead={input}
      />
    )

    expect(normalizeAmount(input.fact.value)).toEqual({
      token: 'USDC',
      units: '1234500',
      decimals: 6,
    })
  })

  it('derives a source-backed Fact envelope from the production DeFiLlama settlement', async () => {
    const fetchVaults = vi.mocked(fetchDeFiLlamaVaults)
    fetchVaults.mockResolvedValueOnce([liveVault])

    render(<OnboardingFlow connected={false} onConnect={() => {}} onComplete={() => {}} />)

    await waitFor(() => {
      expect(document.querySelector('[data-fact-state="current"]')).toBeTruthy()
    })
    expect(screen.getAllByText('defiLlama').length).toBeGreaterThan(0)
    expect(screen.getAllByText(CHECKED_AT).length).toBeGreaterThan(0)
    expect(fetchVaults).toHaveBeenCalledTimes(1)
  })

  it('keeps the production fallback settlement unavailable instead of presenting it as current', async () => {
    const fetchVaults = vi.mocked(fetchDeFiLlamaVaults)
    fetchVaults.mockResolvedValueOnce([fallbackVault])

    render(<OnboardingFlow connected={false} onConnect={() => {}} onComplete={() => {}} />)

    await waitFor(() => {
      expect(document.querySelector('[data-fact-state="unavailable"]')).toBeTruthy()
    })
    expect(screen.queryByText(/Verified from/i)).toBeNull()
    expect(screen.queryByText(/Checked at:\s*\S+/i)).toBeNull()
  })

  it('renders APY only for a nested live execution-venue yield record', async () => {
    const fetchVaults = vi.mocked(fetchDeFiLlamaVaults)
    fetchVaults.mockResolvedValueOnce([
      {
        name: 'Live execution venue',
        protocol: 'blend-usdc',
        apy: 4.8,
        yield: { state: 'live', apy: 6.2, asOf: Date.now() },
        poolId: null,
      },
    ])

    render(<OnboardingFlow connected={false} onConnect={() => {}} onComplete={() => {}} />)

    expect(await screen.findByText('Live execution venue')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('6.2% APY')).toBeTruthy())
    expect(screen.queryByText('4.8% APY')).toBeNull()
  })
})
