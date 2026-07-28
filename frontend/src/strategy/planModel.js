// frontend/src/strategy/planModel.js
// Strategy Task 2 (Pocket Crew redesign, Wave 1). Turns a strategist's destination allocation --
// how much goes to the one truthful Stellar venue (venueTruth.js) vs. how much goes to which Base
// custody-proxy pools -- into the actual on-chain crew. The strategist chooses the destination
// split; THIS module chooses agent cardinality (approved ruling: never invent separate Stellar
// protocols merely to fill crew slots). A Base destination allocation, however many pools it
// funds, always collapses to exactly ONE bridge agent -- the CCTP burn is a single mandate, not
// one per pool -- with the individual pools carried as that agent's `children`.
//
// Boundary-amount ruling: units are integer base-unit strings; all arithmetic here is bigint.
// Conversion to a JS display number happens only at the named boundary (buildStrategyViewModel).
import { normalizeVenue } from './venueTruth.js'

export const RISK_PROFILES = Object.freeze({
  low: { label: 'Steady', targetSlots: 1 },
  med: { label: 'Balanced', targetSlots: 2 },
  high: { label: 'Adventurous', targetSlots: 3 },
})

const STELLAR_NETWORK_ID = 'stellar-testnet'
const DEFAULT_PERIOD_SECONDS = 3600
const DEFAULT_EXPIRY_SECONDS = 3600
const DEFAULT_STELLAR_DECIMALS = 7
const DEFAULT_BASE_DECIMALS = 6

function toBigIntUnits(units) {
  if (typeof units === 'bigint') return units
  if (units == null || units === '') return 0n
  return BigInt(units)
}

/** floor(total/k) to each of k slots, the integer remainder to the earliest (lowest-index) slots. */
function splitEven(totalUnits, k) {
  if (k <= 0) return []
  const kBig = BigInt(k)
  const base = totalUnits / kBig
  const remainder = totalUnits % kBig
  return Array.from({ length: k }, (_, i) => base + (BigInt(i) < remainder ? 1n : 0n))
}

/** Deterministic allocationId: plan/run inputs + destination kind + a stable key -- never an
 * array-position index for anything the caller could reorder (base children key on their own
 * proxyTarget/factSlug/address, not their position in `baseAllocations`). */
function allocationId(runId, kind, key) {
  return `${runId || 'unrun'}:${kind}:${key}`
}

/**
 * Choose real crew cardinality for a destination allocation and expand it into canonical agents.
 * @param {object} input
 * @param {string} [input.runId] stable id for this reviewed execution (created by the caller at
 *   review time, never minted here -- see Task 2's runId ruling).
 * @param {'low'|'med'|'high'} input.risk
 * @param {string} [input.token]
 * @param {bigint|string} [input.stellarUnits] total Stellar-side units (7dp SAC units)
 * @param {number} [input.stellarDecimals]
 * @param {string} [input.destination] truthful Stellar deposit destination label (venueTruth.js)
 * @param {Array<{address?:string, units:bigint|string, decimals?:number, proxyTarget?:string, factSlug?:string, venueKind?:string, chain?:string}>} [input.baseAllocations]
 *   raw records (normalized here via venueTruth.normalizeVenue) plus their intended 6dp amount.
 * @param {number} [input.periodSeconds]
 * @param {number} [input.expiry]
 * @returns {Array<object>} canonical `agents` (see the StrategyPlan shape in the task brief)
 */
