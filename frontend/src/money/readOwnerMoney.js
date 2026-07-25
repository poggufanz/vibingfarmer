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
import { custodyForAgent } from './custody.js'

const TOKEN = 'USDC'
// Base Sepolia USDC is 6dp (base/config.js BASE_USDC_DECIMALS); every OwnerMoneyReadV1 amount
// this module produces is canonicalized to the Stellar side's 7dp so Stellar-vault and Base-proxy
// money can be summed as plain BigInt units without a per-field decimals lookup at every call site.
const BASE_DECIMALS = 6
const BASE_TO_CANONICAL_SCALE = 10n ** BigInt(SOROBAN_DECIMALS - BASE_DECIMALS)
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
  const units =
    delta >= 0 ? BigInt(amount.units) * 10n ** BigInt(delta) : BigInt(amount.units) / 10n ** BigInt(-delta)
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

function liveUnitsForPool(liveAccount, proxyTarget) {
  const pos = (liveAccount.positions ?? []).find(
    (p) => String(p.pool).toLowerCase() === String(proxyTarget).toLowerCase()
  )
  // readPositions() filters out zero-share pools entirely (base/readPositions.js) — absence here
  // is a confirmed zero, not a missing read (the whole account was already read successfully).
  return pos ? BigInt(pos.assets) : 0n
}

function unavailableScopeRecord(address, now) {
  return {
    address,
    scope: { state: 'unavailable', value: null, checkedAt: now },
    vaultShares: { state: 'unavailable', amount: null, checkedAt: now },
    idleToken: { state: 'unavailable', amount: null, checkedAt: now },
    amount: null,
    executionStatus: 'unknown',
    custody: { location: 'unknown' },
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
    custody: { location: 'unknown' },
    problems: ['unexpected-error'],
  }
}

async function readOneAgentMoney({ row, readVaultShares, readTokenBalance, pps, baseAccountsMap, now }) {
  const address = row.address
  if (row.scopeReadStatus !== 'ok') return unavailableScopeRecord(address, now)

  const problems = []
  if (row.revoked) problems.push('scope-revoked')
  const nowSec = Math.floor(now / 1000)
  if (Number.isFinite(row.expiry) && row.expiry > 0 && row.expiry <= nowSec) problems.push('scope-expired')

  // Belt-and-braces (readVaultShares/readTokenBalance already catch internally and resolve null
  // on RPC failure — see agentDeposit.js): allSettled here guards only against an injected/future
  // implementation that throws instead, same non-load-bearing posture as ownerDiscovery.js.
  const [sharesR, idleR] = await Promise.allSettled([readVaultShares(address), readTokenBalance(address)])
  const rawShares = sharesR.status === 'fulfilled' ? sharesR.value : null
  const rawIdle = idleR.status === 'fulfilled' ? idleR.value : null

  const vaultShares = buildSharesRead(rawShares, pps, now)
  const idleToken = buildIdleRead(rawIdle, now)
  if (vaultShares.state === 'unavailable') problems.push('vault-shares-unavailable')
  if (idleToken.state === 'unavailable') problems.push('idle-token-unavailable')

  const child = latestBaseChild(row.baseChildren)
  let amount = null
  let executionStatus = 'idle'

  if (child) {
    executionStatus = mapExecutionStatus(child.executionStatus)
    if (TERMINAL_BASE_STATUSES.has(child.executionStatus)) {
      // Funds are claimed to have landed at a queryable proxy — cross-check with a live read
      // rather than trusting the report's snapshot amount forever (the owner may have withdrawn
      // since the association was written; a live read is the current source of truth).
      const live = baseAccountsMap.get(String(child.kernelAddress).toLowerCase())
      if (live) {
        amount = amountOf(liveUnitsForPool(live, child.proxyTarget) * BASE_TO_CANONICAL_SCALE)
      } else {
        problems.push('base-read-unavailable')
        // Fall back to the durable evidence rather than nulling it out — Task 5's association
        // already passed its own on-chain scope re-check before being written; it is stale
        // evidence, not a guess.
        amount = canonicalizeReportedAmount(child.amount)
      }
    } else if (child.executionStatus === 'failed') {
      problems.push('base-execution-failed')
      amount = null // failed evidence cannot say where the money ended up — fail closed
    } else {
      // queued / accepted / burn-confirmed / minted: in flight. No live proxy read applies yet
      // (the funds have not landed anywhere queryable) — the reported amount is the current truth.
      amount = canonicalizeReportedAmount(child.amount)
    }
  } else if (vaultShares.state === 'known' && idleToken.state === 'known') {
    amount = amountOf(BigInt(vaultShares.amount.units) + BigInt(idleToken.amount.units))
  }

  const custody = custodyForAgent({
    scope: { state: 'known' },
    vaultShares,
    idleToken,
    baseChild: child ? { custody: child.custody } : null,
  })

  return {
    address,
    scope: {
      state: 'known',
      value: { vault: row.vault, revoked: row.revoked, expiry: row.expiry, authorized: row.authorized },
      checkedAt: now,
    },
    vaultShares,
    idleToken,
    amount,
    executionStatus,
    custody,
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
 *   stellarYield:{state:string, apy:number|null}}>}
 */
