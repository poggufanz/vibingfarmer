import { createHash } from 'node:crypto'

// Domain vocabulary + row shaping for the agent owner-membership/coverage index (D1 tables in
// migrations/0002_agent_index.sql). Pure, no I/O — store.js is the only module that touches the
// database; this file is the single place the JS-record <-> SQL-column mapping and the shared
// enums live, so Tasks 3-7 import types/helpers from here rather than re-guessing column names.

export const AGENT_KINDS = ['deposit', 'bridge', 'unknown']
export const CUSTODY_LOCATIONS = [
  'owner',
  'agent',
  'stellar-vault',
  'in-transit',
  'base-proxy',
  'unknown',
]
export const EXECUTION_STATUSES = [
  'queued',
  'accepted',
  'burn-confirmed',
  'minted',
  'deposited',
  'held',
  'failed',
]
export const SOURCE_STATUSES = ['ok', 'error']
export const GAP_STATUSES = ['open', 'closed']
export const BACKFILL_RESULTS = ['verified', 'failed']
export const RECEIPT_PHASES = ['pull', 'stellar_deposit', 'cctp_burn', 'cctp_mint', 'base_deposit']
export const RECEIPT_PHASE_STATUSES = ['not_started', 'submitted', 'confirmed', 'failed', 'unknown']
export const RECEIPT_CUSTODY_LOCATIONS = [
  'owner',
  'stellar-agent',
  'stellar-vault',
  'cctp-transit',
  'base-kernel',
  'base-vault',
  'unknown',
]
export const BASE_CHILD_LIFECYCLE_STATUSES = [
  'planned',
  'submitted',
  'confirmed',
  'failed',
  'unknown',
]
export const BASE_CHILD_RECOVERY_PHASES = [
  'cctp_burn',
  'cctp_attestation',
  'cctp_mint',
  'base_deposit',
]
export const BASE_CHILD_RECOVERY_STATES = [
  'submitting',
  'submitted',
  'confirmed',
  'failed',
  'unknown',
  'blocked',
]
export const MAX_BASE_CHILD_EVIDENCE_BYTES = 4096
export const MAX_BASE_CHILD_EVIDENCE_DEPTH = 2
export const BASE_RECONCILE_ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032'
const BASE_RECONCILE_HANDLE_FIELDS = new Set(['entryPoint', 'sender', 'nonce', 'startBlock'])

const BASE_CHILD_PHASE_EVIDENCE_FIELDS = new Map([
  [
    'cctp_burn',
    new Set([
      'burnTxHash',
      'expectationDigest',
      'burnUnits7',
      'amount',
      'token',
      'units',
      'decimals',
      'destinationDomain',
      'messageDigest',
      'messageHash',
      'nonce',
      'mintRecipient',
      'reasonCode',
    ]),
  ],
  [
    'cctp_attestation',
    new Set([
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'attestationDigest',
      'nonce',
      'evidenceVersion',
      'messageHash',
      'attestationHash',
      'reasonCode',
    ]),
  ],
  [
    'cctp_mint',
    new Set([
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'attestationDigest',
      'evidenceVersion',
      'nonce',
      'mintTxHash',
      'transactionHash',
      'blockNumber',
      'blockHash',
      'chainId',
      'reasonCode',
    ]),
  ],
  [
    'base_deposit',
    new Set([
      'chainId',
      'yieldRouterAddress',
      'kernelAddress',
      'caller',
      'poolAddress',
      'assets',
      'minShares',
      'shares',
      'userOpHash',
      'transactionHash',
      'blockNumber',
      'blockHash',
      'reconcileHandle',
      'reasonCode',
      'custodyLocation',
      'kernelCustodyConfirmed',
      'custody',
      'event',
    ]),
  ],
])
const BASE_DEPOSIT_EVENT_FIELDS = new Set([
  'address',
  'topic0',
  'logIndex',
  'caller',
  'poolAddress',
  'assets',
  'shares',
])
const BASE_COMMON_FIELDS = [
  'chainId',
  'yieldRouterAddress',
  'caller',
  'poolAddress',
  'assets',
  'minShares',
]
const BASE_CHILD_PHASE_STATE_FIELDS = new Map([
  ['cctp_burn:submitted', new Set(['burnTxHash', 'expectationDigest', 'burnUnits7'])],
  ['cctp_burn:confirmed', new Set(['burnTxHash', 'expectationDigest', 'burnUnits7'])],
  ['cctp_burn:unknown', new Set(['burnTxHash', 'expectationDigest', 'burnUnits7', 'reasonCode'])],
  ['cctp_burn:failed', new Set(['reasonCode'])],
  ['cctp_burn:blocked', new Set(['reasonCode'])],
  [
    'cctp_attestation:confirmed',
    new Set([
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'attestationDigest',
      'evidenceVersion',
    ]),
  ],
  ...['submitting', 'submitted', 'failed', 'unknown', 'blocked'].map((state) => [
    `cctp_attestation:${state}`,
    new Set([
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'nonce',
      ...(state === 'failed' || state === 'blocked' ? ['reasonCode'] : []),
    ]),
  ]),
  [
    'cctp_mint:confirmed',
    new Set([
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'attestationDigest',
      'evidenceVersion',
      'mintTxHash',
    ]),
  ],
  [
    'cctp_mint:submitted',
    new Set([
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'attestationDigest',
      'nonce',
      'evidenceVersion',
    ]),
  ],
  [
    'cctp_mint:submitting',
    new Set(['burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest', 'nonce']),
  ],
  [
    'cctp_mint:unknown',
    new Set(['burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest', 'nonce']),
  ],
  [
    'cctp_mint:failed',
    new Set([
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'attestationDigest',
      'nonce',
      'reasonCode',
    ]),
  ],
  [
    'cctp_mint:blocked',
    new Set([
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'attestationDigest',
      'nonce',
      'reasonCode',
    ]),
  ],
  ['base_deposit:submitting', new Set(BASE_COMMON_FIELDS)],
  ['base_deposit:submitted', new Set([...BASE_COMMON_FIELDS, 'userOpHash'])],
  [
    'base_deposit:confirmed',
    new Set([...BASE_COMMON_FIELDS, 'shares', 'userOpHash', 'transactionHash', 'event']),
  ],
  [
    'base_deposit:failed',
    new Set([...BASE_COMMON_FIELDS, 'userOpHash', 'transactionHash', 'reasonCode']),
  ],
  ['base_deposit:blocked', new Set([...BASE_COMMON_FIELDS, 'reasonCode'])],
  ['base_deposit:unknown', new Set(BASE_COMMON_FIELDS)],
])
const LOWER_ADDRESS_RE = /^0x[0-9a-f]{40}$/
const LOWER_EVM_HASH_RE = /^0x[0-9a-f]{64}$/
const LOWER_BARE_DIGEST_RE = /^[0-9a-f]{64}$/
const LOWER_CCTP_DIGEST_RE = /^0x[0-9a-f]{64}$/
const EXACT_EVIDENCE_INTEGER_FIELDS = new Set([
  'burnUnits7',
  'amount',
  'units',
  'decimals',
  'destinationDomain',
  'evidenceVersion',
  'nonce',
  'blockNumber',
  'chainId',
  'assets',
  'minShares',
  'shares',
  'logIndex',
  'startBlock',
])

