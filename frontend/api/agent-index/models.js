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
function optionalInt(value, field) {
  if (value === null || value === undefined) return null
  return requireInt(value, field)
}
// Token amounts are decimal strings end-to-end — never SQLite INTEGER — so a value like
// "0.0000001" or a unit count above 2^53 never loses precision going through JS number math.
function requireDecimalString(value, field) {
  requireString(value, field)
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new Error(`${field} must be a decimal string, got ${JSON.stringify(value)}`)
  return value
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
    run_ordinal: optionalInt(r.runOrdinal, 'runOrdinal'),
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
