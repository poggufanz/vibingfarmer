// keeper/src/apr.js — Blend v2 supply-APR estimate, pure (no I/O, no SDK imports).
//
// Extracted out of chain.js (T2 Fix 3) so it has exactly one implementation: chain.js imports it
// for the live keeper decision loop, and frontend/src/stellar/vaultReads.js imports the SAME file
// via a relative cross-package path for the read-only KeeperPanel display — see that file's
// header for why there's no shared npm package between the two projects instead.
//
// Blend v2 fixed-point scales (see docs/superpowers/specs/2026-07-03-vf-autofarm-design.md §3):
// config fractions (util/IR breakpoints) are 1e7 scale; b_rate/d_rate are 1e12 scale.
const SCALAR_7 = 10_000_000n;
const SCALAR_12 = 1_000_000_000_000n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Keeper-side supply-APR ESTIMATE (bps) from Blend's reserve config/data, using the 3-slope
 * kinked-rate curve documented in docs/superpowers/specs/2026-07-03-vf-autofarm-design.md §3
 * (`pool/src/pool/reserve.rs`). This is a JUDGMENT-CALL approximation for cross-strategy
 * rebalance comparison, NOT an authoritative Blend APR source. With only one live strategy
 * today, `decide()`'s rebalance branch never fires regardless of this value (`highest ===
 * lowest` short-circuits — see decide.js `findAprExtremes`/`decideRebalance`); this exists so a
 * future second strategy has a real number to compare against, not a placeholder.
 * @param {{config: object, data: object}} reserve Blend pool `get_reserve(asset)` return
 * @param {bigint} backstopTakeRateFraction pool `get_config()`'s `bstop_rate` (1e7 fraction)
 * @returns {number} estimated supply APR in basis points
 */
export function estimateSupplyAprBps(reserve, backstopTakeRateFraction) {
  const { config, data } = reserve;
  const bSupplyUnderlying = (BigInt(data.b_supply) * BigInt(data.b_rate)) / SCALAR_12;
  const dSupplyUnderlying = (BigInt(data.d_supply) * BigInt(data.d_rate)) / SCALAR_12;
  if (bSupplyUnderlying <= 0n) return 0;

  const util = (dSupplyUnderlying * SCALAR_7) / bSupplyUnderlying;
  const targetUtil = BigInt(config.util);
  const maxUtil = BigInt(config.max_util);
  const rBase = BigInt(config.r_base);
  const rOne = BigInt(config.r_one);
  const rTwo = BigInt(config.r_two);
  const rThree = BigInt(config.r_three);

  let borrowRate;
  if (util <= targetUtil) {
    borrowRate = rBase + (util * rOne) / (targetUtil || 1n);
  } else if (util <= maxUtil) {
    borrowRate = rBase + rOne + ((util - targetUtil) * rTwo) / ((maxUtil - targetUtil) || 1n);
  } else {
    borrowRate = rBase + rOne + rTwo + ((util - maxUtil) * rThree) / ((SCALAR_7 - maxUtil) || 1n);
  }
  const irMod = BigInt(data.ir_mod); // 1e7 fixed point, 1e7 == 1.0x (no reactivity adjustment yet)
  const adjustedBorrowRate = (borrowRate * irMod) / SCALAR_7;
  const supplyRate = (adjustedBorrowRate * util * (SCALAR_7 - backstopTakeRateFraction)) / (SCALAR_7 * SCALAR_7);
  return Number((supplyRate * BPS_DENOMINATOR) / SCALAR_7);
}
