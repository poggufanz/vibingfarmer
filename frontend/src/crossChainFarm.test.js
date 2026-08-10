// frontend/src/crossChainFarm.test.js
import { describe, test, expect, vi } from 'vitest'

vi.mock('./base/deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } = await import('./base/hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

import { runFarmFlow } from './crossChainFarm.js'
import { readCctpTransfer } from './cctp/transferJournal.js'
import { BASE_POOL_CATALOG } from './config.js'

const OWNER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'
const REQUEST_ID = '11'.repeat(16)
const MANDATE_ID = '22'.repeat(16)
const JOB_ID = '33'.repeat(16)
const OTHER_JOB_ID = '34'.repeat(16)
const BURN_TX_HASH = '66'.repeat(32)
const KERNEL = `0x${'99'.repeat(20)}`
const BINDING_HASH = 'aa'.repeat(32)
const GRANT_TX_HASH = 'bb'.repeat(32)
const BRIDGE_AGENT = 'CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ'
const RUN_ID = 'run-42'

const AAVE_POOL = BASE_POOL_CATALOG.find((p) => p.proxyTarget === 'aave-v3').address

function makeStorage({ write } = {}) {
  const values = new Map()
  return {
    get length() {
      return values.size
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      write ? write(values, key, value) : values.set(key, value)
    },
    removeItem(key) {
      values.delete(key)
    },
    dump() {
      return [...values.entries()]
    },
  }
}

function allocation(overrides = {}) {
  return {
    allocationId: `${RUN_ID}:bridge:aave-v3`,
    pool: AAVE_POOL,
    amount: 1,
    amountBaseUnits: 1_000_000n,
    minShares: 900_000n,
    ...overrides,
  }
}

function completeChild() {
  return {
    bindingId: 'binding-v1',
    executionId: `${RUN_ID}:exec:${RUN_ID}:bridge:aave-v3`,
    allocationId: `${RUN_ID}:bridge:aave-v3`,
    childId: 'child-1',
    userOpHash: `0x${'77'.repeat(32)}`,
    mintTxHash: `0x${'88'.repeat(32)}`,
    depositTxHash: `0x${'cc'.repeat(32)}`,
    custody: { location: 'base', confirmed: true, checkedAt: 2_000_000_000_000 },
    recoveryVersion: 1,
  }
}

function status({ status = 'done', jobId = JOB_ID, mandateId = MANDATE_ID, allocations } = {}) {
  return {
    status,
    jobId,
    mandateId,
    ...(status === 'done'
      ? {
          associationDelivery: { complete: true, blocked: false },
          evidenceDelivery: { complete: true, blocked: false },
          allocations: allocations ?? [completeChild()],
        }
      : allocations === undefined
        ? {}
        : { allocations }),
  }
}

function farmParams(overrides = {}) {
  const { deps: depOverrides = {}, local: suppliedLocal, ...params } = overrides
  const local = suppliedLocal ?? makeStorage()
  const deps = {
    journalStorage: local,
    requestId: REQUEST_ID,
    burn: vi.fn(async () => ({ approveHash: 'a', burnHash: BURN_TX_HASH })),
    postFarm: vi.fn(async () => ({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 })),
    postFarmAttach: vi.fn(async () => ({
      jobId: JOB_ID,
      attached: true,
      burnTxHash: BURN_TX_HASH,
    })),
    pollFarmStatus: vi.fn(async () => status()),
    ...depOverrides,
  }
  return {
    stellarWallet: { address: OWNER, signBurn: vi.fn() },
    baseRecipientAddress: KERNEL,
    sessionKeyAddress: `0x${'ef'.repeat(20)}`,
    mandateId: MANDATE_ID,
    bindingId: 'binding-v1',
    bindingHash: BINDING_HASH,
    allocations: [allocation()],
    burnUnits7: 10_000_000n,
    bridgeAgentAddress: BRIDGE_AGENT,
    runId: RUN_ID,
    grantTxHash: GRANT_TX_HASH,
    ...params,
    deps,
  }
}

function record(local, requestId = REQUEST_ID) {
  return readCctpTransfer({ owner: OWNER, requestId }, { storage: local })
}

describe('runFarmFlow browser journal boundaries', () => {
  // Defect caught: moving a journal checkpoint below its side effect re-opens the reload burn window.
  test('writes the exact journal-before-intent/burn/attach/poll trace and returns public status evidence', async () => {
    const trace = []
    const local = makeStorage({
      write(values, key, value) {
        const state = JSON.parse(value).state
        trace.push(`journal:${state}`)
        values.set(key, value)
      },
    })
    const child = completeChild()
    const events = []
    const params = farmParams({
      local,
      onEvent: (name, data) => events.push({ name, data }),
      deps: {
        burn: vi.fn(async () => {
          expect(record(local)?.state).toBe('burn_submitting')
          trace.push('burn')
          return { approveHash: 'a', burnHash: BURN_TX_HASH }
        }),
        postFarm: vi.fn(async (body) => {
          expect(record(local)?.state).toBe('intent_creating')
          expect(body.requestId).toBe(REQUEST_ID)
          trace.push('intent')
          return { jobId: JOB_ID, acknowledged: true, schemaVersion: 1 }
        }),
        postFarmAttach: vi.fn(async (body) => {
          expect(record(local)?.state).toBe('attach_pending')
          expect(record(local)?.transfer.burnTxHash).toBe(BURN_TX_HASH)
          expect(body).toEqual({ mandateId: MANDATE_ID, jobId: JOB_ID, burnTxHash: BURN_TX_HASH })
          trace.push('attach')
          return { jobId: JOB_ID, attached: true, burnTxHash: BURN_TX_HASH }
        }),
        pollFarmStatus: vi.fn(async (identity) => {
          expect(record(local)?.state).toBe('settling')
          expect(identity).toEqual({ mandateId: MANDATE_ID, jobId: JOB_ID })
          trace.push('poll')
          return status({
            allocations: [child],
          })
        }),
      },
    })

    const result = await runFarmFlow(params)

    expect(trace).toEqual([
      'journal:intent_creating',
      'intent',
      'journal:intent_acked',
      'journal:burn_submitting',
      'burn',
      'journal:burn_confirmed',
      'journal:attach_pending',
      'attach',
      'journal:settling',
      'poll',
      'journal:done',
    ])
    expect(params.deps.burn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      burnHash: BURN_TX_HASH,
      jobId: JOB_ID,
      finalStatus: 'done',
      status: 'done',
      associationDelivery: { complete: true, blocked: false },
      evidenceDelivery: { complete: true, blocked: false },
      allocations: [child],
    })
    expect(record(local)).toMatchObject({
      state: 'done',
      transfer: {
        mandateId: MANDATE_ID,
        kernelAddress: KERNEL,
        bindingId: 'binding-v1',
        bindingHash: BINDING_HASH,
        bridgeAgent: BRIDGE_AGENT,
        grantTxHash: GRANT_TX_HASH,
        jobId: JOB_ID,
        burnTxHash: BURN_TX_HASH,
      },
    })
    expect(JSON.stringify({ result, events, journal: local.dump() })).not.toMatch(
      /capability|privatekey|authorization|bearer|cookie|approval|signedxdr|passkey/i
    )
  })

  test('does not post an intent when the initial durable journal write fails', async () => {
    const local = makeStorage({
      write() {
        throw new Error('quota')
      },
    })
    const params = farmParams({ local })
    await expect(runFarmFlow(params)).rejects.toMatchObject({ code: 'journal_unavailable' })
    expect(params.deps.postFarm).not.toHaveBeenCalled()
    expect(params.deps.burn).not.toHaveBeenCalled()
  })

  test('does not burn when the acknowledgement cannot be durably checkpointed', async () => {
    let writes = 0
    const local = makeStorage({
      write(values, key, value) {
        writes += 1
        if (writes === 2) return
        values.set(key, value)
      },
    })
    const params = farmParams({ local })
    await expect(runFarmFlow(params)).rejects.toMatchObject({ code: 'journal_unavailable' })
    expect(params.deps.postFarm).toHaveBeenCalledTimes(1)
    expect(params.deps.burn).not.toHaveBeenCalled()
  })

  test('keeps one confirmed burn durable and never attaches when its checkpoint write fails', async () => {
    let writes = 0
    const local = makeStorage({
      write(values, key, value) {
        writes += 1
        if (writes === 4) return
        values.set(key, value)
      },
    })
    const events = []
    const params = farmParams({ local, onEvent: (name, data) => events.push({ name, data }) })
    await expect(runFarmFlow(params)).rejects.toMatchObject({ code: 'journal_unavailable' })
    expect(params.deps.burn).toHaveBeenCalledTimes(1)
    expect(params.deps.postFarmAttach).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        name: 'farm-failed',
        data: expect.objectContaining({ stage: 'attach', jobId: JOB_ID, burnHash: BURN_TX_HASH }),
      })
    )
  })

  test('keeps a response-loss attach journal row with the exact job and burn, without a second burn', async () => {
    const local = makeStorage()
    const params = farmParams({
      local,
      deps: {
        postFarmAttach: vi.fn(async () => {
          throw new Error('response lost')
        }),
      },
    })
    await expect(runFarmFlow(params)).rejects.toThrow('response lost')
    expect(params.deps.burn).toHaveBeenCalledTimes(1)
    expect(params.deps.postFarmAttach).toHaveBeenCalledTimes(1)
    expect(record(local)).toMatchObject({
      state: 'attach_pending',
      transfer: { jobId: JOB_ID, burnTxHash: BURN_TX_HASH },
    })
  })

  test.each([
    ['wrong status job identity', status({ jobId: OTHER_JOB_ID }), /identity changed/i],
    ['wrong status mandate identity', status({ mandateId: '44'.repeat(16) }), /identity changed/i],
    ['untrusted status field', { ...status(), capability: 'must-not-leak' }, /malformed/i],
  ])('rejects %s without writing a terminal success', async (_label, response, error) => {
    const local = makeStorage()
    const params = farmParams({ local, deps: { pollFarmStatus: vi.fn(async () => response) } })
    await expect(runFarmFlow(params)).rejects.toThrow(error)
    expect(record(local)).toMatchObject({
      state: 'settling',
      transfer: { jobId: JOB_ID, burnTxHash: BURN_TX_HASH },
    })
  })

  test('rejects a done status whose complete-looking child evidence belongs to a different reviewed allocation', async () => {
    const local = makeStorage()
    const forgedChild = { ...completeChild(), allocationId: `${RUN_ID}:bridge:moonwell` }
    const params = farmParams({
      local,
      deps: { pollFarmStatus: vi.fn(async () => status({ allocations: [forgedChild] })) },
    })
    await expect(runFarmFlow(params)).rejects.toThrow(/allocation evidence|identity/i)
    expect(record(local)).toMatchObject({
      state: 'settling',
      transfer: { jobId: JOB_ID, burnTxHash: BURN_TX_HASH },
    })
  })

  test.each(['error', 'uncertain', 'blocked'])(
    'preserves strict public terminal %s status without inventing allocation evidence',
    async (terminal) => {
      const local = makeStorage()
      const params = farmParams({
        local,
        deps: { pollFarmStatus: vi.fn(async () => status({ status: terminal })) },
      })
      const result = await runFarmFlow(params)
      expect(result).toEqual({
        burnHash: BURN_TX_HASH,
        jobId: JOB_ID,
        finalStatus: terminal,
        status: terminal,
      })
      expect(record(local)).toMatchObject({ state: terminal, terminalFrom: 'settling' })
    }
  )
})

