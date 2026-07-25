// frontend/src/money/myMoneyModel.js
// Pocket Crew "My money" Task 8: the view-model the /agent route renders from. Pure — no I/O, no
// React. Composes OwnerDiscoveryV1 (ownerDiscovery.js), the readOwnerMoney.js aggregate
// (aggregateOwnerPositions, EXTENDED with the raw per-agent `agents` array and its own
// `checkedAt` — see this file's own JSDoc below for the exact shape this module expects),
// lifeboat protection evidence, automation evidence, and a same-shaped `cache` of the last good
// reads into ONE state a UI can switch on without re-deriving any of this logic itself.
//
// The one rule every branch below obeys: a state or action is only ever produced from a POSITIVE
// observation. Missing/failed/partial evidence never gets rounded up to a confident claim — it
// downgrades to the nearest honest state instead (see buildMyMoneyModel's state list).
import { classifyFreshness } from './freshness.js'

/**
 * @typedef {{
 *   status: 'complete'|'partial'|'unavailable',
 *   confirmedTotal: {state:'known'|'partial'|'unavailable', amount:{token:string,units:string,decimals:number}|null},
 *   yield: {state:string, apy:number|null},
 *   earned: {state:string, amount:object|null},
 *   custodyBreakdown: Record<string,string>,
 *   unattributed: Record<string,{state:'known'|'unavailable', amount:object|null, checkedAt:number|null}>,
 *   executionBreakdown: Record<string,number>,
 *   agentCount: number, problemAgentCount: number,
 *   agents: Array<{address:string, problems?:string[], amount:{token:string,units:string,decimals:number}|null}>,
 *   checkedAt: number,
 * }} MoneySnapshot readOwnerMoney.js's aggregateOwnerPositions() output, plus its `agents` (the
 *   raw readOwnerMoney().agents rows — needed here for confirmed-problem detection) and its own
 *   `checkedAt`. This module never mutates or re-fetches it; the caller is responsible for
 *   assembling `{ ...aggregateOwnerPositions(reads), agents: reads.agents, checkedAt: reads.checkedAt }`.
 * @typedef {{status:'complete'|'partial'|'unavailable', agents:Array}} DiscoverySnapshot
 *   OwnerDiscoveryV1 (ownerDiscovery.js's discoverOwnerScopes() output).
 * @typedef {{state:'engaged'|'armed'|'disarmed'|'unavailable', authority:string|null, mandateExpiry:number|null}} ProtectionSnapshot
 *   automationEvidence.js's classifyLifeboatAutomation() output, plus the raw `mandateExpiry`
 *   (unix seconds) needed for the urgency window below.
 */

// Confirmed FACTS about an agent's scope/execution — never a mere read-incomplete marker (see
// readOwnerMoney.js's own READ_INCOMPLETE_PROBLEMS, a deliberately DIFFERENT axis: "we couldn't
// read this yet" is not "we know something is wrong").
const CONFIRMED_PROBLEM_MARKERS = new Set(['scope-revoked', 'scope-expired', 'base-execution-failed'])

// Lifeboat mandate windows are a 24-48h refresh cycle (lifeboat.js) — "urgent" means close to
// lapsing, not "could someday lapse".
const URGENT_RENEWAL_WITHIN_S = 2 * 3600

function isKnownPositiveAmount(amount) {
  return amount != null && BigInt(amount.units) > 0n
}

/** Addresses of agents with a CONFIRMED (not merely unread) custody/recovery problem AND real
 * money actually at stake — a revoked/expired agent holding nothing confirmed-positive is not
 * urgent; nothing to recover. */
function confirmedProblemAgents(agents) {
  return (agents ?? [])
    .filter((a) => a.problems?.some((p) => CONFIRMED_PROBLEM_MARKERS.has(p)) && isKnownPositiveAmount(a.amount))
    .map((a) => a.address)
}

function hasUnknownUnattributed(unattributed) {
  return Object.values(unattributed ?? {}).some((u) => u.state === 'unavailable')
}

