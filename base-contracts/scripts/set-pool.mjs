// Whitelist (or de-list) a pool on the already-deployed YieldRouter.
// Reads the router address from deployments/base-sepolia.json and the pool
// from argv[2] (or INITIAL_POOL_ADDRESS). This is the operational tool for
// the plan's "swap-in a confirmed Morpho MetaMorpho vault" path, and the
// retry path when deploy.mjs's inline setPool hits the public-RPC
// estimateGas race (see Task 1.6). An explicit gas limit sidesteps that race.
// Run (PowerShell, from base-contracts/):
//   node --env-file=.dev.vars scripts/set-pool.mjs [poolAddress] [true|false]
import { readFileSync } from 'node:fs';
import { createWalletClient, createPublicClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const art = JSON.parse(readFileSync(new URL('../out/YieldRouter.sol/YieldRouter.json', import.meta.url)));
const deployments = JSON.parse(readFileSync(new URL('../../deployments/base-sepolia.json', import.meta.url)));
const routerAddress = getAddress(deployments.yieldRouter.address);

const poolArg = process.argv[2] || process.env.INITIAL_POOL_ADDRESS;
if (!poolArg || /FILL_ME/.test(poolArg)) throw new Error('pool address missing (argv[2] or INITIAL_POOL_ADDRESS)');
const pool = getAddress(poolArg);
const allowed = process.argv[3] ? process.argv[3] === 'true' : true;

const pk = process.env.BASE_DEPLOYER_PRIVKEY;
if (!pk || /FILL_ME/.test(pk)) throw new Error('BASE_DEPLOYER_PRIVKEY missing');

const rpc = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

const hash = await wallet.writeContract({
  address: routerAddress,
  abi: art.abi,
  functionName: 'setPool',
  args: [pool, allowed],
  gas: 100_000n, // explicit — avoid estimateGas hitting an RPC node lagging on freshly-deployed code
});
console.log('setPool tx:', hash);
const rcpt = await pub.waitForTransactionReceipt({ hash });
console.log('status:', rcpt.status);
const isAllowed = await pub.readContract({ address: routerAddress, abi: art.abi, functionName: 'allowedPool', args: [pool] });
console.log('allowedPool[' + pool + '] =', isAllowed);
