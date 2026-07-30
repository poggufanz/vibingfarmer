// frontend/src/money/readOwnerMoney.js
// Pocket Crew "My money" Task 7: turns OwnerDiscoveryV1 (ownerDiscovery.js's discoverOwnerScopes)
// into the actual money and custody read model the /agent route renders. Every agent's Stellar
// vault-share/idle-token balances and — when a durable, relayer-attested Base association exists
// (Task 5) — its Base custody are read defensively (Promise.allSettled at TWO layers: the two
// Stellar reads per agent, and every agent against every other) so one bad address never blanks
// the rest. Unknown money is never rendered as zero: a read that could not be confirmed leaves
// `amount: null`, never a guessed number, matching the "never coerce a null" discipline
// ownerDiscovery.js and vaultReads.js already establish for this codebase.
//
// Task 10: a bridge agent can carry MORE THAN ONE durable Base child (two separate runs/
// allocations that both landed real money). The old `latestBaseChild` picked the freshest one and
// silently discarded any sibling's proven money -- deleted. Every valid child now survives via
// baseChildPositions.js's `normalizeBaseChildren`, grouped by the real on-chain position it shares
// with any sibling (same kernel+vault+asset), and valued via `readBasePositions`'s pinned-block
// reads (delegated through dashboardPositions.js's loadIndexedBasePositions -- see its own header).
import {
  readVaultShares as _readVaultShares,
  readTokenBalance as _readTokenBalance,
} from '../stellar/agentDeposit.js'
import {
  readPricePerShare as _readPricePerShare,
  readSupplyAprBps as _readSupplyAprBps,
  sharesToAssetUnits,
} from '../stellar/vaultReads.js'
import { loadIndexedBasePositions as _loadIndexedBasePositions } from '../base/dashboardPositions.js'
import { normalizeBaseChildren } from './baseChildPositions.js'
import { SOROBAN_DECIMALS, SOROBAN_BLEND_POOL_ADDRESS } from '../stellar/config.js'
import { BASE_USDC_DECIMALS } from '../base/config.js'
import { BASE_POOL_CATALOG } from '../config.js'
import { custodyForAgent, custodyBreakdownForAgent } from './custody.js'

const TOKEN = 'USDC'
// Every OwnerMoneyReadV1 amount this module produces is canonicalized to the Stellar side's 7dp
// so Stellar-vault and Base-proxy money can be summed as plain BigInt units without a per-field
// decimals lookup at every call site. Fix loop 1, Fix 8: sourced from base/config.js's own
// BASE_USDC_DECIMALS rather than a second, independently hardcoded '6' here — one rule, not two.
const BASE_TO_CANONICAL_SCALE = 10n ** BigInt(SOROBAN_DECIMALS - BASE_USDC_DECIMALS)
const TERMINAL_BASE_STATUSES = new Set(['deposited', 'held'])
// Labels HOW every Base figure this module reports was derived — never maxWithdraw (no ABI
// fragment for it exists in this codebase), never per-child yield attribution. See
// baseChildPositions.js's readBasePositions docblock for the same rule at the read layer.
const BASE_VALUATION_KIND = 'convertToAssets-current-estimate'

function amountOf(units) {
  return { token: TOKEN, units: String(units), decimals: SOROBAN_DECIMALS }
}

// A raw association amount (base/config.js's BASE_USDC_DECIMALS = 6) rescaled to this module's
// canonical 7dp — the association's own decimals field is trusted over a hardcoded assumption,
// in case a future report ever reviews at a different precision.
function canonicalizeReportedAmount(amount) {
  if (!amount) return null
  const decimals = Number(amount.decimals)
  const delta = SOROBAN_DECIMALS - decimals
  // Fix loop 1, Fix 8: a report finer than the canonical scale would need integer division to
  // rescale down, silently truncating (rounding money away) with no signal to the caller. Decided:
  // reject (treat as unavailable) rather than truncate — money must never be silently lost.
  if (delta < 0) return null
  const units = BigInt(amount.units) * 10n ** BigInt(delta)
  return amountOf(units)
}

function buildSharesRead(rawShares, pps, now) {
  if (rawShares == null) return { state: 'unavailable', amount: null, checkedAt: now }
  const units = sharesToAssetUnits(rawShares, pps)
  if (units == null) return { state: 'unavailable', amount: null, checkedAt: now } // shares known, price wasn't
  return { state: 'known', amount: amountOf(units), checkedAt: now }
}

function buildIdleRead(rawIdle, now) {
  if (rawIdle == null) return { state: 'unavailable', amount: null, checkedAt: now }
  return { state: 'known', amount: amountOf(rawIdle), checkedAt: now }
}

// Task 10: the multi-child counterpart of the old single-child `mapExecutionStatus` switch (now
// deleted -- this fully replaces it) — the most-advanced status among every one of this agent's
// valid Base children wins
// ('queued' only when EVERY in-flight child is still queued; any child past that is 'executing';
// no in-flight child but at least one landed is 'succeeded'; otherwise every child failed).
// Reduces to the exact old per-child result whenever there is only one child (every existing
// single-child test keeps its exact expectation).
function summarizeExecutionStatus(children) {
  const inFlight = children.filter(
    (c) => c.executionStatus !== 'failed' && !TERMINAL_BASE_STATUSES.has(c.executionStatus)
  )
  if (inFlight.length > 0) {
    return inFlight.every((c) => c.executionStatus === 'queued') ? 'queued' : 'executing'
  }
  if (children.some((c) => TERMINAL_BASE_STATUSES.has(c.executionStatus))) return 'succeeded'
  return 'failed'
}

