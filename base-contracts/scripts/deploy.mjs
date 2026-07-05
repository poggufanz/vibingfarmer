// Deploy YieldRouter to Base Sepolia via viem, then whitelist the initial
// pool and record the deployment. Mirrors
// spikes/smart-sessions/deploy-router.mjs (proven working pattern).
// Run (PowerShell, from base-contracts/): node --env-file=.dev.vars scripts/deploy.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createWalletClient, createPublicClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const art = JSON.parse(readFileSync(new URL('../out/YieldRouter.sol/YieldRouter.json', import.meta.url)));
const abi = art.abi;
const bytecode = art.bytecode.object;

const pk = process.env.BASE_DEPLOYER_PRIVKEY;
if (!pk || /FILL_ME/.test(pk)) throw new Error('BASE_DEPLOYER_PRIVKEY missing');

const initialPool = process.env.INITIAL_POOL_ADDRESS;
if (!initialPool || /FILL_ME/.test(initialPool)) throw new Error('INITIAL_POOL_ADDRESS missing — run deploy-mock-pool.mjs first, or set a confirmed vault address');

const rpc = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

const deployHash = await wallet.deployContract({ abi, bytecode, args: [account.address] });
console.log('deploy tx:', deployHash);
const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
console.log('status:', deployRcpt.status);
const routerAddress = getAddress(deployRcpt.contractAddress);
console.log('YIELD_ROUTER=' + routerAddress);

const setPoolHash = await wallet.writeContract({
  address: routerAddress,
  abi,
  functionName: 'setPool',
  args: [getAddress(initialPool), true],
  gas: 100_000n, // explicit — the public RPC's estimateGas can hit a node lagging on the just-deployed code and under-estimate (see scripts/set-pool.mjs)
});
console.log('setPool tx:', setPoolHash);
const setPoolRcpt = await pub.waitForTransactionReceipt({ hash: setPoolHash });
console.log('status:', setPoolRcpt.status);

const deploymentsPath = new URL('../../deployments/base-sepolia.json', import.meta.url);
const existing = existsSync(deploymentsPath) ? JSON.parse(readFileSync(deploymentsPath)) : {};
const updated = {
  ...existing,
  yieldRouter: {
    address: routerAddress,
    deployTx: deployHash,
    initialOwner: account.address,
    allowedPools: [getAddress(initialPool)],
    deployedAt: new Date().toISOString(),
  },
};
writeFileSync(deploymentsPath, JSON.stringify(updated, null, 2) + '\n');
console.log('wrote deployments/base-sepolia.json');
