import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { StrKey } from '@stellar/stellar-sdk';
import {
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  keccak256,
  pad,
  slice,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  KernelFactoryStakerAbi,
  KernelV3_1AccountAbi,
} from '@zerodev/sdk';
import { decodeParamsFromInitCode } from '@zerodev/permissions';
import { ParamCondition, toCallPolicy, toTimestampPolicy } from '@zerodev/permissions/policies';

export const MAX_CALL_CAP_UNITS = 10_000_000_000n;
export const CANONICAL_PERMISSION_FLAG = '0x0000';

export const CANONICAL_BASE_MANDATE_POLICY = Object.freeze({
  chainId: 84532,
  kernelVersion: '0.3.1',
  kernelImplementation: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
  entryPointVersion: '0.7',
  entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  callPolicyVersion: '0.0.4',
  callPolicyAddress: '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2',
  timestampPolicyAddress: '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F',
  ecdsaSignerAddress: '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF',
  usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  yieldRouterAddress: '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d',
  approveSelector: '0x095ea7b3',
  depositSelector: '0x0efe6a8b',
  callType: 'call',
  nativeValue: '0',
  executionHorizonSeconds: 2700,
});

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DECIMAL_RE = /^(0|[1-9]\d*)$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const PERMISSION_ID_RE = /^0x[0-9a-f]{8}$/;
const DEFAULT_ACTION_SELECTOR = '0xe9ae5c53';
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const KERNEL_V0_3_1_FACTORY = '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419';
const PASSKEY_VALIDATOR_V0_0_3 = '0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69';
const PASSKEY_ROOT_VALIDATOR_ID = concatHex(['0x00', PASSKEY_VALIDATOR_V0_0_3]);
const MAX_ENABLE_SIGNATURE_BYTES = 16_384;
const MAX_INIT_CODE_BYTES = 65_536;
const TOP_LEVEL_FIELDS = new Set([
  'permissionParams',
  'action',
  'validityData',
  'accountParams',
  'enableSignature',
  'eip7702Auth',
  'isPreInstalled',
]);
const ACCOUNT_FIELDS = new Set(['initCode', 'accountAddress']);
const ACTION_FIELDS = new Set(['selector', 'address']);
const VALIDITY_FIELDS = new Set(['validAfter', 'validUntil']);
const PERMISSION_PARAMS_FIELDS = new Set(['permissionId', 'policies']);
const POLICY_FIELDS = new Set(['policyParams']);
const CALL_POLICY_FIELDS = new Set([
  'type', 'policyVersion', 'policyAddress', 'policyFlag', 'permissions',
]);
const TIMESTAMP_POLICY_FIELDS = new Set([
  'type', 'policyAddress', 'policyFlag', 'validAfter', 'validUntil',
]);
const CALL_FIELDS = new Set([
  'target', 'valueLimit', 'abi', 'functionName', 'args', 'callType', 'selector', 'rules',
]);
const RULE_FIELDS = new Set(['params', 'offset', 'condition']);
const ARG_FIELDS = new Set(['condition', 'value']);

export class CanonicalMandateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CanonicalMandateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CanonicalMandateError(code, message);
}

function objectWithOnly(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function sameAddress(left, right) {
  return isAddress(String(left || '')) && isAddress(String(right || ''))
    && String(left).toLowerCase() === String(right).toLowerCase();
}

function sameHex(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

function boundedHex(value, maxBytes, { allowEmpty = true } = {}) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return false;
  const bytes = (value.length - 2) / 2;
  return bytes <= maxBytes && (allowEmpty || bytes > 0);
}

function json(value) {
  return JSON.stringify(value, (_, child) => (
    typeof child === 'bigint' ? child.toString() : child
  ));
}

export function digestCanonicalValue(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex');
}

export function isStellarStrKey(value) {
  if (typeof value !== 'string') return false;
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}

export function deriveSessionAddress(sessionPrivateKey) {
  return privateKeyToAccount(sessionPrivateKey).address;
}

export function canonicalUserOpHash(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) ? value : null;
}

export function canonicalTxHash(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) ? value : null;
}

