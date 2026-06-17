import { describe, it, expect } from 'vitest'
import { toAuthorizeArgs, toSummary, maxAtRisk } from './permissionScope.js'

const scope = {
  agent: '0xBEEF', vault: '0xVault', token: '0xToken',
  capPerPeriod: 100_000000n, periodDuration: 86400, expiry: 1_900_000_000,
  nowSec: 1_899_827_200, // ~2 days before expiry
}

describe('permissionScope single source', () => {
  it('serializes the SAME numbers the UI shows', () => {
    const args = toAuthorizeArgs(scope)
    const summary = toSummary(scope)
    expect(args[3]).toBe(scope.capPerPeriod)          // capPerPeriod arg
    expect(summary.capPerPeriod).toBe(scope.capPerPeriod)
    expect(args[2]).toBe(scope.token)                 // token arg
  })

  it('max-at-risk = cap × ceil((expiry-now)/period) — boundary (exact 2 periods)', () => {
    // (1_900_000_000 - 1_899_827_200) = 172800s = exactly 2 days → ceil(2) = 2 periods
    expect(maxAtRisk(scope)).toBe(200_000000n)
  })

  it('max-at-risk rounds UP a partial period (proves ceil, not floor)', () => {
    // 172801s = 2 days + 1s → ceil(2.0000…) = 3 periods. floor would give 2 and pass the
    // boundary test above — this case is the one that actually distinguishes ceil from floor.
    const partial = { ...scope, expiry: scope.nowSec + 172_801 }
    expect(maxAtRisk(partial)).toBe(300_000000n)
  })

  it('throws if capPerPeriod is not a bigint (single-source means single-TYPE)', () => {
    expect(() => maxAtRisk({ ...scope, capPerPeriod: 100_000000 })).toThrow()
  })

  it('refuses to derive args from an unapproved scope', () => {
    expect(() => toAuthorizeArgs({ ...scope, approvedByUser: false })).toThrow()
  })
})
