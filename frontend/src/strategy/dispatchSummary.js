// Canonical mixed-branch execution receipt. The receipt deliberately keeps operation progress
// separate from current custody: a failed relay can still leave USDC in a bridge agent or CCTP.
//
// Task 6 chunk C2 -- custody now has THREE sources, and callers must be able to tell them apart:
//   - PROVEN (`source:'receipt'`): a real AllocationReceiptV2 (allocationReceipt.js) exists for
//     this allocation, and its own location is recognized. Its `custody` is projected VERBATIM
//     (only the location string is renamed onto this module's vocabulary -- see
//     RECEIPT_TO_CUSTODY_LOCATION below); never re-derived, never "improved."
//   - INFERRED (`source:'inferred'`): the pre-existing, unchanged fallback (`inferredCustody`) for
//     the one live path that still produces no receipt at all (`dispatchLegacy`,
//     orchestrator.js:1693) and for the Base branch, which does not yet wire AllocationReceiptV2
//     (baseLeg.js keeps its own separate custody handling, out of Task 6's scope).
//   - UNMAPPED (`source:'unmapped'`, fix round 1): a receipt DID exist for this allocation, but its
//     `location` is outside the server vocabulary this module's copy knows (client/server drift).
//     Never silently presented as an honest "no evidence" `unknown` -- see `unmappedCustody`'s own
//     header for the controller ruling this implements.
// The distinction is carried on CustodyV1 itself as `source:'receipt'|'inferred'|'unmapped'` -- a
// named field rather than a bare boolean, because `confirmed` already exists and means something
// different (the custody CLAIM is confirmed vs. ambiguous); a second boolean sitting next to it
// would invite exactly the kind of "which flag means what" confusion this task exists to remove.
//
// `checkedAt` (fix round 1: reworked) exists ONLY on the inferred path now, carrying its
// pre-existing real timestamp data unchanged. It is OMITTED entirely (not merely `null`) on both
// the receipt and unmapped paths: the receipt carries no timestamp on `custody` itself (only each
// phase attempt's `observedAt` does, and reading one of those would be reconstructing a fact the
// receipt does not actually assert about custody, not projecting one it does). Fix round 1 review
// caught that an earlier version of this module kept `checkedAt: null` present-but-always-null on
// the BETTER (receipt) path while only the WEAKER (inferred) path carried a real value -- backwards
// from what any consumer would assume reading `checkedAt` as a freshness signal. Omitting it on the
// stronger-evidence paths removes the inverted signal instead of leaving it to be misread.
//
// See RECEIPT_TO_CUSTODY_LOCATION's own comment for why 'base-kernel'/'base-vault' map onto this
// module's EXISTING vocabulary rather than widening it with two new strings.

/**
 * @typedef {{token:string, units:string, decimals:number}} TokenAmount
 * @typedef {{location:'owner'|'agent'|'stellar-vault'|'in-transit'|'base-proxy'|'unknown',
 *   confirmed:boolean, checkedAt?:number|null, amount:TokenAmount|null, reason:string|null,
 *   source:'receipt'|'inferred'|'unmapped'}} CustodyV1
 * @typedef {{allocationId:string, amount:TokenAmount, networkContext:object, executionStatus:'succeeded'|'failed'|'pending'|'not-started'|'unknown', custody:CustodyV1, txHash:string|null, error:string|null}} AllocationOutcomeV1
 * @typedef {{status:'succeeded'|'partial'|'failed'|'in-transit'|'not-planned', results:AllocationOutcomeV1[]}} BranchResultV1
 * @typedef {{version:1, runId:string, planFingerprint:string, permission:object, branches:{stellar:BranchResultV1,base:BranchResultV1}, allocations:AllocationOutcomeV1[]}} DispatchReceiptV1
 */

const EXECUTION_STATUSES = new Set(['succeeded', 'failed', 'pending', 'not-started', 'unknown'])
const CUSTODY_LOCATIONS = new Set([
  'owner',
  'agent',
  'stellar-vault',
  'in-transit',
  'base-proxy',
  'unknown',
])

