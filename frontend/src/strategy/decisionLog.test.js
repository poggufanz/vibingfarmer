// frontend/src/strategy/decisionLog.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { accSummary } from './decisionLog.js'

describe('accSummary', () => {
  it('uses the first concern when present, with cited rules', () => {
    expect(
      accSummary({
        signal: 'WITHDRAW',
        citedRules: ['risk-turbulent-veto'],
        concerns: ['turbulent market'],
      })
    ).toBe('WITHDRAW: Turbulent market (risk-turbulent-veto)')
  })

  it('falls back to a positive phrase when no concerns', () => {
    expect(accSummary({ signal: 'DEPOSIT', citedRules: ['yield-uplift'], concerns: [] })).toBe(
      'DEPOSIT: Clear to proceed (yield-uplift)'
    )
  })

  it('omits the rules suffix when no cited rules', () => {
    expect(accSummary({ signal: 'HOLD', citedRules: [], concerns: [] })).toBe('HOLD: Hold')
  })

  it('tolerates missing arrays', () => {
    expect(accSummary({ signal: 'DEPOSIT' })).toBe('DEPOSIT: Clear to proceed')
  })
})

import { buildDecisionRecord } from './decisionLog.js'

const verdict = (over = {}) => ({
  verdict: 'keep',
  reason: null,
  confidence: 0.69,
  resolvedBy: 'weighted',
  citedRules: ['yield-uplift', 'risk-calm-clear'],
  specialists: [
    {
      role: 'yield',
      signal: 'DEPOSIT',
      confidence: 0.78,
      citedRules: ['yield-uplift'],
      concerns: [],
    },
    {
      role: 'risk',
      signal: 'DEPOSIT',
      confidence: 0.6,
      citedRules: ['risk-calm-clear'],
      concerns: [],
    },
    {
      role: 'market',
      signal: 'HOLD',
      confidence: 0.7,
      citedRules: ['market-gas-negative'],
      concerns: ['gas exceeds expected gain'],
    },
  ],
  ...over,
})

describe('buildDecisionRecord', () => {
  const ctx = () => ({
    cycle: 42,
    idea: { kind: 'rebalance', vaultName: 'Aave USDC', apyGain: 1.4 },
    state: { market: { turbulence: 'calm' } },
    verdict: verdict(),
  })

  it('maps council output to the EvoDS schema', () => {
    const r = buildDecisionRecord(ctx())
    expect(r).toMatchObject({
      cycle: 42,
      action: { kind: 'rebalance', vault: 'Aave USDC', apyGain: 1.4 },
      turbulence: 'calm',
      majoritySignal: 'DEPOSIT',
      majorityCount: 2,
      finalDecision: 'keep',
      resolvedBy: 'weighted',
      reason: null,
      citedRules: ['yield-uplift', 'risk-calm-clear'],
    })
  })

  it('computes a stable id from cycle + ts', () => {
    const r = buildDecisionRecord(ctx())
    expect(r.id).toBe(`c42-${r.ts}`)
    expect(typeof r.ts).toBe('number')
  })

  it('attaches an ACC summary to every specialist verdict', () => {
    const r = buildDecisionRecord(ctx())
    expect(r.verdicts).toHaveLength(3)
    expect(r.verdicts[2]).toEqual({
      role: 'market',
      signal: 'HOLD',
      confidence: 0.7,
      summary: 'HOLD: Gas exceeds expected gain (market-gas-negative)',
    })
  })

  it('avgConfidence is the mean confidence of the majority-signal specialists', () => {
    const r = buildDecisionRecord(ctx())
    expect(r.avgConfidence).toBeCloseTo(0.69, 3) // (0.78 + 0.6) / 2
  })

  it('records when the council vetoes against the majority (finalDecision != majoritySignal)', () => {
    const v = verdict({
      verdict: 'discard',
      reason: 'Risk Analyst',
      resolvedBy: 'veto',
      citedRules: ['risk-turbulent-veto'],
      specialists: [
        {
          role: 'yield',
          signal: 'DEPOSIT',
          confidence: 0.8,
          citedRules: ['yield-uplift'],
          concerns: [],
        },
        {
          role: 'risk',
          signal: 'WITHDRAW',
          confidence: 0.9,
          citedRules: ['risk-turbulent-veto'],
          concerns: ['turbulent market'],
        },
        {
          role: 'market',
          signal: 'DEPOSIT',
          confidence: 0.8,
          citedRules: ['market-gas-positive'],
          concerns: [],
        },
      ],
    })
    const r = buildDecisionRecord({
      cycle: 7,
      idea: { kind: 'harvest' },
      state: { market: { turbulence: 'turbulent' } },
      verdict: v,
    })
    expect(r.majoritySignal).toBe('DEPOSIT')
    expect(r.majorityCount).toBe(2)
    expect(r.finalDecision).toBe('discard')
    expect(r.resolvedBy).toBe('veto')
  })

  it('applies defensive defaults on a missing idea', () => {
    const r = buildDecisionRecord({ cycle: 1, idea: undefined, state: {}, verdict: verdict() })
    expect(r.action).toEqual({ kind: 'unknown', vault: null, apyGain: null })
    expect(r.turbulence).toBe('unknown')
  })
})