export function expandAgentSlots(input) {
  const {
    runId,
    risk,
    token = 'USDC',
    stellarUnits = 0n,
    stellarDecimals = DEFAULT_STELLAR_DECIMALS,
    destination = 'Stellar deposit',
    baseAllocations = [],
    periodSeconds = DEFAULT_PERIOD_SECONDS,
    expiry = Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECONDS,
  } = input || {}

  const profile = RISK_PROFILES[risk] || RISK_PROFILES.low
  const stellarTotal = toBigIntUnits(stellarUnits)
  const baseChildrenInput = (baseAllocations || [])
    .map((b) => ({ ...b, units: toBigIntUnits(b.units) }))
    .filter((b) => b.units > 0n)
  const hasBase = baseChildrenInput.length > 0
  const bridgeSlots = hasBase ? 1 : 0

  // The strategist's risk profile budgets `targetSlots` total; a bridge (when present) always
  // claims exactly one of them. Never let the bridge starve real Stellar funds down to zero
  // agents, though -- if there is Stellar money to deposit, at least one deposit agent exists,
  // even if that pushes the total one slot over targetSlots (correctness beats slot aesthetics).
  const stellarSlotsAvailable = Math.max(0, profile.targetSlots - bridgeSlots)
  let kStellar = stellarTotal > 0n ? Math.max(1, stellarSlotsAvailable) : 0
  // Defensive: never create more deposit agents than there are base units to give each at least 1.
  if (kStellar > 0 && stellarTotal < BigInt(kStellar)) kStellar = Number(stellarTotal)

  const agents = []

  if (kStellar > 0) {
    const shares = splitEven(stellarTotal, kStellar)
    shares.forEach((units, i) => {
      agents.push({
        allocationId: allocationId(runId, 'deposit', i),
        kind: 'deposit',
        hostNetworkId: STELLAR_NETWORK_ID,
        allocation: { token, units: units.toString(), decimals: stellarDecimals },
        cap: { token, units: units.toString(), decimals: stellarDecimals },
        periodSeconds,
        expiry,
        destination,
        children: [],
      })
    })
  }

  if (hasBase) {
    const bridgeBaseUnits = baseChildrenInput.reduce((s, b) => s + b.units, 0n)
    // Base children keep their exact 6dp intended amounts; the bridge agent's OWN cap is the
    // exact sum converted to Stellar 7dp Circle-USDC SAC units used by the burn path -- an exact
    // *10 (6dp -> 7dp is always lossless, unlike the reverse).
    const bridgeCapUnits = bridgeBaseUnits * 10n
    agents.push({
      allocationId: allocationId(runId, 'bridge', 'base'),
      kind: 'bridge',
      hostNetworkId: STELLAR_NETWORK_ID,
      allocation: { token, units: bridgeCapUnits.toString(), decimals: stellarDecimals },
      cap: { token, units: bridgeCapUnits.toString(), decimals: stellarDecimals },
      periodSeconds,
      expiry,
      destination: 'Base Sepolia bridge',
      children: baseChildrenInput.map((b) => {
        const venue = normalizeVenue(b)
        const childDecimals = b.decimals ?? DEFAULT_BASE_DECIMALS
        return {
          allocationId: allocationId(runId, 'bridge', b.proxyTarget || b.factSlug || b.address),
          address: venue.address,
          proxyTarget: venue.proxyTarget,
          destination: venue.proxyTarget || venue.name || 'Base custody proxy',
          venueKind: venue.venueKind,
          disclosure: venue.disclosure,
          yield: venue.yield,
          allocation: { token, units: b.units.toString(), decimals: childDecimals },
        }
      }),
    })
  }

  return agents
}

function computeTruth(agents) {
  return {
    agentIsolationCount: agents.length,
    stellarVenueCount: agents.some((a) => a.kind === 'deposit') ? 1 : 0,
    baseUsesProxyVaults: agents.some((a) => a.kind === 'bridge'),
  }
}

/**
 * Build the canonical StrategyPlan from a strategist's destination allocation + run context.
 * `runId` is never minted here -- it means one REVIEWED execution and is created by the caller
 * at review time (approved ruling). `planFingerprint` is left null; a later task (Task 4) fills
 * it deterministically before review.
 * @param {object} input
 * @param {string} [input.runId]
 * @param {'deepseek'|'venice'|'fallback'} [input.source]
 * @param {'live-ai'|'deterministic'|'cached'} [input.sourceState]
 * @param {'low'|'med'|'high'} input.risk
 * @param {string} [input.token]
 * @param {bigint|string} [input.stellarUnits]
 * @param {number} [input.stellarDecimals]
 * @param {string} [input.destination]
 * @param {Array} [input.baseAllocations]
 * @param {number} [input.periodSeconds]
 * @param {number} [input.expiry]
 * @returns {object} canonical StrategyPlan
 */
