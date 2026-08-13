// Pure presentation adapters for the authenticated Pocket Crew core routes.
//
// The route components own composition and callbacks; this module owns the small seams where
// route-friendly values meet the Foundation contracts.  It deliberately does not read a clock,
// fetch data, decide permissions, or perform any money-moving work.
import {
  formatTokenUnits,
  normalizeAmount,
  normalizeFact,
  resolveAgentIdentity,
  statusNoticeModel,
  toFreshnessView,
} from '../design/pocket-crew-foundation.js'

const BASE_CUSTODY_DISCLOSURE = 'Base Sepolia proxy. Custody only. No protocol yield.'

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isPresentText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string' || value.trim().length === 0) return false
  return Number.isFinite(Date.parse(value))
}

/**
 * Keep the presentation amount boundary narrower than Foundation's defensive formatter: route
 * DTOs carry unsigned decimal strings only.  Business BigInts must be converted by the caller
 * (`bigint.toString()`) before they enter this adapter.
 */
export function normalizeCoreAmount(amount = {}) {
  if (!isPlainRecord(amount)) throw new TypeError('amount must be a plain record')
  if (!Object.prototype.hasOwnProperty.call(amount, 'token')) {
    throw new TypeError('amount token is required')
  }
  if (typeof amount.units !== 'string') {
    throw new TypeError('amount units must be a decimal string')
  }
  if (!/^[0-9]+$/.test(amount.units)) {
    throw new TypeError('amount units must be an unsigned decimal integer')
  }
  if (!Number.isInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 38) {
    throw new TypeError('amount decimals must be an integer from 0 through 38')
  }
  return normalizeAmount({
    token: amount.token,
    units: amount.units,
    decimals: amount.decimals,
  })
}

export function formatCoreAmount(amount) {
  const normalized = normalizeCoreAmount(amount)
  return `${formatTokenUnits(normalized.units, normalized.decimals)} ${normalized.token}`
}

/** Foundation-owned fact projection. */
export function toFactView(input = {}, previousFact = null) {
  return normalizeFact(input, previousFact)
}

// These are intentionally direct re-exports.  A route must not grow a second freshness or status
// vocabulary, and preserving function identity makes that boundary obvious to callers/tests.
export { statusNoticeModel, toFreshnessView }

/**
 * Resolve one phase-aware identity and append only display gates.  The Foundation result is
 * spread unchanged; the booleans never become a substitute identity or a second identity DTO.
 */
export function toAgentIdentityView(input = {}) {
  const record = isPlainRecord(input) ? input : {}
  const address = record.address ?? record.verifiedAddress
  const identity = resolveAgentIdentity({ ...record, verifiedAddress: address })
  const identityAvailable = identity.status === 'available'
  return Object.freeze({
    ...identity,
    identityAvailable,
    showMark: identityAvailable,
    showMoney: identityAvailable,
    showCap: identityAvailable,
    showAction: identityAvailable,
  })
}

/**
 * Read only the nested source-owned yield record.  `venueTruth.normalizeVenue` is allowed to
 * classify a producer record upstream, but this presentation seam never calls it with its
 * default clock and never trusts a flat `venue.apy` compatibility field.
 */
export function toLiveVenueView(venue = {}) {
  if (!isPlainRecord(venue)) return { state: 'unavailable', apy: null }
  if (venue.venueKind === 'stellar-live' && venue.chain === 'base') {
    return { state: 'unavailable', apy: null }
  }
  if (venue.venueKind === 'base-custody-proxy' || venue.chain === 'base') {
    return { state: 'none', apy: null }
  }

  const sourceYield = venue.yield
  if (!isPlainRecord(sourceYield) || sourceYield.state !== 'live') {
    return { state: 'unavailable', apy: null }
  }
  if (!Number.isFinite(sourceYield.apy)) return { state: 'unavailable', apy: null }
  if (
    !isPresentText(sourceYield.source) ||
    !isValidTimestamp(sourceYield.asOf) ||
    !isValidTimestamp(sourceYield.checkedAt)
  ) {
    return { state: 'unavailable', apy: null }
  }

  // Preserve source-owned values exactly; no component freshness window or local timestamp.
  return {
    state: sourceYield.state,
    apy: sourceYield.apy,
    asOf: sourceYield.asOf,
    source: sourceYield.source,
    checkedAt: sourceYield.checkedAt,
  }
}

export function toStartProgress(phase) {
  if (phase === 'queued') return 0
  if (phase === 'pulling') return 22
  if (phase === 'depositing') return 66
  if (phase === 'done') return 100
  return null
}

export function toBaseCustodyTruth() {
  return {
    disclosure: BASE_CUSTODY_DISCLOSURE,
    destination: 'custody',
    custody: 'custody',
    yield: { state: 'none', apy: null },
  }
}

const PERMISSION_LABELS = Object.freeze({
  'fresh-grant': 'Fresh grant',
  'stellar-reuse-verified': 'Existing permission',
  'base-fresh-ceremony': 'Base setup ceremony',
  'stop-future-access': 'Stop future access',
  'withdrawal-separate': 'Withdrawal is separate',
})

