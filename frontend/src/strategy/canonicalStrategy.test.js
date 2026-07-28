import { describe, it, expect } from 'vitest'
import { canonicalizeStrategy } from './canonicalStrategy.js'
import { hashStrategy } from '../attestation.js'
import { normalizeStrategyPlan } from './planModel.js'
import { normalizeVenue } from './venueTruth.js'

const STELLAR_DESTINATION = normalizeVenue({}).destination
const U = (usdc) => BigInt(Math.round(usdc * 1e7)) // Stellar 7dp base units
const B = (usdc) => BigInt(Math.round(usdc * 1e6)) // Base 6dp base units

function makePlan(over = {}) {
  return normalizeStrategyPlan({
    runId: 'run-1',
    risk: 'med',
    stellarUnits: U(200),
    destination: STELLAR_DESTINATION,
    baseAllocations: [
      {
        proxyTarget: 'aave-v3',
        factSlug: 'aave-v3-base',
        address: '0xAAA',
        units: B(50),
        chain: 'base',
      },
    ],
    expiry: 1_800_000_000,
    ...over,
  })
}

describe('canonicalizeStrategy', () => {
  it('sorts object keys recursively regardless of source key order', () => {
    const a = canonicalizeStrategy({ b: 1, a: { d: 2, c: 3 } })
    const b = canonicalizeStrategy({ a: { c: 3, d: 2 }, b: 1 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(Object.keys(a)).toEqual(['a', 'b'])
    expect(Object.keys(a.a)).toEqual(['c', 'd'])
  })

  it('preserves array order (allocation and agent order are semantically meaningful)', () => {
    const c = canonicalizeStrategy({ agents: [{ id: 'z' }, { id: 'a' }] })
    expect(c.agents.map((x) => x.id)).toEqual(['z', 'a'])
  })

  it('stringifies bigint units as decimal strings', () => {
    const c = canonicalizeStrategy({ amount: { units: 12345678901234567890n } })
    expect(c.amount.units).toBe('12345678901234567890')
    expect(typeof c.amount.units).toBe('string')
  })

  it("excludes the plan's own planFingerprint from the canonical payload", () => {
    const c = canonicalizeStrategy({ planFingerprint: '0xabc', source: 'venice' })
    expect(c.planFingerprint).toBeUndefined()
    expect(c.source).toBe('venice')
  })

  it('excludes the legacy strategyHash field (self-referential under its old name)', () => {
    const c = canonicalizeStrategy({ strategyHash: '0xdead', source: 'venice' })
    expect(c.strategyHash).toBeUndefined()
    expect(c.source).toBe('venice')
  })

  it("excludes the eligibility gate's review verdicts -- display-only, never part of what the fingerprint attests to", () => {
    const c = canonicalizeStrategy({
      source: 'venice',
      review: { candidates: [{ protocol: 'Aave v3', chain: 'base', eligible: false, reasons: ['x'] }] },
    })
    expect(c.review).toBeUndefined()
    expect(c).toEqual({ source: 'venice' })
  })

  it('excludes transient wallet and wall-clock fields if a caller merges them in', () => {
    const c = canonicalizeStrategy({
      source: 'venice',
      attester: 'GUSER123',
      wallet: 'freighter',
      timestamp: 1700000000,
      generatedAt: Date.now(),
    })
    expect(c).toEqual({ source: 'venice' })
  })

  it('is a pure function: same input shape always canonicalizes the same way', () => {
    const plan = { source: 'venice', agents: [{ allocation: { units: '100' } }] }
    expect(canonicalizeStrategy(plan)).toEqual(
      canonicalizeStrategy(JSON.parse(JSON.stringify(plan)))
    )
  })
})

// hashStrategy(plan) against a real Task-2 StrategyPlan (planModel.js): the canonical consumer
// this task fills planFingerprint for (Tasks 5-8).
describe('hashStrategy(plan) on a StrategyPlan', () => {
  it('hashes the same semantic plan identically across calls and top-level key order', () => {
    const plan = makePlan()
    const swapped = Object.fromEntries(Object.entries(plan).reverse())
    expect(hashStrategy(plan)).toBe(hashStrategy(plan))
    expect(hashStrategy(plan)).toBe(hashStrategy(swapped))
  })

  it('changes when allocation units change', () => {
    const base = makePlan()
    const bumped = makePlan({ stellarUnits: U(999) })
    expect(hashStrategy(bumped)).not.toBe(hashStrategy(base))
  })

  it('changes when the Stellar deposit destination changes', () => {
    const base = makePlan()
    const moved = makePlan({ destination: 'Somewhere else' })
    expect(hashStrategy(moved)).not.toBe(hashStrategy(base))
  })

  it('changes when agent scope (expiry, the SEP-41 allowance bound) changes', () => {
    const base = makePlan()
    const rescoped = makePlan({ expiry: 1_800_000_500 })
    expect(hashStrategy(rescoped)).not.toBe(hashStrategy(base))
  })

  it('changes when Base custody-proxy truth (proxyTarget) changes', () => {
    const base = makePlan()
    const reproxied = makePlan({
      baseAllocations: [
        {
          proxyTarget: 'compound-v3',
          factSlug: 'aave-v3-base',
          address: '0xAAA',
          units: B(50),
          chain: 'base',
        },
      ],
    })
    expect(hashStrategy(reproxied)).not.toBe(hashStrategy(base))
  })

  it('does not move when plan.review (eligibility-gate verdicts) differs or is absent', () => {
    const base = makePlan()
    const withReview = makePlan({
      review: { candidates: [{ protocol: 'Aave v3', chain: 'base', eligible: false, reasons: ['facts stale'] }] },
    })
    expect(hashStrategy(withReview)).toBe(hashStrategy(base))
  })

  it('never lets a wall-clock timestamp into the payload', () => {
    const plan = makePlan()
    const realNow = Date.now
    Date.now = () => 1000
    const h1 = hashStrategy(plan)
    Date.now = () => 9_999_999_999
    const h2 = hashStrategy(plan)
    Date.now = realNow
    expect(h1).toBe(h2)
  })
})
