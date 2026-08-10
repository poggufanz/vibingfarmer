// Fires the AI strategist's per-pool allocations as gasless session-key userOps against
// YieldRouter.deposit, one per allocation, SERIALLY, with allSettled-shaped results so a single
// rejected pool (paused, cap hit, expired session) never aborts the rest of the swarm.
// Serial is load-bearing, not a style choice: every userOp comes from the SAME session smart
// account, and the first one carries the account deployment + permission-enable. Dispatching a
// second op before the first lands makes the bundler simulate the enable again — proven live as
// `AA23 reverted duplicate permissionHash` (zd_sponsorUserOperation 400) on the 2nd pool.

import { createPublicClient, decodeEventLog, encodeFunctionData, http } from 'viem';
import { ENTRY_POINT, reconstructSessionClient, MAX_CALL_CAP_UNITS } from './session.mjs';
import { normalizeReconcileHandle, PINNED_ENTRY_POINT } from '../baseEvidenceValidation.mjs';
import { requireCanonicalUserOperationHash, requireSuccessfulUserOperation } from './userOpReceipt.mjs';

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
export const DEPOSITED_TOPIC0 = '0xf5681f9d0db1b911ac18ee83d515a1cf1051853a9eae418316a2fdf7dea427c5';
export const USER_OPERATION_EVENT_TOPIC0 = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
export const DEFAULT_RECONCILE_MAX_BLOCKS = 256;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const IDENTITY_FIELDS = new Set([
  'networkId', 'bindingId', 'executionId', 'allocationId', 'childId',
]);

class DepositObservationError extends Error {
  constructor(reasonCode, message, { transactionHash = null, definitive = false } = {}) {
    super(message);
    this.code = 'BASE_DEPOSIT_OBSERVATION';
    this.reasonCode = reasonCode;
    this.transactionHash = transactionHash;
    this.definitive = definitive;
  }
}

export class BaseDepositReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BaseDepositReconciliationError';
    this.code = code;
  }
}

const USER_OPERATION_EVENT_ABI = [
  {
    type: 'event',
    name: 'UserOperationEvent',
    inputs: [
      { name: 'userOpHash', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'paymaster', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'success', type: 'bool', indexed: false },
      { name: 'actualGasCost', type: 'uint256', indexed: false },
      { name: 'actualGasUsed', type: 'uint256', indexed: false },
    ],
  },
];

function reconcilePending(reasonCode, allocation, handle, userOpHash = null) {
  return {
    identity: allocation.identity,
    allocationId: allocation.identity.allocationId,
    pool: allocation.pool,
    status: 'held',
    reasonCode,
    executionStatus: 'confirming',
    custody: { location: 'agent' },
    userOpHash,
    transactionHash: null,
    txHash: null,
    reconcileHandle: handle,
  };
}

function canonicalUnsigned(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value.toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value;
  throw new BaseDepositReconciliationError(
    'BASE_DEPOSIT_RECONCILE_MISMATCH',
    `${label} is not a canonical unsigned decimal`,
  );
}

function rpcUnsigned(value, label) {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    try {
      return BigInt(value).toString(10);
    } catch {
      /* stable mismatch below */
    }
  }
  return canonicalUnsigned(value, label);
}

function canonicalHash(value, label) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (!HASH_RE.test(normalized)) {
    throw new BaseDepositReconciliationError('BASE_DEPOSIT_RECONCILE_VALIDATION', `${label} must be a canonical hash`);
  }
  return normalized;
}

function reconcileReadError(message, cause) {
  const error = new BaseDepositReconciliationError('BASE_DEPOSIT_RECONCILE_RETRYABLE', message);
  error.cause = cause;
  return error;
}

function decodeUserOperationEvent(log) {
  if (log?.args && typeof log.args === 'object') {
    return { log, args: log.args };
  }
  try {
    return {
      log,
      args: decodeEventLog({
        abi: USER_OPERATION_EVENT_ABI,
        eventName: 'UserOperationEvent',
        topics: log?.topics,
        data: log?.data,
        strict: true,
      }).args,
    };
  } catch {
    throw new BaseDepositReconciliationError(
      'BASE_DEPOSIT_RECONCILE_MISMATCH',
      'EntryPoint UserOperationEvent is malformed',
    );
  }
}

function logAddress(log, label) {
  return canonicalAddress(log?.address, `${label} address`);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const unexpected = keys.find((field) => !fields.has(field));
  const missing = [...fields].find((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (unexpected || missing) throw new Error(`${label} has invalid fields`);
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  return value;
}

function canonicalAddress(value, label) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (!ADDRESS_RE.test(normalized)) throw new Error(`${label} must be a canonical EVM address`);
  return normalized;
}

function normalizeAllocation(allocation) {
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) {
    throw new Error('allocation must be an object');
  }
  exactObject(allocation.identity, IDENTITY_FIELDS, 'allocation identity');
  const identity = Object.fromEntries([...IDENTITY_FIELDS].map((field) => [
    field, requireText(allocation.identity[field], `identity.${field}`),
  ]));
  const marker = ':exec:';
  const split = identity.executionId.indexOf(marker);
  if (split <= 0 || identity.executionId.slice(split + marker.length) !== identity.allocationId) {
    throw new Error('executionId must match runId and allocationId');
  }
  if (typeof allocation.amount !== 'bigint' || allocation.amount <= 0n) {
    throw new Error('allocation amount must be a positive bigint');
  }
  if (typeof allocation.minShares !== 'bigint' || allocation.minShares < 0n) {
    throw new Error('allocation minShares must be a non-negative bigint');
  }
  return {
    ...allocation,
    identity,
    caller: canonicalAddress(allocation.caller, 'allocation caller'),
    pool: canonicalAddress(allocation.pool, 'allocation pool'),
  };
}

function decimalLogIndex(value) {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed.toString(10);
  } catch {
    throw new DepositObservationError('deposit_event_malformed', 'deposit event log index is malformed');
  }
}

function topicAddress(value) {
  if (typeof value !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) {
    throw new DepositObservationError('deposit_event_malformed', 'deposit event indexed address is malformed');
  }
  return `0x${value.slice(-40).toLowerCase()}`;
}

