const STATUS_VALUES = new Set([
  'active',
  'not_yet_valid',
  'expiring',
  'expired',
  'revoked',
  'mismatch',
  'unknown',
])

const SECRET_KEY = /(private.*key|secret|session.*material|raw.*public.*key|approval|enable.*signature)/i
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
  'freshness',
  'reconstruction',
  'activation',
])
const CANONICAL_HASH = /^0x[0-9a-f]{64}$/

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
  if (!value || value.version !== 3 || value.status !== 'active') return false
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
    CANONICAL_HASH.test(observed?.activation?.userOpHash || '') &&
    CANONICAL_HASH.test(observed?.activation?.txHash || '') &&
    Number.isSafeInteger(observed?.activation?.activatedAt)
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
    activation: value.observed?.activation ?? null,
    checks: value.checks || null,
  })
}

export function materialBaseMandateStatusChange(previous, next) {
  if (!previous) return false
  return materialFingerprint(previous) !== materialFingerprint(next)
}

export function normalizeBaseMandateStatus(body) {
  const publicBody = publicBaseMandateEvidence(body)
  if (!STATUS_VALUES.has(publicBody?.status) || publicBody.version !== 3) {
    return {
      version: 3,
      status: 'unknown',
      reasonCodes: ['EVIDENCE_MISSING'],
      expected: {},
      observed: {},
      checks: {},
    }
  }
  return publicBody
}
