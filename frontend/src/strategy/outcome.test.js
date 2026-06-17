import { describe, it, expect } from 'vitest'
import { councilOutcome } from './outcome.js'

const agents = [{ id: 'w1' }, { id: 'w2' }]

describe('councilOutcome', () => {
  it('returns success when at least one agent confirmed', () => {
    expect(councilOutcome({ w1: { status: 'confirmed' }, w2: { status: 'failed' } }, agents)).toBe('success')
  })
  it('returns failure when all agents failed', () => {
    expect(councilOutcome({ w1: { status: 'failed' }, w2: { status: 'failed' } }, agents)).toBe('failure')
  })
  it('returns failure when nothing confirmed (idle/missing)', () => {
    expect(councilOutcome({}, agents)).toBe('failure')
  })
})
