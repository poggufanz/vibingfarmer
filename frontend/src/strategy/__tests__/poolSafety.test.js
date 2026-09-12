// frontend/src/strategy/__tests__/poolSafety.test.js
// P0 G3 pool-safety data layer: rows are projected from proved facts only; anything
// unprovable degrades row-by-row to unavailable, and every live read fails soft.
import { describe, it, expect, vi } from 'vitest'
import {
  buildPoolSafetyView,
  readPoolUtilization,
  loadPoolSafety,
  initialPoolSafetyView,
  formatUsdCompact,
  formatUtilizationBps,
} from '../poolSafety.js'

const AS_OF = 1_757_000_000_000
const field = (value, source = 'snapshot', asOf = AS_OF) => ({ value, source, asOf })

const FULL_FACTS = {
  annualizedDistributed: field(1_000_000),
  protocolRevenue: field(1_050_000),
  audit: field('audited'),
  ageDays: field(365),
  tvl: field(127_174_055),
  adminKey: field('timelock_multisig'),
  oracleType: field('circuit_breaker'),
  collateralLiquidityDepthUsd: field(1_000_000),
  poolClass: field('curated'),
  supplierConcentrationPct: field(25),
}

const rowById = (view, id) => view.rows.find((r) => r.id === id)

describe('buildPoolSafetyView (full data)', () => {
  it('projects every checklist row with value + source + freshness', () => {
    const view = buildPoolSafetyView({
      facts: FULL_FACTS,
      poolLabel: 'Blend USDC (Stellar)',
      utilization: { bps: 6532, asOf: AS_OF },
    })
    expect(view.poolLabel).toBe('Blend USDC (Stellar)')
    expect(view.rows).toHaveLength(8)
    expect(rowById(view, 'tvl')).toEqual({
      id: 'tvl',
      label: 'Total value locked',
      value: '$127.2M',
      source: 'Snapshot',
      asOf: AS_OF,
      note: null,
    })
    expect(rowById(view, 'utilization')).toEqual({
      id: 'utilization',
      label: 'Pool utilization (live)',
      value: '65.32%',
      source: 'Blend pool · live RPC',
      asOf: AS_OF,
      note: null,
    })
    expect(rowById(view, 'oracle').value).toBe('Circuit breaker')
    expect(rowById(view, 'admin').value).toBe('Timelock + multisig')
    expect(rowById(view, 'audit').value).toBe('Audited')
    expect(rowById(view, 'collateral').value).toBe('$1.0M')
    expect(rowById(view, 'concentration').value).toBe('25%')
  })

  it('labels a live TVL overlay as DeFiLlama live, never as snapshot', () => {
    const view = buildPoolSafetyView({
      facts: { ...FULL_FACTS, tvl: field(130_000_000, 'live', AS_OF + 1) },
      utilization: null,
    })
    const tvl = rowById(view, 'tvl')
    expect(tvl.value).toBe('$130.0M')
    expect(tvl.source).toBe('DeFiLlama · live')
    expect(tvl.asOf).toBe(AS_OF + 1)
  })

  it('always carries the backstop row as unavailable with an actionable note (no read exists)', () => {
    const view = buildPoolSafetyView({ facts: FULL_FACTS, utilization: { bps: 100, asOf: AS_OF } })
    const backstop = rowById(view, 'backstop')
    expect(backstop.value).toBeNull()
    expect(backstop.source).toBe('No verified source')
    expect(backstop.asOf).toBeNull()
    expect(backstop.note).toMatch(/no on-chain backstop read/i)
  })
})

describe('buildPoolSafetyView (partial / missing data)', () => {
  it('degrades row-by-row to unavailable without throwing', () => {
    const view = buildPoolSafetyView({ facts: null, utilization: null })
    expect(view.rows).toHaveLength(8)
    for (const row of view.rows) expect(row.value).toBeNull()
  })

  it('passes through unknown enum values verbatim rather than dropping the row', () => {
    const view = buildPoolSafetyView({
      facts: { ...FULL_FACTS, oracleType: field('stellar-reflector-v2') },
      utilization: null,
    })
    expect(rowById(view, 'oracle').value).toBe('stellar-reflector-v2')
  })
})

