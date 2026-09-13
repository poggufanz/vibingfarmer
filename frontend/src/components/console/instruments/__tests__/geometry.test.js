// frontend/src/components/console/instruments/geometry.test.js
import { describe, it, expect } from 'vitest'
import {
  ekgGeometry,
  dialGeometry,
  radarBlipPoints,
  gaugeRatio,
  ppsSparklineGeometry,
} from '../geometry.js'

describe('ekgGeometry', () => {
  it('builds a path with one beat per row, newest at the right', () => {
    const rows = [{ verdict: 'keep' }, { verdict: 'discard' }] // newest first
    const g = ekgGeometry(rows, { width: 200, height: 50 })
    expect(g.path.startsWith('M')).toBe(true)
    expect(g.markers).toHaveLength(1) // only the discard marks
    expect(g.markers[0].verdict).toBe('discard')
  })
  it('flat baseline when no rows', () => {
    const g = ekgGeometry([], { width: 200, height: 50 })
    expect(g.path).toBe('M0,31 L200,31') // baseline = height * 0.62 rounded
    expect(g.markers).toHaveLength(0)
  })
})

describe('dialGeometry', () => {
  it('maps apr onto -90..90 with a rounded nice max', () => {
    const g = dialGeometry(7.5, { size: 180 })
    expect(g.max).toBe(15) // ceil(11.25/5)*5
    expect(g.angle).toBeCloseTo(-90 + (7.5 / 15) * 180, 5)
  })
  it('null apr parks the needle at min', () => {
    expect(dialGeometry(null, { size: 180 }).angle).toBe(-90)
  })
})

describe('radarBlipPoints', () => {
  const now = 1_000_000_000_000
  it('plots only recent derisk events, older farther from center', () => {
    const evs = [
      { type: 'derisk', txHash: 'a', timestamp: now - 1000 },
      { type: 'resume', txHash: 'b', timestamp: now - 1000 },
      { type: 'derisk', txHash: 'c', timestamp: now - 90_000_000_000 }, // > 24h → dropped
    ]
    const pts = radarBlipPoints(evs, { nowMs: now, size: 180 })
    expect(pts).toHaveLength(1)
    expect(pts[0].type).toBe('derisk')
    expect(pts[0].ageFrac).toBeGreaterThanOrEqual(0)
  })
})

describe('gaugeRatio', () => {
  it('clamps to 0..1 and handles zero max', () => {
    expect(gaugeRatio(50, 100)).toBe(0.5)
    expect(gaugeRatio(200, 100)).toBe(1)
    expect(gaugeRatio(10, 0)).toBe(0)
  })
})

describe('ppsSparklineGeometry', () => {
  it('flat mid-line baseline when empty', () => {
    const g = ppsSparklineGeometry([], { width: 260, height: 56 })
    expect(g).toEqual({ path: 'M0,28 L260,28', empty: true })
  })

  it('maps a rising series onto an ascending left-to-right path', () => {
    const g = ppsSparklineGeometry([1.0, 1.01, 1.02], { width: 200, height: 50 })
    expect(g.empty).toBe(false)
    const ys = [...g.path.matchAll(/L?([\d.]+),([\d.]+)/g)].map((m) => Number(m[2]))
    expect(ys).toHaveLength(3)
    expect(ys[0]).toBeGreaterThan(ys[1])
    expect(ys[1]).toBeGreaterThan(ys[2]) // SVG y grows downward
    expect(g.path).toMatch(/L200,\d/)
    expect(g.path.startsWith('M0,')).toBe(true)
  })

  it('flat mid-line (not empty) for a constant series', () => {
    const g = ppsSparklineGeometry([1.5, 1.5, 1.5], { width: 200, height: 50 })
    expect(g.empty).toBe(false)
    const ys = new Set([...g.path.matchAll(/,([\d.]+)/g)].map((m) => m[1]))
    expect(ys).toEqual(new Set(['25']))
  })

  it('downsamples long series to at most maxPoints vertices', () => {
    const values = Array.from({ length: 500 }, (_, i) => 1 + i / 1000)
    const g = ppsSparklineGeometry(values, { width: 260, height: 56, maxPoints: 60 })
    const vertices = (g.path.match(/L/g) || []).length + 1
    expect(vertices).toBeLessThanOrEqual(60)
  })

  it('ignores non-finite entries rather than breaking the path', () => {
    const g = ppsSparklineGeometry([1.0, NaN, 1.02], { width: 200, height: 50 })
    expect(g.empty).toBe(false)
    expect(g.path).not.toMatch(/NaN/)
  })
})
