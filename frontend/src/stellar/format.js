import { SOROBAN_DECIMALS } from './config.js'

export const BASE_UNIT = 10 ** SOROBAN_DECIMALS // 1e7 — 7-dp token base unit

// 7-dp base units (string | number | bigint) -> human number for display
export function toDisplay(units) {
  return Number(units || 0) / BASE_UNIT
}

// human USDC amount -> 7-dp base-unit bigint (for on-chain writes / caps)
export function toBaseUnits(amount) {
  return BigInt(Math.round(Number(amount || 0) * BASE_UNIT))
}
