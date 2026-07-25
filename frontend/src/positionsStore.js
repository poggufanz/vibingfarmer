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
// "position" is read as the agent's vault-share balance. `agents` must be an explicit,
// caller-supplied list (Pocket Crew My Money Task 6): no address is ever guessed, so an omitted
// or empty list reads nothing rather than silently substituting a demo/seeded agent.

import { SOROBAN_ACTIVE_VAULT_ADDRESS } from './stellar/config.js'
import { readVaultShares } from './stellar/agentDeposit.js'
import { readPricePerShare } from './stellar/vaultReads.js'

const PPS_SCALE = 10_000_000n // price_per_share is 7-dp fixed point (1_0000000 == 1.0)

// Single demo vault has no on-chain name field — label it for the positions list.
const VAULT_NAME = 'VFUSD Yield Vault'

const keyFor = (addr) => `yv_positions_${String(addr).toLowerCase()}`
const agentsKeyFor = (addr) => `yv_agents_${String(addr).toLowerCase()}`

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

/** Restore last-known deployed agent addresses for an address from localStorage. */
export function loadDeployedAgents(address) {
  if (!address) return []
  try {
    return JSON.parse(localStorage.getItem(agentsKeyFor(address)) || '[]') || []
  } catch {
    return []
  }
}

/** Persist deployed agent addresses for an address. */
export function saveDeployedAgents(address, agents) {
  if (!address) return
  try {
    localStorage.setItem(agentsKeyFor(address), JSON.stringify(agents || []))
  } catch {
    // non-fatal
  }
}

/**
 * Reconcile positions against the Stellar vault. Sums the vault-share balance across
 * every agent the user funded (shares are i128 base units, 7-dp). Returns a positions
 * map ({ [vaultAddr]: { vaultName, balance, unclaimedRewards } }), or null when `agents`
 * is missing/empty or EVERY read fails, so callers keep the cached snapshot instead of
 * wiping it.
 *
 * `agents` is REQUIRED — no default, no demo-agent fallback (Task 6: "no product read ever
 * defaults to SOROBAN_DEMO_AGENT"). The caller (positions discovery) is the one place that
 * knows which addresses are real; guessing here would misreport whose money this is.
 *
 * A balance of '0' is an explicit entry (not absent) so an authoritative consumer
 * (applyChainPositions) can PRUNE a fully-swept vault. readVaultShares returns null on
 * RPC failure (it catches), so a transient failure stays out of the total — never
 * mistaken for a withdrawal.
 *
 * The returned map also carries a non-enumerable `agentStatus` array (one { agent, status:
 * 'ok'|'failed' } per input agent) — a side channel for callers that want per-agent detail
 * without perturbing existing consumers that iterate the map's own vault keys directly
 * (Object.keys/entries/spread/JSON.stringify all skip a non-enumerable property).
 *
 * @param {string} address - connected user wallet (kept for caller/localStorage compat)
 * @param {{ agents?: string[], server?: object }} [opts]
 * @returns {Promise<Object|null>}
 */
export async function reconcilePositionsFromChain(address, { agents, server } = {}) {
  if (!address) return null
  if (!Array.isArray(agents) || agents.length === 0) return null

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
  const positions = {
    [SOROBAN_ACTIVE_VAULT_ADDRESS]: {
      vaultName: VAULT_NAME,
      balance: assets.toString(),
      shares: total.toString(),
      unclaimedRewards: '0',
    },
  }
  Object.defineProperty(positions, 'agentStatus', {
    value: agents.map((agent, i) => ({
      agent,
      status: results[i].status === 'fulfilled' && results[i].value != null ? 'ok' : 'failed',
    })),
    enumerable: false,
  })
  return positions
}

/**
 * @deprecated Pocket Crew My Money Task 6 replaced this with `pickDisplayAgents`, which reads
 * the `OwnerDiscoveryV1` envelope instead of a plain `scopes` array. This function silently
 * drops revoked agents — the exit-enumeration rule (full exit enumeration includes active,
 * expired, revoked, AND revoked-but-funded agents) forbids that. Kept only because its existing
 * callers (app.jsx, HomePage.jsx, PositionsZone.jsx) still depend on the plain-`scopes` shape;
 * My Money Tasks 11/13 own migrating those callers to `pickDisplayAgents` and deleting this pair.
 *
 * Choose which agents' vault shares represent the user's positions. View-as (dev) reads the
 * impersonated address's OWN shares; a real run reads the per-run agents the router deployed
 * (scopes[].agent, non-revoked) — where deposit mints the shares. Returns undefined when there
 * is nothing better yet (e.g. before scopes have rehydrated) — the caller must then omit `agents`
 * when calling `reconcilePositionsFromChain`, which reads nothing rather than guessing (no
 * default exists to "keep" anymore; see that function's own doc).
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

/**
 * @deprecated Pocket Crew My Money Task 6 replaced this with `pickRecoverableVaultAgents`, which
 * reads the `OwnerDiscoveryV1` envelope instead of a plain `scopes` array. This function silently
 * drops revoked agents — the exit-enumeration rule (full exit enumeration includes active,
 * expired, revoked, AND revoked-but-funded agents) forbids that: a revoked-but-funded agent is
 * exactly the case a sweep must not skip. Kept only because its existing callers (app.jsx,
 * HomePage.jsx, PositionsZone.jsx) still depend on the plain-`scopes` shape; My Money Tasks 11/13
 * own migrating those callers to `pickRecoverableVaultAgents` and deleting this pair.
 *
 * The agents whose shares back the position shown for `vaultAddress` — i.e. the set `owner_withdraw`
 * must sweep, one user-signed tx each, because a position is the SUM over every agent (see the
 * `total +=` above) while the exit is per-agent.
 *
 * Deliberately NOT pickPositionsAgents: that one is for DISPLAY, so it may fall back to a default
 * and may return a view-as address. An exit must never guess an agent — the user cannot sign for an
 * agent they do not own, and a wrong guess is what made every withdraw invoke the demo agent.
 * Empty means empty: the caller must disable the button, not substitute something.
 *
 * @param {Array<{agent?: string, vault?: string, revoked?: boolean}>} scopes
 * @param {string} vaultAddress
 * @returns {string[]} non-revoked agents pinned to that vault, deduped, in scope order
 */
