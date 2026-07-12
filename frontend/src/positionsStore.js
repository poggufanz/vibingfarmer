// positionsStore.js
// Position persistence + chain reconciliation, keyed by wallet address.
//
// Why: agentData.positions was session-only in-memory state. On reload/reconnect
// it reset to {}, so the home page looked like the user never farmed. This module
// (1) caches positions in localStorage for instant restore, and
// (2) reconciles against on-chain balances (source of truth) in the background.
//
// Stellar model: vault shares are held by the agent custom account (deposit mints
// to `from` = the agent), NOT the user — the user exits via owner_withdraw. So a
// "position" is read as the agent's vault-share balance. The demo uses one agent
// (SOROBAN_DEMO_AGENT) + one vault; pass `agents` for a multi-agent session.

import { SOROBAN_ACTIVE_VAULT_ADDRESS, SOROBAN_DEMO_AGENT } from './stellar/config.js'
import { readVaultShares } from './stellar/agentDeposit.js'
import { readPricePerShare } from './stellar/vaultReads.js'

const PPS_SCALE = 10_000_000n // price_per_share is 7-dp fixed point (1_0000000 == 1.0)

// Single demo vault has no on-chain name field — label it for the positions list.
const VAULT_NAME = 'VFUSD Yield Vault'

const keyFor = (addr) => `yv_positions_${String(addr).toLowerCase()}`

/** Restore last-known positions for an address from localStorage (sync, instant). */
export function loadPersistedPositions(address) {
  if (!address) return {}
  try {
    return JSON.parse(localStorage.getItem(keyFor(address)) || '{}') || {}
  } catch {
    return {}
  }
}

/** Persist a positions map for an address. Safe to call with an empty map. */
export function persistPositions(address, positions) {
  if (!address) return
  try {
    localStorage.setItem(keyFor(address), JSON.stringify(positions || {}))
  } catch {
    // localStorage unavailable/full — non-fatal, positions still live in memory.
  }
}

/**
 * Reconcile positions against the Stellar vault. Sums the vault-share balance across
 * every agent the user funded (shares are i128 base units, 7-dp). Returns a positions
 * map ({ [vaultAddr]: { vaultName, balance, unclaimedRewards } }), or null when EVERY
 * read fails so callers keep the cached snapshot instead of wiping it.
 *
 * A balance of '0' is an explicit entry (not absent) so an authoritative consumer
 * (applyChainPositions) can PRUNE a fully-swept vault. readVaultShares returns null on
 * RPC failure (it catches), so a transient failure stays out of the total — never
 * mistaken for a withdrawal.
 *
 * @param {string} address - connected user wallet (kept for caller/localStorage compat)
 * @param {{ agents?: string[], server?: object }} [opts]
 * @returns {Promise<Object|null>}
 */
export async function reconcilePositionsFromChain(
  address,
  { agents = [SOROBAN_DEMO_AGENT], server } = {}
) {
  if (!address) return null

  const results = await Promise.allSettled(
    agents.map((agent) => readVaultShares(agent, { server }))
  )

  let anyOk = false
  let total = 0n
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value != null) {
      anyOk = true
      total += BigInt(r.value)
    }
  }
  if (!anyOk) return null

  // Autofarm vault shares are exchange-rate priced (NOT 1:1 with USDC) — convert to asset
  // value via price_per_share so `balance` stays in the asset base units every display and
  // seed path already uses. pps read failure → null (keep the cached snapshot; a 1:1 guess
  // would silently misreport value).
  let assets = 0n
  if (total > 0n) {
    const pps = await readPricePerShare(SOROBAN_ACTIVE_VAULT_ADDRESS, { server })
    if (pps == null) return null
    assets = (total * pps) / PPS_SCALE
  }

  // ponytail: balance is base-unit (7-dp) string — render sites must divide by 1e7
  // (SOROBAN_DECIMALS), not the legacy EVM 1e6. Single vault for the demo.
  return {
    [SOROBAN_ACTIVE_VAULT_ADDRESS]: {
      vaultName: VAULT_NAME,
      balance: assets.toString(),
      shares: total.toString(),
      unclaimedRewards: '0',
    },
  }
}

/**
 * Choose which agents' vault shares represent the user's positions. View-as (dev) reads the
 * impersonated address's OWN shares; a real run reads the per-run agents the router deployed
 * (scopes[].agent, non-revoked) — where deposit mints the shares. Returns undefined when there
 * is nothing better yet (e.g. before scopes have rehydrated) so reconcile keeps its default.
 *
 * @param {Array<{agent?: string, revoked?: boolean}>} scopes
 * @param {string} [viewAsAddress]
 * @returns {string[]|undefined}
 */
export function pickPositionsAgents(scopes, viewAsAddress) {
  if (viewAsAddress) return [viewAsAddress]
  const deployed = (scopes || []).filter((s) => s && !s.revoked && s.agent).map((s) => s.agent)
  return deployed.length ? deployed : undefined
}

// Merge position maps keyed by vault address (case-insensitive). Balances only ever
// INCREASE via merge — withdraw handlers are the only path that lowers them. Idempotent:
// re-running with the same seed (e.g. re-visiting "done") can't double or drop a balance,
// and a worker's on-chain 0 (deposit not yet mined) can't wipe a seeded position.
export function mergePositions(prev, incoming) {
  const merged = { ...(prev || {}) }
  for (const [addr, pos] of Object.entries(incoming || {})) {
    if (!pos) continue
    const key = Object.keys(merged).find((k) => k.toLowerCase() === addr.toLowerCase()) || addr
    const curBal = BigInt(merged[key]?.balance || '0')
    const newBal = BigInt(pos.balance || '0')
    merged[key] = {
      ...merged[key],
      ...pos,
      balance: (newBal > curBal ? newBal : curBal).toString(),
    }
  }
  return merged
}

// Authoritatively apply on-chain positions over the current map: REPLACES balances for
// returned vaults (can move down, e.g. after a withdraw) and DELETES any vault the chain
// reports as '0' (fully withdrawn). Vaults absent from the chain map (read failed) are left
// untouched. Use only when chain is proven-current — e.g. right after a Deposit/Withdraw
// event or on cold reconnect — never for speculative/seeded values.
export function applyChainPositions(prev, chain) {
  const positions = { ...(prev || {}) }
  for (const [addr, pos] of Object.entries(chain || {})) {
    if (!pos) continue
    const key = Object.keys(positions).find((k) => k.toLowerCase() === addr.toLowerCase()) || addr
    if (BigInt(pos.balance || '0') === 0n) {
      delete positions[key]
      continue
    }
    positions[key] = { ...positions[key], ...pos }
  }
  return positions
}
