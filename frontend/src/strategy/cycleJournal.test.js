// frontend/src/strategy/cycleJournal.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveCycle, getCycles, clearCycles, getJournalSummary } from './cycleJournal.js'

describe('cycleJournal', () => {
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

// Pocket Crew "My money" Task 8: owner+network-scoped forms. The legacy single-argument calls
// above must keep working unchanged (never assigned to whichever wallet connects first) — these
// cover the NEW scoped forms only.
describe('cycleJournal — owner+network scoped (Pocket Crew Task 8)', () => {
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
    })
  })

  it('saves and reads back scoped to owner+network, newest-first', () => {
    saveCycle('GOWNER', { cycle: 1, phase: 'execute', verdict: 'keep' }, { network: 'stellar-testnet' })
    saveCycle('GOWNER', { cycle: 2, phase: 'crash', verdict: 'crash' }, { network: 'stellar-testnet' })
    const rows = getCycles('GOWNER', { network: 'stellar-testnet' })
    expect(rows).toHaveLength(2)
    expect(rows[0].verdict).toBe('crash')
    expect(rows[1].verdict).toBe('keep')
  })

  it('never reuses journal history across wallets', () => {
    saveCycle('GOWNER_A', { cycle: 1, verdict: 'keep' }, { network: 'stellar-testnet' })
    expect(getCycles('GOWNER_B', { network: 'stellar-testnet' })).toEqual([])
  })

  it('never reuses journal history across networks for the same owner', () => {
    saveCycle('GOWNER', { cycle: 1, verdict: 'keep' }, { network: 'stellar-testnet' })
    expect(getCycles('GOWNER', { network: 'stellar-mainnet' })).toEqual([])
  })

  it('does not leak into or read from the legacy unowned bucket', () => {
    saveCycle({ cycle: 1, verdict: 'keep' }) // legacy call — hidden bucket
    expect(getCycles('GOWNER', { network: 'stellar-testnet' })).toEqual([])
    saveCycle('GOWNER', { cycle: 2, verdict: 'discard' }, { network: 'stellar-testnet' })
    expect(getCycles()).toHaveLength(1) // legacy bucket still only has its own row
  })

  it('drops a scoped write with no owner — never guesses whose journal it is', () => {
    saveCycle(null, { cycle: 1, verdict: 'keep' }, { network: 'stellar-testnet' })
    expect(getCycles('GOWNER', { network: 'stellar-testnet' })).toEqual([])
  })

  it('returns [] for a scoped read with no owner', () => {
    expect(getCycles(null, { network: 'stellar-testnet' })).toEqual([])
  })

  it('clearCycles(owner, {network}) empties only that bucket', () => {
    saveCycle('GOWNER', { cycle: 1, verdict: 'keep' }, { network: 'stellar-testnet' })
    saveCycle('OTHER', { cycle: 1, verdict: 'keep' }, { network: 'stellar-testnet' })
    clearCycles('GOWNER', { network: 'stellar-testnet' })
    expect(getCycles('GOWNER', { network: 'stellar-testnet' })).toEqual([])
    expect(getCycles('OTHER', { network: 'stellar-testnet' })).toHaveLength(1)
  })

  // Fix 6 (minor, review loop 1): a caller passing a not-yet-loaded owner (explicitly `undefined`,
  // e.g. before a wallet connects) must never be treated as the zero-arg LEGACY call — that would
  // read or wipe the hidden, unowned journal from inside what was meant to be a wallet-scoped call.
  it('does not fall through to the legacy bucket when owner is explicitly undefined (not omitted)', () => {
    saveCycle({ cycle: 1, verdict: 'keep' }) // real legacy write
    expect(getCycles(undefined, { network: 'stellar-testnet' })).toEqual([])
    clearCycles(undefined, { network: 'stellar-testnet' }) // must not wipe the legacy bucket
    expect(getCycles()).toHaveLength(1)
  })

  // Fix 6 (minor, review loop 1): missing network must drop the write, matching riskWatchStore's
  // policy — never invent an 'unknown' bucket that merges every network-less write for one owner
  // (Stellar G-addresses are identical across testnet and mainnet).
  it('drops a scoped write with no network — never invents a shared "unknown" bucket', () => {
    saveCycle('GOWNER', { cycle: 1, verdict: 'keep' }) // no {network} at all — must be a true no-op
    expect(getCycles('GOWNER', {})).toEqual([])
    expect(getCycles('GOWNER', { network: 'stellar-testnet' })).toEqual([])
  })

  it('returns [] for a scoped read with no network', () => {
    saveCycle('GOWNER', { cycle: 1, verdict: 'keep' }, { network: 'stellar-testnet' })
    expect(getCycles('GOWNER', {})).toEqual([])
  })

  // Fix 4 (minor, review loop 2): the write side of the same arity bug the read side already
  // hardened above (`does not fall through to the legacy bucket when owner is explicitly
  // undefined`). `row === undefined` cannot distinguish a true legacy call (`saveCycle(row)`, 1
  // argument) from a scoped call whose row just hasn't loaded yet (`saveCycle(owner, undefined,
  // { network })`, 3 arguments) — the latter used to fall through and write a string-spread
  // record (`{...'GOWNER'}` -> `{0:'G',1:'O',...}`) into the unowned legacy bucket.
  it('never falls through to the legacy bucket when the scoped row is explicitly undefined', () => {
    saveCycle({ cycle: 1, verdict: 'keep' }) // baseline real legacy write
    saveCycle('GOWNER', undefined, { network: 'stellar-testnet' }) // not-yet-loaded row, owner known
    const legacyRows = getCycles()
    expect(legacyRows).toHaveLength(1) // untouched by the scoped call
    expect(legacyRows[0]).not.toHaveProperty('0') // never the string-spread artifact
  })
})

describe('getJournalSummary gated count', () => {
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
