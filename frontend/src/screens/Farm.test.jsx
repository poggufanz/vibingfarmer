// @vitest-environment jsdom
// frontend/src/screens/Farm.test.jsx
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Farm from './Farm.jsx'

afterEach(cleanup) // @testing-library/react v16 does not auto-clean; unmount between tests

vi.mock('../crossChainFarm.js', () => ({ runFarmFlow: vi.fn() }))
vi.mock('../venice.js', () => ({ allocateBasePools: vi.fn() }))

import { runFarmFlow } from '../crossChainFarm.js'
import { allocateBasePools } from '../venice.js'

describe('Farm screen', () => {
  test('shows the AI allocation preview, then runs the farm flow on "Start Farming" and shows progress', async () => {
    allocateBasePools.mockResolvedValue([
      { pool: '0xAAAA', protocol: 'aave-v3', amount: 60, minShares: 59n, expectedApy: 5.1, riskTier: 'low', skill: {} },
      { pool: '0xBBBB', protocol: 'morpho-blue', amount: 40, minShares: 39n, expectedApy: 6.8, riskTier: 'medium', skill: {} },
    ])
    runFarmFlow.mockResolvedValue({ burnHash: 'burn-1', jobId: 'job-1', finalStatus: 'done' })

    render(
      <Farm
        amount={100}
        riskLevel="medium"
        nPools={2}
        stellarWallet={{ address: 'GWALLET', signBurn: vi.fn() }}
        baseRecipientAddress="0xBASEACCT"
        sessionKeyAddress="0xSESSION"
        serializedApproval="approval-blob"
      />
    )

    await waitFor(() => expect(screen.getByText(/aave-v3/i)).toBeTruthy())
    expect(screen.getByText(/morpho-blue/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /start farming/i }))

    await waitFor(() => expect(runFarmFlow).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText(/done/i)).toBeTruthy())
  })

  test('a staged failure event renders the stage-specific error, not a generic message', async () => {
    allocateBasePools.mockResolvedValue([
      { pool: '0xAAAA', protocol: 'aave-v3', amount: 100, minShares: 99n, expectedApy: 5.1, riskTier: 'low', skill: {} },
    ])
    runFarmFlow.mockImplementation(async ({ onEvent }) => {
      onEvent('farm-burn-started', {})
      onEvent('farm-failed', { stage: 'burn', error: 'friendbot funding failed (503)' })
      throw new Error('friendbot funding failed (503)')
    })

    render(
      <Farm
        amount={100}
        riskLevel="low"
        nPools={1}
        stellarWallet={{ address: 'GWALLET', signBurn: vi.fn() }}
        baseRecipientAddress="0xBASEACCT"
        sessionKeyAddress="0xSESSION"
        serializedApproval="approval-blob"
      />
    )
    await waitFor(() => screen.getByRole('button', { name: /start farming/i }))
    fireEvent.click(screen.getByRole('button', { name: /start farming/i }))

    await waitFor(() => expect(screen.getByText(/friendbot funding failed/i)).toBeTruthy())
  })
})