// Review round 1, finding 5 (Critical->Important, fixed): 'failed' is deliberately ABSENT from
// this ranked list. It used to rank above 'deposited'/'held', so a failed sibling could win the
// representative slot over money a live read just proved landed. An unranked status falls to
// `?? -1` below, so any real progress (even 'queued') always beats a failed sibling.
const STATUS_PROGRESS = new Map(
  ['queued', 'accepted', 'burn-confirmed', 'minted', 'deposited', 'held'].map((s, i) => [s, i])
)
// Which child's own `custody` best represents a whole GROUP: the most-advanced one — once any part
// of a shared position has landed, the group's honest "home" is wherever it landed, not an
// earlier in-flight claim. For a single child this trivially returns that child.
function mostAdvancedChild(children) {
  return children.reduce((a, b) =>
    (STATUS_PROGRESS.get(b.executionStatus) ?? -1) > (STATUS_PROGRESS.get(a.executionStatus) ?? -1)
      ? b
      : a
  )
}

// Fix loop 1, Fix 1 (CRITICAL): `poolAddress` is the EVM pool address readPositions.js returns
// as `pool` — NOT `proxyTarget`, which is a venue slug ('aave-v3', 'morpho-blue', 'moonwell';
// BASE_POOL_CATALOG, config.js) that can never match an on-chain address. Comparing against the
// slug always missed, so every settled Base allocation with a successful live read was valued at
// a fabricated zero.
function liveUnitsForPool(liveAccount, poolAddress) {
  // Fix loop 1, Fix 4: loadIndexedBasePositions only ever queries BASE_POOL_CATALOG addresses —
  // a pool absent from that catalog (a historical/retired allocation) was never asked about at
  // all, so treating its absence from `positions` as a confirmed zero was wrong; it's unknown.
  const queried = BASE_POOL_CATALOG.some(
    (p) => p.address.toLowerCase() === String(poolAddress).toLowerCase()
  )
  if (!queried) return null
  const pos = (liveAccount.positions ?? []).find(
    (p) => String(p.pool).toLowerCase() === String(poolAddress).toLowerCase()
  )
  // readPositions() filters out zero-share pools entirely (base/readPositions.js) — absence here,
  // once we know the pool WAS queried, is a confirmed zero, not a missing read.
  return pos ? BigInt(pos.assets) : 0n
}

function sumReported(children) {
  let sum = 0n
  let anyKnown = false
  let rejected = false
  for (const c of children) {
    const reported = canonicalizeReportedAmount(c.amount)
    if (reported) {
      sum += BigInt(reported.units)
      anyKnown = true
    } else {
      rejected = true
    }
  }
  return { sum, anyKnown, rejected }
}

// Task 10: values ONE Base position group (every child sharing the same kernel+vault+asset — see
// baseChildPositions.js's normalizeBaseChildren). Terminal children (deposited/held) are merged
// on-chain already; in-flight children have not landed yet.
//
// Review round 1, finding 1 (Critical, fixed): a group is valued from the live on-chain balance
// OR from reported evidence, NEVER additively from both. The live balance for a kernel+pool
// already IS the whole current truth the moment it can be read — it was double-counting to also
// add an in-flight sibling's reported amount on top, because that sibling's money may already be
// INSIDE the live balance under a stale lifecycle status (a lifecycle report stuck/dead-lettered
// while the deposit itself already landed). We cannot tell landed-but-unreported apart from
// genuinely-still-elsewhere, so an in-flight sibling next to a successful live read contributes
// NOTHING numerically and is flagged `base-inflight-unaccounted` instead — a coverage downgrade,
// never a guess in either direction. Reported evidence (terminal AND in-flight) is only summed
// when there is no live read to double-count against at all.
function valueBaseGroup({ group, children, baseAccountsMap }) {
  const terminal = children.filter((c) => TERMINAL_BASE_STATUSES.has(c.executionStatus))
  const inFlight = children.filter(
    (c) => c.executionStatus !== 'failed' && !TERMINAL_BASE_STATUSES.has(c.executionStatus)
  )
  const failed = children.filter((c) => c.executionStatus === 'failed')

  const problems = []
  let units = 0n
  let known = false
  let live = false

  if (terminal.length > 0) {
    const account = baseAccountsMap.get(group.kernelAddress)
    const liveUnits = account ? liveUnitsForPool(account, group.poolAddress) : null
    if (liveUnits != null) {
      // The live balance IS the whole truth for this kernel+pool right now — report it alone.
      units = liveUnits * BASE_TO_CANONICAL_SCALE
      known = true
      live = true
      if (inFlight.length > 0) problems.push('base-inflight-unaccounted')
    } else {
      problems.push('base-read-unavailable')
      // No live confirmation exists for this group at all — fall back to the sum of every
      // child's own reported evidence (terminal AND in-flight; nothing to double-count against).
      const { sum, anyKnown, rejected } = sumReported([...terminal, ...inFlight])
      if (rejected) problems.push('base-reported-amount-rejected')
      if (anyKnown) {
        units = sum
        known = true
      }
    }
  } else {
    // Nothing has landed yet — no live read applies; sum whatever is reported in-flight (mirrors
    // the pre-Task-10 single-child rule exactly).
    const { sum, anyKnown, rejected } = sumReported(inFlight)
    if (rejected) problems.push('base-reported-amount-rejected')
    if (anyKnown) {
      units = sum
      known = true
    }
  }

  if (failed.length > 0) problems.push('base-execution-failed')

  return { units: known ? units : null, problems, live }
}

