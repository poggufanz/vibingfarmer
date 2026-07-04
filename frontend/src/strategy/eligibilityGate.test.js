import { describe, it, expect } from 'vitest'
import {
  REQUIRED_FACTS,
  AGE_WEIGHT,
  TVL_WEIGHT,
  ADMIN_WEIGHT,
  MAX_FACT_AGE_MS,
  factPresent,
  allRequiredFactsPresent,
} from './eligibilityGate.js'

import { yieldReality, securityScore, evaluate } from './eligibilityGate.js'
import { SECURITY_MIN, TVL_FLOOR, TVL_CAP } from './eligibilityGate.js'

const tvlForSig = (sig) =>
  10 ** (Math.log10(TVL_FLOOR) + sig * (Math.log10(TVL_CAP) - Math.log10(TVL_FLOOR)))

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
    expect(
      factPresent({ value: 5, source: 'snapshot', asOf: NOW - MAX_FACT_AGE_MS - 1 }, NOW)
    ).toBe(false)
  })
  it('allRequiredFactsPresent: each required fact absent ALONE fails', () => {
    for (const k of REQUIRED_FACTS) {
      const f = fullFacts()
      f[k] = { value: null, source: 'snapshot', asOf: NOW }
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
  // Lifeboat F8 facts — healthy values so these pre-existing evaluate() tests keep asserting
  // what they asserted before (ponzi/audit/age/tvl/admin behavior), not the new gate.
  oracleType: { value: 'circuit_breaker', source: 'snapshot', asOf: NOW2 },
  collateralLiquidityDepthUsd: { value: 1_000_000, source: 'snapshot', asOf: NOW2 },
  poolClass: { value: 'curated', source: 'snapshot', asOf: NOW2 },
  supplierConcentrationPct: { value: 25, source: 'snapshot', asOf: NOW2 },
  ...over,
})

describe('evaluate (combine)', () => {
  it('Blend-like facts => eligible', () => {
    expect(evaluate({ protocol: 'blend', facts: mk() }, NOW2).eligible).toBe(true)
  })
  it('fixture => ineligible with both reasons', () => {
    const v = evaluate(
      {
        protocol: 'hyperfarm',
        isFixture: true,
        facts: mk({
          audit: { value: 'none', source: 'snapshot', asOf: NOW2 },
          ageDays: { value: 4, source: 'snapshot', asOf: NOW2 },
          tvl: { value: 50_000, source: 'snapshot', asOf: NOW2 },
          adminKey: { value: 'eoa', source: 'snapshot', asOf: NOW2 },
          annualizedDistributed: { value: 10_000_000, source: 'snapshot', asOf: NOW2 },
          protocolRevenue: { value: 3_000_000, source: 'snapshot', asOf: NOW2 },
        }),
      },
      NOW2
    )
    expect(v.eligible).toBe(false)
    expect(v.isFixture).toBe(true)
    expect(v.reasons.join(' ')).toMatch(/unaudited/i)
    expect(v.reasons.join(' ')).toMatch(/ratio 3\.3/)
  })
  it('missing fact => fail-closed reject', () => {
    const v = evaluate(
      {
        protocol: 'x',
        facts: mk({ protocolRevenue: { value: null, source: 'snapshot', asOf: NOW2 } }),
      },
      NOW2
    )
    expect(v.eligible).toBe(false)
  })
  it('echoes provenance', () => {
    const v = evaluate({ protocol: 'blend', facts: mk() }, NOW2)
    expect(v.facts.tvl.source).toBe('snapshot')
  })
})

describe('securityScore boundary + saturation', () => {
  const sf2 = (audit, ageDays, tvl, adminKey) => ({
    audit: { value: audit, source: 'snapshot', asOf: 0 },
    ageDays: { value: ageDays, source: 'snapshot', asOf: 0 },
    tvl: { value: tvl, source: 'snapshot', asOf: 0 },
    adminKey: { value: adminKey, source: 'snapshot', asOf: 0 },
  })
  it('score lands exactly on SECURITY_MIN at the pass boundary (ageSig=1, tvlSig=0.75, eoa)', () => {
    // round(100*(0.30*1 + 0.40*0.75 + 0.30*0)) = round(60) = 60 — pins the >= boundary
    expect(securityScore(sf2('audited', 180, tvlForSig(0.75), 'eoa')).score).toBe(SECURITY_MIN)
  })
  it('one notch below the boundary rejects (tvlSig=0.70 => 58 < 60)', () => {
    expect(securityScore(sf2('audited', 180, tvlForSig(0.7), 'eoa')).score).toBeLessThan(
      SECURITY_MIN
    )
  })
  it('TVL at/above TVL_CAP saturates tvlSig to 1', () => {
    expect(securityScore(sf2('audited', 180, TVL_CAP, 'eoa')).components.tvl).toBe(1)
    expect(securityScore(sf2('audited', 180, TVL_CAP * 10, 'eoa')).components.tvl).toBe(1)
  })
})

describe('evaluate boundary + fail-closed extras', () => {
  // a vector whose securityScore is exactly SECURITY_MIN, otherwise eligible (audited, real, known admin)
  const atBoundary = () =>
    mk({
      ageDays: { value: 180, source: 'snapshot', asOf: NOW2 },
      tvl: { value: tvlForSig(0.75), source: 'snapshot', asOf: NOW2 },
      adminKey: { value: 'eoa', source: 'snapshot', asOf: NOW2 },
    })
  it('eligible when score === SECURITY_MIN (>= boundary, not >)', () => {
    const v = evaluate({ protocol: 'b', facts: atBoundary() }, NOW2)
    expect(v.security.score).toBe(SECURITY_MIN)
    expect(v.eligible).toBe(true)
  })
  it('rejects an unrecognized adminKey value (fail-closed governance)', () => {
    const v = evaluate(
      {
        protocol: 'b',
        facts: mk({ adminKey: { value: 'gnosis-x', source: 'snapshot', asOf: NOW2 } }),
      },
      NOW2
    )
    expect(v.eligible).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/unrecognized governance/i)
  })
  it('each required fact stale ALONE => fail-closed reject with the staleness reason', () => {
    for (const k of REQUIRED_FACTS) {
      const facts = mk({
        [k]: { value: mk()[k].value, source: 'snapshot', asOf: NOW2 - MAX_FACT_AGE_MS - 1 },
      })
      const v = evaluate({ protocol: 'b', facts }, NOW2)
      expect(v.eligible).toBe(false)
      expect(v.reasons.join(' ')).toMatch(/missing or stale required data/)
    }
  })
  it('audit value "none" yields the distinct audit-gate reason', () => {
    const v = evaluate(
      { protocol: 'b', facts: mk({ audit: { value: 'none', source: 'snapshot', asOf: NOW2 } }) },
      NOW2
    )
    expect(v.eligible).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/unaudited \(audit gate\)/)
  })
  it('a below-threshold score reason carries the "our weighting" honesty qualifier', () => {
    // audited but young + tiny TVL + eoa => score ~1, audit passes => the score reason renders
    const v = evaluate(
      {
        protocol: 'b',
        facts: mk({
          ageDays: { value: 4, source: 'snapshot', asOf: NOW2 },
          tvl: { value: 50_000, source: 'snapshot', asOf: NOW2 },
          adminKey: { value: 'eoa', source: 'snapshot', asOf: NOW2 },
        }),
      },
      NOW2
    )
    expect(v.eligible).toBe(false)
    expect(v.reasons.join(' ')).toMatch(/security \d+\/100 \(our weighting\) below/)
  })
})

