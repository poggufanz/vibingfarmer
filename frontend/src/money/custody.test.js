import { describe, it, expect } from 'vitest'
import { custodyForAgent, custodyBreakdownForAgent } from './custody.js'

const KNOWN = (units) => ({ state: 'known', amount: { token: 'USDC', units, decimals: 7 } })
const UNAVAILABLE = { state: 'unavailable', amount: null }

describe('custodyForAgent', () => {
  it('is unknown for a nullish or empty read (never invents a location)', () => {
    expect(custodyForAgent(null)).toEqual({ location: 'unknown' })
    expect(custodyForAgent(undefined)).toEqual({ location: 'unknown' })
    expect(custodyForAgent({})).toEqual({ location: 'unknown' })
  })

  it('is unknown when the scope itself could not be read, regardless of anything else', () => {
    expect(
      custodyForAgent({
        scope: { state: 'unavailable' },
        vaultShares: KNOWN('500'),
        idleToken: KNOWN('0'),
        baseChild: null,
      })
    ).toEqual({ location: 'unknown' })
  })

  it('a durable Base association wins over Stellar-side reads and passes its location through', () => {
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('0'),
        idleToken: KNOWN('0'),
        baseChild: { custody: { location: 'base-proxy' } },
      })
    ).toEqual({ location: 'base-proxy' })
  })

  it('a known-positive Stellar leg alongside a durable Base association is a genuine split -> unknown, never a guessed winner (fix loop 1, Fix 3)', () => {
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('1000000'),
        idleToken: KNOWN('0'),
        baseChild: { custody: { location: 'base-proxy' } },
      })
    ).toEqual({ location: 'unknown' })
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('0'),
        idleToken: KNOWN('500'),
        baseChild: { custody: { location: 'base-proxy' } },
      })
    ).toEqual({ location: 'unknown' })
  })

  it('an association with an unrecognized/missing custody location falls back to unknown, never a guess', () => {
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('0'),
        idleToken: KNOWN('0'),
        baseChild: { custody: { location: 'made-up' } },
      })
    ).toEqual({ location: 'unknown' })
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('0'),
        idleToken: KNOWN('0'),
        baseChild: { custody: {} },
      })
    ).toEqual({ location: 'unknown' })
  })

  it('nonzero known vault shares -> stellar-vault', () => {
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('1000000'),
        idleToken: KNOWN('0'),
        baseChild: null,
      })
    ).toEqual({ location: 'stellar-vault' })
  })

  it('zero vault shares but nonzero idle token -> agent (stranded post-redeem balance)', () => {
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('0'),
        idleToken: KNOWN('500'),
        baseChild: null,
      })
    ).toEqual({ location: 'agent' })
  })

  it('known-zero everywhere (nothing deposited, nothing stranded) -> agent, not owner or unknown', () => {
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('0'),
        idleToken: KNOWN('0'),
        baseChild: null,
      })
    ).toEqual({ location: 'agent' })
  })

  it('a partial Stellar read (one of shares/idle unavailable) -> unknown, never a guess from the other', () => {
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: UNAVAILABLE,
        idleToken: KNOWN('0'),
        baseChild: null,
      })
    ).toEqual({ location: 'unknown' })
    expect(
      custodyForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('0'),
        idleToken: UNAVAILABLE,
        baseChild: null,
      })
    ).toEqual({ location: 'unknown' })
  })
})

// Fix loop 2, Fix 1: the per-leg counterpart to custodyForAgent's collapsed 'unknown' summary.
describe('custodyBreakdownForAgent', () => {
  it('is empty for a nullish/empty read or an agent with no Base association (nothing to split)', () => {
    expect(custodyBreakdownForAgent(null)).toEqual([])
    expect(custodyBreakdownForAgent({})).toEqual([])
    expect(
      custodyBreakdownForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('1000000'),
        idleToken: KNOWN('0'),
        baseChild: null,
      })
    ).toEqual([])
  })

  it('is empty when the scope itself could not be read, even with a Base child present', () => {
    expect(
      custodyBreakdownForAgent({
        scope: { state: 'unavailable' },
        vaultShares: KNOWN('1000000'),
        idleToken: KNOWN('0'),
        baseChild: {
          custody: { location: 'base-proxy' },
          amount: { token: 'USDC', units: '500', decimals: 7 },
        },
      })
    ).toEqual([])
  })

  it('a genuine split (known-positive vault leg + known Base leg) files each under its own real location (fix loop 2, Fix 1)', () => {
    expect(
      custodyBreakdownForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('5000000'),
        idleToken: KNOWN('0'),
        baseChild: {
          custody: { location: 'base-proxy' },
          amount: { token: 'USDC', units: '5000000', decimals: 7 },
        },
      })
    ).toEqual([
      { location: 'stellar-vault', amount: { token: 'USDC', units: '5000000', decimals: 7 } },
      { location: 'base-proxy', amount: { token: 'USDC', units: '5000000', decimals: 7 } },
    ])
  })

  it('a known-positive idle leg (stranded, no vault shares) plus a Base leg also splits correctly', () => {
    expect(
      custodyBreakdownForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('0'),
        idleToken: KNOWN('500'),
        baseChild: {
          custody: { location: 'base-proxy' },
          amount: { token: 'USDC', units: '5000000', decimals: 7 },
        },
      })
    ).toEqual([
      { location: 'agent', amount: { token: 'USDC', units: '500', decimals: 7 } },
      { location: 'base-proxy', amount: { token: 'USDC', units: '5000000', decimals: 7 } },
    ])
  })

  // A leg that is genuinely unread (unavailable, not a known zero) contributes NOTHING here —
  // never fabricated as a 'stellar-vault' entry, never silently folded into the Base leg either.
  // The gap is still visible: readOwnerMoney.js's `problems` marker ('vault-shares-unavailable')
  // is what tells a consumer this leg's read was incomplete.
  it('a genuinely unread Stellar leg contributes nothing — only the known Base leg appears', () => {
    expect(
      custodyBreakdownForAgent({
        scope: { state: 'known' },
        vaultShares: UNAVAILABLE,
        idleToken: KNOWN('0'),
        baseChild: {
          custody: { location: 'base-proxy' },
          amount: { token: 'USDC', units: '4000000', decimals: 7 },
        },
      })
    ).toEqual([
      { location: 'base-proxy', amount: { token: 'USDC', units: '4000000', decimals: 7 } },
    ])
  })

  it('a Base leg whose own amount is unresolved contributes nothing, even with a known vault leg', () => {
    expect(
      custodyBreakdownForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('5000000'),
        idleToken: KNOWN('0'),
        baseChild: { custody: { location: 'base-proxy' }, amount: null },
      })
    ).toEqual([
      { location: 'stellar-vault', amount: { token: 'USDC', units: '5000000', decimals: 7 } },
    ])
  })

  // Two known legs must never BOTH collapse to 'unknown' (the pre-fix bug) — an unrecognized Base
  // custody location only taints its OWN leg, never the independently-known vault leg alongside it.
  it('an unrecognized Base custody location taints only its own leg, not the known vault leg beside it', () => {
    expect(
      custodyBreakdownForAgent({
        scope: { state: 'known' },
        vaultShares: KNOWN('5000000'),
        idleToken: KNOWN('0'),
        baseChild: {
          custody: { location: 'made-up' },
          amount: { token: 'USDC', units: '5000000', decimals: 7 },
        },
      })
    ).toEqual([
      { location: 'stellar-vault', amount: { token: 'USDC', units: '5000000', decimals: 7 } },
      { location: 'unknown', amount: { token: 'USDC', units: '5000000', decimals: 7 } },
    ])
  })
})
