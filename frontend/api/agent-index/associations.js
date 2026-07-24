const EXECUTION_STATUSES = [
  'queued',
  'accepted',
  'burn-confirmed',
  'minted',
  'deposited',
  'held',
  'failed',
]
const CUSTODY_LOCATIONS = [
  'owner',
  'agent',
  'stellar-vault',
  'in-transit',
  'base-proxy',
  'unknown',
]
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

function requiredString(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`)
  return value
}

function requiredInteger(value, field) {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`)
  return value
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
  if (!allocation || typeof allocation !== 'object') throw new Error('allocation is required')
  for (const field of Object.keys(allocation)) {
    if (!ALLOCATION_FIELDS.has(field)) throw new Error(`unexpected allocation field: ${field}`)
  }
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
  const amount = allocation.amount
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
  if (failed) throw new Error(`live bridge scope ${failed[0]} does not cover the association report`)
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
    throw new Error('allocation identity cannot change owner, run, bridge, pool, kernel, or binding')
  }
}

function validateMonotonic(existing, allocation) {
  const before = existing.executionStatus
  const after = allocation.executionStatus
  if (TERMINAL_STATUSES.has(before) && before !== after) {
    throw new Error('terminal association evidence cannot change')
  }
  if ((STATUS_RANK.get(after) ?? -1) < (STATUS_RANK.get(before) ?? -1)) {
    throw new Error('association evidence cannot regress')
  }
  if (existing.txHash && allocation.txHash && existing.txHash !== allocation.txHash) {
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
  validateAllocation(allocation, poolTargets, scopeRequirements)
  const expectedKey = associationIdempotencyKey(report, allocation)
  if (idempotencyKey !== expectedKey) throw new Error('idempotency key does not match report tuple')
  const existing = await store.readRunAllocation({
    networkId: report.networkId,
    allocationId: allocation.allocationId,
  })
  const hasAssociationProof = existing?.associationSource === 'relayer-attested'
  if (hasAssociationProof) {
    validateImmutable(existing, report, allocation)
    validateMonotonic(existing, allocation)
  }
  if (await store.hasAssociationEvent({ idempotencyKey })) {
    return { written: 0, duplicates: 1 }
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
    if (!membership || membership.owner !== report.owner) {
      throw new Error('bridge agent is not an indexed membership for this owner')
    }
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
  await store.commitAssociation({ association, idempotencyKey })
  return { written: 1, duplicates: 0 }
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
        poolAddress: row.poolAddress,
        proxyTarget: row.proxyTarget,
        amount: row.amount,
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
