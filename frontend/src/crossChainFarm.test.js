// frontend/src/crossChainFarm.test.js
import { describe, test, expect, vi } from 'vitest'

vi.mock('./base/deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } = await import('./base/hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

import { runFarmFlow } from './crossChainFarm.js'
import { BASE_POOL_CATALOG } from './config.js'

// Real catalog entries (test env pins these to fixed 0x1111...111N addresses — see
// vite.config.js's test.env block) — Fix loop 2, Fix 2a requires every allocation's
// allocationId to resolve to `${runId}:bridge:${proxyTarget}` via this exact catalog, matching
// relayer/src/httpRouter.mjs:246-262, so tests below use real entries instead of placeholders.
const AAVE_POOL = BASE_POOL_CATALOG.find((p) => p.proxyTarget === 'aave-v3').address
const MOONWELL_POOL = BASE_POOL_CATALOG.find((p) => p.proxyTarget === 'moonwell').address
const MANDATE_ID = '11'.repeat(16)
const JOB_ID = '55'.repeat(16)
const OTHER_JOB_ID = '66'.repeat(16)

describe('crossChainFarm protected wire POST migration', () => {
  // Defect caught: the browser used to burn before the relayer durably acknowledged the Base child intent.
  test('commits intent, burns once, attaches that burn, then polls in exact custody-safe order', async () => {
    const events = []
    const calls = []
    const onEvent = (name, data) => events.push({ name, data })
    const allocations = [
      {
        allocationId: 'run-42:bridge:aave-v3',
        pool: AAVE_POOL,
        amount: 100,
        amountBaseUnits: 100_000_000n,
        minShares: 99n,
      },
    ]
    const deps = {
      burn: vi.fn(async () => {
        calls.push('burn')
        return { approveHash: 'a', burnHash: 'burn-1' }
      }),
      postFarm: vi.fn(async () => {
        calls.push('intent')
        return { jobId: JOB_ID, acknowledged: true, schemaVersion: 1 }
      }),
      postFarmAttach: vi.fn(async () => {
        calls.push('attach')
        return { jobId: JOB_ID, attached: true }
      }),
      pollFarmStatus: vi.fn(async () => {
        calls.push('poll')
        return { status: 'done', steps: { pool1: 'deposited' } }
      }),
    }

    const result = await runFarmFlow({
      stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
      baseRecipientAddress: '0xBASEACCT',
      sessionKeyAddress: '0xSESSION',
      mandateId: MANDATE_ID,
      allocations,
      burnUnits7: 1_000_000_000n,
      runId: 'run-42',
      onEvent,
      deps,
    })

    expect(result).toEqual({ burnHash: 'burn-1', jobId: JOB_ID, finalStatus: 'done' })
    expect(calls).toEqual(['intent', 'burn', 'attach', 'poll'])
    expect(deps.burn).toHaveBeenCalledWith(expect.objectContaining({ amountUnits: 1_000_000_000n }))
    expect(events.map((e) => e.name)).toEqual([
      'farm-intent-committed',
      'farm-burn-started',
      'farm-burn-confirmed',
      'farm-relay-dispatched',
      'farm-completed',
    ])
    expect(deps.postFarm).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDomain: 27,
        mandateId: MANDATE_ID,
        allocations,
        // VF Wallet Task 6: stellarOwner/kernelAddress bind the dispatch, derived from the
        // params already passed in (no new required args); bridgeAgent/grantTxHash default to
        // null when the caller doesn't supply them (runId is supplied here — Fix loop 2, Fix 2a
        // now requires it to validate every allocation's canonical allocationId before the burn).
        stellarOwner: 'GWALLET',
        kernelAddress: '0xBASEACCT',
        bridgeAgent: null,
        runId: 'run-42',
        grantTxHash: null,
      })
    )
    expect(deps.postFarmAttach).toHaveBeenCalledWith({
      mandateId: MANDATE_ID,
      jobId: JOB_ID,
      burnTxHash: 'burn-1',
      stellarOwner: 'GWALLET',
      kernelAddress: '0xBASEACCT',
    })
    expect(deps.pollFarmStatus).toHaveBeenCalledWith({ mandateId: MANDATE_ID, jobId: JOB_ID })
    expect(JSON.stringify(deps.postFarm.mock.calls)).not.toMatch(
      /serializedApproval|approval-blob/i
    )
    expect(JSON.stringify({ result, events })).not.toMatch(
      /serializedApproval|capability|sessionPrivateKey|Authorization|Bearer|Cookie/i
    )
  })

  // Defect caught: ambiguous reporter failures previously happened after custody had already left Stellar.
  test.each([
    ['reporter 401', 'farm intent failed (401)'],
    ['reporter timeout', 'farm intent timed out'],
    ['malformed acknowledgement', 'farm intent acknowledgement is malformed'],
    ['schema mismatch', 'farm intent schema mismatch'],
    ['D1 failure', 'farm intent failed (503)'],
  ])(
    'does not burn or start follow-up work when %s prevents durable intent',
    async (_label, message) => {
      const deps = {
        postFarm: vi.fn(async () => {
          throw new Error(message)
        }),
        burn: vi.fn(),
        postFarmAttach: vi.fn(),
        pollFarmStatus: vi.fn(),
      }
      await expect(
        runFarmFlow({
          stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
          baseRecipientAddress: '0xBASEACCT',
          sessionKeyAddress: '0xSESSION',
          mandateId: MANDATE_ID,
          allocations: [
            {
              allocationId: 'run-safe:bridge:aave-v3',
              pool: AAVE_POOL,
              amountBaseUnits: 1n,
              minShares: 0n,
            },
          ],
          burnUnits7: 10n,
          bridgeAgentAddress: 'CBRIDGE',
          runId: 'run-safe',
          grantTxHash: 'HGRANT',
          deps,
        })
      ).rejects.toThrow(message)
      expect(deps.burn).not.toHaveBeenCalled()
      expect(deps.postFarmAttach).not.toHaveBeenCalled()
      expect(deps.pollFarmStatus).not.toHaveBeenCalled()
    }
  )

  test('threads bridgeAgentAddress/runId/grantTxHash through to postFarm when the caller supplies them', async () => {
    const deps = {
      burn: vi.fn(async () => ({ approveHash: 'a', burnHash: 'burn-1' })),
      postFarm: vi.fn(async () => ({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 })),
      postFarmAttach: vi.fn(async () => ({ jobId: JOB_ID, attached: true })),
      pollFarmStatus: vi.fn(async () => ({ status: 'done', steps: {} })),
    }
    await runFarmFlow({
      stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
      baseRecipientAddress: '0xBASEACCT',
      sessionKeyAddress: '0xSESSION',
      mandateId: MANDATE_ID,
      allocations: [
        {
          allocationId: 'run-42:bridge:aave-v3',
          pool: AAVE_POOL,
          amount: 100,
          amountBaseUnits: 100_000_000n,
          minShares: 99n,
        },
      ],
      burnUnits7: 1_000_000_000n,
      bridgeAgentAddress: 'CBRIDGE',
      runId: 'run-42',
      grantTxHash: 'HGRANT',
      deps,
    })
    expect(deps.postFarm).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeAgent: 'CBRIDGE', runId: 'run-42', grantTxHash: 'HGRANT' })
    )
  })

  // Defect caught: a burn failure must leave only an inert durable intent and must never attach/start it.
  test('a burn failure surfaces a clear error and never attaches the acknowledged intent', async () => {
    const onEvent = vi.fn()
    const deps = {
      burn: vi.fn(async () => {
        throw new Error('friendbot funding failed (503)')
      }),
      postFarm: vi.fn(async () => ({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 })),
      postFarmAttach: vi.fn(),
      pollFarmStatus: vi.fn(),
    }
    await expect(
      runFarmFlow({
        stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
        baseRecipientAddress: '0xBASEACCT',
        sessionKeyAddress: '0xSESSION',
        mandateId: MANDATE_ID,
        allocations: [
          { allocationId: 'run-b:bridge:aave-v3', pool: AAVE_POOL, amountBaseUnits: 1n },
        ],
        burnUnits7: 10n,
        runId: 'run-b',
        onEvent,
        deps,
      })
    ).rejects.toThrow(/friendbot funding failed/)
    expect(deps.postFarm).toHaveBeenCalledTimes(1)
    expect(deps.postFarmAttach).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledWith('farm-burn-started', expect.anything())
    expect(onEvent).toHaveBeenCalledWith('farm-failed', expect.objectContaining({ stage: 'burn' }))
  })

  // Defect caught: an attach failure after burn must identify the already-durable job and burn for recovery.
  test('an attach failure after a successful burn surfaces a recovery hint with job and burn', async () => {
    const onEvent = vi.fn()
    const deps = {
      burn: vi.fn(async () => ({ approveHash: 'a', burnHash: 'burn-1' })),
      postFarm: vi.fn(async () => ({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 })),
      postFarmAttach: vi.fn(async () => {
        throw new Error('relayer unreachable')
      }),
      pollFarmStatus: vi.fn(),
    }
    await expect(
      runFarmFlow({
        stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
        baseRecipientAddress: '0xBASEACCT',
        sessionKeyAddress: '0xSESSION',
        mandateId: MANDATE_ID,
        allocations: [
          { allocationId: 'run-r:bridge:aave-v3', pool: AAVE_POOL, amountBaseUnits: 1n },
        ],
        burnUnits7: 10n,
        runId: 'run-r',
        onEvent,
        deps,
      })
    ).rejects.toThrow(/relayer unreachable/)
    expect(onEvent).toHaveBeenCalledWith(
      'farm-failed',
      expect.objectContaining({
        stage: 'attach',
        recoveryHint: expect.stringMatching(new RegExp(`${JOB_ID}.*burn-1|burn-1.*${JOB_ID}`)),
      })
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
        mandateId: MANDATE_ID,
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
        mandateId: MANDATE_ID,
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

// Fix loop 2, Fix 2a: frontend/src/base/relayerClient.js's canonical-allocationId guard threw
// inside postFarm, which historically ran only AFTER the CCTP burn had already submitted. The
// flow now validates the same identity before intent commit and before the later burn. So a
// non-canonical or missing allocationId meant burned USDC that could never be deposited. This
// block locks the SAME rule — `${runId}:bridge:${proxyTarget}`, proxyTarget resolved from the
// pool address via BASE_POOL_CATALOG (relayer/src/httpRouter.mjs:246-262's exact rule) — into
// runFarmFlow's existing pre-burn validation block, so the same class of bug now fails closed
// before any funds move.
describe('runFarmFlow allocationId canonical guard (pre-burn)', () => {
  const RUN_ID = 'run-canon'

  function canonicalAllocation(overrides = {}) {
    return {
      allocationId: `${RUN_ID}:bridge:aave-v3`,
      pool: AAVE_POOL,
      amount: 100,
      amountBaseUnits: 100_000_000n,
      minShares: 99n,
      ...overrides,
    }
  }

  function baseParams(overrides = {}) {
    return {
      stellarWallet: { address: 'GWALLET', signBurn: vi.fn() },
      baseRecipientAddress: '0xBASEACCT',
      sessionKeyAddress: '0xSESSION',
      mandateId: MANDATE_ID,
      burnUnits7: 1_000_000_000n,
      runId: RUN_ID,
      ...overrides,
    }
  }

  test('a canonical allocationId still burns and dispatches unchanged (no behavior change on the healthy path)', async () => {
    const deps = {
      burn: vi.fn(async () => ({ approveHash: 'a', burnHash: 'burn-canon' })),
      postFarm: vi.fn(async () => ({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 })),
      postFarmAttach: vi.fn(async () => ({ jobId: JOB_ID, attached: true })),
      pollFarmStatus: vi.fn(async () => ({ status: 'done', steps: {} })),
    }
    const result = await runFarmFlow({
      ...baseParams(),
      allocations: [canonicalAllocation()],
      deps,
    })
    expect(result.finalStatus).toBe('done')
    expect(deps.burn).toHaveBeenCalledTimes(1)
    expect(deps.postFarm).toHaveBeenCalledTimes(1)
  })

  // Also proves reordering/multiple canonical allocations (summing to the full burn) still work.
  test('multiple canonical allocations across different catalog pools still burn and dispatch unchanged', async () => {
    const deps = {
      burn: vi.fn(async () => ({ approveHash: 'a', burnHash: 'burn-multi' })),
      postFarm: vi.fn(async () => ({ jobId: OTHER_JOB_ID, acknowledged: true, schemaVersion: 1 })),
      postFarmAttach: vi.fn(async () => ({ jobId: OTHER_JOB_ID, attached: true })),
      pollFarmStatus: vi.fn(async () => ({ status: 'done', steps: {} })),
    }
    const result = await runFarmFlow({
      ...baseParams(),
      allocations: [
        canonicalAllocation({ amountBaseUnits: 60_000_000n }),
        canonicalAllocation({
          allocationId: `${RUN_ID}:bridge:moonwell`,
          pool: MOONWELL_POOL,
          amountBaseUnits: 40_000_000n,
        }),
      ],
      deps,
    })
    expect(result.finalStatus).toBe('done')
    expect(deps.burn).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['a missing allocationId', { allocationId: undefined }, /allocationId/i],
    [
      'an array-index-shaped allocationId (the orchestrator.js producer this closes off)',
      { allocationId: `${RUN_ID}:bridge:0` },
      /allocationId|canonical/i,
    ],
    [
      'a foreign-run allocationId',
      { allocationId: 'run-other:bridge:aave-v3' },
      /allocationId|canonical/i,
    ],
    [
      'an allocationId for a pool absent from the catalog',
      { pool: `0x${'de'.repeat(20)}`, allocationId: `${RUN_ID}:bridge:aave-v3` },
      /catalog|pool/i,
    ],
  ])('rejects %s before burn is called', async (_label, overrides, expectedError) => {
    const deps = {
      burn: vi.fn(async () => ({ burnHash: 'must-not-run' })),
      postFarm: vi.fn(async () => ({ jobId: 'must-not-run' })),
      pollFarmStatus: vi.fn(),
    }
    await expect(
      runFarmFlow({
        ...baseParams(),
        allocations: [canonicalAllocation(overrides)],
        deps,
      })
    ).rejects.toThrow(expectedError)
    expect(deps.burn).not.toHaveBeenCalled()
    expect(deps.postFarm).not.toHaveBeenCalled()
  })

  test('rejects a duplicate allocationId before burn is called', async () => {
    const deps = {
      burn: vi.fn(async () => ({ burnHash: 'must-not-run' })),
      postFarm: vi.fn(async () => ({ jobId: 'must-not-run' })),
      pollFarmStatus: vi.fn(),
    }
    await expect(
      runFarmFlow({
        ...baseParams(),
        allocations: [
          canonicalAllocation({ amountBaseUnits: 50_000_000n }),
          canonicalAllocation({ amountBaseUnits: 50_000_000n }),
        ],
        deps,
      })
    ).rejects.toThrow(/duplicate|allocationId/i)
    expect(deps.burn).not.toHaveBeenCalled()
    expect(deps.postFarm).not.toHaveBeenCalled()
  })
})