// Fix loop 2, Fix 3 (bullet 1): both records below used to hardcode `custody: {location:'unknown'}`
// inline, which meant custody.js's own `scope.state !== 'known'` guard was never actually reached
// by the only production caller — routing through custodyForAgent with the real (unavailable)
// scope state makes that guard live code again, not dead code only exercised by custody.test.js's
// own unit tests. Output is unchanged (still 'unknown') by construction.
const UNAVAILABLE_LEG = { state: 'unavailable', amount: null }

function unavailableScopeRecord(address, now) {
  return {
    address,
    scope: { state: 'unavailable', value: null, checkedAt: now },
    vaultShares: { state: 'unavailable', amount: null, checkedAt: now },
    idleToken: { state: 'unavailable', amount: null, checkedAt: now },
    amount: null,
    executionStatus: 'unknown',
    custody: custodyForAgent({
      scope: { state: 'unavailable' },
      vaultShares: UNAVAILABLE_LEG,
      idleToken: UNAVAILABLE_LEG,
      baseChild: null,
    }),
    custodyBreakdown: [],
    problems: ['scope-read-failed'],
  }
}

// Outer Promise.allSettled's rejection fallback: whatever the read model itself learned before
// blowing up is gone, but the OTHER agents in this run must not lose theirs (see ownerDiscovery.js
// for the same "one dead read must not drop the whole owner" philosophy).
function unreadableRecord(address, now) {
  return {
    address,
    scope: { state: 'unavailable', value: null, checkedAt: now },
    vaultShares: { state: 'unavailable', amount: null, checkedAt: now },
    idleToken: { state: 'unavailable', amount: null, checkedAt: now },
    amount: null,
    executionStatus: 'unknown',
    custody: custodyForAgent({
      scope: { state: 'unavailable' },
      vaultShares: UNAVAILABLE_LEG,
      idleToken: UNAVAILABLE_LEG,
      baseChild: null,
    }),
    custodyBreakdown: [],
    problems: ['unexpected-error'],
  }
}

// Fix loop 2, Fix 1: the yield gate must key off whether THIS agent's OWN vault-shares leg is
// confirmed positive, not the collapsed custody.location summary — a split agent (real vault money
// alongside a Base child) reports custody.location:'unknown' by design (a single value can't
// honestly name two places at once), but its vault leg is still known and still earns real Blend
// yield. Falls back to the collapsed location when `vaultShares` isn't present at all, which only
// happens for aggregateOwnerPositions's own synthetic test fixtures (never a real production
// record — every real OwnerMoneyReadV1 always carries `vaultShares`).
function hasKnownVaultLeg(a) {
  if (a.vaultShares) {
    return (
      a.vaultShares.state === 'known' &&
      a.vaultShares.amount != null &&
      BigInt(a.vaultShares.amount.units) > 0n
    )
  }
  return Boolean(a.amount) && a.custody?.location === 'stellar-vault'
}

// Fix loop 1, Fix 3: a leg counts toward the sum only when its OWN read is truly 'known' — never
// treat an 'unavailable' leg as a silent zero contribution.
function knownLegUnits(read) {
  return read?.state === 'known' && read.amount != null ? BigInt(read.amount.units) : 0n
}
function isLegKnown(read) {
  return read?.state === 'known' && read.amount != null
}

function isKnownPositiveAmount(amount) {
  return amount != null && BigInt(amount.units) > 0n
}

// Fix loop 1, Fixes 2 & 3: a per-agent `amount` can be non-null yet still be incomplete evidence
// — a stale Base figure kept only because the live read couldn't run, or the Stellar-only
// remainder of a Base leg that outright failed. These problem markers say the underlying READ was
// incomplete, which is a different axis from scope-revoked/scope-expired (a fully-known balance
// that simply can't move right now — see the "revoked-but-funded" product truth) and must not be
// conflated with it. Hoisted above readOneAgentMoney/readOwnerMoney (was previously declared only
// beside aggregateOwnerPositions) so readOwnerMoney's own owner-wide completeness gate (review
// round 1, finding 4) can share this exact set rather than re-deriving it.
const READ_INCOMPLETE_PROBLEMS = new Set([
  'vault-shares-unavailable',
  'idle-token-unavailable',
  'base-read-unavailable',
  'base-execution-failed',
  'base-reported-amount-rejected',
  'base-child-invalid',
  'base-child-conflict',
  'base-inflight-unaccounted',
])

