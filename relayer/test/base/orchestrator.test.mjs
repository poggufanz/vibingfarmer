import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import {
  APPROVE_ABI,
  YIELD_ROUTER_ABI,
  createOrchestrator,
} from '../../src/base/orchestrator.mjs';
import {
  buildFarmPermissions,
  evaluateCall,
} from '../../../frontend/src/base/policyEngine.js';

const YIELD_ROUTER_ADDRESS = '0x00000000000000000000000000000000000000f1';
const USDC_ADDRESS = '0x00000000000000000000000000000000000000dd';

function buildMockKernelClient() {
  return {
    account: {
      address: '0xSmartAccount',
      encodeCalls: vi.fn().mockResolvedValue('0xencodedCallData'),
    },
    sendUserOperation: vi.fn().mockResolvedValue('0xuserOpHash'),
    waitForUserOperationReceipt: vi.fn(async ({ hash }) => ({
      success: true,
      receipt: { status: 'success', transactionHash: `0xtx-${hash}` },
    })),
  };
}

describe('dispatchDeposits', () => {
  it('returns 3 settled results (all fulfilled) for 3 allocations', async () => {
    const kernelClient = buildMockKernelClient();
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn,
    });

    const allocations = [
      { pool: '0x00000000000000000000000000000000000000a1', amount: 100n, minShares: 90n },
      { pool: '0x00000000000000000000000000000000000000b2', amount: 200n, minShares: 190n },
      { pool: '0x00000000000000000000000000000000000000c3', amount: 300n, minShares: 290n },
    ];

    const results = await orchestrator.dispatchDeposits('serialized-approval', allocations);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(3);
  });

  it('a rejected allocation (e.g. a paused pool) does not abort the others — Promise.allSettled semantics', async () => {
    const kernelClient = buildMockKernelClient();
    kernelClient.sendUserOperation = vi.fn()
      .mockResolvedValueOnce('0xop-1')
      .mockRejectedValueOnce(new Error('AA23 reverted: pool paused'))
      .mockResolvedValueOnce('0xop-3');
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn,
    });

    const allocations = [
      { pool: '0x00000000000000000000000000000000000000a1', amount: 100n, minShares: 90n },
      { pool: '0x00000000000000000000000000000000000000b2', amount: 200n, minShares: 190n },
      { pool: '0x00000000000000000000000000000000000000c3', amount: 300n, minShares: 290n },
    ];

    const results = await orchestrator.dispatchDeposits('serialized-approval', allocations);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(results[1].reason.message).toMatch(/pool paused/);
    expect(results[2].status).toBe('fulfilled');
  });

  it('dispatches SERIALLY — the next userOp is not sent until the previous receipt lands (first op deploys the session account + enables the permission; a concurrent second op reverts AA23 "duplicate permissionHash")', async () => {
    const kernelClient = buildMockKernelClient();
    let sends = 0;
    let resolveFirstReceipt;
    kernelClient.sendUserOperation = vi.fn(async () => `0xop-${++sends}`);
    kernelClient.waitForUserOperationReceipt = vi.fn(({ hash }) =>
      hash === '0xop-1'
        ? new Promise((res) => {
            resolveFirstReceipt = () =>
              res({ success: true, receipt: { status: 'success', transactionHash: '0xt1' } });
          })
        : Promise.resolve({ success: true, receipt: { status: 'success', transactionHash: '0xt2' } })
    );
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn,
    });

    const allocations = [
      { pool: '0x00000000000000000000000000000000000000a1', amount: 100n, minShares: 90n },
      { pool: '0x00000000000000000000000000000000000000b2', amount: 200n, minShares: 190n },
    ];

    const pending = orchestrator.dispatchDeposits('serialized-approval', allocations);
    await new Promise((r) => setTimeout(r, 25));
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1); // second op MUST wait

    resolveFirstReceipt();
    const results = await pending;
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('encodes the canonical two-call batch and both decoded calls pass the generated policy', async () => {
    const kernelClient = buildMockKernelClient();
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });
    const allocation = {
      pool: '0x00000000000000000000000000000000000000a1',
      amount: 100n,
      minShares: 90n,
    };

    await orchestrator.dispatchDeposits('serialized-approval', [allocation]);

    const calls = kernelClient.account.encodeCalls.mock.calls[0][0];
    expect(calls).toHaveLength(2);
    expect(calls.map(({ to, value }) => ({ to, value }))).toEqual([
      { to: USDC_ADDRESS, value: 0n },
      { to: YIELD_ROUTER_ADDRESS, value: 0n },
    ]);

    const decodedCalls = [
      decodeFunctionData({ abi: APPROVE_ABI, data: calls[0].data }),
      decodeFunctionData({ abi: YIELD_ROUTER_ABI, data: calls[1].data }),
    ];
    expect(decodedCalls[0]).toMatchObject({
      functionName: 'approve',
      args: [YIELD_ROUTER_ADDRESS, allocation.amount],
    });
    expect(decodedCalls[1].functionName).toBe('deposit');
    expect(decodedCalls[1].args[0].toLowerCase()).toBe(allocation.pool.toLowerCase());
    expect(decodedCalls[1].args.slice(1)).toEqual([allocation.amount, allocation.minShares]);

    const permissions = buildFarmPermissions({
      pools: [{ pool: allocation.pool, cap: allocation.amount }],
      yieldRouterAbi: YIELD_ROUTER_ABI,
      usdcAbi: APPROVE_ABI,
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
    });
    const expiry = Math.floor(Date.now() / 1000) + 60;

    for (const [index, decoded] of decodedCalls.entries()) {
      expect(evaluateCall({
        permissions,
        to: calls[index].to,
        functionName: decoded.functionName,
        args: decoded.args,
        expiry,
      })).toEqual({ allowed: true, reason: null });
    }
  });
});
