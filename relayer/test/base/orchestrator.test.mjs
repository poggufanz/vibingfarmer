import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import {
  APPROVE_ABI,
  YIELD_ROUTER_ABI,
  createOrchestrator as createOrchestratorProduction,
  readBaseDepositEvidence,
  USER_OPERATION_EVENT_TOPIC0,
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
const KERNEL_ADDRESS = '0x00000000000000000000000000000000000000aa';
const DEPOSITED_TOPIC0 = '0xf5681f9d0db1b911ac18ee83d515a1cf1051853a9eae418316a2fdf7dea427c5';

function createOrchestrator(config) {
  return createOrchestratorProduction({
    baseCrossChainAvailable: true,
    ...config,
  });
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function task10Allocation(ordinal = 1, overrides = {}) {
  const allocationId = `run-42:bridge:pool-${ordinal}`;
  return {
    identity: {
      networkId: 'stellar-testnet',
      bindingId: '0123456789abcdef0123456789abcdef',
      executionId: `run-42:exec:${allocationId}`,
      allocationId,
      childId: 'abcdef0123456789abcdef0123456789',
    },
    caller: KERNEL_ADDRESS,
    pool: `0x${String(ordinal).padStart(40, '0')}`,
    amount: 1_000_000n,
    minShares: 900_000n,
    ...overrides,
  };
}

function depositedLog(allocation, overrides = {}) {
  const caller = overrides.caller ?? allocation.caller;
  const pool = overrides.pool ?? allocation.pool;
  return {
    address: overrides.address ?? YIELD_ROUTER_ADDRESS,
    topics: [
      DEPOSITED_TOPIC0,
      `0x${caller.slice(2).padStart(64, '0')}`,
      `0x${pool.slice(2).padStart(64, '0')}`,
    ],
    data: `0x${word(overrides.assets ?? allocation.amount)}${word(overrides.shares ?? 912_345n)}`,
    logIndex: overrides.logIndex ?? 7,
    transactionHash: overrides.transactionHash ?? TX_HASH,
  };
}

function task10Receipt(allocation, overrides = {}) {
  return {
    userOpHash: USER_OP_HASH,
    sender: allocation.caller,
    success: true,
    logs: [depositedLog(allocation)],
    receipt: { status: 'success', transactionHash: TX_HASH, logs: [] },
    ...overrides,
  };
}

function buildMockKernelClient() {
  return {
    account: {
      address: '0xSmartAccount',
      encodeCalls: vi.fn().mockResolvedValue('0xencodedCallData'),
      getNonce: vi.fn().mockResolvedValue(17n),
    },
    getBlockNumber: vi.fn().mockResolvedValue(4321n),
    sendUserOperation: vi.fn().mockResolvedValue(USER_OP_HASH),
    waitForUserOperationReceipt: vi.fn(async ({ hash }) => ({
      success: true,
      receipt: { status: 'success', transactionHash: TX_HASH },
    })),
  };
}

describe('dispatchDeposits', () => {
  it('captures a frozen canonical reconcile handle before the submitting fence and reuses its nonce', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.account.getNonce = vi.fn().mockResolvedValue(17n);
    kernelClient.getBlockNumber = vi.fn().mockResolvedValue(4321n);
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(task10Receipt(allocation));
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 },
      rpcUrl: 'https://sepolia.base.org',
      bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    await orchestrator.dispatchDeposits('approval', [allocation], {
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    });

    const handle = checkpoints[0].evidence.reconcileHandle;
    expect(handle).toEqual({
      entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
      sender: KERNEL_ADDRESS,
      nonce: '17',
      startBlock: '4321',
    });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(checkpoints.map(({ evidence }) => evidence.reconcileHandle)).toEqual([handle, handle, handle]);
    expect(kernelClient.sendUserOperation).toHaveBeenCalledWith({
      callData: '0xencodedCallData',
      nonce: 17n,
    });
  });

  it('holds a new durable send when both reconcile readers are unavailable', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.getNonce = undefined;
    kernelClient.getBlockNumber = undefined;
    kernelClient.account.address = KERNEL_ADDRESS;
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const onCheckpoint = vi.fn();
    const orchestrator = createOrchestrator({
      chain: { id: 84532 },
      rpcUrl: 'https://sepolia.base.org',
      bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn,
    });
    const [result] = await orchestrator.dispatchDeposits('approval', [allocation], { onCheckpoint });
    expect(result).toMatchObject({
      status: 'held',
      reasonCode: 'reconcile_handle_unavailable',
    });
    expect(onCheckpoint).not.toHaveBeenCalled();
    expect(kernelClient.account.encodeCalls).not.toHaveBeenCalled();
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it('invokes the post-encode dual fence immediately before exactly one send', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(task10Receipt(allocation));
    const order = [];
    kernelClient.account.encodeCalls.mockImplementation(async () => {
      order.push('encode');
      return '0xencodedCallData';
    });
    kernelClient.sendUserOperation.mockImplementation(async () => {
      order.push('send');
      return USER_OP_HASH;
    });
    const onBeforeSend = vi.fn(async () => {
      order.push('beforeSend');
      return { allowed: true };
    });
    const orchestrator = createOrchestrator({
      chain: { id: 84532 },
      rpcUrl: 'https://sepolia.base.org',
      bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });
    await orchestrator.dispatchDeposits('approval', [allocation], {
      onCheckpoint: async ({ status }) => {
        order.push(status);
      },
      onBeforeSend,
    });
    expect(order.slice(0, 4)).toEqual(['submitting', 'encode', 'beforeSend', 'send']);
    expect(onBeforeSend).toHaveBeenCalledOnce();
    expect(kernelClient.sendUserOperation).toHaveBeenCalledOnce();
  });

  it('writes one durable unknown and performs zero sends when the post-encode fence is lost', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 },
      rpcUrl: 'https://sepolia.base.org',
      bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });
    const [result] = await orchestrator.dispatchDeposits('approval', [allocation], {
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
      onBeforeSend: async () => false,
    });
    expect(result).toMatchObject({
      status: 'uncertain',
      reasonCode: 'pre_submit_fence_lost',
    });
    expect(checkpoints.at(-1)).toMatchObject({
      status: 'unknown',
      evidence: { reasonCode: 'pre_submit_fence_lost', userOpHash: null },
    });
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it('read-only reconciliation proves one bounded EntryPoint operation and one YieldRouter event without a signing client', async () => {
    const allocation = task10Allocation();
    const reconcileHandle = {
      entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
      sender: KERNEL_ADDRESS,
      nonce: '17',
      startBlock: '4321',
    };
    const entryPointLog = {
      address: reconcileHandle.entryPoint,
      topics: [USER_OPERATION_EVENT_TOPIC0],
      args: {
        userOpHash: USER_OP_HASH,
        sender: KERNEL_ADDRESS,
        nonce: 17n,
        success: true,
      },
      transactionHash: TX_HASH,
      blockNumber: 4322n,
    };
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(4330n),
      getLogs: vi.fn().mockResolvedValue([entryPointLog]),
    };
    const bundlerClient = {
      getUserOperation: vi.fn().mockResolvedValue({
        entryPoint: reconcileHandle.entryPoint,
        transactionHash: TX_HASH,
        blockNumber: 4322n,
        userOperation: { sender: KERNEL_ADDRESS, nonce: 17n },
      }),
      getUserOperationReceipt: vi.fn().mockResolvedValue({
        userOpHash: USER_OP_HASH,
        entryPoint: reconcileHandle.entryPoint,
        sender: KERNEL_ADDRESS,
        nonce: 17n,
        success: true,
        receipt: { status: 'success', transactionHash: TX_HASH },
        logs: [depositedLog(allocation)],
      }),
    };

    const result = await readBaseDepositEvidence({
      publicClient,
      bundlerClient,
      allocation,
      reconcileHandle,
      userOpHash: USER_OP_HASH,
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      maxBlocks: 20,
    });

    expect(publicClient.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        address: reconcileHandle.entryPoint,
        fromBlock: 4321n,
        toBlock: 4330n,
      }),
    );
    expect(bundlerClient.getUserOperation).toHaveBeenCalledWith({
      hash: USER_OP_HASH,
    });
    expect(bundlerClient.getUserOperationReceipt).toHaveBeenCalledWith({
      hash: USER_OP_HASH,
    });
    expect(result).toMatchObject({
      status: 'fulfilled',
      userOpHash: USER_OP_HASH,
      transactionHash: TX_HASH,
      executionStatus: 'deposited',
      reconcileHandle,
    });
  });

  it('read-only reconciliation returns owner action for a definitive reverted UserOperation', async () => {
    const allocation = task10Allocation();
    const reconcileHandle = {
      entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
      sender: KERNEL_ADDRESS,
      nonce: '17',
      startBlock: '4321',
    };
    const entryPointLog = {
      address: reconcileHandle.entryPoint,
      topics: [USER_OPERATION_EVENT_TOPIC0],
      args: {
        userOpHash: USER_OP_HASH,
        sender: KERNEL_ADDRESS,
        nonce: 17n,
        success: false,
      },
      transactionHash: TX_HASH,
      blockNumber: 4322n,
    };
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(4330n),
      getLogs: vi.fn().mockResolvedValue([entryPointLog]),
    };
    const bundlerClient = {
      getUserOperation: vi.fn().mockResolvedValue({
        entryPoint: reconcileHandle.entryPoint,
        transactionHash: TX_HASH,
        blockNumber: 4322n,
        userOperation: { sender: KERNEL_ADDRESS, nonce: 17n },
      }),
      getUserOperationReceipt: vi.fn().mockResolvedValue({
        userOpHash: USER_OP_HASH,
        entryPoint: reconcileHandle.entryPoint,
        sender: KERNEL_ADDRESS,
        nonce: 17n,
        success: false,
        receipt: { status: 'success', transactionHash: TX_HASH },
        logs: [],
      }),
    };

    const result = await readBaseDepositEvidence({
      publicClient,
      bundlerClient,
      allocation,
      reconcileHandle,
      userOpHash: USER_OP_HASH,
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      maxBlocks: 20,
    });

    expect(result).toMatchObject({
      status: 'owner_action_required',
      executionStatus: 'failed',
      userOpHash: USER_OP_HASH,
      transactionHash: TX_HASH,
      custodyLocation: 'base-kernel',
      kernelCustodyConfirmed: true,
      custody: { location: 'base-kernel', confirmed: true },
      reconcileHandle,
    });
  });

  it('routes handle recovery through a read-only seam and never reconstructs, encodes, or sends', async () => {
    const allocation = task10Allocation();
    const reconcileHandle = {
      entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
      sender: KERNEL_ADDRESS,
      nonce: '17',
      startBlock: '4321',
    };
    const reconstructSessionClientFn = vi.fn();
    const readBaseDepositEvidenceFn = vi.fn().mockResolvedValue({
      status: 'fulfilled',
      userOpHash: USER_OP_HASH,
      transactionHash: TX_HASH,
      event: {
        address: YIELD_ROUTER_ADDRESS,
        topic0: DEPOSITED_TOPIC0,
        logIndex: '7',
        caller: KERNEL_ADDRESS,
        poolAddress: allocation.pool,
        assets: '1000000',
        shares: '912345',
      },
    });
    const onCheckpoint = vi.fn();
    const orchestrator = createOrchestrator({
      chain: { id: 84532 },
      rpcUrl: 'unused',
      bundlerRpcUrl: 'unused',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn,
      readBaseDepositEvidenceFn,
    });

    const result = await orchestrator.reconcileBaseDeposit({
      allocation,
      reconcileHandle,
      userOpHash: USER_OP_HASH,
      onCheckpoint,
    });

    expect(readBaseDepositEvidenceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        allocation,
        reconcileHandle,
        userOpHash: USER_OP_HASH,
      }),
    );
    expect(reconstructSessionClientFn).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'confirmed',
        evidence: expect.objectContaining({ reconcileHandle }),
      }),
    );
    expect(result).toMatchObject({ status: 'fulfilled', reconcileHandle });
  });

  it('writes one failed Kernel-custody checkpoint for a definitive read-only revert', async () => {
    const allocation = task10Allocation();
    const reconcileHandle = {
      entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032',
      sender: KERNEL_ADDRESS,
      nonce: '17',
      startBlock: '4321',
    };
    const reconstructSessionClientFn = vi.fn();
    const readBaseDepositEvidenceFn = vi.fn().mockResolvedValue({
      status: 'owner_action_required',
      reasonCode: 'base-deposit-failed-kernel-custody',
      userOpHash: USER_OP_HASH,
      transactionHash: TX_HASH,
      reconcileHandle,
      custodyLocation: 'base-kernel',
      kernelCustodyConfirmed: true,
      custody: { location: 'base-kernel', confirmed: true },
    });
    const onCheckpoint = vi.fn();
    const orchestrator = createOrchestrator({
      chain: { id: 84532 },
      rpcUrl: 'unused',
      bundlerRpcUrl: 'unused',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn,
      readBaseDepositEvidenceFn,
    });

    const result = await orchestrator.reconcileBaseDeposit({
      allocation,
      reconcileHandle,
      userOpHash: USER_OP_HASH,
      onCheckpoint,
    });

    expect(reconstructSessionClientFn).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenCalledOnce();
    expect(onCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'base_deposit',
        status: 'failed',
        evidence: expect.objectContaining({
          userOpHash: USER_OP_HASH,
          transactionHash: TX_HASH,
          reasonCode: 'base-deposit-failed-kernel-custody',
          custodyLocation: 'base-kernel',
          kernelCustodyConfirmed: true,
          custody: { location: 'base-kernel', confirmed: true },
          reconcileHandle,
        }),
      }),
    );
    expect(result).toMatchObject({
      status: 'owner_action_required',
      transactionHash: TX_HASH,
    });
  });

  // Defect caught: startup recovery sent a new deposit UserOperation for a child whose exact
  // canonical submitted hash was already durable instead of confirming that hash only.
  it('confirms one exact submitted child without encoding or sending another UserOperation', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(task10Receipt(allocation));
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
      now: () => 2_000_000_000_000,
    });

    const result = await orchestrator.reconcileSubmittedDeposit(
      'serialized-approval', allocation, USER_OP_HASH,
      { onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint) },
    );

    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
    expect(kernelClient.account.encodeCalls).not.toHaveBeenCalled();
    expect(kernelClient.waitForUserOperationReceipt).toHaveBeenCalledWith({
      hash: USER_OP_HASH,
      timeout: 120_000,
    });
    expect(checkpoints).toEqual([
      expect.objectContaining({
        identity: allocation.identity,
        phase: 'base_deposit',
        status: 'confirmed',
        evidence: expect.objectContaining({
          userOpHash: USER_OP_HASH,
          transactionHash: TX_HASH,
        }),
      }),
    ]);
    expect(result).toMatchObject({
      status: 'fulfilled',
      executionStatus: 'deposited',
      userOpHash: USER_OP_HASH,
      transactionHash: TX_HASH,
    });
  });

  it('keeps a transient submitted-hash receipt observation retryable without writing unknown', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.waitForUserOperationReceipt.mockRejectedValue(new Error('bundler timeout'));
    const onCheckpoint = vi.fn();
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const result = await orchestrator.reconcileSubmittedDeposit(
      'approval', allocation, USER_OP_HASH, { onCheckpoint },
    );

    expect(result).toMatchObject({
      status: 'held', executionStatus: 'confirming', reasonCode: 'submitted_receipt_pending',
      userOpHash: USER_OP_HASH,
    });
    expect(onCheckpoint).not.toHaveBeenCalled();
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it('keeps an initial send timeout submitted and confirms only the stored hash after restart', async () => {
    const allocation = task10Allocation();
    const firstClient = buildMockKernelClient();
    firstClient.account.address = KERNEL_ADDRESS;
    firstClient.waitForUserOperationReceipt.mockRejectedValue(new Error('receipt pending'));
    const checkpoints = [];
    const first = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn(async () => firstClient),
    });

    const [pending] = await first.dispatchDeposits('approval', [allocation], {
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(pending).toMatchObject({
      status: 'held', executionStatus: 'confirming', reasonCode: 'submitted_receipt_pending',
      userOpHash: USER_OP_HASH,
    });
    expect(checkpoints.map(({ status }) => status)).toEqual(['submitting', 'submitted']);

    const restartedClient = buildMockKernelClient();
    restartedClient.account.address = KERNEL_ADDRESS;
    restartedClient.waitForUserOperationReceipt.mockResolvedValue(task10Receipt(allocation));
    const restarted = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn(async () => restartedClient),
    });
    const confirmed = await restarted.reconcileSubmittedDeposit(
      'approval', allocation, USER_OP_HASH, { onCheckpoint: vi.fn() },
    );

    expect(confirmed).toMatchObject({
      status: 'fulfilled',
      userOpHash: USER_OP_HASH,
    });
    expect(restartedClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it('awaits durable checkpoints around send/wait and confirms exactly one scoped Deposited event', async () => {
    const allocation = task10Allocation();
    const order = [];
    const checkpoints = [];
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.sendUserOperation.mockImplementation(async () => {
      expect(order).toEqual(['submitting']);
      order.push('send');
      return USER_OP_HASH;
    });
    kernelClient.waitForUserOperationReceipt.mockImplementation(async ({ hash }) => {
      expect(hash).toBe(USER_OP_HASH);
      expect(order).toEqual(['submitting', 'send', 'submitted']);
      order.push('wait');
      return task10Receipt(allocation);
    });
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
      now: () => 2_000_000_000_000,
    });

    const [result] = await orchestrator.dispatchDeposits('serialized-approval', [allocation], {
      onCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
        order.push(checkpoint.status);
      },
    });

    expect(order).toEqual(['submitting', 'send', 'submitted', 'wait', 'confirmed']);
    expect(checkpoints.map(({ status }) => status)).toEqual(['submitting', 'submitted', 'confirmed']);
    expect(checkpoints[2]).toEqual({
      identity: allocation.identity,
      phase: 'base_deposit',
      status: 'confirmed',
      observedAt: 2_000_000_000_000,
      evidence: expect.objectContaining({
        chainId: '84532', caller: KERNEL_ADDRESS, poolAddress: allocation.pool,
        assets: '1000000', minShares: '900000', userOpHash: USER_OP_HASH,
        transactionHash: TX_HASH,
        shares: '912345',
        event: {
          address: YIELD_ROUTER_ADDRESS, topic0: DEPOSITED_TOPIC0, logIndex: '7',
          caller: KERNEL_ADDRESS, poolAddress: allocation.pool, assets: '1000000', shares: '912345',
        },
      }),
    });
    expect(result).toMatchObject({
      identity: allocation.identity, status: 'fulfilled', userOpHash: USER_OP_HASH,
      transactionHash: TX_HASH, executionStatus: 'deposited', custody: { location: 'base-proxy' },
    });
  });

  it('writes definitive failed Kernel-custody evidence when the submitted deposit reverts', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(
      task10Receipt(allocation, {
        success: false,
        logs: [],
        receipt: { status: 'success', transactionHash: TX_HASH },
      }),
    );
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 },
      rpcUrl: 'https://sepolia.base.org',
      bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession',
      reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const [result] = await orchestrator.dispatchDeposits('serialized-approval', [allocation], {
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(checkpoints.map(({ status }) => status)).toEqual(['submitting', 'submitted', 'failed']);
    expect(checkpoints.at(-1)).toMatchObject({
      status: 'failed',
      evidence: {
        userOpHash: USER_OP_HASH,
        transactionHash: TX_HASH,
        reasonCode: 'userop_reverted',
        custodyLocation: 'base-kernel',
        kernelCustodyConfirmed: true,
        custody: { location: 'base-kernel', confirmed: true },
      },
    });
    expect(result).toMatchObject({
      status: 'owner_action_required',
      executionStatus: 'failed',
      userOpHash: USER_OP_HASH,
      transactionHash: TX_HASH,
      custody: { location: 'base-kernel', confirmed: true },
    });
    expect(kernelClient.sendUserOperation).toHaveBeenCalledOnce();
  });

  it('never encodes or sends when another process owns the durable submitting fence', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const results = await orchestrator.dispatchDeposits('approval', [allocation], {
      onClaimSubmitting: vi.fn(async () => ({
        claimed: false,
        ownerToken: null,
      })),
      onCheckpoint: vi.fn(),
    });

    expect(results).toMatchObject([{
      status: 'held', executionStatus: 'held', reasonCode: 'submission_claim_held',
    }]);
    expect(kernelClient.account.encodeCalls).not.toHaveBeenCalled();
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it('fresh-gates after deferred client reconstruction and before claiming or sending', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    let releaseReconstruction;
    const reconstructSessionClientFn = vi.fn(() => new Promise((resolve) => {
      releaseReconstruction = () => resolve(kernelClient);
    }));
    const onBeforeClaimSubmitting = vi.fn(async () => false);
    const onClaimSubmitting = vi.fn(async () => ({
      claimed: true,
      ownerToken: 'must-not-claim',
    }));
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn,
    });

    const pending = orchestrator.dispatchDeposits('approval', [allocation], {
      onBeforeClaimSubmitting, onClaimSubmitting, onCheckpoint: vi.fn(),
    });
    await vi.waitFor(() => expect(reconstructSessionClientFn).toHaveBeenCalledOnce());
    expect(onBeforeClaimSubmitting).not.toHaveBeenCalled();
    releaseReconstruction();
    const results = await pending;

    expect(onBeforeClaimSubmitting).toHaveBeenCalledOnce();
    expect(onClaimSubmitting).not.toHaveBeenCalled();
    expect(kernelClient.account.encodeCalls).not.toHaveBeenCalled();
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      status: 'held', reasonCode: 'authority_changed_before_submission',
    });
  });

  it('passes the final authority snapshot only to the atomic submission claim callback', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    const authoritySnapshot = {
      mandateId: '01'.repeat(16), capabilityHash: '02'.repeat(32), updatedAt: 123,
    };
    const onClaimSubmitting = vi.fn(async () => ({
      claimed: false, ownerToken: null, reasonCode: 'mandate_authority_changed',
    }));
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn(async () => kernelClient),
    });

    const results = await orchestrator.dispatchDeposits('approval', [allocation], {
      onBeforeClaimSubmitting: vi.fn(async () => ({
        authorized: true,
        authoritySnapshot,
      })),
      onClaimSubmitting,
      onCheckpoint: vi.fn(),
    });

    expect(onClaimSubmitting).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'submitting' }),
      { authoritySnapshot },
    );
    expect(results[0]).toMatchObject({
      status: 'held', reasonCode: 'authority_changed_before_submission',
    });
    expect(JSON.stringify(results)).not.toMatch(/capabilityHash|02020202/);
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it('stops every later sibling when the first durable submission claim is held', async () => {
    const allocations = [task10Allocation(1), task10Allocation(2)];
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    const onClaimSubmitting = vi.fn(async () => ({
      claimed: false,
      ownerToken: null,
    }));
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn(async () => kernelClient),
    });

    const results = await orchestrator.dispatchDeposits('approval', allocations, {
      onClaimSubmitting, onCheckpoint: vi.fn(),
    });

    expect(onClaimSubmitting).toHaveBeenCalledOnce();
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
    expect(results).toMatchObject([
      { status: 'held', reasonCode: 'submission_claim_held' },
      { status: 'held', reasonCode: 'not_dispatched_after_unknown' },
    ]);
  });

  it('carries the private submission owner only to later durable callbacks', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(task10Receipt(allocation));
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    await orchestrator.dispatchDeposits('approval', [allocation], {
      onClaimSubmitting: vi.fn(async () => ({
        claimed: true,
        ownerToken: 'private-owner',
      })),
      onCheckpoint: vi.fn(async (entry, ownership) => checkpoints.push([entry.status, ownership])),
    });

    expect(checkpoints).toEqual([
      ['submitted', { ownerToken: 'private-owner' }],
      ['confirmed', undefined],
    ]);
  });

  it('marks a successful receipt without top-level scoped proof unknown and holds later sends', async () => {
    const first = task10Allocation(1);
    const second = task10Allocation(2);
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(
      task10Receipt(first, {
        logs: [],
        receipt: {
          status: 'success',
          transactionHash: TX_HASH,
          logs: [depositedLog(first)],
        },
      }),
    );
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const results = await orchestrator.dispatchDeposits('serialized-approval', [first, second], {
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1);
    expect(checkpoints.at(-1)).toMatchObject({
      identity: first.identity,
      status: 'unknown',
      evidence: {
        userOpHash: USER_OP_HASH,
        transactionHash: TX_HASH,
        reasonCode: 'deposit_event_missing',
      },
    });
    expect(results[0]).toMatchObject({ status: 'uncertain', executionStatus: 'unknown', userOpHash: USER_OP_HASH, transactionHash: TX_HASH });
    expect(results[1]).toMatchObject({ status: 'held', executionStatus: 'held', reasonCode: 'not_dispatched_after_unknown' });
  });

  it('retains the canonical send hash and never waits or continues when submitted persistence fails', async () => {
    const first = task10Allocation(1);
    const second = task10Allocation(2);
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const results = await orchestrator.dispatchDeposits('serialized-approval', [first, second], {
      onCheckpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
        if (checkpoint.status === 'submitted') throw new Error('sqlite unavailable');
      },
    });

    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled();
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1);
    expect(checkpoints.at(-1)).toMatchObject({
      status: 'unknown',
      evidence: {
        userOpHash: USER_OP_HASH,
        reasonCode: 'submitted_checkpoint_failed',
      },
    });
    expect(results[0]).toMatchObject({
      executionStatus: 'unknown',
      userOpHash: USER_OP_HASH,
    });
    expect(results[1]).toMatchObject({
      reasonCode: 'not_dispatched_after_unknown',
    });
  });

  it('does not wait for a receipt until submitted persistence has resolved', async () => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(task10Receipt(allocation));
    let releaseSubmitted;
    const submittedGate = new Promise((resolve) => { releaseSubmitted = resolve; });
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const pending = orchestrator.dispatchDeposits('approval', [allocation], {
      onCheckpoint: async ({ status }) => {
        if (status === 'submitted') await submittedGate;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled();
    releaseSubmitted();
    await expect(pending).resolves.toMatchObject([{ status: 'fulfilled' }]);
  });

  it.each([
    ['receipt UserOp mismatch', (a) => task10Receipt(a, { userOpHash: `0x${'c'.repeat(64)}` }), 'receipt_ambiguous'],
    ['receipt sender mismatch', (a) => task10Receipt(a, { sender: `0x${'c'.repeat(40)}` }), 'deposit_event_mismatch'],
    ['missing scoped logs', (a) => task10Receipt(a, { logs: undefined }), 'deposit_event_missing'],
    [
      'spoof router',
      (a) =>
        task10Receipt(a, {
          logs: [depositedLog(a, { address: `0x${'d'.repeat(40)}` })],
        }),
      'deposit_event_missing',
    ],
    [
      'wrong caller',
      (a) =>
        task10Receipt(a, {
          logs: [depositedLog(a, { caller: `0x${'c'.repeat(40)}` })],
        }),
      'deposit_event_mismatch',
    ],
    [
      'wrong pool',
      (a) =>
        task10Receipt(a, {
          logs: [depositedLog(a, { pool: `0x${'d'.repeat(40)}` })],
        }),
      'deposit_event_mismatch',
    ],
    [
      'wrong assets',
      (a) => task10Receipt(a, { logs: [depositedLog(a, { assets: 999_999n })] }),
      'deposit_event_mismatch',
    ],
    [
      'shares below minimum',
      (a) => task10Receipt(a, { logs: [depositedLog(a, { shares: 899_999n })] }),
      'deposit_event_mismatch',
    ],
    [
      'duplicate event',
      (a) =>
        task10Receipt(a, {
          logs: [depositedLog(a), depositedLog(a, { logIndex: 8 })],
        }),
      'deposit_event_ambiguous',
    ],
    [
      'log transaction mismatch',
      (a) =>
        task10Receipt(a, {
          logs: [depositedLog(a, { transactionHash: `0x${'c'.repeat(64)}` })],
        }),
      'receipt_ambiguous',
    ],
    [
      'log block mismatch',
      (a) =>
        task10Receipt(a, {
          logs: [
            {
              ...depositedLog(a),
              blockHash: `0x${'c'.repeat(64)}`,
              blockNumber: 8n,
            },
          ],
          receipt: {
            status: 'success',
            transactionHash: TX_HASH,
            blockHash: `0x${'d'.repeat(64)}`,
            blockNumber: 7n,
            logs: [],
          },
        }),
      'receipt_ambiguous',
    ],
  ])('never confirms %s', async (_label, receiptFor, reasonCode) => {
    const allocation = task10Allocation();
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.waitForUserOperationReceipt.mockResolvedValue(receiptFor(allocation));
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });
    const [result] = await orchestrator.dispatchDeposits('approval', [allocation], {
      onCheckpoint: async (entry) => checkpoints.push(entry),
    });
    expect(result).toMatchObject({
      status: 'uncertain',
      executionStatus: 'unknown',
      reasonCode,
      userOpHash: USER_OP_HASH,
    });
    expect(checkpoints.at(-1)).toMatchObject({
      status: 'unknown',
      evidence: { reasonCode },
    });
    expect(checkpoints.some(({ status }) => status === 'confirmed')).toBe(false);
  });

  it.each([
    ['missing identity', (a) => ({ ...a, identity: undefined })],
    ['extra identity field', (a) => ({ ...a, identity: { ...a.identity, owner: 'forbidden' } })],
    [
      'noncanonical execution mapping',
      (a) => ({
        ...a,
        identity: { ...a.identity, executionId: 'run-42:exec:wrong' },
      }),
    ],
    ['numeric amount', (a) => ({ ...a, amount: 100 })],
    ['noncanonical pool', (a) => ({ ...a, pool: '0x1' })],
  ])('rejects %s before reconstructing the signing client', async (_label, mutate) => {
    const reconstructSessionClientFn = vi.fn();
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn,
    });
    await expect(orchestrator.dispatchDeposits('approval', [mutate(task10Allocation())], {
      onCheckpoint: vi.fn(),
    })).rejects.toThrow();
    expect(reconstructSessionClientFn).not.toHaveBeenCalled();
  });

  it('stops the batch when the submitting durability callback outcome is ambiguous', async () => {
    const allocations = [task10Allocation(1), task10Allocation(2)];
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const results = await orchestrator.dispatchDeposits('approval', allocations, {
      onCheckpoint: vi.fn(async () => { throw new Error('commit response lost'); }),
    });

    expect(results).toMatchObject([
      {
        executionStatus: 'unknown',
        reasonCode: 'submitting_checkpoint_ambiguous',
      },
      { executionStatus: 'held', reasonCode: 'not_dispatched_after_unknown' },
    ]);
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it('continues only when a submitting callback explicitly proves it was not committed', async () => {
    const allocations = [task10Allocation(1), task10Allocation(2)];
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    const error = new Error('validation rejected');
    error.checkpointOutcome = 'not_committed';
    let submitting = 0;
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const results = await orchestrator.dispatchDeposits('approval', allocations, {
      onCheckpoint: vi.fn(async ({ status }) => {
        if (status === 'submitting' && submitting++ === 0) throw error;
      }),
    });

    expect(results[0]).toMatchObject({
      executionStatus: 'held', reasonCode: 'pre_submit_validation',
    });
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1);
  });

  it('classifies deterministic call encoding failure as pre-submit validation without sending it', async () => {
    const allocations = [task10Allocation(1), task10Allocation(2)];
    const kernelClient = buildMockKernelClient();
    kernelClient.account.address = KERNEL_ADDRESS;
    kernelClient.account.encodeCalls
      .mockRejectedValueOnce(new Error('cannot encode deterministic call'))
      .mockResolvedValueOnce('0xencoded');
    const checkpoints = [];
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS, usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn: vi.fn().mockResolvedValue(kernelClient),
    });

    const results = await orchestrator.dispatchDeposits('approval', allocations, {
      onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(results[0]).toMatchObject({
      executionStatus: 'held', reasonCode: 'pre_submit_validation',
    });
    expect(checkpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'failed', evidence: expect.objectContaining({
        reasonCode: 'pre_submit_validation', userOpHash: null, transactionHash: null,
      }) }),
    ]));
    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1);
  });
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
      {
        pool: '0x00000000000000000000000000000000000000a1',
        amount: 100n,
        minShares: 90n,
      },
      {
        pool: '0x00000000000000000000000000000000000000b2',
        amount: 200n,
        minShares: 190n,
      },
      {
        pool: '0x00000000000000000000000000000000000000c3',
        amount: 300n,
        minShares: 290n,
      },
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
      {
        pool: '0x00000000000000000000000000000000000000a1',
        amount: 100n,
        minShares: 90n,
      },
      {
        pool: '0x00000000000000000000000000000000000000b2',
        amount: 200n,
        minShares: 190n,
      },
      {
        pool: '0x00000000000000000000000000000000000000c3',
        amount: 300n,
        minShares: 290n,
      },
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
              res({
                success: true,
                receipt: { status: 'success', transactionHash: TX_HASH },
              });
          })
        : Promise.resolve({
            success: true,
            receipt: { status: 'success', transactionHash: TX_HASH },
          }),
    );
    const reconstructSessionClientFn = vi.fn().mockResolvedValue(kernelClient);
    const orchestrator = createOrchestrator({
      chain: { id: 84532 }, rpcUrl: 'https://sepolia.base.org', bundlerRpcUrl: 'https://rpc.zerodev.app/x',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xsession', reconstructSessionClientFn,
    });

    const allocations = [
      {
        pool: '0x00000000000000000000000000000000000000a1',
        amount: 100n,
        minShares: 90n,
      },
      {
        pool: '0x00000000000000000000000000000000000000b2',
        amount: 200n,
        minShares: 190n,
      },
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
      const approval = decodeFunctionData({
        abi: APPROVE_ABI,
        data: calls[0].data,
      });
      const deposit = decodeFunctionData({
        abi: YIELD_ROUTER_ABI,
        data: calls[1].data,
      });
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
      {
        pool: '0x00000000000000000000000000000000000000a1',
        amount: MAX_CALL_CAP_UNITS,
        minShares: 1n,
      },
      {
        pool: '0x00000000000000000000000000000000000000b2',
        amount: MAX_CALL_CAP_UNITS + 1n,
        minShares: 1n,
      },
    ];

    await expect(orchestrator.dispatchDeposits('serialized-approval', allocations)).rejects.toThrow(/cap/i);
    expect(reconstructSessionClientFn).not.toHaveBeenCalled();
    expect(kernelClient.sendUserOperation).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        success: true,
        receipt: { status: 'reverted', transactionHash: TX_HASH },
      },
    ],
    [
      {
        success: false,
        receipt: { status: 'success', transactionHash: TX_HASH },
      },
    ],
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
      {
        pool: '0x00000000000000000000000000000000000000a1',
        amount: 100n,
        minShares: 90n,
      },
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      executionStatus: 'held',
      txHash: null,
    });
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
      {
        pool: '0x00000000000000000000000000000000000000a1',
        amount: 100n,
        minShares: 90n,
      },
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      executionStatus: 'held',
      txHash: null,
    });
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled();
  });
});

