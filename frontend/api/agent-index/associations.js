import {
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_WASM_GENERATIONS,
} from '../../src/stellar/agentCreatorManifest.js'
import {
  AgentIndexValidationError,
  BASE_CHILD_LIFECYCLE_STATUSES,
  assertNoSensitiveProperties,
  canonicalJson,
  toBaseChildRow,
} from './models.js'
import { receiptIntentDigest } from './executionReceipts.js'

const EXECUTION_STATUSES = [
  'queued',
  'accepted',
  'burn-confirmed',
  'minted',
  'deposited',
  'held',
  'failed',
]
const CUSTODY_LOCATIONS = ['owner', 'agent', 'stellar-vault', 'in-transit', 'base-proxy', 'unknown']
const TERMINAL_STATUSES = new Set(['deposited', 'held', 'failed'])
const STATUS_RANK = new Map(EXECUTION_STATUSES.map((status, index) => [status, index]))
const ALLOCATION_FIELDS = new Set([
  'allocationId',
  'poolAddress',
  'proxyTarget',
  'amount',
  'executionStatus',
  'custody',
  'txHash',
])
const REPORT_FIELDS = new Set([
  'version',
  'networkId',
  'owner',
  'bridgeAgent',
  'runId',
  'grantTxHash',
  'kernelAddress',
  'mandateBindingId',
  'mandateBindingHash',
  'baseJobId',
  'allocations',
])
const AMOUNT_FIELDS = new Set(['token', 'units', 'decimals'])
const CUSTODY_FIELDS = new Set(['location'])
const BASE_CHILD_FIELDS = new Set([
  'version',
  'networkId',
  'owner',
  'agent',
  'bindingId',
  'allocationId',
  'childId',
  'intent',
  'lifecycle',
])
const BASE_CHILD_IDENTITY_FIELDS = new Set([
  'networkId',
  'owner',
  'bindingId',
  'allocationId',
  'childId',
])
const BASE_CHILD_INTENT_FIELDS = new Set([
  'token',
  'units',
  'decimals',
  'poolAddress',
  'proxyTarget',
  'runId',
  'grantTxHash',
  'kernelAddress',
  'bindingHash',
  'baseJobId',
])
const BASE_CHILD_LIFECYCLE_FIELDS = new Set(['sequence', 'status', 'evidence', 'observedAt'])
const LIVE_BRIDGE_GENERATION = AGENT_WASM_GENERATIONS.find(
  (generation) => generation.generation === 'agent-v3-bridge'
)
const LIVE_BRIDGE_CREATORS = new Set(LIVE_BRIDGE_GENERATION?.creatorAddresses ?? [])

export function baseChildIdempotencyKey(child) {
  const digest = receiptIntentDigest(child?.intent)
  return JSON.stringify([
    child?.networkId,
    child?.bindingId,
    child?.allocationId,
    child?.childId,
    digest,
  ])
}

export function baseChildIdentity(child) {
  return {
    networkId: requiredString(child?.networkId, 'networkId'),
    owner: requiredString(child?.owner, 'owner'),
    bindingId: requiredString(child?.bindingId, 'bindingId'),
    allocationId: requiredString(child?.allocationId, 'allocationId'),
    childId: requiredString(child?.childId, 'childId'),
  }
}

export async function ingestBaseChildIntent({ child, store }) {
  if (!store?.createBaseChildIntent) throw new Error('Base child intent store is unavailable')
  let intentDigest
  try {
    requireExactFields(child, BASE_CHILD_FIELDS, 'Base child')
    requireExactFields(child.intent, BASE_CHILD_INTENT_FIELDS, 'Base child intent')
    requireExactFields(child.lifecycle, BASE_CHILD_LIFECYCLE_FIELDS, 'Base child lifecycle')
    intentDigest = receiptIntentDigest(child?.intent)
    toBaseChildRow(child, intentDigest)
  } catch (error) {
    if (error instanceof AgentIndexValidationError) throw error
    throw new AgentIndexValidationError(error?.message || 'Invalid Base child intent', {
      cause: error,
    })
  }
  return store.createBaseChildIntent({
    child,
    intentDigest,
    idempotencyKey: baseChildIdempotencyKey(child),
  })
}

