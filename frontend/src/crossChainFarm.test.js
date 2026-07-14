// frontend/src/crossChainFarm.test.js
import { describe, test, expect, vi } from 'vitest'
import { runFarmFlow } from './crossChainFarm.js'

describe('runFarmFlow', () => {
  test('burns on Stellar, dispatches to the relayer, polls to done, emits progress events in order', async () => {
    const events = []
    const onEvent = (name, data) => events.push({ name, data })
    const allocations = [
      { pool: '0xAAAA', amount: 100, amountBaseUnits: 100_000_000n, minShares: 99n },
    ]
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
      allocations,
      burnUnits7: 1_000_000_000n,
      onEvent,
      deps,
    })

    expect(result).toEqual({ burnHash: 'burn-1', jobId: 'job-1', finalStatus: 'done' })
    expect(deps.burn).toHaveBeenCalledWith(expect.objectContaining({ amountUnits: 1_000_000_000n }))
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
        allocations,
      })
    )
  })

  test('a burn failure surfaces a clear error and never calls the relayer - funds stay on Stellar, recoverable', async () => {
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
        allocations: [{ pool: '0xAAAA', amountBaseUnits: 1n }],
        burnUnits7: 10n,
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
        allocations: [{ pool: '0xAAAA', amountBaseUnits: 1n }],
        burnUnits7: 10n,
        onEvent,
        deps,
      })
    ).rejects.toThrow(/relayer unreachable/)
    expect(onEvent).toHaveBeenCalledWith(
      'farm-failed',
      expect.objectContaining({ stage: 'relay', recoveryHint: expect.stringContaining('burn-1') })
    )
  })

  test('rejects a non-six-decimal Stellar burn before any side effect', async () => {
    const deps = {
      burn: vi.fn(async () => ({ burnHash: 'must-not-run' })),
      postFarm: vi.fn(async () => ({ jobId: 'must-not-run' })),
      pollFarmStatus: vi.fn(),
    }

    await expect(
      runFarmFlow({
        stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
        baseRecipientAddress: '0xBASEACCT',
        sessionKeyAddress: '0xSESSION',
        serializedApproval: 'approval-blob',
        allocations: [{ pool: '0xAAAA', amountBaseUnits: 123_456n }],
        burnUnits7: 1_234_567n,
        deps,
      })
    ).rejects.toThrow(/burnUnits7.*divisible by 10/i)
    expect(deps.burn).not.toHaveBeenCalled()
    expect(deps.postFarm).not.toHaveBeenCalled()
  })

  test.each([
    ['an empty allocation list', [], /non-empty/i],
    [
      'an allocation without exact bigint units',
      [{ pool: '0xAAAA', amountBaseUnits: 1 }],
      /positive bigint/i,
    ],
    [
      'a non-positive exact allocation',
      [{ pool: '0xAAAA', amountBaseUnits: 0n }],
      /positive bigint/i,
    ],
    [
      'an exact allocation total that differs from the CCTP mint',
      [{ pool: '0xAAAA', amountBaseUnits: 2n }],
      /sum.*expected 1/i,
    ],
  ])('rejects %s before burn or dispatch', async (_label, allocations, expectedError) => {
    const deps = {
      burn: vi.fn(async () => ({ burnHash: 'must-not-run' })),
      postFarm: vi.fn(async () => ({ jobId: 'must-not-run' })),
      pollFarmStatus: vi.fn(),
    }

    await expect(
      runFarmFlow({
        stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
        baseRecipientAddress: '0xBASEACCT',
        sessionKeyAddress: '0xSESSION',
        serializedApproval: 'approval-blob',
        allocations,
        burnUnits7: 10n,
        deps,
      })
    ).rejects.toThrow(expectedError)
    expect(deps.burn).not.toHaveBeenCalled()
    expect(deps.postFarm).not.toHaveBeenCalled()
    expect(deps.pollFarmStatus).not.toHaveBeenCalled()
  })
})