function assertPinnedConfig(config) {
  const policy = config?.base?.mandatePolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('POLICY_MISMATCH', 'canonical mandate policy is unavailable');
  }
  const expectedKeys = Object.keys(CANONICAL_BASE_MANDATE_POLICY);
  if (Object.keys(policy).length !== expectedKeys.length
    || expectedKeys.some((key) => policy[key] !== CANONICAL_BASE_MANDATE_POLICY[key])) {
    fail('POLICY_MISMATCH', 'canonical mandate policy facts do not match pinned deployment facts');
  }
  if (config?.base?.chain?.id !== policy.chainId) {
    fail('CHAIN_MISMATCH', 'configured Base chain does not match the pinned mandate chain');
  }
  return policy;
}

function decodeCanonicalBase64(serializedApproval) {
  if (typeof serializedApproval !== 'string' || !serializedApproval
    || !BASE64_RE.test(serializedApproval)) {
    fail('APPROVAL_MALFORMED', 'serialized approval is not canonical base64');
  }
  const bytes = Buffer.from(serializedApproval, 'base64');
  if (bytes.toString('base64') !== serializedApproval) {
    fail('APPROVAL_MALFORMED', 'serialized approval is not canonical base64');
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('APPROVAL_MALFORMED', 'serialized approval is not canonical UTF-8 JSON');
  }
  if (!objectWithOnly(value, TOP_LEVEL_FIELDS) || Object.hasOwn(value, 'privateKey')) {
    fail('APPROVAL_MALFORMED', 'serialized approval contains unsupported fields');
  }
  return value;
}

function canonicalDecimal(value, label) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    fail('POLICY_MISMATCH', `${label} is not a canonical decimal`);
  }
  return BigInt(value);
}

function exactArg(arg, condition, value, label) {
  if (!objectWithOnly(arg, ARG_FIELDS) || arg.condition !== condition) {
    fail('POLICY_MISMATCH', `${label} argument mismatch`);
  }
  if (condition === ParamCondition.EQUAL) {
    if (!sameAddress(arg.value, value)) fail('POLICY_MISMATCH', `${label} argument mismatch`);
  } else if (arg.value !== value) {
    fail('POLICY_MISMATCH', `${label} argument mismatch`);
  }
}

function ruleValue(rule, label) {
  if (!objectWithOnly(rule, RULE_FIELDS) || !Array.isArray(rule.params)
    || rule.params.length !== 1 || !BYTES32_RE.test(String(rule.params[0] || ''))) {
    fail('POLICY_MISMATCH', `${label} rule mismatch`);
  }
  return rule.params[0];
}

function validateCanonicalInitCode(initCode, policy) {
  if (initCode === '0x') return;
  if (!boundedHex(initCode, MAX_INIT_CODE_BYTES)) {
    fail('APPROVAL_MALFORMED', 'serialized approval init code mismatch');
  }
  let outer;
  let initialize;
  let decoded;
  try {
    outer = decodeFunctionData({ abi: KernelFactoryStakerAbi, data: initCode });
    if (outer.functionName !== 'deployWithFactory'
      || !sameAddress(outer.args?.[0], KERNEL_V0_3_1_FACTORY)) {
      fail('APPROVAL_MALFORMED', 'serialized approval factory init code mismatch');
    }
    initialize = decodeFunctionData({ abi: KernelV3_1AccountAbi, data: outer.args[1] });
    decoded = decodeParamsFromInitCode(initCode, policy.kernelVersion);
  } catch (error) {
    if (error instanceof CanonicalMandateError) throw error;
    fail('APPROVAL_MALFORMED', 'serialized approval factory init code mismatch');
  }
  if (initialize.functionName !== 'initialize'
    || !sameHex(initialize.args?.[0], PASSKEY_ROOT_VALIDATOR_ID)
    || !sameAddress(initialize.args?.[1], ZERO_ADDRESS)
    || !boundedHex(initialize.args?.[2], MAX_INIT_CODE_BYTES, { allowEmpty: false })
    || initialize.args?.[3] !== '0x'
    || !Array.isArray(initialize.args?.[4]) || initialize.args[4].length !== 0
    || decoded.useMetaFactory !== true
    || typeof decoded.index !== 'bigint'
    || decoded.index !== BigInt(outer.args[2])
    || !sameHex(decoded.validatorInitData?.identifier, PASSKEY_ROOT_VALIDATOR_ID)
    || !sameHex(decoded.validatorInitData?.validatorAddress, PASSKEY_ROOT_VALIDATOR_ID)
    || !sameHex(decoded.validatorInitData?.enableData, initialize.args[2])
    || decoded.validatorInitData?.initConfig !== undefined) {
    fail('APPROVAL_MALFORMED', 'serialized approval account initialization mismatch');
  }
  const canonicalInitialize = encodeFunctionData({
    abi: KernelV3_1AccountAbi,
    functionName: 'initialize',
    args: [...initialize.args],
  });
  const canonicalInitCode = encodeFunctionData({
    abi: KernelFactoryStakerAbi,
    functionName: 'deployWithFactory',
    args: [KERNEL_V0_3_1_FACTORY, canonicalInitialize, outer.args[2]],
  });
  if (!sameHex(initCode, canonicalInitCode)) {
    fail('APPROVAL_MALFORMED', 'serialized approval factory init code is not canonical');
  }
}

