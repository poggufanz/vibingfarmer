// keeper/src/radar-runner.mjs — long-running lifeboat radar process (the keeper Worker itself
// is a 15-min cron and cannot react at ledger speed — this runner is the ledger-edge sibling).
// Run from keeper/:  node --env-file=.dev.vars src/radar-runner.mjs
// Needs the same vars the Worker uses (SOROBAN_RPC_URL, NETWORK_PASSPHRASE, VAULT_ADDRESS,
// POOL_1, USDC, STELLAR_KEEPER_SECRET) plus the optional LIFEBOAT_* / POOL_ORACLE knobs.
import { runRadar } from './radar.js';
import { defaultConfig } from './lifeboat.js';
import { readLifeboatChainState, submit } from './chain.js';

const env = process.env;
for (const key of ['SOROBAN_RPC_URL', 'NETWORK_PASSPHRASE', 'VAULT_ADDRESS', 'POOL_1', 'USDC', 'STELLAR_KEEPER_SECRET']) {
  if (!env[key]) {
    console.error(`[radar] missing required env var ${key}`);
    process.exit(1);
  }
}

async function latestLedger() {
  const res = await fetch(env.SOROBAN_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
  });
  const body = await res.json();
  return Number(body.result.sequence);
}

// Reference prices for the oracle-divergence detector. Demo: LIFEBOAT_REF_PRICE=1.0 (static).
// Real deploy: LIFEBOAT_REF_URLS=comma,separated JSON endpoints returning {"price": <number>}.
async function refPrices() {
  if (env.LIFEBOAT_REF_PRICE) return [Number(env.LIFEBOAT_REF_PRICE)];
  if (!env.LIFEBOAT_REF_URLS) return null;
  const urls = env.LIFEBOAT_REF_URLS.split(',').filter(Boolean);
  const settled = await Promise.allSettled(
    urls.map(async (u) => Number((await (await fetch(u)).json()).price)),
  );
  const prices = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  return prices.length > 0 ? prices : null;
}

console.log('[radar] lifeboat radar starting — one evaluation per ledger (~6s), 2s poll');
runRadar({
  env,
  deps: { read: readLifeboatChainState, submit, latestLedger, refPrices, log: console },
  config: defaultConfig(env),
}).catch((err) => {
  console.error('[radar] fatal:', err);
  process.exit(1);
});
