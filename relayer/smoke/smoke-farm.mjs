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
import { reconstructSessionClient } from '../src/base/session.mjs';
import { MIN_FINALITY_STANDARD, MAX_FEE_STANDARD } from '../src/cctp/constants.mjs';
import deployments from '../../deployments/base-sepolia.json' with { type: 'json' };

const E = process.env;
const need = (k) => { if (!E[k] || /FILL_ME/.test(E[k])) throw new Error(`env ${k} missing/unfilled`); return E[k]; };

async function main() {
  const config = loadConfig(E);
  const smokeKp = Keypair.fromSecret(need('SMOKE_STELLAR_SECRET'));
  const smokePub = need('SMOKE_STELLAR_PUBLIC');
  const approval = need('SMOKE_SESSION_APPROVAL'); // from smoke/mint-mandate.mjs (or an SP3 ceremony)
  const sessionPrivateKey = need('SMOKE_SESSION_PRIVKEY');
  const pool = deployments.yieldRouter.allowedPools[0];

  // The bridged USDC must land where the deposit runs FROM: the ZeroDev smart account, not the
  // relayer EOA. Reconstruct the session client to learn that address, then burn to it.
  const sessionClient = await reconstructSessionClient({
    chain: config.base.chain, rpcUrl: config.base.rpcUrl, bundlerRpcUrl: config.base.bundlerRpcUrl,
    approval, sessionPrivateKey,
  });
  const smartAccount = sessionClient.account.address;
  console.log('  smart account (mint recipient):', smartAccount, '| pool:', pool);

  console.log('[1/3] Stellar burn (simulating the user passkey signature)...');
  const burnTxHash = await approveAndBurnStellar({
    server: config.stellar.server, kp: smokeKp, sourcePub: smokePub, passphrase: config.stellar.passphrase,
    tokenMessengerMinter: config.stellar.tokenMessengerMinter, usdcSac: config.stellar.usdcSac,
    amount7dp: 10_000_000n, allowance7dp: 100_000_000n, // 1.0 USDC at 7dp -> bridges to 1.0 USDC (1_000_000 at 6dp)
    baseRecipient: smartAccount,
    destDomain: config.domains.base, minFinality: MIN_FINALITY_STANDARD, maxFee: MAX_FEE_STANDARD,
  });
  console.log('  burn tx:', burnTxHash);

  const watcher = createWatcher(config);
  const orchestrator = createOrchestrator({
    chain: config.base.chain, rpcUrl: config.base.rpcUrl, bundlerRpcUrl: config.base.bundlerRpcUrl,
    yieldRouterAddress: config.base.yieldRouterAddress, usdcAddress: config.base.usdcAddress, sessionPrivateKey,
  });
  const { farm } = createFarmFlow({ watcher, orchestrator, domains: config.domains });

  console.log('[2-3/3] relay mint + dispatch deposits...');
  const result = await farm({
    burnTxHash, execId: `smoke-farm-${burnTxHash}`, approval,
    allocations: [{ pool, amount: 1_000_000n, minShares: 1n }], // deposit the 1.0 USDC (6dp) that bridged
  });

  const summary = `## Farm smoke — ${new Date().toISOString()}\n- Stellar burn: ${burnTxHash}\n- Base mint: ${result.mintResult.mintTxHash} (${result.mintResult.status})\n- Deposits: ${JSON.stringify(result.depositResults)}\n`;
  writeFileSync(new URL('../SMOKE.md', import.meta.url), summary, { flag: 'a' });
  console.log(summary);
}

main().catch((e) => { console.error('SMOKE FAILED:', e?.message || e); process.exitCode = 1; });
