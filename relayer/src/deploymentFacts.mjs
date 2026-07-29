import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StrKey } from '@stellar/stellar-sdk';

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

function assertHash(value, label) {
  if (!HASH_RE.test(String(value || ''))) throw new Error(`${label} is not a sha256 hash`);
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

export function validateDeploymentFacts({ stellar, base }) {
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
      chainId: policy.chainId,
      usdcAddress: policy.usdcAddress,
      yieldRouterAddress: policy.yieldRouterAddress,
      allowedPools: pools,
      mandatePolicy: policy,
    },
    digests: {
      deployments: digest({ stellar, base }),
      baseMandatePolicy: digest(policy),
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
