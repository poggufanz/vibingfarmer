// frontend/src/money/freshness.js
// Pocket Crew "My money" Task 8: the freshness contract shared by every money/automation source
// the /agent route renders. A source reading is never just a value — it always carries WHEN it
// was checked (`checkedAt`), WHERE that check was anchored on-chain when applicable
// (`confirmedLedger` for Stellar, `confirmedBlock` for Base), and WHAT read it (`source`).
// Consumers derive a freshness label from that evidence — never from the mere absence of a newer
// failure ("no alert seen" is not "protected"; see myMoneyModel.js).
//
// Shape every source reading is expected to carry (documented here, not re-validated — callers
// like myMoneyModel.js compose these from readOwnerMoney.js / automationEvidence.js output):
//   { state: 'known'|'unavailable', checkedAt: number|null, confirmedLedger?: number|null,
//     confirmedBlock?: number|null, source?: string, ...payload }

export const FRESHNESS_STATES = ['current', 'stale', 'unavailable']

// A source silent for longer than this reads as stale, not current — headroom above app.jsx's
// own 15s sync poll for one missed cycle before calling it stale rather than crying wolf.
export const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1000

// Real client/chain clock skew is seconds, not hours — a `checkedAt` further in the future than
// this is not skew, it is implausible/bogus data (a chain close time is always in the past). Left
// unclamped, an unbounded future timestamp read as 'current' and let a corrupt reading manufacture
// 'healthy' automation evidence (see classifyKeeperAutomation) out of a reading that never actually
// happened (Fix 6, review loop 1).
export const MAX_CLOCK_SKEW_MS = 60 * 1000

/**
 * Classify a single `checkedAt` timestamp against `now`. A `checkedAt` that was never set (no
 * read ever happened) is always 'unavailable' — there is no reading to be stale about.
 * @returns {'current'|'stale'|'unavailable'}
 */
export function classifyFreshness({ checkedAt, now, staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  if (checkedAt == null || !Number.isFinite(checkedAt) || !Number.isFinite(now)) return 'unavailable'
  const age = now - checkedAt
  if (age < 0) {
    // Small clock skew still reads as current — never punish a reading that looks "from the
    // future" by a plausible margin. Anything further ahead than that is not skew; it is bad data
    // and must never be rewarded with 'current'.
    return -age <= MAX_CLOCK_SKEW_MS ? 'current' : 'unavailable'
  }
  return age <= staleAfterMs ? 'current' : 'stale'
}

/**
 * Reconciles a fresh read against the last known-good cache for the SAME source. A failed refresh
 * (`fresh` missing, or itself `state: 'unavailable'`) keeps showing the cached figure — "Last
 * confirmed" — but the state downgrades to 'stale'; it is never silently presented as current
 * again just because nothing new came back. With nothing cached either, the honest answer is
 * 'unavailable', never a guessed zero.
 */
export function withCacheFallback({ cached, fresh, now, staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  if (fresh && fresh.state && fresh.state !== 'unavailable') {
    return { ...fresh, freshness: classifyFreshness({ checkedAt: fresh.checkedAt, now, staleAfterMs }) }
  }
  if (cached && cached.state && cached.state !== 'unavailable') {
    return { ...cached, freshness: 'stale' }
  }
  // Nothing usable — every field of the freshness triple is genuinely unknown, carried as null,
  // never coerced to 0 (a confirmedLedger/confirmedBlock of 0 would read as a real, very early
  // confirmation height, not "never checked").
  return {
    state: 'unavailable',
    amount: null,
    checkedAt: null,
    confirmedLedger: null,
    confirmedBlock: null,
    source: null,
    freshness: 'unavailable',
  }
}

/**
 * Post-action reconciliation guard. Every mutating action (withdraw, grant, revoke) bumps a
 * monotonic token via `nextReconciliationToken`; a money read is only trusted to overwrite the
 * displayed state if it started at or after the CURRENT token. An in-flight read that began
 * before the action resolves AFTER it and must be discarded, or a stale pre-withdraw balance
 * would silently reappear over the real post-withdraw one.
 */
export function nextReconciliationToken(prevToken) {
  return (Number.isFinite(prevToken) ? prevToken : 0) + 1
}

export function isReconciliationCurrent({ readToken, currentToken } = {}) {
  if (currentToken == null) return true // no mutating action has ever happened — nothing to guard against
  if (readToken == null) return false // a read that can't prove when it started can't prove it isn't stale
  return readToken >= currentToken
}