describe('runFarmFlow protected wire POST migration', () => {
  test('threads a stable canonical request, owner, mandate, binding, and grant snapshot through postFarm', async () => {
    const local = makeStorage()
    const params = farmParams({ local })
    await runFarmFlow(params)
    expect(params.deps.postFarm).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: REQUEST_ID,
        sourceDomain: 27,
        mandateId: MANDATE_ID,
        stellarOwner: OWNER,
        kernelAddress: KERNEL,
        bridgeAgent: BRIDGE_AGENT,
        runId: RUN_ID,
        grantTxHash: GRANT_TX_HASH,
      })
    )
  })

  test.each([
    ['reporter failure', 'farm intent unavailable'],
    ['malformed acknowledgement', null],
  ])('does not burn or attach when %s prevents durable intent', async (_label, message) => {
    const local = makeStorage()
    const params = farmParams({
      local,
      deps: {
        postFarm: vi.fn(async () => {
          if (message) throw new Error(message)
          return { jobId: JOB_ID, acknowledged: false, schemaVersion: 1 }
        }),
      },
    })
    await expect(runFarmFlow(params)).rejects.toThrow(message ?? 'malformed')
    expect(params.deps.burn).not.toHaveBeenCalled()
    expect(params.deps.postFarmAttach).not.toHaveBeenCalled()
    expect(params.deps.pollFarmStatus).not.toHaveBeenCalled()
    expect(record(local)).toMatchObject({ state: 'intent_creating' })
  })
})

