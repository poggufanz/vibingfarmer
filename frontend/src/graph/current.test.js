import { describe, it, expect } from 'vitest'
import {
  edgeFlow,
  advanceParticles,
  spawnFor,
  MAX_PARTICLES,
  EDGE_PARTICLE_CAP,
} from './current.js'

describe('edgeFlow', () => {
  it('failed endpoint kills the edge', () => {
    expect(edgeFlow('failed', 'idle')).toBe('off')
    expect(edgeFlow('confirmed', 'failed')).toBe('off')
  })
  it('running endpoint makes it hot', () => {
    expect(edgeFlow('running', 'idle')).toBe('hot')
    expect(edgeFlow('idle', 'running')).toBe('hot')
  })
  it('both confirmed = calm, everything else = idle (static included)', () => {
    expect(edgeFlow('confirmed', 'confirmed')).toBe('calm')
    expect(edgeFlow('idle', 'idle')).toBe('idle')
    expect(edgeFlow('static', 'static')).toBe('idle')
    expect(edgeFlow('skipped', 'confirmed')).toBe('idle')
  })
})

describe('advanceParticles', () => {
  it('advances t by speed*delta and drops finished particles', () => {
    const out = advanceParticles(
      [
        { t: 0.5, speed: 0.01 },
        { t: 0.999, speed: 0.01 },
      ],
      1
    )
    expect(out).toHaveLength(1)
    expect(out[0].t).toBeCloseTo(0.51)
  })
  it('returns a new array (input untouched)', () => {
    const input = [{ t: 0.1, speed: 0.01 }]
    const out = advanceParticles(input, 1)
    expect(out).not.toBe(input)
    expect(input[0].t).toBe(0.1)
  })
})

describe('spawnFor', () => {
  it('never spawns on off edges, spawns hot particles on hot edges', () => {
    expect(spawnFor('off', () => 0)).toBeNull()
    const p = spawnFor('hot', () => 0)
    expect(p).toMatchObject({ t: 0, hot: true })
    expect(p.size).toBeGreaterThan(1)
  })
  it('respects the spawn probability', () => {
    expect(spawnFor('idle', () => 0.99)).toBeNull()
    expect(spawnFor('idle', () => 0)).not.toBeNull()
  })
  it('caps exist and are sane', () => {
    expect(MAX_PARTICLES).toBe(300)
    expect(EDGE_PARTICLE_CAP).toBeLessThan(MAX_PARTICLES)
  })
})
