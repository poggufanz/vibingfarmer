import { describe, it, expect } from 'vitest'
import { validateStrategyResponse } from './strategist.js'
import { buildMergedCatalog } from './strategy/mergedCatalog.js'
import { BASE_POOL_CATALOG } from './config.js'

// NOTE: the base address is read from BASE_POOL_CATALOG rather than hardcoded, because
// vite.config.js's `test.env` stubs VITE_BASE_POOL_*_ADDRESS to throwaway 0x111...11N
// placeholders under vitest — a literal mainnet/testnet-looking address here would never
// actually appear in the vitest-built merged catalog and the "accepts" case below would
// falsely fail as hallucinated. See task-3-report.md deviations section.
const STELLAR_ADDRESS = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const BASE_ADDRESS = BASE_POOL_CATALOG[0].address

const mixedResponse = () => ({
  strategy_summary: 'mix',
  rationale: 'diversified across chains for yield and resilience',
  selected_vaults: [
    {
      address: STELLAR_ADDRESS,
      allocation: 0.6,
      expected_apy: 4.8,
      risk_tier: 'low',
      reasoning: 'battle-tested stellar lending vault with deep liquidity',
    },
    {
      address: BASE_ADDRESS,
      allocation: 0.4,
      expected_apy: 5.1,
      risk_tier: 'low',
      reasoning: 'base-side aave pool balances the stellar concentration',
    },
  ],
})

describe('chain-aware validateStrategyResponse', () => {
  it('accepts a mixed allocation against the merged catalog and stamps chain', () => {
    const catalog = buildMergedCatalog({ baseAvailable: true }).map((v, i) =>
      i === 0 ? { ...v, address: STELLAR_ADDRESS } : v
    )
    const out = validateStrategyResponse(mixedResponse(), catalog)
    expect(out.selected_vaults[0].chain).toBe('stellar')
    expect(out.selected_vaults[1].chain).toBe('base')
  })
  it('rejects a base address when catalog is stellar-only (fail-closed)', () => {
    const catalog = buildMergedCatalog({ baseAvailable: false })
    expect(() => validateStrategyResponse(mixedResponse(), catalog)).toThrow(/hallucinated/)
  })
  it('snaps an LLM-mangled address casing back to the catalog canonical string', () => {
    // LLMs mangle hex casing; a mixed-case address that fails EIP-55 is rejected by viem at
    // the first contract read (live 2026-07-20, mandate stage). Membership check is
    // case-insensitive — the kept string must be the CATALOG's, never the model's.
    const catalog = buildMergedCatalog({ baseAvailable: true }).map((v, i) =>
      i === 0 ? { ...v, address: STELLAR_ADDRESS } : v
    )
    const r = mixedResponse()
    r.selected_vaults[1].address = BASE_ADDRESS.toUpperCase().replace('0X', '0x')
    const out = validateStrategyResponse(r, catalog)
    expect(out.selected_vaults[1].address).toBe(BASE_ADDRESS)
  })
})
