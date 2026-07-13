// frontend/src/vfapi/client.test.js
// TDD: RED → GREEN. Tests the vfapi thin client over real eligibilityGate.evaluate.
import { describe, it, expect, vi } from 'vitest'
import { eligibility, buildUnsignedTx } from './client.js'

// Known-rejected fixture: annualizedDistributed / protocolRevenue = 3.0 >= PONZI_RATIO_MAX (1.5)
// → yieldReality.verdict = 'ponzi' → eligible = false → allow = false.
// All required facts are present and fresh (asOf === nowMs, so age = 0 ≤ MAX_FACT_AGE_MS).
const PONZI_FIXTURE = {
  annualizedDistributed: { value: 3, asOf: 1_000_000, source: 'snapshot' },
  protocolRevenue: { value: 1, asOf: 1_000_000, source: 'snapshot' },
  audit: { value: 'audited', asOf: 1_000_000, source: 'snapshot' },
  ageDays: { value: 365, asOf: 1_000_000, source: 'snapshot' },
  tvl: { value: 1_000_000, asOf: 1_000_000, source: 'snapshot' },
  adminKey: { value: 'timelock_multisig', asOf: 1_000_000, source: 'snapshot' },
  // Lifeboat F8 facts — healthy values so this fixture's rejection stays attributable to the
  // ponzi ratio alone (the thing this test is actually asserting), not the new required facts.
  oracleType: { value: 'circuit_breaker', asOf: 1_000_000, source: 'snapshot' },
  collateralLiquidityDepthUsd: { value: 1_000_000, asOf: 1_000_000, source: 'snapshot' },
  poolClass: { value: 'curated', asOf: 1_000_000, source: 'snapshot' },
  supplierConcentrationPct: { value: 25, asOf: 1_000_000, source: 'snapshot' },
}

describe('vfapi thin client', () => {
  it('eligibility delegates to the F8 gate and returns a fail-closed verdict', async () => {
    const out = await eligibility({
      vault: 'CVAULT',
      amount: 100n,
      facts: PONZI_FIXTURE,
      nowMs: 1_000_000,
    })
    expect(out).toHaveProperty('allow')
    expect(out).toHaveProperty('reasons')
    // Confirm the fixture is genuinely rejected (fail-closed)
    expect(out.allow).toBe(false)
    expect(out.reasons.length).toBeGreaterThan(0)
    expect(out.reasons[0]).toMatch(/exceeds the 1\.5 limit/i)
  })

  it('resolves snapshot facts from the protocol slug when facts are omitted', async () => {
    // Fixed nowMs (3 days after the snapshot CAPTURED_AT) keeps freshness deterministic.
    const out = await eligibility({
      vault: 'blend-usdc',
      amount: 100n,
      nowMs: Date.parse('2026-07-01T00:00:00Z'),
    })
    expect(out.allow).toBe(true)
    expect(out.verdict.protocol).toBe('blend-usdc')
  })

  it('fails closed for an unknown protocol/address (no facts = no eligibility)', async () => {
    const out = await eligibility({
      vault: 'CUNKNOWNVAULTADDRESS',
      amount: 100n,
      nowMs: Date.parse('2026-07-01T00:00:00Z'),
    })
    expect(out.allow).toBe(false)
    expect(out.reasons[0]).toMatch(/facts unavailable/)
  })

  it('buildUnsignedTx returns { xdr } and never a signature/secret', async () => {
    const assemble = vi.fn(async () => ({ xdr: 'AAAA...' }))
    const out = await buildUnsignedTx({ kind: 'deposit', params: { amount: 100n }, assemble })
    expect(out).toEqual({ xdr: 'AAAA...' })
    expect(JSON.stringify(out)).not.toMatch(/secret|seed|privateKey/i)
  })
})