// The server's authoritative custody vocabulary (frontend/api/agent-index/models.js:29-37's
// RECEIPT_CUSTODY_LOCATIONS), copied verbatim -- this module has no import from api/ at runtime,
// the same rule allocationReceipt.js documents at its own header (a pure producer with no network/
// DB dependency should not reach into api/ at runtime). The copy is pinned against drift by
// dispatchSummary.test.js, which imports and checks against the REAL models.js export.
//
// Mapped onto this module's PRE-EXISTING CustodyV1 vocabulary rather than widening it with new
// strings:
//   - 'stellar-agent' -> 'agent' and 'cctp-transit' -> 'in-transit' are lossless renames: the old
//     vocab already had exactly one bucket for each of those concepts.
//   - 'base-vault' -> 'base-proxy': the old vocab's only "arrived on Base" bucket, and the
//     server's 'base-vault' means exactly that (landed in the destination pool).
//   - 'base-kernel' -> 'agent', deliberately NOT a new distinct value and NOT collapsed onto
//     'base-proxy' either. This preserves the receipt's real distinction (funds reached an
//     intermediary Base-side smart account, never the destination vault) using vocabulary this
//     module's own read-only consumer already interprets correctly: StartStage.jsx's
//     `custodyLabelFor` already reads 'agent' as a chain-agnostic "held by an intermediary,
//     recovery available" verdict for BOTH deposit and bridge lanes (StartStage.jsx:216-224), and
//     its `bridgeSettledPhase` already treats ONLY 'base-proxy' as "confirmed arrived"
//     (StartStage.jsx:279). Introducing two brand-new 'base-kernel'/'base-vault' CustodyV1 strings
//     was considered and rejected: StartStage.jsx is out of scope for this chunk (read-only,
//     under active review) and its `c.custody?.location === 'base-proxy'` string match would never
//     recognize a new string -- silently regressing a genuinely proven Base arrival back to
//     "in-transit" forever. Reusing 'agent' means that already-shipped consumer keeps classifying
//     a proven-but-stranded Base allocation correctly with zero edits to it required.
const RECEIPT_TO_CUSTODY_LOCATION = new Map([
  ['owner', 'owner'],
  ['stellar-agent', 'agent'],
  ['stellar-vault', 'stellar-vault'],
  ['cctp-transit', 'in-transit'],
  ['base-kernel', 'agent'],
  ['base-vault', 'base-proxy'],
  ['unknown', 'unknown'],
])

function asError(value) {
  if (!value) return null
  return value instanceof Error ? value.message : String(value)
}

function plannedAllocations(plan) {
  return (plan?.agents || []).flatMap((agent) => {
    if (agent.kind === 'bridge' && Array.isArray(agent.children) && agent.children.length > 0) {
      return agent.children.map((child) => ({ ...child, branch: 'base' }))
    }
    return [{ ...agent, branch: agent.kind === 'bridge' ? 'base' : 'stellar' }]
  })
}

function rawResults(branch) {
  if (!branch) return []
  if (Array.isArray(branch)) return branch
  if (Array.isArray(branch.results)) return branch.results
  return []
}

function executionStatus(raw, branch) {
  if (EXECUTION_STATUSES.has(raw?.executionStatus)) return raw.executionStatus
  if (raw?.finalStatus === 'pending' || raw?.status === 'pending') return 'pending'
  if (raw?.finalStatus === 'done' || raw?.success === true || raw?.status === 'fulfilled') {
    return 'succeeded'
  }
  if (raw?.success === false || raw?.error || raw?.reason || raw?.status === 'rejected')
    return 'failed'
  return branch ? 'unknown' : 'not-started'
}

function inferredCustody(raw, branch, status) {
  if (raw?.custody && CUSTODY_LOCATIONS.has(raw.custody.location)) {
    return {
      location: raw.custody.location,
      confirmed: raw.custody.confirmed === true,
      checkedAt: typeof raw.custody.checkedAt === 'number' ? raw.custody.checkedAt : null,
      amount: null,
      reason: null,
      source: 'inferred',
    }
  }
  return {
    location: 'unknown',
    confirmed: false,
    checkedAt: null,
    amount: null,
    reason: null,
    source: 'inferred',
  }
}

// C1 already threads the real AllocationReceiptV2 onto a dispatch result -- under `raw.receipt`
// for the plain per-worker loop (orchestrator.js's `dispatch`/`dispatchPermissioned` results,
// :919-920: `custody: r.value?.receipt?.custody ?? null, receipt: r.value?.receipt ?? null`) and
// under `raw.allocationReceipt` for the mixed Stellar+Base loop (`dispatchConfirmedMixed`,
// orchestrator.js:1085,1098,1116). That second loop deliberately kept its PRE-EXISTING `custody`
// field in the OLD legacy shape "so nothing downstream collides" (orchestrator.js:962-966's own
// comment), so the real receipt lives under the second name there instead -- verified by reading
// orchestrator.js directly, not assumed from the brief, which only describes the first loop.
// Checking both names is reading more of the SAME already-committed producer output; it requires
// no orchestrator.js change.
function receiptCustodyEvidence(raw) {
  return raw?.receipt?.custody ?? raw?.allocationReceipt?.custody ?? null
}

