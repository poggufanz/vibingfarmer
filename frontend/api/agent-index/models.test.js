import { describe, it, expect } from 'vitest'
import {
  AGENT_KINDS,
  CUSTODY_LOCATIONS,
  EXECUTION_STATUSES,
  BACKFILL_RESULTS,
  sourceIdFor,
  nowSeconds,
  toMembershipRow,
  parseMembershipRow,
  toRunAllocationRow,
  parseRunAllocationRow,
  toAssociationRow,
  parseAssociationRow,
  toGapRow,
  parseGapRow,
  toBackfillAuditRow,
  parseBackfillAuditRow,
  parseSourceRow,
} from './models.js'

const membership = (over = {}) => ({
  networkId: 'stellar-testnet',
  agentAddress: 'CAGENT1',
  ownerAddress: 'GOWNER1',
  creatorAddress: 'CROUTER1',
  schemaVersion: 1,
  kind: 'deposit',
  creationLedger: 100,
  creationTx: 'tx1',
  grantTxHash: 'grant1',
  runId: 'stellar-testnet:CROUTER1:grant1',
  runOrdinal: 0,
  provenance: { source: 'router-event' },
  ...over,
})

const allocation = (over = {}) => ({
  id: 'alloc-1',
  networkId: 'stellar-testnet',
  runId: 'run-1',
  ownerAddress: 'GOWNER1',
  bridgeAgentAddress: 'CAGENT1',
  baseChildAddress: null,
  token: 'USDC',
  units: '1000000',
  decimals: 6,
  proxyTarget: null,
  jobId: null,
  txId: null,
  executionStatus: 'queued',
  custodyLocation: 'agent',
  ...over,
})

describe('sourceIdFor', () => {
  it('joins networkId and creatorAddress deterministically', () => {
    expect(sourceIdFor({ networkId: 'stellar-testnet', creatorAddress: 'CROUTER1' })).toBe(
      'stellar-testnet:CROUTER1'
    )
  })
  it('throws when either part is missing', () => {
    expect(() => sourceIdFor({ networkId: '', creatorAddress: 'CROUTER1' })).toThrow()
    expect(() => sourceIdFor({ networkId: 'stellar-testnet' })).toThrow()
  })
})

describe('nowSeconds', () => {
  it('returns an integer epoch-seconds timestamp', () => {
    const n = nowSeconds()
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThan(1_700_000_000)
  })
})

describe('toMembershipRow / parseMembershipRow', () => {
  it('shapes a valid record into snake_case columns and round-trips', () => {
    const row = toMembershipRow(membership())
    expect(row).toEqual({
      network_id: 'stellar-testnet',
      agent_address: 'CAGENT1',
      owner_address: 'GOWNER1',
      creator_address: 'CROUTER1',
      schema_version: 1,
      agent_kind: 'deposit',
      creation_ledger: 100,
      creation_tx: 'tx1',
      grant_tx_hash: 'grant1',
      run_id: 'stellar-testnet:CROUTER1:grant1',
      run_ordinal: 0,
      provenance: JSON.stringify({ source: 'router-event' }),
    })
    expect(parseMembershipRow(row)).toEqual({
      networkId: 'stellar-testnet',
      address: 'CAGENT1',
      owner: 'GOWNER1',
      creator: 'CROUTER1',
      schemaVersion: 1,
      kind: 'deposit',
      createdLedger: 100,
      createdTxHash: 'tx1',
      grantTxHash: 'grant1',
      runId: 'stellar-testnet:CROUTER1:grant1',
      runOrdinal: 0,
      provenance: { source: 'router-event' },
    })
  })
  it('defaults provenance to {} and allows grantTxHash/runId/runOrdinal to be omitted', () => {
    const row = toMembershipRow(
      membership({
        grantTxHash: undefined,
        runId: undefined,
        runOrdinal: undefined,
        provenance: undefined,
      })
    )
    expect(row.grant_tx_hash).toBeNull()
    expect(row.run_id).toBeNull()
    expect(row.run_ordinal).toBeNull()
    expect(row.provenance).toBe('{}')
  })
  it('rejects an unknown agent kind', () => {
    expect(() => toMembershipRow(membership({ kind: 'legacy' }))).toThrow(/kind/)
  })
  for (const field of [
    'networkId',
    'agentAddress',
    'ownerAddress',
    'creatorAddress',
    'creationTx',
  ]) {
    it(`rejects a missing ${field} (proof field)`, () => {
      expect(() => toMembershipRow(membership({ [field]: undefined }))).toThrow()
    })
  }
  it('rejects a non-integer creationLedger', () => {
    expect(() => toMembershipRow(membership({ creationLedger: '100' }))).toThrow()
  })
  it('parseMembershipRow returns null for a missing row', () => {
    expect(parseMembershipRow(null)).toBeNull()
  })
})

