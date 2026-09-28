// frontend/src/history/__tests__/apyHistory.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApyHistory, fetchApyHistoryBatch, _test } from '../apyHistory.js'

const ok = (data) => ({ ok: true, json: async () => ({ data }) })

describe('fetchApyHistory cache gate', () => {
  beforeEach(() => _test.clear())

  it('fetches once per pool per TTL window, refetches after expiry', async () => {
    const f = vi.fn(async () => ok([{ apy: 1 }]))
    const g = globalThis.fetch
    globalThis.fetch = f
    try {
      await fetchApyHistory('pool-1')
      await fetchApyHistory('pool-1')
      expect(f).toHaveBeenCalledOnce()
    } finally {
      globalThis.fetch = g
    }
  })

  it('dedupes concurrent same-key fetches into one network call', async () => {
    let calls = 0
    const g = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return ok([{ apy: 2 }])
    })
    try {
      const [a, b] = await Promise.all([fetchApyHistory('pool-x'), fetchApyHistory('pool-x')])
      expect(a).toEqual([{ apy: 2 }])
      expect(b).toEqual([{ apy: 2 }])
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = g
    }
  })

  it('never throws and never caches failures', async () => {
    const g = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({ ok: false }))
    try {
      expect(await fetchApyHistory('pool-bad')).toBeNull()
    } finally {
      globalThis.fetch = g
    }
    const f2 = vi.fn(async () => ok([{ apy: 3 }]))
    globalThis.fetch = f2
    try {
      expect(await fetchApyHistory('pool-bad')).toEqual([{ apy: 3 }])
      expect(f2).toHaveBeenCalledOnce()
    } finally {
      globalThis.fetch = g
    }
  })

  it('batch drops null entries and returns the rest keyed by pool', async () => {
    const g = globalThis.fetch
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes('good') ? ok([{ apy: 5 }]) : { ok: false }
    )
    try {
      const out = await fetchApyHistoryBatch(['good-1', 'bad-1'])
      expect(out).toEqual({ 'good-1': [{ apy: 5 }] })
    } finally {
      globalThis.fetch = g
    }
  })

  it('returns null for an empty poolId without fetching', async () => {
    const f = vi.fn()
    const g = globalThis.fetch
    globalThis.fetch = f
    try {
      expect(await fetchApyHistory('')).toBeNull()
      expect(f).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = g
    }
  })
})
