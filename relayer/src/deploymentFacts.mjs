import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StrKey } from '@stellar/stellar-sdk';
import { getAddress } from 'viem';

const STELLAR_PATH = new URL('../../deployments/stellar-testnet.json', import.meta.url);
const BASE_PATH = new URL('../../deployments/base-sepolia.json', import.meta.url);

const BASE_POLICY = Object.freeze({
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

const HASH_RE = /^[a-f0-9]{64}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const USER_SPECIFIC_POLICY_KEYS = /kernelAddress|session|permission|binding/i;
const BASE_UNAVAILABLE_REASON = 'Hardened Base deployment is not active.';
const BASE_VERIFICATION_FAILED_REASON = 'Hardened Base deployment verification failed.';
const HEX_HASH_RE = /^0x[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_RE = /^[1-9][0-9]*$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const CIRCLE_BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CIRCLE_BASE_TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const HARDENED_EXIT_SELECTOR = '0x4c9d247b';
const ABSENT_EXIT_SELECTORS = Object.freeze(['0x0d390c9e', '0x9abaf267']);

// Activation remains an explicit code/configuration ceremony. A generation label or a verifier
// record in deployments JSON is not authority by itself; an independently reviewed exact record
// must be pinned here in a separately authorized change.
export const APPROVED_HARDENED_BASE_DEPLOYMENT = null;

const HARDENED_FIELDS = new Set([
  'generation', 'chainId', 'adminSafe', 'yieldRouter', 'baseExitSweeper',
  'route', 'selectors', 'pools', 'verification',
]);
const HARDENED_ENVELOPE_FIELDS = new Set(['base']);
const HARDENED_BASE_ENVELOPE_FIELDS = new Set(['hardenedDeployment']);
const SAFE_FIELDS = new Set([
  'address', 'proxyImplementation', 'runtimeCodeHash', 'threshold', 'owners',
]);
const ROUTER_FIELDS = new Set([
  'address', 'deployTxHash', 'deployBlockNumber', 'deployBlockHash',
  'rawRuntimeCodeHash', 'normalizedRuntimeCodeHash',
]);
const SWEEPER_FIELDS = new Set([
  'address', 'deployTxHash', 'deployBlockNumber', 'deployBlockHash',
  'rawRuntimeCodeHash', 'normalizedRuntimeCodeHash',
]);
const ROUTE_FIELDS = new Set([
  'usdcAddress', 'tokenMessengerAddress', 'stellarDomain', 'mintRecipient',
  'destinationCaller', 'finalityThreshold',
]);
const SELECTOR_FIELDS = new Set(['exitAllAndBurn', 'absent']);
const POOL_FIELDS = new Set(['enabled', 'known']);
const VERIFICATION_FIELDS = new Set(['blockNumber', 'blockHash']);

function required(object, key, label) {
  const value = object?.[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`${label}.${key} is missing`);
  }
  return value;
}

function assertContract(value, label) {
  if (!StrKey.isValidContract(String(value || ''))) throw new Error(`${label} is not a Stellar contract`);
  return value;
}

function assertAccount(value, label) {
  if (!StrKey.isValidEd25519PublicKey(String(value || ''))) throw new Error(`${label} is not a Stellar account`);
  return value;
}

function assertEvm(value, label) {
  if (!EVM_RE.test(String(value || ''))) throw new Error(`${label} is not an EVM address`);
  return value;
}

function exactObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function checksumAddress(value) {
  try {
    return typeof value === 'string'
      && value !== ZERO_ADDRESS
      && EVM_RE.test(value)
      && getAddress(value) === value;
  } catch {
    return false;
  }
}

function canonicalHexHash(value) {
  return typeof value === 'string'
    && HEX_HASH_RE.test(value)
    && !/^0x0{64}$/.test(value);
}

function canonicalDecimal(value) {
  return typeof value === 'string' && POSITIVE_DECIMAL_RE.test(value);
}

function canonicalAddressArray(value) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(checksumAddress)) return false;
  const normalized = value.map((entry) => entry.toLowerCase());
  return new Set(normalized).size === normalized.length
    && normalized.every((entry, index) => index === 0 || normalized[index - 1] < entry);
}

function validContractFacts(value, fields) {
  if (!exactObject(value, fields) || !checksumAddress(value.address)
    || !canonicalHexHash(value.deployTxHash)
    || !canonicalDecimal(value.deployBlockNumber)
    || !canonicalHexHash(value.deployBlockHash)
    || !canonicalHexHash(value.rawRuntimeCodeHash)
    || !canonicalHexHash(value.normalizedRuntimeCodeHash)) return false;
  return true;
}