export function normalizeStrategyPlan(input) {
  const {
    runId,
    source = 'fallback',
    sourceState = 'deterministic',
    token = 'USDC',
    stellarDecimals = DEFAULT_STELLAR_DECIMALS,
  } = input || {}

  const agents = expandAgentSlots({ ...input, token, stellarDecimals })
  // The plan's total amount is derived from the actual expanded agents, never re-stated from the
  // caller's input -- so `amount` can never drift from what the crew was really scoped to spend
  // (satisfies "allocations sum exactly to input units").
  const totalUnits = agents.reduce((s, a) => s + toBigIntUnits(a.allocation.units), 0n)

  return Object.freeze({
    runId,
    planFingerprint: null,
    source,
    sourceState,
    amount: { token, units: totalUnits.toString(), decimals: stellarDecimals },
    agents,
    truth: computeTruth(agents),
    review: input?.review ?? null,
  })
}

const unitsToDecimal = (units, decimals) => Number(toBigIntUnits(units)) / 10 ** decimals

/**
 * Project a canonical StrategyPlan into the wizard's display-agent shape: human-decimal amounts
 * plus per-agent vault metadata for rendering. Reward/MDP scoring is a separate concern
 * (strategy/mdp.js) -- this only turns canonical units + Task-1 venue truth into card-ready rows.
 * @param {object} input
 * @param {object} input.plan canonical StrategyPlan (see normalizeStrategyPlan)
 * @param {object} [input.stellarVenue] a venueTruth-normalized Stellar record for display fields
 *   (name/protocol/apy/drawdown/risk). Falls back to generic labels when omitted.
 * @returns {{agents:Array, total:number, risk:string, source:string, sourceState:string, truth:object}}
 */
export function buildStrategyViewModel(input) {
  const { plan, stellarVenue = {} } = input || {}
  const total = unitsToDecimal(plan.amount.units, plan.amount.decimals)
  const agents = plan.agents.map((a, i) => {
    const idx = String(i + 1).padStart(2, '0')
    const allocation = unitsToDecimal(a.allocation.units, a.allocation.decimals)
    if (a.kind === 'bridge') {
      return {
        id: a.allocationId,
        idx,
        name: `Worker ${i + 1}, Cross-chain bridge`,
        role: 'Bridge, Base custody proxy',
        allocation,
        skillName: 'cctp_bridge',
        kind: 'bridge',
        vault: {
          name: 'Base Sepolia bridge',
          protocol: 'cctp-bridge',
          apy: null,
          drawdown: null,
          risk: 'medium',
          addr: a.destination,
          isLiveData: false,
        },
        children: a.children.map((c) => ({
          ...c,
          allocation: unitsToDecimal(c.allocation.units, c.allocation.decimals),
        })),
      }
    }
    return {
      id: a.allocationId,
      idx,
      name: `Worker ${i + 1}, ${stellarVenue.roleLabel || 'Conservative'}`,
      role: stellarVenue.role || 'Conservative, lending',
      allocation,
      skillName: 'yield_vault_deposit',
      kind: 'deposit',
      vault: {
        name: stellarVenue.name || 'Vibing Farmer Autofarm',
        protocol: stellarVenue.protocol || 'blend-usdc',
        apy: stellarVenue.apy ?? null,
        drawdown: stellarVenue.drawdown ?? null,
        risk: stellarVenue.risk || 'low',
        addr: stellarVenue.address || a.destination,
        address: stellarVenue.address,
        isLiveData: false,
      },
    }
  })
  return {
    agents,
    total,
    risk: input.risk,
    source: plan.source,
    sourceState: plan.sourceState,
    truth: plan.truth,
  }
}

