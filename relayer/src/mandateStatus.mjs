import { createHash } from 'node:crypto';
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  slice,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KernelV3_1AccountAbi } from '@zerodev/sdk';
import {
  ParamCondition,
  toCallPolicy,
  toTimestampPolicy,
} from '@zerodev/permissions/policies';
import { reconstructSessionClient } from './base/session.mjs';
import { APPROVE_ABI, YIELD_ROUTER_ABI } from './base/orchestrator.mjs';

const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const CANONICAL_PERMISSION_FLAG = '0x0000';
// Base documents ~2-second sealed L2 block inclusion. Six blocks tolerates ordinary RPC lag
// while keeping revoke evidence far tighter than the separate 2700-second execution horizon.
const MAX_BASE_OBSERVATION_AGE_SECONDS = 12;
const STELLAR_OWNER_RE = /^[GC][A-Z2-7]{55}$/;
const DECIMAL_RE = /^(0|[1-9]\d*)$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ALLOCATION_FIELDS = new Set(['allocationId', 'poolAddress', 'amount', 'minShares']);
const AMOUNT_FIELDS = new Set(['token', 'units', 'decimals']);

function sameAddress(left, right) {
  return isAddress(String(left || '')) && isAddress(String(right || ''))
    && String(left).toLowerCase() === String(right).toLowerCase();
}

function json(value) {
  return JSON.stringify(value, (_, child) => (
    typeof child === 'bigint' ? child.toString() : child
  ));
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex');
}

function exactFields(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function decodeApproval(serializedApproval) {
  if (typeof serializedApproval !== 'string' || !serializedApproval || !BASE64_RE.test(serializedApproval)) {
    throw new Error('malformed serialized approval');
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(serializedApproval, 'base64').toString('utf8'));
  } catch {
    throw new Error('malformed serialized approval');
  }
  const accountAddress = decoded?.accountParams?.accountAddress;
  const permissionId = decoded?.permissionParams?.permissionId;
  const policies = decoded?.permissionParams?.policies;
  if (!isAddress(String(accountAddress || '')) || !/^0x[0-9a-fA-F]{8}$/.test(String(permissionId || ''))
    || !Array.isArray(policies)) {
    throw new Error('malformed serialized approval');
  }
  const call = policies.filter((policy) => policy?.policyParams?.type === 'call');
  const timestamp = policies.filter((policy) => policy?.policyParams?.type === 'timestamp');
  if (policies.length !== 2 || call.length !== 1 || timestamp.length !== 1) {
    throw new Error('policy mismatch');
  }
  return {
    accountAddress,
    permissionId: permissionId.toLowerCase(),
    policies,
    call: call[0].policyParams,
    timestamp: timestamp[0].policyParams,
  };
}

function valueOfRule(rule) {
  const value = rule?.params?.[0];
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return BigInt(value);
}

function addressOfRule(rule) {
  const value = rule?.params?.[0];
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return `0x${value.slice(-40)}`;
}

