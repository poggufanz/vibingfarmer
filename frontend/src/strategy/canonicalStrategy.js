// frontend/src/strategy/canonicalStrategy.js
// Strategy Task 4 (Pocket Crew redesign, Wave 1). Deterministic, key-order-independent
// serialization of a StrategyPlan (planModel.js) for off-chain hashing. Two calls with the same
// semantic plan -- regardless of how the caller ordered its object keys -- MUST canonicalize (and
// therefore hash) identically, so a reviewer can reproduce hashStrategy's output from the plan
// JSON alone, with no wallet, network, or wall clock involved.
//
// Rules: object keys sort recursively; array order is kept as-is (agent order, allocation order,
// venue order are all semantically meaningful -- reordering them is a real plan change); bigint
// units become decimal strings (JSON.stringify cannot serialize bigint); a short denylist strips
// fields that must never move the hash of an otherwise-identical plan -- the plan's own
// (not-yet-computed) fingerprint, and any transient UI/wallet/timestamp field a caller might have
// merged in.

const EXCLUDED_KEYS = new Set([
  'planFingerprint', // self-referential: this is the value hashStrategy is computing
  // transient UI state / wallet state -- never part of the plan's semantic content
  'attestation',
  'attester',
  'wallet',
  'walletAddress',
  'connectedWallet',
  'realAddress',
  // wall-clock artifacts that must never sneak into an otherwise-deterministic payload
  // (this is the exact bug being fixed: the old hashStrategy stamped Date.now() into every hash)
  'timestamp',
  'generatedAt',
  'createdAt',
  'updatedAt',
])

function canonicalize(value) {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .filter((key) => !EXCLUDED_KEYS.has(key))
      .sort()
      .reduce((out, key) => {
        out[key] = canonicalize(value[key])
        return out
      }, {})
  }
  return value
}

/**
 * Canonicalize a StrategyPlan (or any plan-shaped object) into a plain object whose key order
 * and content are deterministic across calls: same semantic plan in, same canonical shape out,
 * no matter how the source object's keys were ordered. Synchronous, off-chain, no I/O.
 * @param {object} plan
 * @returns {object} canonical plain object, safe to JSON.stringify for hashing
 */
export function canonicalizeStrategy(plan) {
  return canonicalize(plan || {})
}
