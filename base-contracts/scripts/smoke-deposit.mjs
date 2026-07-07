// Live smoke: deposit then withdraw 1 USDC through the deployed YieldRouter on
// Base Sepolia, proving the on-chain wire end-to-end (not just a fork). Reads
// the router + pool from deployments/base-sepolia.json; the deployer key in
// .dev.vars is both owner and depositor here. Explicit gas limits sidestep the
// public-RPC estimateGas race (see scripts/set-pool.mjs).
// Run (PowerShell, from base-contracts/): node --env-file=.dev.vars scripts/smoke-deposit.mjs
import { readFileSync } from 'node:fs';
import { createWalletClient, createPublicClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const routerArt = JSON.parse(readFileSync(new URL('../out/YieldRouter.sol/YieldRouter.json', import.meta.url)));
const deployments = JSON.parse(readFileSync(new URL('../../deployments/base-sepolia.json', import.meta.url)));
const router = getAddress(deployments.yieldRouter.address);
const pool = getAddress(deployments.yieldRouter.allowedPools[0]);
const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e'); // Base Sepolia USDC, 6dp

const erc20 = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const pk = process.env.BASE_DEPLOYER_PRIVKEY;
if (!pk || /FILL_ME/.test(pk)) throw new Error('BASE_DEPLOYER_PRIVKEY missing');
const rpc = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

const AMOUNT = 1_000_000n; // 1 USDC at 6dp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The deployer is EIP-7702-delegated (SP0 spike). Base Sepolia caps delegated
// accounts to 1 in-flight tx, and the public RPC is load-balanced, so we must
// send strictly serially: wait until pending==latest nonce before each send,
// and retry the send if a lagging node still reports an in-flight tx.
async function waitNoPending() {
  for (let i = 0; i < 40; i++) {
    const [latest, pending] = await Promise.all([
      pub.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      pub.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    ]);
    if (pending === latest) return;
    await sleep(2000);
  }
  throw new Error('still have in-flight txs after waiting');
}
const send = async (label, params) => {
  await waitNoPending();
  let hash;
  for (let attempt = 1; ; attempt++) {
    try {
      hash = await wallet.writeContract(params);
      break;
    } catch (e) {
      if (attempt < 5 && /in-flight transaction limit/i.test(e.message || '')) {
        await sleep(3000);
        continue;
      }
      throw e;
    }
  }
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${hash} -> ${rcpt.status}`);
  if (rcpt.status !== 'success') throw new Error(`${label} reverted`);
  return rcpt;
};
const read = (address, functionName, args) => pub.readContract({ address, abi: erc20, functionName, args });

const usdc0 = await read(USDC, 'balanceOf', [account.address]);
console.log('USDC before:', usdc0.toString());

await send('approve USDC', { address: USDC, abi: erc20, functionName: 'approve', args: [router, AMOUNT], gas: 100_000n });
await send('deposit', { address: router, abi: routerArt.abi, functionName: 'deposit', args: [pool, AMOUNT, 1n], gas: 400_000n });

let shares = 0n;
for (let i = 0; i < 15; i++) {
  shares = await read(pool, 'balanceOf', [account.address]);
  if (shares > 0n) break;
  await sleep(2000); // public RPC can serve a stale read right after the block is mined
}
console.log('shares held after deposit:', shares.toString());
if (shares === 0n) throw new Error('no shares minted');

await send('approve shares', { address: pool, abi: erc20, functionName: 'approve', args: [router, shares], gas: 100_000n });
await send('withdraw', { address: router, abi: routerArt.abi, functionName: 'withdraw', args: [pool, shares, 1n], gas: 400_000n });

const usdc1 = await read(USDC, 'balanceOf', [account.address]);
const routerUsdc = await read(USDC, 'balanceOf', [router]);
console.log('USDC after:', usdc1.toString());
console.log('router USDC (must be 0):', routerUsdc.toString());
if (routerUsdc !== 0n) throw new Error('router holds USDC — zero-custody violated');
console.log('SMOKE OK: live deposit + withdraw round-trip, router zero-custody holds');
