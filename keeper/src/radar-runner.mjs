// keeper/src/radar-runner.mjs — long-running lifeboat radar process (the keeper Worker itself
// is a 15-min cron and cannot react at ledger speed — this runner is the ledger-edge sibling).
// Run from keeper/:  node --env-file=.dev.vars src/radar-runner.mjs
// Needs the same vars the Worker uses (SOROBAN_RPC_URL, NETWORK_PASSPHRASE, VAULT_ADDRESS,
// POOL_1, USDC, STELLAR_KEEPER_SECRET) plus the optional LIFEBOAT_* / POOL_ORACLE knobs.
import { runRadar } from './radar.js';
import { defaultConfig } from './lifeboat.js';
import { readLifeboatChainState, submit } from './chain.js';
import { createRefPrices } from './refprices.js';

const env = process.env;
for (const key of ['SOROBAN_RPC_URL', 'NETWORK_PASSPHRASE', 'VAULT_ADDRESS', 'POOL_1', 'USDC', 'STELLAR_KEEPER_SECRET']) {
  if (!env[key]) {
    console.error(`[radar] missing required env var ${key}`);
    process.exit(1);
  }
}

async function latestLedger() {
  // 5s abort so a hung RPC can never blind the ~6s reaction loop for undici's ~5-min
  // default headersTimeout — the runRadar catch retries on the next poll.
  const res = await fetch(env.SOROBAN_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json();
  return Number(body.result.sequence);
}

// Reference prices for the oracle-divergence detector — real feeds (per-URL #dot.path fragment,
// 60s cache, all-failed -> null). Demo: LIFEBOAT_REF_PRICE=1.0 (static). See refprices.js.
const refPrices = createRefPrices(env);

console.log('[radar] lifeboat radar starting — one evaluation per ledger (~6s), 2s poll');
runRadar({
  env,
  deps: { read: readLifeboatChainState, submit, latestLedger, refPrices, log: console },
  config: defaultConfig(env),
}).catch((err) => {
  console.error('[radar] fatal:', err);
  process.exit(1);
});
