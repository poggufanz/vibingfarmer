export const I128_MAX = (1n << 127n) - 1n

const UNSIGNED_DECIMAL = /^\d+(?:\.\d+)?$/

function fail(code) {
  return { ok: false, code }
}

function decimalPlaces(decimals) {
  if (typeof decimals !== 'number' || decimals < 0 || decimals % 1 !== 0) return null
  return BigInt(decimals)
}

/**
 * Format exact integer asset units as a canonical, non-localized decimal string.
 * Uses only BigInt arithmetic and string slicing.
 */
export function formatAssetUnits(units, decimals) {
  const places = decimalPlaces(decimals)
  if (places == null) throw new RangeError('Asset decimals must be a non-negative integer.')

  const value = BigInt(units)
  const negative = value < 0n
  const absolute = negative ? -value : value
  const scale = 10n ** places
  const whole = (absolute / scale).toString()
  const fraction =
    decimals === 0 ? '' : (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  const canonical = fraction ? `${whole}.${fraction}` : whole
  return negative ? `-${canonical}` : canonical
}

/**
 * Parse an unsigned decimal string into exact integer asset units.
 * The raw string is never trimmed or converted through a floating-point value.
 */
export function parseAssetUnits(raw, decimals, options = {}) {
  if (raw === '') return fail('EMPTY')
  if (typeof raw !== 'string' || !UNSIGNED_DECIMAL.test(raw)) return fail('INVALID_FORMAT')

  const places = decimalPlaces(decimals)
  if (places == null) return fail('INVALID_FORMAT')

  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length > decimals) return fail('TOO_PRECISE')

  const scale = 10n ** places
  const units = BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (units === 0n) return fail('ZERO')

  let requestedMax = I128_MAX
  if (options?.maxUnits != null) {
    try {
      requestedMax = BigInt(options.maxUnits)
    } catch {
      return fail('OVERFLOW')
    }
  }
  const effectiveMax = requestedMax < I128_MAX ? requestedMax : I128_MAX
  if (units > effectiveMax) return fail('OVERFLOW')

  if (options?.availableUnits != null) {
    let availableUnits
    try {
      availableUnits = BigInt(options.availableUnits)
    } catch {
      return fail('EXCEEDS_AVAILABLE')
    }
    if (units > availableUnits) return fail('EXCEEDS_AVAILABLE')
  }

  return { ok: true, units, canonical: formatAssetUnits(units, decimals) }
}
