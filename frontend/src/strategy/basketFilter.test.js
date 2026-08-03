import { describe, it, expect } from 'vitest'
import { filterBasket, computeBasket } from './basketFilter.js'

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
    const agents = [
      agent('w1', 'aave-v3', 30),
      agent('w2', 'morpho-blue', 10),
      agent('w3', 'hyperfarm', 60),
    ]
    const r = filterBasket(agents, {
      'aave-v3': V(true),
      'morpho-blue': V(true),
      hyperfarm: V(false),
    })
    expect(r.survivors.find((s) => s.id === 'w1').allocationFraction).toBeCloseTo(0.75, 6)
    expect(r.survivors.reduce((a, s) => a + s.allocationFraction, 0)).toBeCloseTo(1.0, 6)
  })
})

describe('computeBasket', () => {
  it('drops a single contradictory venue record fail-closed instead of crashing the whole basket', () => {
    // chain:'base' paired with a real Stellar-shaped address — venueDisclosure/normalizeVenue
    // refuses to guess and throws. That must sink only THIS agent's verdict, not the whole call.
    const contradictory = {
      id: 'w-bad',
      allocation: 50,
      vault: {
        protocol: 'morpho-blue', // distinct slug from the healthy agent below
        chain: 'base',
        addr: 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77',
      },
    }
    const healthy = agent('w-ok', 'aave-v3', 50)
    expect(() => computeBasket([contradictory, healthy])).not.toThrow()
    const { verdictBySlug, survivors, dropped } = computeBasket([contradictory, healthy])
    // the contradictory agent's own verdict is ineligible (fail-closed), never crashes the batch
    expect(verdictBySlug['morpho-blue'].eligible).toBe(false)
    expect(dropped.some((d) => d.agent.id === 'w-bad')).toBe(true)
    expect(survivors.some((s) => s.id === 'w-bad')).toBe(false)
    // the healthy agent, sharing nothing with the bad record, is unaffected
    expect(survivors.some((s) => s.id === 'w-ok')).toBe(true)
  })
})
