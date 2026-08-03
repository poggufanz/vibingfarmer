import { RECOVERY_REASON_CODES, selectRecoveryAction } from '../../api/agent-index/recovery.js'

const RECEIPT_TO_UI_CUSTODY = new Map([
  ['owner', 'owner'],
  ['stellar-agent', 'agent'],
  ['stellar-vault', 'stellar-vault'],
  ['cctp-transit', 'in-transit'],
  ['base-kernel', 'agent'],
  ['base-vault', 'base-proxy'],
  ['unknown', 'unknown'],
])

function malformedCustody(receipt, detail) {
  return {
    location: 'unknown',
    confirmed: false,
    amount: null,
    source: 'unmapped',
    reason: `receipt custody for allocation "${receipt.allocationId}" is malformed or unmapped (${detail})`,
  }
}

function projectCustody(receipt) {
  const custody = receipt?.custody
  const location = RECEIPT_TO_UI_CUSTODY.get(custody?.location)
  if (location === undefined) return malformedCustody(receipt, `location=${custody?.location}`)
  if (typeof custody.confirmed !== 'boolean') {
    return malformedCustody(receipt, 'confirmed must be boolean')
  }
  if (custody.reason != null && typeof custody.reason !== 'string') {
    return malformedCustody(receipt, 'reason must be a string or null')
  }
  const amount = custody.amount
  if (
    amount != null &&
    (typeof amount.token !== 'string' ||
      typeof amount.units !== 'string' ||
      !/^\d+$/.test(amount.units) ||
      !Number.isInteger(amount.decimals) ||
      amount.decimals < 0)
  ) {
    return malformedCustody(receipt, 'amount must preserve exact integer-string units')
  }
  if (custody.location === 'unknown' && (custody.confirmed || amount != null)) {
    return malformedCustody(receipt, 'unknown custody cannot be confirmed or carry an amount')
  }
  return {
    location,
    confirmed: custody.confirmed,
    amount:
      amount == null
        ? null
        : { token: amount.token, units: amount.units, decimals: amount.decimals },
    reason: custody.reason ?? null,
    source: 'receipt',
  }
}

function baseDisplay(baseResult, strandedBridge) {
  if (!baseResult) return null
  return {
    allocationId: baseResult.allocationId,
    jobId: baseResult.jobId ?? null,
    strandedFunds:
      strandedBridge?.pulled === true
        ? {
            pulled: true,
            bridgeAgentAddress: strandedBridge.bridgeAgentAddress ?? null,
          }
        : null,
    authorization: 'display-only',
  }
}

/** Pure evidence-first projection. Base-leg result fields are display-only and never affect action. */
export function projectRecoveryReceipt({
  receipt,
  version,
  identity,
  baseResult = null,
  strandedBridge = null,
}) {
  const selected = selectRecoveryAction(receipt)
  const decision =
    receipt == null && baseResult
      ? {
          action: 'blocked-reconcile',
          phase: null,
          reasonCode: RECOVERY_REASON_CODES.BASE_EVIDENCE_UNAVAILABLE,
          reason:
            'a Base child result exists but no durable Base execution receipt producer records ' +
            'the nonce, attestation, or UserOperation evidence required for automated recovery',
        }
      : selected
  const rowVersion = version ?? receipt?.version ?? 0
  if (!Number.isSafeInteger(rowVersion) || rowVersion < 0) {
    throw new Error('projectRecoveryReceipt: version must be a non-negative safe integer')
  }
  if (receipt && receipt.version !== rowVersion) {
    throw new Error('projectRecoveryReceipt: receipt/version mismatch')
  }
  const sourceIdentity = receipt ?? identity
  if (!sourceIdentity?.executionId || !sourceIdentity?.allocationId) {
    throw new Error('projectRecoveryReceipt: executionId and allocationId are required')
  }
  const recoveryChildId = receipt ? (receipt.childId ?? null) : null
  const displayChildId = receipt ? recoveryChildId : baseResult ? (identity?.childId ?? null) : null
  return {
    ...decision,
    version: rowVersion,
    receipt,
    custody: receipt ? projectCustody(receipt) : null,
    requestIdentity: {
      executionId: sourceIdentity.executionId,
      allocationId: sourceIdentity.allocationId,
      ...(recoveryChildId == null || recoveryChildId === '' ? {} : { childId: recoveryChildId }),
      expectedReceiptVersion: rowVersion,
    },
    route: {
      allocationId: baseResult?.allocationId ?? sourceIdentity.allocationId,
      parentAllocationId: sourceIdentity.parentAllocationId ?? null,
      childId: displayChildId,
      jobId: baseResult?.jobId ?? null,
      source: baseResult ? 'base-child-result' : receipt ? 'receipt' : 'request',
    },
    baseDisplay: baseDisplay(baseResult, strandedBridge),
  }
}
