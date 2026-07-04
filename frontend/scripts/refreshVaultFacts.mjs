// OFF the demo path. Run manually before the demo to capture DeFiLlama mainnet Blend numbers, then
// hand-update vaultFactsSnapshot.js with the printed values + a new CAPTURED_AT. Never called at runtime.
// Usage: node frontend/scripts/refreshVaultFacts.mjs
const DEFILLAMA = 'https://api.llama.fi' // protocol TVL; revenue via /summary/fees endpoints
async function main() {
  // Printed unconditionally (before the try) so the reminder still shows even when the
  // DeFiLlama fetch below fails and the catch block exits early — these facts aren't sourced
  // from DeFiLlama anyway; they need a human to check the Blend UI / DEX depth directly.
  console.log('[lifeboat F8] manual-verify before demo (sources → snapshot values):')
  console.log('  oracleType: Blend pool page → oracle contract type (circuit_breaker | vwap_no_breaker)')
  console.log('  collateralLiquidityDepthUsd: DeFiLlama / DEX depth for the pool collateral assets')
  console.log('  poolClass: Blend UI → curated (Blend-managed) vs community pool')
  console.log('  supplierConcentrationPct: top supplier share of pool supply (Blend pool page)')
  try {
    const res = await fetch(`${DEFILLAMA}/tvl/blend`)
    const tvl = await res.json()
    console.log('Captured Blend TVL:', tvl, '— paste into vaultFactsSnapshot.js and bump CAPTURED_AT')
  } catch (err) {
    console.error('refresh failed — keep the existing dated snapshot:', err.message)
    process.exit(0) // non-fatal: the committed snapshot remains the source of truth
  }
}
main()
