// frontend/src/crossChainFarm.test.js
import { describe, test, expect, vi } from 'vitest'
import { runFarmFlow } from './crossChainFarm.js'

describe('runFarmFlow', () => {
  test('burns on Stellar, dispatches to the relayer, polls to done, emits progress events in order', async () => {
    const events = []
    const onEvent = (name, data) => events.push({ name, data })
    const deps = {
      burn: vi.fn(async () => ({ approveHash: 'a', burnHash: 'burn-1' })),
      postFarm: vi.fn(async () => ({ jobId: 'job-1' })),
      pollFarmStatus: vi.fn(async () => ({ status: 'done', steps: { pool1: 'deposited' } })),
    }

    const result = await runFarmFlow({
      stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
      baseRecipientAddress: '0xBASEACCT',
      sessionKeyAddress: '0xSESSION',
      serializedApproval: 'approval-blob',
      allocations: [{ pool: '0xAAAA', amount: 100, minShares: 99n }],
      amountUnits: 1_000_000_000n,
      onEvent,
      deps,
    })

    expect(result).toEqual({ burnHash: 'burn-1', jobId: 'job-1', finalStatus: 'done' })
    expect(events.map((e) => e.name)).toEqual([
      'farm-burn-started',
      'farm-burn-confirmed',
      'farm-relay-dispatched',
      'farm-completed',
    ])
    expect(deps.postFarm).toHaveBeenCalledWith(
      expect.objectContaining({
        burnTxHash: 'burn-1',
        sourceDomain: 27,
        serializedApproval: 'approval-blob',
      })
    )
  })

  test('a burn failure surfaces a clear error and never calls the relayer — funds stay on Stellar, recoverable', async () => {
    const onEvent = vi.fn()
    const deps = {
      burn: vi.fn(async () => {
        throw new Error('friendbot funding failed (503)')
      }),
      postFarm: vi.fn(),
      pollFarmStatus: vi.fn(),
    }
    await expect(
      runFarmFlow({
        stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
        baseRecipientAddress: '0xBASEACCT',
        sessionKeyAddress: '0xSESSION',
        serializedApproval: 'approval-blob',
        allocations: [],
        amountUnits: 1n,
        onEvent,
        deps,
      })
    ).rejects.toThrow(/friendbot funding failed/)
    expect(deps.postFarm).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith('farm-burn-started', expect.anything())
    expect(onEvent).toHaveBeenCalledWith('farm-failed', expect.objectContaining({ stage: 'burn' }))
  })

  test('a relay failure after a successful burn surfaces a clear error naming that funds already left Stellar', async () => {
    const onEvent = vi.fn()
    const deps = {
      burn: vi.fn(async () => ({ approveHash: 'a', burnHash: 'burn-1' })),
      postFarm: vi.fn(async () => {
        throw new Error('relayer unreachable')
      }),
      pollFarmStatus: vi.fn(),
    }
    await expect(
      runFarmFlow({
        stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
        baseRecipientAddress: '0xBASEACCT',
        sessionKeyAddress: '0xSESSION',
        serializedApproval: 'approval-blob',
        allocations: [],
        amountUnits: 1n,
        onEvent,
        deps,
      })
    ).rejects.toThrow(/relayer unreachable/)
    expect(onEvent).toHaveBeenCalledWith(
      'farm-failed',
      expect.objectContaining({ stage: 'relay', recoveryHint: expect.stringContaining('burn-1') })
    )
  })
})
