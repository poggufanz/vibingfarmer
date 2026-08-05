import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import {
  APPROVE_ABI,
  YIELD_ROUTER_ABI,
  createOrchestrator,
} from '../../src/base/orchestrator.mjs';
import { MAX_CALL_CAP_UNITS } from '../../src/base/session.mjs';
import {
  buildFarmPermissions,
  evaluateCall,
} from '../../../frontend/src/base/policyEngine.js';

const YIELD_ROUTER_ADDRESS = '0x00000000000000000000000000000000000000f1';
const USDC_ADDRESS = '0x00000000000000000000000000000000000000dd';
const TX_HASH = `0x${'a'.repeat(64)}`;
const USER_OP_HASH = `0x${'b'.repeat(64)}`;
const FIRST_USER_OP_HASH = `0x${'1'.repeat(64)}`;
const SECOND_USER_OP_HASH = `0x${'2'.repeat(64)}`;
const THIRD_USER_OP_HASH = `0x${'3'.repeat(64)}`;

function buildMockKernelClient() {
  return {
    account: {
      address: '0xSmartAccount',
      encodeCalls: vi.fn().mockResolvedValue('0xencodedCallData'),
    },
    sendUserOperation: vi.fn().mockResolvedValue(USER_OP_HASH),
    waitForUserOperationReceipt: vi.fn(async ({ hash }) => ({
      success: true,
      receipt: { status: 'success', transactionHash: TX_HASH },
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
      .mockResolvedValueOnce(FIRST_USER_OP_HASH)
      .mockRejectedValueOnce(new Error('AA23 reverted: pool paused'))
      .mockResolvedValueOnce(THIRD_USER_OP_HASH);
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
    kernelClient.sendUserOperation = vi.fn(async () => [FIRST_USER_OP_HASH, SECOND_USER_OP_HASH][sends++]);
    kernelClient.waitForUserOperationReceipt = vi.fn(({ hash }) =>
      hash === FIRST_USER_OP_HASH
        ? new Promise((res) => {
            resolveFirstReceipt = () =>
            res({ success: true, receipt: { status: 'success', transactionHash: TX_HASH } });
          })
        : Promise.resolve({ success: true, receipt: { status: 'success', transactionHash: TX_HASH } })
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
        value: calls[index].value,
        expiry,
      })).toEqual({ allowed: true, reason: null });
    }
  });

  it('uses exact pre-quantized thirds for both approve and deposit in every dispatched batch', async () => {
    const kernelClient = buildMockKernelClient();
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });
    const units = [33_333_334n, 33_333_333n, 33_333_333n];
    const allocations = units.map((amount, index) => ({
      pool: `0x00000000000000000000000000000000000000${index + 1}1`,
      amount,
      minShares: 1n,
    }));

    await orchestrator.dispatchDeposits('serialized-approval', allocations);

    expect(units.reduce((sum, amount) => sum + amount, 0n)).toBe(100_000_000n);
    const batches = kernelClient.account.encodeCalls.mock.calls.map(([calls]) => calls);
    expect(batches).toHaveLength(3);
    for (const [index, calls] of batches.entries()) {
      const approval = decodeFunctionData({ abi: APPROVE_ABI, data: calls[0].data });
      const deposit = decodeFunctionData({ abi: YIELD_ROUTER_ABI, data: calls[1].data });
      expect(approval.args[1]).toBe(units[index]);
      expect(deposit.args[1]).toBe(units[index]);
    }
  });

  // VF Wallet Task 7 — defense in depth: this is the point where the session key is actually
  // used (reconstructSessionClientFn builds a live signing client from it), so an over-cap
  // allocation must never get this far even if some future caller bypasses httpRouter's own
  // pre-dispatch check. Rejects the WHOLE call up front (never releases the key at all) rather
  // than the allSettled per-pool pattern used for runtime failures below — a policy violation is
  // caught before dispatch starts, not discovered mid-flight.
  it('rejects the whole call before reconstructing the session client when any allocation exceeds the 10,000 USDC per-call cap', async () => {
    const kernelClient = buildMockKernelClient();
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn,
    });

    const allocations = [
      { pool: '0x00000000000000000000000000000000000000a1', amount: MAX_CALL_CAP_UNITS, minShares: 1n },
      { pool: '0x00000000000000000000000000000000000000b2', amount: MAX_CALL_CAP_UNITS + 1n, minShares: 1n },
    ];

    await expect(orchestrator.dispatchDeposits('serialized-approval', allocations)).rejects.toThrow(/cap/i);
    expect(reconstructSessionClientFn).not.toHaveBeenCalled();
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it.each([
    [{ success: true, receipt: { status: 'reverted', transactionHash: TX_HASH } }],
    [{ success: false, receipt: { status: 'success', transactionHash: TX_HASH } }],
  ])('holds an allocation when user operation success is only one-sided', async (receipt) => {
    const kernelClient = buildMockKernelClient();
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(receipt);
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const [result] = await orchestrator.dispatchDeposits('serialized-approval', [
      { pool: '0x00000000000000000000000000000000000000a1', amount: 100n, minShares: 90n },
    ]);

    expect(result).toMatchObject({ status: 'rejected', executionStatus: 'held', txHash: null });
  });

  it('holds an allocation without waiting when the bundler returns a malformed user operation hash', async () => {
    const kernelClient = buildMockKernelClient();
    kernelClient.sendUserOperation.mockResolvedValue('0x1');
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const [result] = await orchestrator.dispatchDeposits('serialized-approval', [
      { pool: '0x00000000000000000000000000000000000000a1', amount: 100n, minShares: 90n },
    ]);

    expect(result).toMatchObject({ status: 'rejected', executionStatus: 'held', txHash: null });
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled();
  });
});

