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
export const DEPOSITED_TOPIC0 = '0xf5681f9d0db1b911ac18ee83d515a1cf1051853a9eae418316a2fdf7dea427c5';
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
  async function dispatchDeposits(
    approval, allocations, { onCheckpoint, onClaimSubmitting, onBeforeClaimSubmitting } = {},
  ) {
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
      if (!durableMode) {
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
        continue;
      }

      const commonEvidence = {
        chainId: String(chain.id),
        yieldRouterAddress: canonicalAddress(yieldRouterAddress, 'YieldRouter address'),
        caller: allocation.caller,
        poolAddress: allocation.pool,
        assets: allocation.amount.toString(10),
        minShares: allocation.minShares.toString(10),
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
                authorityFresh = await onBeforeClaimSubmitting({ identity: allocation.identity });
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
        try {
          userOpHash = requireCanonicalUserOperationHash(
            await kernelClient.sendUserOperation({ callData }),
            { label: `deposit into ${allocation.pool}` },
          ).toLowerCase();
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
          ...commonEvidence, userOpHash, transactionHash, event: proof.event,
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
          value: { pool: allocation.pool, userOpHash, txHash: transactionHash, event: proof.event },
          userOpHash,
          transactionHash,
          event: proof.event,
          executionStatus: 'deposited',
          custody: { location: 'base-proxy' },
          txHash: transactionHash,
        });
      } catch (reason) {
        if (reason?.code === 'BASE_DEPOSIT_UNCERTAIN') throw reason;
        const reasonCode = reason instanceof DepositObservationError
          ? reason.reasonCode : 'receipt_ambiguous';
        transactionHash = reason instanceof DepositObservationError
          ? reason.transactionHash : transactionHash;
        const state = reason instanceof DepositObservationError && reason.definitive
          ? 'failed' : 'unknown';
        await checkpoint(state, {
          ...commonEvidence, userOpHash, transactionHash,
          reasonCode,
        });
        if (state === 'unknown') stopAfterUnknown = true;
        results.push({
          identity: allocation.identity, allocationId: allocation.identity.allocationId,
          pool: allocation.pool, status: state === 'failed' ? 'rejected' : 'uncertain', reason, reasonCode,
          executionStatus: state === 'failed' ? 'held' : 'unknown',
          custody: { location: 'agent' }, userOpHash, transactionHash, txHash: transactionHash,
        });
      }
    }
    return results;
  }

  /**
   * Reconciles a deposit which already crossed the durable `submitted` fence.  Recovery must
   * only observe the exact stored UserOperation hash; it must never encode or send a replacement.
   */
  async function reconcileSubmittedDeposit(
    approval, allocationInput, userOpHashInput, { onCheckpoint } = {},
  ) {
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

  return { activateMandate, dispatchDeposits, reconcileSubmittedDeposit };
}