/**
 * Project one receipt's custody VERBATIM -- never re-derive it. The only transformation applied is
 * the server-vocabulary -> CustodyV1-vocabulary rename table (RECEIPT_TO_CUSTODY_LOCATION above);
 * `confirmed`/`amount`/`reason` are copied through unchanged (amount stays a decimal string end to
 * end -- never routed through `Number()`, which would silently lose precision above
 * `Number.MAX_SAFE_INTEGER`). `checkedAt` is deliberately OMITTED here, not merely `null` -- see the
 * module header.
 *
 * Returns `null` (fix round 1: never throws) when the location is outside the server's
 * RECEIPT_CUSTODY_LOCATIONS vocabulary. `custodyFor` below turns a `null` here into a LOUD,
 * distinctly-marked per-allocation verdict (`unmappedCustody`) rather than a silent 'unknown' --
 * see that function's own header for why the earlier throwing design was replaced.
 * @param {{location:string, confirmed:boolean, amount:TokenAmount|null, reason:string|null}} receiptCustody
 * @returns {CustodyV1|null}
 */
function provenCustody(receiptCustody) {
  const location = RECEIPT_TO_CUSTODY_LOCATION.get(receiptCustody.location)
  if (location === undefined) return null
  return {
    location,
    confirmed: receiptCustody.confirmed === true,
    amount:
      receiptCustody.amount == null
        ? null
        : {
            token: receiptCustody.amount.token,
            units: String(receiptCustody.amount.units),
            decimals: receiptCustody.amount.decimals,
          },
    reason: receiptCustody.reason ?? null,
    source: 'receipt',
  }
}

/**
 * Fix round 1 (controller ruling): the original design had `provenCustody` THROW on an unmapped
 * location, and that throw propagated all the way out of `buildDispatchReceipt` -- aborting the
 * ENTIRE receipt for EVERY allocation in the run, even though both real call sites
 * (app.jsx:3310, orchestrator.js's `buildDispatchReceipt` calls) build the receipt strictly AFTER
 * dispatch. A single unmapped value would have cost the user the whole receipt for a run whose
 * money had already moved. This is the contained replacement: the ONE bad allocation gets this
 * distinct verdict; every OTHER allocation in the same receipt still builds and renders normally.
 *
 * Still never a silent 'unknown' -- the brief's fail-loud requirement still holds, just scoped to
 * one allocation instead of the whole receipt: `source:'unmapped'` is its own value (never
 * `'receipt'` or `'inferred'`, so it is never confused with either a proven or a genuinely
 * evidence-free verdict), and `reason` always names the exact bad value and the allocation it
 * belongs to, so a caller -- or a human reading the rendered receipt -- can diagnose it at a
 * glance rather than guessing from a bare `location:'unknown'`.
 * @param {{location:string}} receiptCustody
 * @param {string} allocationId
 * @returns {CustodyV1}
 */
function unmappedCustody(receiptCustody, allocationId) {
  return {
    location: 'unknown',
    confirmed: false,
    amount: null,
    reason:
      `receipt custody location "${receiptCustody.location}" for allocation "${allocationId}" is ` +
      'outside the server RECEIPT_CUSTODY_LOCATIONS vocabulary this module knows (client/server ' +
      "vocabulary drift) -- this allocation's custody could not be read; it is NOT a genuine " +
      '"no evidence" verdict.',
    source: 'unmapped',
  }
}

/**
 * Custody comes from the receipt when one exists (verbatim, via `provenCustody`, falling back to
 * the loud `unmappedCustody` if the receipt's own location can't be mapped); inference is only the
 * documented fallback for an allocation with no receipt evidence at all. `source` on the returned
 * CustodyV1 is how any caller -- including StrategyReceipt.jsx -- tells the three apart.
 */
function custodyFor(raw, branch, status, allocationId) {
  const receiptCustody = receiptCustodyEvidence(raw)
  if (!receiptCustody) return inferredCustody(raw, branch, status)
  return provenCustody(receiptCustody) ?? unmappedCustody(receiptCustody, allocationId)
}

function txHash(raw) {
  return (
    raw?.depositTxHash || raw?.mintTxHash || raw?.txHash || raw?.burnHash || raw?.pullTxHash || null
  )
}

function isEmptyContainer(value) {
  if (Array.isArray(value)) return value.length === 0
  return value != null && typeof value === 'object' && Object.keys(value).length === 0
}

function isSensitiveProperty(key) {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return (
    normalized.includes('secret') ||
    normalized.includes('privatekey') ||
    normalized.includes('sessionkey')
  )
}

/** Recursively keep receipt-safe JSON evidence while dropping all key material by property name.
 * Exported so Base-leg output and final receipt normalization cannot drift apart. */
export function sanitizeReceiptData(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeReceiptData(entry, seen))
      .filter((entry) => !isEmptyContainer(entry))
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveProperty(key))
      .map(([key, entry]) => [key, sanitizeReceiptData(entry, seen)])
      .filter(([, entry]) => !isEmptyContainer(entry))
  )
}

