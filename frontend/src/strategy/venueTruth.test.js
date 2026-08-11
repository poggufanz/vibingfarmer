import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  VENUE_KINDS,
  normalizeVenue,
  venueYield,
  venueDisclosure,
  isLiveYieldVenue,
  assertExecutableVenue,
} from './venueTruth.js'
import { VAULT_CATALOG, BASE_POOL_CATALOG } from '../config.js'
import { SOROBAN_ACTIVE_VAULT_ADDRESS } from '../stellar/config.js'

const FAKE_PERSONAS = ['aave-v3', 'morpho-blue', 'pendle-v2', 'fluid']

describe('VAULT_CATALOG — exactly one truthful Stellar venue', () => {
  it('contains exactly one record', () => {
    expect(VAULT_CATALOG).toHaveLength(1)
  })
  it('is "Vibing Farmer Autofarm" at SOROBAN_ACTIVE_VAULT_ADDRESS', () => {
    expect(VAULT_CATALOG[0].name).toBe('Vibing Farmer Autofarm')
    expect(VAULT_CATALOG[0].address).toBe(SOROBAN_ACTIVE_VAULT_ADDRESS)
  })
  it('carries no Aave/Morpho/Pendle/Fluid persona protocol slug', () => {
    for (const entry of VAULT_CATALOG) {
      expect(FAKE_PERSONAS).not.toContain(entry.protocol)
    }
  })
})

describe('normalizeVenue — Stellar-live', () => {
  const record = normalizeVenue(VAULT_CATALOG[0])

  it('stamps the real destination, networkId, and venueKind', () => {
    expect(record.destination).toBe('Autofarm Vault to Blend Capital v2')
    expect(record.networkId).toBe('stellar-testnet')
    expect(record.venueKind).toBe(VENUE_KINDS.STELLAR_LIVE)
    expect(record.address).toBe(SOROBAN_ACTIVE_VAULT_ADDRESS)
  })

  it('never elevates a static/flat apy field to live yield', () => {
    // VAULT_CATALOG's entry may carry a flat `apy` (an "expected" figure other, out-of-scope UI
    // surfaces still render) -- the truth guard must not present that as current/live yield.
    expect(venueYield(VAULT_CATALOG[0])).toEqual({ state: 'unavailable', apy: null })
    expect(isLiveYieldVenue(VAULT_CATALOG[0])).toBe(false)
  })

  it('treats a flat catalog APY as unavailable and only accepts nested live evidence', () => {
    const stellar = { ...VAULT_CATALOG[0] }
    expect(venueYield({ ...stellar, apy: 4.8 })).toEqual({ state: 'unavailable', apy: null })
    expect(
      venueYield({ ...stellar, yield: { state: 'live', apy: 4.8, asOf: Date.now() } })
    ).toEqual({ state: 'live', apy: 4.8 })
  })

  it('documents that DeFiLlama APY is not execution-venue evidence', () => {
    const source = readFileSync(fileURLToPath(new URL('./venueTruth.js', import.meta.url)), 'utf8')
    expect(source).toContain(
      'Flat DeFiLlama APY is reference-market data, not live yield evidence for the Autofarm-to-Blend execution venue.'
    )
  })

  it('reports live yield only for an explicit, fresh {state:"live"} shape', () => {
    const now = 1_800_000_000_000
    expect(venueYield({ venueKind: 'stellar-live', yield: { state: 'live', apy: 5.5 } })).toEqual({
      state: 'live',
      apy: 5.5,
    })
    expect(
      isLiveYieldVenue({ venueKind: 'stellar-live', yield: { state: 'live', apy: 5.5 } })
    ).toBe(true)
    // stale live yield falls back to unavailable, not 0
    const stale = normalizeVenue(
      {
        venueKind: 'stellar-live',
        yield: { state: 'live', apy: 5.5, asOf: now - 7 * 60 * 60 * 1000 },
      },
      { now }
    )
    expect(stale.yield).toEqual({ state: 'unavailable', apy: null })
  })

  it('never reports 0 for absent yield', () => {
    const y = venueYield({ venueKind: 'stellar-live' })
    expect(y.apy).not.toBe(0)
    expect(y).toEqual({ state: 'unavailable', apy: null })
  })
})