describe('formatters', () => {
  it('formatUsdCompact compacts and rejects non-positive/non-numeric input', () => {
    expect(formatUsdCompact(127_174_055)).toBe('$127.2M')
    expect(formatUsdCompact(2_500_000_000)).toBe('$2.5B')
    expect(formatUsdCompact(999)).toBe('$999')
    expect(formatUsdCompact(0)).toBeNull()
    expect(formatUsdCompact(-5)).toBeNull()
    expect(formatUsdCompact(NaN)).toBeNull()
    expect(formatUsdCompact('100')).toBeNull()
  })

  it('formatUtilizationBps bounds to 0..10000 bps', () => {
    expect(formatUtilizationBps(6532)).toBe('65.32%')
    expect(formatUtilizationBps(0)).toBe('0.00%')
    expect(formatUtilizationBps(10_000)).toBe('100.00%')
    expect(formatUtilizationBps(10_001)).toBeNull()
    expect(formatUtilizationBps(-1)).toBeNull()
    expect(formatUtilizationBps(null)).toBeNull()
  })
})

describe('readPoolUtilization (live reserve read)', () => {
  const reserve = (bSupply, dSupply) => ({
    data: {
      b_supply: String(bSupply),
      b_rate: '1000000000000',
      d_supply: String(dSupply),
      d_rate: '1000000000000',
    },
  })

  it('computes utilization bps from get_reserve with a read timestamp', async () => {
    const readContractImpl = vi.fn(async () => reserve(1_000_0000000, 653_2000000))
    const out = await readPoolUtilization({
      poolAddress: 'CPOOL',
      tokenAddress: 'CTOKEN',
      readContractImpl,
      nowMs: AS_OF,
    })
    expect(out).toEqual({ bps: 6532, asOf: AS_OF })
    expect(readContractImpl).toHaveBeenCalledWith({
      contract: 'CPOOL',
      method: 'get_reserve',
      args: [{ addr: 'CTOKEN' }],
      server: undefined,
    })
  })

  it('fails soft to null on RPC failure or an empty pool (never a 0% guess)', async () => {
    await expect(
      readPoolUtilization({ readContractImpl: async () => { throw new Error('rpc down') } })
    ).resolves.toBeNull()
    await expect(
      readPoolUtilization({ readContractImpl: async () => reserve(0, 0) })
    ).resolves.toBeNull()
  })
})

describe('loadPoolSafety (composer)', () => {
  it('composes resolved facts with live utilization', async () => {
    const view = await loadPoolSafety({
      resolveImpl: () => ({ facts: FULL_FACTS }),
      readContractImpl: async () => ({
        data: {
          b_supply: '10000000000',
          b_rate: '1000000000000',
          d_supply: '5000000000',
          d_rate: '1000000000000',
        },
      }),
      nowMs: AS_OF,
    })
    expect(rowById(view, 'tvl').value).toBe('$127.2M')
    expect(rowById(view, 'utilization').value).toBe('50.00%')
  })

  it('never throws: a failed resolve still yields an all-unavailable view', async () => {
    const view = await loadPoolSafety({
      resolveImpl: () => { throw new Error('no eligibility facts') },
      readContractImpl: async () => { throw new Error('rpc down') },
    })
    expect(view.rows).toHaveLength(8)
    for (const row of view.rows) expect(row.value).toBeNull()
  })
})

describe('initialPoolSafetyView (snapshot first paint)', () => {
  it('resolves the real blend-usdc snapshot with zero I/O', () => {
    const view = initialPoolSafetyView()
    expect(view.poolLabel).toBe('Blend USDC (Stellar)')
    expect(rowById(view, 'tvl').value).toBe('$127.2M')
    // Live-only rows start unavailable until the explicit refresh.
    expect(rowById(view, 'utilization').value).toBeNull()
    expect(rowById(view, 'backstop').value).toBeNull()
  })
})