function validatePolicy(decoded, config, allocationAmount) {
  const policy = config.base.mandatePolicy;
  const { call, timestamp } = decoded;
  if (call.policyVersion !== policy.callPolicyVersion) return false;
  // ZeroDev's serialized CallPolicy params do not carry their factory contract address. The
  // address is proven below from permissionConfig.policyData at the same observed block.
  if (call.policyAddress && !sameAddress(call.policyAddress, policy.callPolicyAddress)) return false;
  if (!sameAddress(timestamp.policyAddress, policy.timestampPolicyAddress)) return false;
  if (call.policyFlag !== CANONICAL_PERMISSION_FLAG
    || timestamp.policyFlag !== CANONICAL_PERMISSION_FLAG) return false;
  const permissions = call.permissions;
  if (!Array.isArray(permissions) || permissions.length !== 2) return false;
  const approve = permissions.find((entry) => entry?.functionName === 'approve');
  const deposit = permissions.find((entry) => entry?.functionName === 'deposit');
  if (!approve || !deposit) return false;
  if (!sameAddress(approve.target, policy.usdcAddress)
    || String(approve.selector).toLowerCase() !== String(policy.approveSelector).toLowerCase()
    || approve.callType !== '0x00'
    || BigInt(approve.valueLimit ?? -1) !== BigInt(policy.nativeValue)) return false;
  if (!sameAddress(deposit.target, policy.yieldRouterAddress)
    || String(deposit.selector).toLowerCase() !== String(policy.depositSelector).toLowerCase()
    || deposit.callType !== '0x00'
    || BigInt(deposit.valueLimit ?? -1) !== BigInt(policy.nativeValue)) return false;

  const approveArgs = approve.args;
  const depositArgs = deposit.args;
  if (!Array.isArray(approveArgs) || approveArgs.length !== 2
    || Number(approveArgs[0]?.condition) !== ParamCondition.EQUAL
    || !sameAddress(approveArgs[0]?.value, policy.yieldRouterAddress)
    || Number(approveArgs[1]?.condition) !== ParamCondition.LESS_THAN_OR_EQUAL
    || !DECIMAL_RE.test(String(approveArgs[1]?.value ?? ''))) return false;
  if (!Array.isArray(depositArgs) || depositArgs.length !== 3 || depositArgs[0] !== null
    || Number(depositArgs[1]?.condition) !== ParamCondition.LESS_THAN_OR_EQUAL
    || !DECIMAL_RE.test(String(depositArgs[1]?.value ?? '')) || depositArgs[2] !== null) return false;
  const approveCap = BigInt(approveArgs[1].value);
  const depositCap = BigInt(depositArgs[1].value);
  if (approveCap <= 0n || approveCap !== depositCap || allocationAmount > approveCap) return false;

  if (!Array.isArray(approve.rules) || approve.rules.length !== 2
    || Number(approve.rules[0]?.condition) !== ParamCondition.EQUAL
    || Number(approve.rules[0]?.offset) !== 0
    || !sameAddress(addressOfRule(approve.rules[0]), policy.yieldRouterAddress)
    || Number(approve.rules[1]?.condition) !== ParamCondition.LESS_THAN_OR_EQUAL
    || Number(approve.rules[1]?.offset) !== 32
    || valueOfRule(approve.rules[1]) !== approveCap) return false;
  if (!Array.isArray(deposit.rules) || deposit.rules.length !== 1
    || Number(deposit.rules[0]?.condition) !== ParamCondition.LESS_THAN_OR_EQUAL
    || Number(deposit.rules[0]?.offset) !== 32
    || valueOfRule(deposit.rules[0]) !== depositCap) return false;
  return true;
}

function deriveCanonicalPermissionId(decoded, config, sessionAddress) {
  const policy = config.base.mandatePolicy;
  const policies = [
    toCallPolicy({
      policyVersion: decoded.call.policyVersion,
      policyAddress: policy.callPolicyAddress,
      policyFlag: decoded.call.policyFlag,
      permissions: decoded.call.permissions,
    }),
    toTimestampPolicy({
      policyAddress: policy.timestampPolicyAddress,
      policyFlag: decoded.timestamp.policyFlag,
      validAfter: decoded.timestamp.validAfter,
      validUntil: decoded.timestamp.validUntil,
    }),
  ];
  const policyId = encodeAbiParameters(
    [{ name: 'policiesData', type: 'bytes[]' }],
    [policies.map((entry) => concatHex([
      entry.getPolicyInfoInBytes(),
      entry.getPolicyData(),
    ]))],
  );
  const signerId = encodeAbiParameters(
    [{ name: 'signerData', type: 'bytes' }],
    [concatHex([policy.ecdsaSignerAddress, sessionAddress])],
  );
  const permissionIdData = encodeAbiParameters(
    [{ name: 'policyAndSignerData', type: 'bytes[]' }],
    [[policyId, CANONICAL_PERMISSION_FLAG, signerId]],
  );
  return slice(keccak256(permissionIdData), 0, 4).toLowerCase();
}

function parseAllocation(allocation, config) {
  if (!exactFields(allocation, ALLOCATION_FIELDS) || typeof allocation.allocationId !== 'string'
    || !allocation.allocationId || !isAddress(String(allocation.poolAddress || ''))
    || !exactFields(allocation.amount, AMOUNT_FIELDS) || allocation.amount.token !== 'USDC'
    || allocation.amount.decimals !== 6 || !DECIMAL_RE.test(String(allocation.amount.units ?? ''))
    || !DECIMAL_RE.test(String(allocation.minShares ?? ''))) {
    throw new Error('allocation mismatch');
  }
  const amount = BigInt(allocation.amount.units);
  const minShares = BigInt(allocation.minShares);
  if (amount <= 0n || !config.base.allowedPools.some((pool) => sameAddress(pool, allocation.poolAddress))) {
    throw new Error('allocation mismatch');
  }
  return { amount, minShares };
}