function parseDepositEvent(log, allocation, routerAddress, receiptMetadata, userOpHash) {
  const receiptTxHash = receiptMetadata.transactionHash;
  if (!Array.isArray(log.topics) || log.topics.length !== 3
      || String(log.topics[0]).toLowerCase() !== DEPOSITED_TOPIC0
      || typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(log.data)) {
    throw new DepositObservationError('deposit_event_malformed', 'deposit event encoding is malformed', {
      transactionHash: receiptTxHash,
    });
  }
  for (const [field, expected] of [
    ['transactionHash', receiptTxHash], ['userOpHash', userOpHash],
  ]) {
    if (log[field] !== undefined && String(log[field]).toLowerCase() !== expected) {
      throw new DepositObservationError('receipt_ambiguous', 'deposit event metadata disagrees with receipt', {
        transactionHash: receiptTxHash,
      });
    }
  }
  if (log.blockHash !== undefined
      && (typeof receiptMetadata.blockHash !== 'string'
        || String(log.blockHash).toLowerCase() !== receiptMetadata.blockHash.toLowerCase())) {
    throw new DepositObservationError('receipt_ambiguous', 'deposit event block hash disagrees with receipt', {
      transactionHash: receiptTxHash,
    });
  }
  if (log.blockNumber !== undefined) {
    try {
      if (receiptMetadata.blockNumber === undefined
          || BigInt(log.blockNumber) !== BigInt(receiptMetadata.blockNumber)) throw new Error();
    } catch {
      throw new DepositObservationError('receipt_ambiguous', 'deposit event block number disagrees with receipt', {
        transactionHash: receiptTxHash,
      });
    }
  }
  const caller = topicAddress(log.topics[1]);
  const poolAddress = topicAddress(log.topics[2]);
  const assets = BigInt(`0x${log.data.slice(2, 66)}`);
  const shares = BigInt(`0x${log.data.slice(66, 130)}`);
  if (caller !== allocation.caller || poolAddress !== allocation.pool
      || assets !== allocation.amount || shares <= 0n || shares < allocation.minShares) {
    throw new DepositObservationError('deposit_event_mismatch', 'deposit event disagrees with immutable intent', {
      transactionHash: receiptTxHash,
    });
  }
  return {
    address: routerAddress,
    topic0: DEPOSITED_TOPIC0,
    logIndex: decimalLogIndex(log.logIndex),
    caller,
    poolAddress,
    assets: assets.toString(10),
    shares: shares.toString(10),
  };
}

function proveDepositReceipt(receipt, allocation, routerAddress, userOpHash) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || typeof receipt.userOpHash !== 'string' || !HASH_RE.test(receipt.userOpHash.toLowerCase())
      || receipt.userOpHash.toLowerCase() !== userOpHash) {
    throw new DepositObservationError('receipt_ambiguous', 'user operation receipt is ambiguous');
  }
    const sender = typeof receipt.sender === 'string' ? receipt.sender.toLowerCase() : '';
  if (!ADDRESS_RE.test(sender) || sender !== allocation.caller) {
    throw new DepositObservationError('deposit_event_mismatch', 'receipt sender disagrees with immutable caller');
  }
  const txCandidate = receipt.receipt?.transactionHash;
  const transactionHash = typeof txCandidate === 'string' ? txCandidate.toLowerCase() : null;
  if (receipt.success !== true || receipt.receipt?.status !== 'success') {
    throw new DepositObservationError('userop_reverted', 'deposit user operation reverted', {
      transactionHash: transactionHash && HASH_RE.test(transactionHash) ? transactionHash : null,
      definitive: true,
    });
  }
  if (!transactionHash || !HASH_RE.test(transactionHash)) {
    throw new DepositObservationError('receipt_ambiguous', 'receipt transaction hash is ambiguous');
  }
  if (!Array.isArray(receipt.logs)) {
    throw new DepositObservationError('deposit_event_missing', 'user-operation-scoped logs are missing', {
      transactionHash,
    });
  }
  const candidates = receipt.logs.filter((log) => (
    typeof log?.address === 'string'
      && log.address.toLowerCase() === routerAddress
      && String(log?.topics?.[0] || '').toLowerCase() === DEPOSITED_TOPIC0
  ));
  if (candidates.length === 0) {
    throw new DepositObservationError('deposit_event_missing', 'canonical deposit event is missing', {
      transactionHash,
    });
  }
  if (candidates.length !== 1) {
    throw new DepositObservationError('deposit_event_ambiguous', 'canonical deposit event is ambiguous', {
      transactionHash,
    });
  }
  return {
    transactionHash,
    event: parseDepositEvent(candidates[0], allocation, routerAddress, {
      transactionHash,
      blockHash: receipt.receipt?.blockHash,
      blockNumber: receipt.receipt?.blockNumber,
    }, userOpHash),
  };
}

/**
 * Read-only authority seam for a Base deposit.  It searches only the bounded block window
 * captured in `reconcileHandle`, selects exactly one EntryPoint UserOperationEvent, then
 * verifies the corresponding bundler UserOperation/receipt and exactly one canonical
 * YieldRouter Deposited event.  This function deliberately has no account reconstruction,
 * call encoding, signing, or send capability.
 *
 * `userOpHash` is optional for a crash after the submitting fence but before the bundler hash
 * reached durable storage; the unique EntryPoint event supplies it in that case.  A historical
 * hash-only row continues through `reconcileSubmittedDeposit`, which is the compatibility path.
 */
