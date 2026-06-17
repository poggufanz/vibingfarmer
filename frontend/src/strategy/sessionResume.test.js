// sessionResume.test.js — wizard resume snapshot persisted per wallet address.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveResume, loadResume, clearResume } from './sessionResume.js'

const ADDR = '0xAbC0000000000000000000000000000000000001'
const STRATEGY = {
  agents: [{ id: 'worker-1', vault: { addr: '0xVault', name: 'A', apy: '4.8' }, allocation: 100 }],
  total: 100,
  blendedApy: '4.8',
}

beforeEach(() => {
  const store = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
  })
})

describe('sessionResume', () => {
  it('round-trips a snapshot for an address', () => {
    saveResume(ADDR, { stage: 'done', amount: '100', risk: 'med', strategy: STRATEGY })
    const snap = loadResume(ADDR)
    expect(snap.stage).toBe('done')
    expect(snap.amount).toBe('100')
    expect(snap.risk).toBe('med')
    expect(snap.strategy.agents).toHaveLength(1)
  })

  it('is case-insensitive on address', () => {
    saveResume(ADDR.toLowerCase(), { stage: 'done', amount: '50', risk: 'low', strategy: STRATEGY })
    expect(loadResume(ADDR.toUpperCase())?.amount).toBe('50')
  })

  it('returns null when nothing is stored', () => {
    expect(loadResume(ADDR)).toBeNull()
  })

  it('does NOT persist a snapshot without strategy agents (nothing to resume)', () => {
    saveResume(ADDR, { stage: 'done', amount: '100', risk: 'med', strategy: { agents: [] } })
    expect(loadResume(ADDR)).toBeNull()
  })

  it('returns null and self-heals on corrupt JSON', () => {
    localStorage.setItem('yv_resume_' + ADDR.toLowerCase(), '{ not json')
    expect(loadResume(ADDR)).toBeNull()
    // corrupt entry dropped
    expect(localStorage.getItem('yv_resume_' + ADDR.toLowerCase())).toBeNull()
  })

  it('clears a stored snapshot', () => {
    saveResume(ADDR, { stage: 'done', amount: '100', risk: 'med', strategy: STRATEGY })
    clearResume(ADDR)
    expect(loadResume(ADDR)).toBeNull()
  })

  it('no-ops safely on missing address', () => {
    expect(() => saveResume(null, { strategy: STRATEGY })).not.toThrow()
    expect(loadResume(null)).toBeNull()
    expect(() => clearResume(undefined)).not.toThrow()
  })
})
