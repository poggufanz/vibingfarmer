// frontend/src/base/relayerClient.test.js
import { describe, test, expect, vi } from 'vitest'
import * as relayerClient from './relayerClient.js'

const { postFarm, pollFarmStatus, postUnwind, postMandate, getMandateStatus } = relayerClient

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
        allocations: [{ pool: '0xAAAA', amount: 0.1234567, minShares: 1n }],
        expected: [123_456n],
      },
      {
        allocations: [
          { pool: '0xAAAA', amount: 0.1234567 * 0.5, minShares: 1n },
          { pool: '0xBBBB', amount: 0.1234567 * 0.3, minShares: 1n },
          { pool: '0xCCCC', amount: 0.1234567 * 0.2, minShares: 1n },
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

      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ jobId: 'job-1' }) }))
      await postFarm({
        burnTxHash: 'burn-precision',
        sourceDomain: 27,
        serializedApproval: 'approval-blob',
        allocations: quantized,
        baseUrl: 'https://example.test/api/vf-cross',
        deps: { fetchImpl: fetchMock },
      })
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.allocations.map((a) => BigInt(a.amount))).toEqual(scenario.expected)
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
  test('POSTs the burn hash + approval + allocations, returns the jobId', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ jobId: 'job-123' }),
    }))
    const result = await postFarm({
      burnTxHash: 'abcd',
      sourceDomain: 27,
      serializedApproval: 'approval-blob',
      allocations: [{ pool: '0xAAAA', amount: 100, minShares: 99n }],
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual({ jobId: 'job-123' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.test/api/vf-cross/farm')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.burnTxHash).toBe('abcd')
    expect(body.allocations[0].minShares).toBe('99') // BigInt serialized as string over JSON
  })

  test('throws a clear error on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502 }))
    await expect(
      postFarm({
        burnTxHash: 'x',
        sourceDomain: 27,
        serializedApproval: 'a',
        allocations: [],
        baseUrl: 'https://example.test/api/vf-cross',
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
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ jobId: 'job-1' }) }))
    const fractional = 100 / 3 // 33.333333333333336 — a real 3-way split remainder
    await postFarm({
      burnTxHash: 'abcd',
      sourceDomain: 27,
      serializedApproval: 'approval-blob',
      allocations: [{ pool: '0xAAAA', amount: fractional, minShares: 99n }],
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body)
    // toBaseChainUnits: BigInt(Math.round(fractional * 1e6)) — verified against config.js, not
    // assumed: Math.round(33.333333333333336 * 1e6) === 33333333.
    expect(body.allocations[0].amount).toBe('33333333')
  })

  // Regression lock: independent per-pool rounding overshot the bridged total by up to ~1 unit
  // per pool, and the relayer deposits each amount verbatim against a fixed balance — so the last
  // pool's deposit was stranded. Largest-remainder rounding makes the base-unit amounts sum
  // EXACTLY to round(total * 1e6).
  test('multi-pool display floats sum to exactly the bridged base-unit total (largest-remainder)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ jobId: 'job-1' }) }))
    const third = 100 / 3 // three-way split of 100 USDC — 33.333333333333336 each
    await postFarm({
      burnTxHash: 'abcd',
      sourceDomain: 27,
      serializedApproval: 'approval-blob',
      allocations: [
        { pool: '0xAAAA', amount: third, minShares: 1n },
        { pool: '0xBBBB', amount: third, minShares: 1n },
        { pool: '0xCCCC', amount: third, minShares: 1n },
      ],
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    const [, opts] = fetchMock.mock.calls[0]
    const amounts = JSON.parse(opts.body).allocations.map((a) => BigInt(a.amount))
    expect(amounts.reduce((s, x) => s + x, 0n)).toBe(100_000_000n) // exactly the bridged total
    // one pool absorbs the leftover unit, the rest floor — never an overshoot
    expect(amounts.map(String).sort()).toEqual(['33333333', '33333333', '33333334'])
  })

  test('serializes pre-quantized exact units verbatim instead of quantizing display values again', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ jobId: 'job-1' }) }))
    const third = 100 / 3
    const quantized = relayerClient.quantizeAllocations([
      { pool: '0xAAAA', amount: third, minShares: 1n },
      { pool: '0xBBBB', amount: third, minShares: 1n },
      { pool: '0xCCCC', amount: third, minShares: 1n },
    ])
    // Deliberately move the remainder to pool 2. If the wire seam quantizes the display values a
    // second time it will move the unit back to pool 1 and this assertion will fail.
    quantized[0].amountBaseUnits -= 1n
    quantized[1].amountBaseUnits += 1n

    await postFarm({
      burnTxHash: 'abcd',
      sourceDomain: 27,
      serializedApproval: 'approval-blob',
      allocations: quantized,
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })

    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.allocations.map((a) => a.amount)).toEqual(['33333333', '33333334', '33333333'])
    expect(body.allocations.every((a) => !('amountBaseUnits' in a))).toBe(true)
  })

  test('passes a bigint amount through as-is - it is already base units, never re-scaled', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ jobId: 'job-1' }) }))
    await postFarm({
      burnTxHash: 'abcd',
      sourceDomain: 27,
      serializedApproval: 'approval-blob',
      allocations: [{ pool: '0xAAAA', amount: 60_000_000n, minShares: 99n }],
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    const [, opts] = fetchMock.mock.calls[0]
    const body = JSON.parse(opts.body)
    expect(body.allocations[0].amount).toBe('60000000')
  })
})

