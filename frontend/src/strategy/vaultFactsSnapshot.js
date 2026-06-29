// Dated, sourced eligibility facts. PLACEHOLDER mainnet values — replace with captured DeFiLlama
// numbers + update CAPTURED_AT before the demo (see plan §14 / refreshVaultFacts.mjs). Provenance
// honesty: asOf is the CAPTURE date, never Date.now().
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
  ...over,
})

export const SNAPSHOT = {
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
    },
    meta: { isFixture: true, label: 'demo fixture — illustrates rejection' },
  },
}
