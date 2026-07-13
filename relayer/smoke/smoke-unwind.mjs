// Live testnet smoke for the reverse leg: withdraws from the pool, burns-with-hook back to the
// smoke Stellar recipient, relays the reverse mint. This MUST use a separately reviewed
// reverse-only mandate; the farm-only SMOKE_SESSION_* credentials cannot authorize unwind.
// Run: node --env-file=.dev.vars smoke/smoke-unwind.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { createWatcher } from '../src/cctp/watcher.mjs';
import { reconstructSessionClient } from '../src/base/session.mjs';
import { createUnwindFlow } from '../src/flows/unwind.mjs';
import { contractStrkeyToBytes32 } from '../src/cctp/reverse.mjs';
import { MIN_FINALITY_STANDARD, MAX_FEE_STANDARD } from '../src/cctp/constants.mjs';
import deployments from '../../deployments/base-sepolia.json' with { type: 'json' };

const need = (env, k) => { if (!env[k] || /FILL_ME/.test(env[k])) throw new Error(`env ${k} missing/unfilled`); return env[k]; };

function needUnwindSession(env) {
  const approval = env.SMOKE_UNWIND_SESSION_APPROVAL;
  const signerPrivateKey = env.SMOKE_UNWIND_SESSION_PRIVKEY;
  if (!approval || /FILL_ME/.test(approval) || !signerPrivateKey || /FILL_ME/.test(signerPrivateKey)) {
    throw new Error(
      'Farm-only SMOKE_SESSION_* credentials cannot authorize unwind. Set '
      + 'SMOKE_UNWIND_SESSION_APPROVAL and SMOKE_UNWIND_SESSION_PRIVKEY from a separately '
      + 'reviewed reverse-only mandate.',
    );
  }
  return { approval, signerPrivateKey };
}

const DEFAULT_DEPS = {
  writeFileSync,
  loadConfig,
  createWatcher,
  reconstructSessionClient,
  createUnwindFlow,
  contractStrkeyToBytes32,
};

export async function main({ env = process.env, deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const { approval, signerPrivateKey } = needUnwindSession(env);
  const stellarRecipient = need(env, 'SMOKE_STELLAR_PUBLIC');
  const config = d.loadConfig(env);

  const watcher = d.createWatcher(config);
  const { unwind } = d.createUnwindFlow({
    reconstructSessionClientFn: d.reconstructSessionClient,
    watcher, domains: config.domains,
    yieldRouterAddress: config.base.yieldRouterAddress,
    usdcAddress: config.base.usdcAddress,
    tokenMessengerV2Address: config.base.tokenMessengerV2Address,
    forwarder32: d.contractStrkeyToBytes32(config.stellar.forwarderAddress),
  });

  const pool = deployments.yieldRouter.allowedPools[0];
  // Assumes smoke-farm ran first: it deposited 1.0 USDC (1_000_000 at 6dp) into `pool`, which mints
  // ~1_000_000 shares on a fresh ~1:1 MockERC4626. Redeem them and bridge the ~1.0 USDC back.
  // Tune shares/burnAmount6dp to the smart account's actual pool balance if the vault rate differs.
  console.log('[1-3/3] withdraw + burn-with-hook + relay reverse mint...  pool:', pool);
  const result = await unwind({
    approval, signerPrivateKey,
    redemptions: [{ pool, shares: 1_000_000n, minAssets: 1n }],
    burnAmount6dp: 1_000_000n, stellarRecipient,
    execId: `smoke-unwind-${Date.now()}`,
    chainConfig: { chain: config.base.chain, rpcUrl: config.base.rpcUrl, bundlerRpcUrl: config.base.bundlerRpcUrl },
    minFinality: MIN_FINALITY_STANDARD, maxFee: MAX_FEE_STANDARD,
  });

  const summary = `## Unwind smoke — ${new Date().toISOString()}\n- Withdraws: ${JSON.stringify(result.withdrawResults)}\n- Base burn: ${result.burnResult.txHash}\n- Stellar mint_and_forward: ${result.mintResult.mintTxHash} (${result.mintResult.status})\n- Final recipient: ${stellarRecipient}\n`;
  d.writeFileSync(new URL('../SMOKE.md', import.meta.url), summary, { flag: 'a' });
  console.log(summary);

  return result;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((e) => { console.error('SMOKE FAILED:', e?.message || e); process.exitCode = 1; });
}
