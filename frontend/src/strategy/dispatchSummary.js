// Canonical mixed-branch execution receipt. The receipt deliberately keeps operation progress
// separate from current custody: a failed relay can still leave USDC in a bridge agent or CCTP.

/**
 * @typedef {{token:string, units:string, decimals:number}} TokenAmount
 * @typedef {{location:'owner'|'agent'|'stellar-vault'|'in-transit'|'base-proxy'|'unknown', confirmed:boolean, checkedAt:number|null}} CustodyV1
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
    }
  }
  return { location: 'unknown', confirmed: false, checkedAt: null }
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
  const custody = inferredCustody(raw, planned.branch, status)
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