describe('pollFarmStatus', () => {
  test('polls until a terminal status, returns the final payload', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      const status = call < 3 ? 'depositing' : 'done'
      return { ok: true, json: async () => ({ status, steps: { call } }) }
    })
    const result = await pollFarmStatus({
      jobId: 'job-123',
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock, sleep: vi.fn(async () => {}) },
    })
    expect(result.status).toBe('done')
    expect(call).toBe(3)
  })

  test('gives up after maxTries and returns the last-seen status rather than hanging forever', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'pending' }) }))
    const result = await pollFarmStatus({
      jobId: 'job-123',
      baseUrl: 'https://example.test/api/vf-cross',
      maxTries: 3,
      deps: { fetchImpl: fetchMock, sleep: vi.fn(async () => {}) },
    })
    expect(result.status).toBe('pending')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('postMandate', () => {
  test('POSTs the serializedApproval + sessionPrivateKey + expiry once, returns {ok: true}', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
    const result = await postMandate({
      serializedApproval: 'approval-blob',
      sessionPrivateKey: '0xSECRETKEY',
      expiry,
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.test/api/vf-cross/mandate')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({
      serializedApproval: 'approval-blob',
      sessionPrivateKey: '0xSECRETKEY',
      expiry,
    })
  })

  test('throws a clear error on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400 }))
    await expect(
      postMandate({
        serializedApproval: 'approval-blob',
        sessionPrivateKey: '0xSECRETKEY',
        expiry: Math.floor(Date.now() / 1000) + 100,
        baseUrl: 'https://example.test/api/vf-cross',
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/mandate registration failed \(400\)/)
  })
})

describe('getMandateStatus', () => {
  test('GETs /mandate/valid with the approval urlencoded as a query param, returns {valid, expiresAt}', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ valid: true, expiresAt: 1234567890000 }),
    }))
    const result = await getMandateStatus('approval blob/with+special=chars', {
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual({ valid: true, expiresAt: 1234567890000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(
      'https://example.test/api/vf-cross/mandate/valid?approval=' +
        encodeURIComponent('approval blob/with+special=chars')
    )
  })

  test('never leaks key material — the relayer response shape has no key field, and the client just passes it through', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ valid: true, expiresAt: 999 }),
    }))
    const result = await getMandateStatus('approval-blob', {
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'valid'])
  })

  test('throws a clear error on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }))
    await expect(
      getMandateStatus('approval-blob', {
        baseUrl: 'https://example.test/api/vf-cross',
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/mandate status check failed \(500\)/)
  })
})

describe('postUnwind', () => {
  test('POSTs the withdrawal batch tx hash + destination for the relayer to pick up', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ jobId: 'unwind-1' }) }))
    const result = await postUnwind({
      unwindTxHash: '0xdead',
      stellarRecipient: 'GRECIPIENT',
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual({ jobId: 'unwind-1' })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.test/api/vf-cross/unwind')
  })
})
