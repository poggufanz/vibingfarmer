import { describe, it, expect } from 'vitest'
import { resolve, SNAPSHOT } from './vaultFacts.js'
import { CAPTURED_AT } from './vaultFactsSnapshot.js'
import { evaluate } from './eligibilityGate.js'

// Derived from the capture date so the snapshot stays inside MAX_FACT_AGE_MS regardless of when
// CAPTURED_AT is bumped (plan literal 1_790_000_000_000 was 85d stale — would fail the gate).
const NOW = CAPTURED_AT + 1000

describe('vaultFacts', () => {
  it('resolves a known protocol with provenance', () => {
    const r = resolve('aave-v3')
    expect(r.facts.tvl.source).toBe('snapshot')
    expect(typeof r.facts.tvl.asOf).toBe('number')
  })
  it('an audited catalog protocol is eligible', () => {
    expect(evaluate(resolve('aave-v3'), NOW).eligible).toBe(true)
  })
  it('the hyperfarm fixture is flagged and rejected', () => {
    const r = resolve('hyperfarm')
    expect(r.isFixture).toBe(true)
    expect(evaluate(r, NOW).eligible).toBe(false)
  })
  it('unknown protocol throws (caller maps to reject)', () => {
    expect(() => resolve('nope')).toThrow()
  })
})