function validatePermissions(call, policy) {
  const entries = call.permissions;
  if (!Array.isArray(entries) || entries.length !== 2) {
    fail('POLICY_MISMATCH', 'call policy must contain exactly two permissions');
  }
  const [approve, deposit] = entries;
  if (!objectWithOnly(approve, CALL_FIELDS) || !objectWithOnly(deposit, CALL_FIELDS)) {
    fail('POLICY_MISMATCH', 'permission contains unsupported fields');
  }
  if (approve.functionName !== 'approve' || !sameAddress(approve.target, policy.usdcAddress)
    || !sameHex(approve.selector, policy.approveSelector) || approve.callType !== '0x00'
    || approve.valueLimit !== '0') {
    fail('POLICY_MISMATCH', 'approve permission mismatch');
  }
  if (deposit.functionName !== 'deposit' || !sameAddress(deposit.target, policy.yieldRouterAddress)
    || !sameHex(deposit.selector, policy.depositSelector) || deposit.callType !== '0x00'
    || deposit.valueLimit !== '0') {
    fail('POLICY_MISMATCH', 'deposit permission mismatch');
  }

  if (!Array.isArray(approve.args) || approve.args.length !== 2) {
    fail('POLICY_MISMATCH', 'approve argument metadata mismatch');
  }
  exactArg(approve.args[0], ParamCondition.EQUAL, policy.yieldRouterAddress, 'approve spender');
  if (!objectWithOnly(approve.args[1], ARG_FIELDS)
    || approve.args[1].condition !== ParamCondition.LESS_THAN_OR_EQUAL) {
    fail('POLICY_MISMATCH', 'approve cap argument mismatch');
  }
  const approveCap = canonicalDecimal(approve.args[1].value, 'approve cap');
  if (approveCap <= 0n || approveCap > MAX_CALL_CAP_UNITS) {
    fail('POLICY_MISMATCH', 'approve cap is outside the canonical bound');
  }

  if (!Array.isArray(deposit.args) || deposit.args.length !== 3
    || deposit.args[0] !== null || deposit.args[2] !== null
    || !objectWithOnly(deposit.args[1], ARG_FIELDS)
    || deposit.args[1].condition !== ParamCondition.LESS_THAN_OR_EQUAL) {
    fail('POLICY_MISMATCH', 'deposit argument metadata mismatch');
  }
  const depositCap = canonicalDecimal(deposit.args[1].value, 'deposit cap');
  if (depositCap !== approveCap) fail('POLICY_MISMATCH', 'permission caps must be equal');

  if (!Array.isArray(approve.rules) || approve.rules.length !== 2) {
    fail('POLICY_MISMATCH', 'approve rules mismatch');
  }
  const spenderRule = ruleValue(approve.rules[0], 'approve spender');
  if (approve.rules[0].condition !== ParamCondition.EQUAL
    || approve.rules[0].offset !== 0
    || !sameHex(spenderRule, pad(policy.yieldRouterAddress, { size: 32 }))) {
    fail('POLICY_MISMATCH', 'approve spender rule mismatch');
  }
  const approveCapRule = ruleValue(approve.rules[1], 'approve cap');
  if (approve.rules[1].condition !== ParamCondition.LESS_THAN_OR_EQUAL
    || approve.rules[1].offset !== 32
    || BigInt(approveCapRule) !== approveCap) {
    fail('POLICY_MISMATCH', 'approve cap rule mismatch');
  }
  if (!Array.isArray(deposit.rules) || deposit.rules.length !== 1) {
    fail('POLICY_MISMATCH', 'deposit rules mismatch');
  }
  const depositCapRule = ruleValue(deposit.rules[0], 'deposit cap');
  if (deposit.rules[0].condition !== ParamCondition.LESS_THAN_OR_EQUAL
    || deposit.rules[0].offset !== 32
    || BigInt(depositCapRule) !== depositCap) {
    fail('POLICY_MISMATCH', 'deposit cap rule mismatch');
  }
  return approveCap;
}