// Review round 1, finding 8: a real, catalog-backed pool name for a Base leg's identity, so the
// renderer can show WHICH pool a leg belongs to instead of two visually identical rows.
function poolNameFor(poolAddress) {
  const cat = BASE_POOL_CATALOG.find(
    (p) => p.address.toLowerCase() === String(poolAddress ?? '').toLowerCase()
  )
  return cat?.name ?? null
}

// Review round 1, finding 6: derives a leg's coverage reason from the SIGNAL that actually caused
// it, instead of the old `live ? null : 'stale'` ternary (which mislabeled every in-flight group
// and every failed live-re-read as 'stale'). 'stale' is reserved for R2's own meaning — the
// association RECORD itself hasn't been updated recently (`child.freshness`) — never conflated
// with a read failure or an ordinary in-flight bridge.
function coverageReasonFor({ units, groupProblems, groupChildren }) {
  if (units == null) return 'unavailable'
  if (
    groupProblems.includes('base-read-unavailable') ||
    groupProblems.includes('base-inflight-unaccounted')
  )
    return 'unavailable'
  if (groupChildren.some((c) => c.freshness === 'stale')) return 'stale'
  return null
}

async function readOneAgentMoney({
  row,
  readVaultShares,
  readTokenBalance,
  pps,
  baseAccountsMap,
  now,
}) {
  const address = row.address
  if (row.scopeReadStatus !== 'ok') return unavailableScopeRecord(address, now)

  const problems = []
  if (row.revoked) problems.push('scope-revoked')
  const nowSec = Math.floor(now / 1000)
  if (Number.isFinite(row.expiry) && row.expiry > 0 && row.expiry <= nowSec)
    problems.push('scope-expired')

  // Fix loop 1, Fix 8 (bullet 4): computed once and reused below (custodyForAgent + the returned
  // record) instead of a second hardcoded `{ state: 'known' }` literal at the custody call site —
  // by construction this is always 'known' here (the failed-scope-read case already returned
  // above), but one computed value can't silently drift out of sync with itself.
  const scope = {
    state: 'known',
    value: {
      vault: row.vault,
      revoked: row.revoked,
      expiry: row.expiry,
      authorized: row.authorized,
    },
    checkedAt: now,
  }

  // Belt-and-braces (readVaultShares/readTokenBalance already catch internally and resolve null
  // on RPC failure — see agentDeposit.js): allSettled here guards only against an injected/future
  // implementation that throws instead, same non-load-bearing posture as ownerDiscovery.js.
  const [sharesR, idleR] = await Promise.allSettled([
    readVaultShares(address),
    readTokenBalance(address),
  ])
  const rawShares = sharesR.status === 'fulfilled' ? sharesR.value : null
  const rawIdle = idleR.status === 'fulfilled' ? idleR.value : null

  const vaultShares = buildSharesRead(rawShares, pps, now)
  const idleToken = buildIdleRead(rawIdle, now)
  if (vaultShares.state === 'unavailable') problems.push('vault-shares-unavailable')
  if (idleToken.state === 'unavailable') problems.push('idle-token-unavailable')

  // Task 10: every valid Base child survives, grouped by the real on-chain position it shares
  // with any sibling — never a single picked "latest" child.
  const normalized = normalizeBaseChildren(row.baseChildren)
  if (normalized.invalid.length > 0) problems.push('base-child-invalid')
  if (normalized.conflicts.length > 0) problems.push('base-child-conflict')

  let amount = null
  let executionStatus = 'idle'
  // Every base leg this agent can prove, each carrying its OWN real identity (kernelAddress +
  // poolAddress) — the fix for PositionList.jsx's key collision (two Base children on one agent
  // used to render on the exact same React key): each leg here is distinguishable.
  const baseLegs = []

  if (normalized.groups.length > 0) {
    executionStatus = summarizeExecutionStatus(normalized.children)

    let anyGroupKnown = false
    let totalBaseUnits = 0n
    for (const group of normalized.groups) {
      const groupChildren = normalized.children.filter((c) =>
        group.childAllocationIds.includes(c.allocationId)
      )
      const { units, problems: groupProblems } = valueBaseGroup({
        group,
        children: groupChildren,
        baseAccountsMap,
      })
      problems.push(...groupProblems)
      const representative = mostAdvancedChild(groupChildren)
      baseLegs.push({
        location: representative.custody?.location ?? 'unknown',
        amount: units != null ? amountOf(units) : null,
        kernelAddress: group.kernelAddress,
        poolAddress: group.poolAddress,
        asset: group.asset,
        poolName: poolNameFor(group.poolAddress),
        coverageReason: coverageReasonFor({ units, groupProblems, groupChildren }),
      })
      if (units != null) {
        anyGroupKnown = true
        totalBaseUnits += units
      }
    }

    // Fix loop 1, Fix 3: every leg whose balance is actually known contributes — a bridge agent
    // can hold real money on BOTH sides at once (not yet swept, or swept but still accruing idle
    // Stellar dust). Only truly nothing-known-anywhere stays null.
    const stellarUnits = knownLegUnits(vaultShares) + knownLegUnits(idleToken)
    const stellarKnown = isLegKnown(vaultShares) || isLegKnown(idleToken)
    if (anyGroupKnown || stellarKnown) {
      amount = amountOf(totalBaseUnits + stellarUnits)
    }
  } else if (vaultShares.state === 'known' && idleToken.state === 'known') {
    // Fix loop 2, Fix 3 (bullet 4): unlike the base-groups branch above (which sums whatever legs
    // are individually known, tolerating one side being unread), a non-bridge agent requires BOTH
    // legs known before reporting any amount at all. That's safe specifically because there is no
    // in-flight child to race against: crossChainFarm.js awaits the burn (`burn(...)`, line ~116)
    // and only writes the durable association afterwards (`postFarmFn(...)`, line ~130) — so a
    // `queued`/`accepted` child can never exist with its units still sitting in this agent's own
    // Stellar balances. A plain agent's two legs are independent facts about the SAME idle money,
    // not a race between two systems, so the stricter both-known rule is the right one here.
    amount = amountOf(BigInt(vaultShares.amount.units) + BigInt(idleToken.amount.units))
  }

  // custody / custodyBreakdown: zero or one base leg routes through custody.js unchanged (byte-
  // identical to the pre-Task-10 single-child behaviour); two or more distinct base positions
  // can't be honestly represented by custody.js's single-`baseChild` API, so they're composed
  // directly here, mirroring its own "two independently-known legs can't be one location" rule.
  let custody
  let custodyBreakdown
  if (baseLegs.length <= 1) {
    const leg = baseLegs[0] ?? null
    custody = custodyForAgent({
      scope,
      vaultShares,
      idleToken,
      baseChild: leg ? { custody: { location: leg.location } } : null,
    })
    custodyBreakdown = custodyBreakdownForAgent({
      scope,
      vaultShares,
      idleToken,
      baseChild: leg ? { custody: { location: leg.location }, amount: leg.amount } : null,
    }).map((entry) =>
      leg && entry.amount === leg.amount
        ? {
            ...entry,
            kernelAddress: leg.kernelAddress,
            poolAddress: leg.poolAddress,
            asset: leg.asset,
            poolName: leg.poolName,
            coverageReason: leg.coverageReason,
          }
        : entry
    )
  } else {
    custodyBreakdown = []
    if (scope.state === 'known') {
      if (isKnownPositiveAmount(vaultShares.amount) && vaultShares.state === 'known')
        custodyBreakdown.push({ location: 'stellar-vault', amount: vaultShares.amount })
      if (isKnownPositiveAmount(idleToken.amount) && idleToken.state === 'known')
        custodyBreakdown.push({ location: 'agent', amount: idleToken.amount })
    }
    for (const leg of baseLegs) {
      if (leg.amount != null) {
        custodyBreakdown.push({
          location: leg.location,
          amount: leg.amount,
          kernelAddress: leg.kernelAddress,
          poolAddress: leg.poolAddress,
          asset: leg.asset,
          poolName: leg.poolName,
          coverageReason: leg.coverageReason,
        })
      }
    }
    // Two or more distinct Base positions are, by construction, two or more distinct places —
    // never collapsible to one honest `location` string, regardless of whether every leg's
    // amount happened to resolve.
    custody = { location: 'unknown' }
  }

  return {
    address,
    scope,
    vaultShares,
    idleToken,
    amount,
    executionStatus,
    custody,
    custodyBreakdown,
    problems,
  }
}

