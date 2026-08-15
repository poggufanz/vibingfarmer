import { SOROBAN_DECIMALS } from './config.js'

export const BASE_UNIT = 10 ** SOROBAN_DECIMALS // 1e7 — 7-dp token base unit
const CCTP_UNIT = BASE_UNIT / 10 // CCTP messages use 6dp

const DECIMAL_STR_RE = /^-?\d+(\.\d+)?$/

/**
 * Decimal string (or number, stringified) -> bigint at `decimals` precision via exact string
 * arithmetic — never `Number(amount) * 10**decimals`, which is float multiplication on the
 * exact amount that ends up as a grant/burn unit (strategist.js's `stellarUnits: toBaseUnits(amount)`
 * feeds straight into planModel.expandAgentSlots' bigint agent caps). `strict: true` rejects
 * extra fractional digits instead of rounding them away (parseUsdcInput's user-input contract,
 * strategy/amountValidation.js); the default rounds half-up, matching this module's pre-existing
 * `toBaseUnits` contract. Returns `{ ok: false }` for anything that isn't a plain decimal string
 * (empty, exponent notation, NaN, garbage) — callers decide how to handle that themselves.
 * @param {string|number} value
 * @param {number} decimals
 * @param {{ strict?: boolean }} [opts]
 * @returns {{ok:true, units:bigint}|{ok:false, code:'EMPTY'|'INVALID_FORMAT'|'TOO_PRECISE'}}
 */
export function decimalToUnits(value, decimals, { strict = false } = {}) {
  const str = typeof value === 'string' ? value.trim() : String(value ?? '')
  if (!str) return { ok: false, code: 'EMPTY' }
  if (!DECIMAL_STR_RE.test(str)) return { ok: false, code: 'INVALID_FORMAT' }
  const neg = str[0] === '-'
  const unsigned = neg ? str.slice(1) : str
  const [whole, frac = ''] = unsigned.split('.')
  if (strict && frac.length > decimals) return { ok: false, code: 'TOO_PRECISE' }
  let units = BigInt(whole || '0') * 10n ** BigInt(decimals)
  const kept = frac.slice(0, decimals).padEnd(decimals, '0')
  if (kept) units += BigInt(kept)
  if (!strict) {
    const nextChar = frac[decimals]
    if (nextChar && nextChar >= '5') units += 1n
  }
  return { ok: true, units: neg ? -units : units }
}

// 7-dp base units (string | number | bigint) -> human number for display
export function toDisplay(units) {
  return Number(units || 0) / BASE_UNIT
}

// human USDC amount -> 7-dp base-unit bigint (for on-chain writes / caps). Decimal-safe for any
// plain decimal string/number; falls back to the previous float path only for what
// decimalToUnits refuses (exponent notation, non-finite) — this is an internal conversion
// helper, not user-input validation (that's strategy/amountValidation.js's parseUsdcInput), so
// it tolerates whatever Number(amount) can coerce rather than throwing.
export function toBaseUnits(amount) {
  const r = decimalToUnits(amount, SOROBAN_DECIMALS)
  if (r.ok) return r.units
  return BigInt(Math.round(Number(amount || 0) * BASE_UNIT))
}

/**
 * Derive the exact source/destination amounts for Stellar -> CCTP. Circle messages use 6dp, so
 * the Stellar burn is deliberately restricted to a multiple of 10 in Stellar's 7dp units; any
 * seventh-decimal remainder stays in the user's wallet instead of being burned as unusable dust.
 * https://developers.circle.com/cctp/references/stellar
 */
export function deriveCctpTransferUnits(amount) {
  const numericAmount = Number(amount)
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('CCTP amount must be a finite positive safe number')
  }
  const flooredTargetUnits6 = Math.floor(numericAmount * CCTP_UNIT)
  const flooredRequestedUnits7 = Math.floor(numericAmount * BASE_UNIT)
  if (!Number.isSafeInteger(flooredTargetUnits6) || !Number.isSafeInteger(flooredRequestedUnits7)) {
    throw new Error('CCTP amount must be a finite positive safe number')
  }
  const baseTargetUnits6 = BigInt(flooredTargetUnits6)
  if (baseTargetUnits6 <= 0n) {
    throw new Error('Amount must contain at least one six-decimal CCTP unit')
  }
  const burnUnits7 = baseTargetUnits6 * 10n
  const requestedUnits7 = BigInt(flooredRequestedUnits7)
  return {
    requestedUnits7,
    baseTargetUnits6,
    burnUnits7,
    retainedDustUnits7: requestedUnits7 - burnUnits7,
  }
}
