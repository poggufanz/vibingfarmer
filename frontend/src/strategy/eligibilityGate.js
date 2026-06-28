// Pure, deterministic, fail-closed eligibility gate (F8). No I/O — all facts arrive resolved.
// A fact field is { value, source: 'live'|'snapshot', asOf: epochMs }.

export const PONZI_RATIO_MAX = 1.5
export const SECURITY_MIN = 60
export const AGE_CAP_DAYS = 180
export const TVL_FLOOR = 100_000
export const TVL_CAP = 100_000_000
export const AGE_WEIGHT = 0.30
export const TVL_WEIGHT = 0.40
export const ADMIN_WEIGHT = 0.30
export const ADMIN_LEVELS = { timelock_multisig: 1.0, multisig: 0.7, timelock: 0.5, eoa: 0.0 }
export const MAX_FACT_AGE_MS = 30 * 86_400_000
export const MAX_TOKEN_AGE_MS = 15 * 60_000
export const REQUIRED_FACTS = [
  'annualizedDistributed', 'protocolRevenue', 'audit', 'ageDays', 'tvl', 'adminKey',
]

/** A fact field is present iff it has a non-null value and is not stale. */
export function factPresent(field, nowMs) {
  if (!field || field.value == null) return false
  if (typeof field.asOf !== 'number') return false
  return nowMs - field.asOf <= MAX_FACT_AGE_MS
}

export function allRequiredFactsPresent(facts, nowMs) {
  return REQUIRED_FACTS.every((k) => factPresent(facts?.[k], nowMs))
}
