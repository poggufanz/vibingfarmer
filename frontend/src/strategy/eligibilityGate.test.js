import { describe, it, expect } from 'vitest'
import {
  REQUIRED_FACTS, AGE_WEIGHT, TVL_WEIGHT, ADMIN_WEIGHT,
  MAX_FACT_AGE_MS, factPresent, allRequiredFactsPresent,
} from './eligibilityGate.js'

import { yieldReality, securityScore, evaluate } from './eligibilityGate.js'

const NOW = 1_900_000_000_000
const fresh = (value) => ({ value, source: 'snapshot', asOf: NOW - 1000 })
const fullFacts = () => Object.fromEntries(REQUIRED_FACTS.map((k) => [k, fresh(1)]))

describe('weights + presence', () => {
  it('security weights sum to 1.0', () => {
    expect(AGE_WEIGHT + TVL_WEIGHT + ADMIN_WEIGHT).toBe(1.0)
  })
  it('a fresh present field is present', () => {
    expect(factPresent(fresh(5), NOW)).toBe(true)
  })
  it('a null value is absent', () => {
    expect(factPresent({ value: null, source: 'snapshot', asOf: NOW }, NOW)).toBe(false)
  })
  it('a stale field (older than MAX_FACT_AGE) is absent', () => {
    expect(factPresent({ value: 5, source: 'snapshot', asOf: NOW - MAX_FACT_AGE_MS - 1 }, NOW)).toBe(false)
  })
  it('allRequiredFactsPresent: each required fact absent ALONE fails', () => {
    for (const k of REQUIRED_FACTS) {
      const f = fullFacts(); f[k] = { value: null, source: 'snapshot', asOf: NOW }
      expect(allRequiredFactsPresent(f, NOW)).toBe(false)
    }
    expect(allRequiredFactsPresent(fullFacts(), NOW)).toBe(true)
  })
})

describe('yieldReality (Test 1)', () => {
  const ff = (dist, rev) => ({
    annualizedDistributed: { value: dist, source: 'snapshot', asOf: 0 },
    protocolRevenue: { value: rev, source: 'snapshot', asOf: 0 },
  })
  it('ratio < 1.5 => real (Blend ~1.0)', () => {
    expect(yieldReality(ff(1_000_000, 1_050_000)).verdict).toBe('real')
  })
  it('ratio >= 1.5 => ponzi (fixture 3.33)', () => {
    expect(yieldReality(ff(10_000_000, 3_000_000)).verdict).toBe('ponzi')
  })
  it('boundary ratio === 1.5 => ponzi (strict <)', () => {
    expect(yieldReality(ff(150, 100)).verdict).toBe('ponzi')
  })
  it('missing/<=0 distributed => unknown (symmetric)', () => {
    expect(yieldReality(ff(0, 100)).verdict).toBe('unknown')
    expect(yieldReality(ff(null, 100)).verdict).toBe('unknown')
  })
  it('missing/<=0 revenue => unknown', () => {
    expect(yieldReality(ff(100, 0)).verdict).toBe('unknown')
    expect(yieldReality(ff(100, null)).verdict).toBe('unknown')
  })
})

describe('securityScore (Test 2)', () => {
  const sf = (audit, ageDays, tvl, adminKey) => ({
    audit: { value: audit, source: 'snapshot', asOf: 0 },
    ageDays: { value: ageDays, source: 'snapshot', asOf: 0 },
    tvl: { value: tvl, source: 'snapshot', asOf: 0 },
    adminKey: { value: adminKey, source: 'snapshot', asOf: 0 },
  })
  it('audited + mature + large TVL + timelock_multisig => high score, audit passes', () => {
    const r = securityScore(sf('audited', 365, 25_000_000, 'timelock_multisig'))
    expect(r.auditGate).toBe('pass')
    expect(r.score).toBeGreaterThanOrEqual(60)
  })
  it('fixture: unaudited 4-day tiny-TVL eoa => audit fails, score 1', () => {
    const r = securityScore(sf('none', 4, 50_000, 'eoa'))
    expect(r.auditGate).toBe('fail')
    expect(r.score).toBe(1) // round(100 * (0.30*(4/180) + 0.40*0 + 0.30*0))
  })
})

const NOW2 = 1_900_000_000_000
const mk = (over = {}) => ({
  annualizedDistributed: { value: 1_000_000, source: 'snapshot', asOf: NOW2 },
  protocolRevenue: { value: 1_050_000, source: 'snapshot', asOf: NOW2 },
  audit: { value: 'audited', source: 'snapshot', asOf: NOW2 },
  ageDays: { value: 365, source: 'snapshot', asOf: NOW2 },
  tvl: { value: 25_000_000, source: 'snapshot', asOf: NOW2 },
  adminKey: { value: 'timelock_multisig', source: 'snapshot', asOf: NOW2 },
  ...over,
})

describe('evaluate (combine)', () => {
  it('Blend-like facts => eligible', () => {
    expect(evaluate({ protocol: 'blend', facts: mk() }, NOW2).eligible).toBe(true)
  })
  it('fixture => ineligible with both reasons', () => {
    const v = evaluate({
      protocol: 'hyperfarm', isFixture: true,
      facts: mk({
        audit: { value: 'none', source: 'snapshot', asOf: NOW2 },
        ageDays: { value: 4, source: 'snapshot', asOf: NOW2 },
        tvl: { value: 50_000, source: 'snapshot', asOf: NOW2 },
        adminKey: { value: 'eoa', source: 'snapshot', asOf: NOW2 },
        annualizedDistributed: { value: 10_000_000, source: 'snapshot', asOf: NOW2 },
        protocolRevenue: { value: 3_000_000, source: 'snapshot', asOf: NOW2 },
      }),
    }, NOW2)
    expect(v.eligible).toBe(false)
    expect(v.isFixture).toBe(true)
    expect(v.reasons.join(' ')).toMatch(/unaudited/i)
    expect(v.reasons.join(' ')).toMatch(/ratio 3\.3/)
  })
  it('missing fact => fail-closed reject', () => {
    const v = evaluate({ protocol: 'x', facts: mk({ protocolRevenue: { value: null, source: 'snapshot', asOf: NOW2 } }) }, NOW2)
    expect(v.eligible).toBe(false)
  })
  it('echoes provenance', () => {
    const v = evaluate({ protocol: 'blend', facts: mk() }, NOW2)
    expect(v.facts.tvl.source).toBe('snapshot')
  })
})
