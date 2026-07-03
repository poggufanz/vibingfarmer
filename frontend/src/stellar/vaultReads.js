// frontend/src/stellar/vaultReads.js
// Read-only Autofarm vault state for the KeeperPanel (vf-autofarm Task 15): the vault's
// exchange-rate `price_per_share()` (7-dp i128 — post-Task-6 this is NOT 1:1 with shares any
// more, see soroban/contracts/rwa_vault/src/vault.rs) and its registered `strategies()` list,
// each paired with a best-effort Blend supply-APR estimate for cross-strategy comparison.
//
// `estimateSupplyAprBps` mirrors keeper/src/chain.js's `estimateSupplyAprBps` verbatim (same
// 3-slope kinked-rate curve documented in docs/superpowers/specs/2026-07-03-vf-autofarm-design.md
// §3) — the keeper Worker and the frontend are separate npm projects with no shared package, so
// the read-only estimate is duplicated here rather than imported. It is a JUDGMENT-CALL
// approximation for display, NOT an authoritative Blend APR source (same caveat as the keeper).
// Every read here is best-effort: RPC/simulation failure returns null, never a guessed number —
// same "--" convention as ExplorerPage.jsx / HomePage.jsx.
import { readContract } from './client.js'
import { SOROBAN_AUTOFARM_VAULT_ADDRESS, SOROBAN_TOKEN_ADDRESS } from './config.js'

const SCALAR_7 = 10_000_000n
const SCALAR_12 = 1_000_000_000_000n
const BPS_DENOMINATOR = 10_000n

/**
 * Vault's `price_per_share()` — i128, 7-dp scaled (1_0000000 == 1.0000000). null on RPC failure.
 * @param {string} [vaultAddress]
 * @param {{ server?: object }} [opts]
 * @returns {Promise<bigint|null>}
 */
export async function readPricePerShare(
  vaultAddress = SOROBAN_AUTOFARM_VAULT_ADDRESS,
  { server } = {}
) {
  try {
    const v = await readContract({
      contract: vaultAddress,
      method: 'price_per_share',
      args: [],
      server,
    })
    return BigInt(v)
  } catch {
    return null
  }
}

/**
 * Vault's registered strategy addresses. [] on RPC failure — never throws (best-effort read).
 * @param {string} [vaultAddress]
 * @param {{ server?: object }} [opts]
 * @returns {Promise<string[]>}
 */
export async function readStrategies(
  vaultAddress = SOROBAN_AUTOFARM_VAULT_ADDRESS,
  { server } = {}
) {
  try {
    const v = await readContract({ contract: vaultAddress, method: 'strategies', args: [], server })
    return (v || []).map(String)
  } catch {
    return []
  }
}

/**
 * Keeper-side supply-APR ESTIMATE (bps) from Blend's reserve config/data — ported read-only from
 * keeper/src/chain.js `estimateSupplyAprBps` (kept in sync manually; no shared package between
 * the keeper Worker and this frontend). Judgment-call approximation, not authoritative.
 * @param {{config: object, data: object}} reserve Blend pool `get_reserve(asset)` return
 * @param {bigint} backstopTakeRateFraction pool `get_config()`'s `bstop_rate` (1e7 fraction)
 * @returns {number} estimated supply APR in basis points
 */
export function estimateSupplyAprBps(reserve, backstopTakeRateFraction) {
  const { config, data } = reserve
  const bSupplyUnderlying = (BigInt(data.b_supply) * BigInt(data.b_rate)) / SCALAR_12
  const dSupplyUnderlying = (BigInt(data.d_supply) * BigInt(data.d_rate)) / SCALAR_12
  if (bSupplyUnderlying <= 0n) return 0

  const util = (dSupplyUnderlying * SCALAR_7) / bSupplyUnderlying
  const targetUtil = BigInt(config.util)
  const maxUtil = BigInt(config.max_util)
  const rBase = BigInt(config.r_base)
  const rOne = BigInt(config.r_one)
  const rTwo = BigInt(config.r_two)
  const rThree = BigInt(config.r_three)

  let borrowRate
  if (util <= targetUtil) {
    borrowRate = rBase + (util * rOne) / (targetUtil || 1n)
  } else if (util <= maxUtil) {
    borrowRate = rBase + rOne + ((util - targetUtil) * rTwo) / (maxUtil - targetUtil || 1n)
  } else {
    borrowRate = rBase + rOne + rTwo + ((util - maxUtil) * rThree) / (SCALAR_7 - maxUtil || 1n)
  }
  const irMod = BigInt(data.ir_mod) // 1e7 fixed point, 1e7 == 1.0x
  const adjustedBorrowRate = (borrowRate * irMod) / SCALAR_7
  const supplyRate =
    (adjustedBorrowRate * util * (SCALAR_7 - backstopTakeRateFraction)) / (SCALAR_7 * SCALAR_7)
  return Number((supplyRate * BPS_DENOMINATOR) / SCALAR_7)
}

/**
 * Best-effort supply APR (bps) for a Blend pool's USDC reserve. null on any failure (never
 * throws — callers show "--" rather than a fake number).
 * @param {string} poolAddress
 * @param {{ token?: string, server?: object }} [opts]
 * @returns {Promise<number|null>}
 */
export async function readSupplyAprBps(
  poolAddress,
  { token = SOROBAN_TOKEN_ADDRESS, server } = {}
) {
  try {
    const reserve = await readContract({
      contract: poolAddress,
      method: 'get_reserve',
      args: [{ addr: token }],
      server,
    })
    const poolConfig = await readContract({
      contract: poolAddress,
      method: 'get_config',
      args: [],
      server,
    })
    return estimateSupplyAprBps(reserve, BigInt(poolConfig.bstop_rate))
  } catch {
    return null
  }
}
