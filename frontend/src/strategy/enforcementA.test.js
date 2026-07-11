import { describe, it, expect } from 'vitest'
import { computeBasket } from './basketFilter.js'
import { CAPTURED_AT } from './vaultFactsSnapshot.js'

const agent = (id, protocol, allocation) => ({ id, allocation, vault: { protocol, addr: 'C...' } })
// Within MAX_FACT_AGE_MS of the capture date (see vaultFacts.test.js note on the 85d-stale literal).
const NOW = CAPTURED_AT + 1000

describe('computeBasket (Enforcement A)', () => {
  it('aave passes, hyperfarm dropped', () => {
    const r = computeBasket([agent('w1', 'aave-v3', 50), agent('w2', 'hyperfarm', 50)], NOW)
    expect(r.verdictBySlug['aave-v3'].eligible).toBe(true)
    expect(r.verdictBySlug['hyperfarm'].eligible).toBe(false)
    expect(r.survivors.map((s) => s.id)).toEqual(['w1'])
    expect(r.allFailed).toBe(false)
  })
  it('unknown protocol => rejected (resolve throws => reject verdict), not a crash', () => {
    const r = computeBasket([agent('w1', 'nope', 100)], NOW)
    expect(r.verdictBySlug['nope'].eligible).toBe(false)
    expect(r.allFailed).toBe(true)
  })
})
