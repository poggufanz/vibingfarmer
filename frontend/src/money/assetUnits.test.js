import { describe, expect, test } from 'vitest'
import { I128_MAX, formatAssetUnits, parseAssetUnits } from './assetUnits.js'

describe('parseAssetUnits', () => {
  // Defect: a smallest-possible Stellar amount can be rounded to zero by a floating-point path.
  test('parses one stroop exactly', () => {
    expect(parseAssetUnits('0.0000001', 7)).toEqual({
      ok: true,
      units: 1n,
      canonical: '0.0000001',
    })
  })

  // Defect: an unchecked decimal can exceed the signed i128 accepted by Soroban.
  test('accepts the exact i128 maximum and rejects one unit above it', () => {
    expect(
      parseAssetUnits('17014118346046923173168730371588.4105727', 7, {
        maxUnits: I128_MAX,
      })
    ).toEqual({
      ok: true,
      units: 170141183460469231731687303715884105727n,
      canonical: '17014118346046923173168730371588.4105727',
    })
    expect(
      parseAssetUnits('17014118346046923173168730371588.4105728', 7, {
        maxUnits: I128_MAX,
      })
    ).toMatchObject({
      ok: false,
      code: 'OVERFLOW',
    })
    expect(I128_MAX).toBe(170141183460469231731687303715884105727n)
  })

  // Defect: a rounded comparison can admit one base unit more than the confirmed balance.
  test('accepts the exact available balance and rejects one unit above it', () => {
    expect(parseAssetUnits('12.345678', 6, { availableUnits: '12345678' })).toEqual({
      ok: true,
      units: 12345678n,
      canonical: '12.345678',
    })
    expect(parseAssetUnits('12.345679', 6, { availableUnits: 12345678n })).toMatchObject({
      ok: false,
      code: 'EXCEEDS_AVAILABLE',
    })
  })

  // Defect: six- and seven-decimal assets can be silently scaled by the wrong power of ten.
  test('round-trips six- and seven-decimal asset units with literal expected strings', () => {
    expect(formatAssetUnits(12345678n, 6)).toBe('12.345678')
    expect(parseAssetUnits('12.345678', 6)).toMatchObject({ ok: true, units: 12345678n })
    expect(formatAssetUnits(123456789n, 7)).toBe('12.3456789')
    expect(parseAssetUnits('12.3456789', 7)).toMatchObject({ ok: true, units: 123456789n })
  })

  // Defect: leading and trailing zeroes can leak a non-canonical amount into review or submission.
  test('canonicalizes leading and trailing zeroes without changing units', () => {
    expect(parseAssetUnits('00012.3400000', 7)).toEqual({
      ok: true,
      units: 123400000n,
      canonical: '12.34',
    })
    expect(formatAssetUnits(123400000n, 7)).toBe('12.34')
  })

  // Defect: syntactically valid zero amounts can reach an on-chain positive-amount requirement.
  test('rejects every decimal spelling of zero', () => {
    expect(parseAssetUnits('0', 7)).toMatchObject({ ok: false, code: 'ZERO' })
    expect(parseAssetUnits('000.0000000', 7)).toMatchObject({ ok: false, code: 'ZERO' })
  })

  // Defect: trimming user input changes the raw string contract and admits whitespace-padded data.
  test('distinguishes an empty input from invalid whitespace', () => {
    expect(parseAssetUnits('', 7)).toMatchObject({ ok: false, code: 'EMPTY' })
    expect(parseAssetUnits(' ', 7)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' })
    expect(parseAssetUnits(' 1', 7)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' })
    expect(parseAssetUnits('1 ', 7)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' })
  })

  // Defect: unary signs can expand the accepted grammar beyond unsigned asset amounts.
  test('rejects positive and negative signs', () => {
    expect(parseAssetUnits('+1', 7)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' })
    expect(parseAssetUnits('-1', 7)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' })
  })

  // Defect: JavaScript numeric spellings can be coerced into unintended asset amounts.
  test('rejects exponent, comma, NaN, Infinity, and incomplete decimal formats', () => {
    for (const raw of ['1e3', '1,000', 'NaN', 'Infinity', '.1', '1.']) {
      expect(parseAssetUnits(raw, 7)).toMatchObject({ ok: false, code: 'INVALID_FORMAT' })
    }
  })

  // Defect: rounding excess fractional digits spends a different amount than the owner typed.
  test('rejects fractional precision beyond the selected asset decimals', () => {
    expect(parseAssetUnits('1.12345678', 7)).toMatchObject({
      ok: false,
      code: 'TOO_PRECISE',
    })
    expect(parseAssetUnits('1.0000000', 6)).toMatchObject({
      ok: false,
      code: 'TOO_PRECISE',
    })
  })
})

describe('formatAssetUnits', () => {
  // Defect: zero formatting can emit a locale-sensitive or fractional representation.
  test('formats zero canonically', () => {
    expect(formatAssetUnits(0n, 7)).toBe('0')
  })
})
