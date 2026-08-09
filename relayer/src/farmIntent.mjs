import { createHash } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';

const HEX32 = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const POSITIVE_UINT = /^[1-9][0-9]*$/;

function sha256Domain(domain, value) {
  return createHash('sha256').update(`${domain}\0${JSON.stringify(value)}`).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function bytes32FromContract(value, field) {
  if (!StrKey.isValidContract(value)) throw new Error(`${field} must be a canonical Stellar contract`);
  return `0x${Buffer.from(StrKey.decodeContract(value)).toString('hex')}`;
}

function paddedAddress(value, field) {
  if (!EVM_ADDRESS.test(value)) throw new Error(`${field} must be an EVM address`);
  return `0x${'00'.repeat(12)}${value.slice(2).toLowerCase()}`;
}

function requireHash(value, field, pattern = HASH) {
  if (!pattern.test(value || '')) throw new Error(`${field} is not canonical`);
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function normalizeAllocation(value, ordinal, { runId, jobId, poolTargets }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('allocation must be an object');
  const allowed = new Set(['allocationId', 'poolAddress', 'amount', 'minShares']);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new Error('unexpected allocation field');
  const amount = value.amount;
  if (!amount || typeof amount !== 'object' || Array.isArray(amount)
      || Object.keys(amount).some((field) => !new Set(['token', 'units', 'decimals']).has(field))) {
    throw new Error('amount must be an exact object');
  }
  const allocationId = requireText(value.allocationId, 'allocationId');
  const poolAddress = requireText(value.poolAddress, 'poolAddress').toLowerCase();
  if (!EVM_ADDRESS.test(poolAddress) || !poolTargets?.has(poolAddress)) throw new Error('poolAddress is not tracked');
  if (amount.token !== 'USDC' || amount.decimals !== 6 || !POSITIVE_UINT.test(amount.units || '')) {
    throw new Error('allocation amount is not canonical USDC');
  }
  if (!UINT.test(value.minShares || '')) throw new Error('minShares is not canonical');
  return {
    ordinal,
    allocationId,
    executionId: `${runId}:exec:${allocationId}`,
    childId: jobId,
    token: 'USDC',
    units: amount.units,
    decimals: 6,
    poolAddress,
    proxyTarget: poolTargets.get(poolAddress),
    minShares: value.minShares,
  };
}

export function buildForwardFarmIntent({ jobId, observedAt, request, mandate, deployment }) {
  requireHash(jobId, 'jobId', HEX32);
  requireHash(request?.requestId, 'requestId', HEX32);
  requireHash(request?.mandateId, 'mandateId', HEX32);
  requireHash(request?.grantTxHash, 'grantTxHash');
  if (!StrKey.isValidEd25519PublicKey(request?.stellarOwner || '')) throw new Error('stellarOwner is not canonical');
  if (!StrKey.isValidContract(request?.bridgeAgent || '')) throw new Error('bridgeAgent is not canonical');
  if (!EVM_ADDRESS.test(request?.kernelAddress || '')) throw new Error('kernelAddress is not canonical');
  if (!Array.isArray(request?.allocations) || request.allocations.length === 0 || request.allocations.length > 100) {
    throw new Error('allocations must contain between 1 and 100 children');
  }
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error('observedAt is not canonical');
  const runId = requireText(request.runId, 'runId');
  const allocations = request.allocations.map((allocation, ordinal) => normalizeAllocation(
    allocation, ordinal, { runId, jobId, poolTargets: deployment.poolTargets },
  ));
  if (new Set(allocations.map(({ allocationId }) => allocationId)).size !== allocations.length) {
    throw new Error('allocationId must be unique');
  }
  const amount = allocations.reduce((total, allocation) => total + BigInt(allocation.units), 0n);
  const kernelAddress = request.kernelAddress.toLowerCase();
  const expectation = {
    version: 1,
    direction: 'stellar-to-base',
    sourceDomain: deployment.sourceDomain,
    destinationDomain: deployment.destinationDomain,
    sender: bytes32FromContract(deployment.tokenMessengerMinter, 'tokenMessengerMinter'),
    recipient: paddedAddress(deployment.baseTokenMessenger, 'baseTokenMessenger'),
    destinationCaller: `0x${'00'.repeat(32)}`,
    burnToken: bytes32FromContract(deployment.stellarUsdcSac, 'stellarUsdcSac'),
    mintRecipient: paddedAddress(kernelAddress, 'kernelAddress'),
    messageSender: bytes32FromContract(request.bridgeAgent, 'bridgeAgent'),
    amount: amount.toString(10),
    burnUnits7: (amount * 10n).toString(10),
    maxFee: '0',
    minFinalityThreshold: 2000,
    hookData: '0x',
  };
  const intent = {
    version: 1,
    requestId: request.requestId,
    jobId,
    networkId: deployment.networkId,
    mandate: {
      mandateId: request.mandateId,
      stellarOwner: request.stellarOwner,
      kernelAddress,
      bindingId: requireText(mandate.bindingId, 'bindingId'),
      bindingHash: requireHash(mandate.bindingHash, 'bindingHash'),
      approvalDigest: requireHash(mandate.approvalDigest, 'approvalDigest'),
      policyDigest: requireHash(mandate.policyDigest, 'policyDigest'),
      permissionId: requireText(mandate.permissionId, 'permissionId'),
      validUntilSeconds: mandate.validUntilSeconds,
      relayerOrigin: requireText(mandate.relayerOrigin, 'relayerOrigin'),
    },
    run: {
      bridgeAgent: request.bridgeAgent,
      runId,
      grantTxHash: request.grantTxHash,
    },
    allocations,
    cctpExpectation: expectation,
  };
  const expectationDigest = sha256Domain('vf-cctp-expectation-v1', expectation);
  const intentDigest = sha256Domain('vf-forward-farm-intent-v1', intent);
  const batchIdempotencyKey = createHash('sha256')
    .update(`vf-agent-index-base-child-batch-v1\0${intentDigest}`).digest('hex');
  const batch = {
    idempotencyKey: batchIdempotencyKey,
    burnUnits7: expectation.burnUnits7,
    children: allocations.map((allocation) => ({
      version: 1,
      networkId: deployment.networkId,
      owner: request.stellarOwner,
      agent: request.bridgeAgent,
      bindingId: mandate.bindingId,
      executionId: allocation.executionId,
      allocationId: allocation.allocationId,
      childId: jobId,
      intent: {
        token: 'USDC',
        units: allocation.units,
        decimals: 6,
        poolAddress: allocation.poolAddress,
        proxyTarget: allocation.proxyTarget,
        runId,
        grantTxHash: request.grantTxHash,
        kernelAddress,
        bindingHash: mandate.bindingHash,
        baseJobId: jobId,
        minShares: allocation.minShares,
      },
      lifecycle: { sequence: 0, status: 'planned', evidence: {}, observedAt },
    })),
  };
  const batchDigest = createHash('sha256').update(canonicalJson(batch)).digest('hex');
  const output = {
    intent,
    expectation,
    batch,
    intentDigest,
    expectationDigest,
    batchIdempotencyKey,
    batchDigest,
    relayExecId: `forward-farm:${jobId}`,
  };
  const rebuildInput = {
    request: JSON.parse(JSON.stringify(request)),
    mandate: JSON.parse(JSON.stringify(mandate)),
    deployment: {
      ...deployment,
      poolTargets: new Map(deployment.poolTargets),
    },
  };
  Object.defineProperty(output, 'rebuild', {
    enumerable: false,
    value: ({ jobId: winnerJobId, observedAt: winnerObservedAt }) => buildForwardFarmIntent({
      ...rebuildInput,
      jobId: winnerJobId,
      observedAt: winnerObservedAt,
    }),
  });
  return Object.freeze(output);
}
