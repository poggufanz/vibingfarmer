const asText = (value) => (typeof value === 'string' ? value.trim() : '')
const TOKEN_AMOUNT_KEYS = Object.freeze(['token', 'units', 'decimals'])
const INVALID_PRESENTATION_VALUE = Symbol('invalid-presentation-value')

const readDataProperty = (record, key) => {
  if (record === null || (typeof record !== 'object' && typeof record !== 'function')) {
    return { present: false, valid: true, value: undefined }
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor) return { present: false, valid: true, value: undefined }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return { present: true, valid: false, value: undefined }
    }
    return { present: true, valid: true, value: descriptor.value }
  } catch {
    return { present: true, valid: false, value: undefined }
  }
}

const readDataValue = (record, key) => {
  const result = readDataProperty(record, key)
  return result.valid && result.present ? result.value : undefined
}

const isUnsafeNumber = (value) =>
  typeof value === 'number' &&
  (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))

const snapshotPresentationValue = (value, ancestors = new WeakSet()) => {
  const valueType = typeof value
  if (valueType === 'bigint' || valueType === 'function' || valueType === 'symbol') {
    return INVALID_PRESENTATION_VALUE
  }
  if (isUnsafeNumber(value)) return INVALID_PRESENTATION_VALUE
  if (value === null || valueType !== 'object') return value
  if (ancestors.has(value)) return INVALID_PRESENTATION_VALUE

  ancestors.add(value)
  try {
    const prototype = Object.getPrototypeOf(value)
    const isArray = Array.isArray(value)
    if (
      isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    ) {
      return INVALID_PRESENTATION_VALUE
    }

    const ownKeys = Reflect.ownKeys(value)
    const entries = []

    for (const key of ownKeys) {
      if (typeof key !== 'string') return INVALID_PRESENTATION_VALUE
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return INVALID_PRESENTATION_VALUE
      }
      const snapshot = snapshotPresentationValue(descriptor.value, ancestors)
      if (snapshot === INVALID_PRESENTATION_VALUE) return INVALID_PRESENTATION_VALUE
      if (descriptor.enumerable) entries.push([key, snapshot])
    }

    const presentsAmountFields = TOKEN_AMOUNT_KEYS.every((key) => ownKeys.includes(key))
    if (presentsAmountFields) {
      if (
        ownKeys.length !== TOKEN_AMOUNT_KEYS.length ||
        entries.length !== TOKEN_AMOUNT_KEYS.length ||
        entries.some(([key]) => !TOKEN_AMOUNT_KEYS.includes(key))
      ) {
        return INVALID_PRESENTATION_VALUE
      }
      try {
        return normalizeAmount(Object.fromEntries(entries))
      } catch {
        return INVALID_PRESENTATION_VALUE
      }
    }

    const clone = isArray ? [] : Object.create(prototype)
    for (const [key, entry] of entries) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: entry,
        writable: true,
      })
    }
    return Object.freeze(clone)
  } catch {
    return INVALID_PRESENTATION_VALUE
  } finally {
    ancestors.delete(value)
  }
}

export const COLLECTION_STATES = Object.freeze(['loading', 'current', 'stale', 'empty', 'error'])

export const DISCOVERY_STATES = Object.freeze(['checking', 'complete', 'partial', 'unavailable'])

export const PROTECTION_STATES = Object.freeze([
  'loading',
  'armed',
  'engaged',
  'expired',
  'stale',
  'unavailable',
  'disarmed',
])

export const AUTOMATION_STATES = Object.freeze([
  'loading',
  'running',
  'configured',
  'stale',
  'unavailable',
])

export const PLAN_SOURCES = Object.freeze(['live-ai', 'deterministic', 'cached'])

export const EXECUTION_STATES = Object.freeze([
  'planned',
  'creating',
  'queued',
  'ready',
  'moving',
  'depositing',
  'bridging',
  'in-transit',
  'working',
  'failed',
  'revoked-funded',
  'revoked-empty',
  'expired',
  'unknown',
])

export const CUSTODY_STATES = Object.freeze([
  'owner',
  'agent',
  'stellar-vault',
  'in-transit',
  'base-proxy',
  'unknown',
])

export const FACT_STATES = Object.freeze([
  'loading',
  'current',
  'confirmed',
  'stale',
  'partial',
  'blocked',
  'empty',
  'error',
  'rejected',
  'cancelled',
  'unknown',
  'unavailable',
])

export function formatTokenUnits(units, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new TypeError('decimals must be an integer from 0 through 38')
  }
  const raw = typeof units === 'bigint' ? units.toString() : asText(units)
  if (!/^[0-9]+$/.test(raw)) throw new TypeError('units must be an unsigned decimal integer')
  if (decimals === 0) return raw

  const scale = 10n ** BigInt(decimals)
  const whole = BigInt(raw) / scale
  const fraction = (BigInt(raw) % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString()
}

export function normalizeAmount({ token, units, decimals } = {}) {
  const tokenText = asText(token)
  const raw = asText(units)
  if (!tokenText || !/^[0-9]+$/.test(raw))
    throw new TypeError('amount token and units are required')
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new TypeError('decimals must be an integer from 0 through 38')
  }
  return Object.freeze({ token: tokenText, units: raw, decimals })
}