/**
 * @param {{owner?: string, discovery: object, stellar?: object, base?: object,
 *   associationDelivery?: {events?: Array<{allocationId?:string, status:string}>}|null,
 *   now?: number}} p
 *   `discovery` is an OwnerDiscoveryV1 envelope (ownerDiscovery.js). `stellar`/`base` are
 *   injectable read seams (tests); production defaults are the real Stellar RPC reads and
 *   dashboardPositions.js's loadIndexedBasePositions. `associationDelivery` is an OPTIONAL
 *   injected input (Task 10, R2) -- the relayer's own dead-letter signal
 *   (`GET /status/:jobId`'s `associationDelivery.events[].status==='dead'`) is not wired through
 *   any UI-facing code path today (crossChainFarm.js's runFarmFlow drops it -- see
 *   task-10-interface-notes.md's Known Hazards table); a caller that DOES have it can pass it here.
 *   Its absence never upgrades `associationCoverage`: per R2's constraint 1, an owner with at
 *   least one Base child and no supplied `associationDelivery` reads `associationCoverage:
 *   {state:'unknown', reasons:['unavailable']}` (fail closed) until a caller actually wires this
 *   through — not `'complete'` merely because nothing contradicted it.
 * @returns {Promise<{status:'complete'|'partial'|'unavailable', owner:string|null,
 *   networkId:string|null, checkedAt:number, agents:Array, baseBindingStatus:string,
 *   baseIdle:Array<{kernelAddress:string, state:'known'|'unavailable', amount:object|null,
 *   checkedAt:number}>, stellarYield:{state:string, apy:number|null},
 *   stellarSubtotalUnits:bigint, baseSubtotalUnits:bigint, completeBaseTotalUnits:bigint|null,
 *   overallTotalUnits:bigint|null, baseValuationKind:string,
 *   associationCoverage:{state:'complete'|'partial'|'unknown', reasons:string[]},
 *   baseSourceCoverage:{state:'complete'|'unknown'},
 *   basePositionCoverage:{state:'complete'|'partial'|'unknown', reasons:string[]}}>}
 */
