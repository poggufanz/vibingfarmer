import { SOROBAN_DECIMALS } from './config.js'

export const BASE_UNIT = 10 ** SOROBAN_DECIMALS // 1e7 — 7-dp token base unit
const CCTP_UNIT = BASE_UNIT / 10 // CCTP messages use 6dp

// 7-dp base units (string | number | bigint) -> human number for display
export function toDisplay(units) {
  return Number(units || 0) / BASE_UNIT
}

// human USDC amount -> 7-dp base-unit bigint (for on-chain writes / caps)
export function toBaseUnits(amount) {
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