export async function readBaseDepositEvidence({
  publicClient,
  bundlerClient,
  allocation: allocationInput,
  reconcileHandle: handleInput,
  userOpHash: userOpHashInput = null,
  yieldRouterAddress,
  maxBlocks = DEFAULT_RECONCILE_MAX_BLOCKS,
} = {}) {
  const allocation = normalizeAllocation(allocationInput);
  const reconcileHandle = normalizeReconcileHandle(handleInput, {
    sender: allocation.caller,
  });
  const userOpHash = userOpHashInput == null ? null : canonicalHash(userOpHashInput, 'userOpHash');
  const routerAddress = canonicalAddress(yieldRouterAddress, 'YieldRouter address');
  if (
    !publicClient ||
    typeof publicClient.getBlockNumber !== 'function' ||
    typeof publicClient.getLogs !== 'function' ||
    !bundlerClient ||
    typeof bundlerClient.getUserOperation !== 'function' ||
    typeof bundlerClient.getUserOperationReceipt !== 'function'
  ) {
    throw new BaseDepositReconciliationError(
      'BASE_DEPOSIT_RECONCILE_VALIDATION',
      'read-only Base reconciliation clients are unavailable',
    );
  }
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 0) {
    throw new BaseDepositReconciliationError(
      'BASE_DEPOSIT_RECONCILE_VALIDATION',
      'reconciliation maxBlocks must be a non-negative safe integer',
    );
  }

  const fromBlock = BigInt(reconcileHandle.startBlock);
  let latestBlock;
  try {
    latestBlock = BigInt(await publicClient.getBlockNumber());
  } catch (error) {
    throw reconcileReadError('Base reconciliation block read is unavailable', error);
  }
  if (latestBlock < fromBlock) {
    return reconcilePending('reconcile_start_block_pending', allocation, reconcileHandle, userOpHash);
  }
  const boundedToBlock = fromBlock + BigInt(maxBlocks);
  const toBlock = latestBlock < boundedToBlock ? latestBlock : boundedToBlock;
  let rawEntryPointLogs;
  try {
    rawEntryPointLogs = await publicClient.getLogs({
      address: reconcileHandle.entryPoint,
      topics: [USER_OPERATION_EVENT_TOPIC0],
      fromBlock,
      toBlock,
    });
  } catch (error) {
    throw reconcileReadError('Base reconciliation EntryPoint log read is unavailable', error);
  }
  if (!Array.isArray(rawEntryPointLogs)) {
    throw new BaseDepositReconciliationError('BASE_DEPOSIT_RECONCILE_MISMATCH', 'EntryPoint log result is malformed');
  }
  const decodedEntries = rawEntryPointLogs
    .filter((log) => {
      try {
        return (
          logAddress(log, 'EntryPoint') === reconcileHandle.entryPoint &&
          String(log?.topics?.[0] || '').toLowerCase() === USER_OPERATION_EVENT_TOPIC0
        );
      } catch {
        return false;
      }
    })
    .map(decodeUserOperationEvent)
    .filter(({ args }) => {
      const sender = typeof args?.sender === 'string' ? args.sender.toLowerCase() : '';
      const nonce = (() => {
        try {
          return rpcUnsigned(args?.nonce, 'EntryPoint nonce');
        } catch {
          return null;
        }
      })();
      const hash = typeof args?.userOpHash === 'string' ? args.userOpHash.toLowerCase() : '';
      return (
        sender === reconcileHandle.sender &&
        nonce === reconcileHandle.nonce &&
        (userOpHash === null || hash === userOpHash)
      );
    });
  if (decodedEntries.length === 0) {
    return reconcilePending(
      latestBlock > toBlock ? 'reconcile_window_exhausted' : 'reconcile_userop_pending',
      allocation,
      reconcileHandle,
      userOpHash,
    );
  }
  if (decodedEntries.length !== 1) {
    throw new BaseDepositReconciliationError(
      'BASE_DEPOSIT_RECONCILE_AMBIGUOUS',
      'exactly one matching EntryPoint UserOperation is required',
    );
  }
  const [entry] = decodedEntries;
  const discoveredHash = canonicalHash(entry.args.userOpHash, 'EntryPoint userOpHash');
  const entryPointLogTx =
    entry.log?.transactionHash == null ? null : canonicalHash(entry.log.transactionHash, 'EntryPoint transactionHash');
  const entryPointLogBlock =
    entry.log?.blockNumber == null ? null : rpcUnsigned(entry.log.blockNumber, 'EntryPoint block number');
  if (entryPointLogBlock !== null && (BigInt(entryPointLogBlock) < fromBlock || BigInt(entryPointLogBlock) > toBlock)) {
    throw new BaseDepositReconciliationError(
      'BASE_DEPOSIT_RECONCILE_MISMATCH',
      'EntryPoint UserOperation is outside the reconcile window',
    );
  }

  let fullUserOperation;
  try {
    fullUserOperation = await bundlerClient.getUserOperation({
      hash: discoveredHash,
    });
  } catch (error) {
    throw reconcileReadError('Base reconciliation UserOperation read is unavailable', error);
  }
  if (!fullUserOperation) {
    return reconcilePending('reconcile_userop_pending', allocation, reconcileHandle, discoveredHash);
  }
  const signedUserOperation = fullUserOperation.userOperation;
  if (!signedUserOperation || typeof signedUserOperation !== 'object' || Array.isArray(signedUserOperation)) {
    throw new BaseDepositReconciliationError('BASE_DEPOSIT_RECONCILE_MISMATCH', 'full UserOperation is malformed');
  }
  const fullEntryPoint = canonicalAddress(fullUserOperation.entryPoint, 'full UserOperation EntryPoint');
  const fullSender = canonicalAddress(signedUserOperation.sender, 'full UserOperation sender');
  const fullNonce = rpcUnsigned(signedUserOperation.nonce, 'full UserOperation nonce');
  const fullBlockNumber = rpcUnsigned(fullUserOperation.blockNumber, 'full UserOperation block number');
  const fullTransactionHash = canonicalHash(fullUserOperation.transactionHash, 'full UserOperation transactionHash');
  if (
    fullEntryPoint !== PINNED_ENTRY_POINT ||
    fullEntryPoint !== reconcileHandle.entryPoint ||
    fullSender !== reconcileHandle.sender ||
    fullNonce !== reconcileHandle.nonce ||
    BigInt(fullBlockNumber) < fromBlock ||
    BigInt(fullBlockNumber) > toBlock ||
    (entryPointLogTx !== null && entryPointLogTx !== fullTransactionHash)
  ) {
    throw new BaseDepositReconciliationError(
      'BASE_DEPOSIT_RECONCILE_MISMATCH',
      'full UserOperation disagrees with reconcile handle',
    );
  }

  let userOperationReceipt;
  try {
    userOperationReceipt = await bundlerClient.getUserOperationReceipt({
      hash: discoveredHash,
    });
  } catch (error) {
    throw reconcileReadError('Base reconciliation UserOperation receipt is unavailable', error);
  }
  if (!userOperationReceipt) {
    return reconcilePending('reconcile_receipt_pending', allocation, reconcileHandle, discoveredHash);
  }
  const receiptEntryPoint = canonicalAddress(userOperationReceipt.entryPoint, 'UserOperation receipt EntryPoint');
  const receiptSender = canonicalAddress(userOperationReceipt.sender, 'UserOperation receipt sender');
  const receiptNonce = rpcUnsigned(userOperationReceipt.nonce, 'UserOperation receipt nonce');
  const receiptHash = canonicalHash(userOperationReceipt.userOpHash, 'UserOperation receipt hash');
  const receiptTransactionHash = canonicalHash(
    userOperationReceipt.receipt?.transactionHash,
    'receipt transactionHash',
  );
  if (
    receiptEntryPoint !== reconcileHandle.entryPoint ||
    receiptSender !== reconcileHandle.sender ||
    receiptNonce !== reconcileHandle.nonce ||
    receiptHash !== discoveredHash ||
    receiptTransactionHash !== fullTransactionHash
  ) {
    throw new BaseDepositReconciliationError(
      'BASE_DEPOSIT_RECONCILE_MISMATCH',
      'UserOperation receipt disagrees with canonical handle',
    );
  }
  const userOpEventNonce = rpcUnsigned(entry.args.nonce, 'EntryPoint event nonce');
  if (userOpEventNonce !== receiptNonce) {
    throw new BaseDepositReconciliationError(
      'BASE_DEPOSIT_RECONCILE_MISMATCH',
      'EntryPoint UserOperation outcome is not successful',
    );
  }
  if (
    entry.args.success !== true ||
    userOperationReceipt.success !== true ||
    userOperationReceipt.receipt?.status !== 'success'
  ) {
    return {
      identity: allocation.identity,
      allocationId: allocation.identity.allocationId,
      pool: allocation.pool,
      status: 'owner_action_required',
      reasonCode: 'base-deposit-failed-kernel-custody',
      executionStatus: 'failed',
      custody: { location: 'base-kernel', confirmed: true },
      custodyLocation: 'base-kernel',
      kernelCustodyConfirmed: true,
      userOpHash: discoveredHash,
      transactionHash: receiptTransactionHash,
      txHash: receiptTransactionHash,
      reconcileHandle,
    };
  }

  const proof = proveDepositReceipt(
    {
      ...userOperationReceipt,
      userOpHash: discoveredHash,
      sender: receiptSender,
      receipt: {
        ...userOperationReceipt.receipt,
        transactionHash: fullTransactionHash,
        status: 'success',
      },
    },
    allocation,
    routerAddress,
    discoveredHash,
  );
  return {
    identity: allocation.identity,
    allocationId: allocation.identity.allocationId,
    pool: allocation.pool,
    status: 'fulfilled',
    value: {
      pool: allocation.pool,
      userOpHash: discoveredHash,
      txHash: proof.transactionHash,
      event: proof.event,
    },
    userOpHash: discoveredHash,
    transactionHash: proof.transactionHash,
    event: proof.event,
    executionStatus: 'deposited',
    custody: { location: 'base-proxy' },
    txHash: proof.transactionHash,
    reconcileHandle,
  };
}

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
    now = () => Date.now(),
    baseCrossChainAvailable = false,
    captureReconcileHandleFn = null,
    readBaseDepositEvidenceFn = readBaseDepositEvidence,
    readOnlyPublicClient = null,
    readOnlyBundlerClient = null,
    reconcileMaxBlocks = DEFAULT_RECONCILE_MAX_BLOCKS,
  } = config;
  let defaultReadOnlyClients;
  const requireBaseExecution = () => {
    if (baseCrossChainAvailable !== true) {
      throw new Error('Base cross-chain execution is unavailable');
    }
  };

  function defaultReadClients() {
    if (defaultReadOnlyClients || !rpcUrl || !bundlerRpcUrl) return defaultReadOnlyClients;
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const bundlerRpcClient = createPublicClient({
      chain,
      transport: http(bundlerRpcUrl),
    });
    defaultReadOnlyClients = {
      publicClient,
      bundlerClient: {
        getUserOperation: ({ hash }) =>
          bundlerRpcClient.request({
            method: 'eth_getUserOperationByHash',
            params: [hash],
          }),
        getUserOperationReceipt: ({ hash }) =>
          bundlerRpcClient.request({
            method: 'eth_getUserOperationReceipt',
            params: [hash],
          }),
      },
    };
    return defaultReadOnlyClients;
  }

  async function captureReconcileHandle(kernelClient, allocation) {
    const sender = canonicalAddress(kernelClient?.account?.address, 'reconstructed Kernel address');
    const entryPoint = canonicalAddress(ENTRY_POINT.address, 'pinned EntryPoint');
    if (entryPoint !== PINNED_ENTRY_POINT) {
      throw new Error('configured EntryPoint disagrees with the pinned EntryPoint');
    }
    if (typeof captureReconcileHandleFn === 'function') {
      return normalizeReconcileHandle(
        await captureReconcileHandleFn({
          kernelClient,
          allocation,
          entryPoint,
          sender,
        }),
        { sender },
      );
    }
    const nonceReader =
      typeof kernelClient?.account?.getNonce === 'function'
        ? () => kernelClient.account.getNonce()
        : typeof kernelClient?.getNonce === 'function'
          ? () => kernelClient.getNonce()
          : null;
    const blockReader =
      typeof kernelClient?.getBlockNumber === 'function'
        ? () => kernelClient.getBlockNumber()
        : typeof kernelClient?.publicClient?.getBlockNumber === 'function'
          ? () => kernelClient.publicClient.getBlockNumber()
          : null;
    // A new durable submission must always carry the complete read-only reconciliation handle.
    // Historical hash-only rows are still supported by reconcileSubmittedDeposit(), but a
    // missing reader here cannot be allowed to create another unreconcilable send fence.
    if (!nonceReader && !blockReader) {
      throw new Error('Base reconcile handle requires nonce and startBlock reads');
    }
    if (!nonceReader || !blockReader) {
      throw new Error('Base reconcile handle requires nonce and startBlock reads');
    }
    const [nonce, startBlock] = await Promise.all([nonceReader(), blockReader()]);
    return normalizeReconcileHandle(
      {
        entryPoint,
        sender,
        nonce: canonicalUnsigned(nonce, 'reconcile nonce'),
        startBlock: canonicalUnsigned(startBlock, 'reconcile startBlock'),
      },
      { sender },
    );
  }

  /**
   * Activates a mandate by clearing the session account's allowance to YieldRouter.
   * @param {string} approval - serialized session approval from the SP3 mandate ceremony
   * @param {{onSubmitted?: (userOpHash: string) => Promise<void> | void}} [options]
   */
  async function activateMandate(approval, { onSubmitted } = {}) {
    requireBaseExecution();
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
    const txHash = requireSuccessfulUserOperation(receipt, {
      label: 'mandate activation',
    });
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
  async function dispatchDeposits(
    approval,
    allocations,
    { onCheckpoint, onClaimSubmitting, onBeforeClaimSubmitting, onBeforeSend } = {},
  ) {
    requireBaseExecution();
    const durableMode = typeof onCheckpoint === 'function';
    const normalizedAllocations = durableMode ? allocations.map(normalizeAllocation) : allocations;
    if (durableMode && normalizedAllocations.length > 1) {
      const first = normalizedAllocations[0];
      for (const allocation of normalizedAllocations.slice(1)) {
        if (allocation.identity.networkId !== first.identity.networkId
          || allocation.identity.bindingId !== first.identity.bindingId
          || allocation.identity.childId !== first.identity.childId
          || allocation.caller !== first.caller) {
          throw new Error('deposit batch has mixed immutable context');
        }
      }
    }
    // VF Wallet Task 7 (defense in depth): this is the point where sessionPrivateKey actually
    // gets used — reject the whole call, before the session client is even reconstructed, if any
    // allocation is over the per-call cap. httpRouter.mjs's own pre-dispatch validateMandateBinding
    // check is the primary gate; this is the last line of defense should some other caller ever
    // reach this function directly. Per-call, not cumulative — checked against each allocation's
    // own amount, nothing is summed across allocations or across calls.
    const overCap = normalizedAllocations.find((a) => a.amount > MAX_CALL_CAP_UNITS);
    if (overCap) {
      throw new Error(`allocation for ${overCap.pool} exceeds the ${MAX_CALL_CAP_UNITS} per-call cap`);
    }

    const kernelClient = await reconstructSessionClientFn({
      chain, rpcUrl, bundlerRpcUrl, approval, sessionPrivateKey,
    });
    if (durableMode && normalizedAllocations.length > 0
        && canonicalAddress(kernelClient?.account?.address, 'reconstructed Kernel address')
          !== normalizedAllocations[0].caller) {
      throw new Error('reconstructed Kernel address disagrees with immutable caller');
    }

    const results = [];
    let stopAfterUnknown = false;
    for (const allocation of normalizedAllocations) {
      if (stopAfterUnknown) {
        results.push({
          identity: allocation.identity,
          allocationId: allocation.identity?.allocationId ?? allocation.allocationId,
          pool: allocation.pool,
          status: 'held',
          reasonCode: 'not_dispatched_after_unknown',
          executionStatus: 'held',
          custody: { location: 'agent' },
          userOpHash: null,
          transactionHash: null,
          txHash: null,
        });
        continue;
      }
      let reconcileHandle = null;
      if (durableMode) {
        try {
          reconcileHandle = await captureReconcileHandle(kernelClient, allocation);
        } catch (reason) {
          stopAfterUnknown = true;
          results.push({
            identity: allocation.identity,
            allocationId: allocation.identity.allocationId,
            pool: allocation.pool,
            status: 'held',
            reason,
            reasonCode: 'reconcile_handle_unavailable',
            executionStatus: 'held',
            custody: { location: 'agent' },
            userOpHash: null,
            transactionHash: null,
            txHash: null,
          });
          continue;
        }
      }
      if (!durableMode) {
        try {
          const approveData = encodeFunctionData({
            abi: APPROVE_ABI,
            functionName: 'approve',
            args: [yieldRouterAddress, allocation.amount],
          });
          const depositData = encodeFunctionData({
            abi: YIELD_ROUTER_ABI,
            functionName: 'deposit',
            args: [allocation.pool, allocation.amount, allocation.minShares],
          });
          const callData = await kernelClient.account.encodeCalls([
            { to: usdcAddress, value: 0n, data: approveData },
            { to: yieldRouterAddress, value: 0n, data: depositData },
          ]);
          const userOpHash = requireCanonicalUserOperationHash(await kernelClient.sendUserOperation({ callData }), {
            label: `deposit into ${allocation.pool}`,
          });
          const receipt = await kernelClient.waitForUserOperationReceipt({
            hash: userOpHash,
            timeout: USEROP_TIMEOUT_MS,
          });
          const txHash = requireSuccessfulUserOperation(receipt, {
            label: `deposit into ${allocation.pool}`,
          });
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
        continue;
      }

      const commonEvidence = {
        chainId: String(chain.id),
        yieldRouterAddress: canonicalAddress(yieldRouterAddress, 'YieldRouter address'),
        caller: allocation.caller,
        poolAddress: allocation.pool,
        assets: allocation.amount.toString(10),
        minShares: allocation.minShares.toString(10),
        ...(reconcileHandle ? { reconcileHandle } : {}),
      };
      let submissionOwnerToken = null;
      const checkpoint = async (status, evidence) => onCheckpoint({
        identity: allocation.identity,
        phase: 'base_deposit',
        status,
        evidence,
        observedAt: now(),
      }, submissionOwnerToken ? { ownerToken: submissionOwnerToken } : undefined);
      let userOpHash = null;
      let transactionHash = null;
      try {
        try {
          if (typeof onClaimSubmitting === 'function') {
            let claimContext;
            if (typeof onBeforeClaimSubmitting === 'function') {
              let authorityFresh = false;
              try {
                authorityFresh = await onBeforeClaimSubmitting({
                  identity: allocation.identity,
                });
              } catch {
                authorityFresh = false;
              }
              const authorizedSnapshot = authorityFresh?.authorized === true
                && authorityFresh.authoritySnapshot
                && typeof authorityFresh.authoritySnapshot === 'object'
                ? authorityFresh.authoritySnapshot
                : null;
              if (authorityFresh !== true && !authorizedSnapshot) {
                stopAfterUnknown = true;
                results.push({
                  identity: allocation.identity, allocationId: allocation.identity.allocationId,
                  pool: allocation.pool, status: 'held',
                  reasonCode: 'authority_changed_before_submission', executionStatus: 'held',
                  custody: { location: 'agent' }, userOpHash: null,
                  transactionHash: null, txHash: null,
                });
                continue;
              }
              if (authorizedSnapshot) claimContext = { authoritySnapshot: authorizedSnapshot };
            }
            const claim = await onClaimSubmitting({
              identity: allocation.identity,
              phase: 'base_deposit',
              status: 'submitting',
              evidence: commonEvidence,
              observedAt: now(),
            }, claimContext);
            if (claim?.claimed !== true || typeof claim.ownerToken !== 'string'
                || claim.ownerToken.length === 0) {
              stopAfterUnknown = true;
              results.push({
                identity: allocation.identity, allocationId: allocation.identity.allocationId,
                pool: allocation.pool, status: 'held',
                reasonCode: claim?.reasonCode === 'mandate_authority_changed'
                  ? 'authority_changed_before_submission' : 'submission_claim_held',
                executionStatus: 'held', custody: { location: 'agent' }, userOpHash: null,
                transactionHash: null, txHash: null,
              });
              continue;
            }
            submissionOwnerToken = claim.ownerToken;
          } else {
            await checkpoint('submitting', commonEvidence);
          }
        } catch (reason) {
          if (reason?.checkpointOutcome !== 'not_committed') {
            stopAfterUnknown = true;
            results.push({
              identity: allocation.identity, allocationId: allocation.identity.allocationId,
              pool: allocation.pool, status: 'uncertain', reason,
              reasonCode: 'submitting_checkpoint_ambiguous', executionStatus: 'unknown',
              custody: { location: 'agent' }, userOpHash: null,
              transactionHash: null, txHash: null,
            });
            continue;
          }
          results.push({
            identity: allocation.identity, allocationId: allocation.identity.allocationId,
            pool: allocation.pool, status: 'rejected', reason,
            reasonCode: 'pre_submit_validation', executionStatus: 'held',
            custody: { location: 'agent' }, userOpHash: null, transactionHash: null, txHash: null,
          });
          continue;
        }
        let callData;
        try {
          const approveData = encodeFunctionData({
            abi: APPROVE_ABI, functionName: 'approve', args: [yieldRouterAddress, allocation.amount],
          });
          const depositData = encodeFunctionData({
            abi: YIELD_ROUTER_ABI, functionName: 'deposit',
            args: [allocation.pool, allocation.amount, allocation.minShares],
          });
          callData = await kernelClient.account.encodeCalls([
            { to: usdcAddress, value: 0n, data: approveData },
            { to: yieldRouterAddress, value: 0n, data: depositData },
          ]);
        } catch (reason) {
          await checkpoint('failed', {
            ...commonEvidence, userOpHash: null, transactionHash: null,
            reasonCode: 'pre_submit_validation',
          });
          results.push({
            identity: allocation.identity, allocationId: allocation.identity.allocationId,
            pool: allocation.pool, status: 'rejected', reason,
            reasonCode: 'pre_submit_validation', executionStatus: 'held',
            custody: { location: 'agent' }, userOpHash: null,
            transactionHash: null, txHash: null,
          });
          continue;
        }
        if (typeof onBeforeSend === 'function') {
          let beforeSendResult;
          try {
            beforeSendResult = await onBeforeSend({
              identity: allocation.identity,
              phase: 'base_deposit',
              status: 'submitting',
              evidence: commonEvidence,
              reconcileHandle,
              callData,
            });
          } catch (reason) {
            beforeSendResult = { allowed: false, reason };
          }
          const beforeSendAllowed = beforeSendResult === true || beforeSendResult?.allowed === true;
          if (!beforeSendAllowed) {
            const reason = beforeSendResult?.reason ?? new Error('Base send fence was lost');
            if (beforeSendResult?.checkpointed !== true) {
              try {
                await checkpoint('unknown', {
                  ...commonEvidence,
                  userOpHash: null,
                  transactionHash: null,
                  reasonCode: 'pre_submit_fence_lost',
                });
              } catch (checkpointError) {
                checkpointError.cause = reason;
                stopAfterUnknown = true;
                results.push({
                  identity: allocation.identity,
                  allocationId: allocation.identity.allocationId,
                  pool: allocation.pool,
                  status: 'held',
                  reason: checkpointError,
                  reasonCode: 'pre_submit_fence_checkpoint_failed',
                  executionStatus: 'held',
                  custody: { location: 'agent' },
                  userOpHash: null,
                  transactionHash: null,
                  txHash: null,
                });
                continue;
              }
            }
            stopAfterUnknown = true;
            results.push({
              identity: allocation.identity,
              allocationId: allocation.identity.allocationId,
              pool: allocation.pool,
              status: 'uncertain',
              reason,
              reasonCode: 'pre_submit_fence_lost',
              executionStatus: 'unknown',
              custody: { location: 'agent' },
              userOpHash: null,
              transactionHash: null,
              txHash: null,
            });
            continue;
          }
        }
        try {
          const sendParams = reconcileHandle ? { callData, nonce: BigInt(reconcileHandle.nonce) } : { callData };
          userOpHash = requireCanonicalUserOperationHash(await kernelClient.sendUserOperation(sendParams), {
            label: `deposit into ${allocation.pool}`,
          }).toLowerCase();
        } catch (reason) {
          await checkpoint('unknown', {
            ...commonEvidence, userOpHash: null, transactionHash: null,
            reasonCode: 'send_result_unknown',
          });
          stopAfterUnknown = true;
          results.push({
            identity: allocation.identity, allocationId: allocation.identity.allocationId,
            pool: allocation.pool, status: 'uncertain', reason,
            reasonCode: 'send_result_unknown', executionStatus: 'unknown',
            custody: { location: 'agent' }, userOpHash: null, transactionHash: null, txHash: null,
          });
          continue;
        }
        try {
          await checkpoint('submitted', { ...commonEvidence, userOpHash });
          submissionOwnerToken = null;
        } catch (reason) {
          try {
            await checkpoint('unknown', {
              ...commonEvidence, userOpHash, transactionHash: null,
              reasonCode: 'submitted_checkpoint_failed',
            });
          } catch (fallbackError) {
            fallbackError.code = 'BASE_DEPOSIT_UNCERTAIN';
            fallbackError.userOpHash = userOpHash;
            throw fallbackError;
          }
          stopAfterUnknown = true;
          results.push({
            identity: allocation.identity, allocationId: allocation.identity.allocationId,
            pool: allocation.pool, status: 'uncertain', reason,
            reasonCode: 'submitted_checkpoint_failed', executionStatus: 'unknown',
            custody: { location: 'agent' }, userOpHash, transactionHash: null, txHash: null,
          });
          continue;
        }
        let receipt;
        try {
          receipt = await kernelClient.waitForUserOperationReceipt({
            hash: userOpHash, timeout: USEROP_TIMEOUT_MS,
          });
        } catch (reason) {
          stopAfterUnknown = true;
          results.push({
            identity: allocation.identity, allocationId: allocation.identity.allocationId,
            pool: allocation.pool, status: 'held', reason,
            reasonCode: 'submitted_receipt_pending', executionStatus: 'confirming',
            custody: { location: 'agent' }, userOpHash, transactionHash: null, txHash: null,
          });
          continue;
        }
        const proof = proveDepositReceipt(
          receipt, allocation, commonEvidence.yieldRouterAddress, userOpHash,
        );
        transactionHash = proof.transactionHash;
        const confirmedEvidence = {
          ...commonEvidence,
          shares: proof.event.shares,
          userOpHash,
          transactionHash,
          event: proof.event,
        };
        try {
          await checkpoint('confirmed', confirmedEvidence);
        } catch (reason) {
          await checkpoint('unknown', {
            ...confirmedEvidence, reasonCode: 'confirmed_checkpoint_failed',
          });
          stopAfterUnknown = true;
          results.push({
            identity: allocation.identity, allocationId: allocation.identity.allocationId,
            pool: allocation.pool, status: 'uncertain', reason,
            reasonCode: 'confirmed_checkpoint_failed', executionStatus: 'unknown',
            custody: { location: 'agent' }, userOpHash, transactionHash, txHash: transactionHash,
            event: proof.event,
          });
          continue;
        }
        results.push({
          identity: allocation.identity,
          allocationId: allocation.identity.allocationId,
          pool: allocation.pool,
          status: 'fulfilled',
          value: {
            pool: allocation.pool,
            userOpHash,
            txHash: transactionHash,
            event: proof.event,
          },
          userOpHash,
          transactionHash,
          event: proof.event,
          executionStatus: 'deposited',
          custody: { location: 'base-proxy' },
          txHash: transactionHash,
        });
      } catch (reason) {
        if (reason?.code === 'BASE_DEPOSIT_UNCERTAIN') throw reason;
        const reasonCode = reason instanceof DepositObservationError ? reason.reasonCode : 'receipt_ambiguous';
        transactionHash = reason instanceof DepositObservationError ? reason.transactionHash : transactionHash;
        const definitiveKernelCustody = reason instanceof DepositObservationError && reason.definitive === true;
        const state = definitiveKernelCustody ? 'failed' : 'unknown';
        const custodyEvidence = definitiveKernelCustody
          ? {
              custodyLocation: 'base-kernel',
              kernelCustodyConfirmed: true,
              custody: { location: 'base-kernel', confirmed: true },
            }
          : {};
        await checkpoint(state, {
          ...commonEvidence, userOpHash, transactionHash,
          reasonCode,
          ...custodyEvidence,
        });
        if (state === 'unknown') stopAfterUnknown = true;
        results.push({
          identity: allocation.identity,
          allocationId: allocation.identity.allocationId,
          pool: allocation.pool,
          status: definitiveKernelCustody ? 'owner_action_required' : 'uncertain',
          reason,
          reasonCode,
          executionStatus: definitiveKernelCustody ? 'failed' : 'unknown',
          custody: definitiveKernelCustody ? { location: 'base-kernel', confirmed: true } : { location: 'agent' },
          ...(definitiveKernelCustody ? custodyEvidence : {}),
          userOpHash,
          transactionHash,
          txHash: transactionHash,
        });
      }
    }
    return results;
  }

  /**
   * Reconciles a Base deposit through the bounded, read-only handle seam.  This method never
   * reconstructs a signing client and never calls encode/send; a missing UserOperation hash is
   * allowed when the EntryPoint scan can identify the one operation by sender + nonce.
   */
  async function reconcileBaseDeposit(input, allocationInput, handleInput, hashInput, options = {}) {
    requireBaseExecution();
    let request;
    if (
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.prototype.hasOwnProperty.call(input, 'allocation')
    ) {
      request = input;
    } else {
      request = {
        approval: input,
        allocation: allocationInput,
        reconcileHandle: handleInput,
        userOpHash: hashInput,
        ...options,
      };
    }
    const allocation = normalizeAllocation(request.allocation);
    const reconcileHandle = normalizeReconcileHandle(request.reconcileHandle ?? allocation.reconcileHandle, {
      sender: allocation.caller,
    });
    if (typeof request.onCheckpoint !== 'function') {
      throw new Error('Base reconciliation requires a durable checkpoint callback');
    }
    let result;
    try {
      const defaults = defaultReadClients() ?? {};
      result = await readBaseDepositEvidenceFn({
        publicClient: request.publicClient ?? readOnlyPublicClient ?? defaults.publicClient,
        bundlerClient: request.bundlerClient ?? readOnlyBundlerClient ?? defaults.bundlerClient,
        allocation,
        reconcileHandle,
        userOpHash: request.userOpHash ?? null,
        yieldRouterAddress: canonicalAddress(yieldRouterAddress, 'YieldRouter address'),
        maxBlocks: request.maxBlocks ?? reconcileMaxBlocks,
      });
    } catch (reason) {
      if (reason?.code === 'BASE_DEPOSIT_RECONCILE_RETRYABLE') {
        return reconcilePending('reconcile_read_pending', allocation, reconcileHandle, request.userOpHash ?? null);
      }
      throw reason;
    }
    if (!result || result.status !== 'fulfilled') {
      if (result?.status === 'owner_action_required') {
        const failureEvidence = {
          chainId: String(chain.id),
          yieldRouterAddress: canonicalAddress(yieldRouterAddress, 'YieldRouter address'),
          caller: allocation.caller,
          poolAddress: allocation.pool,
          assets: allocation.amount.toString(10),
          minShares: allocation.minShares.toString(10),
          userOpHash: result.userOpHash ?? request.userOpHash ?? null,
          transactionHash: result.transactionHash ?? null,
          reasonCode: result.reasonCode ?? 'base-deposit-failed-kernel-custody',
          custodyLocation: 'base-kernel',
          kernelCustodyConfirmed: true,
          custody: { location: 'base-kernel', confirmed: true },
          reconcileHandle,
        };
        await request.onCheckpoint({
          identity: allocation.identity,
          phase: 'base_deposit',
          status: 'failed',
          evidence: failureEvidence,
          observedAt: now(),
        });
        return {
          ...result,
          identity: allocation.identity,
          allocationId: allocation.identity.allocationId,
          pool: allocation.pool,
          reconcileHandle,
        };
      }
      return {
        ...reconcilePending(
          result?.reasonCode ?? 'reconcile_read_pending',
          allocation,
          reconcileHandle,
          result?.userOpHash ?? request.userOpHash ?? null,
        ),
        ...(result || {}),
        reconcileHandle,
      };
    }
    const userOpHash = canonicalHash(result.userOpHash, 'reconciled userOpHash');
    const transactionHash = canonicalHash(result.transactionHash, 'reconciled transactionHash');
    const evidence = {
      chainId: String(chain.id),
      yieldRouterAddress: canonicalAddress(yieldRouterAddress, 'YieldRouter address'),
      caller: allocation.caller,
      poolAddress: allocation.pool,
      assets: allocation.amount.toString(10),
      minShares: allocation.minShares.toString(10),
      shares: result.event.shares,
      reconcileHandle,
      userOpHash,
      transactionHash,
      event: result.event,
    };
    await request.onCheckpoint({
      identity: allocation.identity,
      phase: 'base_deposit',
      status: 'confirmed',
      evidence,
      observedAt: now(),
    });
    return {
      ...result,
      identity: allocation.identity,
      allocationId: allocation.identity.allocationId,
      pool: allocation.pool,
      userOpHash,
      transactionHash,
      txHash: transactionHash,
      reconcileHandle,
    };
  }

  /**
   * Reconciles a deposit which already crossed the durable `submitted` fence.  Recovery must
   * only observe the exact stored UserOperation hash; it must never encode or send a replacement.
   * New rows with a reconcile handle use the stricter bounded read-only seam above.  Rows written
   * before the handle existed retain hash-only compatibility through this legacy branch.
   */
  async function reconcileSubmittedDeposit(
    approval,
    allocationInput,
    userOpHashInput,
    { onCheckpoint, reconcileHandle: optionReconcileHandle } = {},
  ) {
    requireBaseExecution();
    const reconcileHandle = optionReconcileHandle ?? allocationInput?.reconcileHandle;
    if (reconcileHandle) {
      return reconcileBaseDeposit({
        approval,
        allocation: allocationInput,
        reconcileHandle,
        userOpHash: userOpHashInput,
        onCheckpoint,
      });
    }
    if (typeof onCheckpoint !== 'function') {
      throw new Error('submitted deposit reconciliation requires a durable checkpoint callback');
    }
    const allocation = normalizeAllocation(allocationInput);
    const userOpHash = requireCanonicalUserOperationHash(userOpHashInput, {
      label: `submitted deposit into ${allocation.pool}`,
    }).toLowerCase();
    const kernelClient = await reconstructSessionClientFn({
      chain, rpcUrl, bundlerRpcUrl, approval, sessionPrivateKey,
    });
    if (canonicalAddress(kernelClient?.account?.address, 'reconstructed Kernel address')
        !== allocation.caller) {
      throw new Error('reconstructed Kernel address disagrees with immutable caller');
    }
    const commonEvidence = {
      chainId: String(chain.id),
      yieldRouterAddress: canonicalAddress(yieldRouterAddress, 'YieldRouter address'),
      caller: allocation.caller,
      poolAddress: allocation.pool,
      assets: allocation.amount.toString(10),
      minShares: allocation.minShares.toString(10),
    };
    let receipt;
    try {
      receipt = await kernelClient.waitForUserOperationReceipt({
        hash: userOpHash, timeout: USEROP_TIMEOUT_MS,
      });
    } catch (reason) {
      return {
        identity: allocation.identity,
        allocationId: allocation.identity.allocationId,
        pool: allocation.pool,
        status: 'held', reason, reasonCode: 'submitted_receipt_pending',
        userOpHash, transactionHash: null, executionStatus: 'confirming',
        custody: { location: 'agent' }, txHash: null,
      };
    }
    const proof = proveDepositReceipt(
      receipt, allocation, commonEvidence.yieldRouterAddress, userOpHash,
    );
    const evidence = {
      ...commonEvidence,
      shares: proof.event.shares,
      userOpHash,
      transactionHash: proof.transactionHash,
      event: proof.event,
    };
    await onCheckpoint({
      identity: allocation.identity,
      phase: 'base_deposit',
      status: 'confirmed',
      evidence,
      observedAt: now(),
    });
    return {
      identity: allocation.identity,
      allocationId: allocation.identity.allocationId,
      pool: allocation.pool,
      status: 'fulfilled',
      value: {
        pool: allocation.pool,
        userOpHash,
        txHash: proof.transactionHash,
        event: proof.event,
      },
      userOpHash,
      transactionHash: proof.transactionHash,
      event: proof.event,
      executionStatus: 'deposited',
      custody: { location: 'base-proxy' },
      txHash: proof.transactionHash,
    };
  }

  return {
    activateMandate,
    dispatchDeposits,
    reconcileBaseDeposit,
    reconcileDeposit: reconcileBaseDeposit,
    reconcileSubmittedDeposit,
  };
}
