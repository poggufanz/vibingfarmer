// frontend/src/base/relayerClient.test.js
import { describe, test, expect, vi } from 'vitest'

vi.mock('./deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } = await import('./hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

import * as relayerClient from './relayerClient.js'

const {
  postFarmAttach,
  pollFarmStatus,
  reserveUnwind,
  postUnwindAttach,
  pollUnwindStatus,
  postMandate,
  getMandateStatus,
  postMandateRevoke,
} = relayerClient

// Task 13 requires callers to own a stable request ID. Legacy unit scenarios exercise unrelated
// allocation/transport behavior, so supply one fixed caller-owned identity without weakening the
// production guard; request-ID-specific tests call relayerClient.postFarm directly.
const postFarm = (args) => relayerClient.postFarm({ requestId: JOB_ID, ...args })

const MANDATE_ID = '11'.repeat(16)
const CAPABILITY = '22'.repeat(32)
const OTHER_ID = '33'.repeat(16)
const JOB_ID = '55'.repeat(16)
const BASE_URL = '/api/vf-cross'
const STELLAR_OWNER = 'GUSER'
const KERNEL = '0x0000000000000000000000000000000000000aa1'
const CHECKSUMMED_KERNEL = '0x1234567890AbcdEF1234567890aBcdef12345678'
const SESSION = '0x0000000000000000000000000000000000000bb2'
const USER_OP_HASH = `0x${'33'.repeat(32)}`
const ACTIVATION_TX_HASH = `0x${'44'.repeat(32)}`
const BINDING_HASH = '66'.repeat(32)
const STELLAR_RECIPIENT = 'GCXMZCDVYTAANBRASUGWS5GDKRGSQWNM5XHVB4JI7PXECZYKBG5OTTRK'
const UNWIND_TX_HASH = `0x${'77'.repeat(32)}`
const MINT_TX_HASH = '88'.repeat(32)
const BLOCKED_REASON = 'message_mismatch'
const UNCERTAIN_REASON = 'submission_unknown'

function unwindProjection(status) {
  if (status === 'awaiting_burn' || status === 'expired') return { jobId: JOB_ID, status }
  if (status === 'done') {
    return { jobId: JOB_ID, status, unwindTxHash: UNWIND_TX_HASH, mintTxHash: MINT_TX_HASH }
  }
  if (status === 'blocked' || status === 'uncertain') {
    return {
      jobId: JOB_ID,
      status,
      unwindTxHash: UNWIND_TX_HASH,
      reasonCode: status === 'blocked' ? BLOCKED_REASON : UNCERTAIN_REASON,
    }
  }
  return { jobId: JOB_ID, status, unwindTxHash: UNWIND_TX_HASH }
}

function farmProjection(status, overrides = {}) {
  if (status !== 'done') return { status, ...overrides }
  return {
    status,
    jobId: JOB_ID,
    mandateId: MANDATE_ID,
    associationDelivery: { complete: true, blocked: false },
    evidenceDelivery: { complete: true, blocked: false },
    allocations: [],
    ...overrides,
  }
}

const verifiedActive = (overrides = {}) => ({
  version: 3,
  mandateId: MANDATE_ID,
  stellarOwner: STELLAR_OWNER,
  kernelAddress: KERNEL,
  sessionKeyAddress: SESSION,
  relayerOrigin: 'https://relayer.example',
  validUntilSeconds: 2_000_007_200,
  status: 'active',
  bindingId: 'binding-1',
  bindingHash: BINDING_HASH,
  reasonCodes: [],
  expected: { owner: STELLAR_OWNER, kernelAddress: KERNEL },
  observed: {
    blockNumber: '100',
    blockHash: `0x${'ab'.repeat(32)}`,
    blockTime: 2_000_000_000,
    implementation: '0x0000000000000000000000000000000000000cc3',
    permission: { digest: 'permission-digest' },
    activation: {
      userOpHash: USER_OP_HASH,
      txHash: ACTIVATION_TX_HASH,
      activatedAt: 2_000_000_000,
    },
  },
  checks: {
    chain: true,
    owner: true,
    kernel: true,
    session: true,
    permission: true,
    policy: true,
    binding: true,
    origin: true,
    implementation: true,
    freshness: true,
    reconstruction: true,
    activation: true,
  },
  ...overrides,
})

const intentAck = (jobId = JOB_ID) => ({
  ok: true,
  status: 201,
  json: async () => ({ jobId, acknowledged: true, schemaVersion: 1 }),
})

describe('quantizeAllocations', () => {
  test('quantizes a 100 / 3 split once while preserving display amounts', () => {
    const third = 100 / 3
    const allocations = [
      { pool: '0xAAAA', amount: third, minShares: 1n },
      { pool: '0xBBBB', amount: third, minShares: 1n },
      { pool: '0xCCCC', amount: third, minShares: 1n },
    ]

    const quantized = relayerClient.quantizeAllocations(allocations)

    expect(quantized).not.toBe(allocations)
    expect(quantized.map((a) => a.amount)).toEqual([third, third, third])
    expect(quantized.map((a) => a.amountBaseUnits)).toEqual([33_333_334n, 33_333_333n, 33_333_333n])
    expect(quantized.reduce((sum, a) => sum + a.amountBaseUnits, 0n)).toBe(100_000_000n)
  })

  test('uses the explicit CCTP mint target for one and multiple 0.1234567 allocations', async () => {
    const scenarios = [
      {
        allocations: [
          {
            allocationId: 'run-q:bridge:aave-v3',
            pool: '0xAAAA',
            amount: 0.1234567,
            minShares: 1n,
          },
        ],
        expected: [123_456n],
      },
      {
        allocations: [
          {
            allocationId: 'run-q:bridge:aave-v3',
            pool: '0xAAAA',
            amount: 0.1234567 * 0.5,
            minShares: 1n,
          },
          {
            allocationId: 'run-q:bridge:moonwell',
            pool: '0xBBBB',
            amount: 0.1234567 * 0.3,
            minShares: 1n,
          },
          {
            allocationId: 'run-q:bridge:morpho-blue',
            pool: '0xCCCC',
            amount: 0.1234567 * 0.2,
            minShares: 1n,
          },
        ],
        expected: [61_728n, 37_037n, 24_691n],
      },
    ]

    for (const scenario of scenarios) {
      const quantized = relayerClient.quantizeAllocations(scenario.allocations, {
        targetUnits: 123_456n,
      })
      expect(quantized.map((a) => a.amountBaseUnits)).toEqual(scenario.expected)
      expect(quantized.reduce((sum, a) => sum + a.amountBaseUnits, 0n)).toBe(123_456n)

      const fetchMock = vi.fn(async () => intentAck())
      await postFarm({
        sourceDomain: 27,
        mandateId: MANDATE_ID,
        runId: 'run-q',
        allocations: quantized,
        baseUrl: BASE_URL,
        deps: { fetchImpl: fetchMock },
      })
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.allocations.map((a) => BigInt(a.amount.units))).toEqual(scenario.expected)
    }
  })

  test('strictly rejects an invalid or unusable explicit target', () => {
    const allocations = [{ pool: '0xAAAA', amount: 1, minShares: 1n }]

    for (const targetUnits of [0n, -1n, 1]) {
      expect(() => relayerClient.quantizeAllocations(allocations, { targetUnits })).toThrow(
        /targetUnits.*positive bigint/i
      )
    }
  })
})