export async function advanceBaseChildLifecycle({ identity, expectedSequence, lifecycle, store }) {
  if (!store?.advanceBaseChildLifecycle)
    throw new Error('Base child lifecycle store is unavailable')
  try {
    requireExactFields(identity, BASE_CHILD_IDENTITY_FIELDS, 'Base child identity')
    requireExactFields(lifecycle, BASE_CHILD_LIFECYCLE_FIELDS, 'Base child lifecycle')
    assertNoSensitiveProperties({ identity, lifecycle })
    for (const field of ['networkId', 'owner', 'bindingId', 'allocationId', 'childId']) {
      requiredString(identity?.[field], `identity.${field}`)
    }
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
      throw new Error('expectedSequence must be a non-negative safe integer')
    }
    if (lifecycle?.sequence !== expectedSequence + 1) {
      throw new Error('lifecycle.sequence must advance expectedSequence by one')
    }
    if (!BASE_CHILD_LIFECYCLE_STATUSES.includes(lifecycle?.status)) {
      throw new Error('invalid Base child lifecycle status')
    }
    requiredInteger(lifecycle?.observedAt, 'lifecycle.observedAt')
    canonicalJson(lifecycle)
  } catch (error) {
    if (error instanceof AgentIndexValidationError) throw error
    throw new AgentIndexValidationError(error?.message || 'Invalid Base child lifecycle', {
      cause: error,
    })
  }
  const idempotencyKey = JSON.stringify([
    identity.networkId,
    identity.bindingId,
    identity.allocationId,
    identity.childId,
    lifecycle?.sequence,
    lifecycle?.status,
    receiptIntentDigest(lifecycle?.evidence ?? {}),
  ])
  return store.advanceBaseChildLifecycle({
    identity,
    expectedSequence,
    lifecycle,
    idempotencyKey,
  })
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`)
  return value
}

function requiredInteger(value, field) {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`)
  return value
}

function requireExactFields(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  const unexpected = Object.keys(value).find((key) => !allowed.has(key))
  if (unexpected) throw new Error(`unexpected ${field} field: ${unexpected}`)
}

function canonicalPoolTarget(poolTargets, poolAddress) {
  const key = requiredString(poolAddress, 'poolAddress').toLowerCase()
  return poolTargets instanceof Map ? poolTargets.get(key) : poolTargets?.[key]
}

function mintRecipientHex(value) {
  if (typeof value === 'string') return value.replace(/^0x/, '').toLowerCase()
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString('hex').toLowerCase()
  }
  return ''
}

