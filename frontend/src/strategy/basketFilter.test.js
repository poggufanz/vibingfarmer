import { describe, it, expect } from 'vitest'
import { filterBasket } from './basketFilter.js'

const agent = (id, protocol, allocation) => ({ id, allocation, vault: { protocol, addr: 'C...' } })
const V = (eligible) => ({ eligible })

describe('filterBasket', () => {
  it('drops ineligible and re-normalizes survivors to sum 1', () => {
    const agents = [agent('w1', 'aave-v3', 50), agent('w2', 'hyperfarm', 50)]
    const r = filterBasket(agents, { 'aave-v3': V(true), hyperfarm: V(false) })
    expect(r.allFailed).toBe(false)
    expect(r.survivors).toHaveLength(1)
    expect(r.survivors[0].allocationFraction).toBeCloseTo(1.0, 6)
    expect(r.dropped[0].agent.id).toBe('w2')
  })
  it('all ineligible => allFailed, no survivors', () => {
    const agents = [agent('w1', 'hyperfarm', 100)]
    const r = filterBasket(agents, { hyperfarm: V(false) })
    expect(r.allFailed).toBe(true)
    expect(r.survivors).toHaveLength(0)
  })
  it('survivor fractions are proportional to original allocation', () => {
    const agents = [agent('w1', 'aave-v3', 30), agent('w2', 'morpho-blue', 10), agent('w3', 'hyperfarm', 60)]
    const r = filterBasket(agents, { 'aave-v3': V(true), 'morpho-blue': V(true), hyperfarm: V(false) })
    expect(r.survivors.find((s) => s.id === 'w1').allocationFraction).toBeCloseTo(0.75, 6)
    expect(r.survivors.reduce((a, s) => a + s.allocationFraction, 0)).toBeCloseTo(1.0, 6)
  })
})
