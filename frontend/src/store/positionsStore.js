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

import { SOROBAN_ACTIVE_VAULT_ADDRESS, SOROBAN_DECIMALS } from '../stellar/config.js'
import { readVaultShares } from '../stellar/agentDeposit.js'
import { readPricePerShare } from '../stellar/vaultReads.js'

const PPS_SCALE = 10_000_000n // price_per_share is 7-dp fixed point (1_0000000 == 1.0)

// Single demo vault has no on-chain name field — label it for the positions list.
const VAULT_NAME = 'VFUSD Yield Vault'

const keyFor = (addr) => `yv_positions_${String(addr).toLowerCase()}`
const agentsKeyFor = (addr) => `yv_agents_${String(addr).toLowerCase()}`

const POSITIONS_CACHE_SCHEMA_VERSION = 1

/** Unwrap a versioned envelope; unknown/missing versions are a miss, never trusted data. */
function unwrapVersioned(raw, fallback) {
  if (!raw || typeof raw !== 'object') return fallback
  if (raw.__schemaVersion !== POSITIONS_CACHE_SCHEMA_VERSION) return fallback
  return raw.data ?? fallback
}

/** Restore last-known positions for an address from localStorage (sync, instant). */
export function loadPersistedPositions(address) {
  if (!address) return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(address)) || '{}') || {}
    // Back-compat: pre-versioning entries were the bare positions map. A bare map has
    // vault-address keys, never __schemaVersion; accept it once so existing installs do
    // not lose their snapshot, but never partially trust an unknown version.
    if (parsed.__schemaVersion === undefined && typeof parsed === 'object') return parsed
    return unwrapVersioned(parsed, {})
  } catch {
    return {}
  }
}

/** Persist a positions map for an address. Safe to call with an empty map. */
export function persistPositions(address, positions) {
  if (!address) return
  try {
    localStorage.setItem(
      keyFor(address),
      JSON.stringify({
        __schemaVersion: POSITIONS_CACHE_SCHEMA_VERSION,
        savedAt: Date.now(),
        data: positions || {},
      })
    )
  } catch {
    // localStorage unavailable/full — non-fatal, positions still live in memory.
  }
}

/** Restore last-known deployed agent addresses for an address from localStorage. */
export function loadDeployedAgents(address) {
  if (!address) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(agentsKeyFor(address)) || '[]')
    // Back-compat: pre-versioning entries were the bare address array.
    if (Array.isArray(parsed)) return parsed
    const data = unwrapVersioned(parsed, null)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** Persist deployed agent addresses for an address. */
export function saveDeployedAgents(address, agents) {
  if (!address) return
  try {
    localStorage.setItem(
      agentsKeyFor(address),
      JSON.stringify({
        __schemaVersion: POSITIONS_CACHE_SCHEMA_VERSION,
        savedAt: Date.now(),
        data: agents || [],
      })
    )
  } catch {
    // non-fatal
  }
}

// --- Honest-PnL deposit ledger (P0 G1) -------------------------------------------
// Cost basis for the "Earned" card: one entry per confirmed Stellar vault deposit:
// `{ agent, shares, assetsIn, ppsAtDeposit, txHash }`. Every field is either proved by
// a deposit flow that already ran or null — never estimated:
// - `assetsIn` (canonical 7-dp units): the reviewed allocation a success confirms moved.
//   The sanctioned producer is `projectDepositHints` below (receipt amount, rescaled
//   without truncation); `reconcilePositionsFromChain`'s `deposits` hints must already
//   carry this form.
// - `shares` + `ppsAtDeposit`: the same on-chain reads reconcile already performs
//   (per-agent shares + live `price_per_share`), stamped at record time.
// - `txHash`: the deposit transaction hash, for the stellar.expert link.
// Entries are append-only per deposit (a repeat funding appends, deduped by agent+txHash,
// so Σ assetsIn stays the true cumulative principal) and are PRUNED only when the chain
// proves their agent holds zero shares (fully exited — no unrealized PnL left to attribute).
// `readOwnerMoney.js` reports `earned: unavailable` unless a non-empty ledger AND live PPS
// (all vault legs known) both exist.

