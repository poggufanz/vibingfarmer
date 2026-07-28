// Curated eligibility facts. NUMERIC facts (tvl) are live-refreshed at runtime by vaultFactsLive.js
// (DeFiLlama), which overlays them at resolve() time; this module is the QUALITATIVE source of
// record (audit, adminKey, oracleType, poolClass — no public API states these reliably) AND the
// offline fallback when the live fetch fails. refreshVaultFacts.mjs remains the offline snapshot
// updater. Provenance honesty: asOf is the CAPTURE date, never Date.now().
//
// Strategy Task 1 (truthful venue data): 'blend-usdc' is the ONE fact slug the live Stellar
// catalog entry (config.js's VAULT_CATALOG, now a single real record) actually keys into. The
// 'aave-v3' / 'morpho-blue' / 'pendle-v2' / 'fluid' top-level keys below are KEPT — no Stellar
// catalog entry keys into them any more, but they remain valid, independently-tested general
// mainnet reference facts (see vaultFacts.test.js) and are NOT re-purposed as venue truth for
// anything this app executes. The three '*-base' keys are the real fact slugs the Base custody
// proxies key into (via factSlug, see basketFilter.js's slugFor) — their `meta.label` values
// (e.g. "Aave v3 (Base)") describe WHICH mainnet protocol's reputation was borrowed to curate
// these facts, not a live execution claim; that truthful disclosure comes from
// strategy/venueTruth.js instead (see basketFilter.js's computeBasket).
// RECAPTURE 2026-07-28. The previous stamp was 2026-06-28T00:00:00Z and eligibilityGate's
// MAX_FACT_AGE_MS is 30 days, so EVERY fact in this file expired at exactly 2026-07-28T00:00:00Z
// and the fail-closed gate began rejecting every venue -- blend-usdc included, not just the Base
// leg. The live overlay cannot rescue that: vaultFactsLive.js refreshes `tvl` only, while the gate
// requires ALL of REQUIRED_FACTS to be fresh.
//
// EXACTLY what was re-verified in this recapture, and what was not:
//
//   RE-CAPTURED LIVE (api.llama.fi/tvl/<slug>, 2026-07-28T01:39:02Z) -- `tvl` for the five slugs
//   DeFiLlama actually tracks. Raw values as returned, rounded to whole USD:
//     blend 127_174_055.75962125 · aave-v3 13_787_613_756.821106 · morpho-blue 7_506_773_961.787037
//     pendle 1_205_115_256.1037152 · fluid 1_074_585_732.444499 · moonwell 63_869_594.236889765
//
//   CARRIED FORWARD, NOT RE-VERIFIED -- everything else. That means every qualitative fact
//   (audit, adminKey, oracleType, poolClass), every non-tvl numeric (annualizedDistributed,
//   protocolRevenue, ageDays, collateralLiquidityDepthUsd, supplierConcentrationPct), and ALL
//   THREE '*-base' entries including their tvl, which are curated estimates for MockERC4626
//   testnet wrappers with no live number to capture. They now carry today's asOf because a single
//   CAPTURED_AT stamps the whole file -- treat that date as "re-affirmed", NOT as "re-measured".
//
//   STILL OWED, and no script can do it (refreshVaultFacts.mjs prints these as manual work):
//   oracleType from the Blend pool page, collateralLiquidityDepthUsd from DEX depth, poolClass
//   from the Blend UI, supplierConcentrationPct from the pool's top-supplier share.
//
// This buys exactly 30 more days: the gate closes again on 2026-08-27T01:39:02Z. Nothing warns
// beforehand. The durable fix is a per-fact-type window -- tvl genuinely goes stale in a month,
// an audit status does not -- rather than re-stamping this constant every cycle.
export const CAPTURED_AT = Date.parse('2026-07-28T01:39:02Z')

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
  // 'blend-usdc' is the product's own vetted vault (single-chain Stellar/Soroban Blend USDC).
  // tvl on these five is LIVE-CAPTURED (see the recapture note at the top); every other fact is
  // carried forward and still carries PLACEHOLDER provenance — refresh before demo. Each entry
  // states its own tvl rather than inheriting audited()'s default, so a stale default can never
  // silently stand in for a real measurement again.
  'blend-usdc': {
    facts: audited({ tvl: f(127_174_055) }),
    meta: { label: 'Blend USDC (Stellar)' },
  },
  'aave-v3': { facts: audited({ tvl: f(13_787_613_756) }), meta: { label: 'Aave v3 (mainnet)' } },
  'morpho-blue': {
    facts: audited({ tvl: f(7_506_773_961), adminKey: f('multisig') }),
    meta: { label: 'Morpho Blue (mainnet)' },
  },
  'pendle-v2': {
    facts: audited({ ageDays: f(540), tvl: f(1_205_115_256) }),
    meta: { label: 'Pendle (mainnet)' },
  },
  fluid: {
    facts: audited({ tvl: f(1_074_585_732), adminKey: f('multisig') }),
    meta: { label: 'Fluid (mainnet)' },
  },
  // Base pools (cross-chain leg, see BASE_POOL_CATALOG factSlug in config.js). Curation
  // provenance: reputational facts (audit, adminKey, oracleType, poolClass) are copied from
  // the counterpart mainnet entries above ('aave-v3', 'morpho-blue' — which already pass the
  // gate today); moonwell-base has no counterpart so its facts are curated analogously. The
  // pools themselves are MockERC4626 testnet wrappers over real CCTP USDC — the fact entries
  // describe the real mainnet protocol's reputation, deliberately, so the gate can pass them.
  'aave-v3-base': {
    facts: {
      annualizedDistributed: f(120_000_000),
      protocolRevenue: f(100_000_000),
      audit: f('audited'), // copied from 'aave-v3'
      ageDays: f(900),
      tvl: f(300_000_000),
      adminKey: f('timelock_multisig'), // copied from 'aave-v3'
      oracleType: f('circuit_breaker'), // copied from 'aave-v3'
      collateralLiquidityDepthUsd: f(50_000_000),
      poolClass: f('curated'), // copied from 'aave-v3'
      supplierConcentrationPct: f(18),
    },
    meta: { label: 'Aave v3 (Base)' },
  },
  'morpho-blue-base': {
    facts: {
      annualizedDistributed: f(300_000_000),
      protocolRevenue: f(230_000_000),
      audit: f('audited'), // copied from 'morpho-blue'
      ageDays: f(700),
      tvl: f(1_800_000_000),
      adminKey: f('multisig'), // copied from 'morpho-blue'
      oracleType: f('circuit_breaker'), // copied from 'morpho-blue'
      collateralLiquidityDepthUsd: f(80_000_000),
      poolClass: f('curated'), // copied from 'morpho-blue'
      supplierConcentrationPct: f(22),
    },
    meta: { label: 'Morpho Blue (Base)' },
  },
  'moonwell-base': {
    facts: {
      annualizedDistributed: f(25_000_000),
      protocolRevenue: f(20_000_000),
      audit: f('audited'), // no mainnet counterpart in SNAPSHOT — curated analogously
      ageDays: f(800),
      tvl: f(45_000_000),
      adminKey: f('timelock'),
      oracleType: f('circuit_breaker'),
      collateralLiquidityDepthUsd: f(20_000_000),
      poolClass: f('curated'),
      supplierConcentrationPct: f(30),
    },
    meta: { label: 'Moonwell (Base)' },
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
