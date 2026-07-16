import { describe, it, expect } from 'vitest'
import { buildGraphData, buildAutofarmGraphData } from './topology.js'
import { detectMode, layoutGraph, conduitControl, pointOnQuadratic } from './layout.js'

const strategy = {
  agents: [
    { id: 'worker-1', idx: '01', vault: { protocol: 'Blend', apy: '6.2' } },
    { id: 'worker-2', idx: '02', vault: { protocol: 'YieldBlox', apy: '8.4' } },
  ],
}
const W = 800
const H = 400

describe('detectMode', () => {
  it('classifies strategy, cluster, and generic shapes', () => {
    expect(detectMode(buildGraphData(strategy).nodes)).toBe('strategy')
    expect(detectMode(buildAutofarmGraphData({ vaultAddress: 'V', keeperAddress: 'K' }).nodes)).toBe('cluster')
    expect(detectMode([{ id: 'a' }, { id: 'b' }])).toBe('generic')
  })
})

describe('strategy layout', () => {
  const data = buildGraphData(strategy)
  const { mode, positions } = layoutGraph(data, W, H)
  it('orders columns left to right: core < worker < swap < approve < deposit < vault', () => {
    expect(mode).toBe('strategy')
    const x = (id) => positions.get(id).x
    expect(x('orchestrator')).toBeLessThan(x('worker-1'))
    expect(x('worker-1')).toBeLessThan(x('worker-1-swap'))
    expect(x('worker-1-swap')).toBeLessThan(x('worker-1-approve'))
    expect(x('worker-1-approve')).toBeLessThan(x('worker-1-deposit'))
    expect(x('worker-1-deposit')).toBeLessThan(x('worker-1-vault'))
  })
  it('gives each worker its own lane and centers the core', () => {
    expect(positions.get('worker-1').y).not.toBe(positions.get('worker-2').y)
    expect(positions.get('worker-1').y).toBe(positions.get('worker-1-vault').y)
    expect(positions.get('orchestrator').y).toBe(H / 2)
  })
  it('positions every node and is deterministic', () => {
    expect(positions.size).toBe(data.nodes.length)
    expect(layoutGraph(data, W, H).positions.get('worker-2-deposit')).toEqual(
      positions.get('worker-2-deposit')
    )
  })
})

describe('cluster layout', () => {
  const data = buildAutofarmGraphData({
    vaultAddress: 'V',
    keeperAddress: 'K',
    strategies: [
      { address: 'S1', poolAddress: 'P1' },
      { address: 'S2' },
    ],
  })
  const { positions } = layoutGraph(data, W, H)
  const dist = (id) => {
    const p = positions.get(id)
    const v = positions.get('V')
    return Math.hypot(p.x - v.x, p.y - v.y)
  }
  it('puts the vault at the hub and ring nodes equidistant', () => {
    expect(positions.get('V').x).toBeCloseTo(W / 2)
    expect(dist('K')).toBeCloseTo(dist('S1'))
    expect(dist('K')).toBeGreaterThan(0)
  })
  it('puts pools beyond their parent strategy on the same bearing', () => {
    expect(dist('pool:P1')).toBeGreaterThan(dist('S1'))
    const s = positions.get('S1')
    const p = positions.get('pool:P1')
    const v = positions.get('V')
    const angS = Math.atan2(s.y - v.y, s.x - v.x)
    const angP = Math.atan2(p.y - v.y, p.x - v.x)
    expect(Math.abs(angS - angP)).toBeLessThan(0.01)
  })
})

describe('cluster layout on a wide-short canvas', () => {
  it('keeps every node (including pools) inside the [0,w] x [0,h] bounds', () => {
    const panelW = 650
    const panelH = 330
    const data = buildAutofarmGraphData({
      vaultAddress: 'V',
      keeperAddress: 'K',
      strategies: [
        { address: 'S1', poolAddress: 'P1' },
        { address: 'S2', poolAddress: 'P2' },
      ],
    })
    const { positions } = layoutGraph(data, panelW, panelH)
    positions.forEach((p, id) => {
      expect(p.x, `${id}.x within [0, ${panelW}]`).toBeGreaterThanOrEqual(0)
      expect(p.x, `${id}.x within [0, ${panelW}]`).toBeLessThanOrEqual(panelW)
      expect(p.y, `${id}.y within [0, ${panelH}]`).toBeGreaterThanOrEqual(0)
      expect(p.y, `${id}.y within [0, ${panelH}]`).toBeLessThanOrEqual(panelH)
    })
  })

  it('centers the cluster vertically — equal top and bottom gaps', () => {
    const panelW = 650
    const panelH = 330
    const data = buildAutofarmGraphData({
      vaultAddress: 'V',
      keeperAddress: 'K',
      strategies: [
        { address: 'S1', poolAddress: 'P1' },
        { address: 'S2', poolAddress: 'P2' },
      ],
    })
    const { positions } = layoutGraph(data, panelW, panelH)
    let minY = Infinity
    let maxY = -Infinity
    positions.forEach((p) => {
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    })
    const topGap = minY
    const bottomGap = panelH - maxY
    expect(Math.abs(topGap - bottomGap)).toBeLessThan(1)
    expect(topGap).toBeGreaterThanOrEqual(20)
    expect(bottomGap).toBeGreaterThanOrEqual(20)
  })
})

describe('generic layout', () => {
  it('rings by BFS depth from the highest-degree node', () => {
    const data = {
      nodes: [{ id: 'hub' }, { id: 'a' }, { id: 'b' }, { id: 'leaf' }],
      links: [
        { source: 'hub', target: 'a' },
        { source: 'hub', target: 'b' },
        { source: 'a', target: 'leaf' },
      ],
    }
    const { mode, positions } = layoutGraph(data, W, H)
    expect(mode).toBe('generic')
    const c = { x: W / 2, y: H / 2 }
    const d = (id) => Math.hypot(positions.get(id).x - c.x, positions.get(id).y - c.y)
    expect(d('hub')).toBeCloseTo(0)
    expect(d('a')).toBeCloseTo(d('b'))
    expect(d('leaf')).toBeGreaterThan(d('a'))
  })
})

describe('curve math', () => {
  it('pointOnQuadratic hits both endpoints', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 100, y: 0 }
    const c = conduitControl(a, b)
    expect(pointOnQuadratic(a, c, b, 0)).toEqual(a)
    expect(pointOnQuadratic(a, c, b, 1)).toEqual({ x: 100, y: 0 })
  })
  it('conduitControl bows the midpoint off the straight line', () => {
    const c = conduitControl({ x: 0, y: 0 }, { x: 100, y: 0 })
    expect(c.x).toBeCloseTo(50)
    expect(Math.abs(c.y)).toBeGreaterThan(0)
  })
})
