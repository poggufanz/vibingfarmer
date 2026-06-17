// positionsStore.js
// Position persistence + chain reconciliation, keyed by wallet address.
//
// Why: agentData.positions was session-only in-memory state. On reload/reconnect
// it reset to {}, so the home page looked like the user never farmed. This module
// (1) caches positions in localStorage for instant restore, and
// (2) reconciles against on-chain balances (source of truth) in the background.

import { ethers } from 'ethers'
import { VAULT_CATALOG, VAULT_ABI } from './config.js'
import { getReadProvider } from './readProvider.js'

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
 * Reconcile positions against chain. Reads balanceOf + convertToAssets per unique
 * vault. Returns a positions map ({ [vaultAddr]: { vaultName, balance, unclaimedRewards } }),
 * or null when all reads fail.
 *
 * Successfully-read vaults are ALWAYS included — including those with balance '0'. The
 * zero entries are how an authoritative consumer (applyChainPositions) learns a vault was
 * fully withdrawn and must be PRUNED. A read that throws stays absent (vs. an explicit '0'),
 * so a transient RPC failure can never be mistaken for a withdrawal.
 *
 * Reads go through the dedicated read-only provider (getReadProvider) — NEVER the
 * wallet's BrowserProvider, which throws -32603 while a wallet_* RPC is pending.
 * Never throws — per-vault failures are isolated via Promise.allSettled.
 *
 * When batch txs contain multiple internal deposit calls, each call emits a separate
 * DepositExecuted event. The on-chain balance read reflects all of them, so we must
 * read from ALL vaults in VAULT_CATALOG to capture all deposits across all tx hashes.
 */
export async function reconcilePositionsFromChain(address) {
  if (!address) return null
  const provider = getReadProvider()

  // Unique vault addresses (catalog maps multiple protocols to shared MockVaults).
  // CRITICAL: must read from ALL unique vaults to capture deposits from all tx hashes.
  const seen = new Set()
  const vaults = VAULT_CATALOG.filter((v) => {
    const a = v.address?.toLowerCase()
    if (!a || seen.has(a)) return false
    seen.add(a)
    return true
  })

  const results = await Promise.allSettled(
    vaults.map(async (v) => {
      const contract = new ethers.Contract(v.address, VAULT_ABI, provider)
      // Shares are minted to the user (receiver=user in AgentVaultDepositor.executeAgentDeposit)
      const shares = await contract.balanceOf(address)
      // Explicit zero entry (not null) so authoritative consumers can prune a withdrawn vault.
      if (shares === 0n) return [v.address, { vaultName: v.name, balance: '0', unclaimedRewards: '0' }]
      const assets = await contract.convertToAssets(shares)
      // v2 MockVault is plain ERC-4626 — yield is share-price appreciation, realized on
      // withdraw; there is no separate unclaimed-rewards balance to read.
      return [v.address, {
        vaultName: v.name,
        balance: assets.toString(),
        unclaimedRewards: '0',
      }]
    })
  )

  let anyOk = false
  const positions = {}
  for (const r of results) {
    if (r.status === 'fulfilled') {
      anyOk = true
      if (r.value) positions[r.value[0]] = r.value[1]
    }
  }

  // If every read failed, return null so callers keep the cached snapshot instead
  // of wiping it with a falsely-empty result.
  return anyOk ? positions : null
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
    merged[key] = { ...merged[key], ...pos, balance: (newBal > curBal ? newBal : curBal).toString() }
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
    if (BigInt(pos.balance || '0') === 0n) { delete positions[key]; continue }
    positions[key] = { ...positions[key], ...pos }
  }
  return positions
}
