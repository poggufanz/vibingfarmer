import {
  RECOVERY_REASON_CODES,
  selectBaseChildRecoveryAction,
  selectRecoveryAction,
} from '../../api/agent-index/recovery.js'
import { requireBaseRecoveryIdentity } from './baseRecoveryIdentity.js'

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

const BASE_PHASES = Object.freeze(['cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit'])
const BASE_PUBLIC_EVIDENCE = new Set([
  'burnTxHash',
  'expectationDigest',
  'burnUnits7',
  'messageDigest',
  'messageHash',
  'attestationDigest',
  'attestationHash',
  'evidenceVersion',
  'nonce',
  'mintTxHash',
  'userOpHash',
  'transactionHash',
  'blockNumber',
  'blockHash',
  'chainId',
  'kernelAddress',
  'yieldRouterAddress',
  'yieldRouter',
  'caller',
  'poolAddress',
  'assets',
  'minShares',
  'shares',
  'entryPoint',
  'sender',
  'startBlock',
  'reasonCode',
  'custodyLocation',
  'kernelCustodyConfirmed',
])
const BASE_PUBLIC_EVENT = new Set([
  'address',
  'topic0',
  'logIndex',
  'caller',
  'poolAddress',
  'assets',
  'shares',
])

function projectExactBaseObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!fields.has(key)) continue
    if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) {
      output[key] = entry
    }
  }
  return output
}

function projectBaseEvidence(value) {
  const output = projectExactBaseObject(value, BASE_PUBLIC_EVIDENCE) || {}
  const event = projectExactBaseObject(value?.event, BASE_PUBLIC_EVENT)
  if (event) output.event = event
  if (
    value?.custody &&
    typeof value.custody === 'object' &&
    !Array.isArray(value.custody) &&
    typeof value.custody.location === 'string' &&
    typeof value.custody.confirmed === 'boolean'
  ) {
    output.custody = {
      location: value.custody.location,
      confirmed: value.custody.confirmed,
    }
  }
  return output
}

function projectedBasePhases(bundle) {
  const rows = Array.isArray(bundle?.phases)
    ? bundle.phases
    : bundle?.phases && typeof bundle.phases === 'object'
      ? BASE_PHASES.map((phase) => bundle.phases[phase]).filter(Boolean)
      : []
  const output = {}
  for (const row of rows) {
    if (!BASE_PHASES.includes(row?.phase) || output[row.phase]) continue
    output[row.phase] = {
      state: typeof row.state === 'string' ? row.state : 'unknown',
      eventId: typeof row.eventId === 'string' ? row.eventId : null,
      recoveryVersion: Number.isSafeInteger(row.recoveryVersion) ? row.recoveryVersion : null,
      observedAt:
        typeof row.observedAt === 'string' || Number.isSafeInteger(row.observedAt)
          ? row.observedAt
          : null,
      evidence: projectBaseEvidence(row.evidence),
    }
  }
  return output
}

function baseCustody(decision, phases) {
  const burn = phases.cctp_burn
  const mint = phases.cctp_mint
  const deposit = phases.base_deposit
  const depositEvidence = deposit?.evidence || {}
  if (decision.action === 'complete') {
    return {
      location: 'base-proxy',
      confirmed: true,
      userOpHash: depositEvidence.userOpHash ?? null,
      transactionHash: depositEvidence.transactionHash ?? null,
      assets: depositEvidence.assets ?? null,
      shares: depositEvidence.shares ?? null,
    }
  }
  if (
    decision.action === 'owner-action-required' ||
    mint?.state === 'confirmed' ||
    deposit != null
  ) {
    return {
      location: 'base-kernel',
      confirmed: decision.action === 'owner-action-required' || mint?.state === 'confirmed',
      mintTxHash: mint?.evidence?.mintTxHash ?? null,
      transactionHash: depositEvidence.transactionHash ?? null,
    }
  }
  if (burn?.state === 'confirmed') {
    return {
      location: 'cctp-transit',
      confirmed: decision.action !== 'manual-review',
      burnTxHash: burn.evidence?.burnTxHash ?? null,
    }
  }
  return { location: 'unknown', confirmed: false }
}

/**
 * Base-only, secret-free UI projection. The pure Agent Index selector remains the sole source of
 * action truth; this function only copies an allowlisted display subset and never a claim token or
 * private bundle.
 */
export function projectBaseRecoveryBundle(bundle) {
  const identity = requireBaseRecoveryIdentity(bundle?.identity)
  const decision = selectBaseChildRecoveryAction(bundle)
  const version =
    Number.isSafeInteger(bundle?.recoveryVersion) && bundle.recoveryVersion >= 0
      ? bundle.recoveryVersion
      : 0
  const phases = projectedBasePhases(bundle)
  return {
    ...decision,
    identity,
    version,
    phases,
    custody: baseCustody(decision, phases),
  }
}
