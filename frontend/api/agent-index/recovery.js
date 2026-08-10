// Browser-safe, pure recovery decision table. Server authentication and lease claiming live in
// handler.js so client code can import this module without Node builtins or polyfills.

const BASE_CUSTODY_LOCATIONS = new Set(['cctp-transit', 'base-kernel', 'base-vault'])
const BASE_ONLY_PHASES = ['cctp_burn', 'cctp_mint', 'base_deposit']
const V3_EXECUTION_ID = /^0x[0-9a-f]{64}$/

export const RECOVERY_REASON_CODES = Object.freeze({
  NO_RECEIPT: 'no-receipt',
  BASE_EVIDENCE_UNAVAILABLE: 'base-evidence-unavailable',
  CUSTODY_EVIDENCE_GAP: 'custody-evidence-gap',
  CONTRADICTORY_STELLAR_EVIDENCE: 'contradictory-stellar-evidence',
  PULL_NOT_STARTED: 'pull-not-started',
  PULL_FAILED: 'pull-failed',
  PULL_V3_UNCERTAIN: 'pull-v3-uncertain',
  PULL_V2_UNCERTAIN: 'pull-v2-uncertain',
  PULL_STATUS_UNRECOGNIZED: 'pull-status-unrecognized',
  DEPOSIT_CONFIRMED: 'deposit-confirmed',
  DEPOSIT_NOT_STARTED: 'deposit-not-started',
  DEPOSIT_FAILED: 'deposit-failed',
  DEPOSIT_UNCERTAIN: 'deposit-uncertain',
  DEPOSIT_STATUS_UNRECOGNIZED: 'deposit-status-unrecognized',
})

function lastAttemptForPhase(attempts, phase) {
  const list = Array.isArray(attempts) ? attempts : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.phase === phase) return list[i]
  }
  return null
}

/**
 * Pure and total: decides the one safe next action from durable receipt evidence alone.
 * @param {object|null} receipt parsed execution receipt, or null when none has been persisted
 * @returns {{action:string, phase:('pull'|'stellar_deposit'|null), reasonCode:string, reason:string}}
 */