describe('postFarm', () => {
  test('CCTP journal status transport sends the stable request ID only in the POST body', async () => {
    const fetchImpl = vi.fn(async () => intentAck())
    await postFarm({
      requestId: '11'.repeat(16),
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      allocations: [],
      deps: { fetchImpl },
    })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/vf-cross/farm')
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      requestId: '11'.repeat(16),
    })
  })
  test('uses the same-origin proxy by default even when local development configured a direct relayer', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      allocations: [],
      deps: { fetchImpl: fetchMock },
    })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/vf-cross/farm')
  })

  test('rejects a noncanonical mandate identity before fetch', async () => {
    const fetchMock = vi.fn()
    await expect(
      postFarm({
        sourceDomain: 27,
        mandateId: `0x${MANDATE_ID}`,
        allocations: [],
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/mandate|identity/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Defect caught: the browser client still allowed a burn hash on the intent-only custody gate.
  test('POSTs intent without a burn field and validates the durable 201 acknowledgement', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 }),
    }))
    const result = await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      stellarOwner: 'GUSER',
      kernelAddress: '0xKERNEL',
      bridgeAgent: 'CBRIDGE',
      runId: 'run-42',
      grantTxHash: 'HGRANT',
      allocations: [
        {
          allocationId: 'run-42:bridge:aave-v3',
          pool: '0xAAAA',
          amount: 100,
          minShares: 99n,
        },
      ],
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).not.toHaveProperty('burnTxHash')
    expect(body.mandateId).toBe(MANDATE_ID)
    expect(body).not.toHaveProperty('serializedApproval')
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin')
  })

  // Defect caught: HTTP success with malformed or stale-schema JSON could incorrectly authorize the burn.
  test.each([
    [
      {
        ok: true,
        status: 200,
        json: async () => ({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 }),
      },
      /201/,
    ],
    [{ ok: true, status: 201, json: async () => ({ jobId: JOB_ID }) }, /acknowledgement/i],
    [
      {
        ok: true,
        status: 201,
        json: async () => ({ jobId: JOB_ID, acknowledged: true, schemaVersion: 2 }),
      },
      /schema/i,
    ],
    [
      {
        ok: true,
        status: 201,
        json: async () => ({ jobId: 'job-1', acknowledged: true, schemaVersion: 1 }),
      },
      /job|acknowledgement/i,
    ],
  ])(
    'rejects an ambiguous durable-intent response before returning a job',
    async (response, expected) => {
      await expect(
        postFarm({
          sourceDomain: 27,
          mandateId: MANDATE_ID,
          allocations: [],
          baseUrl: BASE_URL,
          deps: { fetchImpl: vi.fn(async () => response) },
        })
      ).rejects.toThrow(expected)
    }
  )

  test('POSTs mandate identity and allocations without a burn hash, returns the durable acknowledgement', async () => {
    const fetchMock = vi.fn(async () => intentAck(JOB_ID))
    const result = await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      runId: 'run-42',
      allocations: [
        {
          allocationId: 'run-42:bridge:aave-v3',
          pool: '0xAAAA',
          amount: 100,
          minShares: 99n,
        },
      ],
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual({ jobId: JOB_ID, acknowledged: true, schemaVersion: 1 })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/farm`)
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body).not.toHaveProperty('burnTxHash')
    expect(body.allocations[0].minShares).toBe('99') // BigInt serialized as string over JSON
  })

  // VF Wallet Task 6 wire contract: allocations wrap into {allocationId, poolAddress,
  // amount:{token,units,decimals}}, and the binding/routing fields default to null when the
  // caller doesn't supply them (baseLeg.js/crossChainFarm.js thread them through when known).
  test('builds the {allocationId, poolAddress, amount:{token,units,decimals}} wire shape and forwards binding fields', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      stellarOwner: 'GUSER',
      kernelAddress: '0xKERNEL',
      bridgeAgent: 'CBRIDGE',
      runId: 'run-42',
      grantTxHash: 'HGRANT',
      allocations: [
        {
          allocationId: 'run-42:bridge:aave-v3',
          pool: '0xAAAA',
          amount: 100,
          minShares: 99n,
        },
      ],
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.mandateId).toBe(MANDATE_ID)
    expect(body).not.toHaveProperty('serializedApproval')
    expect(body).not.toHaveProperty('burnTxHash')
    expect(body.stellarOwner).toBe('GUSER')
    expect(body.kernelAddress).toBe('0xKERNEL')
    expect(body.bridgeAgent).toBe('CBRIDGE')
    expect(body.runId).toBe('run-42')
    expect(body.grantTxHash).toBe('HGRANT')
    expect(body.allocations[0]).toEqual({
      allocationId: 'run-42:bridge:aave-v3',
      poolAddress: '0xAAAA',
      amount: { token: 'USDC', units: '100000000', decimals: 6 },
      minShares: '99',
    })
  })

  test('preserves an explicit reviewed allocation ID when optional binding fields are absent', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      allocations: [
        {
          allocationId: 'reviewed-run:bridge:aave-v3',
          pool: '0xAAAA',
          amount: 100,
          minShares: 99n,
        },
      ],
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.stellarOwner).toBeNull()
    expect(body.kernelAddress).toBeNull()
    expect(body.bridgeAgent).toBeNull()
    expect(body.runId).toBeNull()
    expect(body.grantTxHash).toBeNull()
    expect(body.allocations[0].allocationId).toBe('reviewed-run:bridge:aave-v3')
  })

  test('preserves the strategy canonical allocationId instead of rebuilding it from array order', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      runId: 'run-42',
      allocations: [
        {
          allocationId: 'run-42:bridge:morpho-blue',
          pool: '0xAAAA',
          amount: 100,
          minShares: 99n,
        },
      ],
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.allocations[0].allocationId).toBe('run-42:bridge:morpho-blue')
  })

  test('fails before fetch when any Task-5 allocation lacks its reviewed allocationId', async () => {
    const fetchMock = vi.fn()
    await expect(
      postFarm({
        sourceDomain: 27,
        mandateId: MANDATE_ID,
        runId: 'run-42',
        allocations: [{ pool: '0xAAAA', amount: 100, minShares: 99n }],
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/allocationId/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Fix loop 2, Fix 2b: `run-42:bridge:0` (produced by frontend/src/orchestrator.js:1060's
  // `${receiptRunId}:bridge:${index}`) previously passed this check because it only tested
  // .startsWith(`${runId}:bridge:`) — an array-index suffix satisfies a prefix test. The relayer
  // rejects it (relayer/src/httpRouter.mjs:246-262 requires the exact canonical proxy-target
  // string), but only AFTER the CCTP burn already ran. Require the same exact canonical shape
  // here, before the burn's own dispatch ever reaches fetch.
  test('fails before fetch when an allocationId is array-index-shaped instead of a canonical proxy target', async () => {
    const fetchMock = vi.fn()
    await expect(
      postFarm({
        sourceDomain: 27,
        mandateId: MANDATE_ID,
        runId: 'run-42',
        allocations: [
          {
            allocationId: 'run-42:bridge:0',
            pool: '0xAAAA',
            amount: 100,
            minShares: 99n,
          },
        ],
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/allocationId|canonical/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('fails before fetch when an allocationId belongs to a different reviewed run', async () => {
    const fetchMock = vi.fn()
    await expect(
      postFarm({
        sourceDomain: 27,
        mandateId: MANDATE_ID,
        runId: 'run-42',
        allocations: [
          {
            allocationId: 'run-other:bridge:aave-v3',
            pool: '0xAAAA',
            amount: 100,
            minShares: 99n,
          },
        ],
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/run|allocationId/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('preserves canonical allocation IDs verbatim when the input order changes', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    const allocations = [
      {
        allocationId: 'run-42:bridge:aave-v3',
        pool: '0xAAAA',
        amount: 60,
        minShares: 1n,
      },
      {
        allocationId: 'run-42:bridge:moonwell',
        pool: '0xBBBB',
        amount: 40,
        minShares: 1n,
      },
    ]
    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      runId: 'run-42',
      allocations: [...allocations].reverse(),
      deps: { fetchImpl: fetchMock },
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.allocations.map((allocation) => allocation.allocationId)).toEqual([
      'run-42:bridge:moonwell',
      'run-42:bridge:aave-v3',
    ])
  })

  test('throws a clear error on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502 }))
    await expect(
      postFarm({
        sourceDomain: 27,
        mandateId: MANDATE_ID,
        allocations: [],
        baseUrl: BASE_URL,
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/farm dispatch failed \(502\)/)
  })

  // Locks the wire-boundary fix: `a.amount` is a DISPLAY float everywhere upstream (strategist.js's
  // allocateBasePools, the mandate cap in CrossChainFarmFlow.jsx) — the relayer expects base
  // units (relayer/src/httpRouter.mjs parseAllocations does BigInt(a.amount)). A bare float would
  // become dust, and a fractional remainder like 100/3 would throw. serializeAllocations converts
  // at this seam so nothing upstream has to change.
  test('serializes a fractional display-float amount to its base-unit string (6dp)', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    const fractional = 100 / 3 // 33.333333333333336 — a real 3-way split remainder
    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      allocations: [
        {
          allocationId: 'run-f:bridge:aave-v3',
          pool: '0xAAAA',
          amount: fractional,
          minShares: 99n,
        },
      ],
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body)
    // toBaseChainUnits: BigInt(Math.round(fractional * 1e6)) — verified against config.js, not
    // assumed: Math.round(33.333333333333336 * 1e6) === 33333333.
    expect(body.allocations[0].amount.units).toBe('33333333')
  })

  // Regression lock: independent per-pool rounding overshot the bridged total by up to ~1 unit
  // per pool, and the relayer deposits each amount verbatim against a fixed balance — so the last
  // pool's deposit was stranded. Largest-remainder rounding makes the base-unit amounts sum
  // EXACTLY to round(total * 1e6).
  test('multi-pool display floats sum to exactly the bridged base-unit total (largest-remainder)', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    const third = 100 / 3 // three-way split of 100 USDC — 33.333333333333336 each
    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      allocations: [
        { allocationId: 'run-m:bridge:aave-v3', pool: '0xAAAA', amount: third, minShares: 1n },
        { allocationId: 'run-m:bridge:moonwell', pool: '0xBBBB', amount: third, minShares: 1n },
        { allocationId: 'run-m:bridge:morpho-blue', pool: '0xCCCC', amount: third, minShares: 1n },
      ],
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    const [, opts] = fetchMock.mock.calls[0]
    const amounts = JSON.parse(opts.body).allocations.map((a) => BigInt(a.amount.units))
    expect(amounts.reduce((s, x) => s + x, 0n)).toBe(100_000_000n) // exactly the bridged total
    // one pool absorbs the leftover unit, the rest floor — never an overshoot
    expect(amounts.map(String).sort()).toEqual(['33333333', '33333333', '33333334'])
  })

  test('serializes pre-quantized exact units verbatim instead of quantizing display values again', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    const third = 100 / 3
    const quantized = relayerClient.quantizeAllocations([
      { allocationId: 'run-p:bridge:aave-v3', pool: '0xAAAA', amount: third, minShares: 1n },
      { allocationId: 'run-p:bridge:moonwell', pool: '0xBBBB', amount: third, minShares: 1n },
      { allocationId: 'run-p:bridge:morpho-blue', pool: '0xCCCC', amount: third, minShares: 1n },
    ])
    // Deliberately move the remainder to pool 2. If the wire seam quantizes the display values a
    // second time it will move the unit back to pool 1 and this assertion will fail.
    quantized[0].amountBaseUnits -= 1n
    quantized[1].amountBaseUnits += 1n

    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      allocations: quantized,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })

    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.allocations.map((a) => a.amount.units)).toEqual([
      '33333333',
      '33333334',
      '33333333',
    ])
    expect(
      body.allocations.every((a) => !('amountBaseUnits' in a) && !('amountBaseUnits' in a.amount))
    ).toBe(true)
  })

  test('passes a bigint amount through as-is - it is already base units, never re-scaled', async () => {
    const fetchMock = vi.fn(async () => intentAck())
    await postFarm({
      sourceDomain: 27,
      mandateId: MANDATE_ID,
      allocations: [
        {
          allocationId: 'run-b:bridge:aave-v3',
          pool: '0xAAAA',
          amount: 60_000_000n,
          minShares: 99n,
        },
      ],
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.allocations[0].amount).toEqual({ token: 'USDC', units: '60000000', decimals: 6 })
  })
})

describe('pollFarmStatus', () => {
  test('polls until a terminal status, returns the final payload', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      const status = call < 3 ? 'depositing' : 'done'
      return { ok: true, json: async () => farmProjection(status) }
    })
    const result = await pollFarmStatus({
      mandateId: MANDATE_ID,
      jobId: JOB_ID,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock, sleep: vi.fn(async () => {}) },
    })
    expect(result.status).toBe('done')
    expect(call).toBe(3)
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe(`${BASE_URL}/status`)
      expect(options).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      expect(JSON.parse(options.body)).toEqual({ mandateId: MANDATE_ID, jobId: JOB_ID })
    }
  })

  test('gives up after maxTries and returns the last-seen status rather than hanging forever', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'pending' }) }))
    const result = await pollFarmStatus({
      mandateId: MANDATE_ID,
      jobId: JOB_ID,
      baseUrl: BASE_URL,
      maxTries: 3,
      deps: { fetchImpl: fetchMock, sleep: vi.fn(async () => {}) },
    })
    expect(result.status).toBe('pending')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // Production mutation caught: returning the upstream object directly let a nested capability
  // escape even though the top-level status envelope was allowlisted.
  test('rejects poisoned nested farm delivery data rather than returning the upstream object', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'done',
        jobId: JOB_ID,
        mandateId: MANDATE_ID,
        associationDelivery: { complete: true, capability: 'capability-sentinel' },
        evidenceDelivery: { complete: true },
        allocations: [],
      }),
    }))

    await expect(
      pollFarmStatus({
        mandateId: MANDATE_ID,
        jobId: JOB_ID,
        baseUrl: BASE_URL,
        maxTries: 1,
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/farm status response is malformed/i)
  })

  test('rejects poisoned nested child custody data rather than returning raw child evidence', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () =>
        farmProjection('done', {
          allocations: [
            {
              bindingId: 'binding-1',
              executionId: 'run-1:exec:allocation-1',
              allocationId: 'allocation-1',
              childId: JOB_ID,
              userOpHash: USER_OP_HASH,
              mintTxHash: UNWIND_TX_HASH,
              depositTxHash: ACTIVATION_TX_HASH,
              custody: {
                location: 'base',
                confirmed: true,
                checkedAt: 1,
                approval: 'approval-sentinel',
              },
              recoveryVersion: 1,
            },
          ],
        }),
    }))

    await expect(
      pollFarmStatus({
        mandateId: MANDATE_ID,
        jobId: JOB_ID,
        baseUrl: BASE_URL,
        maxTries: 1,
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/farm status response is malformed/i)
  })

  test('rejects job-only use of the farm poller before fetch; unwind uses its strict poller', async () => {
    const fetchMock = vi.fn()
    await expect(
      pollFarmStatus({
        jobId: JOB_ID,
        baseUrl: BASE_URL,
        maxTries: 1,
        deps: { fetchImpl: fetchMock, sleep: vi.fn() },
      })
    ).rejects.toThrow(/mandate|farm/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects a noncanonical status job identity before fetch', async () => {
    const fetchMock = vi.fn()
    await expect(
      pollFarmStatus({
        mandateId: MANDATE_ID,
        jobId: 'job-1',
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/job|identity/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('postFarmAttach', () => {
  test('attaches an observed burn using exact public binding context and no session key', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ jobId: JOB_ID, attached: true }),
    }))
    const result = await postFarmAttach({
      mandateId: MANDATE_ID,
      jobId: JOB_ID,
      burnTxHash: 'burn-observed',
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })

    expect(result).toEqual({ jobId: JOB_ID, attached: true })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/farm/attach`)
    expect(options.credentials).toBe('same-origin')
    expect(JSON.parse(options.body)).toEqual({
      mandateId: MANDATE_ID,
      jobId: JOB_ID,
      burnTxHash: 'burn-observed',
    })
    expect(options.body).not.toMatch(
      /sessionPrivateKey|serializedApproval|capability|authorization/i
    )
  })

  test('rejects a noncanonical attach job identity before fetch', async () => {
    const fetchMock = vi.fn()
    await expect(
      postFarmAttach({
        mandateId: MANDATE_ID,
        jobId: 'job-1',
        burnTxHash: 'burn-observed',
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL,
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/job|identity/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('postMandate', () => {
  test('POSTs one-time capability with activation material once and returns only strict pending metadata', async () => {
    const pending = {
      ok: true,
      status: 'pending_activation',
      mandateId: MANDATE_ID,
      bindingId: 'binding-1',
      bindingHash: BINDING_HASH,
      relayerOrigin: 'https://relayer.example',
    }
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202, json: async () => pending }))
    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
    const result = await postMandate({
      mandateId: MANDATE_ID,
      capability: CAPABILITY,
      serializedApproval: 'approval-blob',
      sessionPrivateKey: '0xSECRETKEY',
      sessionKeyAddress: SESSION,
      expiresAt,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual(pending)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/mandate`)
    expect(opts).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(url).not.toContain(MANDATE_ID)
    expect(url).not.toContain(CAPABILITY)
    expect(JSON.stringify(opts.headers)).not.toContain(CAPABILITY)
    const body = JSON.parse(opts.body)
    expect(body).toEqual({
      mandateId: MANDATE_ID,
      capability: CAPABILITY,
      serializedApproval: 'approval-blob',
      sessionPrivateKey: '0xSECRETKEY',
      sessionKeyAddress: SESSION,
      expiresAt,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
    })
    expect(opts.body.match(new RegExp(CAPABILITY, 'g'))).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('approval-blob')
    expect(JSON.stringify(result)).not.toContain('0xSECRETKEY')
    expect(JSON.stringify(result)).not.toContain(CAPABILITY)
  })

  test('throws a clear error on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400 }))
    await expect(
      postMandate({
        mandateId: MANDATE_ID,
        capability: CAPABILITY,
        serializedApproval: 'approval-blob',
        sessionPrivateKey: '0xSECRETKEY',
        expiresAt: Math.floor(Date.now() / 1000) + 100,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL,
        baseUrl: BASE_URL,
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/mandate registration failed/i)
  })
})

describe('postMandateRevoke', () => {
  test('POSTs the mandate identity and owner binding without JavaScript bearer material', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    const result = await postMandateRevoke({
      mandateId: MANDATE_ID,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual({ ok: true })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/mandate/revoke`)
    expect(opts).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(opts.body)).toEqual({
      mandateId: MANDATE_ID,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
    })
    expect(`${url}${opts.body}${JSON.stringify(opts.headers)}`).not.toMatch(
      /serializedApproval|capability|authorization/i
    )
  })

  test('throws a clear error on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403 }))
    await expect(
      postMandateRevoke({
        mandateId: MANDATE_ID,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL,
        baseUrl: BASE_URL,
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/mandate revoke failed \(403\)/)
  })
})

describe('getMandateStatus', () => {
  const canonical = verifiedActive()

  test('POSTs an amount-free identity to a fixed path with no IDs or authority in the URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => canonical,
    }))
    await getMandateStatus(MANDATE_ID, {
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/mandate/status`)
    expect(url).not.toMatch(/\?|11{4}|approval|allocation|pool|amount|minShares/i)
    expect(options).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    expect(JSON.parse(options.body)).toEqual({
      mandateId: MANDATE_ID,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
    })
  })

  test('normalizes a canonical v3 response without adding caller-forged status facts', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => canonical,
    }))
    const result = await getMandateStatus(MANDATE_ID, {
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      allocation: { amount: 'must-not-cross' },
      expectedOwner: 'GFORGED',
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual(canonical)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/mandate/status`)
    expect(JSON.parse(options.body)).toEqual({
      mandateId: MANDATE_ID,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
    })
  })

  test('normalizes a canonical BaseMandateStatusV3 response through untouched', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => canonical }))
    const result = await getMandateStatus(MANDATE_ID, {
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual(canonical)
  })

  test('fails legacy {valid, expiresAt} responses closed as unknown evidence', async () => {
    const fetchTrue = vi.fn(async () => ({
      ok: true,
      json: async () => ({ valid: true, expiresAt: 999 }),
    }))
    const active = await getMandateStatus(MANDATE_ID, {
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchTrue },
    })
    expect(active).toEqual({
      version: 3,
      status: 'unknown',
      reasonCodes: ['EVIDENCE_MISSING'],
      expected: {},
      observed: {},
      checks: {},
    })

    const fetchFalse = vi.fn(async () => ({ ok: true, json: async () => ({ valid: false }) }))
    const unknown = await getMandateStatus(MANDATE_ID, {
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchFalse },
    })
    expect(unknown.status).toBe('unknown') // fails closed the same as expired/missing/mismatched
  })

  test('scrubs accidental key material from nested evidence', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...canonical,
        sessionPrivateKey: '0xLEAK',
        observed: { ...canonical.observed, sessionKeyMaterial: '0xLEAK2' },
      }),
    }))
    const result = await getMandateStatus(MANDATE_ID, {
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    expect(JSON.stringify(result)).not.toContain('0xLEAK')
    expect(result.status).toBe('active')
  })

  test('ignores allocation and client-forged expected facts at the amount-free boundary', async () => {
    const allocation = {
      allocationId: 'run-1:bridge:aave-v3',
      poolAddress: '0xPOOL',
      amount: { token: 'USDC', units: '123', decimals: 6 },
      minShares: '100',
    }
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => canonical }))
    await getMandateStatus(MANDATE_ID, {
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      allocation,
      expectedOwner: 'GFORGED',
      expectedChainId: 1,
      baseUrl: BASE_URL,
      deps: { fetchImpl: fetchMock },
    })
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/mandate/status`)
    expect(JSON.parse(options.body)).toEqual({
      mandateId: MANDATE_ID,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
    })
  })

  test('throws a clear error on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }))
    await expect(
      getMandateStatus(MANDATE_ID, {
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL,
        baseUrl: BASE_URL,
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/mandate status check failed \(500\)/)
  })
})

describe('v3 mandate activation client', () => {
  const registration = (overrides = {}) => ({
    mandateId: MANDATE_ID,
    capability: CAPABILITY,
    serializedApproval: 'approval-secret-sentinel',
    sessionPrivateKey: 'private-key-sentinel',
    sessionKeyAddress: SESSION,
    expiresAt: 2_000_007_200,
    stellarOwner: STELLAR_OWNER,
    kernelAddress: KERNEL,
    baseUrl: BASE_URL,
    ...overrides,
  })
  const pendingResponse = (overrides = {}) => ({
    ok: true,
    status: 'pending_activation',
    mandateId: MANDATE_ID,
    bindingId: 'binding-1',
    bindingHash: BINDING_HASH,
    relayerOrigin: 'https://relayer.example',
    ...overrides,
  })

  test.each([
    ['uppercase mandate ID', { mandateId: 'AA'.repeat(16) }],
    ['short mandate ID', { mandateId: MANDATE_ID.slice(2) }],
    ['non-hex mandate ID', { mandateId: `z${MANDATE_ID.slice(1)}` }],
    ['prefixed mandate ID', { mandateId: `0x${MANDATE_ID}` }],
    ['whitespace-padded mandate ID', { mandateId: ` ${MANDATE_ID}` }],
    ['missing mandate ID', { mandateId: undefined }],
    ['uppercase capability', { capability: 'BB'.repeat(32) }],
    ['short capability', { capability: CAPABILITY.slice(2) }],
    ['non-hex capability', { capability: `z${CAPABILITY.slice(1)}` }],
    ['prefixed capability', { capability: `0x${CAPABILITY}` }],
    ['whitespace-padded capability', { capability: `${CAPABILITY} ` }],
    ['missing capability', { capability: undefined }],
  ])('rejects a noncanonical %s before fetch', async (_label, overrides) => {
    const fetchImpl = vi.fn()
    await expect(postMandate({ ...registration(overrides), deps: { fetchImpl } })).rejects.toThrow(
      /mandate registration/i
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test.each([
    ['non-202 response', 200, pendingResponse()],
    ['wrong lifecycle', 202, pendingResponse({ status: 'active' })],
    ['missing success flag', 202, pendingResponse({ ok: undefined })],
    ['false success flag', 202, pendingResponse({ ok: false })],
    ['non-object body', 202, null],
    ['array body', 202, [pendingResponse()]],
    ['different mandate ID', 202, pendingResponse({ mandateId: OTHER_ID })],
    ['wrong mandate ID type', 202, pendingResponse({ mandateId: 11 })],
    ['noncanonical mandate ID', 202, pendingResponse({ mandateId: 'AA'.repeat(16) })],
    ['missing binding ID', 202, pendingResponse({ bindingId: undefined })],
    ['empty binding ID', 202, pendingResponse({ bindingId: '' })],
    ['wrong binding ID type', 202, pendingResponse({ bindingId: 1 })],
    ['missing binding hash', 202, pendingResponse({ bindingHash: undefined })],
    ['noncanonical binding hash', 202, pendingResponse({ bindingHash: 'binding-hash-1' })],
    ['wrong binding hash type', 202, pendingResponse({ bindingHash: 1 })],
    ['missing relayer origin', 202, pendingResponse({ relayerOrigin: undefined })],
    ['malformed relayer origin', 202, pendingResponse({ relayerOrigin: 'not-an-origin' })],
    ['wrong relayer origin type', 202, pendingResponse({ relayerOrigin: 1 })],
    ['echoed capability', 202, pendingResponse({ capability: CAPABILITY })],
    ['echoed approval', 202, pendingResponse({ serializedApproval: 'approval-secret-sentinel' })],
    ['echoed private key', 202, pendingResponse({ sessionPrivateKey: 'private-key-sentinel' })],
    ['unexpected field', 202, pendingResponse({ extra: 'not-in-the-response-contract' })],
    [
      'nested secret field',
      202,
      pendingResponse({
        nested: { capability: CAPABILITY, authorization: `Bearer ${CAPABILITY}` },
      }),
    ],
  ])('rejects a %s without returning registration secrets', async (_label, status, body) => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status, json: async () => body }))
    let error
    try {
      await postMandate({ ...registration(), deps: { fetchImpl } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String(error?.message)).toMatch(/mandate registration/i)
    expect(String(error?.message)).not.toMatch(
      /approval-secret-sentinel|private-key-sentinel|22222222|Bearer|Cookie/i
    )
  })

  test('scrubs a malformed registration JSON failure that contains handled secrets', async () => {
    const poison = `approval-secret-sentinel private-key-sentinel ${CAPABILITY} Bearer Cookie`
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => {
        throw new Error(poison)
      },
    }))
    let error
    try {
      await postMandate({ ...registration(), deps: { fetchImpl } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String(error?.message)).toMatch(/mandate registration/i)
    expect(String(error?.message)).not.toMatch(
      /approval-secret-sentinel|private-key-sentinel|22222222|Bearer|Cookie/i
    )
  })

  test('polls pending activation to verified active with a fixed identity and bounded sleeps', async () => {
    const statuses = [
      {
        version: 3,
        status: 'pending_activation',
        reasonCodes: [],
        expected: {},
        observed: {},
        checks: {},
      },
      {
        version: 3,
        status: 'pending_activation',
        reasonCodes: [],
        expected: {},
        observed: {},
        checks: {},
      },
      verifiedActive(),
    ]
    const trace = []
    const getStatus = vi.fn(async (mandateId, identity) => {
      trace.push(['status', mandateId, identity.stellarOwner, identity.kernelAddress])
      return statuses.shift()
    })
    const sleep = vi.fn(async (ms) => trace.push(['sleep', ms]))

    const result = await relayerClient.waitForMandateActivation({
      mandateId: MANDATE_ID,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      intervalMs: 17,
      maxTries: 3,
      deps: { getMandateStatus: getStatus, sleep },
    })

    expect(result).toEqual(verifiedActive())
    expect(trace).toEqual([
      ['status', MANDATE_ID, STELLAR_OWNER, KERNEL],
      ['sleep', 17],
      ['status', MANDATE_ID, STELLAR_OWNER, KERNEL],
      ['sleep', 17],
      ['status', MANDATE_ID, STELLAR_OWNER, KERNEL],
    ])
  })

  test.each(['activation_uncertain', 'revoked', 'expired', 'mismatch', 'unknown'])(
    'stops after one %s status without sleeping',
    async (status) => {
      const getStatus = vi.fn(async () => ({
        version: 3,
        status,
        reasonCodes: [`PUBLIC_${status.toUpperCase()}`],
        expected: {},
        observed: {},
        checks: {},
      }))
      const sleep = vi.fn()
      await expect(
        relayerClient.waitForMandateActivation({
          mandateId: MANDATE_ID,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL,
          deps: { getMandateStatus: getStatus, sleep },
        })
      ).rejects.toThrow(new RegExp(status))
      expect(getStatus).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  )

  test('bounds perpetual pending polling and rejects invalid retry controls before a read', async () => {
    const pending = {
      version: 3,
      status: 'pending_activation',
      reasonCodes: [],
      expected: {},
      observed: {},
      checks: {},
    }
    const getStatus = vi.fn(async () => pending)
    const sleep = vi.fn(async () => {})
    await expect(
      relayerClient.waitForMandateActivation({
        mandateId: MANDATE_ID,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL,
        intervalMs: 9,
        maxTries: 3,
        deps: { getMandateStatus: getStatus, sleep },
      })
    ).rejects.toThrow(/timed out/i)
    expect(getStatus).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)

    for (const controls of [
      { maxTries: 0 },
      { maxTries: -1 },
      { maxTries: 1.5 },
      { maxTries: '3' },
      { intervalMs: 0 },
      { intervalMs: -1 },
      { intervalMs: Number.NaN },
    ]) {
      const before = getStatus.mock.calls.length
      await expect(
        relayerClient.waitForMandateActivation({
          mandateId: MANDATE_ID,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL,
          deps: { getMandateStatus: getStatus, sleep },
          ...controls,
        })
      ).rejects.toThrow(/activation|poll|interval|tries/i)
      expect(getStatus).toHaveBeenCalledTimes(before)
    }
  })

  test('retries a 429 rate-limited status read as still pending without aborting the ceremony', async () => {
    const rateLimited = Object.assign(new Error('mandate status check failed (429)'), {
      status: 429,
    })
    const statuses = [rateLimited, verifiedActive()]
    const trace = []
    const getStatus = vi.fn(async () => {
      trace.push('status')
      const next = statuses.shift()
      if (next instanceof Error) throw next
      return next
    })
    const sleep = vi.fn(async (ms) => trace.push(['sleep', ms]))

    const result = await relayerClient.waitForMandateActivation({
      mandateId: MANDATE_ID,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL,
      intervalMs: 11,
      maxTries: 3,
      deps: { getMandateStatus: getStatus, sleep },
    })

    expect(result).toEqual(verifiedActive())
    expect(trace).toEqual(['status', ['sleep', 11], 'status'])
  })

  test.each([400, 401, 403, 500])(
    'stops fail-closed after one non-429 status read failure (%i) without sleeping',
    async (statusCode) => {
      const failure = Object.assign(new Error(`mandate status check failed (${statusCode})`), {
        status: statusCode,
      })
      const getStatus = vi.fn(async () => {
        throw failure
      })
      const sleep = vi.fn()
      await expect(
        relayerClient.waitForMandateActivation({
          mandateId: MANDATE_ID,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL,
          deps: { getMandateStatus: getStatus, sleep },
        })
      ).rejects.toThrow(/mandate status check failed/i)
      expect(getStatus).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  )

  test('bounds perpetual 429 polling instead of retrying a rate limit forever', async () => {
    const rateLimited = Object.assign(new Error('mandate status check failed (429)'), {
      status: 429,
    })
    const getStatus = vi.fn(async () => {
      throw rateLimited
    })
    const sleep = vi.fn(async () => {})
    await expect(
      relayerClient.waitForMandateActivation({
        mandateId: MANDATE_ID,
        stellarOwner: STELLAR_OWNER,
        kernelAddress: KERNEL,
        intervalMs: 7,
        maxTries: 3,
        deps: { getMandateStatus: getStatus, sleep },
      })
    ).rejects.toThrow(/timed out/i)
    expect(getStatus).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  test('scrubs dependency failures after registration handled raw secrets', async () => {
    const poison = `approval-secret-sentinel private-key-sentinel ${CAPABILITY} Bearer Cookie`
    const fetchImpl = vi.fn(async () => {
      throw new Error(poison)
    })
    let error
    try {
      await postMandate({ ...registration(), deps: { fetchImpl } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String(error?.message)).toMatch(/mandate registration/i)
    expect(String(error?.message)).not.toContain(poison)
    expect(String(error?.message)).not.toContain(CAPABILITY)
  })
})

describe('durable unwind client', () => {
  function deterministicCrypto() {
    const buffers = []
    let call = 0
    return {
      buffers,
      getRandomValues: vi.fn((bytes) => {
        buffers.push(bytes)
        bytes.fill(call++ === 0 ? 0x55 : 0x22)
        return bytes
      }),
    }
  }

  test('CSPRNG-reserves before signing with exact one-shot capability body and returns no authority', async () => {
    const cryptoImpl = deterministicCrypto()
    const fetchImpl = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body)
      expect(body).toEqual({
        jobId: JOB_ID,
        capability: CAPABILITY,
        kernelAddress: KERNEL,
        recipientHint: STELLAR_RECIPIENT,
      })
      return {
        ok: true,
        status: 202,
        json: async () => ({ jobId: JOB_ID, status: 'awaiting_burn' }),
      }
    })

    const result = await reserveUnwind({
      kernelAddress: KERNEL,
      recipientHint: STELLAR_RECIPIENT,
      baseUrl: BASE_URL,
      deps: { fetchImpl, cryptoImpl },
    })

    expect(result).toEqual({ jobId: JOB_ID, status: 'awaiting_burn' })
    expect(JSON.stringify(result)).not.toContain(CAPABILITY)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/unwind`)
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(cryptoImpl.getRandomValues).toHaveBeenCalledTimes(2)
    expect([...cryptoImpl.buffers[1]]).toEqual(Array(32).fill(0))
  })

  test('accepts a checksummed ZeroDev Kernel address and binds its canonical lowercase form', async () => {
    const cryptoImpl = deterministicCrypto()
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(JSON.parse(options.body).kernelAddress).toBe(CHECKSUMMED_KERNEL.toLowerCase())
      return {
        ok: true,
        status: 202,
        json: async () => ({ jobId: JOB_ID, status: 'awaiting_burn' }),
      }
    })

    await reserveUnwind({
      kernelAddress: CHECKSUMMED_KERNEL,
      recipientHint: STELLAR_RECIPIENT,
      deps: { fetchImpl, cryptoImpl },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test.each([
    [
      'non-202',
      { ok: true, status: 200, json: async () => ({ jobId: JOB_ID, status: 'awaiting_burn' }) },
    ],
    [
      'wrong job',
      { ok: true, status: 202, json: async () => ({ jobId: OTHER_ID, status: 'awaiting_burn' }) },
    ],
    [
      'wrong lifecycle',
      { ok: true, status: 202, json: async () => ({ jobId: JOB_ID, status: 'relay_pending' }) },
    ],
    [
      'echoed capability',
      {
        ok: true,
        status: 202,
        json: async () => ({ jobId: JOB_ID, status: 'awaiting_burn', capability: CAPABILITY }),
      },
    ],
  ])(
    'rejects a malformed reserve acknowledgement (%s) and erases capability bytes',
    async (_label, response) => {
      const cryptoImpl = deterministicCrypto()
      await expect(
        reserveUnwind({
          kernelAddress: KERNEL,
          recipientHint: STELLAR_RECIPIENT,
          deps: { fetchImpl: vi.fn(async () => response), cryptoImpl },
        })
      ).rejects.toThrow(/unwind reservation/i)
      expect([...cryptoImpl.buffers[1]]).toEqual(Array(32).fill(0))
    }
  )

  test('scrubs a transport failure that contains raw capability authority', async () => {
    const cryptoImpl = deterministicCrypto()
    let error
    try {
      await reserveUnwind({
        kernelAddress: KERNEL,
        recipientHint: STELLAR_RECIPIENT,
        deps: {
          cryptoImpl,
          fetchImpl: vi.fn(async () => {
            throw new Error(`poison ${CAPABILITY}`)
          }),
        },
      })
    } catch (caught) {
      error = caught
    }
    expect(error?.message).toMatch(/unwind reservation/i)
    expect(error?.message).not.toContain(CAPABILITY)
    expect([...cryptoImpl.buffers[1]]).toEqual(Array(32).fill(0))
  })

  test('attaches only the reserved identity and canonical receipt hashes with same-origin credentials', async () => {
    const projection = { jobId: JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH }
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 202, json: async () => projection }))
    const result = await postUnwindAttach({
      jobId: JOB_ID,
      userOpHash: USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
      deps: { fetchImpl },
    })
    expect(result).toEqual(projection)
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/unwind/attach`)
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(options.body)).toEqual({
      jobId: JOB_ID,
      userOpHash: USER_OP_HASH,
      unwindTxHash: UNWIND_TX_HASH,
    })
    expect(options.body).not.toMatch(/owner|burned|recipient|hook|message|capability/i)
  })

  test.each([
    [
      'extra response field',
      { jobId: JOB_ID, status: 'relay_pending', unwindTxHash: UNWIND_TX_HASH, internal: 'secret' },
    ],
    ['wrong hash', { jobId: JOB_ID, status: 'relay_pending', unwindTxHash: USER_OP_HASH }],
    ['wrong status', { jobId: JOB_ID, status: 'done', unwindTxHash: UNWIND_TX_HASH }],
  ])('rejects a non-strict attach acknowledgement: %s', async (_label, body) => {
    await expect(
      postUnwindAttach({
        jobId: JOB_ID,
        userOpHash: USER_OP_HASH,
        unwindTxHash: UNWIND_TX_HASH,
        deps: { fetchImpl: vi.fn(async () => ({ ok: true, status: 202, json: async () => body })) },
      })
    ).rejects.toThrow(/unwind attach/i)
  })

  test.each(['relay_running', 'done', 'blocked', 'uncertain'])(
    'accepts an idempotent attach retry that returns the current strict %s projection',
    async (status) => {
      const projection = unwindProjection(status)
      await expect(
        postUnwindAttach({
          jobId: JOB_ID,
          userOpHash: USER_OP_HASH,
          unwindTxHash: UNWIND_TX_HASH,
          deps: {
            fetchImpl: vi.fn(async () => ({
              ok: true,
              status: 202,
              json: async () => projection,
            })),
          },
        })
      ).resolves.toEqual(projection)
    }
  )

  test.each(['done', 'blocked', 'uncertain', 'expired'])(
    'polls job-only status to terminal unwind status %s using a strict public DTO',
    async (terminal) => {
      let call = 0
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          call++ === 0 ? unwindProjection('relay_running') : unwindProjection(terminal),
      }))
      const result = await pollUnwindStatus({
        jobId: JOB_ID,
        intervalMs: 1,
        maxTries: 2,
        deps: { fetchImpl, sleep: vi.fn(async () => {}) },
      })
      expect(result.status).toBe(terminal)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      for (const [url, options] of fetchImpl.mock.calls) {
        expect(url).toBe(`${BASE_URL}/status`)
        expect(options).toMatchObject({
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
        })
        expect(JSON.parse(options.body)).toEqual({ jobId: JOB_ID })
      }
    }
  )

  test.each([
    ['blocked before proof', { jobId: JOB_ID, status: 'blocked', reasonCode: BLOCKED_REASON }],
    [
      'uncertain before proof',
      { jobId: JOB_ID, status: 'uncertain', reasonCode: UNCERTAIN_REASON },
    ],
    [
      'blocked after proof',
      {
        jobId: JOB_ID,
        status: 'blocked',
        unwindTxHash: UNWIND_TX_HASH,
        reasonCode: BLOCKED_REASON,
      },
    ],
    [
      'blocked with a retained mint submission hash',
      {
        jobId: JOB_ID,
        status: 'blocked',
        mintTxHash: MINT_TX_HASH,
        reasonCode: BLOCKED_REASON,
      },
    ],
    [
      'blocked with retained unwind and mint hashes',
      {
        jobId: JOB_ID,
        status: 'blocked',
        unwindTxHash: UNWIND_TX_HASH,
        mintTxHash: MINT_TX_HASH,
        reasonCode: BLOCKED_REASON,
      },
    ],
    [
      'uncertain after proof',
      {
        jobId: JOB_ID,
        status: 'uncertain',
        unwindTxHash: UNWIND_TX_HASH,
        reasonCode: UNCERTAIN_REASON,
      },
    ],
    [
      'uncertain with a retained mint submission hash before proof projection',
      {
        jobId: JOB_ID,
        status: 'uncertain',
        mintTxHash: MINT_TX_HASH,
        reasonCode: UNCERTAIN_REASON,
      },
    ],
    [
      'uncertain with retained unwind and mint hashes',
      {
        jobId: JOB_ID,
        status: 'uncertain',
        unwindTxHash: UNWIND_TX_HASH,
        mintTxHash: MINT_TX_HASH,
        reasonCode: UNCERTAIN_REASON,
      },
    ],
  ])('accepts the exact terminal projection variant: %s', async (_label, projection) => {
    await expect(
      pollUnwindStatus({
        jobId: JOB_ID,
        maxTries: 1,
        deps: {
          fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => projection })),
        },
      })
    ).resolves.toEqual(projection)
  })

  test('accepts a running projection with its canonical mint-submission checkpoint', async () => {
    const running = { ...unwindProjection('relay_running'), mintTxHash: MINT_TX_HASH }
    const done = unwindProjection('done')
    let call = 0

    await expect(
      pollUnwindStatus({
        jobId: JOB_ID,
        intervalMs: 1,
        maxTries: 2,
        deps: {
          fetchImpl: vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => (call++ === 0 ? running : done),
          })),
          sleep: vi.fn(async () => {}),
        },
      })
    ).resolves.toEqual(done)
  })

  test.each([
    ['unknown reason', { ...unwindProjection('blocked'), reasonCode: 'made_up_reason' }],
    ['reason on running', { ...unwindProjection('relay_running'), reasonCode: BLOCKED_REASON }],
    ['missing done mint', { jobId: JOB_ID, status: 'done', unwindTxHash: UNWIND_TX_HASH }],
    ['hash on expired', { jobId: JOB_ID, status: 'expired', unwindTxHash: UNWIND_TX_HASH }],
    [
      'null unwind hash',
      { jobId: JOB_ID, status: 'blocked', unwindTxHash: null, reasonCode: BLOCKED_REASON },
    ],
    [
      'null uncertain mint hash',
      { jobId: JOB_ID, status: 'uncertain', mintTxHash: null, reasonCode: UNCERTAIN_REASON },
    ],
    [
      'malformed uncertain mint hash',
      {
        jobId: JOB_ID,
        status: 'uncertain',
        mintTxHash: `0x${MINT_TX_HASH}`,
        reasonCode: UNCERTAIN_REASON,
      },
    ],
    ['mint hash on pending', { ...unwindProjection('relay_pending'), mintTxHash: MINT_TX_HASH }],
    ['null running mint hash', { ...unwindProjection('relay_running'), mintTxHash: null }],
  ])('rejects malformed state-bound status projection: %s', async (_label, projection) => {
    await expect(
      pollUnwindStatus({
        jobId: JOB_ID,
        maxTries: 1,
        deps: {
          fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => projection })),
        },
      })
    ).rejects.toThrow(/unwind status/i)
  })

  test('requires exact HTTP 200 for status instead of accepting another successful lifecycle', async () => {
    await expect(
      pollUnwindStatus({
        jobId: JOB_ID,
        maxTries: 1,
        deps: {
          fetchImpl: vi.fn(async () => ({
            ok: true,
            status: 202,
            json: async () => unwindProjection('relay_pending'),
          })),
        },
      })
    ).rejects.toThrow(/unwind status/i)
  })

  test('scrubs status transport diagnostics before returning them to UI code', async () => {
    const poison = `private-cookie ${CAPABILITY}`
    let error
    try {
      await pollUnwindStatus({
        jobId: JOB_ID,
        maxTries: 1,
        deps: {
          fetchImpl: vi.fn(async () => {
            throw new Error(poison)
          }),
        },
      })
    } catch (caught) {
      error = caught
    }
    expect(error?.message).toMatch(/unwind status/i)
    expect(error?.message).not.toContain(poison)
    expect(error?.message).not.toContain(CAPABILITY)
  })
})

describe('same-origin capability transport', () => {
  const crossOrigin = 'https://direct-relayer.example/api/vf-cross'
  const deterministicCrossOriginCrypto = { getRandomValues: vi.fn() }

  test.each([
    ['backslash authority', '/\\evil.example'],
    ['scheme-relative authority', '//evil.example/api/vf-cross'],
    ['tab-normalized authority', '/\tevil.example'],
    ['newline-normalized authority', '/\nevil.example'],
    ['wrong proxy pathname', '/api/vf-cross/../other'],
    ['query-bearing proxy pathname', '/api/vf-cross?capability=poison'],
  ])('rejects %s before unwind capability generation or fetch', async (_label, baseUrl) => {
    const fetchImpl = vi.fn()
    const cryptoImpl = { getRandomValues: vi.fn() }

    await expect(
      reserveUnwind({
        kernelAddress: KERNEL,
        recipientHint: STELLAR_RECIPIENT,
        baseUrl,
        deps: { fetchImpl, cryptoImpl },
      })
    ).rejects.toThrow(/same-origin|proxy/i)

    expect(cryptoImpl.getRandomValues).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('ignores a cross-origin VITE relayer override for the default protected client', async () => {
    vi.stubEnv('VITE_CROSS_RELAYER_BASE', crossOrigin)
    vi.resetModules()
    try {
      const freshClient = await import('./relayerClient.js')
      const fetchImpl = vi.fn(async () => intentAck())
      await freshClient.postFarm({
        requestId: JOB_ID,
        sourceDomain: 27,
        mandateId: MANDATE_ID,
        allocations: [],
        deps: { fetchImpl },
      })
      expect(fetchImpl.mock.calls[0][0]).toBe('/api/vf-cross/farm')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  test.each([
    [
      'farm intent',
      (fetchImpl) =>
        postFarm({
          sourceDomain: 27,
          mandateId: MANDATE_ID,
          allocations: [],
          baseUrl: crossOrigin,
          deps: { fetchImpl },
        }),
    ],
    [
      'farm attach',
      (fetchImpl) =>
        postFarmAttach({
          mandateId: MANDATE_ID,
          jobId: JOB_ID,
          burnTxHash: 'burn-observed',
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL,
          baseUrl: crossOrigin,
          deps: { fetchImpl },
        }),
    ],
    [
      'farm status',
      (fetchImpl) =>
        pollFarmStatus({
          mandateId: MANDATE_ID,
          jobId: JOB_ID,
          baseUrl: crossOrigin,
          deps: { fetchImpl },
        }),
    ],
    [
      'mandate registration',
      (fetchImpl) =>
        postMandate({
          mandateId: MANDATE_ID,
          capability: CAPABILITY,
          serializedApproval: 'approval-secret-sentinel',
          sessionPrivateKey: 'private-key-sentinel',
          sessionKeyAddress: SESSION,
          expiresAt: 2_000_007_200,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL,
          baseUrl: crossOrigin,
          deps: { fetchImpl },
        }),
    ],
    [
      'mandate status',
      (fetchImpl) =>
        getMandateStatus(MANDATE_ID, {
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL,
          baseUrl: crossOrigin,
          deps: { fetchImpl },
        }),
    ],
    [
      'mandate revoke',
      (fetchImpl) =>
        postMandateRevoke({
          mandateId: MANDATE_ID,
          stellarOwner: STELLAR_OWNER,
          kernelAddress: KERNEL,
          baseUrl: crossOrigin,
          deps: { fetchImpl },
        }),
    ],
    [
      'unwind reserve',
      (fetchImpl) =>
        reserveUnwind({
          kernelAddress: KERNEL,
          recipientHint: STELLAR_RECIPIENT,
          baseUrl: crossOrigin,
          deps: { fetchImpl, cryptoImpl: deterministicCrossOriginCrypto },
        }),
    ],
  ])('rejects a direct cross-origin base URL before %s fetch', async (_label, call) => {
    const fetchImpl = vi.fn()
    await expect(call(fetchImpl)).rejects.toThrow(/same-origin|proxy/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
