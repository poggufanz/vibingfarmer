import { describe, it, expect } from 'vitest'
import * as format from './format.js'

const { toDisplay, toBaseUnits } = format

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

  it('derives a six-decimal CCTP target and a divisible Stellar burn while retaining seventh-decimal dust', () => {
    expect(format.deriveCctpTransferUnits(0.1234567)).toEqual({
      requestedUnits7: 1_234_567n,
      baseTargetUnits6: 123_456n,
      burnUnits7: 1_234_560n,
      retainedDustUnits7: 7n,
    })
  })

  it('rejects a transfer too small to produce one six-decimal CCTP unit', () => {
    expect(() => format.deriveCctpTransferUnits(0.00000009)).toThrow(
      /at least one six-decimal CCTP unit/i
    )
  })

  it('floors precision beyond 7dp so the boundary never debits more than the typed amount', () => {
    const amount = 0.12345679
    const units = format.deriveCctpTransferUnits(amount)

    expect(units).toEqual({
      requestedUnits7: 1_234_567n,
      baseTargetUnits6: 123_456n,
      burnUnits7: 1_234_560n,
      retainedDustUnits7: 7n,
    })
    expect(Number(units.burnUnits7) / 10_000_000).toBeLessThanOrEqual(amount)
  })

  it('rejects nonfinite, nonpositive, and unsafe transfer inputs', () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, Number.MAX_SAFE_INTEGER]) {
      expect(() => format.deriveCctpTransferUnits(amount)).toThrow(/finite positive safe/i)
    }
  })
})
