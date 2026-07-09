import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { createUnwindFlow } from '../../src/flows/unwind.mjs';

function buildMockKernelClient() {
  let opCount = 0;
  return {
    account: { encodeCalls: vi.fn().mockResolvedValue('0xencoded') },
    sendUserOperation: vi.fn(async () => `0xop-${opCount += 1}`),
    waitForUserOperationReceipt: vi.fn(async ({ hash }) => ({ success: true, receipt: { status: 'success', transactionHash: `0xtx-${hash}` } })),
  };
}

describe('unwind', () => {
  it('withdraws, then burns-with-hook, then relays the reverse mint, in that order', async () => {
    const kernelClient = buildMockKernelClient();
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const watcher = { relayMint: vi.fn().mockResolvedValue({ status: 'minted', mintTxHash: 'stellar-hash' }) };
    const recipient = Keypair.random().publicKey();

    const { unwind } = createUnwindFlow({
      reconstructSessionClientFn, watcher, domains: { stellar: 27, base: 6 },
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      usdcAddress: '0x00000000000000000000000000000000000000dd',
      tokenMessengerV2Address: '0x00000000000000000000000000000000000000ee',
      forwarder32: `0x${'22'.repeat(32)}`,
    });

    const result = await unwind({
      approval: 'approval-blob', signerPrivateKey: '0xsigner',
      redemptions: [{ pool: '0x00000000000000000000000000000000000000a1', shares: 50n, minAssets: 45n }],
      burnAmount6dp: 45_000_000n, stellarRecipient: recipient, execId: 'exec-unwind-1',
      chainConfig: { chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x' },
      minFinality: 2000, maxFee: 0n,
    });

    expect(result.withdrawResults).toHaveLength(1);
    expect(result.withdrawResults[0].status).toBe('fulfilled');
    expect(result.burnResult.txHash).toBeDefined();
    expect(result.mintResult).toEqual({ status: 'minted', mintTxHash: 'stellar-hash' });
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(2); // 1 withdraw userOp + 1 burn userOp
    expect(watcher.relayMint).toHaveBeenCalledWith(expect.objectContaining({ sourceDomain: 6, execId: 'exec-unwind-1' }));
  });

  it('throws before dispatching anything if stellarRecipient is not a valid StrKey (assertHookData guard)', async () => {
    const kernelClient = buildMockKernelClient();
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const watcher = { relayMint: vi.fn() };

    const { unwind } = createUnwindFlow({
      reconstructSessionClientFn, watcher, domains: { stellar: 27, base: 6 },
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      usdcAddress: '0x00000000000000000000000000000000000000dd',
      tokenMessengerV2Address: '0x00000000000000000000000000000000000000ee',
      forwarder32: `0x${'22'.repeat(32)}`,
    });

    await expect(unwind({
      approval: 'approval-blob', signerPrivateKey: '0xsigner',
      redemptions: [{ pool: '0x00000000000000000000000000000000000000a1', shares: 50n, minAssets: 45n }],
      burnAmount6dp: 45_000_000n, stellarRecipient: 'not-a-strkey', execId: 'exec-bad',
      chainConfig: { chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x' },
      minFinality: 2000, maxFee: 0n,
    })).rejects.toThrow(/not a valid Stellar StrKey/);

    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
    expect(watcher.relayMint).not.toHaveBeenCalled();
  });

  it('aborts before burning if any withdrawal failed (avoids bridging a mismatched amount)', async () => {
    const kernelClient = buildMockKernelClient();
    kernelClient.sendUserOperation = vi.fn().mockRejectedValueOnce(new Error('AA23 reverted: paused'));
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const watcher = { relayMint: vi.fn() };
    const recipient = Keypair.random().publicKey();

    const { unwind } = createUnwindFlow({
      reconstructSessionClientFn, watcher, domains: { stellar: 27, base: 6 },
      yieldRouterAddress: '0x00000000000000000000000000000000000000f1',
      usdcAddress: '0x00000000000000000000000000000000000000dd',
      tokenMessengerV2Address: '0x00000000000000000000000000000000000000ee',
      forwarder32: `0x${'22'.repeat(32)}`,
    });

    await expect(unwind({
      approval: 'approval-blob', signerPrivateKey: '0xsigner',
      redemptions: [{ pool: '0x00000000000000000000000000000000000000a1', shares: 50n, minAssets: 45n }],
      burnAmount6dp: 45_000_000n, stellarRecipient: recipient, execId: 'exec-partial-fail',
      chainConfig: { chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x' },
      minFinality: 2000, maxFee: 0n,
    })).rejects.toThrow(/withdrawals failed/);

    expect(watcher.relayMint).not.toHaveBeenCalled();
  });
});
