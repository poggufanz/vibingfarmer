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

  it('treats a future checkedAt (clock skew) as current, never a crash', () => {
    expect(classifyFreshness({ checkedAt: 5000, now: 1000 })).toBe('current')
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