describe('activateMandate', () => {
  it('submits one zero-reset approval before waiting for its successful receipt', async () => {
    const kernelClient = buildMockKernelClient();
    const events = [];
    kernelClient.waitForUserOperationReceipt.mockImplementation(async () => {
      events.push('waited');
      return { success: true, receipt: { status: 'success', transactionHash: TX_HASH } };
    });
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const result = await orchestrator.activateMandate('serialized-approval', {
      onSubmitted: async (userOpHash) => events.push(`submitted:${userOpHash}`),
    });

    expect(events).toEqual([`submitted:${USER_OP_HASH}`, 'waited']);
    expect(result).toEqual({ userOpHash: USER_OP_HASH, txHash: TX_HASH });
    expect(kernelClient.account.encodeCalls).toHaveBeenCalledTimes(1);
    const [calls] = kernelClient.account.encodeCalls.mock.calls[0];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: USDC_ADDRESS, value: 0n });
    expect(decodeFunctionData({ abi: APPROVE_ABI, data: calls[0].data })).toMatchObject({
      functionName: 'approve', args: [YIELD_ROUTER_ADDRESS, 0n],
    });
  });

  it('rejects a malformed user operation hash before notifying or waiting', async () => {
    const kernelClient = buildMockKernelClient();
    kernelClient.sendUserOperation.mockResolvedValue('0x1');
    const onSubmitted = vi.fn();
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    await expect(orchestrator.activateMandate('serialized-approval', { onSubmitted })).rejects.toThrow('canonical user operation hash');
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled();
  });

  it.each([
    [{ success: true, receipt: { status: 'reverted', transactionHash: TX_HASH } }],
    [{ success: false, receipt: { status: 'success', transactionHash: TX_HASH } }],
  ])('rejects a mandate activation when receipt success is only one-sided', async (receipt) => {
    const kernelClient = buildMockKernelClient();
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(receipt);
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    await expect(orchestrator.activateMandate('serialized-approval')).rejects.toThrow();
  });
});