export async function readOwnerMoney({ owner, discovery, stellar = {}, base = {}, now = Date.now() }) {
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

  const settled = await Promise.allSettled(
    rows.map((row) => readOneAgentMoney({ row, readVaultShares, readTokenBalance, pps, baseAccountsMap, now }))
  )
  const agents = settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : unreadableRecord(rows[i]?.address, now)
  )

  // The vault APR is one shared, owner-independent fact — skip the network call entirely when
  // nobody's confirmed money is actually in the vault (nothing would use it).
  const hasVaultCustody = agents.some((a) => a.custody?.location === 'stellar-vault')
  let stellarYield = { state: 'unavailable', apy: null }
  if (hasVaultCustody) {
    const aprBps = await readSupplyAprBps(SOROBAN_BLEND_POOL_ADDRESS).catch(() => null)
    stellarYield = aprBps != null ? { state: 'live', apy: aprBps / 100 } : { state: 'unavailable', apy: null }
  }

  return {
    status: discovery?.status ?? 'unavailable',
    owner: owner ?? discovery?.owner ?? null,
    networkId: discovery?.networkId ?? null,
    checkedAt: now,
    agents,
    baseBindingStatus: baseResult.status,
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
    if (a.amount) {
      const units = BigInt(a.amount.units)
      knownUnits += units
      const loc = a.custody?.location ?? 'unknown'
      custodyBreakdown[loc] = (custodyBreakdown[loc] ?? 0n) + units
    } else {
      anyUnread = true
    }
  }

  const state = status === 'unavailable' ? 'unavailable' : anyUnread ? 'partial' : 'known'
  const hasVaultCustody = agents.some((a) => a.amount && a.custody?.location === 'stellar-vault')

  return {
    status,
    confirmedTotal: {
      state,
      amount: state === 'unavailable' ? null : amountOf(knownUnits),
    },
    // Base Sepolia pools are honest ERC-4626 1:1 custody proxies, not live yield venues — never
    // attribute Autofarm/Blend's live APR to confirmed money that is entirely Base custody.
    yield: hasVaultCustody ? (reads?.stellarYield ?? { state: 'unavailable', apy: null }) : { state: 'none', apy: null },
    // No principal/share-price history is tracked by this read model — an "earned" figure would
    // have to be invented (the exact anti-pattern positionsStore.js's hardcoded
    // `unclaimedRewards: '0'` already commits elsewhere in this codebase). Always unavailable.
    earned: { state: 'unavailable', amount: null },
    custodyBreakdown: Object.fromEntries(Object.entries(custodyBreakdown).map(([k, v]) => [k, String(v)])),
    executionBreakdown,
    agentCount: agents.length,
    problemAgentCount,
  }
}
