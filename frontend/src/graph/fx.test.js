import { describe, it, expect } from 'vitest'
import {
  corePulseScale,
  coronaAlpha,
  settleRing,
  failFlicker,
  waveT,
  spawnDust,
  stepDust,
  DUST_COUNT,
} from './fx.js'

describe('envelopes', () => {
  it('core pulse stays within 1.00–1.04', () => {
    for (let t = 0; t < 5000; t += 97) {
      const s = corePulseScale(t)
      expect(s).toBeGreaterThanOrEqual(0.96)
      expect(s).toBeLessThanOrEqual(1.04)
    }
  })
  it('corona alpha oscillates in a visible band', () => {
    for (let t = 0; t < 3000; t += 53) {
      const a = coronaAlpha(t)
      expect(a).toBeGreaterThan(0.1)
      expect(a).toBeLessThan(0.6)
    }
  })
  it('settleRing expands, fades, then ends', () => {
    const start = settleRing(0)
    const mid = settleRing(350)
    expect(start.scale).toBeLessThan(mid.scale)
    expect(start.alpha).toBeGreaterThan(mid.alpha)
    expect(settleRing(700)).toBeNull()
  })
  it('failFlicker toggles then ends', () => {
    expect(failFlicker(0).alpha).not.toBe(failFlicker(160).alpha)
    expect(failFlicker(900)).toBeNull()
  })
  it('waveT runs 0→1 over its duration then ends', () => {
    expect(waveT(0)).toBe(0)
    expect(waveT(1250)).toBeCloseTo(0.5)
    expect(waveT(2500)).toBeNull()
  })
})

describe('dust', () => {
  it('spawns DUST_COUNT specks within bounds', () => {
    const dust = spawnDust(200, 100, DUST_COUNT, () => 0.5)
    expect(dust).toHaveLength(DUST_COUNT)
    dust.forEach((d) => {
      expect(d.x).toBeGreaterThanOrEqual(0)
      expect(d.x).toBeLessThanOrEqual(200)
      expect(d.alpha).toBeGreaterThan(0)
    })
  })
  it('drifts and wraps around edges', () => {
    const moved = stepDust([{ x: 199.9, y: 50, vx: 1, vy: 0, size: 1, alpha: 0.1 }], 1, 200, 100)
    expect(moved[0].x).toBeGreaterThanOrEqual(0)
    expect(moved[0].x).toBeLessThan(200)
  })
})