const depositLedgerKeyFor = (addr) => `yv_deposit_ledger_${String(addr).toLowerCase()}`
const UINT_RE = /^[0-9]+$/

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/** A ledger entry is valid when it names a real agent and a positive 7-dp principal. */
function isValidLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (!isNonEmptyString(entry.agent)) return false
  if (typeof entry.assetsIn !== 'string' || !UINT_RE.test(entry.assetsIn)) return false
  try {
    if (BigInt(entry.assetsIn) <= 0n) return false
  } catch {
    return false
  }
  if (entry.shares != null && (typeof entry.shares !== 'string' || !UINT_RE.test(entry.shares)))
    return false
  if (
    entry.ppsAtDeposit != null &&
    (typeof entry.ppsAtDeposit !== 'string' || !UINT_RE.test(entry.ppsAtDeposit))
  )
    return false
  if (entry.txHash != null && !isNonEmptyString(entry.txHash)) return false
  return true
}

function normalizeLedgerEntry(entry) {
  return {
    agent: entry.agent,
    shares: entry.shares ?? null,
    assetsIn: entry.assetsIn,
    ppsAtDeposit: entry.ppsAtDeposit ?? null,
    txHash: entry.txHash ?? null,
  }
}

function sanitizeLedger(data) {
  if (!Array.isArray(data)) return []
  return data.filter(isValidLedgerEntry).map(normalizeLedgerEntry)
}

/** Restore the deposit ledger for an address (sync). Miss/corrupt/version → `[]`, never null. */
export function loadDepositLedger(address) {
  if (!address) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(depositLedgerKeyFor(address)) || '[]')
    // Back-compat: pre-versioning entries were the bare array; accept once.
    if (Array.isArray(parsed)) return sanitizeLedger(parsed)
    const data = unwrapVersioned(parsed, null)
    return Array.isArray(data) ? sanitizeLedger(data) : []
  } catch {
    return []
  }
}

function saveDepositLedger(address, ledger) {
  if (!address) return
  try {
    localStorage.setItem(
      depositLedgerKeyFor(address),
      JSON.stringify({
        __schemaVersion: POSITIONS_CACHE_SCHEMA_VERSION,
        savedAt: Date.now(),
        data: ledger || [],
      })
    )
  } catch {
    // localStorage unavailable/full — non-fatal, the returned ledger still serves this call.
  }
}

/**
 * Pure append: returns the next ledger array (a repeat funding appends; nothing is edited
 * in place). A hint whose agent+txHash already exists only backfills null shares/pps fields
 * (the "recorded before the deposit mined" case) and never duplicates principal. A hint
 * without txHash dedupes on the exact agent+assetsIn pair. Invalid hints are ignored.
 */
function appendLedgerEntry(ledger, entry) {
  if (!isValidLedgerEntry(entry)) return ledger
  const next = [...ledger]
  const agentLower = entry.agent.toLowerCase()
  const incumbent =
    entry.txHash != null
      ? next.find((e) => e.agent.toLowerCase() === agentLower && e.txHash === entry.txHash)
      : next.find((e) => e.agent.toLowerCase() === agentLower && e.assetsIn === entry.assetsIn)
  if (incumbent) {
    if (incumbent.shares == null && entry.shares != null) incumbent.shares = entry.shares
    if (incumbent.ppsAtDeposit == null && entry.ppsAtDeposit != null)
      incumbent.ppsAtDeposit = entry.ppsAtDeposit
    return next
  }
  next.push(normalizeLedgerEntry(entry))
  return next
}

/**
 * Pure prune: drops entries whose agent the chain just proved holds zero shares (fully
 * exited — realized, no longer unrealized). Agents with a failed read (absent from
 * `readByAgent`) or with a hint in THIS call (just funded, possibly not yet mined) are
 * always kept: only proven-zero exits prune, never a guess.
 */
