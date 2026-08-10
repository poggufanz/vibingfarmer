import { getAddress, isAddress, zeroAddress } from 'viem';
import { KernelV3_1AccountAbi } from '@zerodev/sdk';
import {
  canonicalTxHash,
  canonicalUserOpHash,
  digestCanonicalValue,
  parseCanonicalMandate,
} from './base/canonicalMandate.mjs';
import { reconstructSessionClient } from './base/session.mjs';

const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const CANONICAL_PERMISSION_FLAG = '0x0000';
const MAX_BASE_OBSERVATION_AGE_SECONDS = 12;
const MAX_SAFE_BLOCK_TIMESTAMP_SECONDS = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000));
const CANONICAL_BLOCK_HASH = /^0x[0-9a-f]{64}$/;

function sameAddress(left, right) {
  return isAddress(String(left || '')) && isAddress(String(right || ''))
    && String(left).toLowerCase() === String(right).toLowerCase();
}

function json(value) {
  return JSON.stringify(value, (_, child) => (
    typeof child === 'bigint' ? child.toString() : child
  ));
}

function implementationFromStorage(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  if (value.slice(2, 26) !== '0'.repeat(24)) return null;
  const address = `0x${value.slice(-40)}`;
  return isAddress(address) ? getAddress(address) : null;
}

function allChecks() {
  return {
    chain: false,
    owner: false,
    kernel: false,
    session: false,
    permission: false,
    policy: false,
    binding: false,
    origin: false,
    implementation: false,
    freshness: false,
    reconstruction: false,
    activation: false,
  };
}

function statusEnvelope({ status, reasonCodes, expected, observed, checks }) {
  return {
    version: 3,
    stellarOwner: expected.owner ?? null,
    kernelAddress: expected.kernelAddress ?? null,
    sessionKeyAddress: expected.sessionKeyAddress ?? null,
    relayerOrigin: expected.relayerOrigin ?? null,
    expiresAt: expected.validUntilSeconds ?? null,
    bindingId: expected.bindingId ?? null,
    bindingHash: expected.bindingHash ?? null,
    status,
    reasonCodes,
    expected,
    observed,
    checks,
  };
}

export function permissionIdFromSerializedApproval(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    return parseCanonicalMandate(input).permissionId;
  } catch {
    return null;
  }
}

