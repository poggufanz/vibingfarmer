import { describe, it, expect } from 'vitest'
import { toDisplay, toBaseUnits } from './format.js'

describe('format (7-dp)', () => {
  it('renders 1e7 base units as 1', () => {
    expect(toDisplay('10000000')).toBe(1)
  })
  it('handles 0 / null / undefined safely', () => {
    expect(toDisplay(0)).toBe(0)
    expect(toDisplay(null)).toBe(0)
    expect(toDisplay(undefined)).toBe(0)
  })
  it('converts a human USDC amount to 7-dp base units', () => {
    expect(toBaseUnits(1).toString()).toBe('10000000')
    expect(toBaseUnits(100).toString()).toBe('1000000000')
  })
})