function derivePermissionId({ call, timestamp, policy, sessionKeyAddress }) {
  const policies = [
    toCallPolicy({
      policyVersion: call.policyVersion,
      policyAddress: policy.callPolicyAddress,
      policyFlag: call.policyFlag,
      permissions: call.permissions,
    }),
    toTimestampPolicy({
      policyAddress: policy.timestampPolicyAddress,
      policyFlag: timestamp.policyFlag,
      validAfter: timestamp.validAfter,
      validUntil: timestamp.validUntil,
    }),
  ];
  const policyId = encodeAbiParameters(
    [{ name: 'policiesData', type: 'bytes[]' }],
    [policies.map((entry) => concatHex([entry.getPolicyInfoInBytes(), entry.getPolicyData()]))],
  );
  const signerId = encodeAbiParameters(
    [{ name: 'signerData', type: 'bytes' }],
    [concatHex([policy.ecdsaSignerAddress, sessionKeyAddress])],
  );
  return slice(keccak256(encodeAbiParameters(
    [{ name: 'policyAndSignerData', type: 'bytes[]' }],
    [[policyId, CANONICAL_PERMISSION_FLAG, signerId]],
  )), 0, 4).toLowerCase();
}

export function expectedCanonicalPolicyData() {
  return [
    concatHex([CANONICAL_PERMISSION_FLAG, CANONICAL_BASE_MANDATE_POLICY.callPolicyAddress]),
    concatHex([CANONICAL_PERMISSION_FLAG, CANONICAL_BASE_MANDATE_POLICY.timestampPolicyAddress]),
  ];
}

