// Curated eligibility facts. NUMERIC facts (tvl) are live-refreshed at runtime by vaultFactsLive.js
// (DeFiLlama), which overlays them at resolve() time; this module is the QUALITATIVE source of
// record (audit, adminKey, oracleType, poolClass — no public API states these reliably) AND the
// offline fallback when the live fetch fails. refreshVaultFacts.mjs remains the offline snapshot
// updater. Provenance honesty: asOf is the CAPTURE date, never Date.now().
export const CAPTURED_AT = Date.parse('2026-06-28T00:00:00Z')

const f = (value) => ({ value, source: 'snapshot', asOf: CAPTURED_AT })

// Audited lending protocols (catalog universe). Distributions ~ revenue => ratio ~1 => real.
const audited = (over) => ({
  annualizedDistributed: f(1_000_000),
  protocolRevenue: f(1_050_000),
  audit: f('audited'),
  ageDays: f(365),
  tvl: f(25_000_000),
  adminKey: f('timelock_multisig'),
  // Lifeboat F8 facts — PLACEHOLDER snapshot values (same provenance discipline as above);
  // verify via refreshVaultFacts.mjs before the demo.
  oracleType: f('circuit_breaker'),
  collateralLiquidityDepthUsd: f(1_000_000),
  poolClass: f('curated'),
  supplierConcentrationPct: f(25),
  ...over,
})

export const SNAPSHOT = {
  // The product's own vetted vault (single-chain Stellar/Soroban Blend USDC). Same
  // PLACEHOLDER-provenance discipline as the rest — refresh before demo.
  'blend-usdc': { facts: audited(), meta: { label: 'Blend USDC (Stellar)' } },
  'aave-v3': { facts: audited(), meta: { label: 'Aave v3 (mainnet)' } },
  'morpho-blue': {
    facts: audited({ tvl: f(12_000_000), adminKey: f('multisig') }),
    meta: { label: 'Morpho Blue (mainnet)' },
  },
  'pendle-v2': {
    facts: audited({ ageDays: f(540), tvl: f(8_000_000) }),
    meta: { label: 'Pendle (mainnet)' },
  },
  fluid: {
    facts: audited({ tvl: f(5_000_000), adminKey: f('multisig') }),
    meta: { label: 'Fluid (mainnet)' },
  },
  // Controlled demo fixture — illustrates rejection. NOT a real vault.
  hyperfarm: {
    facts: {
      annualizedDistributed: f(10_000_000),
      protocolRevenue: f(3_000_000),
      audit: f('none'),
      ageDays: f(4),
      tvl: f(50_000),
      adminKey: f('eoa'),
      oracleType: f('vwap_no_breaker'),
      collateralLiquidityDepthUsd: f(40_000),
      poolClass: f('community'),
      supplierConcentrationPct: f(80),
    },
    meta: { isFixture: true, label: 'Demo fixture rejected by eligibility checks' },
  },
}