const STATE_TONES = Object.freeze({
  loading: 'neutral',
  empty: 'neutral',
  current: 'active',
  confirmed: 'active',
  stale: 'warning',
  partial: 'warning',
  blocked: 'warning',
  error: 'danger',
  rejected: 'neutral',
  cancelled: 'neutral',
  unknown: 'neutral',
  unavailable: 'neutral',
})

export function statusToneForState(state) {
  return Object.prototype.hasOwnProperty.call(STATE_TONES, state) ? STATE_TONES[state] : 'neutral'
}

const FACT_COPY = Object.freeze({
  loading: {
    consequence: 'This fact is still being checked.',
    safeNextAction: 'Wait for the read to finish.',
  },
  current: {
    consequence: 'This is the latest verified fact.',
    safeNextAction: 'Continue with the shown state.',
  },
  confirmed: {
    consequence: 'The source confirmed this fact.',
    safeNextAction: 'Continue with the confirmed state.',
  },
  stale: {
    consequence: 'The last verified fact may be out of date.',
    safeNextAction: 'Refresh the source before moving money.',
  },
  partial: {
    consequence: 'Only part of the requested evidence is available.',
    safeNextAction: 'Review the known evidence before acting.',
  },
  blocked: {
    consequence: 'The safety check prevents this action.',
    safeNextAction: 'Resolve the stated condition before signing.',
  },
  empty: {
    consequence: 'The completed read found no matching value.',
    safeNextAction: 'Start a new request when you are ready.',
  },
  error: {
    consequence: 'The source read failed before it could verify this fact.',
    safeNextAction: 'Retry the read when the source is available.',
  },
  rejected: {
    consequence: 'The requested action was rejected and nothing moved.',
    safeNextAction: 'Review the request before trying again.',
  },
  cancelled: {
    consequence: 'The requested action was cancelled and nothing moved.',
    safeNextAction: 'Start again only if you still want this action.',
  },
  unknown: { consequence: null, safeNextAction: null },
  unavailable: { consequence: null, safeNextAction: null },
})

const FACT_LABELS = Object.freeze({
  loading: 'Checking',
  current: 'Current',
  confirmed: 'Confirmed',
  stale: 'Stale',
  partial: 'Partial',
  blocked: 'Blocked',
  empty: 'Empty',
  error: 'Error',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  unknown: 'Unavailable',
  unavailable: 'Unavailable',
})

const validCheckedAt = (value) =>
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.trim().length > 0)

const normalizeCheckedAt = (value) => (validCheckedAt(value) ? value : null)

const asAnchor = (value) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[0-9]+$/.test(text) ? text : null
}

const asStaleAfterMs = (value) => (Number.isInteger(value) && value >= 0 ? value : null)

const FACT_PHASES = ['planned', 'submitted', 'confirmed', 'stale', 'unknown']

