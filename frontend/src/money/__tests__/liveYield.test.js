// frontend/src/money/__tests__/liveYield.test.js
// G2 follow-up: the production yield loader — live Blend APR in, fail-soft view-model out.
// The APR read and the series load are always injected mocks here; app.jsx wires the real
// readSupplyAprBps + loadPpsSeries once (covered by that file's own structural test).
import { describe, it, expect, vi } from 'vitest'
import { loadLiveYield } from '../liveYield.js'

const NOW = 1_700_000_000_000
const SERIES = [
  { t: NOW - 7 * 24 * 3600 * 1000, pps: '10000000' },
  { t: NOW, pps: '10010000' },
]

function load(overrides = {}, depOverrides = {}) {
  return loadLiveYield({
    nowMs: NOW,
    deps: {
      readApr: vi.fn(async () => 416),
      loadSeries: vi.fn(() => SERIES),
      ...depOverrides,
    },
    ...overrides,
  })
}

describe('loadLiveYield — live APR plus the local series', () => {
  it('converts bps to percent and stamps the read time', async () => {
    const deps = { readApr: vi.fn(async () => 416), loadSeries: vi.fn(() => SERIES) }
    const view = await loadLiveYield({ nowMs: NOW, deps })
    expect(deps.readApr).toHaveBeenCalledTimes(1)
    expect(view.liveApr).toEqual({ state: 'live', aprPct: 4.16, asOf: NOW })
    expect(view.series).toBe(SERIES)
  })
})

describe('loadLiveYield — fail-soft, never a fake percent', () => {
  it('a null APR read resolves to unavailable with the series intact', async () => {
    const view = await load({}, { readApr: async () => null })
    expect(view.liveApr).toEqual({ state: 'unavailable', aprPct: null, asOf: null })
    expect(view.series).toBe(SERIES)
  })

  it('a throwing APR read resolves to unavailable, never rejects', async () => {
    const view = await load({}, { readApr: async () => { throw new Error('rpc down') } })
    expect(view.liveApr.state).toBe('unavailable')
  })

  it('a non-numeric or negative APR resolves to unavailable', async () => {
    for (const bad of ['4.16', NaN, -1, Infinity]) {
      const view = await load({}, { readApr: async () => bad })
      expect(view.liveApr, `bps=${String(bad)}`).toEqual({
        state: 'unavailable',
        aprPct: null,
        asOf: null,
      })
    }
  })

  it('a hostile series loader degrades to [], never throws', async () => {
    const view = await load({}, { loadSeries: () => { throw new Error('no storage') } })
    expect(view.series).toEqual([])
    expect(view.liveApr.state).toBe('live')
  })
})
