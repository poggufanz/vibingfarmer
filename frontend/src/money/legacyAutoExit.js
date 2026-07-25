// frontend/src/money/legacyAutoExit.js
// Pocket Crew "My money" Task 10: this is the LAST autonomous-movement path removal. The
// production execution loop that used to read these keys is deleted — app.jsx's 15s `checkExit`
// effect, agents/exitExecutor.js (redeem + transfer + relay submit), and
// strategy/autoExit/{engine,rules,triggers}.js. This module is what is left: a READ-ONLY
// inspector over the four localStorage families that removed code used to write, plus an
// explicit, owner-initiated delete. It has exactly zero imports (same discipline as
// money/riskWatchStore.js) — nothing here can sign, submit, or move a single unit of value. It
// never touches the chain, never touches the relay, and never silently deletes anything on load.
//
// Four legacy key families, and ONLY these:
//   yv_exit_rules_<owner>      - stored auto-exit trigger rules + the `authorized` flag
//                                 (AutoExitSettings.jsx, deleted)
//   yv_last_exit_trip_<owner>  - last time the (now-removed) engine tripped for this owner
//   yv_exit_key_<agent>        - legacy AGENT-ONLY exit-signer keypair cache
//                                 (wallet/exitKey.js's `saveExitKey`/`loadExitKey`)
//   vf_exit_inflight_<agent>   - cross-tab in-progress lock, TTL-bounded (agents/exitExecutor.js,
//                                 deleted; the 120s TTL below is that module's own constant, copied
//                                 rather than imported since the module it lived in no longer exists)
//
// `vf.manualExitKey.v2|<network>|<owner>|<agent>` is a DIFFERENT, still-live namespace — the
// manual partial-withdraw flow (stellar/partialWithdraw.js, wallet/exitKey.js). It is never
// enumerated, counted, or deletable through this module.

const PREFIX_EXIT_RULES = 'yv_exit_rules_'
const PREFIX_LAST_TRIP = 'yv_last_exit_trip_'
const PREFIX_EXIT_KEY = 'yv_exit_key_'
const PREFIX_EXIT_INFLIGHT = 'vf_exit_inflight_'
const MANUAL_KEY_V2_PREFIX = 'vf.manualExitKey.v2|'

// agents/exitExecutor.js's own EXIT_LOCK_TTL_MS — that module is deleted by this same task, so the
// value is copied rather than imported.
const EXIT_LOCK_TTL_MS = 120_000

const ALL_PREFIXES = [PREFIX_EXIT_RULES, PREFIX_LAST_TRIP, PREFIX_EXIT_KEY, PREFIX_EXIT_INFLIGHT]
const TRIGGER_NAMES = ['utilization', 'apyCollapse', 'protocolRisk', 'drawdown']

function safeKeys() {
  const out = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k) out.push(k)
    }
  } catch {
    // No localStorage (SSR / locked-down environment) — an empty scan, never a throw.
  }
  return out
}

