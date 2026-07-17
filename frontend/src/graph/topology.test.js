import { describe, it, expect } from 'vitest'
import { buildGraphData, buildAutofarmGraphData, rebalancePulseKey, STEP_IDS } from './topology.js'

const strategy = {
  agents: [
    { id: 'worker-1', idx: '01', vault: { protocol: 'Blend', apy: '6.2' } },
    { id: 'worker-2', idx: '02', vault: { protocol: 'YieldBlox', apy: '8.4' } },
  ],
}

describe('buildGraphData', () => {
  it('builds orchestrator → worker → steps → vault chain per agent', () => {
    const { nodes, links } = buildGraphData(strategy)
    expect(nodes[0]).toEqual({ id: 'orchestrator', name: 'Orchestrator', kind: 'orchestrator' })
    expect(nodes.filter((n) => n.kind === 'worker')).toHaveLength(2)
    expect(nodes.filter((n) => n.kind === 'step')).toHaveLength(2 * STEP_IDS.length)
    expect(nodes.filter((n) => n.kind === 'vault')).toHaveLength(2)
    expect(links).toHaveLength(2 * (1 + STEP_IDS.length + 1))
    expect(links[0]).toEqual({ source: 'orchestrator', target: 'worker-1' })
    expect(nodes.find((n) => n.id === 'worker-1-swap').stepId).toBe('swap')
  })
})

describe('rebalancePulseKey', () => {
  it('is direction-independent', () => {
    expect(rebalancePulseKey('A', 'B')).toBe(rebalancePulseKey('B', 'A'))
  })
})

describe('buildAutofarmGraphData', () => {
  it('returns empty without vaultAddress', () => {
    expect(buildAutofarmGraphData({})).toEqual({ nodes: [], links: [] })
  })
  it('builds keeper/strategy/pool cluster around the vault with pulse keys', () => {
    const g = buildAutofarmGraphData({
      vaultAddress: 'V',
      keeperAddress: 'K',
      strategies: [{ address: 'S1', poolAddress: 'P1' }],
    })
    expect(g.nodes.map((n) => n.id)).toEqual(['V', 'K', 'S1', 'pool:P1'])
    expect(g.nodes.map((n) => n.kind)).toEqual(['vault', 'keeper', 'strategy', 'pool'])
    expect(g.links.every((l) => typeof l.pulseKey === 'string')).toBe(true)
  })
})