describe('toRunAllocationRow / parseRunAllocationRow', () => {
  it('shapes a valid record and round-trips the amount as a decimal string', () => {
    const row = toRunAllocationRow(allocation({ units: '18446744073709551616.000000001' }))
    expect(row.units).toBe('18446744073709551616.000000001')
    expect(typeof row.units).toBe('string')
    const parsed = parseRunAllocationRow({
      id: row.id,
      network_id: row.network_id,
      run_id: row.run_id,
      owner_address: row.owner_address,
      bridge_agent_address: row.bridge_agent_address,
      base_child_address: row.base_child_address,
      token: row.token,
      units: row.units,
      decimals: row.decimals,
      proxy_target: row.proxy_target,
      job_id: row.job_id,
      tx_id: row.tx_id,
      execution_status: row.execution_status,
      custody_location: row.custody_location,
      created_at: 1000,
      updated_at: 1000,
    })
    expect(parsed.amount).toEqual({
      token: 'USDC',
      units: '18446744073709551616.000000001',
      decimals: 6,
    })
  })
  it('rejects a non-decimal-string units value', () => {
    expect(() => toRunAllocationRow(allocation({ units: 'abc' }))).toThrow()
    expect(() => toRunAllocationRow(allocation({ units: 1000000 }))).toThrow()
  })
  it('rejects an unknown executionStatus', () => {
    expect(() => toRunAllocationRow(allocation({ executionStatus: 'done' }))).toThrow(
      /executionStatus/
    )
  })
  it('rejects an unknown custodyLocation', () => {
    expect(() => toRunAllocationRow(allocation({ custodyLocation: 'cold-wallet' }))).toThrow(
      /custodyLocation/
    )
  })
  it('parseRunAllocationRow returns null for a missing row', () => {
    expect(parseRunAllocationRow(null)).toBeNull()
  })
})

describe('toAssociationRow / parseAssociationRow', () => {
  const association = {
    allocationId: 'run-1:bridge:aave-v3',
    networkId: 'stellar-testnet',
    runId: 'run-1',
    ownerAddress: 'GOWNER1',
    bridgeAgentAddress: 'CAGENT1',
    poolAddress: '0xpool',
    amount: { token: 'USDC', units: '1000000', decimals: 6 },
    proxyTarget: 'aave-v3',
    baseJobId: 'job-1',
    txHash: null,
    executionStatus: 'accepted',
    custodyLocation: 'in-transit',
    grantTxHash: 'grant-1',
    kernelAddress: '0xkernel',
    mandateBindingId: 'binding-1',
    mandateBindingHash: 'binding-hash-1',
    associationSource: 'relayer-attested',
    reportedAt: 1000,
    scopeCheckedAt: 999,
  }

  it('round-trips the complete relayer attestation without inventing evidence', () => {
    const row = toAssociationRow(association)
    const parsed = parseAssociationRow({
      id: row.id,
      network_id: row.network_id,
      run_id: row.run_id,
      owner_address: row.owner_address,
      bridge_agent_address: row.bridge_agent_address,
      base_child_address: row.base_child_address,
      token: row.token,
      units: row.units,
      decimals: row.decimals,
      proxy_target: row.proxy_target,
      job_id: row.job_id,
      tx_id: row.tx_id,
      execution_status: row.execution_status,
      custody_location: row.custody_location,
      grant_tx_hash: row.grant_tx_hash,
      kernel_address: row.kernel_address,
      mandate_binding_id: row.mandate_binding_id,
      mandate_binding_hash: row.mandate_binding_hash,
      association_source: row.association_source,
      reported_at: row.reported_at,
      scope_checked_at: row.scope_checked_at,
      created_at: 900,
      updated_at: 1000,
    })
    expect(parsed).toEqual({ ...association, createdAt: 900, updatedAt: 1000 })
    expect(parsed.txHash).toBeNull()
  })

  it('rejects missing binding/timestamp fields and unsupported association sources', () => {
    expect(() => toAssociationRow({ ...association, mandateBindingId: null })).toThrow(/binding/i)
    expect(() => toAssociationRow({ ...association, scopeCheckedAt: null })).toThrow(
      /scopeCheckedAt/
    )
    expect(() => toAssociationRow({ ...association, associationSource: 'browser' })).toThrow(
      /associationSource/
    )
  })
})