// ===== Lifeboat F8 extension: YieldBlox post-mortem facts =====
const F8_NOW = Date.parse('2026-07-04T00:00:00Z')
const f8 = (value) => ({ value, source: 'snapshot', asOf: F8_NOW })
const healthyFacts = (over = {}) => ({
  annualizedDistributed: f8(1_000_000),
  protocolRevenue: f8(1_050_000),
  audit: f8('audited'),
  ageDays: f8(365),
  tvl: f8(25_000_000),
  adminKey: f8('timelock_multisig'),
  oracleType: f8('circuit_breaker'),
  collateralLiquidityDepthUsd: f8(1_000_000),
  poolClass: f8('curated'),
  supplierConcentrationPct: f8(25),
  ...over,
})

describe('F8 lifeboat screening facts', () => {
  it('all healthy facts stay eligible', () => {
    const v = evaluate({ protocol: 'x', facts: healthyFacts() }, F8_NOW)
    expect(v.eligible).toBe(true)
  })
  it('community-managed pool is rejected (the YieldBlox class)', () => {
    const v = evaluate(
      { protocol: 'x', facts: healthyFacts({ poolClass: f8('community') }) },
      F8_NOW
    )
    expect(v.eligible).toBe(false)
    expect(v.reasons).toContain('community-managed pool')
  })
  it('VWAP oracle without circuit breaker is rejected', () => {
    const v = evaluate(
      { protocol: 'x', facts: healthyFacts({ oracleType: f8('vwap_no_breaker') }) },
      F8_NOW
    )
    expect(v.eligible).toBe(false)
    expect(v.reasons).toContain('oracle without circuit breaker')
  })
  it('unknown oracle type is rejected (fail-closed)', () => {
    const v = evaluate(
      { protocol: 'x', facts: healthyFacts({ oracleType: f8('unknown') }) },
      F8_NOW
    )
    expect(v.eligible).toBe(false)
  })
  it('thin collateral liquidity is rejected below 250k', () => {
    const v = evaluate(
      { protocol: 'x', facts: healthyFacts({ collateralLiquidityDepthUsd: f8(100_000) }) },
      F8_NOW
    )
    expect(v.eligible).toBe(false)
    expect(v.reasons).toContain('thin collateral liquidity')
  })
  it('supplier concentration above 40% is rejected', () => {
    const v = evaluate(
      { protocol: 'x', facts: healthyFacts({ supplierConcentrationPct: f8(55) }) },
      F8_NOW
    )
    expect(v.eligible).toBe(false)
    expect(v.reasons).toContain('supplier concentration too high')
  })
  it('a missing new fact fails closed via the required-facts gate', () => {
    const facts = healthyFacts()
    delete facts.poolClass
    const v = evaluate({ protocol: 'x', facts }, F8_NOW)
    expect(v.eligible).toBe(false)
    expect(v.reasons).toContain('missing or stale required data')
  })
})
