import { describe, it, expect } from 'vitest'
import { mintToken, verifyToken, MAX_TOKEN_AGE_MS } from './eligibilityGate.js'

const verdict = {
  protocol: 'aave-v3',
  eligible: true,
  yieldReality: { verdict: 'real' },
  security: { score: 92, auditGate: 'pass' },
}
const NOW = 1_900_000_000_000

describe('eligibility token', () => {
  it('mints for an eligible verdict and verifies', () => {
    const t = mintToken(verdict, 0, NOW)
    expect(t.eligible).toBe(true)
    expect(verifyToken(t, verdict, NOW)).toBe(true)
  })
  it('rejects a stale token', () => {
    const t = mintToken(verdict, 0, NOW - MAX_TOKEN_AGE_MS - 1)
    expect(verifyToken(t, verdict, NOW)).toBe(false)
  })
  it('rejects a verdictHash mismatch (tampered score)', () => {
    const t = mintToken(verdict, 0, NOW)
    expect(verifyToken(t, { ...verdict, security: { score: 10, auditGate: 'pass' } }, NOW)).toBe(
      false
    )
  })
  it('refuses to mint for an ineligible verdict', () => {
    expect(() => mintToken({ ...verdict, eligible: false }, 0, NOW)).toThrow()
  })
})