describe('activateMandate', () => {
  it('submits one zero-reset approval before waiting for its successful receipt', async () => {
    const kernelClient = buildMockKernelClient();
    const events = [];
    kernelClient.waitForUserOperationReceipt.mockImplementation(async () => {
      events.push('waited');
      return {
        success: true,
        receipt: { status: 'success', transactionHash: TX_HASH },
      };
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
    [
      {
        success: true,
        receipt: { status: 'reverted', transactionHash: TX_HASH },
      },
    ],
    [
      {
        success: false,
        receipt: { status: 'success', transactionHash: TX_HASH },
      },
    ],
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

describe('Base deployment availability gate', () => {
  it.each([
    ['string false', 'false'],
    ['numeric one', 1],
    ['object', {}],
  ])('rejects truthy non-boolean availability: %s', async (_label, baseCrossChainAvailable) => {
    const reconstructSessionClientFn = vi.fn(() => {
      throw new Error('session client must not be reconstructed');
    });
    const orchestrator = createOrchestratorProduction({
      baseCrossChainAvailable,
      reconstructSessionClientFn,
    });

    await expect(orchestrator.activateMandate('legacy-approval'))
      .rejects.toThrow('Base cross-chain execution is unavailable');
    expect(reconstructSessionClientFn).not.toHaveBeenCalled();
  });

  it('fails closed when a caller omits deployment availability', async () => {
    const reconstructSessionClientFn = vi.fn();
    const orchestrator = createOrchestratorProduction({
      reconstructSessionClientFn,
    });

    await expect(orchestrator.dispatchDeposits('legacy-approval', []))
      .rejects.toThrow('Base cross-chain execution is unavailable');
    expect(reconstructSessionClientFn).not.toHaveBeenCalled();
  });

  it('rejects activation, deposit dispatch, and submitted recovery before key/client/RPC work', async () => {
    const reconstructSessionClientFn = vi.fn(() => {
      throw new Error('session client must not be reconstructed');
    });
    const orchestrator = createOrchestrator({
      chain: { id: 84532 },
      rpcUrl: 'https://legacy-rpc.invalid',
      bundlerRpcUrl: 'https://legacy-bundler.invalid',
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      sessionPrivateKey: '0xlegacy-session-key',
      baseCrossChainAvailable: false,
      reconstructSessionClientFn,
    });

    await expect(orchestrator.activateMandate('legacy-approval'))
      .rejects.toThrow('Base cross-chain execution is unavailable');
    await expect(orchestrator.dispatchDeposits('legacy-approval', []))
      .rejects.toThrow('Base cross-chain execution is unavailable');
    await expect(orchestrator.reconcileSubmittedDeposit('legacy-approval', null, null))
      .rejects.toThrow('Base cross-chain execution is unavailable');
    expect(reconstructSessionClientFn).not.toHaveBeenCalled();
  });
});