function networkContext(raw, branch, custody) {
  if (raw?.networkContext) return sanitizeReceiptData(raw.networkContext)
  if (branch === 'stellar') {
    return {
      executionNetwork: 'stellar-testnet',
      currentCustodyNetwork: ['owner', 'agent', 'stellar-vault'].includes(custody.location)
        ? 'stellar-testnet'
        : null,
      transit: false,
    }
  }
  return {
    executionNetwork: 'stellar-testnet',
    sourceNetwork: 'stellar-testnet',
    destinationNetwork: 'base-sepolia',
    currentCustodyNetwork: custody.location === 'base-proxy' ? 'base-sepolia' : null,
    transit: custody.location === 'in-transit',
  }
}

function safeEvidence(raw) {
  const keys = [
    'runId',
    'allocationId',
    'pullTxHash',
    'depositTxHash',
    'burnHash',
    'jobId',
    'finalStatus',
    'mintTxHash',
    'bridgeAgentAddress',
    'bridgeAgent',
    'kernelAddress',
    'grantTxHash',
    'baseAccount',
    'attestation',
    'recovery',
    'stage',
  ]
  return Object.fromEntries(
    keys.filter((key) => raw?.[key] != null).map((key) => [key, sanitizeReceiptData(raw[key])])
  )
}

function normalizeOutcome(planned, raw) {
  const status = executionStatus(raw, planned.branch)
  const custody = custodyFor(raw, planned.branch, status, planned.allocationId)
  const amount = planned.allocation || planned.cap
  if (
    !amount ||
    typeof amount.token !== 'string' ||
    !/^\d+$/.test(String(amount.units)) ||
    !Number.isInteger(amount.decimals) ||
    amount.decimals < 0
  ) {
    throw new Error(`Invalid canonical amount for allocation ${planned.allocationId}.`)
  }
  return {
    allocationId: planned.allocationId,
    amount: {
      token: amount.token,
      units: String(amount.units),
      decimals: amount.decimals,
    },
    networkContext: networkContext(raw, planned.branch, custody),
    executionStatus: status,
    custody,
    txHash: txHash(raw),
    error: asError(raw?.error || raw?.reason),
    evidence: safeEvidence(raw),
  }
}

function branchStatus(branch, planned, outcomes, declared) {
  if (
    declared &&
    ['succeeded', 'partial', 'failed', 'in-transit', 'not-planned'].includes(declared)
  ) {
    return declared
  }
  if (planned.length === 0) return 'not-planned'
  const statuses = outcomes.map((outcome) => outcome.executionStatus)
  if (branch === 'base' && statuses.includes('pending')) return 'in-transit'
  if (statuses.length > 0 && statuses.every((status) => status === 'succeeded')) return 'succeeded'
  if (statuses.length > 0 && statuses.every((status) => status === 'failed')) return 'failed'
  return 'partial'
}

function normalizePermission(permission = {}) {
  if (permission.mode !== 'fresh' && permission.mode !== 'reuse') {
    throw new Error('Invalid PermissionConfirmedV1 mode.')
  }
  const reuse = permission.mode === 'reuse'
  return {
    mode: reuse ? 'reuse' : 'fresh',
    status: reuse ? 'reused' : 'confirmed',
    confirmationCount: reuse ? 0 : 1,
    txHash: permission.txHash || null,
    grantReceiptFingerprint: permission.grantReceiptFingerprint || null,
    expiryLedger: permission.expiryLedger ?? null,
    agentAddresses: Array.isArray(permission.agentAddresses) ? permission.agentAddresses : [],
  }
}

/**
 * Build the durable, mixed-branch custody receipt. Plan amounts are always authoritative; branch
 * data can supply progress and custody evidence but cannot alter reviewed integer amounts.
 * @param {{plan:object, permission:object, branches?:{stellar?:object,base?:object}}} input
 * @returns {DispatchReceiptV1}
 */
export function buildDispatchReceipt({ plan, permission, branches = {} }) {
  const planned = plannedAllocations(plan)
  const buildBranch = (branch) => {
    const branchPlan = planned.filter((allocation) => allocation.branch === branch)
    const resultByAllocation = new Map(
      rawResults(branches[branch]).map((result) => [result?.allocationId, result])
    )
    const results = branchPlan.map((allocation) =>
      normalizeOutcome(allocation, resultByAllocation.get(allocation.allocationId))
    )
    return {
      status: branchStatus(branch, branchPlan, results, branches[branch]?.status),
      results,
    }
  }

  const stellar = buildBranch('stellar')
  const base = buildBranch('base')
  return {
    version: 1,
    runId: plan?.runId || null,
    planFingerprint: plan?.planFingerprint || null,
    permission: normalizePermission(permission),
    branches: { stellar, base },
    allocations: [...stellar.results, ...base.results],
  }
}
