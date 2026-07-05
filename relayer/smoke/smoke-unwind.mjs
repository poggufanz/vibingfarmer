// Live testnet smoke for the reverse leg: withdraws from the pool, burns-with-hook back to the
// smoke Stellar recipient, relays the reverse mint. Run: node --env-file=.dev.vars smoke/smoke-unwind.mjs
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { createWatcher } from '../src/cctp/watcher.mjs';
import { reconstructSessionClient } from '../src/base/session.mjs';
import { createUnwindFlow } from '../src/flows/unwind.mjs';
import { contractStrkeyToBytes32 } from '../src/cctp/reverse.mjs';
import { MIN_FINALITY_STANDARD, MAX_FEE_STANDARD } from '../src/cctp/constants.mjs';

const E = process.env;
const need = (k) => { if (!E[k] || /FILL_ME/.test(E[k])) throw new Error(`env ${k} missing/unfilled`); return E[k]; };

async function main() {
  const config = loadConfig(E);
  const approval = need('SMOKE_SESSION_APPROVAL');
  const signerPrivateKey = need('SMOKE_SESSION_PRIVKEY');
  const stellarRecipient = need('SMOKE_STELLAR_PUBLIC');

  const watcher = createWatcher(config);
  const { unwind } = createUnwindFlow({
    reconstructSessionClientFn: reconstructSessionClient,
    watcher, domains: config.domains,
    yieldRouterAddress: config.base.yieldRouterAddress,
    usdcAddress: config.base.usdcAddress,
    tokenMessengerV2Address: config.base.tokenMessengerV2Address,
    forwarder32: contractStrkeyToBytes32(config.stellar.forwarderAddress),
  });

  console.log('[1-3/3] withdraw + burn-with-hook + relay reverse mint...');
  const result = await unwind({
    approval, signerPrivateKey,
    redemptions: [{ pool: config.base.yieldRouterAddress, shares: 1n, minAssets: 1n }],
    burnAmount6dp: 1_000_000n, stellarRecipient,
    execId: `smoke-unwind-${Date.now()}`,
    chainConfig: { chain: config.base.chain, rpcUrl: config.base.rpcUrl, bundlerRpcUrl: config.base.bundlerRpcUrl },
    minFinality: MIN_FINALITY_STANDARD, maxFee: MAX_FEE_STANDARD,
  });

  const summary = `## Unwind smoke — ${new Date().toISOString()}\n- Withdraws: ${JSON.stringify(result.withdrawResults)}\n- Base burn: ${result.burnResult.txHash}\n- Stellar mint_and_forward: ${result.mintResult.mintTxHash} (${result.mintResult.status})\n- Final recipient: ${stellarRecipient}\n`;
  writeFileSync(new URL('../SMOKE.md', import.meta.url), summary, { flag: 'a' });
  console.log(summary);
}

main().catch((e) => { console.error('SMOKE FAILED:', e?.message || e); process.exitCode = 1; });