export function pickVaultAgents(scopes, vaultAddress) {
  const want = (vaultAddress || '').toLowerCase()
  if (!want) return []
  const seen = new Set()
  const out = []
  for (const s of scopes || []) {
    if (!s || s.revoked || !s.agent) continue
    if ((s.vault || '').toLowerCase() !== want) continue
    if (seen.has(s.agent)) continue
    seen.add(s.agent)
    out.push(s.agent)
  }
  return out
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

// --- Discovery-driven pickers (Pocket Crew My Money Task 6) -------------------------------
// `pickPositionsAgents`/`pickVaultAgents` above operate on the LIVE `scopes` array
// (rehydrateScopes()'s shape) — kept unchanged for their existing callers (app.jsx,
// PositionsZone.jsx, HomePage.jsx). These three operate on an `OwnerDiscoveryV1` envelope
// (ownerDiscovery.js's discoverOwnerScopes()) instead, whose `status` can be 'partial' or
// 'unavailable' — information a plain scopes array never carried, and which display/exit
// actions must not paper over.

// A 'bridge'-kind membership moves USDC toward Base — it never holds Stellar vault shares.
// 'unknown' (agent-v3-bridge wasm before evidence narrows it) can't be ruled out, so it stays IN:
// fail OPEN on inclusion here (never strand a possibly-funded agent out of the exit list) — the
// opposite direction from the vault filter below, which fails open on an unKNOWN vault too, for
// the same reason.
function vaultCandidateAgents(discovery) {
  return (discovery?.agents || []).filter((a) => a && a.kind !== 'bridge')
}

/**
 * Agent rows an owner might reasonably want to SEE for `vault` — every known candidate
 * regardless of on-chain liveness: active, expired, revoked, and revoked-but-funded agents all
 * stay visible (product truth: hiding them is exactly how funds go missing from the exit list).
 * Only a row PROVEN scoped to a different vault is excluded; a row whose vault is unread/unknown
 * is kept rather than silently dropped.
 * ponytail: `vault` isn't filtered further than a straight match today (one live vault,
 * SOROBAN_ACTIVE_VAULT_ADDRESS) — the param exists for interface parity with pickVaultAgents;
 * revisit if a second vault ships.
 * @param {{status:string, agents:Array}} discovery an OwnerDiscoveryV1 envelope
 * @param {{vault?: string}} [opts]
 */
export function pickDisplayAgents(discovery, { vault } = {}) {
  const want = (vault || '').toLowerCase()
  return vaultCandidateAgents(discovery).filter((a) => {
    if (!want || a.vault == null) return true
    return String(a.vault).toLowerCase() === want
  })
}

/**
 * Agent ADDRESSES `vault`'s exit must sweep — same inclusion rule as pickDisplayAgents, but
 * returns plain address strings (the shape owner_withdraw/exit_router sweep calls expect).
 * Empty means empty: never a demo/view-as substitute.
 * @param {{status:string, agents:Array}} discovery
 * @param {{vault?: string}} [opts]
 * @returns {string[]}
 */
export function pickRecoverableVaultAgents(discovery, { vault } = {}) {
  return pickDisplayAgents(discovery, { vault }).map((a) => a.address)
}

/**
 * The exit scope a "leave everything" action may claim. `{ kind: 'all' }` is a completeness
 * CLAIM — only `discovery.status === 'complete'` (every source proven gap-free/fresh/backfilled,
 * see coverageProof in api/agent-index/indexer.js) may make it. Anything less is
 * `{ kind: 'known-only' }`: still the full recoverable list this discovery can see, but the
 * caller must say so explicitly rather than render it as "you're fully out".
 * @param {{status:string, agents:Array}} discovery
 * @param {{vault?: string}} [opts]
 * @returns {{kind: 'all'|'known-only', agents: string[]}}
 */
export function buildBulkExitTarget(discovery, { vault } = {}) {
  const agents = pickRecoverableVaultAgents(discovery, { vault })
  return { kind: discovery?.status === 'complete' ? 'all' : 'known-only', agents }
}