function hasKnownPositiveUnattributed(unattributed) {
  return Object.values(unattributed ?? {}).some((u) => u.state === 'known' && isKnownPositiveAmount(u.amount))
}

function hasKnownVaultMoney(money) {
  const units = money?.custodyBreakdown?.['stellar-vault']
  return units != null && BigInt(units) > 0n
}

/** Fresh money wins when it succeeded; a failed/absent fresh read falls back to a known-good
 * cache (state stays whatever the cache says, freshness downgrades to 'stale'); nothing usable
 * anywhere is 'unavailable' — mirrors freshness.js's withCacheFallback, at the whole-snapshot
 * level (a MoneySnapshot, not a single source reading). */
function resolveMoney(fresh, cached, now) {
  const freshOk = fresh && fresh.confirmedTotal && fresh.confirmedTotal.state !== 'unavailable'
  if (freshOk) return { data: fresh, freshness: classifyFreshness({ checkedAt: fresh.checkedAt, now }) }
  const cachedOk = cached && cached.confirmedTotal && cached.confirmedTotal.state !== 'unavailable'
  if (cachedOk) return { data: cached, freshness: 'stale' }
  return { data: null, freshness: 'unavailable' }
}

function resolveProtection({ protection, cache, now }) {
  const p =
    protection && protection.state && protection.state !== 'unavailable'
      ? protection
      : cache?.protection && cache.protection.state && cache.protection.state !== 'unavailable'
        ? cache.protection
        : null
  if (!p) return { state: 'unavailable', authority: null, mandateExpiry: null, urgentRenewal: false }
  const nowS = Math.floor(now / 1000)
  const urgentRenewal =
    (p.state === 'armed' || p.state === 'disarmed') &&
    p.mandateExpiry != null &&
    p.mandateExpiry - nowS <= URGENT_RENEWAL_WITHIN_S
  return { state: p.state, authority: p.authority ?? null, mandateExpiry: p.mandateExpiry ?? null, urgentRenewal }
}

function finishModel({ state, owner, money, protection, automation, cache, now, problemAgents, freshness }) {
  const resolvedProtection = resolveProtection({ protection, cache, now })
  resolvedProtection.ownerIsAuthority =
    Boolean(owner) && Boolean(resolvedProtection.authority) && resolvedProtection.authority === owner
  return {
    state,
    owner: owner ?? null,
    confirmedTotal: money?.confirmedTotal ?? null,
    yield: money?.yield ?? null,
    earned: money?.earned ?? null,
    unattributed: money?.unattributed ?? null,
    custodyBreakdown: money?.custodyBreakdown ?? null,
    agentCount: money?.agentCount ?? null,
    problemAgentCount: money?.problemAgentCount ?? null,
    freshness,
    checkedAt: money?.checkedAt ?? null,
    problemAgents,
    protection: resolvedProtection,
    automation: automation ?? null,
    hasKnownVaultMoney: hasKnownVaultMoney(money),
  }
}

/**
 * @param {{owner?:string|null, discovery?:DiscoverySnapshot|null, money?:MoneySnapshot|null,
 *   protection?:ProtectionSnapshot|null, automation?:object|null,
 *   cache?:{money?:MoneySnapshot, discovery?:DiscoverySnapshot, protection?:ProtectionSnapshot},
 *   now?:number}} p
 */