function confirmationCountOf(decision) {
  return Number.isInteger(decision?.confirmationCount) && decision.confirmationCount >= 0
    ? decision.confirmationCount
    : null
}

function permissionModeOf(mode) {
  if (mode === 'fresh' || mode === 'fresh-grant') return 'fresh-grant'
  if (mode === 'reuse' || mode === 'stellar-reuse-verified') return 'stellar-reuse-verified'
  return PERMISSION_LABELS[mode] ? mode : null
}

function hasVerifiedAgentRow(row) {
  if (!isPlainRecord(row)) return false
  const address = row.agentAddress ?? row.address
  return (
    isPresentText(row.allocationId) &&
    isPresentText(address) &&
    Number.isFinite(row.scopeExpiry) &&
    row.scopeExpiry > 0
  )
}

function hasAllowanceProof(proof) {
  return (
    isPlainRecord(proof) &&
    proof.gapFree === true &&
    proof.noLaterMutation === true &&
    Number.isFinite(proof.latestLedger) &&
    Array.isArray(proof.approvals) &&
    proof.approvals.length > 0
  )
}

function hasSourceBackedReuseProof(decision) {
  return (
    decision?.mode === 'reuse' &&
    isPresentText(decision.grantReceiptFingerprint) &&
    hasAllowanceProof(decision.allowanceExpiryProof) &&
    Array.isArray(decision.agents) &&
    decision.agents.length > 0 &&
    decision.agents.every(hasVerifiedAgentRow)
  )
}

function permissionCopyFor(mode, decision, confirmationCount) {
  if (mode === 'fresh-grant') {
    return confirmationCount == null
      ? 'A bounded permission is required before this run can start.'
      : `This needs ${confirmationCount} wallet confirmation${confirmationCount === 1 ? '' : 's'}.`
  }
  if (mode === 'stellar-reuse-verified') {
    return confirmationCount == null
      ? 'The existing permission cannot be verified for this run.'
      : '0 wallet confirmations needed -- this permission already covers this run.'
  }
  if (mode === 'base-fresh-ceremony') {
    return 'Base setup is a separate ceremony with its own disclosed confirmation.'
  }
  if (mode === 'stop-future-access') {
    return 'Stops future access. Withdrawal is separate.'
  }
  if (mode === 'withdrawal-separate') {
    return 'Withdrawal returns deposited money; stopping future access is separate.'
  }
  return 'Permission details are unavailable.'
}

/**
 * Friendly permission wording over the existing source decision.  Reuse is positive only when
 * the decision carries independent proof and a count; presentation never manufactures a zero.
 */
export function toPermissionCopy(mode, decision = {}) {
  const normalizedMode = permissionModeOf(mode)
  const count = confirmationCountOf(decision)
  const actualMode = decision?.mode
  const freshAvailable =
    normalizedMode === 'fresh-grant' && actualMode === 'fresh' && count != null && count > 0
  const reuseAvailable =
    normalizedMode === 'stellar-reuse-verified' &&
    count === 0 &&
    hasSourceBackedReuseProof(decision)
  const needsCount = normalizedMode === 'fresh-grant' || normalizedMode === 'stellar-reuse-verified'
  const available =
    normalizedMode !== null &&
    (normalizedMode === 'fresh-grant'
      ? freshAvailable
      : normalizedMode === 'stellar-reuse-verified'
        ? reuseAvailable
        : true)
  return Object.freeze({
    mode: normalizedMode || mode,
    label: PERMISSION_LABELS[normalizedMode] || 'Permission unavailable',
    status: available ? 'Available' : 'Unavailable',
    confirmationCount: available && needsCount ? count : null,
    copy: permissionCopyFor(normalizedMode, decision, available ? count : null),
  })
}

function mandateState(mandateView) {
  const sourceState = mandateView?.status || mandateView?.state
  if (
    sourceState === 'owner-mismatch' ||
    sourceState === 'kernel-mismatch' ||
    sourceState === 'relayer-mismatch' ||
    sourceState === 'mismatch' ||
    sourceState === 'mismatched'
  ) {
    return 'mismatched'
  }
  if (typeof sourceState === 'string' && sourceState.trim()) return sourceState
  return 'unavailable'
}

function hasEpoch(value) {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim().length > 0)
  )
}

export function toBaseMandateManagerState({
  connected = false,
  accountEpoch = null,
  capturedEpoch = null,
  busy = false,
  mandateView = null,
} = {}) {
  let state = 'unavailable'
  if (!connected) state = 'disconnected'
  else if (
    !hasEpoch(accountEpoch) ||
    !hasEpoch(capturedEpoch) ||
    String(accountEpoch) !== String(capturedEpoch)
  ) {
    state = 'switched'
  } else if (busy) state = 'busy'
  else state = mandateState(mandateView)

  return Object.freeze({ state, mandateView: mandateView ?? null })
}