export function normalizeFact(input = {}, previousFact = null) {
  const inputRecord =
    input !== null && (typeof input === 'object' || typeof input === 'function') ? input : {}
  const stateValue = readDataProperty(inputRecord, 'state')
  const requested =
    stateValue.valid && FACT_STATES.includes(stateValue.value) ? stateValue.value : 'unknown'
  const prior =
    previousFact !== null &&
    (typeof previousFact === 'object' || typeof previousFact === 'function')
      ? previousFact
      : null
  const failedRefreshRequested = ['error', 'unavailable'].includes(requested)
  const priorValue = failedRefreshRequested
    ? readDataProperty(prior, 'value')
    : { present: false, valid: true, value: undefined }
  const hasPriorEvidence =
    failedRefreshRequested && priorValue.present && priorValue.valid && priorValue.value != null
  let invalidPriorValue = failedRefreshRequested && priorValue.present && !priorValue.valid
  let failedRefresh = false
  let invalidInputValue = false
  let safeValue = null

  if (failedRefreshRequested) {
    if (hasPriorEvidence) {
      safeValue = snapshotPresentationValue(priorValue.value)
      if (safeValue === INVALID_PRESENTATION_VALUE) {
        safeValue = null
        invalidPriorValue = true
      } else {
        failedRefresh = true
      }
    }
  } else {
    const inputValue = readDataProperty(inputRecord, 'value')
    if (!inputValue.valid) {
      invalidInputValue = true
    } else {
      safeValue = snapshotPresentationValue(inputValue.present ? inputValue.value : undefined)
      if (safeValue === INVALID_PRESENTATION_VALUE) {
        safeValue = null
        invalidInputValue = true
      }
    }
  }

  const invalidValue = invalidInputValue || invalidPriorValue
  const stateBeforeFreshness = invalidValue ? 'unavailable' : failedRefresh ? 'stale' : requested
  const source = failedRefresh
    ? asText(readDataValue(prior, 'source')) || null
    : asText(readDataValue(inputRecord, 'source')) || null
  const checkedAt = failedRefresh
    ? normalizeCheckedAt(readDataValue(prior, 'checkedAt'))
    : normalizeCheckedAt(readDataValue(inputRecord, 'checkedAt'))
  const staleAfterMs = failedRefresh
    ? asStaleAfterMs(readDataValue(prior, 'staleAfterMs'))
    : asStaleAfterMs(readDataValue(inputRecord, 'staleAfterMs'))
  const missingFreshness =
    ['current', 'confirmed', 'stale'].includes(stateBeforeFreshness) &&
    !(source && validCheckedAt(checkedAt))
  const outputState = missingFreshness ? 'unavailable' : stateBeforeFreshness
  const phaseValue = readDataValue(inputRecord, 'phase')
  const requestedPhase = FACT_PHASES.includes(phaseValue) ? phaseValue : 'unknown'
  const phase =
    outputState === 'stale'
      ? 'stale'
      : outputState === 'confirmed'
        ? 'confirmed'
        : outputState === 'unavailable'
          ? 'unknown'
          : outputState === 'current' && requestedPhase !== 'stale'
            ? requestedPhase
            : outputState === 'loading' && requestedPhase === 'planned'
              ? 'planned'
              : 'unknown'
  const copy = FACT_COPY[outputState]

  return Object.freeze({
    phase,
    state: outputState,
    value: outputState === 'unavailable' ? null : failedRefresh ? safeValue : (safeValue ?? null),
    source,
    checkedAt,
    staleAfterMs,
    confirmedLedger: failedRefresh
      ? asAnchor(readDataValue(prior, 'confirmedLedger'))
      : asAnchor(readDataValue(inputRecord, 'confirmedLedger')),
    confirmedBlock: failedRefresh
      ? asAnchor(readDataValue(prior, 'confirmedBlock'))
      : asAnchor(readDataValue(inputRecord, 'confirmedBlock')),
    consequence:
      outputState === 'unknown' || outputState === 'unavailable'
        ? null
        : asText(readDataValue(inputRecord, 'consequence')) || copy.consequence,
    safeNextAction:
      outputState === 'unknown' || outputState === 'unavailable'
        ? null
        : asText(readDataValue(inputRecord, 'safeNextAction')) || copy.safeNextAction,
  })
}

export function toFreshnessView(fact) {
  const normalized = normalizeFact(fact)
  return Object.freeze({
    phase: normalized.phase,
    state: normalized.state,
    label: FACT_LABELS[normalized.state],
    source: normalized.source,
    checkedAt: normalized.checkedAt,
    staleAfterMs: normalized.staleAfterMs,
    confirmedLedger: normalized.confirmedLedger,
    confirmedBlock: normalized.confirmedBlock,
  })
}

export function statusNoticeModel(fact) {
  const normalized = normalizeFact(fact)
  return Object.freeze({
    tone: statusToneForState(normalized.state),
    label: FACT_LABELS[normalized.state],
    consequence: normalized.consequence,
    nextAction: normalized.safeNextAction,
    phase: normalized.phase,
    source: normalized.source,
    checkedAt: normalized.checkedAt,
    staleAfterMs: normalized.staleAfterMs,
    confirmedLedger: normalized.confirmedLedger,
    confirmedBlock: normalized.confirmedBlock,
  })
}

const IDENTITY_SOURCES = ['reviewed-plan', 'creation-event', 'owner-discovery', 'receipt']

export function resolveAgentIdentity({
  phase = 'planned',
  runId,
  allocationId,
  verifiedAddress,
  verified = false,
  source = 'unknown',
  state,
} = {}) {
  const identityPhase = ['planned', 'deployed', 'reused'].includes(phase) ? phase : 'unknown'
  const allocation = asText(allocationId) || null
  const run = asText(runId) || null
  const reviewedKey = allocation || run
  const address = asText(verifiedAddress)
  const identitySource = IDENTITY_SOURCES.includes(source) ? source : 'unknown'
  const unavailable = Object.freeze({
    phase: identityPhase,
    key: identityPhase === 'planned' ? reviewedKey : null,
    allocationId: allocation,
    runId: run,
    address: null,
    source: identitySource,
    verified: false,
    status: 'unavailable',
    label: 'Agent identity unavailable',
    state: 'unknown',
  })

  if (identityPhase === 'unknown') return unavailable
  if (
    identityPhase === 'planned' &&
    (!reviewedKey || identitySource !== 'reviewed-plan' || address)
  ) {
    return unavailable
  }
  if (
    identityPhase !== 'planned' &&
    (!address ||
      verified !== true ||
      !['creation-event', 'owner-discovery', 'receipt'].includes(identitySource))
  ) {
    return unavailable
  }

  return Object.freeze({
    phase: identityPhase,
    key: identityPhase === 'planned' ? reviewedKey : address,
    allocationId: allocation,
    runId: run,
    address: identityPhase === 'planned' ? null : address,
    source: identitySource,
    verified: identityPhase !== 'planned',
    status: 'available',
    label: identityPhase === 'planned' ? 'Planned' : 'Existing',
    state: identityPhase === 'planned' ? 'planned' : asText(state) || identityPhase,
  })
}