// Fix loop N -- item 3 (owner report): the old `unitsToDisplay` did `Number(units) / 10 **
// decimals` straight into the Cap line with no rounding at all -- a 100/3 split showed one
// worker's raw remainder digit (...334) beside its siblings' (...333), and neither was formatted
// to money's usual 2dp. `splitEven` (planModel.js) stays exact BigInt for the real grant scope --
// this is a DISPLAY-ONLY remainder redistribution, computed once per render and looked up per row,
// never touching the units that become a grant/burn amount (planModel.js:188's `totalUnits`
// exactness is untouched -- nothing here feeds back into the plan). Grouped by kind: only
// same-kind agents were ever split from the same total by splitEven's single call in
// expandAgentSlots, so a lone bridge cap is a group of one -- it just rounds, nothing to
// redistribute.
// Fix round 1 -- cheap fix (reviewer finding): `cap.decimals`/`allocation.decimals` are always
// `stellarDecimals` (7) for every agent expandAgentSlots creates (planModel.js:104/124) -- fewer
// than 2 is unreachable today -- but a negative BigInt exponent throws RangeError, which would
// take the whole Plan stage render down. Guarded rather than left as a latent throw on a money path.
//
// Task 7 (Pocket Crew design alignment) fix round 1 -- lifted here verbatim from PlanStage.jsx
// (this module was already its natural home per that task's review finding): StartStage.jsx's own
// per-lane cap needs the SAME formatted display map PlanStage's allocation rows use, not a second,
// re-implemented rounding path -- re-implementing money rounding is exactly how this repo has
// reintroduced rounding bugs before. No behavior change from the move: same signatures, same
// guards, same callers (PlanStage.jsx now imports these instead of declaring them locally).
export function roundCentsBigInt(units, decimals) {
  if (decimals < 2) return BigInt(units) * 10n ** BigInt(2 - decimals)
  const denom = 10n ** BigInt(decimals - 2)
  return (BigInt(units) + denom / 2n) / denom
}

export function formatCents(cents) {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const whole = abs / 100n
  const frac = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

// Fix round 1 -- I-2 (reviewer finding): generalized from a Cap-only `buildCapDisplayMap` so the
// SAME redistribute-the-remainder-onto-the-last-agent treatment applies to whichever amount field
// the caller names -- `cap` and `allocation` happen to hold equal units today
// (expandAgentSlots sets both from the same `units` value), but the I8 regression test's own
// premise is that they may diverge, so this reads whichever field it's told, never assumes.
export function buildAmountDisplayMap(planAgents, amountKey) {
  const map = {}
  const byKind = new Map()
  for (const agent of planAgents) {
    const list = byKind.get(agent.kind) || []
    list.push(agent)
    byKind.set(agent.kind, list)
  }
  for (const group of byKind.values()) {
    const cents = group.map((a) => roundCentsBigInt(a[amountKey].units, a[amountKey].decimals))
    const exactUnits = group.reduce((s, a) => s + BigInt(a[amountKey].units), 0n)
    const exactCents = roundCentsBigInt(exactUnits, group[0][amountKey].decimals)
    const diff = exactCents - cents.reduce((s, c) => s + c, 0n)
    cents[cents.length - 1] += diff
    group.forEach((a, i) => {
      map[a.allocationId] = formatCents(cents[i])
    })
  }
  return map
}

/**
 * Drop agents whose destination failed eligibility (per-agent, fail-closed) and recompute truth
 * counts from what survives. `eligibility` maps an agent's `allocationId` to `{eligible}` (mirrors
 * basketFilter's verdictBySlug pattern) or may be a `(agent) => {eligible}` predicate. An agent
 * missing a verdict is treated as eligible (nothing to drop it for) -- callers that need
 * fail-closed-on-missing-data should supply an explicit verdict for every allocationId.
 * @param {object} plan canonical StrategyPlan
 * @param {Object<string,{eligible:boolean}>|((agent:object)=>{eligible:boolean})} [eligibility]
 * @returns {object} canonical StrategyPlan, `agents` narrowed to eligible-only
 */
export function toDispatchStrategy(plan, eligibility) {
  const verdictFor =
    typeof eligibility === 'function'
      ? eligibility
      : (agent) => (eligibility && eligibility[agent.allocationId]) || { eligible: true }
  const agents = (plan.agents || []).filter((a) => verdictFor(a).eligible !== false)
  return Object.freeze({
    ...plan,
    agents,
    truth: computeTruth(agents),
  })
}
