// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const calls = vi.hoisted(() => ({
  fetchDeFiLlamaVaults: vi.fn(),
}))

vi.mock('../defiLlama.js', () => ({
  fetchDeFiLlamaVaults: (...args) => calls.fetchDeFiLlamaVaults(...args),
}))
vi.mock('../apyHistory.js', () => ({
  fetchApyHistoryBatch: vi.fn(async () => ({})),
}))

import OnboardingFlow from './OnboardingFlow.jsx'

afterEach(cleanup)

const baseProps = {
  connected: false,
  onConnect: vi.fn(),
  onComplete: vi.fn(),
}

describe('OnboardingFlow yield evidence', () => {
  beforeEach(() => {
    calls.fetchDeFiLlamaVaults.mockReset()
    calls.fetchDeFiLlamaVaults.mockResolvedValue([])
  })

  it('labels the static seed as unavailable instead of presenting its catalog APY', async () => {
    render(<OnboardingFlow {...baseProps} />)

    expect(screen.getByText('Vault yield')).toBeTruthy()
    expect(screen.getByText('Vibing Farmer Autofarm')).toBeTruthy()
    expect(screen.getByText('Yield unavailable')).toBeTruthy()
    expect(screen.queryByText('4.8% APY')).toBeNull()
    expect(screen.queryByText('Live vault rates')).toBeNull()
  })

  it('labels flat APY rows fetched from DeFiLlama as unavailable', async () => {
    calls.fetchDeFiLlamaVaults.mockResolvedValueOnce([
      { name: 'Reference market row', protocol: 'reference', apy: 4.8, poolId: null },
    ])
    render(<OnboardingFlow {...baseProps} />)

    expect(await screen.findByText('Reference market row')).toBeTruthy()
    expect(screen.getByText('Yield unavailable')).toBeTruthy()
    expect(screen.queryByText('4.8% APY')).toBeNull()
  })

  it('renders APY only for a fresh nested live yield record', async () => {
    calls.fetchDeFiLlamaVaults.mockResolvedValueOnce([
      {
        name: 'Live execution venue',
        protocol: 'blend-usdc',
        apy: 4.8,
        yield: { state: 'live', apy: 6.2, asOf: Date.now() },
        poolId: null,
      },
    ])
    render(<OnboardingFlow {...baseProps} />)

    expect(await screen.findByText('Live execution venue')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('6.2% APY')).toBeTruthy(), { timeout: 3000 })
    expect(screen.queryByText('Yield unavailable')).toBeNull()
  })
})
