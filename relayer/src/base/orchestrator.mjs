// Fires the AI strategist's per-pool allocations as gasless session-key userOps against
// YieldRouter.deposit, one per allocation, via Promise.allSettled so a single rejected pool
// (paused, cap hit, expired session) never aborts the rest of the swarm — the same resilience
// pattern the existing Stellar worker swarm uses (frontend/src/orchestrator.js).

import { encodeFunctionData } from 'viem';
import { reconstructSessionClient } from './session.mjs';

const YIELD_ROUTER_ABI = [{
  type: 'function', name: 'deposit', stateMutability: 'nonpayable',
  inputs: [
    { name: 'pool', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'minShares', type: 'uint256' },
  ], outputs: [{ name: 'shares', type: 'uint256' }],
}];

// YieldRouter.deposit pulls USDC via safeTransferFrom(msg.sender, ...), so the smart account must
// approve the router for `amount` first. Each allocation is one batched userOp: [approve, deposit].
const APPROVE_ABI = [{
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
 * @param {`0x${string}`} config.sessionPrivateKey
 * @param {Function} [config.reconstructSessionClientFn] - injection seam for tests
 */
export function createOrchestrator(config) {
  const {
    chain, rpcUrl, bundlerRpcUrl, yieldRouterAddress, usdcAddress, sessionPrivateKey,
    reconstructSessionClientFn = reconstructSessionClient,
  } = config;

  /**
   * Fires one YieldRouter.deposit(pool, amount, minShares) userOp per allocation, in parallel,
   * via Promise.allSettled. Returns one settled-result entry per allocation, same order/length
   * — a rejected entry means that pool's slice stays as USDC in the smart account, others proceed.
   * @param {string} approval - serialized session approval from the SP3 mandate ceremony
   * @param {{pool:string, amount:bigint, minShares:bigint}[]} allocations
   */
  async function dispatchDeposits(approval, allocations) {
    const kernelClient = await reconstructSessionClientFn({
      chain, rpcUrl, bundlerRpcUrl, approval, sessionPrivateKey,
    });

    const settled = await Promise.allSettled(allocations.map(async (allocation) => {
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
      return { pool: allocation.pool, userOpHash, txHash: receipt?.receipt?.transactionHash };
    }));

    return settled.map((result, i) => ({ pool: allocations[i].pool, ...result }));
  }

  return { dispatchDeposits };
}
