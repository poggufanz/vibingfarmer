// @vitest-environment jsdom
// frontend/src/screens/Farm.test.jsx
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import Farm from './Farm.jsx'

afterEach(cleanup) // @testing-library/react v16 does not auto-clean; unmount between tests

vi.mock('../crossChainFarm.js', () => ({ runFarmFlow: vi.fn() }))
vi.mock('../strategist.js', () => ({ allocateBasePools: vi.fn() }))

import { runFarmFlow } from '../crossChainFarm.js'
import { allocateBasePools } from '../strategist.js'

describe('Farm screen', () => {
  test('shows the AI allocation preview, then runs the farm flow on "Start Farming" and shows progress', async () => {
    allocateBasePools.mockResolvedValue([
      {
        pool: '0xAAAA',
        protocol: 'aave-v3',
        amount: 60,
        minShares: 59n,
        expectedApy: 5.1,
        riskTier: 'low',
        skill: {},
      },
      {
        pool: '0xBBBB',
        protocol: 'morpho-blue',
        amount: 40,
        minShares: 39n,
        expectedApy: 6.8,
        riskTier: 'medium',
        skill: {},
      },
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

  test('with an allocations prop, never calls allocateBasePools and farms the given allocations verbatim', async () => {
    allocateBasePools.mockClear() // call history otherwise leaks from earlier tests in this file
    runFarmFlow.mockClear()
    runFarmFlow.mockResolvedValue({ burnHash: 'burn-2', jobId: 'job-2', finalStatus: 'done' })
    const givenAllocations = [
      {
        pool: '0xCCCC',
        protocol: 'seamless',
        amount: 100,
        amountBaseUnits: 100_000_000n,
        minShares: 99n,
        expectedApy: 4.2,
        riskTier: 'low',
        skill: {},
      },
    ]

    render(
      <Farm
        amount={100}
        riskLevel="low"
        nPools={1}
        stellarWallet={{ address: 'GWALLET', signBurn: vi.fn() }}
        baseRecipientAddress="0xBASEACCT"
        sessionKeyAddress="0xSESSION"
        serializedApproval="approval-blob"
        allocations={givenAllocations}
        burnUnits7={1_000_000_000n}
      />
    )

    // The mandate-time allocation renders immediately — no second (non-deterministic) LLM call.
    expect(screen.getByText(/seamless/i)).toBeTruthy()
    expect(allocateBasePools).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /start farming/i }))
    await waitFor(() =>
      expect(runFarmFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          allocations: givenAllocations,
          burnUnits7: 1_000_000_000n,
        })
      )
    )
    expect(allocateBasePools).not.toHaveBeenCalled()
  })

  test('standalone fallback derives one 7dp burn and quantizes dispatch to Circle six-decimal truncation', async () => {
    allocateBasePools.mockClear()
    runFarmFlow.mockClear()
    allocateBasePools.mockResolvedValue([
      {
        pool: '0xAAAA',
        protocol: 'standalone',
        amount: 0.1234567,
        minShares: 1n,
        expectedApy: 5,
        riskTier: 'medium',
        skill: {},
      },
    ])
    runFarmFlow.mockResolvedValue({ finalStatus: 'done' })

    render(
      <Farm
        amount={0.1234567}
        riskLevel="medium"
        nPools={1}
        stellarWallet={{ address: 'GWALLET', signBurn: vi.fn() }}
        baseRecipientAddress="0xBASEACCT"
        sessionKeyAddress="0xSESSION"
        serializedApproval="approval-blob"
      />
    )

    await waitFor(() => screen.getByRole('button', { name: /start farming/i }))
    fireEvent.click(screen.getByRole('button', { name: /start farming/i }))
    await waitFor(() => expect(runFarmFlow).toHaveBeenCalledTimes(1))
    const farmCall = runFarmFlow.mock.calls[0][0]
    expect(farmCall.burnUnits7).toBe(1_234_560n)
    expect(farmCall.allocations.map((a) => a.amountBaseUnits)).toEqual([123_456n])
  })

  test('validates pre-quantized allocation totals against the burn before dispatch', async () => {
    allocateBasePools.mockClear()
    runFarmFlow.mockClear()
    const mismatchedAllocations = [
      {
        pool: '0xAAAA',
        protocol: 'mismatch',
        amount: 1,
        amountBaseUnits: 1_000_001n,
        minShares: 1n,
        expectedApy: 5,
        riskTier: 'medium',
        skill: {},
      },
    ]

    render(
      <Farm
        amount={1}
        riskLevel="medium"
        nPools={1}
        stellarWallet={{ address: 'GWALLET', signBurn: vi.fn() }}
        baseRecipientAddress="0xBASEACCT"
        sessionKeyAddress="0xSESSION"
        serializedApproval="approval-blob"
        allocations={mismatchedAllocations}
        burnUnits7={10_000_000n}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /start farming/i }))
    await waitFor(() => expect(screen.getByText(/^error$/i)).toBeTruthy())
    expect(runFarmFlow).not.toHaveBeenCalled()
  })

  test('a staged failure event renders the stage-specific error, not a generic message', async () => {
    allocateBasePools.mockResolvedValue([
      {
        pool: '0xAAAA',
        protocol: 'aave-v3',
        amount: 100,
        minShares: 99n,
        expectedApy: 5.1,
        riskTier: 'low',
        skill: {},
      },
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