function validateHardenedShape(record) {
  if (!exactObject(record, HARDENED_FIELDS)
    || record.generation !== 'hardened-v2'
    || record.chainId !== 84532
    || !exactObject(record.adminSafe, SAFE_FIELDS)
    || !checksumAddress(record.adminSafe.address)
    || !checksumAddress(record.adminSafe.proxyImplementation)
    || !canonicalHexHash(record.adminSafe.runtimeCodeHash)
    || !Number.isSafeInteger(record.adminSafe.threshold)
    || record.adminSafe.threshold < 1
    || !canonicalAddressArray(record.adminSafe.owners)
    || record.adminSafe.threshold > record.adminSafe.owners.length
    || !validContractFacts(record.yieldRouter, ROUTER_FIELDS)
    || !validContractFacts(record.baseExitSweeper, SWEEPER_FIELDS)
    || !exactObject(record.route, ROUTE_FIELDS)
    || record.route.usdcAddress !== CIRCLE_BASE_USDC
    || record.route.tokenMessengerAddress !== CIRCLE_BASE_TOKEN_MESSENGER
    || record.route.stellarDomain !== 27
    || !canonicalHexHash(record.route.mintRecipient)
    || !canonicalHexHash(record.route.destinationCaller)
    || /^0x0{64}$/.test(record.route.mintRecipient)
    || /^0x0{64}$/.test(record.route.destinationCaller)
    || record.route.finalityThreshold !== 1000
    || !exactObject(record.selectors, SELECTOR_FIELDS)
    || record.selectors.exitAllAndBurn !== HARDENED_EXIT_SELECTOR
    || JSON.stringify(record.selectors.absent) !== JSON.stringify(ABSENT_EXIT_SELECTORS)
    || !exactObject(record.pools, POOL_FIELDS)
    || !canonicalAddressArray(record.pools.enabled)
    || !canonicalAddressArray(record.pools.known)
    || JSON.stringify(record.pools.enabled) !== JSON.stringify(record.pools.known)
    || !exactObject(record.verification, VERIFICATION_FIELDS)
    || !canonicalDecimal(record.verification.blockNumber)
    || !canonicalHexHash(record.verification.blockHash)) return false;
  try {
    const routerDeployBlock = BigInt(record.yieldRouter.deployBlockNumber);
    const sweeperDeployBlock = BigInt(record.baseExitSweeper.deployBlockNumber);
    const verificationBlock = BigInt(record.verification.blockNumber);
    if (routerDeployBlock > sweeperDeployBlock
      || sweeperDeployBlock > verificationBlock) return false;
  } catch {
    return false;
  }
  return true;
}

export function evaluateHardenedBaseDeployment(
  record,
  approvedHardenedDeployment = APPROVED_HARDENED_BASE_DEPLOYMENT,
) {
  if (!record || !approvedHardenedDeployment) {
    return Object.freeze({
      baseCrossChainAvailable: false,
      unavailableReason: BASE_UNAVAILABLE_REASON,
      hardenedDeployment: null,
    });
  }
  const valid = validateHardenedShape(record)
    && validateHardenedShape(approvedHardenedDeployment)
    && JSON.stringify(record) === JSON.stringify(approvedHardenedDeployment);
  if (!valid) {
    return Object.freeze({
      baseCrossChainAvailable: false,
      unavailableReason: BASE_VERIFICATION_FAILED_REASON,
      hardenedDeployment: null,
    });
  }
  return Object.freeze({
    baseCrossChainAvailable: true,
    unavailableReason: null,
    hardenedDeployment: deepFreeze(structuredClone(record)),
  });
}

