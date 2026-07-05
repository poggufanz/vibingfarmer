import { describe, it, expect, vi } from 'vitest';
import { createOrchestrator } from '../../src/base/orchestrator.mjs';

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
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      usdcAddress: '0x00000000000000000000000000000000000000dd',
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
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      usdcAddress: '0x00000000000000000000000000000000000000dd',
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
});
