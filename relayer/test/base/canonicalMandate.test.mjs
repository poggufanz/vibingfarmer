import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  slice,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KernelFactoryStakerAbi, KernelV3_1AccountAbi } from '@zerodev/sdk';
import { ParamCondition, toCallPolicy, toTimestampPolicy } from '@zerodev/permissions/policies';
import {
  MAX_CALL_CAP_UNITS,
  parseCanonicalMandate,
  validateCanonicalMandate,
} from '../../src/base/canonicalMandate.mjs';

const NOW_SECONDS = 2_000_000_000;
const VALID_UNTIL = NOW_SECONDS + 7_200;
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const KERNEL = `0x${'11'.repeat(20)}`;
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SESSION = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const USER_OP_HASH = `0x${'33'.repeat(32)}`;
const TX_HASH = `0x${'44'.repeat(32)}`;
const CALL_POLICY = '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2';
const TIMESTAMP_POLICY = '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F';
const ECDSA_SIGNER = '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d';
const DEFAULT_ACTION_SELECTOR = '0xe9ae5c53';
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const KERNEL_FACTORY = '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419';
const PASSKEY_VALIDATOR = '0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69';

const policy = Object.freeze({
  chainId: 84532,
  kernelVersion: '0.3.1',
  kernelImplementation: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
  entryPointVersion: '0.7',
  entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  callPolicyVersion: '0.0.4',
  callPolicyAddress: CALL_POLICY,
  timestampPolicyAddress: TIMESTAMP_POLICY,
  ecdsaSignerAddress: ECDSA_SIGNER,
  usdcAddress: USDC,
  yieldRouterAddress: ROUTER,
  approveSelector: '0x095ea7b3',
  depositSelector: '0x0efe6a8b',
  callType: 'call',
  nativeValue: '0',
  executionHorizonSeconds: 2700,
});

const config = Object.freeze({
  publicOrigin: 'https://relayer.example',
  base: {
    chain: { id: 84532 },
    mandatePolicy: policy,
    baseCrossChainAvailable: true,
    hardenedDeployment: {
      generation: 'hardened-v2',
      chainId: 84532,
      yieldRouter: { address: ROUTER },
      route: { usdcAddress: USDC },
    },
  },
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serialize(value) {
  return Buffer.from(JSON.stringify(value, (_, child) => (
    typeof child === 'bigint' ? child.toString() : child
  )), 'utf8').toString('base64');
}

function permissions(cap = MAX_CALL_CAP_UNITS) {
  const encodedCap = pad(`0x${cap.toString(16)}`, { size: 32 });
  return [
    {
      target: USDC,
      valueLimit: '0',
      functionName: 'approve',
      args: [
        { condition: ParamCondition.EQUAL, value: ROUTER },
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap.toString() },
      ],
      callType: '0x00',
      selector: '0x095ea7b3',
      rules: [
        { params: [pad(ROUTER, { size: 32 })], offset: 0, condition: ParamCondition.EQUAL },
        { params: [encodedCap], offset: 32, condition: ParamCondition.LESS_THAN_OR_EQUAL },
      ],
    },
    {
      target: ROUTER,
      valueLimit: '0',
      functionName: 'deposit',
      args: [null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap.toString() }, null],
      callType: '0x00',
      selector: '0x0efe6a8b',
      rules: [
        { params: [encodedCap], offset: 32, condition: ParamCondition.LESS_THAN_OR_EQUAL },
      ],
    },
  ];
}

function permissionId({ entries, sessionAddress = SESSION }) {
  const policiesData = encodeAbiParameters(
    [{ name: 'policiesData', type: 'bytes[]' }],
    [entries.map((entry) => concatHex([entry.getPolicyInfoInBytes(), entry.getPolicyData()]))],
  );
  const signerData = encodeAbiParameters(
    [{ name: 'signerData', type: 'bytes' }],
    [concatHex([ECDSA_SIGNER, sessionAddress])],
  );
  return slice(keccak256(encodeAbiParameters(
    [{ name: 'policyAndSignerData', type: 'bytes[]' }],
    [[policiesData, '0x0000', signerData]],
  )), 0, 4).toLowerCase();
}

function fixture({ cap = MAX_CALL_CAP_UNITS, topLevel = {}, mutate = () => {} } = {}) {
  const call = toCallPolicy({ policyVersion: '0.0.4', permissions: permissions(cap) });
  const timestamp = toTimestampPolicy({ validAfter: 0, validUntil: VALID_UNTIL });
  const value = {
    permissionParams: {
      permissionId: permissionId({ entries: [call, timestamp] }),
      policies: [call, timestamp],
    },
    action: { selector: DEFAULT_ACTION_SELECTOR, address: ZERO_ADDRESS },
    validityData: { validAfter: 0, validUntil: 0 },
    accountParams: { initCode: '0x', accountAddress: KERNEL },
    enableSignature: '0x1234',
    isPreInstalled: false,
    ...topLevel,
  };
  mutate(value);
  return serialize(value);
}

