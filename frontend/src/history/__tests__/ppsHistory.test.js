// frontend/src/history/__tests__/ppsHistory.test.js
// P0 #2: the local PPS series behind the KeeperZone trailing-APY sparkline.
// Every persistence edge is covered: throttle, cap, age-prune, corrupt storage,
// throwing storage, null reads — the poll loop must never break and the series must
// never grow without bound.
import { describe, it, expect } from 'vitest'
import {
  loadPpsSeries,
  recordPpsSample,
  selectPpsWindow,
  trailingApyPct,
  ppsDisplayValues,
  PPS_SCALE,
} from '../ppsHistory.js'

const VAULT = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 2_000_000_000_000

function memStorage(seed = {}) {
  const mem = new Map(Object.entries(seed))
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  }
}

const throwingStorage = () => ({
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('quota')
  },
  removeItem: () => {
    throw new Error('blocked')
  },
})

describe('recordPpsSample', () => {
  it('appends a sample and round-trips through storage as strings', () => {
    const storage = memStorage()
    const out = recordPpsSample(VAULT, 10_234_000n, { storage, now: () => NOW })
    expect(out).toEqual([{ t: NOW, pps: '10234000' }])
    expect(loadPpsSeries(VAULT, { storage })).toEqual([{ t: NOW, pps: '10234000' }])
  })

  it('throttles samples inside the minimum interval (poll ticks faster than this)', () => {
    const storage = memStorage()
    recordPpsSample(VAULT, 10_000_000n, { storage, now: () => NOW })
    const out = recordPpsSample(VAULT, 10_000_001n, { storage, now: () => NOW + 60_000 })
    expect(out).toHaveLength(1)
    expect(out[0].pps).toBe('10000000')
  })

  it('accepts the next sample once the interval elapses', () => {
    const storage = memStorage()
    recordPpsSample(VAULT, 10_000_000n, { storage, now: () => NOW })
    const out = recordPpsSample(VAULT, 10_000_001n, {
      storage,
      now: () => NOW + 15 * 60 * 1000,
    })
    expect(out).toHaveLength(2)
  })

  it('skips null, zero, and garbage reads without touching the series', () => {
    const storage = memStorage()
    recordPpsSample(VAULT, 10_000_000n, { storage, now: () => NOW })
    for (const bad of [null, undefined, 0n, -5n, 'nope']) {
      const out = recordPpsSample(VAULT, bad, { storage, now: () => NOW + 3600_000 })
      expect(out).toHaveLength(1)
    }
  })

  it('caps the series at maxSamples, dropping the oldest first', () => {
    const storage = memStorage()
    let out = []
    for (let i = 0; i < 5; i++) {
      out = recordPpsSample(VAULT, 10_000_000n + BigInt(i), {
        storage,
        now: () => NOW + i * 3600_000,
        minIntervalMs: 0,
        maxSamples: 3,
      })
    }
    expect(out).toHaveLength(3)
    expect(out.map((s) => s.pps)).toEqual(['10000002', '10000003', '10000004'])
  })

  it('prunes samples older than the max age window', () => {
    const storage = memStorage()
    recordPpsSample(VAULT, 10_000_000n, { storage, now: () => NOW - 40 * DAY_MS, minIntervalMs: 0 })
    const out = recordPpsSample(VAULT, 10_000_001n, { storage, now: () => NOW, minIntervalMs: 0 })
    expect(out).toEqual([{ t: NOW, pps: '10000001' }])
  })

  it('never throws when storage itself throws (private-mode browsers)', () => {
    const storage = throwingStorage()
    expect(() => recordPpsSample(VAULT, 10_000_000n, { storage, now: () => NOW })).not.toThrow()
    expect(loadPpsSeries(VAULT, { storage })).toEqual([])
  })

  it('returns [] for corrupt or non-array payloads', () => {
    const key = `vf_pps_history_v1:${VAULT}`
    expect(loadPpsSeries(VAULT, { storage: memStorage({ [key]: 'not-json{' }) })).toEqual([])
    expect(loadPpsSeries(VAULT, { storage: memStorage({ [key]: '{"t":1}' }) })).toEqual([])
    expect(
      loadPpsSeries(VAULT, {
        storage: memStorage({
          [key]: JSON.stringify([
            { t: 'x', pps: '10' },
            { t: 1, pps: '-3' },
          ]),
        }),
      })
    ).toEqual([])
  })
})

describe('selectPpsWindow', () => {
  const series = [
    { t: NOW - 20 * DAY_MS, pps: '10000000' },
    { t: NOW - 5 * DAY_MS, pps: '10050000' },
    { t: NOW, pps: '10100000' },
  ]

  it('selects the trailing 7-day and 30-day windows', () => {
    expect(selectPpsWindow(series, { days: 7, now: NOW })).toHaveLength(2)
    expect(selectPpsWindow(series, { days: 30, now: NOW })).toHaveLength(3)
  })

  it('returns [] for a non-array series', () => {
    expect(selectPpsWindow(null, { days: 7, now: NOW })).toEqual([])
  })
})

describe('trailingApyPct', () => {
  it('annualizes a doubled share price over exactly one year to 100%', () => {
    const series = [
      { t: NOW - 365 * DAY_MS, pps: '10000000' },
      { t: NOW, pps: '20000000' },
    ]
    expect(trailingApyPct(series, { days: 400, now: NOW })).toBeCloseTo(100, 9)
  })

  it('annualizes +5% over one year to 5%', () => {
    const series = [
      { t: NOW - 365 * DAY_MS, pps: '10000000' },
      { t: NOW, pps: '10500000' },
    ]
    expect(trailingApyPct(series, { days: 400, now: NOW })).toBeCloseTo(5, 9)
  })

  it('compounds sub-year growth (CAGR, not linear extrapolation)', () => {
    // +1% in 36.5 days annualizes to (1.01^10 - 1) = 10.4622…%
    const series = [
      { t: NOW - Math.round(36.5 * DAY_MS), pps: '10000000' },
      { t: NOW, pps: '10100000' },
    ]
    expect(trailingApyPct(series, { days: 60, now: NOW })).toBeCloseTo(10.4622, 3)
  })

  it('returns null when the window cannot support an honest annualization', () => {
    expect(trailingApyPct([], { days: 30, now: NOW })).toBeNull()
    expect(trailingApyPct([{ t: NOW, pps: '10000000' }], { days: 30, now: NOW })).toBeNull()
    // zero span (same timestamp twice) — annualizing would divide by zero
    const sameTs = [
      { t: NOW, pps: '10000000' },
      { t: NOW, pps: '10000001' },
    ]
    expect(trailingApyPct(sameTs, { days: 30, now: NOW })).toBeNull()
  })
})

describe('ppsDisplayValues', () => {
  it('converts 7dp base units to display numbers and drops bad entries', () => {
    expect(ppsDisplayValues([{ pps: '10234000' }])).toEqual([1.0234])
    expect(ppsDisplayValues([{ pps: 'xx' }, null, { pps: '10000000' }])).toEqual([1])
    expect(ppsDisplayValues(null)).toEqual([])
  })

  it('uses the vault PPS scale (1e7), not the token display scale', () => {
    expect(PPS_SCALE).toBe(10_000_000)
  })
})