export function parseCanonicalMandate({
  serializedApproval,
  sessionPrivateKey,
  sessionKeyAddress,
  stellarOwner,
  kernelAddress,
  permissionId,
  validUntilSeconds,
  expiresAt,
  relayerOrigin,
  bindingId,
  bindingHash,
  config,
  now,
}) {
  const policy = assertPinnedConfig(config);
  const decoded = decodeCanonicalBase64(serializedApproval);
  if (!objectWithOnly(decoded.accountParams, ACCOUNT_FIELDS)
    || !isAddress(String(decoded.accountParams.accountAddress || ''))
    || !boundedHex(decoded.accountParams.initCode, MAX_INIT_CODE_BYTES)
    || !objectWithOnly(decoded.permissionParams, PERMISSION_PARAMS_FIELDS)
    || !PERMISSION_ID_RE.test(String(decoded.permissionParams.permissionId || ''))) {
    fail('APPROVAL_MALFORMED', 'serialized approval envelope mismatch');
  }
  validateCanonicalInitCode(decoded.accountParams.initCode, policy);
  if (!objectWithOnly(decoded.action, ACTION_FIELDS)
    || !sameHex(decoded.action.selector, DEFAULT_ACTION_SELECTOR)
    || !sameAddress(decoded.action.address, ZERO_ADDRESS)) {
    fail('APPROVAL_MALFORMED', 'serialized approval action mismatch');
  }
  if (!objectWithOnly(decoded.validityData, VALIDITY_FIELDS)
    || decoded.validityData.validAfter !== 0 || decoded.validityData.validUntil !== 0) {
    fail('APPROVAL_MALFORMED', 'serialized approval account validity mismatch');
  }
  if (!boundedHex(decoded.enableSignature, MAX_ENABLE_SIGNATURE_BYTES, { allowEmpty: false })) {
    fail('APPROVAL_MALFORMED', 'serialized approval enable signature mismatch');
  }
  if (decoded.eip7702Auth != null || (decoded.isPreInstalled !== undefined && decoded.isPreInstalled !== false)) {
    fail('APPROVAL_MALFORMED', 'serialized approval installation mode mismatch');
  }
  if (!isStellarStrKey(stellarOwner)) fail('OWNER_MISMATCH', 'invalid Stellar owner checksum');
  if (!sameAddress(decoded.accountParams.accountAddress, kernelAddress)) {
    fail('KERNEL_MISMATCH', 'kernel does not match the serialized approval');
  }
  let derivedSession;
  try {
    derivedSession = deriveSessionAddress(sessionPrivateKey);
  } catch {
    fail('SESSION_MISMATCH', 'invalid session private key');
  }
  if (!sameAddress(derivedSession, sessionKeyAddress)) {
    fail('SESSION_MISMATCH', 'session address does not match the supplied private key');
  }

  const policies = decoded.permissionParams.policies;
  if (!Array.isArray(policies) || policies.length !== 2
    || !objectWithOnly(policies[0], POLICY_FIELDS) || !objectWithOnly(policies[1], POLICY_FIELDS)
    || !objectWithOnly(policies[0].policyParams, CALL_POLICY_FIELDS)
    || !objectWithOnly(policies[1].policyParams, TIMESTAMP_POLICY_FIELDS)) {
    fail('POLICY_MISMATCH', 'policy order or count mismatch');
  }
  const call = policies[0].policyParams;
  const timestamp = policies[1].policyParams;
  if (call.type !== 'call' || timestamp.type !== 'timestamp'
    || call.policyVersion !== policy.callPolicyVersion
    || (call.policyAddress !== undefined && !sameAddress(call.policyAddress, policy.callPolicyAddress))
    || !sameAddress(timestamp.policyAddress, policy.timestampPolicyAddress)
    || call.policyFlag !== CANONICAL_PERMISSION_FLAG
    || timestamp.policyFlag !== CANONICAL_PERMISSION_FLAG) {
    fail('POLICY_MISMATCH', 'policy contract, version, flag, or order mismatch');
  }
  if (timestamp.validAfter !== 0 || !Number.isSafeInteger(timestamp.validUntil)
    || timestamp.validUntil <= 0) {
    fail('POLICY_MISMATCH', 'timestamp policy mismatch');
  }
  if (!Number.isSafeInteger(validUntilSeconds) || !Number.isSafeInteger(expiresAt)
    || timestamp.validUntil !== validUntilSeconds || validUntilSeconds !== expiresAt) {
    fail('EXPIRY_MISMATCH', 'embedded and public expiry must match in Unix seconds');
  }
  if (now !== undefined && (!Number.isSafeInteger(now) || now >= validUntilSeconds)) {
    fail('EXPIRED', 'mandate has expired');
  }
  const cap = validatePermissions(call, policy);
  const canonicalPermissionId = derivePermissionId({
    call,
    timestamp,
    policy,
    sessionKeyAddress: derivedSession,
  });
  if (decoded.permissionParams.permissionId !== canonicalPermissionId
    || (permissionId !== undefined && permissionId !== canonicalPermissionId)) {
    fail('PERMISSION_MISMATCH', 'permission identity mismatch');
  }
  if (relayerOrigin !== undefined && relayerOrigin !== config?.publicOrigin) {
    fail('ORIGIN_MISMATCH', 'relayer origin mismatch');
  }
  if (bindingId !== undefined || bindingHash !== undefined) {
    const wantedBinding = digestCanonicalValue(
      `${stellarOwner}|${kernelAddress}|${sessionKeyAddress}|${validUntilSeconds}`,
    );
    if (typeof bindingId !== 'string' || !bindingId || bindingHash !== wantedBinding) {
      fail('BINDING_MISMATCH', 'binding mismatch');
    }
  }
  return {
    accountAddress: decoded.accountParams.accountAddress,
    sessionKeyAddress: derivedSession,
    stellarOwner,
    permissionId: canonicalPermissionId,
    validAfter: timestamp.validAfter,
    validUntilSeconds,
    cap,
    policies,
    call,
    timestamp,
    policyDigest: digestCanonicalValue(policies),
    policyData: expectedCanonicalPolicyData(),
  };
}

export function validateCanonicalMandate(params) {
  try {
    return { ok: true, mandate: parseCanonicalMandate(params) };
  } catch (error) {
    if (error instanceof CanonicalMandateError) {
      return { ok: false, code: error.code, reason: error.message };
    }
    return { ok: false, code: 'APPROVAL_MALFORMED', reason: 'malformed canonical mandate' };
  }
}
