import { describe, it, expect } from 'vitest'
import {
  REQUIRED_FACTS, AGE_WEIGHT, TVL_WEIGHT, ADMIN_WEIGHT,
  MAX_FACT_AGE_MS, factPresent, allRequiredFactsPresent,
} from './eligibilityGate.js'

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
