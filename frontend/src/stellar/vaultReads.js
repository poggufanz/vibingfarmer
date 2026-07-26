// frontend/src/stellar/vaultReads.js
// Read-only Autofarm vault state for the KeeperPanel (vf-autofarm Task 15): the vault's
// exchange-rate `price_per_share()` (7-dp i128 — post-Task-6 this is NOT 1:1 with shares any
// more, see soroban/contracts/autofarm_vault/src/vault.rs), paired with a best-effort Blend
// supply-APR estimate. My Money Task 13 fix loop 1, M2: `readStrategies` (the vault's registered
// `strategies()` list) is removed — its only consumer was the vault-wide automation-topology graph
// dropped in the same task (app.jsx's own comment there names the fetch as removed, not preserved
// dormant); it had zero production callers left. Re-add it if that topology view returns.
//
// `estimateSupplyAprBps` is re-exported from `keeper/src/apr.js` (T2 Fix 3 dedup) via a relative
// cross-package import — it used to be duplicated here verbatim, which is exactly the drift risk
// this import removes. The keeper Worker and this frontend are separate npm projects with no
// shared package; a plain relative import across the two resolves fine at `vitest` and
// `vite build` time (apr.js has zero external deps, nothing for the bundler to choke on). Under
// `vite dev` it additionally needs the repo-root `server.fs.allow` widening in vite.config.js —
// otherwise Vite's default fs boundary 403s the /@fs/ request for a path outside frontend/ (this
// was missing and has been fixed there). So no re-export shim or duplicate-plus-drift-guard
// fallback was needed. It is a
// JUDGMENT-CALL approximation for display, NOT an authoritative Blend APR source (same caveat as
// the keeper). Every read here is best-effort: RPC/simulation failure returns null, never a
// guessed number — same "--" convention as ExplorerPage.jsx / HomePage.jsx.
import { readContract } from './client.js'
import { SOROBAN_AUTOFARM_VAULT_ADDRESS, SOROBAN_TOKEN_ADDRESS } from './config.js'
import { estimateSupplyAprBps } from '../../../keeper/src/apr.js'

export { estimateSupplyAprBps }

// price_per_share() is 7-dp fixed point (1_0000000 == 1.0000000) — same scale partialWithdraw.js
// already uses for its own maxUnits calc. Kept private: sharesToAssetUnits below is the one
// shared, tested place this conversion happens; no second copy should grow elsewhere.
const PPS_SCALE = 10_000_000n

/**
 * Convert a vault share balance into its current token-unit value via `price_per_share()`.
 * Returns null when the conversion cannot be trusted: a positive share count with an unknown
 * price (`pps` null, i.e. the price_per_share RPC failed) is a share COUNT, not a token VALUE —
 * guessing one (e.g. treating it as 1:1) would render money that was never confirmed (see
 * money/readOwnerMoney.js, Pocket Crew Task 7). `shares === 0n` is trivially worth 0 regardless
 * of whether `pps` is known — a known zero is zero, it needs no price to state.
 * @param {bigint} shares
 * @param {bigint|null} pps
 * @returns {bigint|null}
 */
export function sharesToAssetUnits(shares, pps) {
  if (shares === 0n) return 0n
  if (pps == null) return null
  return (shares * pps) / PPS_SCALE
}

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
 * Vault's `total_assets()` — idle USDC held by the vault plus every strategy's reported balance
 * (i128, token base units, 7-dp). This is the vault's real TVL, independent of any single
 * depositor. null on RPC failure.
 * @param {string} [vaultAddress]
 * @param {{ server?: object }} [opts]
 * @returns {Promise<bigint|null>}
 */
export async function readTotalAssets(
  vaultAddress = SOROBAN_AUTOFARM_VAULT_ADDRESS,
  { server } = {}
) {
  try {
    const v = await readContract({
      contract: vaultAddress,
      method: 'total_assets',
      args: [],
      server,
    })
    return BigInt(v)
  } catch {
    return null
  }
}

/**
 * Vault's `total_shares()` — i128, the share ledger's total supply (`Base::total_supply`,
 * see soroban/contracts/autofarm_vault/src/lib.rs). Authoritative source for whether the vault
 * has ever taken a deposit: 0n means the NEXT deposit is the on-chain first-depositor path
 * (MIN_FIRST_DEPOSIT applies, vault.rs), a positive value means it does not. null on RPC
 * failure — callers (strategy/amountValidation.js) must treat null as genuinely unknown, never
 * coerce it to 0n (that would wrongly re-impose the first-deposit minimum on a seeded vault) or
 * to a positive assumption (that would wrongly skip it on an empty one).
 * @param {string} [vaultAddress]
 * @param {{ server?: object }} [opts]
 * @returns {Promise<bigint|null>}
 */
export async function readTotalShares(
  vaultAddress = SOROBAN_AUTOFARM_VAULT_ADDRESS,
  { server } = {}
) {
  try {
    const v = await readContract({
      contract: vaultAddress,
      method: 'total_shares',
      args: [],
      server,
    })
    return BigInt(v)
  } catch {
    return null
  }
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

/**
 * Vault lifeboat state — { derisked, mandateExpiry, authority } or null on RPC failure
 * (callers render "--" / unknown, never a guessed state).
 * @param {string} [vaultAddress]
 * @param {{ server?: object }} [opts]
 * @returns {Promise<{derisked: boolean, mandateExpiry: number, authority: string|null}|null>}
 */
export async function readLifeboatState(
  vaultAddress = SOROBAN_AUTOFARM_VAULT_ADDRESS,
  { server } = {}
) {
  try {
    const v = await readContract({
      contract: vaultAddress,
      method: 'lifeboat_state',
      args: [],
      server,
    })
    return {
      derisked: Boolean(v.derisked),
      mandateExpiry: Number(v.mandate_expiry),
      authority: v.authority == null ? null : String(v.authority),
    }
  } catch {
    return null
  }
}

/**
 * Vault's pending timelocked upgrade (surface-only — see UpgradeNoticeBanner-equivalent in
 * HomePage.jsx; nothing here ever writes on-chain). `pending_upgrade()` returns
 * `Option<PendingUpgrade>` — decodes to null/undefined when nothing is scheduled (`== null`
 * catches both), same Option convention as readLifeboatState's `authority`. null is also
 * returned on RPC failure — never a guessed state.
 * @param {string} [vaultAddress]
 * @param {{ server?: object }} [opts]
 * @returns {Promise<{wasmHashHex: string, eta: number}|null>}
 */
export async function readPendingUpgrade(
  vaultAddress = SOROBAN_AUTOFARM_VAULT_ADDRESS,
  { server } = {}
) {
  try {
    const v = await readContract({
      contract: vaultAddress,
      method: 'pending_upgrade',
      args: [],
      server,
    })
    if (v == null) return null
    return {
      wasmHashHex: Buffer.from(v.wasm_hash).toString('hex'),
      eta: Number(v.eta),
    }
  } catch {
    return null
  }
}
