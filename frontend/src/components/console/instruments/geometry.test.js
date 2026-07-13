// frontend/src/components/console/instruments/geometry.test.js
import { describe, it, expect } from 'vitest'
import { ekgGeometry, dialGeometry, radarBlipPoints, gaugeRatio } from './geometry.js'

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
