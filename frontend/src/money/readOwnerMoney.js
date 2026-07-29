// frontend/src/money/readOwnerMoney.js
// Pocket Crew "My money" Task 7: turns OwnerDiscoveryV1 (ownerDiscovery.js's discoverOwnerScopes)
// into the actual money and custody read model the /agent route renders. Every agent's Stellar
// vault-share/idle-token balances and — when a durable, relayer-attested Base association exists
// (Task 5) — its Base custody are read defensively (Promise.allSettled at TWO layers: the two
// Stellar reads per agent, and every agent against every other) so one bad address never blanks
// the rest. Unknown money is never rendered as zero: a read that could not be confirmed leaves
// `amount: null`, never a guessed number, matching the "never coerce a null" discipline
// ownerDiscovery.js and vaultReads.js already establish for this codebase.
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

// Most recent baseChildren entry (by reportedAt) — a bridge agent normally carries exactly one
// live allocation; if several exist, the freshest evidence is what "this agent's money" means.
function latestBaseChild(children) {
  if (!children || children.length === 0) return null
  return children.reduce((a, b) => (b.reportedAt > a.reportedAt ? b : a))
}

function mapExecutionStatus(associationStatus) {
  switch (associationStatus) {
    case 'queued':
      return 'queued'
    case 'accepted':
    case 'burn-confirmed':
    case 'minted':
      return 'executing'
    case 'deposited':
    case 'held':
      return 'succeeded'
    case 'failed':
      return 'failed'
    default:
      return 'unknown'
  }
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

  const child = latestBaseChild(row.baseChildren)
  let amount = null
  let executionStatus = 'idle'
  let baseUnits = null // null = the Base leg contributes nothing known this round; hoisted out of
  // the `if (child)` block below so custodyBreakdownForAgent can see it too (fix loop 2, Fix 1).

  if (child) {
    executionStatus = mapExecutionStatus(child.executionStatus)

    if (TERMINAL_BASE_STATUSES.has(child.executionStatus)) {
      // Funds are claimed to have landed at a queryable proxy — cross-check with a live read
      // rather than trusting the report's snapshot amount forever (the owner may have withdrawn
      // since the association was written; a live read is the current source of truth).
      const live = baseAccountsMap.get(String(child.kernelAddress).toLowerCase())
      const liveUnits = live ? liveUnitsForPool(live, child.poolAddress) : null
      if (liveUnits != null) {
        baseUnits = liveUnits * BASE_TO_CANONICAL_SCALE
      } else {
        problems.push('base-read-unavailable')
        // Fall back to the durable evidence rather than nulling it out — Task 5's association
        // already passed its own on-chain scope re-check before being written; it is stale
        // evidence, not a guess. Still visible in `amount` below; aggregateOwnerPositions
        // downgrades the owner-level total to 'partial' on this same problem marker rather than
        // trusting it as fresh (fix loop 1, Fix 2).
        const reported = canonicalizeReportedAmount(child.amount)
        baseUnits = reported ? BigInt(reported.units) : null
      }
    } else if (child.executionStatus === 'failed') {
      problems.push('base-execution-failed')
      // Fix loop 1, Fix 3: failed evidence cannot say where the BASE leg ended up, but it says
      // nothing about the Stellar leg (read independently above) — only the Base contribution
      // fails closed here; it no longer nulls the whole agent's amount.
    } else {
      // queued / accepted / burn-confirmed / minted: in flight. No live proxy read applies yet
      // (the funds have not landed anywhere queryable) — the reported amount is the current truth.
      const reported = canonicalizeReportedAmount(child.amount)
      if (reported) {
        baseUnits = BigInt(reported.units)
      } else {
        baseUnits = null
        // Fix loop 2, Fix 3 (bullet 2): canonicalizeReportedAmount's own rejection (the reported
        // figure is finer than canonical precision — see its comment above) used to fall through
        // silently here with no marker, so a Stellar-only remainder could look like a fully known
        // amount at the aggregate even though real Base evidence was discarded underneath it.
        problems.push('base-reported-amount-rejected')
      }
    }

    // Fix loop 1, Fix 3: every leg whose balance is actually known contributes — a bridge agent
    // can hold real money on BOTH sides at once (not yet swept, or swept but still accruing idle
    // Stellar dust). Only truly nothing-known-anywhere stays null.
    const stellarUnits = knownLegUnits(vaultShares) + knownLegUnits(idleToken)
    const stellarKnown = isLegKnown(vaultShares) || isLegKnown(idleToken)
    if (baseUnits != null || stellarKnown) {
      amount = amountOf((baseUnits ?? 0n) + stellarUnits)
    }
  } else if (vaultShares.state === 'known' && idleToken.state === 'known') {
    // Fix loop 2, Fix 3 (bullet 4): unlike the `if (child)` branch above (which sums whatever legs
    // are individually known, tolerating one side being unread), a non-bridge agent requires BOTH
    // legs known before reporting any amount at all. That's safe specifically because there is no
    // in-flight child to race against: crossChainFarm.js awaits the burn (`burn(...)`, line ~116)
    // and only writes the durable association afterwards (`postFarmFn(...)`, line ~130) — so a
    // `queued`/`accepted` child can never exist with its units still sitting in this agent's own
    // Stellar balances. A plain agent's two legs are independent facts about the SAME idle money,
    // not a race between two systems, so the stricter both-known rule is the right one here.
    amount = amountOf(BigInt(vaultShares.amount.units) + BigInt(idleToken.amount.units))
  }

  const custody = custodyForAgent({
    scope,
    vaultShares,
    idleToken,
    baseChild: child ? { custody: child.custody } : null,
  })
  // Fix loop 2, Fix 1: per-leg counterpart to `custody` above — empty for any agent without a
  // Base child (custody.location is already that agent's one real location; nothing to split).
  const custodyBreakdown = custodyBreakdownForAgent({
    scope,
    vaultShares,
    idleToken,
    baseChild: child
      ? { custody: child.custody, amount: baseUnits != null ? amountOf(baseUnits) : null }
      : null,
  })

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
 * @param {{owner?: string, discovery: object, stellar?: object, base?: object, now?: number}} p
 *   `discovery` is an OwnerDiscoveryV1 envelope (ownerDiscovery.js). `stellar`/`base` are
 *   injectable read seams (tests); production defaults are the real Stellar RPC reads and
 *   dashboardPositions.js's loadIndexedBasePositions.
 * @returns {Promise<{status:'complete'|'partial'|'unavailable', owner:string|null,
 *   networkId:string|null, checkedAt:number, agents:Array, baseBindingStatus:string,
 *   baseIdle:Array<{kernelAddress:string, state:'known'|'unavailable', amount:object|null,
 *   checkedAt:number}>, stellarYield:{state:string, apy:number|null}}>}
 */
export async function readOwnerMoney({
  owner,
  discovery,
  stellar = {},
  base = {},
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

  return {
    status: discovery?.status ?? 'unavailable',
    owner: owner ?? discovery?.owner ?? null,
    networkId: discovery?.networkId ?? null,
    checkedAt: now,
    agents,
    baseBindingStatus: baseResult.status,
    baseIdle,
    stellarYield,
  }
}

/**
 * Pure aggregate over a readOwnerMoney() envelope. `confirmedTotal.state` can never read 'known'
 * unless BOTH the discovery envelope was 'complete' AND every enumerated agent's amount was
 * itself known — an incomplete agent set or any single unread agent downgrades to 'partial' (the
 * best-known sum still ships, just honestly labeled), and a wholly unavailable discovery reports
 * `amount: null` rather than a deceptive $0.
 * @param {{status:string, agents:Array, stellarYield?:object}} reads readOwnerMoney()'s envelope
 */
// Fix loop 1, Fixes 2 & 3: a per-agent `amount` can be non-null yet still be incomplete evidence
// — a stale Base figure kept only because the live read couldn't run, or the Stellar-only
// remainder of a Base leg that outright failed. These problem markers say the underlying READ was
// incomplete, which is a different axis from scope-revoked/scope-expired (a fully-known balance
// that simply can't move right now — see the "revoked-but-funded" product truth) and must not be
// conflated with it.
const READ_INCOMPLETE_PROBLEMS = new Set([
  'vault-shares-unavailable',
  'idle-token-unavailable',
  'base-read-unavailable',
  'base-execution-failed',
  'base-reported-amount-rejected',
])

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
      amount: state === 'unavailable' ? null : amountOf(knownUnits),
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