export async function readOwnerMoney({
  owner,
  discovery,
  stellar = {},
  base = {},
  associationDelivery = null,
  now = Date.now(),
}) {
  const {
    readVaultShares = _readVaultShares,
    readTokenBalance = _readTokenBalance,
    readPricePerShare = _readPricePerShare,
    readSupplyAprBps = _readSupplyAprBps,
  } = stellar
  const { loadIndexedBasePositions = _loadIndexedBasePositions } = base

  const rows = discovery?.agents ?? []

  // Only a TERMINAL (deposited/held) baseChild needs a live cross-check (see readOneAgentMoney) —
  // gather every such kernel address ONCE so N agents cost one batched Base read, not N.
  const indexedBaseAccounts = [
    ...new Set(
      rows.flatMap((row) =>
        (row.baseChildren ?? [])
          .filter((c) => TERMINAL_BASE_STATUSES.has(c.executionStatus))
          .map((c) => c.kernelAddress)
      )
    ),
  ]

  const [pps, baseResult] = await Promise.all([
    readPricePerShare().catch(() => null),
    indexedBaseAccounts.length > 0
      ? loadIndexedBasePositions({ stellarOwner: owner, indexedBaseAccounts }).catch(() => ({
          status: 'unavailable',
          accounts: [],
        }))
      : Promise.resolve({ status: 'empty', accounts: [] }),
  ])
  const baseAccountsMap = new Map(
    (baseResult.accounts ?? []).map((a) => [String(a.kernelAddress).toLowerCase(), a])
  )

  // Fix loop 2, Fix 2: idleUsdc sits at the KERNEL, not any one agent — several bridge agents can
  // legitimately share the same kernel address, so folding it into any single agent's `amount`
  // would double-count it across them the moment more than one agent points at that kernel.
  // Surfaced instead as its own list, keyed by kernel address, for aggregateOwnerPositions to turn
  // into an owner-level `unattributed` bucket. `idleUsdc: null` (dashboardPositions.js's honest
  // "the balanceOf call itself failed" — never a guessed 0n) stays 'unavailable' here too, so
  // Fix loop 1, Fix 6's null finally has a consumer instead of being read and discarded.
  const baseIdle = (baseResult.accounts ?? []).map((a) => ({
    kernelAddress: String(a.kernelAddress).toLowerCase(),
    state: a.idleUsdc == null ? 'unavailable' : 'known',
    amount: a.idleUsdc == null ? null : amountOf(BigInt(a.idleUsdc) * BASE_TO_CANONICAL_SCALE),
    checkedAt: now,
  }))

  const settled = await Promise.allSettled(
    rows.map((row) =>
      readOneAgentMoney({ row, readVaultShares, readTokenBalance, pps, baseAccountsMap, now })
    )
  )
  const agents = settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : unreadableRecord(rows[i]?.address, now)
  )

  // The vault APR is one shared, owner-independent fact — skip the network call entirely when
  // nobody's confirmed money is actually in the vault (nothing would use it). Fix loop 2, Fix 1:
  // keys off the agent's own vault-shares leg (hasKnownVaultLeg), not the collapsed
  // custody.location summary — a split agent (real vault money + a Base child) reports
  // custody.location:'unknown' by design, but its vault leg is still known and still earns yield.
  const hasVaultCustody = agents.some(hasKnownVaultLeg)
  let stellarYield = { state: 'unavailable', apy: null }
  if (hasVaultCustody) {
    const aprBps = await readSupplyAprBps(SOROBAN_BLEND_POOL_ADDRESS).catch(() => null)
    stellarYield =
      aprBps != null ? { state: 'live', apy: aprBps / 100 } : { state: 'unavailable', apy: null }
  }

  // --- Task 10: owner-wide subtotal + coverage composition (additive — R7). Computed from the
  // OWNER-WIDE normalized group set (not summed per-agent) so a kernel+vault shared by more than
  // one agent is valued exactly once, never double-counted, the same way baseIdle already avoids
  // double-counting shared kernel idle balances above. ---
  const allBaseChildren = rows.flatMap((row) => row.baseChildren ?? [])
  const ownerNormalized = normalizeBaseChildren(allBaseChildren)
  // Review round 1, finding 2 (Critical, fixed): no producer in this tree ever emits
  // `baseChildren` as null/missing — `joinBaseAssociations` (associations.js) and
  // `ownerDiscovery.js`'s `placeholderApiFields` both always stamp `[]`, including the exact
  // "genuinely unavailable, never indexed" case. Testing for a shape nothing ever produces was a
  // dead branch that always read `false`, so an unreadable Base source silently passed as
  // positively-confirmed-empty. The one real, always-present signal for "did we get a complete
  // enumeration of this owner's agents (and therefore their Base children)" is the envelope's own
  // `status` — anything short of 'complete' means some agent, and therefore possibly its Base
  // children, may be missing from `rows` entirely. Fail closed on that instead.
  const sourceUnknown = discovery?.status !== 'complete'

  const stellarSubtotalUnits = agents.reduce(
    (sum, a) => sum + knownLegUnits(a.vaultShares) + knownLegUnits(a.idleToken),
    0n
  )
  const stellarFullyKnown =
    discovery?.status === 'complete' &&
    agents.every((a) => isLegKnown(a.vaultShares) && isLegKnown(a.idleToken))

  let terminalGroupsTotal = 0
  let terminalGroupsLive = 0
  let baseSubtotalUnits = 0n
  let anyGroupUnknown = false
  // Review round 1, finding 4 (Important, fixed): the old loop kept only `{units, live}`,
  // discarding `valueBaseGroup`'s own `problems` — so a group could carry a
  // READ_INCOMPLETE_PROBLEMS marker (e.g. a failed sibling, an unaccounted in-flight sibling) and
  // still count as fully complete here, while `aggregateOwnerPositions` downgraded to 'partial' on
  // the IDENTICAL evidence. Any such marker on any group now clears completeness.
  let anyGroupIncomplete = false
  for (const group of ownerNormalized.groups) {
    const groupChildren = ownerNormalized.children.filter((c) =>
      group.childAllocationIds.includes(c.allocationId)
    )
    const {
      units,
      live,
      problems: groupProblems,
    } = valueBaseGroup({ group, children: groupChildren, baseAccountsMap })
    if (group.hasTerminal) {
      terminalGroupsTotal += 1
      if (live) terminalGroupsLive += 1
    }
    if (units != null) baseSubtotalUnits += units
    else anyGroupUnknown = true
    if (groupProblems.some((p) => READ_INCOMPLETE_PROBLEMS.has(p))) anyGroupIncomplete = true
  }

  const hasTaintedEvidence =
    ownerNormalized.invalid.length > 0 || ownerNormalized.conflicts.length > 0
  const hasStaleAssociation = ownerNormalized.children.some((c) => c.freshness === 'stale')
  const hasDeadLetter = (associationDelivery?.events ?? []).some((e) => e?.status === 'dead')
  const hasChildren = ownerNormalized.children.length > 0
  const deliveryEvidenceSupplied = associationDelivery != null

  let associationState = 'complete'
  const associationReasons = []
  if (sourceUnknown || (ownerNormalized.children.length === 0 && hasTaintedEvidence)) {
    // The source itself couldn't be read, or every reported child was untrustworthy — nothing
    // usable survived to reason about.
    associationState = 'unknown'
    associationReasons.push('unavailable')
  } else if (hasChildren && !deliveryEvidenceSupplied) {
    // Review round 1, finding 3 (Important, fixed): R2's hard constraint 1 — "not being handed
    // delivery evidence must never produce 'complete'. Fail closed." — is stricter than the plain
    // per-signal mapping below. An owner with zero children still stays 'complete' (nothing was
    // ever expected here); an owner with at least one child but no supplied delivery evidence
    // cannot claim complete delivery coverage on a signal it never observed.
    associationState = 'unknown'
    associationReasons.push('unavailable')
  } else {
    if (hasTaintedEvidence) {
      associationState = 'partial'
      associationReasons.push('unavailable')
    }
    if (hasStaleAssociation) {
      associationState = 'partial'
      associationReasons.push('stale')
    }
    if (hasDeadLetter) {
      associationState = 'partial'
      associationReasons.push('dead-letter')
    }
  }
  const associationCoverage = { state: associationState, reasons: associationReasons }
  const baseSourceCoverage = { state: sourceUnknown ? 'unknown' : 'complete' }

  // Review round 1, finding 4's second bullet (fixed): an all-failed group has no terminal child
  // (hasTerminal stays false), so it never touched terminalGroupsTotal/Live at all — the old
  // `terminalGroupsTotal === 0 -> 'complete'` branch silently called that "complete" even though
  // its own value is unknown. `anyGroupUnknown` now gates the zero-terminal-groups case too.
  const basePositionState =
    terminalGroupsTotal > 0 && terminalGroupsLive < terminalGroupsTotal
      ? terminalGroupsLive === 0
        ? 'unknown'
        : 'partial'
      : anyGroupUnknown
        ? 'unknown'
        : 'complete'
  const basePositionCoverage = {
    state: basePositionState,
    reasons: basePositionState === 'complete' ? [] : ['unavailable'],
  }

  const baseFullyComplete =
    !anyGroupUnknown &&
    !anyGroupIncomplete &&
    associationState === 'complete' &&
    basePositionState === 'complete' &&
    baseSourceCoverage.state === 'complete'
  const completeBaseTotalUnits = baseFullyComplete ? baseSubtotalUnits : null
  const overallTotalUnits =
    stellarFullyKnown && completeBaseTotalUnits != null
      ? stellarSubtotalUnits + completeBaseTotalUnits
      : null

  return {
    status: discovery?.status ?? 'unavailable',
    owner: owner ?? discovery?.owner ?? null,
    networkId: discovery?.networkId ?? null,
    checkedAt: now,
    agents,
    baseBindingStatus: baseResult.status,
    baseIdle,
    stellarYield,
    stellarSubtotalUnits,
    baseSubtotalUnits,
    completeBaseTotalUnits,
    overallTotalUnits,
    baseValuationKind: BASE_VALUATION_KIND,
    associationCoverage,
    baseSourceCoverage,
    basePositionCoverage,
  }
}