import { recordDecision, getDecisions, clearDecisions, getDecisionSummary } from './decisionLog.js'

describe('decisionLog store', () => {
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

  const ctxFor = (cycle, signal) => ({
    cycle,
    idea: { kind: 'rebalance', vaultName: 'V' },
    state: { market: { turbulence: 'calm' } },
    verdict: {
      verdict: signal === 'DEPOSIT' ? 'keep' : 'discard',
      resolvedBy: 'unanimous',
      reason: null,
      citedRules: [],
      specialists: [
        { role: 'yield', signal, confidence: 0.7, citedRules: [], concerns: [] },
        { role: 'risk', signal, confidence: 0.7, citedRules: [], concerns: [] },
        { role: 'market', signal, confidence: 0.7, citedRules: [], concerns: [] },
      ],
    },
  })

  it('records a decision and reads it back newest-first', () => {
    recordDecision(ctxFor(1, 'DEPOSIT'))
    recordDecision(ctxFor(2, 'HOLD'))
    const rows = getDecisions()
    expect(rows).toHaveLength(2)
    expect(rows[0].cycle).toBe(2)
    expect(rows[0].finalDecision).toBe('discard')
    expect(rows[1].cycle).toBe(1)
  })

  it('caps at 100 rows, pruning oldest', () => {
    for (let i = 1; i <= 130; i++) recordDecision(ctxFor(i, 'DEPOSIT'))
    const rows = getDecisions()
    expect(rows).toHaveLength(100)
    expect(rows[0].cycle).toBe(130)
    expect(rows[99].cycle).toBe(31)
  })

  it('never throws on corrupt storage', () => {
    localStorage.setItem('yv_decision_log', 'not json')
    expect(getDecisions()).toEqual([])
    expect(() => recordDecision(ctxFor(1, 'DEPOSIT'))).not.toThrow()
  })

  it('clearDecisions empties the store', () => {
    recordDecision(ctxFor(1, 'DEPOSIT'))
    clearDecisions()
    expect(getDecisions()).toEqual([])
  })

  it('summary tallies signals per agent role', () => {
    recordDecision(ctxFor(1, 'DEPOSIT'))
    recordDecision(ctxFor(2, 'HOLD'))
    const s = getDecisionSummary()
    expect(s.total).toBe(2)
    expect(s.byAgent.yield).toMatchObject({ DEPOSIT: 1, HOLD: 1 })
    expect(s.byAgent.risk).toMatchObject({ DEPOSIT: 1, HOLD: 1 })
  })
})

