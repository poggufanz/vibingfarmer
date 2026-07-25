// frontend/src/money/freshness.test.js
import { describe, it, expect } from 'vitest'
import {
  classifyFreshness,
  withCacheFallback,
  nextReconciliationToken,
  isReconciliationCurrent,
  DEFAULT_STALE_AFTER_MS,
} from './freshness.js'

describe('classifyFreshness', () => {
  it('is unavailable when checkedAt was never set', () => {
    expect(classifyFreshness({ checkedAt: null, now: 1000 })).toBe('unavailable')
    expect(classifyFreshness({ checkedAt: undefined, now: 1000 })).toBe('unavailable')
  })

  it('is current within the staleness window', () => {
    expect(classifyFreshness({ checkedAt: 1000, now: 1000 + DEFAULT_STALE_AFTER_MS })).toBe('current')
  })

  it('is stale past the staleness window', () => {
    expect(classifyFreshness({ checkedAt: 1000, now: 1000 + DEFAULT_STALE_AFTER_MS + 1 })).toBe('stale')
  })

  it('honors a custom staleAfterMs', () => {
    expect(classifyFreshness({ checkedAt: 0, now: 5000, staleAfterMs: 1000 })).toBe('stale')
    expect(classifyFreshness({ checkedAt: 0, now: 500, staleAfterMs: 1000 })).toBe('current')
  })

  it('treats a small future checkedAt (ordinary clock skew) as current, never a crash', () => {
    expect(classifyFreshness({ checkedAt: 5000, now: 1000 })).toBe('current')
  })

  // Fix 6 (minor, review loop 1): a chain close time is always in the past — an unbounded future
  // timestamp is not clock skew, it is implausible/bogus data (classifyKeeperAutomation would
  // otherwise report 'healthy' from a bogus future ledger-close time). Clamp it instead of
  // rewarding it with 'current'.
  // Fix 5, review loop 2: pin the exact value — `not.toBe('current')` would also pass for a bogus
  // third state, masking a regression the way myMoneyModel.test.js:140-150 masked Fix 1.
  it('does not treat a far-future checkedAt as current — a chain close time is never that far ahead', () => {
    const out = classifyFreshness({ checkedAt: 1000 + 60 * 60 * 1000, now: 1000 }) // 1 hour "ahead"
    expect(out).toBe('unavailable')
  })

  it('is unavailable when now is not a finite number', () => {
    expect(classifyFreshness({ checkedAt: 1000, now: NaN })).toBe('unavailable')
  })
})

describe('withCacheFallback', () => {
  const cached = { state: 'known', amount: { token: 'USDC', units: '100', decimals: 7 }, checkedAt: 0 }

  it('uses the fresh read when it succeeded, classified against now', () => {
    const fresh = { state: 'known', amount: { token: 'USDC', units: '200', decimals: 7 }, checkedAt: 1000 }
    const out = withCacheFallback({ cached, fresh, now: 1000 })
    expect(out.amount.units).toBe('200')
    expect(out.freshness).toBe('current')
  })

  it('falls back to cache and marks stale when the fresh read failed', () => {
    const fresh = { state: 'unavailable', amount: null, checkedAt: 1000 }
    const out = withCacheFallback({ cached, fresh, now: 1000 })
    expect(out.amount.units).toBe('100') // the OLD cached figure — never silently dropped
    expect(out.state).toBe('known')
    expect(out.freshness).toBe('stale') // never re-labeled current just because nothing new came back
  })

  it('falls back to cache when fresh is entirely absent (no read attempted yet)', () => {
    const out = withCacheFallback({ cached, fresh: null, now: 1000 })
    expect(out.amount.units).toBe('100')
    expect(out.freshness).toBe('stale')
  })

  it('is unavailable when both fresh and cache are missing/failed', () => {
    const out = withCacheFallback({ cached: null, fresh: { state: 'unavailable', amount: null }, now: 1000 })
    expect(out.state).toBe('unavailable')
    expect(out.amount).toBeNull()
    expect(out.freshness).toBe('unavailable')
  })

  // Fix 5 (missed requirement, review loop 1): every source carries checkedAt,
  // confirmedLedger/confirmedBlock, AND source — not just checkedAt.
  it('carries the full freshness triple (confirmedLedger/confirmedBlock + source) through the fresh path', () => {
    const fresh = {
      state: 'known',
      amount: { token: 'USDC', units: '300', decimals: 7 },
      checkedAt: 1000,
      confirmedLedger: 555,
      source: 'soroban-rpc',
    }
    const out = withCacheFallback({ cached: null, fresh, now: 1000 })
    expect(out.confirmedLedger).toBe(555)
    expect(out.source).toBe('soroban-rpc')
  })

  it('carries the full freshness triple through the cache-fallback path too', () => {
    const cachedTriple = {
      state: 'known',
      amount: { token: 'USDC', units: '100', decimals: 7 },
      checkedAt: 0,
      confirmedBlock: 42,
      source: 'base-rpc',
    }
    const out = withCacheFallback({ cached: cachedTriple, fresh: null, now: 1000 })
    expect(out.confirmedBlock).toBe(42)
    expect(out.source).toBe('base-rpc')
  })

  it('never substitutes 0 for a genuinely unknown confirmation height — the unavailable case carries null, not 0', () => {
    const out = withCacheFallback({ cached: null, fresh: null, now: 1000 })
    expect(out.confirmedLedger).toBeNull()
    expect(out.confirmedBlock).toBeNull()
    expect(out.source).toBeNull()
  })
})

describe('reconciliation token guard', () => {
  it('nextReconciliationToken increments from an unset token', () => {
    expect(nextReconciliationToken(undefined)).toBe(1)
    expect(nextReconciliationToken(null)).toBe(1)
    expect(nextReconciliationToken(3)).toBe(4)
  })

  it('accepts a read when no mutating action has ever happened', () => {
    expect(isReconciliationCurrent({ readToken: null, currentToken: null })).toBe(true)
  })

  it('rejects an older pre-withdraw read racing a newer action token', () => {
    // action bumped the token to 2 (a withdraw was issued); a read that started under token 1
    // resolving afterwards must not overwrite the newer (still loading) state.
    expect(isReconciliationCurrent({ readToken: 1, currentToken: 2 })).toBe(false)
  })

  it('accepts a read at or after the current token', () => {
    expect(isReconciliationCurrent({ readToken: 2, currentToken: 2 })).toBe(true)
    expect(isReconciliationCurrent({ readToken: 3, currentToken: 2 })).toBe(true)
  })

  it('rejects a read that carries no token at all once an action has happened', () => {
    expect(isReconciliationCurrent({ readToken: null, currentToken: 1 })).toBe(false)
  })
})