function implementationFromStorage(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const address = `0x${value.slice(-40)}`;
  return isAddress(address) ? getAddress(address) : null;
}

function expectedPolicyData(decoded, config) {
  const flag = decoded.call.policyFlag;
  if (!/^0x[0-9a-fA-F]{4}$/.test(String(flag || ''))) throw new Error('policy mismatch');
  return [
    concatHex([flag, config.base.mandatePolicy.callPolicyAddress]),
    concatHex([flag, config.base.mandatePolicy.timestampPolicyAddress]),
  ];
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
    allocation: false,
    freshness: false,
    reconstruction: false,
    prepared: false,
  };
}

function statusEnvelope({ status, reasonCodes, expected, observed, checks }) {
  return {
    version: 2,
    stellarOwner: expected.owner ?? null,
    kernelAddress: expected.kernelAddress ?? null,
    sessionKeyAddress: expected.sessionKeyAddress ?? null,
    relayerOrigin: expected.relayerOrigin ?? null,
    expiresAt: expected.expiresAt ?? null,
    bindingId: expected.bindingId ?? null,
    bindingHash: expected.bindingHash ?? null,
    status,
    reasonCodes,
    expected,
    observed,
    checks,
  };
}

/**
 * Read-only Base mandate evidence gate. Expected global facts come only from canonical config;
 * expected user facts come only from the stored mandate/approval. No request field can replace
 * either source, and this function never calls sendUserOperation.
 */
