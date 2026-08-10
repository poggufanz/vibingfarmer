const LOWER_HEX_128 = /^[0-9a-f]{32}$/

const IDENTITY_FIELDS = Object.freeze([
  'networkId',
  'bindingId',
  'executionId',
  'allocationId',
  'childId',
])

/**
 * Return the closed five-field Base child identity or throw before it can become a lookup key.
 * Opaque execution/allocation strings stay byte-for-byte; only their bounded canonical mapping is
 * checked here. The Agent Index remains the authority for the corresponding intent and owner.
 */
export function requireBaseRecoveryIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Base recovery identity is malformed.')
  }
  const keys = Object.keys(value)
  if (
    keys.length !== IDENTITY_FIELDS.length ||
    keys.some((key) => !IDENTITY_FIELDS.includes(key))
  ) {
    throw new Error('Base recovery identity is malformed.')
  }
  if (
    value.networkId !== 'stellar-testnet' ||
    !LOWER_HEX_128.test(value.bindingId) ||
    !LOWER_HEX_128.test(value.childId) ||
    typeof value.executionId !== 'string' ||
    value.executionId.length < 1 ||
    value.executionId.length > 256 ||
    typeof value.allocationId !== 'string' ||
    value.allocationId.length < 1 ||
    value.allocationId.length > 192 ||
    !value.executionId.endsWith(`:exec:${value.allocationId}`)
  ) {
    throw new Error('Base recovery identity is malformed.')
  }
  return {
    networkId: value.networkId,
    bindingId: value.bindingId,
    executionId: value.executionId,
    allocationId: value.allocationId,
    childId: value.childId,
  }
}

export function baseRecoveryIdentityKey(value) {
  const identity = requireBaseRecoveryIdentity(value)
  return JSON.stringify(IDENTITY_FIELDS.map((field) => identity[field]))
}

export function sameBaseRecoveryIdentity(left, right) {
  try {
    return baseRecoveryIdentityKey(left) === baseRecoveryIdentityKey(right)
  } catch {
    return false
  }
}