export function buildMyMoneyModel({
  owner,
  discovery,
  money,
  protection,
  automation,
  cache = {},
  now = Date.now(),
} = {}) {
  // Precedence 1 (checked before EVERY other branch, including connection state — a confirmed
  // problem must never be hidden just because the wallet that surfaced it isn't connected right
  // now): a confirmed fact from the FRESH read only — a problem sourced from stale cache would
  // itself be exactly the kind of "stale data manufacturing a confident state" this whole module
  // exists to forbid.
  const problemAgents = confirmedProblemAgents(money?.agents)
  if (problemAgents.length > 0) {
    return finishModel({
      state: 'problem',
      owner,
      money,
      protection,
      automation,
      cache,
      now,
      problemAgents,
      freshness: classifyFreshness({ checkedAt: money?.checkedAt, now }),
    })
  }

  // Precedence 2: disconnected.
  if (!owner) {
    return finishModel({
      state: 'disconnected',
      owner: null,
      money,
      protection,
      automation,
      cache,
      now,
      problemAgents,
      freshness: classifyFreshness({ checkedAt: money?.checkedAt, now }),
    })
  }

  const { data: md, freshness } = resolveMoney(money, cache.money, now)
  if (!md) {
    // Never read AND never cached = still in flight; a read that came back but failed (or a
    // cache that itself failed) is a real 'unavailable', not merely "loading".
    const neverAttempted = money == null && cache?.money == null
    return finishModel({
      state: neverAttempted ? 'loading' : 'unavailable',
      owner,
      money: null,
      protection,
      automation,
      cache,
      now,
      problemAgents,
      freshness: 'unavailable',
    })
  }

  const discoveryStatus = discovery?.status ?? cache?.discovery?.status ?? 'unavailable'

  // Precedence: incomplete evidence anywhere in the picture — never presented as a confident total.
  if (discoveryStatus === 'partial' || md.confirmedTotal.state === 'partial') {
    return finishModel({
      state: 'partial-discovery',
      owner,
      money: md,
      protection,
      automation,
      cache,
      now,
      problemAgents,
      freshness,
    })
  }

  // Precedence 3: authoritatively empty. Requires PROVEN-complete coverage (never claim "nothing
  // here" from a partial enumeration), a KNOWN zero total, and no doubt hiding in the
  // unattributed (Base kernel idle) bucket — an unavailable entry there means we can't be sure,
  // and a known-positive entry there means it's not actually empty.
  const totalUnits = BigInt(md.confirmedTotal.amount.units)
  const authoritativelyEmpty =
    discoveryStatus === 'complete' &&
    totalUnits === 0n &&
    !hasUnknownUnattributed(md.unattributed) &&
    !hasKnownPositiveUnattributed(md.unattributed)

  if (authoritativelyEmpty) {
    return finishModel({
      state: 'empty',
      owner,
      money: md,
      protection,
      automation,
      cache,
      now,
      problemAgents,
      freshness,
    })
  }

  return finishModel({
    state: freshness === 'stale' ? 'stale' : 'current',
    owner,
    money: md,
    protection,
    automation,
    cache,
    now,
    problemAgents,
    freshness,
  })
}

/**
 * Primary-action precedence (buildMyMoneyModel's own docs):
 *   1. confirmed personal custody/recovery problem -> Review problem
 *   2. disconnected -> Connect wallet
 *   3. authoritatively empty -> Make a deposit
 *   4. connected authorized mandate authority + confirmed urgent protection renewal -> Renew vault protection
 *   5. active position (or simply: connected, nothing more urgent) -> Add money
 * Rule 4 additionally requires known vault money to protect — renewing protection for an owner
 * with no confirmed vault position is never surfaced, and "urgent" is never manufactured from
 * unavailable protection evidence (see resolveProtection's `unavailable` -> urgentRenewal:false).
 * @param {ReturnType<typeof buildMyMoneyModel>|null} model
 */
export function choosePrimaryMoneyAction(model) {
  if (!model) return null
  if (model.state === 'problem') return { action: 'review-problem', label: 'Review problem' }
  if (model.state === 'disconnected') return { action: 'connect-wallet', label: 'Connect wallet' }
  if (model.state === 'empty') return { action: 'deposit', label: 'Make a deposit' }
  if (
    model.owner &&
    model.protection?.ownerIsAuthority &&
    model.protection?.urgentRenewal &&
    model.hasKnownVaultMoney
  ) {
    return { action: 'renew-protection', label: 'Renew vault protection' }
  }
  if (model.owner) return { action: 'add-money', label: 'Add money' }
  return null
}
