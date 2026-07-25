import { describe, it, expect } from 'vitest'
import { custodyForAgent } from './custody.js'

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
