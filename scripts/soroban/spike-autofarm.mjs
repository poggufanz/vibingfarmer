// scripts/soroban/spike-autofarm.mjs — read-only spike: emissions live? swap route? own pool viable?
//
// Run from repo root (cwd-independent — the SDK import below is a relative path, not a bare
// specifier, so it resolves regardless of where `node` is invoked from):
//   node scripts/soroban/spike-autofarm.mjs
// (A bare `@stellar/stellar-sdk` import only resolves when the importing FILE itself lives
// under frontend/, since Node's ESM resolver walks up node_modules from the importer's own
// path, not from process.cwd(). This script lives at scripts/soroban/, so it imports the SDK's
// ESM entry point directly out of frontend/node_modules instead.)
import {
  rpc,
  Contract,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  scValToNative,
  Address,
  nativeToScVal,
} from '../../frontend/node_modules/@stellar/stellar-sdk/lib/esm/index.js';

const RPC = 'https://soroban-testnet.stellar.org';
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF';
const USDC = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU';
const BLND = 'CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF';
const SOROSWAP_FACTORY = 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY';

// Simulation-only source account. The brief's throwaway `GAAAA...WHF5` pubkey does not exist
// on-chain, and `simulateTransaction` needs a real account (for sequence number lookup) even
// though the tx is never submitted, never signed, and costs no fees. Use the real funded
// testnet deployer identity (= `vf-deployer` / `demoAgentOwner` in deployments/stellar-testnet.json).
const SIM_SOURCE = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS';

const server = new rpc.Server(RPC);

/** JSON.stringify replacer — Blend/Soroswap return i128 values as BigInt, which
 * JSON.stringify cannot serialize natively. */
function jsonSafe(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Simulate-only invocation (no submit, no signature, no fees). */
async function simCall(contractId, method, ...args) {
  const acc = await server.getAccount(SIM_SOURCE);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
  return { value: sim.result?.retval ? scValToNative(sim.result.retval) : null };
}

console.log('=== VF Autofarm spike probe (read-only, testnet) ===');
console.log('pool =', POOL);
console.log('usdc =', USDC);
console.log('blnd =', BLND);
console.log('soroswapFactory =', SOROSWAP_FACTORY);
console.log('');

// 1) USDC reserve index → bToken reserve_token_id = index*2+1
const list = await simCall(POOL, 'get_reserve_list');
let idx = -1;
if (list.value) {
  // list.value entries are native Address objects after scValToNative — compare via toString()
  idx = list.value.findIndex((a) => (a?.toString ? a.toString() : a) === USDC);
}
console.log('STEP 1: get_reserve_list =', list.error ? `ERROR: ${jsonSafe(list.error)}` : jsonSafe(list.value?.map((a) => (a?.toString ? a.toString() : a))));
console.log('USDC_RESERVE_INDEX =', idx, idx >= 0 ? `→ bToken id = ${idx * 2 + 1}` : '(not found)');
console.log('');

// 2) emissions configured for USDC supply (b-token) reserve?
let emis = { error: 'skipped: no USDC reserve index' };
if (idx >= 0) {
  emis = await simCall(POOL, 'get_reserve_emissions', nativeToScVal(idx * 2 + 1, { type: 'u32' }));
}
const emissionsLive = !emis.error && !!emis.value;
console.log('STEP 2: get_reserve_emissions =', jsonSafe(emis));
console.log('EMISSIONS_LIVE =', emissionsLive);
console.log('');

// 3) Soroswap BLND/USDC pair + reserves
const pair = await simCall(SOROSWAP_FACTORY, 'get_pair', Address.fromString(BLND).toScVal(), Address.fromString(USDC).toScVal());
console.log('STEP 3: soroswap get_pair =', jsonSafe(pair));
let swapRoute = 'none';
if (pair.value && !pair.error) {
  const pairAddr = pair.value?.toString ? pair.value.toString() : pair.value;
  const reserves = await simCall(pairAddr, 'get_reserves');
  console.log('soroswap get_reserves =', jsonSafe(reserves));
  swapRoute = !reserves.error && reserves.value ? 'soroswap' : 'none';
}
console.log('SWAP_ROUTE =', swapRoute);
console.log('');

// 4) own-pool viability reference: read TestnetV2 pool config/status
const cfg = await simCall(POOL, 'get_config');
console.log('STEP 4 (reference): get_config =', jsonSafe(cfg));
console.log('');

console.log('=== SUMMARY ===');
console.log('EMISSIONS_LIVE =', emissionsLive);
console.log('USDC_RESERVE_INDEX =', idx);
console.log('SWAP_ROUTE =', swapRoute);
console.log('(OWN_POOL_VIABLE is determined separately via WSL stellar CLI — see Step 3 of the task brief)');
