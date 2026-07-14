// Fires the AI strategist's per-pool allocations as gasless session-key userOps against
// YieldRouter.deposit, one per allocation, SERIALLY, with allSettled-shaped results so a single
// rejected pool (paused, cap hit, expired session) never aborts the rest of the swarm.
// Serial is load-bearing, not a style choice: every userOp comes from the SAME session smart
// account, and the first one carries the account deployment + permission-enable. Dispatching a
// second op before the first lands makes the bundler simulate the enable again — proven live as
// `AA23 reverted duplicate permissionHash` (zd_sponsorUserOperation 400) on the 2nd pool.

import { encodeFunctionData } from 'viem';
import { reconstructSessionClient } from './session.mjs';

export const YIELD_ROUTER_ABI = [{
  type: 'function', name: 'deposit', stateMutability: 'nonpayable',
  inputs: [
    { name: 'pool', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'minShares', type: 'uint256' },
  ], outputs: [{ name: 'shares', type: 'uint256' }],
}];

// YieldRouter.deposit pulls USDC via safeTransferFrom(msg.sender, ...), so the smart account must
// approve the router for `amount` first. Each allocation is one batched userOp: [approve, deposit].
export const APPROVE_ABI = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }],
}];

const USEROP_TIMEOUT_MS = 120_000;

/**
 * @param {Object} config
 * @param {import('viem').Chain} config.chain
 * @param {string} config.rpcUrl
 * @param {string} config.bundlerRpcUrl
 * @param {`0x${string}`} config.yieldRouterAddress
 * @param {`0x${string}`} config.usdcAddress
 * @param {`0x${string}`} config.sessionPrivateKey
 * @param {Function} [config.reconstructSessionClientFn] - injection seam for tests
 */
export function createOrchestrator(config) {
  const {
    chain, rpcUrl, bundlerRpcUrl, yieldRouterAddress, usdcAddress, sessionPrivateKey,
    reconstructSessionClientFn = reconstructSessionClient,
  } = config;

  /**
   * Fires one YieldRouter.deposit(pool, amount, minShares) userOp per allocation, SERIALLY —
   * next op only after the previous receipt (see header: duplicate-permissionHash guard).
   * Returns one allSettled-shaped entry per allocation, same order/length — a rejected entry
   * means that pool's slice stays as USDC in the smart account, later pools still proceed.
   * @param {string} approval - serialized session approval from the SP3 mandate ceremony
   * @param {{pool:string, amount:bigint, minShares:bigint}[]} allocations
   */
  async function dispatchDeposits(approval, allocations) {
    const kernelClient = await reconstructSessionClientFn({
      chain, rpcUrl, bundlerRpcUrl, approval, sessionPrivateKey,
    });

    const results = [];
    for (const allocation of allocations) {
      try {
        const approveData = encodeFunctionData({
          abi: APPROVE_ABI, functionName: 'approve', args: [yieldRouterAddress, allocation.amount],
        });
        const depositData = encodeFunctionData({
          abi: YIELD_ROUTER_ABI, functionName: 'deposit',
          args: [allocation.pool, allocation.amount, allocation.minShares],
        });
        const callData = await kernelClient.account.encodeCalls([
          { to: usdcAddress, value: 0n, data: approveData },
          { to: yieldRouterAddress, value: 0n, data: depositData },
        ]);
        const userOpHash = await kernelClient.sendUserOperation({ callData });
        const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash, timeout: USEROP_TIMEOUT_MS });
        const success = receipt?.success === true || receipt?.receipt?.status === 'success';
        if (!success) throw new Error(`deposit into ${allocation.pool} was mined but did not succeed`);
        results.push({
          pool: allocation.pool,
          status: 'fulfilled',
          value: { pool: allocation.pool, userOpHash, txHash: receipt?.receipt?.transactionHash },
        });
      } catch (reason) {
        results.push({ pool: allocation.pool, status: 'rejected', reason });
      }
    }
    return results;
  }

  return { dispatchDeposits };
}