describe('toGapRow / parseGapRow', () => {
  it('shapes a valid gap', () => {
    const row = toGapRow({
      sourceId: 'stellar-testnet:CROUTER1',
      networkId: 'stellar-testnet',
      fromLedger: 10,
      throughLedger: 20,
      reason: 'rpc-timeout',
    })
    expect(row).toEqual({
      source_id: 'stellar-testnet:CROUTER1',
      network_id: 'stellar-testnet',
      from_ledger: 10,
      through_ledger: 20,
      reason: 'rpc-timeout',
    })
  })
  it('rejects throughLedger < fromLedger', () => {
    expect(() =>
      toGapRow({ sourceId: 's', networkId: 'n', fromLedger: 20, throughLedger: 10, reason: 'x' })
    ).toThrow(/throughLedger/)
  })
  it('parseGapRow round-trips a DB row', () => {
    const parsed = parseGapRow({
      id: 1,
      source_id: 's',
      network_id: 'n',
      from_ledger: 10,
      through_ledger: 20,
      reason: 'rpc-timeout',
      status: 'open',
      opened_at: 1000,
      closed_at: null,
    })
    expect(parsed).toEqual({
      id: 1,
      sourceId: 's',
      networkId: 'n',
      fromLedger: 10,
      throughLedger: 20,
      reason: 'rpc-timeout',
      status: 'open',
      openedAt: 1000,
      closedAt: null,
    })
  })
})

describe('toBackfillAuditRow / parseBackfillAuditRow', () => {
  it('shapes a valid audit and stringifies evidence', () => {
    const row = toBackfillAuditRow({
      networkId: 'n',
      sourceId: 's',
      method: 'horizon-tx-scan',
      result: 'verified',
      fromLedger: 1,
      throughLedger: 100,
      evidence: { txCount: 3 },
    })
    expect(row.evidence).toBe(JSON.stringify({ txCount: 3 }))
    expect(row.result).toBe('verified')
  })
  it('rejects an unknown result', () => {
    expect(() =>
      toBackfillAuditRow({
        networkId: 'n',
        sourceId: 's',
        method: 'm',
        result: 'pending',
        fromLedger: 1,
        throughLedger: 2,
      })
    ).toThrow(/result/)
  })
  it('rejects throughLedger < fromLedger', () => {
    expect(() =>
      toBackfillAuditRow({
        networkId: 'n',
        sourceId: 's',
        method: 'm',
        result: 'verified',
        fromLedger: 100,
        throughLedger: 1,
      })
    ).toThrow()
  })
  it('parseBackfillAuditRow returns null for a missing row', () => {
    expect(parseBackfillAuditRow(null)).toBeNull()
  })
})

describe('parseSourceRow', () => {
  it('round-trips a DB row into camelCase', () => {
    const row = {
      source_id: 'stellar-testnet:CROUTER1',
      network_id: 'stellar-testnet',
      creator_address: 'CROUTER1',
      manifest_hash: '0xabc',
      manifest_version: 'v1',
      schema_version: 1,
      indexed_from_ledger: 100,
      indexed_through_ledger: 99,
      finalized_through_ledger: 99,
      cursor: null,
      status: 'ok',
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
    }
    expect(parseSourceRow(row)).toEqual({
      sourceId: 'stellar-testnet:CROUTER1',
      networkId: 'stellar-testnet',
      creatorAddress: 'CROUTER1',
      manifestHash: '0xabc',
      manifestVersion: 'v1',
      schemaVersion: 1,
      indexedFromLedger: 100,
      indexedThroughLedger: 99,
      finalizedThroughLedger: 99,
      cursor: null,
      status: 'ok',
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      providerId: null,
      endpointClass: null,
      reportedOldestLedger: null,
      reportedLatestLedger: null,
    })
  })
  it('round-trips the 0003_agent_index_bounds.sql provider-identity/reported-bound columns', () => {
    const row = {
      source_id: 'stellar-testnet:CROUTER1',
      network_id: 'stellar-testnet',
      creator_address: 'CROUTER1',
      manifest_hash: '0xabc',
      manifest_version: 'v1',
      schema_version: 1,
      indexed_from_ledger: 100,
      indexed_through_ledger: 5000,
      finalized_through_ledger: 4998,
      cursor: null,
      status: 'ok',
      last_success_at: 1,
      last_error_at: null,
      last_error_message: null,
      provider_id: 'soroban-rpc',
      endpoint_class: 'live',
      reported_oldest_ledger: 1,
      reported_latest_ledger: 5002,
    }
    expect(parseSourceRow(row)).toMatchObject({
      providerId: 'soroban-rpc',
      endpointClass: 'live',
      reportedOldestLedger: 1,
      reportedLatestLedger: 5002,
    })
  })
  it('returns null for a missing row', () => {
    expect(parseSourceRow(null)).toBeNull()
  })
})

describe('enum vocabularies', () => {
  it('are non-empty and stable', () => {
    expect(AGENT_KINDS).toEqual(['deposit', 'bridge', 'unknown'])
    expect(CUSTODY_LOCATIONS).toEqual([
      'owner',
      'agent',
      'stellar-vault',
      'in-transit',
      'base-proxy',
      'unknown',
    ])
    expect(EXECUTION_STATUSES).toContain('queued')
    expect(EXECUTION_STATUSES).toContain('failed')
    expect(BACKFILL_RESULTS).toEqual(['verified', 'failed'])
  })
})