export function aggregateOwnerPositions(reads) {
  const agents = reads?.agents ?? []
  const status = reads?.status ?? 'unavailable'

  let knownUnits = 0n
  let anyUnread = status === 'partial'
  const custodyBreakdown = {}
  const executionBreakdown = {}
  let problemAgentCount = 0

  for (const a of agents) {
    executionBreakdown[a.executionStatus] = (executionBreakdown[a.executionStatus] ?? 0) + 1
    if (a.problems?.length) problemAgentCount += 1
    if (a.problems?.some((p) => READ_INCOMPLETE_PROBLEMS.has(p))) anyUnread = true
    if (a.amount) {
      const units = BigInt(a.amount.units)
      knownUnits += units
      // Fix loop 2, Fix 1: a split agent's per-leg breakdown (Base-associated agents only) files
      // each independently-known leg under its OWN real location instead of collapsing the whole
      // known amount under the single 'unknown' summary — two known legs must never both land in
      // the same 'unknown' bucket. Agents without a breakdown (the common, non-split case) keep
      // the pre-existing whole-amount-under-one-location behavior.
      if (a.custodyBreakdown?.length) {
        for (const leg of a.custodyBreakdown) {
          custodyBreakdown[leg.location] =
            (custodyBreakdown[leg.location] ?? 0n) + BigInt(leg.amount.units)
        }
      } else {
        const loc = a.custody?.location ?? 'unknown'
        custodyBreakdown[loc] = (custodyBreakdown[loc] ?? 0n) + units
      }
    } else {
      anyUnread = true
    }
  }

  const state = status === 'unavailable' ? 'unavailable' : anyUnread ? 'partial' : 'known'

  // Final review, Fix 1 (CRITICAL): a Base kernel+pool shared by more than one agent (several
  // bridge agents legitimately sharing one kernel -- see this file's own header) folds its WHOLE
  // live balance into EVERY agent that independently reports a child pointing at it, so summing
  // agents[].amount double(N)-counts every shared group. readOwnerMoney already computes the
  // correct, owner-wide-deduped total for exactly this reason -- stellarSubtotalUnits sums each
  // agent's OWN legs (never shared across agents, so no dedup needed there) and baseSubtotalUnits
  // sums each owner-wide GROUP exactly once (:637-671) -- use that when the caller supplies it
  // (every real readOwnerMoney() result does). `knownUnits` (the old per-agent sum, still used
  // above for `anyUnread`/custodyBreakdown/state) stays the fallback for callers/tests that hand
  // this function a bare {status, agents} fixture without those fields; `state` itself is entirely
  // unaffected by this substitution.
  const dedupedUnits =
    reads?.stellarSubtotalUnits != null && reads?.baseSubtotalUnits != null
      ? reads.stellarSubtotalUnits + reads.baseSubtotalUnits
      : knownUnits

  const hasVaultCustody = agents.some(hasKnownVaultLeg)
  // Fix loop 1, Fix 7: 'no yield' is a positive claim that no vault money exists anywhere for
  // this owner — it can only be asserted once the total itself is fully known. A 'partial' or
  // 'unavailable' total might still be hiding a vault agent that simply couldn't be read yet.
  const yieldInfo =
    state !== 'known'
      ? { state: 'unavailable', apy: null }
      : hasVaultCustody
        ? (reads?.stellarYield ?? { state: 'unavailable', apy: null })
        : { state: 'none', apy: null }

  // Fix loop 2, Fix 2: idle USDC sitting at a shared Base kernel (e.g. after a partial withdraw
  // drained the pool position but left money at the kernel) is never attributable to one agent —
  // reported here on its own, keyed by kernel address, never folded into any agent's `amount` or
  // into `confirmedTotal`. Each entry keeps its OWN state so a consumer can tell a confirmed zero
  // (`state:'known'`, `amount` zero) apart from a failed read (`state:'unavailable'`, `amount`
  // null) instead of a single number pretending both cases look the same.
  const unattributed = Object.fromEntries(
    (reads?.baseIdle ?? []).map((k) => [
      k.kernelAddress,
      { state: k.state, amount: k.amount, checkedAt: k.checkedAt },
    ])
  )

  return {
    status,
    confirmedTotal: {
      state,
      amount: state === 'unavailable' ? null : amountOf(dedupedUnits),
    },
    // Base Sepolia pools are honest ERC-4626 1:1 custody proxies, not live yield venues — never
    // attribute Autofarm/Blend's live APR to confirmed money that is entirely Base custody.
    yield: yieldInfo,
    // No principal/share-price history is tracked by this read model — an "earned" figure would
    // have to be invented (the exact anti-pattern positionsStore.js's hardcoded
    // `unclaimedRewards: '0'` already commits elsewhere in this codebase). Always unavailable.
    earned: { state: 'unavailable', amount: null },
    custodyBreakdown: Object.fromEntries(
      Object.entries(custodyBreakdown).map(([k, v]) => [k, String(v)])
    ),
    unattributed,
    executionBreakdown,
    agentCount: agents.length,
    problemAgentCount,
  }
}