function pruneExitedAgents(ledger, readByAgent, hintedAgents) {
  return ledger.filter((entry) => {
    const lower = entry.agent.toLowerCase()
    if (hintedAgents.has(lower)) return true
    if (!readByAgent.has(lower)) return true
    return readByAgent.get(lower) > 0n
  })
}

/**
 * Reconcile-time ledger maintenance (module-private): stamps `deposits` hints with the
 * per-agent shares + live PPS the caller already read, then prunes fully-exited agents.
 * No hints and an empty ledger → no-op (no localStorage churn on every poll). A hint for
 * an agent whose read failed is skipped (shares must be observed, never invented).
 */
function maintainDepositLedger(address, { agents, results, pps, deposits }) {
  const hints = Array.isArray(deposits) ? deposits : []
  let ledger = loadDepositLedger(address)
  if (ledger.length === 0 && hints.length === 0) return ledger
  const readByAgent = new Map()
  ;(agents || []).forEach((agent, i) => {
    const r = results?.[i]
    if (r?.status === 'fulfilled' && r.value != null) {
      try {
        readByAgent.set(String(agent).toLowerCase(), BigInt(r.value))
      } catch {
        // Non-integer share read — not a balance we can stamp or prune on; skip the agent.
      }
    }
  })
  const hintedAgents = new Set()
  for (const hint of hints) {
    if (!hint || typeof hint.agent !== 'string' || hint.agent.length === 0) continue
    const lower = hint.agent.toLowerCase()
    hintedAgents.add(lower)
    if (!readByAgent.has(lower)) continue
    ledger = appendLedgerEntry(ledger, {
      agent: hint.agent,
      shares: readByAgent.get(lower).toString(),
      assetsIn: hint.assetsIn,
      ppsAtDeposit: pps != null ? String(pps) : null,
      txHash: hint.txHash ?? null,
    })
  }
  ledger = pruneExitedAgents(ledger, readByAgent, hintedAgents)
  saveDepositLedger(address, ledger)
  return ledger
}

/**
 * Record one deposit-ledger entry for an address. Persists (localStorage) and returns the
 * updated ledger. Invalid entries are ignored (the stored ledger is returned unchanged).
 */
export function recordDepositLedger(address, entry) {
  if (!address) return []
  const ledger = loadDepositLedger(address)
  const next = appendLedgerEntry(ledger, entry)
  if (next !== ledger) saveDepositLedger(address, next)
  return next
}

/**
 * Rescale a receipt `{ token, units, decimals }` amount to canonical 7-dp units without
 * truncation. Returns the units string, or null when the amount is missing, non-integer,
 * non-positive, or FINER than canonical (rescaling down would silently destroy money —
 * rejected, never truncated).
 */
function canonicalizeTo7dp(amount) {
  if (!amount || typeof amount.units !== 'string' || !UINT_RE.test(amount.units)) return null
  if (!Number.isInteger(amount.decimals) || amount.decimals < 0) return null
  const delta = SOROBAN_DECIMALS - amount.decimals
  if (delta < 0) return null
  try {
    const units = BigInt(amount.units) * 10n ** BigInt(delta)
    return units > 0n ? units.toString() : null
  } catch {
    return null
  }
}

/**
 * Pure projection: dispatch receipt → deposit-ledger hints (`[{ agent, assetsIn, txHash }]`).
 * Only succeeded Stellar-vault allocations produce hints (Base legs never carry
 * `stellar-vault` custody, so they can never match); the agent address is joined from the
 * orchestrator results by allocationId. Anything unprovable (failed leg, missing agent,
 * unrescalable amount) yields no hint — the ledger stays honest by omission.
 * @param {{ allocations?: Array, results?: Array }} input
 * @returns {Array<{ agent: string, assetsIn: string, txHash: string|null }>}
 */
