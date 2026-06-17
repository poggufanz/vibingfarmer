// frontend/src/strategy/cycleJournal.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveCycle, getCycles, clearCycles, getJournalSummary } from './cycleJournal.js'

describe('cycleJournal', () => {
  beforeEach(() => {
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
  })

  it('appends a cycle and reads it back newest-first', () => {
    saveCycle({ cycle: 1, phase: 'execute', verdict: 'keep', score: 8.2 })
    saveCycle({ cycle: 2, phase: 'crash', verdict: 'crash', error: 'rpc down' })
    const rows = getCycles()
    expect(rows).toHaveLength(2)
    expect(rows[0].verdict).toBe('crash')
    expect(rows[1].verdict).toBe('keep')
    expect(typeof rows[0].ts).toBe('number')
  })

  it('caps at 100 rows, pruning oldest', () => {
    for (let i = 1; i <= 130; i++) saveCycle({ cycle: i, phase: 'observe', verdict: 'idle' })
    const rows = getCycles()
    expect(rows).toHaveLength(100)
    expect(rows[0].cycle).toBe(130)
    expect(rows[99].cycle).toBe(31)
  })

  it('summary counts verdicts and reports last cycle', () => {
    saveCycle({ cycle: 1, phase: 'execute', verdict: 'keep' })
    saveCycle({ cycle: 2, phase: 'evaluate', verdict: 'discard' })
    saveCycle({ cycle: 3, phase: 'crash', verdict: 'crash', error: 'x' })
    const s = getJournalSummary()
    expect(s).toEqual({ total: 3, keep: 1, discard: 1, gated: 0, crash: 1, idle: 0, lastCycle: 3 })
  })

  it('never throws on corrupt storage', () => {
    localStorage.setItem('yv_cycle_journal', 'not json')
    expect(getCycles()).toEqual([])
    expect(() => saveCycle({ cycle: 1, phase: 'observe', verdict: 'idle' })).not.toThrow()
  })

  it('clearCycles empties the store', () => {
    saveCycle({ cycle: 1, phase: 'observe', verdict: 'idle' })
    clearCycles()
    expect(getCycles()).toEqual([])
  })
})

describe('getJournalSummary gated count', () => {
  beforeEach(() => {
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
  })

  it('counts gated cycles', () => {
    clearCycles()
    saveCycle({ cycle: 1, verdict: 'gated', gate: 'turbulence' })
    saveCycle({ cycle: 2, verdict: 'keep' })
    saveCycle({ cycle: 3, verdict: 'gated', gate: 'gas' })
    const s = getJournalSummary()
    expect(s.gated).toBe(2)
    expect(s.keep).toBe(1)
  })
})