export function selectRecoveryAction(receipt) {
  if (receipt == null) {
    return {
      action: 'pull',
      phase: 'pull',
      reasonCode: RECOVERY_REASON_CODES.NO_RECEIPT,
      reason:
        'no execution receipt exists yet for this execution/allocation/owner; nothing has ever ' +
        'been submitted, so exactly one pull is permitted',
    }
  }

  const phases = receipt.phases || {}
  const custody = receipt.custody || {}
  const baseTouched =
    BASE_CUSTODY_LOCATIONS.has(custody.location) ||
    BASE_ONLY_PHASES.some((phase) => phases[phase] && phases[phase] !== 'not_started')

  if (baseTouched) {
    return {
      action: 'blocked-reconcile',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.BASE_EVIDENCE_UNAVAILABLE,
      reason:
        'Base leg evidence is present (custody past the Stellar bridge agent, or CCTP burn/mint ' +
        'or Base deposit phase activity) but no durable producer for the CCTP nonce, the ' +
        'attestation message, or the Base UserOperation/vault-event state exists anywhere in this ' +
        "codebase (operator ruling S2-D8); recovery must go through baseLeg.js's stranded-funds " +
        'path, not this selector',
    }
  }

  if (custody.confirmed !== true || custody.location === 'unknown') {
    return {
      action: 'manual-review',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.CUSTODY_EVIDENCE_GAP,
      reason:
        `custody evidence is unconfirmed or unknown (location=${custody.location ?? 'unknown'}` +
        `${custody.reason ? `, reason=${custody.reason}` : ''}); any evidence gap blocks ` +
        'automated recovery',
    }
  }

  // `pull:confirmed` is independently authoritative because the producer persists it before its
  // trailing stellar-agent custody update. This closes that crash window without another pull.
  const fundsLeftOwner = custody.location !== 'owner' || phases.pull === 'confirmed'

  // Later-phase activity contradicts evidence that funds never left the owner. Fail closed before
  // the pull branch: authorizing another pull could move money twice if the later phase is right.
  if (!fundsLeftOwner && phases.stellar_deposit !== 'not_started') {
    return {
      action: 'manual-review',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.CONTRADICTORY_STELLAR_EVIDENCE,
      reason:
        `stellar_deposit is ${phases.stellar_deposit ?? 'missing'} while pull is ` +
        `${phases.pull ?? 'missing'} and custody is still confirmed at owner; later-phase ` +
        'evidence contradicts the pre-movement state',
    }
  }

  if (!fundsLeftOwner) {
    switch (phases.pull) {
      case 'not_started':
        return {
          action: 'pull',
          phase: 'pull',
          reasonCode: RECOVERY_REASON_CODES.PULL_NOT_STARTED,
          reason:
            'receipt exists but no pull has ever been attempted; exactly one pull is permitted',
        }
      case 'failed':
        return {
          action: 'pull',
          phase: 'pull',
          reasonCode: RECOVERY_REASON_CODES.PULL_FAILED,
          reason:
            'the previous pull attempt failed before any money moved and custody is still ' +
            'confirmed at owner; a fresh pull is safe',
        }
      case 'submitted':
      case 'unknown': {
        const lastPull = lastAttemptForPhase(receipt.attempts, 'pull')
        const v3ExecutionId = lastPull?.evidence?.v3ExecutionId
        if (typeof v3ExecutionId === 'string' && V3_EXECUTION_ID.test(v3ExecutionId)) {
          return {
            action: 'resubmit-identical-envelope',
            phase: 'pull',
            reasonCode: RECOVERY_REASON_CODES.PULL_V3_UNCERTAIN,
            reason:
              'the pending pull attempt carries a valid durable v3ExecutionId, proving it went ' +
              'through pull_v3; resending the identical envelope is safe',
          }
        }
        return {
          action: 'poll',
          phase: 'pull',
          reasonCode: RECOVERY_REASON_CODES.PULL_V2_UNCERTAIN,
          reason:
            'the pull outcome is unconfirmed and carries no valid v3ExecutionId; the deployed V2 ' +
            'router has no replay protection, so resending could move money twice',
        }
      }
      default:
        return {
          action: 'manual-review',
          phase: null,
          reasonCode: RECOVERY_REASON_CODES.PULL_STATUS_UNRECOGNIZED,
          reason: `unrecognized pull phase status "${phases.pull}"`,
        }
    }
  }

  // Deposit confirmation is authoritative even when the producer's final vault custody write has
  // not landed. Uncertain deposits only poll because deposit idempotency is not established.
  if (phases.stellar_deposit === 'confirmed') {
    return {
      action: 'complete',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.DEPOSIT_CONFIRMED,
      reason: 'the deposit phase is confirmed; execution is terminal',
    }
  }
  if (custody.location === 'stellar-vault') {
    return {
      action: 'manual-review',
      phase: null,
      reasonCode: RECOVERY_REASON_CODES.CONTRADICTORY_STELLAR_EVIDENCE,
      reason:
        'custody claims stellar-vault but the deposit phase is not confirmed; evidence is ' +
        'contradictory',
    }
  }

  switch (phases.stellar_deposit) {
    case 'not_started':
      return {
        action: 'deposit',
        phase: 'stellar_deposit',
        reasonCode: RECOVERY_REASON_CODES.DEPOSIT_NOT_STARTED,
        reason: 'the agent holds custody and no deposit has been attempted yet',
      }
    case 'failed':
      return {
        action: 'deposit',
        phase: 'stellar_deposit',
        reasonCode: RECOVERY_REASON_CODES.DEPOSIT_FAILED,
        reason:
          'the previous deposit attempt failed while funds remain with the agent; retrying the ' +
          'deposit does not re-move money',
      }
    case 'submitted':
    case 'unknown':
      return {
        action: 'poll',
        phase: 'stellar_deposit',
        reasonCode: RECOVERY_REASON_CODES.DEPOSIT_UNCERTAIN,
        reason:
          'the deposit outcome is unconfirmed and deposit idempotency is not established; fail ' +
          'closed to poll rather than resubmit',
      }
    default:
      return {
        action: 'manual-review',
        phase: null,
        reasonCode: RECOVERY_REASON_CODES.DEPOSIT_STATUS_UNRECOGNIZED,
        reason: `unrecognized stellar_deposit phase status "${phases.stellar_deposit}"`,
      }
  }
}

/**
 * Base recovery deliberately has its own vocabulary.  In particular, a Base child must never be
 * handed to the Stellar selector (where an absent receipt is allowed to pull once).  The selector
 * below is pure and total: malformed, legacy, contradictory, or future evidence always maps to the
 * closed manual-review result instead of throwing into an optimistic caller.
 */