export class AgentIndexError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = new.target.name
  }
}

export class AgentIndexValidationError extends AgentIndexError {}
export class AgentIndexConflictError extends AgentIndexError {}
export class AgentIndexUnavailableError extends AgentIndexError {}
export class AgentIndexStoreError extends AgentIndexError {}

/** Deterministic id for one row of `agent_index_sources` — the same shape store.js and any
 * future indexer (Task 3+) must agree on to address a manifest source (a funding_router or
 * registry contract from src/stellar/agentCreatorManifest.js). */
export function sourceIdFor({ networkId, creatorAddress }) {
  requireString(networkId, 'networkId')
  requireString(creatorAddress, 'creatorAddress')
  return `${networkId}:${creatorAddress}`
}

export const nowSeconds = () => Math.floor(Date.now() / 1000)

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${field} must be a non-empty string`)
  return value
}
function requireInt(value, field) {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`)
  return value
}
function requireOneOf(value, options, field) {
  if (!options.includes(value))
    throw new Error(`${field} must be one of ${options.join(', ')}, got ${JSON.stringify(value)}`)
  return value
}
function optionalString(value, field) {
  if (value === null || value === undefined) return null
  return requireString(value, field)
}
function optionalNonNegativeSafeInt(value, field) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer`)
  return value
}
// Token amounts are decimal strings end-to-end — never SQLite INTEGER — so a value like
// "0.0000001" or a unit count above 2^53 never loses precision going through JS number math.
function requireDecimalString(value, field) {
  requireString(value, field)
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new Error(`${field} must be a decimal string, got ${JSON.stringify(value)}`)
  return value
}

function requireUnsignedIntegerString(value, field, { positive = false } = {}) {
  requireString(value, field)
  if (!/^(0|[1-9]\d*)$/.test(value) || (positive && value === '0')) {
    throw new Error(`${field} must be a${positive ? ' positive' : 'n unsigned'} integer string`)
  }
  return value
}

function sensitiveKey(key) {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return (
    normalized.includes('secret') ||
    normalized.includes('private') ||
    normalized.includes('sessionkey') ||
    normalized.includes('serializedapproval') ||
    normalized.includes('capability') ||
    normalized.includes('bearer') ||
    normalized.includes('leasetoken') ||
    normalized.includes('walletmaterial') ||
    normalized.includes('authorization') ||
    normalized.includes('apikey') ||
    normalized.includes('approval') ||
    normalized.includes('holder') ||
    normalized.includes('endpoint') ||
    normalized.includes('diagnostic') ||
    normalized.includes('passkey') ||
    normalized.includes('stack')
  )
}

/** Receipt/intent persistence is deny-by-name for key material. Unlike the display sanitizer,
 * server persistence rejects the whole request so callers cannot mistake a stripped object for
 * the exact body they signed. */
export function assertNoSensitiveProperties(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return
  if (seen.has(value)) throw new Error(`circular data is not serializable at ${path}`)
  seen.add(value)
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKey(key)) throw new Error(`sensitive property rejected at ${path}.${key}`)
    assertNoSensitiveProperties(entry, `${path}.${key}`, seen)
  }
  seen.delete(value)
}

function assertExactUnits(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (normalized === 'units' || normalized.endsWith('units')) {
      if (typeof entry !== 'string' || !/^\d+$/.test(entry)) {
        throw new Error(`${path}.${key} units must be an exact integer string`)
      }
    }
    assertExactUnits(entry, `${path}.${key}`, seen)
  }
  seen.delete(value)
}

export function canonicalJson(value) {
  assertNoSensitiveProperties(value)
  assertExactUnits(value)
  const canonicalize = (entry) => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('non-finite numbers are not serializable')
      if (Number.isInteger(entry) && !Number.isSafeInteger(entry)) {
        throw new Error('integer JSON values must be safe integers; use an exact string')
      }
      return entry
    }
    if (Array.isArray(entry)) return entry.map(canonicalize)
    if (!entry || typeof entry !== 'object') throw new Error('unsupported JSON value')
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((key) => [key, canonicalize(entry[key])])
    )
  }
  return JSON.stringify(canonicalize(value))
}

function exactEvidenceObject(
  value,
  allowed,
  path,
  { requireAll = false, requiredFields = allowed } = {}
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an evidence object`)
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowlisted evidence`)
    if (EXACT_EVIDENCE_INTEGER_FIELDS.has(key)) {
      if (key === 'nonce' && typeof entry === 'string' && /^0x[0-9a-f]{64}$/.test(entry)) continue
      requireUnsignedIntegerString(entry, `${path}.${key}`)
      continue
    }
    if (key === 'event') {
      exactEvidenceObject(entry, BASE_DEPOSIT_EVENT_FIELDS, `${path}.event`, { requireAll: true })
      continue
    }
    if (key === 'custody') {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).some((nestedKey) => !['location', 'confirmed'].includes(nestedKey)) ||
        typeof entry.location !== 'string' ||
        typeof entry.confirmed !== 'boolean'
      ) {
        throw new Error(`${path}.custody is invalid`)
      }
      continue
    }
    if (key === 'reconcileHandle') {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).length !== BASE_RECONCILE_HANDLE_FIELDS.size ||
        Object.keys(entry).some((nestedKey) => !BASE_RECONCILE_HANDLE_FIELDS.has(nestedKey)) ||
        typeof entry.entryPoint !== 'string' ||
        typeof entry.sender !== 'string' ||
        typeof entry.nonce !== 'string' ||
        typeof entry.startBlock !== 'string'
      ) {
        throw new Error(`${path}.reconcileHandle is invalid`)
      }
      continue
    }
    if (entry !== null && typeof entry !== 'string' && typeof entry !== 'boolean') {
      throw new Error(`${path}.${key} must be a bounded JSON scalar`)
    }
  }
  if (requireAll) {
    const missing = [...requiredFields].find(
      (key) => !Object.prototype.hasOwnProperty.call(value, key)
    )
    if (missing) throw new Error(`${path}.${missing} is required evidence`)
  }
}

function assertEvidenceDepth(value, depth = 1, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return
  if (depth > MAX_BASE_CHILD_EVIDENCE_DEPTH) {
    throw new Error('Base child evidence exceeds the depth limit')
  }
  if (seen.has(value)) throw new Error('Base child evidence must not contain cycles')
  seen.add(value)
  for (const entry of Object.values(value)) assertEvidenceDepth(entry, depth + 1, seen)
  seen.delete(value)
}

export function validateBaseChildPhaseEvidence({ phase, state, evidence }) {
  const allowed = BASE_CHILD_PHASE_EVIDENCE_FIELDS.get(phase)
  if (!allowed) throw new Error('Base child evidence phase is unsupported')
  const required = BASE_CHILD_PHASE_STATE_FIELDS.get(`${phase}:${state}`)
  if (!required) throw new Error('Base child evidence phase/state is unsupported')
  const stateAllowed = new Set(required)
  if (phase === 'cctp_mint' && ['submitted', 'unknown'].includes(state)) {
    stateAllowed.add('mintTxHash')
  }
  if (phase === 'cctp_burn' && state === 'confirmed') {
    stateAllowed.add('messageDigest')
    stateAllowed.add('nonce')
  }
  if (phase === 'cctp_attestation' && state === 'confirmed') {
    stateAllowed.add('nonce')
  }
  if (phase === 'cctp_mint' && state === 'confirmed') {
    stateAllowed.add('nonce')
  }
  if (phase === 'base_deposit' && state === 'unknown') {
    stateAllowed.add('userOpHash')
    stateAllowed.add('transactionHash')
    stateAllowed.add('reasonCode')
  }
  if (phase === 'base_deposit' && state === 'failed') {
    stateAllowed.add('custodyLocation')
    stateAllowed.add('kernelCustodyConfirmed')
    stateAllowed.add('custody')
  }
  if (phase === 'base_deposit' && state === 'blocked') {
    stateAllowed.add('userOpHash')
    stateAllowed.add('transactionHash')
    stateAllowed.add('kernelCustodyConfirmed')
    stateAllowed.add('custodyLocation')
    stateAllowed.add('custody')
  }
  if (phase === 'base_deposit') {
    stateAllowed.add('kernelAddress')
    stateAllowed.add('reconcileHandle')
  }
  assertNoSensitiveProperties(evidence)
  assertEvidenceDepth(evidence)
  exactEvidenceObject(evidence, stateAllowed, 'event.evidence', {
    requireAll: true,
    requiredFields: required,
  })
  for (const field of ['yieldRouterAddress', 'caller', 'poolAddress', 'kernelAddress']) {
    if (
      Object.prototype.hasOwnProperty.call(evidence, field) &&
      !LOWER_ADDRESS_RE.test(evidence[field])
    ) {
      throw new Error(`event.evidence.${field} must be a canonical address`)
    }
  }
  if (evidence.reconcileHandle) {
    const handle = evidence.reconcileHandle
    if (
      handle.entryPoint !== BASE_RECONCILE_ENTRY_POINT ||
      !LOWER_ADDRESS_RE.test(handle.entryPoint) ||
      !LOWER_ADDRESS_RE.test(handle.sender) ||
      handle.sender === `0x${'00'.repeat(20)}` ||
      handle.sender !== evidence.caller ||
      !/^(0|[1-9]\d*)$/.test(handle.nonce) ||
      !/^(0|[1-9]\d*)$/.test(handle.startBlock)
    ) {
      throw new Error('event.evidence.reconcileHandle is invalid')
    }
  }
  for (const field of ['userOpHash', 'transactionHash', 'mintTxHash']) {
    if (
      evidence[field] !== null &&
      Object.prototype.hasOwnProperty.call(evidence, field) &&
      !LOWER_EVM_HASH_RE.test(evidence[field])
    ) {
      throw new Error(`event.evidence.${field} must be a canonical hash`)
    }
  }
  for (const field of ['burnTxHash', 'expectationDigest']) {
    if (
      Object.prototype.hasOwnProperty.call(evidence, field) &&
      !LOWER_BARE_DIGEST_RE.test(evidence[field])
    ) {
      throw new Error(`event.evidence.${field} must be a canonical digest`)
    }
  }
  for (const field of ['messageDigest', 'attestationDigest']) {
    if (
      Object.prototype.hasOwnProperty.call(evidence, field) &&
      !LOWER_CCTP_DIGEST_RE.test(evidence[field])
    ) {
      throw new Error(`event.evidence.${field} must be a canonical 0x-prefixed digest`)
    }
  }
  if (evidence.event) {
    for (const field of ['address', 'caller', 'poolAddress']) {
      if (!LOWER_ADDRESS_RE.test(evidence.event[field])) {
        throw new Error(`event.evidence.event.${field} must be a canonical address`)
      }
    }
    if (!LOWER_EVM_HASH_RE.test(evidence.event.topic0)) {
      throw new Error('event.evidence.event.topic0 must be a canonical hash')
    }
  }
  if (evidence.custody) {
    if (
      !evidence.custody ||
      typeof evidence.custody !== 'object' ||
      Array.isArray(evidence.custody) ||
      Object.keys(evidence.custody).some((key) => !['location', 'confirmed'].includes(key)) ||
      typeof evidence.custody.location !== 'string' ||
      typeof evidence.custody.confirmed !== 'boolean'
    ) {
      throw new Error('event.evidence.custody is invalid')
    }
  }
  const evidenceJson = canonicalJson(evidence)
  if (new TextEncoder().encode(evidenceJson).byteLength > MAX_BASE_CHILD_EVIDENCE_BYTES) {
    throw new Error('Base child evidence exceeds the payload size limit')
  }
  return evidenceJson
}

function requireAmount(amount, field) {
  if (!amount || typeof amount !== 'object' || Array.isArray(amount)) {
    throw new Error(`${field} must be an object`)
  }
  return {
    token: requireString(amount.token, `${field}.token`),
    units: (() => {
      const units = requireString(amount.units, `${field}.units`)
      if (!/^\d+$/.test(units)) throw new Error(`${field}.units must be an exact integer string`)
      return units
    })(),
    decimals: (() => {
      const decimals = requireInt(amount.decimals, `${field}.decimals`)
      if (decimals < 0) throw new Error(`${field}.decimals must be non-negative`)
      return decimals
    })(),
  }
}

export function toExecutionReceiptRow(record, intentDigest) {
  const r = record || {}
  if (r.version !== 2) throw new Error('receipt.version must be 2')
  assertNoSensitiveProperties(r)
  assertExactUnits(r)
  const phases = r.phases || {}
  const custody = r.custody || {}
  const amount = custody.amount == null ? null : requireAmount(custody.amount, 'custody.amount')
  if (custody.confirmed !== true && custody.confirmed !== false) {
    throw new Error('custody.confirmed must be boolean')
  }
  return {
    network_id: requireString(r.networkId, 'networkId'),
    execution_id: requireString(r.executionId, 'executionId'),
    allocation_id: requireString(r.allocationId, 'allocationId'),
    receipt_format: 2,
    owner_address: requireString(r.owner, 'owner'),
    run_id: requireString(r.runId, 'runId'),
    parent_allocation_id: optionalString(r.parentAllocationId, 'parentAllocationId'),
    child_id: optionalString(r.childId, 'childId'),
    worker_address: requireString(r.worker, 'worker'),
    agent_address: requireString(r.agent, 'agent'),
    intent_digest: requireString(intentDigest, 'intentDigest'),
    intent_json: canonicalJson(r.intent),
    pull_status: requireOneOf(phases.pull, RECEIPT_PHASE_STATUSES, 'phases.pull'),
    stellar_deposit_status: requireOneOf(
      phases.stellar_deposit,
      RECEIPT_PHASE_STATUSES,
      'phases.stellar_deposit'
    ),
    cctp_burn_status: requireOneOf(phases.cctp_burn, RECEIPT_PHASE_STATUSES, 'phases.cctp_burn'),
    cctp_mint_status: requireOneOf(phases.cctp_mint, RECEIPT_PHASE_STATUSES, 'phases.cctp_mint'),
    base_deposit_status: requireOneOf(
      phases.base_deposit,
      RECEIPT_PHASE_STATUSES,
      'phases.base_deposit'
    ),
    custody_location: requireOneOf(custody.location, RECEIPT_CUSTODY_LOCATIONS, 'custody.location'),
    custody_confirmed: custody.confirmed ? 1 : 0,
    custody_token: amount?.token ?? null,
    custody_units: amount?.units ?? null,
    custody_decimals: amount?.decimals ?? null,
    custody_reason: optionalString(custody.reason, 'custody.reason'),
  }
}

export function toPhaseAttemptRow(record) {
  const r = record || {}
  assertNoSensitiveProperties(r)
  assertExactUnits(r)
  return {
    attempt_id: requireString(r.attemptId, 'attemptId'),
    attempt_kind: requireOneOf(r.kind, ['phase', 'revoked-scope-reconciliation'], 'attempt.kind'),
    phase: requireOneOf(r.phase, RECEIPT_PHASES, 'attempt.phase'),
    status: requireOneOf(r.status, RECEIPT_PHASE_STATUSES, 'attempt.status'),
    evidence_json: canonicalJson(r.evidence ?? {}),
    observed_at: requireInt(r.observedAt, 'attempt.observedAt'),
  }
}

export function parseExecutionReceiptRow(row, attempts = []) {
  if (!row) return null
  const amount =
    row.custody_units == null
      ? null
      : { token: row.custody_token, units: row.custody_units, decimals: row.custody_decimals }
  return {
    version: row.version,
    format: row.receipt_format,
    networkId: row.network_id,
    executionId: row.execution_id,
    runId: row.run_id,
    allocationId: row.allocation_id,
    parentAllocationId: row.parent_allocation_id,
    childId: row.child_id,
    owner: row.owner_address,
    worker: row.worker_address,
    agent: row.agent_address,
    intentDigest: row.intent_digest,
    intent: JSON.parse(row.intent_json),
    phases: {
      pull: row.pull_status,
      stellar_deposit: row.stellar_deposit_status,
      cctp_burn: row.cctp_burn_status,
      cctp_mint: row.cctp_mint_status,
      base_deposit: row.base_deposit_status,
    },
    custody: {
      location: row.custody_location,
      confirmed: row.custody_confirmed === 1,
      amount,
      reason: row.custody_reason,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempts,
  }
}

export function parsePhaseAttemptRow(row) {
  return {
    attemptId: row.attempt_id,
    kind: row.attempt_kind,
    phase: row.phase,
    status: row.status,
    evidence: JSON.parse(row.evidence_json),
    observedAt: row.observed_at,
    receiptVersion: row.receipt_version,
  }
}

export function toBaseChildRow(child, intentDigest) {
  const c = child || {}
  if (c.version !== 1) throw new Error('base child version must be 1')
  assertNoSensitiveProperties(c)
  assertExactUnits(c)
  const amount = requireAmount(c.intent, 'intent')
  requireUnsignedIntegerString(amount.units, 'intent.units', { positive: true })
  requireUnsignedIntegerString(c.intent?.minShares, 'intent.minShares')
  const executionId = requireString(c.executionId, 'executionId')
  const expectedExecutionId = `${requireString(c.intent?.runId, 'intent.runId')}:exec:${requireString(c.allocationId, 'allocationId')}`
  if (executionId !== expectedExecutionId) {
    throw new Error('executionId must match runId and allocationId')
  }
  const lifecycle = c.lifecycle || {}
  if (lifecycle.sequence !== 0) throw new Error('first Base child lifecycle sequence must be 0')
  return {
    network_id: requireString(c.networkId, 'networkId'),
    binding_id: requireString(c.bindingId, 'bindingId'),
    execution_id: executionId,
    allocation_id: c.allocationId,
    child_id: requireString(c.childId, 'childId'),
    owner_address: requireString(c.owner, 'owner'),
    agent_address: requireString(c.agent, 'agent'),
    intent_digest: requireString(intentDigest, 'intentDigest'),
    intent_json: canonicalJson(c.intent),
    token: amount.token,
    units: amount.units,
    decimals: amount.decimals,
    recovery_version: 0,
    lifecycle_sequence: 0,
    lifecycle_status: requireOneOf(
      lifecycle.status,
      BASE_CHILD_LIFECYCLE_STATUSES,
      'lifecycle.status'
    ),
    lifecycle_evidence_json: canonicalJson(lifecycle.evidence ?? {}),
    observed_at: (() => {
      const observedAt = requireInt(lifecycle.observedAt, 'lifecycle.observedAt')
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
        throw new Error('lifecycle.observedAt must be a non-negative safe integer')
      }
      return observedAt
    })(),
  }
}

export function parseBaseChildRow(row) {
  if (!row) return null
  const intent = JSON.parse(row.intent_json)
  const executionId = row.execution_id ?? null
  if (executionId !== null && executionId !== `${intent?.runId}:exec:${row.allocation_id}`) {
    throw new Error('persisted Base child execution mapping is invalid')
  }
  const recoveryVersion = row.recovery_version ?? 0
  if (!Number.isSafeInteger(recoveryVersion) || recoveryVersion < 0) {
    throw new Error('persisted Base child recovery version is invalid')
  }
  return {
    version: 1,
    networkId: row.network_id,
    bindingId: row.binding_id,
    executionId,
    allocationId: row.allocation_id,
    childId: row.child_id,
    owner: row.owner_address,
    agent: row.agent_address,
    intentDigest: row.intent_digest,
    intent,
    recoveryVersion,
    recoverable: executionId !== null,
    recoveryUnavailableReason: executionId === null ? 'legacy-execution-unmapped' : null,
    lifecycle: {
      sequence: row.lifecycle_sequence,
      status: row.lifecycle_status,
      evidence: JSON.parse(row.lifecycle_evidence_json),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function baseChildRecoveryIdentity(value) {
  const identity = value || {}
  return {
    networkId: requireString(identity.networkId, 'networkId'),
    bindingId: requireString(identity.bindingId, 'bindingId'),
    executionId: requireString(identity.executionId, 'executionId'),
    allocationId: requireString(identity.allocationId, 'allocationId'),
    childId: requireString(identity.childId, 'childId'),
  }
}

// Task 14 keeps Base recovery's protocol vocabulary separate from the Stellar receipt selector.
// These values are shared by the browser proof handler and the D1 lease store; adding an action to
// the list is therefore an intentional protocol change rather than an accidental caller typo.
export const BASE_RECOVERY_ACTIONS = Object.freeze([
  'no-movement',
  'poll-attestation',
  'submit-mint',
  'poll-mint',
  'submit-base-deposit',
  'poll-base-deposit',
  'owner-action-required',
  'complete',
  'manual-review',
])

export const BASE_RECOVERY_PHASES = Object.freeze(['cctp_attestation', 'cctp_mint', 'base_deposit'])
const BASE_RECOVERY_ACTION_PHASE = Object.freeze({
  'poll-attestation': 'cctp_attestation',
  'submit-mint': 'cctp_mint',
  'poll-mint': 'cctp_mint',
  'submit-base-deposit': 'base_deposit',
  'poll-base-deposit': 'base_deposit',
})

const BASE_RECOVERY_REQUEST_FIELDS = new Set([
  'executionId',
  'bindingId',
  'allocationId',
  'childId',
  'expectedRecoveryVersion',
  'leaseOwner',
])
const BASE_RECOVERY_LEASE_FIELDS = new Set([
  'identity',
  'owner',
  'action',
  'phase',
  'evidenceVersion',
  'holder',
  'leaseToken',
  'now',
  'ttlMs',
])

function requireExactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentIndexValidationError(`${label} must be an object`)
  }
  const keys = Object.keys(value)
  if (
    keys.length !== fields.size ||
    keys.some((key) => !fields.has(key)) ||
    [...fields].some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new AgentIndexValidationError(`Invalid ${label}`)
  }
}

function validateBaseExecutionMapping({ executionId, allocationId }) {
  if (
    typeof executionId !== 'string' ||
    typeof allocationId !== 'string' ||
    !executionId ||
    !allocationId ||
    executionId !== `${executionId.split(':exec:')[0]}:exec:${allocationId}`
  ) {
    throw new AgentIndexValidationError('Base recovery execution mapping is invalid')
  }
}

/** Exact body signed by the bridge-agent credential for `action=base-recovery-request`. */
export function validateBaseRecoveryRequest(request) {
  requireExactFields(request, BASE_RECOVERY_REQUEST_FIELDS, 'Base recovery request')
  for (const field of ['executionId', 'bindingId', 'allocationId', 'childId', 'leaseOwner']) {
    if (typeof request[field] !== 'string' || request[field].length === 0) {
      throw new AgentIndexValidationError(`Base recovery request ${field} is required`)
    }
  }
  if (request.leaseOwner.length > 128) {
    throw new AgentIndexValidationError('Base recovery request leaseOwner is too long')
  }
  validateBaseExecutionMapping(request)
  if (
    !Number.isSafeInteger(request.expectedRecoveryVersion) ||
    request.expectedRecoveryVersion < 0
  ) {
    throw new AgentIndexValidationError('Base recovery request version is invalid')
  }
  return { ...request }
}

/** Validates all immutable and fencing facts before a Base lease reaches SQL. */
export function validateBaseRecoveryLease(lease) {
  requireExactFields(lease, BASE_RECOVERY_LEASE_FIELDS, 'Base recovery lease')
  const identity = baseChildRecoveryIdentity(lease.identity)
  validateBaseExecutionMapping(identity)
  if (typeof lease.owner !== 'string' || lease.owner.length === 0) {
    throw new AgentIndexValidationError('Base recovery lease owner is required')
  }
  if (!BASE_RECOVERY_ACTIONS.includes(lease.action) || lease.action === 'manual-review') {
    throw new AgentIndexValidationError('Base recovery lease action is not claimable')
  }
  if (
    !BASE_RECOVERY_PHASES.includes(lease.phase) ||
    BASE_RECOVERY_ACTION_PHASE[lease.action] !== lease.phase
  ) {
    throw new AgentIndexValidationError('Base recovery lease phase is invalid')
  }
  if (!Number.isSafeInteger(lease.evidenceVersion) || lease.evidenceVersion < 0) {
    throw new AgentIndexValidationError('Base recovery lease evidence version is invalid')
  }
  if (typeof lease.holder !== 'string' || lease.holder.length === 0 || lease.holder.length > 128) {
    throw new AgentIndexValidationError('Base recovery lease holder is required')
  }
  if (typeof lease.leaseToken !== 'string' || !/^[0-9a-f]{64}$/.test(lease.leaseToken)) {
    throw new AgentIndexValidationError('Base recovery lease token is invalid')
  }
  if (!Number.isSafeInteger(lease.now) || lease.now < 0) {
    throw new AgentIndexValidationError('Base recovery lease time is invalid')
  }
  if (
    !Number.isSafeInteger(lease.ttlMs) ||
    lease.ttlMs <= 0 ||
    lease.now + lease.ttlMs <= lease.now
  ) {
    throw new AgentIndexValidationError('Base recovery lease TTL is invalid')
  }
  return { ...lease, identity }
}

export function baseChildBatchDigest(batch) {
  assertNoSensitiveProperties(batch)
  return createHash('sha256').update(canonicalJson(batch)).digest('hex')
}

export function baseChildEvidenceDigest(evidence) {
  assertNoSensitiveProperties(evidence)
  return createHash('sha256').update(canonicalJson(evidence)).digest('hex')
}

export function baseChildEvidenceReportDigest(report) {
  assertNoSensitiveProperties(report)
  return createHash('sha256').update(canonicalJson(report)).digest('hex')
}

export function toBaseChildPhaseEventRow(report, subjects) {
  const identity = baseChildRecoveryIdentity(report?.identity)
  const expectedRecoveryVersion = report?.expectedRecoveryVersion
  if (!Number.isSafeInteger(expectedRecoveryVersion) || expectedRecoveryVersion < 0) {
    throw new Error('expectedRecoveryVersion must be a non-negative safe integer')
  }
  const event = report?.event || {}
  const eventId = requireString(event.eventId, 'event.eventId')
  if (!/^[0-9a-f]{64}$/.test(eventId)) throw new Error('event.eventId must be 64 lowercase hex')
  const evidenceJson = validateBaseChildPhaseEvidence({
    phase: event.phase,
    state: event.state,
    evidence: event.evidence ?? {},
  })
  const observedAt = requireInt(event.observedAt, 'event.observedAt')
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error('event.observedAt must be a non-negative safe integer')
  }
  return {
    event_id: eventId,
    network_id: identity.networkId,
    binding_id: identity.bindingId,
    execution_id: identity.executionId,
    allocation_id: identity.allocationId,
    child_id: identity.childId,
    owner_address: requireString(subjects?.owner, 'owner'),
    agent_address: requireString(subjects?.agent, 'agent'),
    recovery_version: expectedRecoveryVersion + 1,
    phase: requireOneOf(event.phase, BASE_CHILD_RECOVERY_PHASES, 'event.phase'),
    state: requireOneOf(event.state, BASE_CHILD_RECOVERY_STATES, 'event.state'),
    evidence_digest: baseChildEvidenceDigest(event.evidence ?? {}),
    evidence_json: evidenceJson,
    observed_at: observedAt,
  }
}

export function parseBaseChildPhaseEventRow(row) {
  if (!row) return null
  return {
    eventId: row.event_id,
    identity: {
      networkId: row.network_id,
      bindingId: row.binding_id,
      executionId: row.execution_id,
      allocationId: row.allocation_id,
      childId: row.child_id,
    },
    owner: row.owner_address,
    agent: row.agent_address,
    recoveryVersion: row.recovery_version,
    phase: row.phase,
    state: row.state,
    evidenceDigest: row.evidence_digest,
    evidence: JSON.parse(row.evidence_json),
    observedAt: row.observed_at,
  }
}

export function parseBaseChildPhaseProjectionRow(row) {
  if (!row) return null
  return {
    eventId: row.latest_event_id,
    identity: {
      networkId: row.network_id,
      bindingId: row.binding_id,
      executionId: row.execution_id,
      allocationId: row.allocation_id,
      childId: row.child_id,
    },
    recoveryVersion: row.recovery_version,
    phase: row.phase,
    state: row.state,
    evidenceDigest: row.evidence_digest,
    evidence: JSON.parse(row.evidence_json),
    observedAt: row.observed_at,
  }
}

/** Shapes+validates an `upsertMembership`/`commitSourcePage` membership input into the exact
 * snake_case column set store.js binds. `provenance` is a plain object — this is the only place
 * it gets JSON.stringify'd. */
export function toMembershipRow(record) {
  const r = record || {}
  return {
    network_id: requireString(r.networkId, 'networkId'),
    agent_address: requireString(r.agentAddress, 'agentAddress'),
    owner_address: requireString(r.ownerAddress, 'ownerAddress'),
    creator_address: requireString(r.creatorAddress, 'creatorAddress'),
    schema_version: requireInt(r.schemaVersion, 'schemaVersion'),
    agent_kind: requireOneOf(r.kind, AGENT_KINDS, 'kind'),
    creation_ledger: requireInt(r.creationLedger, 'creationLedger'),
    creation_tx: requireString(r.creationTx, 'creationTx'),
    grant_tx_hash: optionalString(r.grantTxHash, 'grantTxHash'),
    run_id: optionalString(r.runId, 'runId'),
    run_ordinal: optionalNonNegativeSafeInt(r.runOrdinal, 'runOrdinal'),
    provenance: JSON.stringify(r.provenance ?? {}),
  }
}

export function parseMembershipRow(row) {
  if (!row) return null
  return {
    networkId: row.network_id,
    address: row.agent_address,
    owner: row.owner_address,
    creator: row.creator_address,
    schemaVersion: row.schema_version,
    kind: row.agent_kind,
    createdLedger: row.creation_ledger,
    createdTxHash: row.creation_tx,
    grantTxHash: row.grant_tx_hash,
    runId: row.run_id,
    runOrdinal: row.run_ordinal,
    provenance: JSON.parse(row.provenance),
  }
}

/** Shapes+validates an `upsertRunAllocation` input. */
export function toRunAllocationRow(record) {
  const r = record || {}
  return {
    id: requireString(r.id, 'id'),
    network_id: requireString(r.networkId, 'networkId'),
    run_id: requireString(r.runId, 'runId'),
    owner_address: requireString(r.ownerAddress, 'ownerAddress'),
    bridge_agent_address: requireString(r.bridgeAgentAddress, 'bridgeAgentAddress'),
    base_child_address: optionalString(r.baseChildAddress, 'baseChildAddress'),
    token: requireString(r.token, 'token'),
    units: requireDecimalString(r.units, 'units'),
    decimals: requireInt(r.decimals, 'decimals'),
    proxy_target: optionalString(r.proxyTarget, 'proxyTarget'),
    job_id: optionalString(r.jobId, 'jobId'),
    tx_id: optionalString(r.txId, 'txId'),
    execution_status: requireOneOf(r.executionStatus, EXECUTION_STATUSES, 'executionStatus'),
    custody_location: requireOneOf(r.custodyLocation, CUSTODY_LOCATIONS, 'custodyLocation'),
  }
}

export function parseRunAllocationRow(row) {
  if (!row) return null
  return {
    id: row.id,
    networkId: row.network_id,
    runId: row.run_id,
    ownerAddress: row.owner_address,
    bridgeAgentAddress: row.bridge_agent_address,
    baseChildAddress: row.base_child_address,
    amount: { token: row.token, units: row.units, decimals: row.decimals },
    proxyTarget: row.proxy_target,
    jobId: row.job_id,
    txId: row.tx_id,
    executionStatus: row.execution_status,
    custodyLocation: row.custody_location,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Shapes a fully verified relayer association for the additive 0004 columns. */
export function toAssociationRow(record) {
  const r = record || {}
  return {
    id: requireString(r.allocationId, 'allocationId'),
    network_id: requireString(r.networkId, 'networkId'),
    run_id: requireString(r.runId, 'runId'),
    owner_address: requireString(r.ownerAddress, 'ownerAddress'),
    bridge_agent_address: requireString(r.bridgeAgentAddress, 'bridgeAgentAddress'),
    base_child_address: requireString(r.poolAddress, 'poolAddress'),
    token: requireString(r.amount?.token, 'amount.token'),
    units: requireDecimalString(r.amount?.units, 'amount.units'),
    decimals: requireInt(r.amount?.decimals, 'amount.decimals'),
    proxy_target: requireOneOf(
      r.proxyTarget,
      ['aave-v3', 'morpho-blue', 'moonwell'],
      'proxyTarget'
    ),
    job_id: requireString(r.baseJobId, 'baseJobId'),
    tx_id: optionalString(r.txHash, 'txHash'),
    execution_status: requireOneOf(r.executionStatus, EXECUTION_STATUSES, 'executionStatus'),
    custody_location: requireOneOf(r.custodyLocation, CUSTODY_LOCATIONS, 'custodyLocation'),
    grant_tx_hash: requireString(r.grantTxHash, 'grantTxHash'),
    kernel_address: requireString(r.kernelAddress, 'kernelAddress'),
    mandate_binding_id: requireString(r.mandateBindingId, 'mandateBindingId'),
    mandate_binding_hash: requireString(r.mandateBindingHash, 'mandateBindingHash'),
    association_source: requireOneOf(
      r.associationSource,
      ['relayer-attested'],
      'associationSource'
    ),
    reported_at: requireInt(r.reportedAt, 'reportedAt'),
    scope_checked_at: requireInt(r.scopeCheckedAt, 'scopeCheckedAt'),
  }
}

export function parseAssociationRow(row) {
  if (!row) return null
  return {
    allocationId: row.id,
    networkId: row.network_id,
    runId: row.run_id,
    ownerAddress: row.owner_address,
    bridgeAgentAddress: row.bridge_agent_address,
    poolAddress: row.base_child_address,
    amount: { token: row.token, units: row.units, decimals: row.decimals },
    proxyTarget: row.proxy_target,
    baseJobId: row.job_id,
    txHash: row.tx_id,
    executionStatus: row.execution_status,
    custodyLocation: row.custody_location,
    grantTxHash: row.grant_tx_hash ?? null,
    kernelAddress: row.kernel_address ?? null,
    mandateBindingId: row.mandate_binding_id ?? null,
    mandateBindingHash: row.mandate_binding_hash ?? null,
    associationSource: row.association_source ?? null,
    reportedAt: row.reported_at ?? null,
    scopeCheckedAt: row.scope_checked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Shapes+validates a `recordGap` input. */
export function toGapRow(gap) {
  const g = gap || {}
  const fromLedger = requireInt(g.fromLedger, 'fromLedger')
  const throughLedger = requireInt(g.throughLedger, 'throughLedger')
  if (throughLedger < fromLedger) throw new Error('throughLedger must be >= fromLedger')
  return {
    source_id: requireString(g.sourceId, 'sourceId'),
    network_id: requireString(g.networkId, 'networkId'),
    from_ledger: fromLedger,
    through_ledger: throughLedger,
    reason: requireString(g.reason, 'reason'),
  }
}

export function parseGapRow(row) {
  if (!row) return null
  return {
    id: row.id,
    sourceId: row.source_id,
    networkId: row.network_id,
    fromLedger: row.from_ledger,
    throughLedger: row.through_ledger,
    reason: row.reason,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  }
}

/** Shapes+validates a `recordBackfillAudit` input. */
export function toBackfillAuditRow(audit) {
  const a = audit || {}
  const fromLedger = requireInt(a.fromLedger, 'fromLedger')
  const throughLedger = requireInt(a.throughLedger, 'throughLedger')
  if (throughLedger < fromLedger) throw new Error('throughLedger must be >= fromLedger')
  return {
    network_id: requireString(a.networkId, 'networkId'),
    source_id: requireString(a.sourceId, 'sourceId'),
    method: requireString(a.method, 'method'),
    result: requireOneOf(a.result, BACKFILL_RESULTS, 'result'),
    from_ledger: fromLedger,
    through_ledger: throughLedger,
    evidence: JSON.stringify(a.evidence ?? {}),
    notes: optionalString(a.notes, 'notes'),
  }
}

export function parseBackfillAuditRow(row) {
  if (!row) return null
  return {
    id: row.id,
    networkId: row.network_id,
    sourceId: row.source_id,
    attemptedAt: row.attempted_at,
    method: row.method,
    result: row.result,
    fromLedger: row.from_ledger,
    throughLedger: row.through_ledger,
    evidence: JSON.parse(row.evidence),
    notes: row.notes,
  }
}

export function parseSourceRow(row) {
  if (!row) return null
  return {
    sourceId: row.source_id,
    networkId: row.network_id,
    creatorAddress: row.creator_address,
    manifestHash: row.manifest_hash,
    manifestVersion: row.manifest_version,
    schemaVersion: row.schema_version,
    indexedFromLedger: row.indexed_from_ledger,
    indexedThroughLedger: row.indexed_through_ledger,
    finalizedThroughLedger: row.finalized_through_ledger,
    cursor: row.cursor,
    status: row.status,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
    // 0003_agent_index_bounds.sql — provider identity + reported chain-tip/retention bounds.
    // `undefined` (pre-migration row shape in an old test double) normalizes to `null`, same as a
    // genuinely never-reported column — coverageProof treats both as "no tip known".
    providerId: row.provider_id ?? null,
    endpointClass: row.endpoint_class ?? null,
    reportedOldestLedger: row.reported_oldest_ledger ?? null,
    reportedLatestLedger: row.reported_latest_ledger ?? null,
  }
}
