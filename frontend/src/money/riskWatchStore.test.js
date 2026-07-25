// frontend/src/money/riskWatchStore.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { recordRecommendation, getRecommendations, clearRecommendations } from './riskWatchStore.js'

function stubStorage() {
  const store = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
  })
  return store
}

describe('riskWatchStore', () => {
  beforeEach(() => {
    stubStorage()
  })

  it('records a recommendation and reads it back newest-first, scoped to network+owner', () => {
    recordRecommendation('stellar-testnet', 'GOWNER', { kind: 'facts-check', source: 'defillama' }, { now: 1 })
    recordRecommendation('stellar-testnet', 'GOWNER', { kind: 'security-scan', source: 'tavily' }, { now: 2 })
    const rows = getRecommendations('stellar-testnet', 'GOWNER')
    expect(rows).toHaveLength(2)
    expect(rows[0].kind).toBe('security-scan')
    expect(rows[1].kind).toBe('facts-check')
  })

  it('tags every recorded row as local scope ("This device")', () => {
    recordRecommendation('stellar-testnet', 'GOWNER', { kind: 'facts-check' }, { now: 1 })
    expect(getRecommendations('stellar-testnet', 'GOWNER')[0].scope).toBe('local')
  })

  it('never reuses history across wallets — a different owner sees nothing', () => {
    recordRecommendation('stellar-testnet', 'GOWNER_A', { kind: 'facts-check' }, { now: 1 })
    expect(getRecommendations('stellar-testnet', 'GOWNER_B')).toEqual([])
  })

  it('never reuses history across networks for the same owner', () => {
    recordRecommendation('stellar-testnet', 'GOWNER', { kind: 'facts-check' }, { now: 1 })
    expect(getRecommendations('stellar-mainnet', 'GOWNER')).toEqual([])
  })

  it('drops writes with no owner or no network — never a shared/legacy bucket', () => {
    recordRecommendation('stellar-testnet', null, { kind: 'facts-check' })
    recordRecommendation(null, 'GOWNER', { kind: 'facts-check' })
    expect(getRecommendations('stellar-testnet', 'GOWNER')).toEqual([])
  })

  it('returns [] for a read with no owner or no network', () => {
    expect(getRecommendations('stellar-testnet', null)).toEqual([])
    expect(getRecommendations(null, 'GOWNER')).toEqual([])
  })

  it('caps at 100 rows, pruning oldest', () => {
    for (let i = 1; i <= 130; i++) {
      recordRecommendation('stellar-testnet', 'GOWNER', { kind: 'facts-check', seq: i }, { now: i })
    }
    const rows = getRecommendations('stellar-testnet', 'GOWNER')
    expect(rows).toHaveLength(100)
    expect(rows[0].seq).toBe(130)
    expect(rows[99].seq).toBe(31)
  })

  it('never throws on corrupt storage', () => {
    localStorage.setItem('yv_risk_watch:stellar-testnet:GOWNER', 'not json')
    expect(getRecommendations('stellar-testnet', 'GOWNER')).toEqual([])
    expect(() =>
      recordRecommendation('stellar-testnet', 'GOWNER', { kind: 'facts-check' })
    ).not.toThrow()
  })

  it('clearRecommendations empties only that owner+network bucket', () => {
    recordRecommendation('stellar-testnet', 'GOWNER', { kind: 'facts-check' }, { now: 1 })
    recordRecommendation('stellar-testnet', 'OTHER', { kind: 'facts-check' }, { now: 1 })
    clearRecommendations('stellar-testnet', 'GOWNER')
    expect(getRecommendations('stellar-testnet', 'GOWNER')).toEqual([])
    expect(getRecommendations('stellar-testnet', 'OTHER')).toHaveLength(1)
  })

  it('exposes no execution capability — the store module has exactly the three storage exports', async () => {
    const mod = await import('./riskWatchStore.js')
    expect(Object.keys(mod).sort()).toEqual(
      ['clearRecommendations', 'getRecommendations', 'recordRecommendation'].sort()
    )
  })
})