function expectedMintRecipient(kernelAddress) {
  const hex = requiredString(kernelAddress, 'kernelAddress').replace(/^0x/, '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('kernelAddress must be a 20-byte address')
  return hex.padStart(64, '0')
}

function validateAllocation(allocation, poolTargets, scopeRequirements) {
  requireExactFields(allocation, ALLOCATION_FIELDS, 'allocation')
  requiredString(allocation.allocationId, 'allocationId')
  const canonicalTarget = canonicalPoolTarget(poolTargets, allocation.poolAddress)
  if (!canonicalTarget) throw new Error('poolAddress is not allowlisted')
  if (allocation.proxyTarget !== canonicalTarget) {
    throw new Error('proxyTarget does not match the canonical pool mapping')
  }
  if (!EXECUTION_STATUSES.includes(allocation.executionStatus)) {
    throw new Error('invalid executionStatus')
  }
  if (!CUSTODY_LOCATIONS.includes(allocation.custody?.location)) {
    throw new Error('invalid custody location')
  }
  if (allocation.txHash !== null && allocation.txHash !== undefined) {
    requiredString(allocation.txHash, 'txHash')
  }
  if (
    ['queued', 'accepted'].includes(allocation.executionStatus) &&
    (allocation.txHash != null || allocation.custody.location !== 'unknown')
  ) {
    throw new Error('queued or accepted evidence cannot claim observed custody or a transaction')
  }
  const amount = allocation.amount
  requireExactFields(amount, AMOUNT_FIELDS, 'amount')
  requireExactFields(allocation.custody, CUSTODY_FIELDS, 'custody')
  if (!amount || amount.token !== scopeRequirements.reportToken) {
    throw new Error('allocation token does not match the supported report token')
  }
  if (amount.decimals !== scopeRequirements.reportDecimals) {
    throw new Error('allocation decimals do not match the supported report token')
  }
  requiredString(amount.units, 'amount.units')
  if (!/^\d+$/.test(amount.units) || BigInt(amount.units) <= 0n) {
    throw new Error('amount.units must be a positive integer string')
  }
  return canonicalTarget
}

function validateMembership(membership, report) {
  if (!membership || membership.owner !== report.owner) {
    throw new Error('bridge agent is not an indexed membership for this owner')
  }
  if (membership.grantTxHash !== report.grantTxHash) {
    throw new Error('bridge membership grant transaction does not match the association')
  }
  if (
    membership.schemaVersion !== AGENT_INDEX_SCHEMA_VERSION ||
    membership.provenance?.source !== 'router-event' ||
    membership.provenance?.generation !== LIVE_BRIDGE_GENERATION?.generation ||
    !LIVE_BRIDGE_CREATORS.has(membership.creator)
  ) {
    throw new Error('bridge membership provenance is not a supported live bridge generation')
  }
}

function validateScope({ scope, report, allocation, requirements, now }) {
  const reportUnits = BigInt(allocation.amount.units)
  const decimalDelta = requirements.scopeDecimals - requirements.reportDecimals
  if (decimalDelta < 0) throw new Error('scope decimal configuration is invalid')
  const requiredCap = reportUnits * 10n ** BigInt(decimalDelta)
  const expiry = BigInt(scope?.expiry ?? 0)
  const nowSeconds = BigInt(Math.floor(now / 1000))
  const checks = [
    ['owner', scope?.owner === report.owner],
    ['kind', Number(scope?.kind) === 1],
    ['messenger', scope?.target === requirements.messenger],
    ['token', scope?.token === requirements.token],
    ['destination domain', Number(scope?.destination_domain) === requirements.destinationDomain],
    [
      'mint recipient',
      mintRecipientHex(scope?.mint_recipient) === expectedMintRecipient(report.kernelAddress),
    ],
    ['cap', BigInt(scope?.cap_per_period ?? 0) >= requiredCap],
    ['expiry', expiry > nowSeconds],
    ['revocation', scope?.revoked === false],
  ]
  const failed = checks.find(([, valid]) => !valid)
  if (failed)
    throw new Error(`live bridge scope ${failed[0]} does not cover the association report`)
}

function validateImmutable(existing, report, allocation) {
  if (
    existing.ownerAddress !== report.owner ||
    existing.runId !== report.runId ||
    existing.bridgeAgentAddress !== report.bridgeAgent ||
    existing.poolAddress?.toLowerCase() !== allocation.poolAddress.toLowerCase() ||
    existing.proxyTarget !== allocation.proxyTarget ||
    existing.amount?.token !== allocation.amount.token ||
    existing.amount?.units !== allocation.amount.units ||
    existing.amount?.decimals !== allocation.amount.decimals ||
    existing.grantTxHash !== report.grantTxHash ||
    existing.baseJobId !== report.baseJobId ||
    existing.kernelAddress?.toLowerCase() !== report.kernelAddress.toLowerCase() ||
    existing.mandateBindingId !== report.mandateBindingId ||
    existing.mandateBindingHash !== report.mandateBindingHash
  ) {
    throw new Error(
      'allocation identity cannot change owner, run, bridge, pool, kernel, or binding'
    )
  }
}

function validateMonotonic(existing, allocation) {
  const before = existing.executionStatus
  const after = allocation.executionStatus
  const beforeRank = STATUS_RANK.get(before) ?? -1
  const afterRank = STATUS_RANK.get(after) ?? -1
  if (TERMINAL_STATUSES.has(before) && before !== after) {
    throw new Error('terminal association evidence cannot change')
  }
  if (afterRank < beforeRank) {
    throw new Error('association evidence cannot regress')
  }
  if (
    existing.txHash &&
    allocation.txHash &&
    existing.txHash !== allocation.txHash &&
    afterRank <= beforeRank
  ) {
    throw new Error('observed transaction evidence cannot change')
  }
  if (existing.txHash && !allocation.txHash) {
    throw new Error('observed transaction evidence cannot regress to null')
  }
  if (
    TERMINAL_STATUSES.has(before) &&
    existing.custodyLocation !== 'unknown' &&
    allocation.custody.location === 'unknown'
  ) {
    throw new Error('terminal custody evidence cannot regress to unknown')
  }
}

export function associationIdempotencyKey(report, allocation) {
  return JSON.stringify([
    report?.networkId,
    report?.runId,
    allocation?.allocationId,
    allocation?.executionStatus,
    allocation?.txHash ?? null,
  ])
}

export async function ingestAssociationReport({
  report,
  idempotencyKey,
  store,
  scopeReader,
  poolTargets,
  scopeRequirements,
  supportedNetworkId = 'stellar-testnet',
  now = Date.now(),
}) {
  requireExactFields(report, REPORT_FIELDS, 'report')
  if (report?.version !== 1) throw new Error('unsupported association report version')
  if (report?.networkId !== supportedNetworkId) {
    throw new Error(`association network must be ${supportedNetworkId}`)
  }
  for (const field of [
    'networkId',
    'owner',
    'bridgeAgent',
    'runId',
    'grantTxHash',
    'kernelAddress',
    'mandateBindingId',
    'mandateBindingHash',
    'baseJobId',
  ]) {
    requiredString(report?.[field], field)
  }
  if (!Array.isArray(report.allocations) || report.allocations.length !== 1) {
    throw new Error('one allocation is required per association idempotency key')
  }
  const allocation = report.allocations[0]
  const canonicalTarget = validateAllocation(allocation, poolTargets, scopeRequirements)
  if (allocation.allocationId !== `${report.runId}:bridge:${canonicalTarget}`) {
    throw new Error('allocationId does not match the reviewed run and canonical proxy target')
  }
  const expectedKey = associationIdempotencyKey(report, allocation)
  if (idempotencyKey !== expectedKey) throw new Error('idempotency key does not match report tuple')
  const existing = await store.readRunAllocation({
    networkId: report.networkId,
    allocationId: allocation.allocationId,
  })
  const hasAssociationProof = existing?.associationSource === 'relayer-attested'
  // associationIdempotencyKey (:223-231) covers only [networkId, runId, allocationId,
  // executionStatus, txHash]. A matching key proves that (status, txHash) tuple was seen before —
  // it proves nothing about the other identity fields validateImmutable checks (ownerAddress,
  // amount.units, baseJobId, grantTxHash, kernelAddress, mandateBindingId, mandateBindingHash,
  // ...). So validateImmutable must run BEFORE the journal short-circuit below: a genuine retry
  // has every field identical and still short-circuits idempotently, but a conflicting-identity
  // report that happens to share a (status, txHash) tuple now throws here instead of returning a
  // false idempotent success. validateMonotonic stays AFTER the short-circuit (frontend/
  // migrations/0004_agent_associations.sql:12-13): a retried, already-applied older tuple is
  // expected to look like a regression against whatever the row has since advanced to, and the
  // short-circuit above already returns for it before reaching this check. A tuple that was never
  // applied still falls through to validateMonotonic, so this can never become a bypass.
  if (hasAssociationProof) {
    validateImmutable(existing, report, allocation)
  }
  if (await store.hasAssociationEvent({ idempotencyKey })) {
    return { written: 0, duplicates: 1 }
  }
  if (hasAssociationProof) {
    validateMonotonic(existing, allocation)
  }
  let scopeCheckedAt = existing?.scopeCheckedAt ?? now
  if (!hasAssociationProof) {
    if (
      existing &&
      (existing.ownerAddress !== report.owner ||
        existing.runId !== report.runId ||
        existing.bridgeAgentAddress !== report.bridgeAgent)
    ) {
      throw new Error('historical allocation owner, run, or bridge identity cannot change')
    }
    const memberships = await store.readMembershipsByAgentAddresses({
      networkId: report.networkId,
      agentAddresses: [report.bridgeAgent],
    })
    const membership = memberships.find((row) => row.address === report.bridgeAgent)
    validateMembership(membership, report)
    const scope = await scopeReader({
      networkId: report.networkId,
      bridgeAgent: report.bridgeAgent,
    })
    validateScope({
      scope,
      report,
      allocation,
      requirements: scopeRequirements,
      now,
    })
    scopeCheckedAt = now
  }

  const association = {
    allocationId: allocation.allocationId,
    networkId: report.networkId,
    runId: report.runId,
    ownerAddress: report.owner,
    bridgeAgentAddress: report.bridgeAgent,
    poolAddress: allocation.poolAddress,
    amount: {
      token: allocation.amount.token,
      units: allocation.amount.units,
      decimals: requiredInteger(allocation.amount.decimals, 'amount.decimals'),
    },
    proxyTarget: allocation.proxyTarget,
    baseJobId: report.baseJobId,
    txHash: allocation.txHash ?? existing?.txHash ?? null,
    executionStatus: allocation.executionStatus,
    custodyLocation: allocation.custody.location,
    grantTxHash: report.grantTxHash,
    kernelAddress: report.kernelAddress,
    mandateBindingId: report.mandateBindingId,
    mandateBindingHash: report.mandateBindingHash,
    associationSource: 'relayer-attested',
    reportedAt: now,
    scopeCheckedAt,
  }
  return (
    (await store.commitAssociation({ association, idempotencyKey })) ?? {
      written: 1,
      duplicates: 0,
    }
  )
}

export function joinBaseAssociations({
  agents,
  associations,
  now = Date.now(),
  freshnessMs = 5 * 60_000,
}) {
  const knownByAgent = new Map()
  for (const row of associations ?? []) {
    if (row.associationSource !== 'relayer-attested') continue
    const list = knownByAgent.get(row.bridgeAgentAddress) ?? []
    list.push(row)
    knownByAgent.set(row.bridgeAgentAddress, list)
  }
  return (agents ?? []).map((agent) => {
    const rows = knownByAgent.get(agent.address) ?? []
    if (rows.length === 0) {
      return {
        ...agent,
        association: 'unknown',
        associationSource: null,
        reportedAt: null,
        scopeCheckedAt: null,
        freshness: 'unknown',
        baseChildren: [],
      }
    }
    const reportedAt = Math.max(...rows.map((row) => row.reportedAt))
    const scopeCheckedAt = Math.max(...rows.map((row) => row.scopeCheckedAt))
    const freshness = now - reportedAt <= freshnessMs ? 'fresh' : 'stale'
    return {
      ...agent,
      association: 'known',
      associationSource: 'relayer-attested',
      reportedAt,
      scopeCheckedAt,
      freshness,
      baseChildren: rows.map((row) => ({
        allocationId: row.allocationId,
        runId: row.runId,
        poolAddress: row.poolAddress,
        proxyTarget: row.proxyTarget,
        amount: row.amount,
        grantTxHash: row.grantTxHash,
        baseJobId: row.baseJobId,
        kernelAddress: row.kernelAddress,
        mandateBindingId: row.mandateBindingId,
        mandateBindingHash: row.mandateBindingHash,
        executionStatus: row.executionStatus,
        custody: { location: row.custodyLocation },
        txHash: row.txHash ?? null,
        association: 'known',
        associationSource: row.associationSource,
        reportedAt: row.reportedAt,
        scopeCheckedAt: row.scopeCheckedAt,
        freshness: now - row.reportedAt <= freshnessMs ? 'fresh' : 'stale',
      })),
    }
  })
}
