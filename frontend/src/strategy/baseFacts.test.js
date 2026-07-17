import { describe, it, expect } from 'vitest'
import { resolve } from './vaultFacts.js'
import { evaluate } from './eligibilityGate.js'

describe('base pool facts', () => {
  for (const slug of ['aave-v3-base', 'morpho-blue-base', 'moonwell-base']) {
    it(`${slug} resolves with all required facts and passes the gate deterministically`, () => {
      const input = resolve(slug)
      expect(input).toBeTruthy()
      expect(input.protocol).toBe(slug)
      const verdict = evaluate(input, Date.now())
      expect(verdict.eligible).toBe(true)
      expect(verdict.reasons).toBeDefined()
    })
  }
})