async function evaluateBaseMandateStatusInternal({
  record,
  config,
  allocation,
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
    expiresAt: record?.expiresAt ?? null,
  };
  const observed = {
    blockNumber: null,
    blockHash: null,
    blockTime: null,
    chainId: null,
    implementation: null,
    permission: null,
    preparedCallDigest: null,
  };
  const checks = allChecks();
  const finish = (status, ...reasonCodes) => statusEnvelope({
    status, reasonCodes: reasonCodes.filter(Boolean), expected, observed, checks,
  });

  let decoded;
  try {
    decoded = decodeApproval(record?.serializedApproval);
  } catch (error) {
    return finish('mismatch', error.message === 'policy mismatch' ? 'POLICY_MISMATCH' : 'APPROVAL_MALFORMED');
  }
  expected.policyDigest = digest(decoded.policies);

  if (!STELLAR_OWNER_RE.test(String(record?.stellarOwner || ''))) return finish('mismatch', 'OWNER_MISMATCH');
  checks.owner = true;
  if (!sameAddress(decoded.accountAddress, record?.kernelAddress)) return finish('mismatch', 'KERNEL_MISMATCH');
  checks.kernel = true;
  let derivedSession;
  try {
    derivedSession = privateKeyToAccount(record.sessionPrivateKey).address;
  } catch {
    return finish('mismatch', 'SESSION_MISMATCH');
  }
  if (!sameAddress(derivedSession, record?.sessionKeyAddress)) return finish('mismatch', 'SESSION_MISMATCH');
  checks.session = true;
  if (record?.policyDigest && record.policyDigest !== expected.policyDigest) {
    return finish('mismatch', 'POLICY_MISMATCH');
  }
  if (record?.relayerOrigin !== config?.publicOrigin) return finish('mismatch', 'ORIGIN_MISMATCH');
  checks.origin = true;
  const validUntilMs = Number(decoded.timestamp.validUntil || 0) * 1000;
  if (!Number.isSafeInteger(record?.expiresAt) || record.expiresAt !== validUntilMs) {
    return finish('mismatch', 'EXPIRY_MISMATCH');
  }
  const expectedBinding = digest(
    `${record.stellarOwner}|${record.kernelAddress}|${record.sessionKeyAddress}|${record.expiresAt / 1000}`,
  );
  if (!record.bindingId || record.bindingHash !== expectedBinding) return finish('mismatch', 'BINDING_MISMATCH');
  checks.binding = true;

  let parsedAllocation;
  try {
    parsedAllocation = parseAllocation(allocation, config);
  } catch {
    return finish('mismatch', 'ALLOCATION_MISMATCH');
  }
  checks.allocation = true;
  try {
    if (!validatePolicy(decoded, config, parsedAllocation.amount)) {
      return finish('mismatch', 'POLICY_MISMATCH');
    }
  } catch {
    return finish('mismatch', 'POLICY_MISMATCH');
  }
  checks.policy = true;

  let canonicalPermissionId;
  try {
    canonicalPermissionId = deriveCanonicalPermissionId(decoded, config, derivedSession);
  } catch {
    return finish('mismatch', 'POLICY_MISMATCH');
  }
  expected.permissionId = canonicalPermissionId;
  if (decoded.permissionId !== canonicalPermissionId
    || (record?.permissionId
      && String(record.permissionId).toLowerCase() !== canonicalPermissionId)) {
    return finish('mismatch', 'PERMISSION_MISMATCH');
  }

  const nowSeconds = Math.floor(now / 1000);
  const validAfter = Number(decoded.timestamp.validAfter || 0);
  const validUntil = Number(decoded.timestamp.validUntil || 0);
  if (validAfter > nowSeconds) return finish('not_yet_valid', 'NOT_YET_VALID');
  if (validUntil !== 0 && validUntil <= nowSeconds) return finish('expired', 'EXPIRED');
  if (validUntil === 0 || validUntil - nowSeconds <= Number(policy.executionHorizonSeconds)) {
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
    observed.blockNumber = block?.number == null ? null : String(block.number);
    observed.blockHash = block?.hash ?? null;
    observed.blockTime = block?.timestamp == null ? null : Number(block.timestamp) * 1000;
  } catch {
    return finish('unknown', 'RPC_ERROR');
  }
  if (observed.chainId !== policy.chainId) return finish('mismatch', 'CHAIN_MISMATCH');
  checks.chain = true;
  if (!observed.blockHash || !Number.isSafeInteger(observed.blockTime)
    || observed.blockTime > now + 30_000
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
      args: [canonicalPermissionId],
      blockNumber: block.number,
    });
  } catch {
    return finish('unknown', 'RPC_ERROR');
  }
  const livePolicyData = Array.isArray(permissionConfig?.policyData) ? permissionConfig.policyData : [];
  observed.permission = {
    permissionId: canonicalPermissionId,
    permissionFlag: permissionConfig?.permissionFlag ?? null,
    signer: permissionConfig?.signer ?? null,
    policyData: livePolicyData,
    digest: digest(livePolicyData.map((entry) => String(entry).toLowerCase())),
  };
  if (sameAddress(permissionConfig?.signer, zeroAddress) || livePolicyData.length === 0) {
    return finish('revoked', 'PERMISSION_REVOKED');
  }
  if (!sameAddress(permissionConfig?.signer, policy.ecdsaSignerAddress)) {
    return finish('mismatch', 'PERMISSION_MISMATCH');
  }
  if (permissionConfig?.permissionFlag !== CANONICAL_PERMISSION_FLAG) {
    return finish('mismatch', 'PERMISSION_MISMATCH');
  }
  const wantedPolicyData = expectedPolicyData(decoded, config);
  if (json(livePolicyData.map((entry) => String(entry).toLowerCase()))
    !== json(wantedPolicyData.map((entry) => entry.toLowerCase()))) {
    return finish('mismatch', 'POLICY_MISMATCH');
  }
  checks.permission = true;

  const calls = [
    {
      to: policy.usdcAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: APPROVE_ABI,
        functionName: 'approve',
        args: [policy.yieldRouterAddress, parsedAllocation.amount],
      }),
    },
    {
      to: policy.yieldRouterAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: YIELD_ROUTER_ABI,
        functionName: 'deposit',
        args: [allocation.poolAddress, parsedAllocation.amount, parsedAllocation.minShares],
      }),
    },
  ];
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
    if (reconstructedPermission
      && String(reconstructedPermission).toLowerCase() !== canonicalPermissionId) {
      return finish('mismatch', 'PERMISSION_MISMATCH');
    }
    checks.reconstruction = true;
    const callData = await kernelClient.account.encodeCalls(calls);
    const prepared = await kernelClient.prepareUserOperation({ callData });
    if (!prepared || prepared.callData !== callData
      || (prepared.sender && !sameAddress(prepared.sender, record.kernelAddress))) {
      return finish('unknown', 'PREPARED_OPERATION_MISMATCH');
    }
    observed.preparedCallDigest = digest({ callData, calls });
    checks.prepared = true;
  } catch {
    return finish('unknown', 'PREPARE_FAILED');
  }
  return finish('active');
}

export async function evaluateBaseMandateStatus(args) {
  try {
    return await evaluateBaseMandateStatusInternal(args);
  } catch {
    return {
      version: 2,
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