export const BASE_RECOVERY_REASON_CODES = Object.freeze({
  NO_MOVEMENT: 'base-no-movement',
  BURN_REVERTED: 'base-burn-reverted',
  ATTESTATION_PENDING: 'base-attestation-pending',
  ATTESTATION_CONFIRMED: 'base-attestation-confirmed',
  MINT_PENDING: 'base-mint-pending',
  MINT_CONFIRMED: 'base-mint-confirmed',
  DEPOSIT_PENDING: 'base-deposit-pending',
  DEPOSIT_FAILED_KERNEL_CUSTODY: 'base-deposit-failed-kernel-custody',
  DEPOSIT_CONFIRMED: 'base-deposit-confirmed',
  MANUAL_REVIEW: 'base-manual-review',
  OWNER_ACTION_REQUIRED: 'base-owner-action-required',
})

const BASE_SELECTOR_PHASES = ['cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit']
const BASE_SELECTOR_OPTIONAL_PROJECTION_PHASES = [...BASE_SELECTOR_PHASES, 'base_position']
const BASE_SELECTOR_STATES = [
  'submitting',
  'submitted',
  'confirmed',
  'failed',
  'unknown',
  'blocked',
]
const BASE_SELECTOR_TOP_LEVEL = new Set([
  'schemaVersion',
  'identity',
  'owner',
  'agent',
  'recoverable',
  'recoveryVersion',
  'intent',
  'phases',
  'events',
])
const BASE_SELECTOR_IDENTITY = new Set([
  'networkId',
  'bindingId',
  'executionId',
  'allocationId',
  'childId',
])
const BASE_SELECTOR_INTENT = new Set([
  'runId',
  'grantTxHash',
  'bindingHash',
  'baseJobId',
  'kernelAddress',
  'poolAddress',
  'proxyTarget',
  'token',
  'units',
  'decimals',
  'minShares',
])
const BASE_SELECTOR_EVENT_FIELDS = new Set([
  'eventId',
  'identity',
  'owner',
  'agent',
  'recoveryVersion',
  'phase',
  'state',
  'evidence',
  'observedAt',
])
const BASE_SELECTOR_PROJECTION_FIELDS = new Set([
  'eventId',
  'identity',
  'owner',
  'agent',
  'recoveryVersion',
  'phase',
  'state',
  'evidence',
  'observedAt',
])
const BASE_SELECTOR_EVIDENCE_FIELDS = new Map([
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
      'messageHash',
      'attestationDigest',
      'attestationHash',
      'evidenceVersion',
      'nonce',
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
      'yieldRouter',
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
const BASE_SELECTOR_EVENT_EVIDENCE_FIELDS = new Set([
  'address',
  'topic0',
  'logIndex',
  'caller',
  'poolAddress',
  'assets',
  'shares',
])
const BASE_SELECTOR_CUSTODY_FIELDS = new Set(['location', 'confirmed'])
const BASE_SELECTOR_HEX32 = /^0x[0-9a-f]{64}$/
const BASE_SELECTOR_BARE32 = /^[0-9a-f]{64}$/
const BASE_SELECTOR_ADDRESS = /^0x[0-9a-f]{40}$/
const BASE_SELECTOR_UNSIGNED = /^(0|[1-9]\d*)$/
const BASE_SELECTOR_ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032'
const BASE_SELECTOR_RECONCILE_HANDLE_FIELDS = new Set([
  'entryPoint',
  'sender',
  'nonce',
  'startBlock',
])

function baseSelectorObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function baseSelectorExact(value, fields, required = []) {
  if (!baseSelectorObject(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => !fields.has(key))) return false
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function baseSelectorString(value) {
  return typeof value === 'string' && value.length > 0
}

function baseSelectorInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function baseSelectorEvidenceInteger(value) {
  return (
    baseSelectorInteger(value) || (typeof value === 'string' && BASE_SELECTOR_UNSIGNED.test(value))
  )
}

function baseSelectorUnsigned(value, positive = false) {
  return (
    typeof value === 'string' && BASE_SELECTOR_UNSIGNED.test(value) && (!positive || value !== '0')
  )
}

function baseSelectorHex(value, { bare = false } = {}) {
  return (
    typeof value === 'string' &&
    (bare ? BASE_SELECTOR_BARE32.test(value) : BASE_SELECTOR_HEX32.test(value))
  )
}

function baseSelectorAddress(value) {
  return typeof value === 'string' && BASE_SELECTOR_ADDRESS.test(value)
}

function baseSelectorValidateReconcileHandle(value, caller) {
  return (
    baseSelectorExact(value, BASE_SELECTOR_RECONCILE_HANDLE_FIELDS, [
      'entryPoint',
      'sender',
      'nonce',
      'startBlock',
    ]) &&
    value.entryPoint === BASE_SELECTOR_ENTRY_POINT &&
    baseSelectorAddress(value.entryPoint) &&
    baseSelectorAddress(value.sender) &&
    value.sender !== `0x${'00'.repeat(20)}` &&
    value.sender === caller &&
    typeof value.nonce === 'string' &&
    BASE_SELECTOR_UNSIGNED.test(value.nonce) &&
    typeof value.startBlock === 'string' &&
    BASE_SELECTOR_UNSIGNED.test(value.startBlock)
  )
}

function baseSelectorSameIdentity(left, right) {
  return (
    baseSelectorObject(left) &&
    baseSelectorObject(right) &&
    [...BASE_SELECTOR_IDENTITY].every((field) => left[field] === right[field])
  )
}

function baseSelectorEqualJson(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function baseSelectorManual() {
  return {
    action: 'manual-review',
    phase: null,
    reasonCode: BASE_RECOVERY_REASON_CODES.MANUAL_REVIEW,
  }
}

function baseSelectorAction(action, phase, reasonCode) {
  return { action, phase, reasonCode }
}

function baseSelectorValidateNestedEvidence(value, fields, required = []) {
  if (!baseSelectorExact(value, fields, required)) return false
  for (const [key, entry] of Object.entries(value)) {
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      return false
    }
    if (['address', 'caller', 'poolAddress'].includes(key) && !baseSelectorAddress(entry))
      return false
    if (key === 'topic0' && !baseSelectorHex(entry)) return false
    if (['assets', 'shares'].includes(key) && !baseSelectorUnsigned(entry)) return false
    if (key === 'logIndex' && !baseSelectorEvidenceInteger(entry)) return false
  }
  return true
}

function baseSelectorValidateEvidence(phase, state, evidence) {
  const fields = BASE_SELECTOR_EVIDENCE_FIELDS.get(phase)
  if (!fields || !baseSelectorObject(evidence)) return false
  if (Object.keys(evidence).some((key) => !fields.has(key))) return false
  for (const [key, entry] of Object.entries(evidence)) {
    if (key === 'event') {
      if (
        !baseSelectorValidateNestedEvidence(entry, BASE_SELECTOR_EVENT_EVIDENCE_FIELDS, [
          'address',
          'topic0',
          'logIndex',
          'caller',
          'poolAddress',
          'assets',
          'shares',
        ])
      )
        return false
      continue
    }
    if (key === 'custody') {
      if (!baseSelectorExact(entry, BASE_SELECTOR_CUSTODY_FIELDS, ['location', 'confirmed']))
        return false
      if (!baseSelectorString(entry.location) || typeof entry.confirmed !== 'boolean') return false
      continue
    }
    if (key === 'reconcileHandle') {
      if (!baseSelectorValidateReconcileHandle(entry, evidence.caller)) return false
      continue
    }
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      return false
    }
    if (
      ['yieldRouterAddress', 'yieldRouter', 'kernelAddress', 'caller', 'poolAddress'].includes(
        key
      ) &&
      !baseSelectorAddress(entry)
    )
      return false
    if (
      ['burnTxHash', 'expectationDigest'].includes(key) &&
      !baseSelectorHex(entry, { bare: true })
    )
      return false
    if (
      [
        'messageDigest',
        'messageHash',
        'attestationDigest',
        'attestationHash',
        'mintTxHash',
        'transactionHash',
        'blockHash',
        'userOpHash',
      ].includes(key)
    ) {
      if (!baseSelectorHex(entry)) return false
    }
    if (
      ['burnUnits7', 'amount', 'units', 'assets', 'minShares', 'shares'].includes(key) &&
      !baseSelectorUnsigned(entry)
    )
      return false
    if (key === 'nonce' && !(baseSelectorHex(entry) || baseSelectorUnsigned(entry))) return false
    if (
      [
        'decimals',
        'destinationDomain',
        'evidenceVersion',
        'blockNumber',
        'chainId',
        'startBlock',
      ].includes(key) &&
      !baseSelectorEvidenceInteger(entry)
    )
      return false
    if (key === 'kernelCustodyConfirmed' && typeof entry !== 'boolean') return false
    if (key === 'reasonCode' && !baseSelectorString(entry)) return false
    if (key === 'custodyLocation' && !baseSelectorString(entry)) return false
  }
  if (state === 'confirmed' && phase === 'cctp_burn') {
    return (
      baseSelectorHex(evidence.burnTxHash, { bare: true }) &&
      baseSelectorHex(evidence.expectationDigest, { bare: true }) &&
      baseSelectorUnsigned(evidence.burnUnits7, true) &&
      baseSelectorHex(evidence.messageDigest) &&
      (baseSelectorHex(evidence.nonce) || baseSelectorUnsigned(evidence.nonce))
    )
  }
  if (phase === 'cctp_attestation') {
    if (
      !baseSelectorHex(evidence.burnTxHash, { bare: true }) ||
      !baseSelectorHex(evidence.expectationDigest, { bare: true })
    )
      return false
    if (
      !baseSelectorHex(evidence.messageDigest) ||
      !(baseSelectorHex(evidence.nonce) || baseSelectorUnsigned(evidence.nonce))
    )
      return false
    if (state === 'confirmed') return baseSelectorHex(evidence.attestationDigest)
    return true
  }
  if (phase === 'cctp_mint') {
    if (
      !baseSelectorHex(evidence.burnTxHash, { bare: true }) ||
      !baseSelectorHex(evidence.expectationDigest, { bare: true })
    )
      return false
    if (!baseSelectorHex(evidence.messageDigest) || !baseSelectorHex(evidence.attestationDigest))
      return false
    if (!(baseSelectorHex(evidence.nonce) || baseSelectorUnsigned(evidence.nonce))) return false
    if (state === 'confirmed') return baseSelectorHex(evidence.mintTxHash)
    if (
      Object.prototype.hasOwnProperty.call(evidence, 'mintTxHash') &&
      evidence.mintTxHash !== null &&
      !baseSelectorHex(evidence.mintTxHash)
    )
      return false
    return true
  }
  if (phase === 'base_deposit') {
    const hasCommon =
      (baseSelectorAddress(evidence.yieldRouterAddress) ||
        baseSelectorAddress(evidence.yieldRouter)) &&
      baseSelectorAddress(evidence.caller) &&
      baseSelectorAddress(evidence.poolAddress) &&
      baseSelectorUnsigned(evidence.assets, true) &&
      baseSelectorUnsigned(evidence.minShares)
    if (!hasCommon) return false
    if (state === 'submitting') {
      return baseSelectorValidateReconcileHandle(evidence.reconcileHandle, evidence.caller)
    }
    if (state === 'submitted') return baseSelectorHex(evidence.userOpHash)
    if (state === 'unknown') {
      return (
        baseSelectorHex(evidence.userOpHash) ||
        baseSelectorValidateReconcileHandle(evidence.reconcileHandle, evidence.caller)
      )
    }
    if (state === 'confirmed') {
      if (!baseSelectorHex(evidence.userOpHash) || !baseSelectorHex(evidence.transactionHash))
        return false
      if (!baseSelectorUnsigned(evidence.shares, true)) return false
      return baseSelectorValidateNestedEvidence(
        evidence.event,
        BASE_SELECTOR_EVENT_EVIDENCE_FIELDS,
        ['address', 'topic0', 'logIndex', 'caller', 'poolAddress', 'assets', 'shares']
      )
    }
    if (state === 'failed' || state === 'blocked') {
      return baseSelectorHex(evidence.transactionHash) || baseSelectorString(evidence.reasonCode)
    }
    return true
  }
  return true
}

function baseSelectorNormalizeProjection(entry, phaseFromObject) {
  if (!baseSelectorObject(entry)) return null
  const phase = phaseFromObject ?? entry.phase
  if (phase === 'base_position') return null
  if (!BASE_SELECTOR_PHASES.includes(phase)) return null
  if (
    !baseSelectorExact(entry, BASE_SELECTOR_PROJECTION_FIELDS, [
      'eventId',
      'recoveryVersion',
      'state',
      'evidence',
    ])
  )
    return null
  if (entry.phase != null && entry.phase !== phase) return null
  if (!baseSelectorString(entry.eventId) || !BASE_SELECTOR_BARE32.test(entry.eventId)) return null
  if (!baseSelectorInteger(entry.recoveryVersion) || entry.recoveryVersion <= 0) return null
  if (!BASE_SELECTOR_STATES.includes(entry.state)) return null
  if (!baseSelectorObject(entry.identity)) return null
  if (!baseSelectorExact(entry.identity, BASE_SELECTOR_IDENTITY, [...BASE_SELECTOR_IDENTITY]))
    return null
  if (!baseSelectorInteger(entry.observedAt)) return null
  if (!baseSelectorValidateEvidence(phase, entry.state, entry.evidence)) return null
  return { ...entry, phase }
}

function baseSelectorNormalizeEvent(entry) {
  if (!baseSelectorExact(entry, BASE_SELECTOR_EVENT_FIELDS, [...BASE_SELECTOR_EVENT_FIELDS]))
    return null
  if (!baseSelectorString(entry.eventId) || !BASE_SELECTOR_BARE32.test(entry.eventId)) return null
  if (!baseSelectorInteger(entry.recoveryVersion) || entry.recoveryVersion <= 0) return null
  if (!BASE_SELECTOR_PHASES.includes(entry.phase) || !BASE_SELECTOR_STATES.includes(entry.state))
    return null
  if (
    !baseSelectorObject(entry.identity) ||
    !baseSelectorExact(entry.identity, BASE_SELECTOR_IDENTITY, [...BASE_SELECTOR_IDENTITY])
  )
    return null
  if (!baseSelectorString(entry.owner) || !baseSelectorString(entry.agent)) return null
  if (!baseSelectorInteger(entry.observedAt)) return null
  if (!baseSelectorValidateEvidence(entry.phase, entry.state, entry.evidence)) return null
  return entry
}

function baseSelectorPhaseList(phases) {
  if (Array.isArray(phases))
    return phases.map((entry) => baseSelectorNormalizeProjection(entry, null))
  if (!baseSelectorObject(phases)) return null
  const keys = Object.keys(phases)
  if (keys.some((key) => !BASE_SELECTOR_OPTIONAL_PROJECTION_PHASES.includes(key))) return null
  const output = []
  for (const phase of BASE_SELECTOR_PHASES) {
    if (phases[phase] == null) continue
    const normalized = baseSelectorNormalizeProjection(phases[phase], phase)
    if (!normalized) return null
    output.push(normalized)
  }
  if (Object.prototype.hasOwnProperty.call(phases, 'base_position') && phases.base_position != null)
    return null
  return output
}

function baseSelectorValidateBundle(bundle) {
  if (!baseSelectorExact(bundle, BASE_SELECTOR_TOP_LEVEL, [...BASE_SELECTOR_TOP_LEVEL])) return null
  if (bundle.schemaVersion !== 1 || bundle.recoverable !== true) return null
  if (
    !baseSelectorObject(bundle.identity) ||
    !baseSelectorExact(bundle.identity, BASE_SELECTOR_IDENTITY, [...BASE_SELECTOR_IDENTITY])
  )
    return null
  const identity = bundle.identity
  for (const value of Object.values(identity)) if (!baseSelectorString(value)) return null
  if (!baseSelectorString(bundle.owner) || !baseSelectorString(bundle.agent)) return null
  if (!baseSelectorInteger(bundle.recoveryVersion)) return null
  if (!baseSelectorExact(bundle.intent, BASE_SELECTOR_INTENT, [...BASE_SELECTOR_INTENT]))
    return null
  const intent = bundle.intent
  if (
    !baseSelectorString(intent.runId) ||
    !baseSelectorString(intent.proxyTarget) ||
    !baseSelectorString(intent.token)
  )
    return null
  if (identity.executionId !== `${intent.runId}:exec:${identity.allocationId}`) return null
  if (
    intent.grantTxHash !== intent.grantTxHash.toLowerCase() ||
    !baseSelectorHex(intent.grantTxHash, { bare: true })
  )
    return null
  if (!baseSelectorHex(intent.bindingHash, { bare: true }) || intent.baseJobId !== identity.childId)
    return null
  if (!baseSelectorAddress(intent.kernelAddress) || !baseSelectorAddress(intent.poolAddress))
    return null
  if (
    !baseSelectorUnsigned(intent.units, true) ||
    !baseSelectorInteger(intent.decimals) ||
    !baseSelectorUnsigned(intent.minShares)
  )
    return null
  const phases = baseSelectorPhaseList(bundle.phases)
  if (!phases) return null
  if (!Array.isArray(bundle.events)) return null
  const events = bundle.events.map(baseSelectorNormalizeEvent)
  if (events.some((event) => !event)) return null
  for (const event of events) {
    if (!baseSelectorSameIdentity(event.identity, identity)) return null
    if (event.owner !== bundle.owner || event.agent !== bundle.agent) return null
  }
  const versions = events.map((event) => event.recoveryVersion)
  for (let index = 0; index < versions.length; index += 1)
    if (versions[index] !== index + 1) return null
  if (new Set(events.map((event) => event.eventId)).size !== events.length) return null
  if ((versions.at(-1) ?? 0) !== bundle.recoveryVersion) return null
  if (phases.some((projection) => !baseSelectorSameIdentity(projection.identity, identity)))
    return null
  if (new Set(phases.map((projection) => projection.phase)).size !== phases.length) return null
  for (let index = 1; index < phases.length; index += 1) {
    if (
      BASE_SELECTOR_PHASES.indexOf(phases[index - 1].phase) >=
      BASE_SELECTOR_PHASES.indexOf(phases[index].phase)
    )
      return null
  }
  for (const projection of phases) {
    const latest = [...events].reverse().find((event) => event.phase === projection.phase)
    if (
      !latest ||
      latest.eventId !== projection.eventId ||
      latest.recoveryVersion !== projection.recoveryVersion ||
      latest.state !== projection.state ||
      latest.observedAt !== projection.observedAt ||
      !baseSelectorEqualJson(latest.evidence, projection.evidence)
    )
      return null
    if (projection.owner != null && projection.owner !== bundle.owner) return null
    if (projection.agent != null && projection.agent !== bundle.agent) return null
  }
  for (const phase of BASE_SELECTOR_PHASES) {
    const latestEvent = [...events].reverse().find((event) => event.phase === phase)
    if (latestEvent && !phases.some((projection) => projection.phase === phase)) return null
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const phaseIndex = BASE_SELECTOR_PHASES.indexOf(event.phase)
    const previousSame = events
      .slice(0, index)
      .filter((candidate) => candidate.phase === event.phase)
      .at(-1)
    if (previousSame?.state === 'confirmed') return null
    if (previousSame) {
      const allowed = {
        submitting: new Set(['submitted', 'confirmed', 'failed', 'unknown', 'blocked']),
        submitted: new Set(['confirmed', 'failed', 'unknown', 'blocked']),
        unknown: new Set(['confirmed']),
        failed: event.phase === 'cctp_attestation' ? new Set(['confirmed']) : new Set(),
      }
      if (!allowed[previousSame.state]?.has(event.state)) return null
    }
    for (const predecessor of events.slice(0, index)) {
      if (BASE_SELECTOR_PHASES.indexOf(predecessor.phase) > phaseIndex) return null
    }
    if (phaseIndex > 0) {
      const prior = [...events]
        .slice(0, index)
        .filter((candidate) => BASE_SELECTOR_PHASES.indexOf(candidate.phase) === phaseIndex - 1)
        .at(-1)
      if (!prior || prior.state !== 'confirmed') return null
    }
  }
  const immutableEvidenceFields = {
    cctp_burn: ['burnTxHash', 'expectationDigest', 'burnUnits7', 'messageDigest', 'nonce'],
    cctp_attestation: [
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'nonce',
      'attestationDigest',
    ],
    cctp_mint: [
      'burnTxHash',
      'expectationDigest',
      'messageDigest',
      'nonce',
      'attestationDigest',
      'mintTxHash',
    ],
    base_deposit: [
      'kernelAddress',
      'poolAddress',
      'assets',
      'minShares',
      'userOpHash',
      'transactionHash',
      'reconcileHandle',
    ],
  }
  for (const phase of BASE_SELECTOR_PHASES) {
    const seen = new Map()
    for (const event of events.filter((candidate) => candidate.phase === phase)) {
      for (const field of immutableEvidenceFields[phase]) {
        if (!Object.prototype.hasOwnProperty.call(event.evidence, field)) continue
        const value = event.evidence[field]
        if (
          seen.has(field) &&
          (typeof value === 'object' || typeof seen.get(field) === 'object'
            ? !baseSelectorEqualJson(seen.get(field), value)
            : seen.get(field) !== value)
        )
          return null
        seen.set(field, value)
      }
    }
  }
  return { ...bundle, phases, events }
}

function baseSelectorFact(evidence, key) {
  return evidence?.[key] ?? null
}

function baseSelectorFactsMatch(left, right, fields) {
  return fields.every((field) => baseSelectorFact(left, field) === baseSelectorFact(right, field))
}

function baseSelectorKernelCustody(evidence) {
  return (
    evidence?.kernelCustodyConfirmed === true ||
    (evidence?.custody?.location === 'base-kernel' && evidence.custody.confirmed === true)
  )
}

/** Total Base-only selector; returns only the stable action/phase/reasonCode triple. */
export function selectBaseChildRecoveryAction(bundle) {
  try {
    const valid = baseSelectorValidateBundle(bundle)
    if (!valid) return baseSelectorManual()
    if (valid.events.length === 0 && valid.phases.length === 0) {
      return baseSelectorAction('no-movement', null, BASE_RECOVERY_REASON_CODES.NO_MOVEMENT)
    }
    const burn = valid.phases.find((phase) => phase.phase === 'cctp_burn')
    const attestation = valid.phases.find((phase) => phase.phase === 'cctp_attestation')
    const mint = valid.phases.find((phase) => phase.phase === 'cctp_mint')
    const deposit = valid.phases.find((phase) => phase.phase === 'base_deposit')
    if (
      burn?.state === 'failed' &&
      !Object.keys(burn.evidence).some((key) => /hash|nonce|digest/i.test(key))
    ) {
      if (/revert/i.test(String(burn.evidence.reasonCode ?? ''))) {
        return baseSelectorAction('no-movement', null, BASE_RECOVERY_REASON_CODES.BURN_REVERTED)
      }
    }
    if (!burn) return baseSelectorManual()
    const burnEvidence = burn.evidence
    if (burn.state !== 'confirmed') return baseSelectorManual()
    if (!attestation) {
      return baseSelectorAction(
        'poll-attestation',
        'cctp_attestation',
        BASE_RECOVERY_REASON_CODES.ATTESTATION_PENDING
      )
    }
    if (
      !baseSelectorFactsMatch(burnEvidence, attestation.evidence, [
        'burnTxHash',
        'messageDigest',
        'nonce',
      ])
    )
      return baseSelectorManual()
    if (attestation.state !== 'confirmed') {
      return baseSelectorAction(
        'poll-attestation',
        'cctp_attestation',
        BASE_RECOVERY_REASON_CODES.ATTESTATION_PENDING
      )
    }
    if (!mint) {
      return baseSelectorAction(
        'submit-mint',
        'cctp_mint',
        BASE_RECOVERY_REASON_CODES.ATTESTATION_CONFIRMED
      )
    }
    if (
      !baseSelectorFactsMatch(attestation.evidence, mint.evidence, [
        'burnTxHash',
        'messageDigest',
        'nonce',
        'attestationDigest',
      ])
    )
      return baseSelectorManual()
    if (['submitting', 'submitted', 'unknown'].includes(mint.state)) {
      return baseSelectorAction('poll-mint', 'cctp_mint', BASE_RECOVERY_REASON_CODES.MINT_PENDING)
    }
    if (mint.state === 'failed' || mint.state === 'blocked') return baseSelectorManual()
    if (!deposit) {
      return baseSelectorAction(
        'submit-base-deposit',
        'base_deposit',
        BASE_RECOVERY_REASON_CODES.MINT_CONFIRMED
      )
    }
    const intent = valid.intent
    if (
      (deposit.evidence.kernelAddress != null &&
        deposit.evidence.kernelAddress !== intent.kernelAddress) ||
      deposit.evidence.caller !== intent.kernelAddress ||
      deposit.evidence.poolAddress !== intent.poolAddress ||
      deposit.evidence.minShares !== intent.minShares ||
      deposit.evidence.assets !== intent.units
    )
      return baseSelectorManual()
    if (
      deposit.state === 'submitting' ||
      deposit.state === 'submitted' ||
      deposit.state === 'unknown'
    ) {
      return baseSelectorAction(
        'poll-base-deposit',
        'base_deposit',
        BASE_RECOVERY_REASON_CODES.DEPOSIT_PENDING
      )
    }
    if (
      (deposit.state === 'failed' || deposit.state === 'blocked') &&
      baseSelectorKernelCustody(deposit.evidence) &&
      (baseSelectorHex(deposit.evidence.transactionHash) ||
        (deposit.state === 'blocked' && deposit.evidence.reasonCode === 'mandate_inactive'))
    ) {
      return baseSelectorAction(
        'owner-action-required',
        null,
        BASE_RECOVERY_REASON_CODES.DEPOSIT_FAILED_KERNEL_CUSTODY
      )
    }
    if (deposit.state === 'confirmed') {
      const evidence = deposit.evidence
      const event = evidence.event
      if (
        baseSelectorAddress(evidence.yieldRouterAddress ?? evidence.yieldRouter) &&
        (evidence.yieldRouterAddress ?? evidence.yieldRouter) === (event?.address ?? '') &&
        evidence.caller === intent.kernelAddress &&
        evidence.caller === event?.caller &&
        evidence.poolAddress === event?.poolAddress &&
        evidence.assets === event?.assets &&
        evidence.shares === event?.shares &&
        baseSelectorUnsigned(evidence.shares, true) &&
        BigInt(evidence.shares) >= BigInt(intent.minShares) &&
        baseSelectorHex(evidence.userOpHash) &&
        baseSelectorHex(evidence.transactionHash) &&
        baseSelectorEvidenceInteger(event.logIndex)
      ) {
        return baseSelectorAction('complete', null, BASE_RECOVERY_REASON_CODES.DEPOSIT_CONFIRMED)
      }
    }
    return baseSelectorManual()
  } catch {
    return baseSelectorManual()
  }
}
