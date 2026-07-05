// Withdraw -> Unwind flow: redeem shares back to USDC in the smart account, burn-with-hook to
// the user's Stellar G-address, then relay the reverse mint. The withdraw + burn userOps must
// already be authorized by the caller (owner passkey or a future withdraw-scoped session —
// SP3's concern); this flow only DISPATCHES already-authorized calls and relays the resulting
// bridge, it does not decide who is allowed to withdraw.

import { encodeFunctionData } from 'viem';
import { buildForwarderHookData, assertHookData } from '../cctp/reverse.mjs';

const YIELD_ROUTER_WITHDRAW_ABI = [{
  type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
  inputs: [
    { name: 'pool', type: 'address' }, { name: 'shares', type: 'uint256' }, { name: 'minAssets', type: 'uint256' },
  ], outputs: [{ name: 'assets', type: 'uint256' }],
}];
const APPROVE_ABI = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }],
}];
const BURN_WITH_HOOK_ABI = [{
  type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' }, { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'hookData', type: 'bytes' },
  ], outputs: [{ type: 'uint64' }],
}];

export function createUnwindFlow({
  reconstructSessionClientFn, watcher, domains, yieldRouterAddress, usdcAddress, tokenMessengerV2Address, forwarder32,
}) {
  /**
   * @param {Object} params
   * @param {string} params.approval - serialized approval authorizing the withdraw+burn calls
   * @param {`0x${string}`} params.signerPrivateKey - owner/session key allowed to sign these calls
   * @param {{pool:string, shares:bigint, minAssets:bigint}[]} params.redemptions
   * @param {bigint} params.burnAmount6dp - total USDC to bridge back after redemptions land
   * @param {string} params.stellarRecipient - user's Stellar G-address (final destination)
   * @param {string} params.execId
   * @param {Object} params.chainConfig - { chain, rpcUrl, bundlerRpcUrl }
   * @param {number} params.minFinality
   * @param {bigint} params.maxFee
   */
  async function unwind({
    approval, signerPrivateKey, redemptions, burnAmount6dp, stellarRecipient, execId, chainConfig, minFinality, maxFee,
  }) {
    // Build + validate hookData FIRST — before reconstructing the client, before any withdraw
    // userOp is dispatched. A malformed recipient must fail here, not after we have already
    // redeemed shares (the #7313 stranded-funds failure mode is the highest-consequence bug in
    // this phase — see cctp/reverse.mjs). This is stricter than validating only before the burn.
    const hookData = buildForwarderHookData(stellarRecipient);
    assertHookData(hookData);

    const kernelClient = await reconstructSessionClientFn({ ...chainConfig, approval, sessionPrivateKey: signerPrivateKey });

    const withdrawResults = await Promise.allSettled(redemptions.map(async (redemption) => {
      const data = encodeFunctionData({
        abi: YIELD_ROUTER_WITHDRAW_ABI, functionName: 'withdraw',
        args: [redemption.pool, redemption.shares, redemption.minAssets],
      });
      const callData = await kernelClient.account.encodeCalls([{ to: yieldRouterAddress, value: 0n, data }]);
      const userOpHash = await kernelClient.sendUserOperation({ callData });
      const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash });
      return { pool: redemption.pool, userOpHash, txHash: receipt?.receipt?.transactionHash };
    }));

    const failedWithdraws = withdrawResults.filter((r) => r.status === 'rejected');
    if (failedWithdraws.length > 0) {
      throw new Error(`unwind: ${failedWithdraws.length}/${redemptions.length} withdrawals failed — aborting the burn to avoid bridging a mismatched amount; retry the failed pools before re-running unwind`);
    }

    const approveData = encodeFunctionData({
      abi: APPROVE_ABI, functionName: 'approve', args: [tokenMessengerV2Address, burnAmount6dp],
    });
    const burnData = encodeFunctionData({
      abi: BURN_WITH_HOOK_ABI, functionName: 'depositForBurnWithHook',
      args: [burnAmount6dp, domains.stellar, forwarder32, usdcAddress, forwarder32, maxFee, minFinality, hookData],
    });
    const burnCallData = await kernelClient.account.encodeCalls([
      { to: usdcAddress, value: 0n, data: approveData },
      { to: tokenMessengerV2Address, value: 0n, data: burnData },
    ]);
    const burnUserOpHash = await kernelClient.sendUserOperation({ callData: burnCallData });
    const burnReceipt = await kernelClient.waitForUserOperationReceipt({ hash: burnUserOpHash });
    const burnTxHash = burnReceipt?.receipt?.transactionHash;

    const mintResult = await watcher.relayMint({ sourceDomain: domains.base, burnTxHash, execId });

    return { withdrawResults, burnResult: { userOpHash: burnUserOpHash, txHash: burnTxHash }, mintResult };
  }

  return { unwind };
}
