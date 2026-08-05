// Fires the AI strategist's per-pool allocations as gasless session-key userOps against
// YieldRouter.deposit, one per allocation, SERIALLY, with allSettled-shaped results so a single
// rejected pool (paused, cap hit, expired session) never aborts the rest of the swarm.
// Serial is load-bearing, not a style choice: every userOp comes from the SAME session smart
// account, and the first one carries the account deployment + permission-enable. Dispatching a
// second op before the first lands makes the bundler simulate the enable again — proven live as
// `AA23 reverted duplicate permissionHash` (zd_sponsorUserOperation 400) on the 2nd pool.

import { encodeFunctionData } from 'viem';
import { reconstructSessionClient, MAX_CALL_CAP_UNITS } from './session.mjs';
import {
  requireCanonicalUserOperationHash,
  requireSuccessfulUserOperation,
} from './userOpReceipt.mjs';

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
   * Activates a mandate by clearing the session account's allowance to YieldRouter.
   * @param {string} approval - serialized session approval from the SP3 mandate ceremony
   * @param {{onSubmitted?: (userOpHash: string) => Promise<void> | void}} [options]
   */
  async function activateMandate(approval, { onSubmitted } = {}) {
    const kernelClient = await reconstructSessionClientFn({
      chain, rpcUrl, bundlerRpcUrl, approval, sessionPrivateKey,
    });
    const approveData = encodeFunctionData({
      abi: APPROVE_ABI, functionName: 'approve', args: [yieldRouterAddress, 0n],
    });
    const callData = await kernelClient.account.encodeCalls([
      { to: usdcAddress, value: 0n, data: approveData },
    ]);
    const userOpHash = requireCanonicalUserOperationHash(
      await kernelClient.sendUserOperation({ callData }),
      { label: 'mandate activation' },
    );
    await onSubmitted?.(userOpHash);
    const receipt = await kernelClient.waitForUserOperationReceipt({
      hash: userOpHash, timeout: USEROP_TIMEOUT_MS,
    });
    const txHash = requireSuccessfulUserOperation(receipt, { label: 'mandate activation' });
    return { userOpHash, txHash };
  }

  /**
   * Fires one YieldRouter.deposit(pool, amount, minShares) userOp per allocation, SERIALLY —
   * next op only after the previous receipt (see header: duplicate-permissionHash guard).
   * Returns one allSettled-shaped entry per allocation, same order/length — a rejected entry
   * means that pool's slice stays as USDC in the smart account, later pools still proceed.
   * @param {string} approval - serialized session approval from the SP3 mandate ceremony
   * @param {{pool:string, amount:bigint, minShares:bigint}[]} allocations
   */
  async function dispatchDeposits(approval, allocations) {
    // VF Wallet Task 7 (defense in depth): this is the point where sessionPrivateKey actually
    // gets used — reject the whole call, before the session client is even reconstructed, if any
    // allocation is over the per-call cap. httpRouter.mjs's own pre-dispatch validateMandateBinding
    // check is the primary gate; this is the last line of defense should some other caller ever
    // reach this function directly. Per-call, not cumulative — checked against each allocation's
    // own amount, nothing is summed across allocations or across calls.
    const overCap = allocations.find((a) => a.amount > MAX_CALL_CAP_UNITS);
    if (overCap) {
      throw new Error(`allocation for ${overCap.pool} exceeds the ${MAX_CALL_CAP_UNITS} per-call cap`);
    }

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
        const userOpHash = requireCanonicalUserOperationHash(
          await kernelClient.sendUserOperation({ callData }),
          { label: `deposit into ${allocation.pool}` },
        );
        const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash, timeout: USEROP_TIMEOUT_MS });
        const txHash = requireSuccessfulUserOperation(receipt, { label: `deposit into ${allocation.pool}` });
        results.push({
          allocationId: allocation.allocationId,
          pool: allocation.pool,
          status: 'fulfilled',
          value: { pool: allocation.pool, userOpHash, txHash },
          executionStatus: 'deposited',
          custody: { location: 'base-proxy' },
          txHash,
        });
      } catch (reason) {
        results.push({
          allocationId: allocation.allocationId,
          pool: allocation.pool,
          status: 'rejected',
          reason,
          executionStatus: 'held',
          custody: { location: 'agent' },
          txHash: null,
        });
      }
    }
    return results;
  }

  return { activateMandate, dispatchDeposits };
}