function params(overrides = {}) {
  const serializedApproval = overrides.serializedApproval ?? fixture();
  const bindingHash = sha256(`${OWNER}|${KERNEL}|${SESSION}|${VALID_UNTIL}`);
  return {
    serializedApproval,
    sessionPrivateKey: SESSION_PRIVATE_KEY,
    sessionKeyAddress: SESSION,
    stellarOwner: OWNER,
    kernelAddress: KERNEL,
    permissionId: permissionId({
      entries: [
        toCallPolicy({ policyVersion: '0.0.4', permissions: permissions() }),
        toTimestampPolicy({ validAfter: 0, validUntil: VALID_UNTIL }),
      ],
    }),
    validUntilSeconds: VALID_UNTIL,
    expiresAt: VALID_UNTIL,
    relayerOrigin: 'https://relayer.example',
    bindingId: 'binding-1',
    bindingHash,
    activationUserOpHash: USER_OP_HASH,
    activationTxHash: TX_HASH,
    activatedAt: NOW_SECONDS - 10,
    config,
    now: NOW_SECONDS,
    ...overrides,
  };
}

function mutateApproval(mutator, options = {}) {
  const decoded = JSON.parse(Buffer.from(fixture(options), 'base64').toString('utf8'));
  mutator(decoded);
  return serialize(decoded);
}

function sdkKernelInitCode({ factory = KERNEL_FACTORY, validator = PASSKEY_VALIDATOR } = {}) {
  const initialize = encodeFunctionData({
    abi: KernelV3_1AccountAbi,
    functionName: 'initialize',
    args: [concatHex(['0x00', validator]), ZERO_ADDRESS, '0x1234', '0x', []],
  });
  return encodeFunctionData({
    abi: KernelFactoryStakerAbi,
    functionName: 'deployWithFactory',
    args: [factory, initialize, pad('0x01', { size: 32 })],
  });
}

