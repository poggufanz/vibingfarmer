import { describe, it, expect } from 'vitest'
import * as format from './format.js'

const { toDisplay, toBaseUnits, decimalToUnits } = format

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

  it('converts a whale-sized amount to exact 7-dp base units (beyond safe float precision)', () => {
    // 123456789.1234567 * 1e7 exceeds Number.MAX_SAFE_INTEGER as a float product; decimal-string
    // arithmetic must still land on the exact bigint (never Number * 10**decimals).
    expect(toBaseUnits('123456789.1234567')).toBe(1234567891234567n)
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

describe('decimalToUnits', () => {
  it('parses a plain decimal string to exact bigint base units', () => {
    expect(decimalToUnits('0.1', 7)).toEqual({ ok: true, units: 1_000_000n })
    expect(decimalToUnits('12.5', 6)).toEqual({ ok: true, units: 12_500_000n })
    expect(decimalToUnits('-5', 7)).toEqual({ ok: true, units: -50_000_000n })
  })

  it('rounds half-up beyond the requested precision by default', () => {
    expect(decimalToUnits('1.00000005', 7)).toEqual({ ok: true, units: 10_000_001n })
    expect(decimalToUnits('1.00000004', 7)).toEqual({ ok: true, units: 10_000_000n })
  })

  it('strict mode rejects extra fractional digits instead of rounding', () => {
    expect(decimalToUnits('1.12345678', 7, { strict: true })).toEqual({
      ok: false,
      code: 'TOO_PRECISE',
    })
  })

  it('rejects empty, exponent-notation, and non-decimal input', () => {
    expect(decimalToUnits('', 7)).toEqual({ ok: false, code: 'EMPTY' })
    expect(decimalToUnits('1e5', 7)).toEqual({ ok: false, code: 'INVALID_FORMAT' })
    expect(decimalToUnits('NaN', 7)).toEqual({ ok: false, code: 'INVALID_FORMAT' })
  })
})