// Pocket Crew "My money" Task 8: owner+network-scoped forms. The legacy single-argument calls
// above must keep working unchanged — these cover the NEW scoped forms only.
describe('decisionLog — owner+network scoped (Pocket Crew Task 8)', () => {
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

  const ctxFor = (cycle, signal) => ({
    cycle,
    idea: { kind: 'rebalance', vaultName: 'V' },
    state: { market: { turbulence: 'calm' } },
    verdict: {
      verdict: signal === 'DEPOSIT' ? 'keep' : 'discard',
      resolvedBy: 'unanimous',
      reason: null,
      citedRules: [],
      specialists: [
        { role: 'yield', signal, confidence: 0.7, citedRules: [], concerns: [] },
        { role: 'risk', signal, confidence: 0.7, citedRules: [], concerns: [] },
        { role: 'market', signal, confidence: 0.7, citedRules: [], concerns: [] },
      ],
    },
  })

  it('records and reads back scoped to owner+network, newest-first', () => {
    recordDecision('GOWNER', ctxFor(1, 'DEPOSIT'), { network: 'stellar-testnet' })
    recordDecision('GOWNER', ctxFor(2, 'HOLD'), { network: 'stellar-testnet' })
    const rows = getDecisions('GOWNER', { network: 'stellar-testnet' })
    expect(rows).toHaveLength(2)
    expect(rows[0].cycle).toBe(2)
    expect(rows[1].cycle).toBe(1)
  })

  it('never reuses decision history across wallets', () => {
    recordDecision('GOWNER_A', ctxFor(1, 'DEPOSIT'), { network: 'stellar-testnet' })
    expect(getDecisions('GOWNER_B', { network: 'stellar-testnet' })).toEqual([])
  })

  it('never reuses decision history across networks for the same owner', () => {
    recordDecision('GOWNER', ctxFor(1, 'DEPOSIT'), { network: 'stellar-testnet' })
    expect(getDecisions('GOWNER', { network: 'stellar-mainnet' })).toEqual([])
  })

  it('does not leak into or read from the legacy unowned bucket', () => {
    recordDecision(ctxFor(1, 'DEPOSIT')) // legacy call — hidden bucket
    expect(getDecisions('GOWNER', { network: 'stellar-testnet' })).toEqual([])
    recordDecision('GOWNER', ctxFor(2, 'HOLD'), { network: 'stellar-testnet' })
    expect(getDecisions()).toHaveLength(1) // legacy bucket still only has its own row
  })

  it('drops a scoped write with no owner — never guesses whose decision log it is', () => {
    recordDecision(null, ctxFor(1, 'DEPOSIT'), { network: 'stellar-testnet' })
    expect(getDecisions('GOWNER', { network: 'stellar-testnet' })).toEqual([])
  })

  it('returns [] for a scoped read with no owner', () => {
    expect(getDecisions(null, { network: 'stellar-testnet' })).toEqual([])
  })

  it('clearDecisions(owner, {network}) empties only that bucket', () => {
    recordDecision('GOWNER', ctxFor(1, 'DEPOSIT'), { network: 'stellar-testnet' })
    recordDecision('OTHER', ctxFor(1, 'DEPOSIT'), { network: 'stellar-testnet' })
    clearDecisions('GOWNER', { network: 'stellar-testnet' })
    expect(getDecisions('GOWNER', { network: 'stellar-testnet' })).toEqual([])
    expect(getDecisions('OTHER', { network: 'stellar-testnet' })).toHaveLength(1)
  })

  // Fix 6 (minor, review loop 1): mirrors cycleJournal's fix exactly — a not-yet-loaded owner
  // (explicit `undefined`) must never fall through to the legacy, unowned bucket.
  it('does not fall through to the legacy bucket when owner is explicitly undefined (not omitted)', () => {
    recordDecision(ctxFor(1, 'DEPOSIT')) // real legacy write
    expect(getDecisions(undefined, { network: 'stellar-testnet' })).toEqual([])
    clearDecisions(undefined, { network: 'stellar-testnet' }) // must not wipe the legacy bucket
    expect(getDecisions()).toHaveLength(1)
  })

  // Fix 6 (minor, review loop 1): missing network must drop the write, matching riskWatchStore's
  // policy — never invent an 'unknown' bucket that merges every network-less write for one owner.
  it('drops a scoped write with no network — never invents a shared "unknown" bucket', () => {
    recordDecision('GOWNER', ctxFor(1, 'DEPOSIT')) // no {network} at all — must be a true no-op
    expect(getDecisions('GOWNER', {})).toEqual([])
    expect(getDecisions('GOWNER', { network: 'stellar-testnet' })).toEqual([])
  })

  it('returns [] for a scoped read with no network', () => {
    recordDecision('GOWNER', ctxFor(1, 'DEPOSIT'), { network: 'stellar-testnet' })
    expect(getDecisions('GOWNER', {})).toEqual([])
  })
})
