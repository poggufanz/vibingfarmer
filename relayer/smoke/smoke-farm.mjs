// Live testnet smoke for the forward leg: simulates the user's burn (approveAndBurnStellar,
// dev-only), then drives the SAME farm() the production API will call. Requires SMOKE_* env
// vars (a throwaway dev keypair playing the "user") in addition to the relayer's own config.
// Requires an SP3 mandate approval already produced (SMOKE_SESSION_APPROVAL) and the ZeroDev
// paymaster's gas-sponsorship policy configured for Base Sepolia (deploy-checklist item).
// Run: node --env-file=.dev.vars smoke/smoke-farm.mjs
import { writeFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.mjs';
import { approveAndBurnStellar } from '../src/cctp/forward.mjs';
import { createWatcher } from '../src/cctp/watcher.mjs';
import { createOrchestrator } from '../src/base/orchestrator.mjs';
import { createFarmFlow } from '../src/flows/farm.mjs';
import { MIN_FINALITY_STANDARD, MAX_FEE_STANDARD } from '../src/cctp/constants.mjs';

const E = process.env;
const need = (k) => { if (!E[k] || /FILL_ME/.test(E[k])) throw new Error(`env ${k} missing/unfilled`); return E[k]; };

async function main() {
  const config = loadConfig(E);
  const smokeKp = Keypair.fromSecret(need('SMOKE_STELLAR_SECRET'));
  const smokePub = need('SMOKE_STELLAR_PUBLIC');
  const approval = need('SMOKE_SESSION_APPROVAL'); // produced by an SP3 mandate ceremony ahead of this run
  const sessionPrivateKey = need('SMOKE_SESSION_PRIVKEY');

  console.log('[1/3] Stellar burn (simulating the user passkey signature)...');
  const burnTxHash = await approveAndBurnStellar({
    server: config.stellar.server, kp: smokeKp, sourcePub: smokePub, passphrase: config.stellar.passphrase,
    tokenMessengerMinter: config.stellar.tokenMessengerMinter, usdcSac: config.stellar.usdcSac,
    amount7dp: 10_000_000n, allowance7dp: 100_000_000n,
    baseRecipient: config.base.walletClient.account.address,
    destDomain: config.domains.base, minFinality: MIN_FINALITY_STANDARD, maxFee: MAX_FEE_STANDARD,
  });
  console.log('  burn tx:', burnTxHash);

  const watcher = createWatcher(config);
  const orchestrator = createOrchestrator({
    chain: config.base.chain, rpcUrl: config.base.rpcUrl, bundlerRpcUrl: config.base.bundlerRpcUrl,
    yieldRouterAddress: config.base.yieldRouterAddress, sessionPrivateKey,
  });
  const { farm } = createFarmFlow({ watcher, orchestrator, domains: config.domains });

  console.log('[2-3/3] relay mint + dispatch deposits...');
  const result = await farm({
    burnTxHash, execId: `smoke-farm-${burnTxHash}`, approval,
    allocations: [{ pool: config.base.yieldRouterAddress, amount: 10_000_000n, minShares: 1n }],
  });

  const summary = `## Farm smoke — ${new Date().toISOString()}\n- Stellar burn: ${burnTxHash}\n- Base mint: ${result.mintResult.mintTxHash} (${result.mintResult.status})\n- Deposits: ${JSON.stringify(result.depositResults)}\n`;
  writeFileSync(new URL('../SMOKE.md', import.meta.url), summary, { flag: 'a' });
  console.log(summary);
}

main().catch((e) => { console.error('SMOKE FAILED:', e?.message || e); process.exitCode = 1; });
