const STATUS_VALUES = new Set([
  'active',
  'not_yet_valid',
  'expiring',
  'expired',
  'revoked',
  'mismatch',
  'unknown',
])

const SECRET_KEY = /(private.*key|secret|session.*material|raw.*public.*key)/i
const ALLOCATION_FIELDS = new Set(['allocationId', 'poolAddress', 'units', 'minShares'])
const MANDATORY_CHECKS = Object.freeze([
  'chain',
  'owner',
  'kernel',
  'session',
  'permission',
  'policy',
  'binding',
  'origin',
  'implementation',
  'allocation',
  'freshness',
  'reconstruction',
  'prepared',
])

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, child]) => [key, scrub(child)])
  )
}

export function publicBaseMandateEvidence(value) {
  return scrub(value || {})
}

export function isVerifiedBaseMandateStatus(value) {
  if (!value || value.version !== 2 || value.status !== 'active') return false
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length !== 0) return false
  const checks = value.checks
  if (!checks || !MANDATORY_CHECKS.every((check) => checks[check] === true)) {
    return false
  }
  const observed = value.observed
  return !!(
    observed?.blockNumber &&
    observed?.blockHash &&
    Number.isFinite(observed?.blockTime) &&
    observed?.implementation &&
    observed?.permission?.digest &&
    observed?.preparedCallDigest
  )
}

function materialFingerprint(value) {
  if (!value) return null
  return JSON.stringify({
    status: value.status,
    reasons: value.reasonCodes || [],
    expected: value.expected || null,
    implementation: value.observed?.implementation ?? null,
    permissionDigest: value.observed?.permission?.digest ?? null,
    checks: value.checks || null,
  })
}

export function materialBaseMandateStatusChange(previous, next) {
  if (!previous) return false
  return materialFingerprint(previous) !== materialFingerprint(next)
}

export function toMandateStatusAllocation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('mandate allocation must be an object')
  }
  const unexpected = Object.keys(input).find((key) => !ALLOCATION_FIELDS.has(key))
  if (unexpected) throw new Error(`unexpected mandate allocation field: ${unexpected}`)
  const { allocationId, poolAddress, units, minShares } = input
  if (typeof allocationId !== 'string' || !allocationId || typeof poolAddress !== 'string') {
    throw new Error('mandate allocation requires allocationId and poolAddress')
  }
  if (typeof units !== 'bigint' || units <= 0n || typeof minShares !== 'bigint' || minShares < 0n) {
    throw new Error('mandate allocation units/minShares must be exact non-negative bigint values')
  }
  return {
    allocationId,
    poolAddress,
    amount: { token: 'USDC', units: units.toString(), decimals: 6 },
    minShares: minShares.toString(),
  }
}

export function normalizeBaseMandateStatus(body) {
  const publicBody = publicBaseMandateEvidence(body)
  if (!STATUS_VALUES.has(publicBody?.status) || publicBody.version !== 2) {
    return {
      version: 2,
      status: 'unknown',
      reasonCodes: ['EVIDENCE_MISSING'],
      expected: {},
      observed: {},
      checks: {},
    }
  }
  return publicBody
}