describe('runFarmFlow pre-validation guards', () => {
  function assertNoBoundaryEffects(local, deps) {
    expect(local.length).toBe(0)
    expect(deps.postFarm).not.toHaveBeenCalled()
    expect(deps.burn).not.toHaveBeenCalled()
    expect(deps.postFarmAttach).not.toHaveBeenCalled()
    expect(deps.pollFarmStatus).not.toHaveBeenCalled()
  }

  test('rejects a non-six-decimal Stellar burn before Storage, intent, or burn', async () => {
    const local = makeStorage()
    const params = farmParams({
      local,
      burnUnits7: 1_234_567n,
      allocations: [allocation({ amountBaseUnits: 123_456n })],
    })
    await expect(runFarmFlow(params)).rejects.toThrow(/burnUnits7.*divisible by 10/i)
    assertNoBoundaryEffects(local, params.deps)
  })

  test.each([
    ['an empty allocation list', [], 10n, /non-empty/i],
    [
      'an allocation without exact bigint units',
      [allocation({ amountBaseUnits: 1 })],
      10n,
      /positive bigint/i,
    ],
    [
      'a non-positive exact allocation',
      [allocation({ amountBaseUnits: 0n })],
      10n,
      /positive bigint/i,
    ],
    [
      'an exact allocation total that differs from the CCTP mint',
      [allocation({ amountBaseUnits: 2n })],
      10n,
      /sum.*expected 1/i,
    ],
    [
      'a missing canonical allocation ID',
      [allocation({ allocationId: undefined })],
      10_000_000n,
      /allocationId/i,
    ],
    [
      'a foreign allocation ID',
      [allocation({ allocationId: 'other:bridge:aave-v3' })],
      10_000_000n,
      /allocationId|canonical/i,
    ],
    [
      'a duplicate canonical allocation ID',
      [allocation({ amountBaseUnits: 500_000n }), allocation({ amountBaseUnits: 500_000n })],
      10_000_000n,
      /duplicate|allocationId/i,
    ],
  ])(
    'rejects %s before Storage, intent, or burn',
    async (_label, allocations, burnUnits7, error) => {
      const local = makeStorage()
      const params = farmParams({ local, allocations, burnUnits7 })
      await expect(runFarmFlow(params)).rejects.toThrow(error)
      assertNoBoundaryEffects(local, params.deps)
    }
  )

  test('rejects an invalid request identity before it writes a journal row or crosses the wire', async () => {
    const local = makeStorage()
    const params = farmParams({ local, deps: { requestId: 'AA'.repeat(16) } })
    await expect(runFarmFlow(params)).rejects.toThrow(/request identity/i)
    assertNoBoundaryEffects(local, params.deps)
  })
})
