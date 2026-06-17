// frontend/src/strategy/permissionScope.js
// SINGLE SOURCE OF TRUTH for a grant. Both the on-chain authorizeSessionKey args
// and the human-readable summary derive from ONE object. UI value != on-chain value
// is a security-class bug — they cannot diverge because they share this module.

// Single-source is only meaningful if the TYPE is single too. Enforce BigInt for the value
// that hits both the UI and the chain, so the UI cannot show a Number while the tx sends a
// BigInt (toBe identity comparisons in tests would silently mislead otherwise).
function assertScope(scope) {
  if (typeof scope.capPerPeriod !== 'bigint') {
    throw new TypeError('scope.capPerPeriod must be a bigint (single source = single type)')
  }
  if (scope.approvedByUser === false) {
    throw new Error('refusing to derive grant args from an unapproved scope')
  }
}

/** Returns the exact positional args for AgentRegistry.authorizeSessionKey. */
export function toAuthorizeArgs(scope) {
  assertScope(scope)
  return [
    scope.agent, scope.vault, scope.token,
    scope.capPerPeriod,                  // already bigint (asserted) — no re-wrap, preserves identity
    Number(scope.periodDuration),
    Number(scope.expiry),                // uint40 — Number is correct (safe past year 2106); do NOT
                                         // "fix" to BigInt: it would encode fine but diverge from periodDuration's type
  ]
}

export function maxAtRisk(scope) {
  assertScope(scope)
  const periods = Math.ceil((Number(scope.expiry) - Number(scope.nowSec)) / Number(scope.periodDuration))
  return scope.capPerPeriod * BigInt(Math.max(periods, 1))
}

export function toSummary(scope) {
  assertScope(scope)
  return {
    agent: scope.agent,
    vault: scope.vault,
    token: scope.token,
    capPerPeriod: scope.capPerPeriod,    // bigint — same value, same type as the on-chain arg
    periodDuration: Number(scope.periodDuration),
    expiry: Number(scope.expiry),
    maxAtRisk: maxAtRisk(scope),
  }
}