function safeGet(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function parseJsonObject(raw) {
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** agent suffix (lowercased, matching how the legacy cache key was written) of a v2 manual key,
 *  or null if `key` isn't one. */
function manualKeyAgent(key) {
  if (!key.startsWith(MANUAL_KEY_V2_PREFIX)) return null
  const parts = key.split('|')
  return parts.length === 4 && parts[3] ? parts[3].toLowerCase() : null
}

function describeExitRules(key, now) {
  const owner = key.slice(PREFIX_EXIT_RULES.length)
  const raw = safeGet(key)
  const rules = raw == null ? null : parseJsonObject(raw)
  if (!rules) return { key, kind: 'exitRules', owner, readable: false }

  const expiryAt = Number.isFinite(rules.expiryAt) ? rules.expiryAt : null
  return {
    key,
    kind: 'exitRules',
    owner,
    readable: true,
    authorized: rules.authorized === true,
    expiryAt,
    expired: expiryAt == null ? null : expiryAt <= now,
    enabledTriggers: TRIGGER_NAMES.filter((t) => rules[t]?.enabled === true),
  }
}

function describeLastTrip(key) {
  const owner = key.slice(PREFIX_LAST_TRIP.length)
  const raw = safeGet(key)
  const ts = raw == null ? NaN : Number(raw)
  if (!Number.isFinite(ts)) return { key, kind: 'lastExitTrip', owner, readable: false }
  return { key, kind: 'lastExitTrip', owner, readable: true, lastTrippedAt: ts }
}

function describeExitKey(key, manualAgents) {
  // Already lowercased by the writer — wallet/exitKey.js's `cacheKey(agentAddress)`.
  const agent = key.slice(PREFIX_EXIT_KEY.length)
  const raw = safeGet(key)
  const parsed = raw == null ? null : parseJsonObject(raw)
  const readable = Boolean(parsed && typeof parsed.publicKey === 'string')
  // A matching v2 manual key PROVES the on-chain signer was re-registered for this agent
  // (ensureExitSigner always registers on-chain before saving — see money/ownerActions.js's own
  // note: set_exit_signer overwrites unconditionally). Its ABSENCE proves nothing either way — this
  // browser may simply have no local record of a replacement made elsewhere — so that case is
  // reported as 'unknown', never as a confident "still active" or "safe to delete, unused".
  const supersededByManualKey = manualAgents.has(agent)
  return {
    key,
    kind: 'exitKey',
    agent,
    readable,
    publicKey: readable ? parsed.publicKey : null,
    supersededByManualKey,
    onChainStatus: supersededByManualKey ? 'superseded' : 'unknown',
  }
}

function describeExitInflight(key, now) {
  const agent = key.slice(PREFIX_EXIT_INFLIGHT.length)
  const raw = safeGet(key)
  // Value shape is `<epoch-ms>:<nonce>` (or a legacy bare timestamp) — see
  // agents/exitExecutor.js's own acquireExitLock, now deleted.
  const ts = raw == null ? NaN : Number(String(raw).split(':')[0])
  if (!Number.isFinite(ts)) return { key, kind: 'exitInflight', agent, readable: false }
  const ageMs = now - ts
  return { key, kind: 'exitInflight', agent, readable: true, ageMs, expired: ageMs >= EXIT_LOCK_TTL_MS }
}

/**
 * Inspect this browser's legacy auto-exit localStorage. Read-only: never deletes, never reads or
 * writes the v2 manual partial-withdraw namespace, never touches the chain. Every entry that
 * exists but can't be parsed is still returned with `readable: false` — an unreadable legacy key
 * is never silently treated as "nothing to clean up".
 * @returns {{rows: object[], count: number}}
 */
export function scanLegacyAutoExit({ now = Date.now() } = {}) {
  const allKeys = safeKeys()
  const manualAgents = new Set(allKeys.map(manualKeyAgent).filter(Boolean))

  const rows = []
  for (const key of allKeys) {
    if (key.startsWith(PREFIX_EXIT_RULES)) rows.push(describeExitRules(key, now))
    else if (key.startsWith(PREFIX_LAST_TRIP)) rows.push(describeLastTrip(key))
    else if (key.startsWith(PREFIX_EXIT_KEY)) rows.push(describeExitKey(key, manualAgents))
    else if (key.startsWith(PREFIX_EXIT_INFLIGHT)) rows.push(describeExitInflight(key, now))
  }
  return { rows, count: rows.length }
}

/** True only for the four legacy auto-exit prefixes above — never for the v2 manual exit-key
 *  namespace or any other storage key, no matter what is passed in. */
export function isLegacyAutoExitKey(key) {
  return typeof key === 'string' && ALL_PREFIXES.some((p) => key.startsWith(p))
}

/**
 * Delete exact legacy keys the owner explicitly selected. Pure `localStorage.removeItem` — never
 * redeems, transfers, calls the relay, or requests a wallet signature. Deleting a local cache never
 * changes an on-chain registered signer (that's owner-authorized separately, on-chain, and this
 * module never reads or writes that state). Anything that isn't one of the four legacy prefixes is
 * skipped, never removed, even if a caller passes it in by mistake.
 * @param {string[]} [keys]
 * @returns {{deleted: string[], skipped: string[]}}
 */
export function deleteLegacyAutoExitKeys(keys) {
  const deleted = []
  const skipped = []
  for (const key of keys || []) {
    if (!isLegacyAutoExitKey(key)) {
      skipped.push(key)
      continue
    }
    try {
      localStorage.removeItem(key)
      deleted.push(key)
    } catch {
      skipped.push(key)
    }
  }
  return { deleted, skipped }
}