export function evaluateHardenedBaseDeploymentEnvelope(
  envelope,
  approvedHardenedDeployment = APPROVED_HARDENED_BASE_DEPLOYMENT,
) {
  if (!exactObject(envelope, HARDENED_ENVELOPE_FIELDS)
      || !exactObject(envelope.base, HARDENED_BASE_ENVELOPE_FIELDS)) {
    return Object.freeze({
      baseCrossChainAvailable: false,
      unavailableReason: BASE_VERIFICATION_FAILED_REASON,
      hardenedDeployment: null,
    });
  }
  return evaluateHardenedBaseDeployment(
    envelope.base.hardenedDeployment,
    approvedHardenedDeployment,
  );
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new Error(`${label} is not a sha256 hash`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readJson(url, label) {
  try {
    return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
  } catch (error) {
    throw new Error(`cannot load ${label}: ${error.message}`);
  }
}

function validatePolicy(base) {
  const policy = required(base, 'baseMandatePolicy', 'base deployment');
  for (const key of Object.keys(policy)) {
    if (USER_SPECIFIC_POLICY_KEYS.test(key) && !Object.hasOwn(BASE_POLICY, key)) {
      throw new Error(`baseMandatePolicy contains user-specific fact ${key}`);
    }
    if (!Object.hasOwn(BASE_POLICY, key)) {
      throw new Error(`baseMandatePolicy contains unsupported fact ${key}`);
    }
  }
  for (const [key, expected] of Object.entries(BASE_POLICY)) {
    const actual = required(policy, key, 'baseMandatePolicy');
    if (actual !== expected) throw new Error(`baseMandatePolicy.${key} does not match the pinned fact`);
  }
  if (policy.usdcAddress !== base.baseExitSweeper?.usdc) {
    throw new Error('baseMandatePolicy.usdcAddress does not match baseExitSweeper.usdc');
  }
  if (policy.yieldRouterAddress !== base.yieldRouter?.address) {
    throw new Error('baseMandatePolicy.yieldRouterAddress does not match yieldRouter.address');
  }
  return policy;
}

export function validateDeploymentFacts(
  { stellar, base },
  { approvedHardenedDeployment = APPROVED_HARDENED_BASE_DEPLOYMENT } = {},
) {
  if (stellar?.network !== 'testnet') throw new Error('stellar deployment network must be testnet');
  const passphrase = required(stellar, 'passphrase', 'stellar deployment');
  const rpcUrl = required(stellar, 'rpc', 'stellar deployment');
  const relayerPublic = assertAccount(required(stellar, 'relayer', 'stellar deployment'), 'stellar relayer');
  const routerV1 = assertContract(required(stellar?.fundingRouter, 'address', 'fundingRouter'), 'fundingRouter.address');
  const routerV2 = assertContract(required(stellar?.fundingRouter, 'addressV2', 'fundingRouter'), 'fundingRouter.addressV2');
  const agentWasmV1 = assertHash(required(stellar, 'agentAccountWasmHash', 'stellar deployment'), 'agentAccountWasmHash');
  const agentWasmV2 = assertHash(required(stellar?.fundingRouter, 'agentWasmHashV3New', 'fundingRouter'), 'fundingRouter.agentWasmHashV3New');
  const exitRouterAddress = assertContract(required(stellar?.exitRouter, 'address', 'exitRouter'), 'exitRouter.address');
  const vaultAddress = assertContract(required(stellar?.autofarmVault, 'address', 'autofarmVault'), 'autofarmVault.address');
  const tokenAddress = assertContract(required(stellar?.autofarmVault, 'token', 'autofarmVault'), 'autofarmVault.token');

  const policy = validatePolicy(base);
  const pools = required(base?.yieldRouter, 'allowedPools', 'yieldRouter');
  if (!Array.isArray(pools) || pools.length !== 3) throw new Error('yieldRouter.allowedPools must contain three targets');
  pools.forEach((pool, index) => assertEvm(pool, `yieldRouter.allowedPools[${index}]`));
  assertEvm(policy.usdcAddress, 'baseMandatePolicy.usdcAddress');
  assertEvm(policy.yieldRouterAddress, 'baseMandatePolicy.yieldRouterAddress');

  const availability = evaluateHardenedBaseDeploymentEnvelope(
    { base: { hardenedDeployment: base?.hardenedDeployment } },
    approvedHardenedDeployment,
  );
  const active = availability.hardenedDeployment;
  const activePolicy = active ? deepFreeze({
    ...BASE_POLICY,
    usdcAddress: active.route.usdcAddress,
    yieldRouterAddress: active.yieldRouter.address,
  }) : policy;
  const activePools = active?.pools.enabled ?? pools;
  const raw = deepFreeze({ stellar, base });
  return deepFreeze({
    stellar: {
      networkId: 'stellar-testnet',
      passphrase,
      rpcUrl,
      relayerPublic,
      routerAddresses: [routerV2, routerV1],
      agentWasmHashes: [agentWasmV2, agentWasmV1],
      exitRouterAddress,
      vaultAddress,
      tokenAddress,
    },
    base: {
      chainId: activePolicy.chainId,
      usdcAddress: activePolicy.usdcAddress,
      yieldRouterAddress: activePolicy.yieldRouterAddress,
      baseExitSweeperAddress: active?.baseExitSweeper.address ?? base?.baseExitSweeper?.address,
      allowedPools: activePools,
      mandatePolicy: activePolicy,
      baseCrossChainAvailable: availability.baseCrossChainAvailable,
      unavailableReason: availability.unavailableReason,
      hardenedDeployment: active,
    },
    digests: {
      deployments: digest({ stellar, base }),
      baseMandatePolicy: digest(activePolicy),
    },
    raw,
  });
}

export function loadDeploymentFacts() {
  return validateDeploymentFacts({
    stellar: readJson(STELLAR_PATH, 'deployments/stellar-testnet.json'),
    base: readJson(BASE_PATH, 'deployments/base-sepolia.json'),
  });
}