describe('BASE_POOL_CATALOG — custody-only proxy truth', () => {
  it('keeps the three deployed pool addresses for execution', () => {
    expect(BASE_POOL_CATALOG).toHaveLength(3)
    for (const p of BASE_POOL_CATALOG) {
      expect(p.address).toMatch(/^0x[a-fA-F0-9]{40}$/)
      expect(p.factSlug).toBeTruthy()
    }
  })

  it('normalizes each entry to the brief-specified proxy shape', () => {
    for (const p of BASE_POOL_CATALOG) {
      const v = normalizeVenue(p)
      expect(v.venueKind).toBe('base-custody-proxy')
      expect(v.networkId).toBe('base-sepolia')
      expect(['aave-v3', 'morpho-blue', 'moonwell']).toContain(v.proxyTarget)
      expect(v.protocol).toBe('vf-erc4626-proxy')
      expect(v.yield).toEqual({ state: 'none', apy: null })
      expect(v.disclosure).toBe('Base Sepolia proxy. Custody only. No protocol yield.')
    }
  })

  it('a supplied apy: 99 still normalizes to yield.state="none", apy=null', () => {
    const poisoned = { ...BASE_POOL_CATALOG[0], apy: 99, venueKind: 'base-custody-proxy' }
    const v = normalizeVenue(poisoned)
    expect(v.yield).toEqual({ state: 'none', apy: null })
    expect(isLiveYieldVenue(poisoned)).toBe(false)
  })

  it('never describes the proxy as live Aave/Morpho/Moonwell in its disclosure', () => {
    for (const p of BASE_POOL_CATALOG) {
      const disclosure = venueDisclosure(p)
      for (const persona of ['Aave', 'Morpho', 'Moonwell', 'Fluid', 'Pendle']) {
        expect(disclosure).not.toContain(persona)
      }
    }
  })
})

describe('normalizeVenue — discriminates records with no venueKind (review fix)', () => {
  // app.jsx builds each agent's `vault` record by hand-picking fields (name/protocol/apy/addr/
  // factSlug/chain) — it never sets venueKind. Before this fix, any such record fell through to
  // the Stellar-live default, so a real Base custody-proxy agent's disclosure lied and claimed
  // "supplies to Blend Capital v2 on Stellar testnet."
  it('an app.jsx-shaped Base vault record (chain/factSlug/addr, no venueKind) normalizes to base-custody-proxy', () => {
    const appShapedBaseVault = {
      name: 'Aave v3 USDC (Base)',
      protocol: 'vf-erc4626-proxy',
      apy: '4.8',
      drawdown: '-1.8',
      risk: 'low',
      addr: '0x389250872044368759D3db5C09b2706A6628d4e0',
      tvl: 'N/A',
      factSlug: 'aave-v3-base',
      chain: 'base',
    }
    const v = normalizeVenue(appShapedBaseVault)
    expect(v.venueKind).toBe(VENUE_KINDS.BASE_CUSTODY_PROXY)
    expect(v.address).toBe('0x389250872044368759D3db5C09b2706A6628d4e0')
    expect(v.disclosure).toBe('Base Sepolia proxy. Custody only. No protocol yield.')
    expect(venueDisclosure(appShapedBaseVault)).not.toContain('Stellar')
  })

  it('throws rather than guess when a record carries contradictory network signals', () => {
    const contradictory = { chain: 'base', address: SOROBAN_ACTIVE_VAULT_ADDRESS }
    expect(() => normalizeVenue(contradictory)).toThrow(/contradictory/)
  })

  it('a bare/incomplete record with no network signal at all still defaults to stellar-live (unchanged)', () => {
    // No chain, no factSlug, no address -- there is nothing to discriminate on, so this is not
    // the "contradictory signals" case above; existing fixture-style callers (e.g. enforcementA
    // tests' `{ protocol, addr: 'C...' }`) rely on this staying the safe default.
    expect(normalizeVenue({ protocol: 'aave-v3', addr: 'C...' }).venueKind).toBe(
      VENUE_KINDS.STELLAR_LIVE
    )
  })
})

describe('assertExecutableVenue', () => {
  it('returns the normalized record for a venue with an address', () => {
    expect(assertExecutableVenue(VAULT_CATALOG[0]).venueKind).toBe('stellar-live')
  })
  it('throws for a venue with no execution address', () => {
    expect(() => assertExecutableVenue({ name: 'Nowhere' })).toThrow(/no execution address/)
  })
})

describe('BASE_PROXY_DISCLOSURE stays equal to the Foundation VenueTruth primitive', () => {
  // APPROVED-RULING OVERRIDE: the brief's own example disclosure string used two middle dots
  // ('Base Sepolia proxy · custody only · no protocol yield'), which conflicts with the ruling
  // that a line carries at most one middle dot. The sentence form below is what Foundation's
  // `VenueTruth` component (frontend/src/components/pocket/Primitives.jsx) already uses as its
  // BASE_PROXY_COPY constant -- this test reads that file's source text directly (it exports no
  // such constant, and is out of this task's file list to change) so the two literals are proven
  // to stay equal without importing the design/JSX layer into this pure data module.
  it('matches Primitives.jsx BASE_PROXY_COPY verbatim', () => {
    const primitivesPath = fileURLToPath(
      new URL('../components/pocket/Primitives.jsx', import.meta.url)
    )
    const source = readFileSync(primitivesPath, 'utf8')
    // Anchored on the actual assignment, not a bare substring match -- a bare `toContain` would
    // still false-pass if BASE_PROXY_COPY were renamed/removed while the string lived on elsewhere
    // (e.g. in a comment); this only passes while the constant itself still holds this value.
    expect(source).toContain(
      "const BASE_PROXY_COPY = 'Base Sepolia proxy. Custody only. No protocol yield.'"
    )
    expect(venueDisclosure({ venueKind: 'base-custody-proxy' })).toBe(
      'Base Sepolia proxy. Custody only. No protocol yield.'
    )
  })
})
