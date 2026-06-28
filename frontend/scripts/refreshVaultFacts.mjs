// OFF the demo path. Run manually before the demo to capture DeFiLlama mainnet Blend numbers, then
// hand-update vaultFactsSnapshot.js with the printed values + a new CAPTURED_AT. Never called at runtime.
// Usage: node frontend/scripts/refreshVaultFacts.mjs
const DEFILLAMA = 'https://api.llama.fi' // protocol TVL; revenue via /summary/fees endpoints
async function main() {
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
