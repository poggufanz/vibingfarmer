// frontend/src/base/relayerClient.test.js
import { describe, test, expect, vi } from 'vitest'
import { postFarm, pollFarmStatus, postUnwind, postMandate } from './relayerClient.js'

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

  test('passes a bigint amount through as-is — it is already base units, never re-scaled', async () => {
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
  test('POSTs the serializedApproval + sessionPrivateKey once, returns {ok: true}', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    const result = await postMandate({
      serializedApproval: 'approval-blob',
      sessionPrivateKey: '0xSECRETKEY',
      baseUrl: 'https://example.test/api/vf-cross',
      deps: { fetchImpl: fetchMock },
    })
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.test/api/vf-cross/mandate')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ serializedApproval: 'approval-blob', sessionPrivateKey: '0xSECRETKEY' })
  })

  test('throws a clear error on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400 }))
    await expect(
      postMandate({
        serializedApproval: 'approval-blob',
        sessionPrivateKey: '0xSECRETKEY',
        baseUrl: 'https://example.test/api/vf-cross',
        deps: { fetchImpl: fetchMock },
      })
    ).rejects.toThrow(/mandate registration failed \(400\)/)
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