async function evaluateBaseMandateStatusInternal({
  record,
  config,
  now = Date.now(),
  makePublicClient,
  reconstructSessionClientFn = reconstructSessionClient,
}) {
  const policy = config?.base?.mandatePolicy || {};
  const expected = {
    chainId: policy.chainId ?? null,
    relayerOrigin: config?.publicOrigin ?? null,
    kernelImplementation: policy.kernelImplementation ?? null,
    kernelVersion: policy.kernelVersion ?? null,
    entryPointVersion: policy.entryPointVersion ?? null,
    entryPointAddress: policy.entryPointAddress ?? null,
    policyContracts: {
      call: policy.callPolicyAddress ?? null,
      timestamp: policy.timestampPolicyAddress ?? null,
      signer: policy.ecdsaSignerAddress ?? null,
    },
    allowedCalls: [
      { target: policy.usdcAddress ?? null, selector: policy.approveSelector ?? null },
      { target: policy.yieldRouterAddress ?? null, selector: policy.depositSelector ?? null },
    ],
    executionHorizonSeconds: policy.executionHorizonSeconds ?? null,
    observationMaxAgeSeconds: MAX_BASE_OBSERVATION_AGE_SECONDS,
    owner: record?.stellarOwner ?? null,
    kernelAddress: record?.kernelAddress ?? null,
    sessionKeyAddress: record?.sessionKeyAddress ?? null,
    permissionId: null,
    policyDigest: null,
    bindingId: record?.bindingId ?? null,
    bindingHash: record?.bindingHash ?? null,
    validUntilSeconds: record?.validUntilSeconds ?? null,
  };
  const observed = {
    blockNumber: null,
    blockHash: null,
    blockTime: null,
    chainId: null,
    implementation: null,
    permission: null,
    activation: null,
  };
  const checks = allChecks();
  const finish = (status, ...reasonCodes) => statusEnvelope({
    status,
    reasonCodes: reasonCodes.filter(Boolean),
    expected,
    observed,
    checks,
  });

  if (!Number.isSafeInteger(now) || now < 0) {
    return finish('unknown', 'TIME_MALFORMED');
  }
  let mandate;
  if (typeof record?.permissionId !== 'string' || !record.permissionId) {
    return finish('mismatch', 'PERMISSION_MISMATCH');
  }
  if (typeof record?.policyDigest !== 'string' || !record.policyDigest) {
    return finish('mismatch', 'POLICY_MISMATCH');
  }
  if (typeof record?.relayerOrigin !== 'string' || !record.relayerOrigin) {
    return finish('mismatch', 'ORIGIN_MISMATCH');
  }
  if (typeof record?.bindingId !== 'string' || !record.bindingId
    || typeof record?.bindingHash !== 'string' || !record.bindingHash) {
    return finish('mismatch', 'BINDING_MISMATCH');
  }
  try {
    mandate = parseCanonicalMandate({
      ...record,
      expiresAt: record?.validUntilSeconds,
      config,
    });
  } catch (error) {
    const reason = typeof error?.code === 'string' ? error.code : 'APPROVAL_MALFORMED';
    return finish('mismatch', reason);
  }
  expected.permissionId = mandate.permissionId;
  expected.policyDigest = mandate.policyDigest;
  checks.owner = true;
  checks.kernel = true;
  checks.session = true;
  checks.binding = true;
  checks.origin = true;
  if (record.policyDigest !== mandate.policyDigest) {
    return finish('mismatch', 'POLICY_MISMATCH');
  }
  checks.policy = true;

  const activation = Boolean(
    canonicalTxHash(record.activationTxHash)
    && canonicalUserOpHash(record.activationUserOpHash)
    && Number.isSafeInteger(record.activatedAt)
  );
  if (activation) {
    observed.activation = {
      userOpHash: record.activationUserOpHash,
      txHash: record.activationTxHash,
      activatedAt: record.activatedAt,
    };
    checks.activation = true;
  }

  const nowSeconds = Math.floor(now / 1000);
  if (mandate.validAfter > nowSeconds) return finish('not_yet_valid', 'NOT_YET_VALID');
  if (mandate.validUntilSeconds <= nowSeconds) return finish('expired', 'EXPIRED');
  if (mandate.validUntilSeconds - nowSeconds <= Number(policy.executionHorizonSeconds)) {
    return finish('expiring', 'EXPIRING');
  }
  if (record.status === 'revoked') return finish('revoked', 'PERMISSION_REVOKED');

  let publicClient;
  let block;
  try {
    publicClient = makePublicClient
      ? await makePublicClient({ config })
      : config?.base?.publicClient;
    if (!publicClient) throw new Error('public client unavailable');
    observed.chainId = await publicClient.getChainId();
    block = await publicClient.getBlock({ blockTag: 'latest' });
  } catch {
    return finish('unknown', 'RPC_ERROR');
  }
  if (observed.chainId !== policy.chainId) return finish('mismatch', 'CHAIN_MISMATCH');
  checks.chain = true;
  if (typeof block?.number !== 'bigint' || block.number < 0n
    || !CANONICAL_BLOCK_HASH.test(block?.hash || '')
    || typeof block?.timestamp !== 'bigint' || block.timestamp < 0n
    || block.timestamp > MAX_SAFE_BLOCK_TIMESTAMP_SECONDS) {
    return finish('unknown', 'BLOCK_MALFORMED');
  }
  observed.blockNumber = String(block.number);
  observed.blockHash = block.hash;
  observed.blockTime = Number(block.timestamp) * 1000;
  if (observed.blockTime > now + 30_000
    || now - observed.blockTime > MAX_BASE_OBSERVATION_AGE_SECONDS * 1000) {
    return finish('unknown', 'BLOCK_STALE');
  }
  checks.freshness = true;

  let permissionConfig;
  try {
    const storage = await publicClient.getStorageAt({
      address: record.kernelAddress,
      slot: EIP1967_IMPLEMENTATION_SLOT,
      blockNumber: block.number,
    });
    observed.implementation = implementationFromStorage(storage);
    if (!sameAddress(observed.implementation, policy.kernelImplementation)) {
      return finish('mismatch', 'IMPLEMENTATION_MISMATCH');
    }
    checks.implementation = true;
    permissionConfig = await publicClient.readContract({
      address: record.kernelAddress,
      abi: KernelV3_1AccountAbi,
      functionName: 'permissionConfig',
      args: [mandate.permissionId],
      blockNumber: block.number,
    });
  } catch {
    return finish('unknown', 'RPC_ERROR');
  }
  const livePolicyData = Array.isArray(permissionConfig?.policyData) ? permissionConfig.policyData : [];
  observed.permission = {
    permissionId: mandate.permissionId,
    permissionFlag: permissionConfig?.permissionFlag ?? null,
    signer: permissionConfig?.signer ?? null,
    policyData: livePolicyData,
    digest: digestCanonicalValue(livePolicyData.map((entry) => String(entry).toLowerCase())),
  };
  if (sameAddress(permissionConfig?.signer, zeroAddress) || livePolicyData.length === 0) {
    return finish('revoked', 'PERMISSION_REVOKED');
  }
  if (!sameAddress(permissionConfig?.signer, policy.ecdsaSignerAddress)
    || permissionConfig?.permissionFlag !== CANONICAL_PERMISSION_FLAG) {
    return finish('mismatch', 'PERMISSION_MISMATCH');
  }
  if (json(livePolicyData.map((entry) => String(entry).toLowerCase()))
    !== json(mandate.policyData.map((entry) => entry.toLowerCase()))) {
    return finish('mismatch', 'POLICY_MISMATCH');
  }
  checks.permission = true;

  try {
    const kernelClient = await reconstructSessionClientFn({
      chain: config.base.chain,
      rpcUrl: config.base.rpcUrl,
      bundlerRpcUrl: config.base.bundlerRpcUrl,
      approval: record.serializedApproval,
      sessionPrivateKey: record.sessionPrivateKey,
    });
    if (!sameAddress(kernelClient?.account?.address, record.kernelAddress)) {
      return finish('mismatch', 'KERNEL_MISMATCH');
    }
    if (kernelClient?.account?.kernelVersion !== policy.kernelVersion) {
      return finish('mismatch', 'KERNEL_VERSION_MISMATCH');
    }
    if (!sameAddress(kernelClient?.account?.entryPoint?.address, policy.entryPointAddress)
      || kernelClient?.account?.entryPoint?.version !== policy.entryPointVersion) {
      return finish('mismatch', 'ENTRY_POINT_MISMATCH');
    }
    const reconstructedPermission = await kernelClient.account.kernelPluginManager?.getIdentifier?.();
    if (reconstructedPermission !== mandate.permissionId) {
      return finish('mismatch', 'PERMISSION_MISMATCH');
    }
    checks.reconstruction = true;
  } catch {
    return finish('unknown', 'RECONSTRUCTION_FAILED');
  }

  return activation ? finish('active') : finish('unknown', 'ACTIVATION_MISSING');
}

export async function evaluateBaseMandateStatus(args) {
  try {
    return await evaluateBaseMandateStatusInternal(args);
  } catch {
    return {
      version: 3,
      stellarOwner: null,
      kernelAddress: null,
      sessionKeyAddress: null,
      relayerOrigin: null,
      expiresAt: null,
      bindingId: null,
      bindingHash: null,
      status: 'unknown',
      reasonCodes: ['EVALUATOR_ERROR'],
      expected: {},
      observed: {},
      checks: allChecks(),
    };
  }
}