describe('parseCanonicalMandate', () => {
  it('accepts canonical padded SDK base64 and returns only normalized public facts', () => {
    let serializedApproval = fixture();
    for (let n = 1; !serializedApproval.endsWith('=') && n < 4; n += 1) {
      serializedApproval = fixture({ topLevel: { enableSignature: `0x${'00'.repeat(n)}` } });
    }
    expect(serializedApproval.endsWith('=')).toBe(true);

    expect(parseCanonicalMandate(params({ serializedApproval }))).toMatchObject({
      accountAddress: KERNEL,
      sessionKeyAddress: SESSION,
      stellarOwner: OWNER,
      permissionId: expect.stringMatching(/^0x[0-9a-f]{8}$/),
      validUntilSeconds: VALID_UNTIL,
      cap: MAX_CALL_CAP_UNITS,
    });
  });

  it('accepts SDK-generated Kernel 0.3.1 meta-factory init code with pinned root facts', () => {
    const serializedApproval = fixture({
      mutate: (value) => { value.accountParams.initCode = sdkKernelInitCode(); },
    });

    expect(parseCanonicalMandate(params({ serializedApproval }))).toMatchObject({
      accountAddress: KERNEL,
      permissionId: expect.stringMatching(/^0x[0-9a-f]{8}$/),
    });
  });

  it.each([
    ['factory', { factory: USDC }],
    ['root validator', { validator: ECDSA_SIGNER }],
  ])('rejects non-canonical Kernel 0.3.1 %s init facts', (_label, initOverrides) => {
    const serializedApproval = fixture({
      mutate: (value) => { value.accountParams.initCode = sdkKernelInitCode(initOverrides); },
    });

    expect(validateCanonicalMandate(params({ serializedApproval })).ok).toBe(false);
  });

  it.each([
    ['trailing base64 garbage', () => `${fixture()}AAAA`],
    ['embedded private key', () => fixture({ topLevel: { privateKey: SESSION_PRIVATE_KEY } })],
    ['unexpected executable field', () => fixture({ topLevel: { delegateTarget: ROUTER } })],
    ['unexpected account field', () => fixture({ mutate: (v) => { v.accountParams.factory = ROUTER; } })],
    ['wrong action selector', () => fixture({ topLevel: { action: { selector: '0xffffffff', address: ZERO_ADDRESS } } })],
    ['wrong action address', () => fixture({ topLevel: { action: { selector: DEFAULT_ACTION_SELECTOR, address: ROUTER } } })],
    ['extra action field', () => fixture({ topLevel: { action: { selector: DEFAULT_ACTION_SELECTOR, address: ZERO_ADDRESS, hook: ROUTER } } })],
    ['account validity drift', () => fixture({ topLevel: { validityData: { validAfter: 1, validUntil: 0 } } })],
    ['missing enable signature', () => fixture({ mutate: (v) => { delete v.enableSignature; } })],
    ['unbounded enable signature', () => fixture({ topLevel: { enableSignature: `0x${'00'.repeat(16_385)}` } })],
    ['malformed enable signature', () => fixture({ topLevel: { enableSignature: 'not-hex' } })],
    ['EIP-7702 authorization', () => fixture({ topLevel: { eip7702Auth: { address: ROUTER } } })],
    ['preinstalled permission', () => fixture({ topLevel: { isPreInstalled: true } })],
    ['malformed init code', () => fixture({ mutate: (v) => { v.accountParams.initCode = '0x1'; } })],
    ['even-byte garbage init code', () => fixture({ mutate: (v) => { v.accountParams.initCode = '0x12'; } })],
    ['unbounded init code', () => fixture({ mutate: (v) => { v.accountParams.initCode = `0x${'00'.repeat(65_537)}`; } })],
    ['wrong approve spender', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].args[0].value = USDC; })],
    ['extra permission', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions.push({ ...v.permissionParams.policies[0].policyParams.permissions[1] }); })],
    ['unexpected permission field', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].delegateTarget = ROUTER; })],
    ['duplicate approve', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[1] = { ...v.permissionParams.policies[0].policyParams.permissions[0] }; })],
    ['duplicate deposit', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0] = { ...v.permissionParams.policies[0].policyParams.permissions[1] }; })],
    ['permission order', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions.reverse(); })],
    ['unequal caps', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[1].args[1].value = '1'; })],
    ['missing policy', () => mutateApproval((v) => { v.permissionParams.policies.pop(); })],
    ['extra policy type', () => mutateApproval((v) => { v.permissionParams.policies.push({ policyParams: { type: 'sudo' } }); })],
    ['policy order', () => mutateApproval((v) => { v.permissionParams.policies.reverse(); })],
    ['wrong call policy address', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.policyAddress = USDC; })],
    ['wrong timestamp policy address', () => mutateApproval((v) => { v.permissionParams.policies[1].policyParams.policyAddress = USDC; })],
    ['wrong call policy version', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.policyVersion = '0.0.5'; })],
    ['wrong policy flag', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.policyFlag = '0x0001'; })],
    ['wrong call type', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].callType = '0x01'; })],
    ['wrong selector', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].selector = '0xffffffff'; })],
    ['wrong argument condition', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].args[0].condition = ParamCondition.LESS_THAN_OR_EQUAL; })],
    ['string argument condition', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].args[0].condition = String(ParamCondition.EQUAL); })],
    ['wrong rule condition', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].rules[0].condition = ParamCondition.LESS_THAN_OR_EQUAL; })],
    ['boolean rule condition', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].rules[0].condition = false; })],
    ['wrong rule offset', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].rules[1].offset = 0; })],
    ['string rule offset', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].rules[0].offset = '0'; })],
    ['non-zero high spender word', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].rules[0].params[0] = `0x01${v.permissionParams.policies[0].policyParams.permissions[0].rules[0].params[0].slice(4)}`; })],
    ['non-zero native value', () => mutateApproval((v) => { v.permissionParams.policies[0].policyParams.permissions[0].valueLimit = '1'; })],
    ['non-zero validAfter', () => mutateApproval((v) => { v.permissionParams.policies[1].policyParams.validAfter = 1; })],
    ['timestamp mismatch', () => mutateApproval((v) => { v.permissionParams.policies[1].policyParams.validUntil += 1; })],
    ['permission id mismatch', () => mutateApproval((v) => { v.permissionParams.permissionId = '0xdeadbeef'; })],
  ])('rejects %s', (_label, build) => {
    expect(validateCanonicalMandate(params({ serializedApproval: build() })).ok).toBe(false);
  });

  it.each([
    ['Kernel implementation', 'kernelImplementation', `0x${'55'.repeat(20)}`],
    ['EntryPoint', 'entryPointAddress', `0x${'66'.repeat(20)}`],
    ['chain', 'chainId', 8453],
  ])('rejects wrong pinned %s facts', (_label, key, value) => {
    const changedPolicy = { ...policy, [key]: value };
    const changedConfig = {
      ...config,
      base: { ...config.base, chain: { id: changedPolicy.chainId }, mandatePolicy: changedPolicy },
    };
    expect(validateCanonicalMandate(params({ config: changedConfig })).ok).toBe(false);
  });

  it('rejects the otherwise canonical legacy mandate policy when hardened deployment authority is unavailable', () => {
    const unavailable = {
      ...config,
      base: { ...config.base, baseCrossChainAvailable: false },
    };

    expect(validateCanonicalMandate(params({ config: unavailable }))).toMatchObject({
      ok: false,
      code: 'POLICY_MISMATCH',
    });
  });

  it('rejects a Stellar address with a valid shape and invalid checksum', () => {
    const replacement = OWNER.endsWith('A') ? 'B' : 'A';
    const invalidChecksum = `${OWNER.slice(0, -1)}${replacement}`;
    expect(invalidChecksum).toMatch(/^G[A-Z2-7]{55}$/);
    expect(validateCanonicalMandate(params({ stellarOwner: invalidChecksum })).ok).toBe(false);
  });
});
