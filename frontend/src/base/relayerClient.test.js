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