export function projectDepositHints({ allocations, results } = {}) {
  const agentByAllocation = new Map()
  for (const result of results || []) {
    if (!result || typeof result.allocationId !== 'string') continue
    if (agentByAllocation.has(result.allocationId)) continue
    if (isNonEmptyString(result.agentAddress))
      agentByAllocation.set(result.allocationId, result.agentAddress)
  }
  const hints = []
  for (const allocation of allocations || []) {
    if (!allocation || allocation.executionStatus !== 'succeeded') continue
    if (allocation.custody?.location !== 'stellar-vault') continue
    if (typeof allocation.allocationId !== 'string') continue
    const agent = agentByAllocation.get(allocation.allocationId)
    if (!isNonEmptyString(agent)) continue
    const assetsIn = canonicalizeTo7dp(allocation.amount)
    if (assetsIn == null) continue
    const txHash = isNonEmptyString(allocation.txHash) ? allocation.txHash : null
    hints.push({ agent, assetsIn, txHash })
  }
  return hints
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
 * @param {{ agents?: string[], server?: object, deposits?: Array<{ agent: string, assetsIn: string, txHash?: string|null }> }} [opts]
 *   `deposits` (optional) carries the cost-basis hints for deposits that just confirmed
 *   (see `projectDepositHints`): each hint's `assetsIn` is stamped into the deposit ledger
 *   together with the per-agent shares + live PPS this call already read. The positions map
 *   itself is untouched by hints — they only feed the ledger side channel.
 * @returns {Promise<Object|null>}
 */
export async function reconcilePositionsFromChain(address, { agents, server, deposits } = {}) {
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
  let pps = null
  if (total > 0n) {
    pps = await readPricePerShare(SOROBAN_ACTIVE_VAULT_ADDRESS, { server })
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
  // P0 G1 ledger side channel: stamp just-confirmed deposit hints with the shares + PPS
  // read above, and prune agents the chain proves fully exited. The positions map returned
  // below is byte-identical with or without hints — this only touches the ledger key.
  maintainDepositLedger(address, { agents, results, pps, deposits })

  return positions
}

// My Money Task 13 Part B item 5. `pickPositionsAgents` (deprecated since My Money Task 6) is
// DELETED outright: it had exactly one remaining caller (app.jsx's `positionsAgents`), now
// migrated to the discovery-based `pickRecoverableVaultAgents` below (see app.jsx's own comment at
// that call site).
//
// `pickVaultAgents` carried the identical defect (both silently dropped revoked agents -- the
// exit-enumeration rule forbids that, since a revoked-but-funded agent is exactly the one a sweep
// must not skip) and could not simply be deleted: `frontend/src/components/console/
// PositionsZone.jsx` (legacy OpsConsole, kept on disk for rollback/tests only, unreachable from any
// production route since My Money Task 13's route-composition step) is still a real, tested caller,
// and it holds `scopes` (rehydrateScopes()'s plain-scope shape: `.agent`/`.vault`/`.revoked`)
// rather than an `OwnerDiscoveryV1` envelope -- `pickRecoverableVaultAgents` below expects the
// latter and would silently return every row's `.address` as `undefined` if forced onto `scopes`
// (the same shape mismatch app.jsx's own `hasLiveScopeForVault` doc explains).
//
// Wave 6 carry (My Money Task 6, carried through Task 13 Part B): renamed to
// `pickVaultAgentsForExit` and the revoked-filter deleted -- this IS the explicit-semantics
// replacement, operating on the scopes shape PositionsZone.jsx actually has, with the same
// inclusive (never-drop-a-revoked-but-funded-agent) rule `pickRecoverableVaultAgents` already
// enforces for the discovery shape. Do not add a NEW caller of this scopes-shaped picker without
// checking whether `pickRecoverableVaultAgents` (discovery-shaped) already covers it instead.
export function pickVaultAgentsForExit(scopes, vaultAddress) {
  const want = (vaultAddress || '').toLowerCase()
  if (!want) return []
  const seen = new Set()
  const out = []
  for (const s of scopes || []) {
    if (!s || !s.agent) continue
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
// `pickVaultAgentsForExit` above operates on the LIVE `scopes` array
// (rehydrateScopes()'s shape) — kept unchanged for its existing caller (PositionsZone.jsx). These
// three operate on an `OwnerDiscoveryV1` envelope
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
 * SOROBAN_ACTIVE_VAULT_ADDRESS) — the param exists for interface parity with pickVaultAgentsForExit;
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
