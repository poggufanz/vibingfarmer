import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  pad,
  slice,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ParamCondition, toCallPolicy, toTimestampPolicy } from '@zerodev/permissions/policies';
import { evaluateBaseMandateStatus } from '../src/mandateStatus.mjs';

const NOW = 2_000_000_000_000;
const NOW_SECONDS = NOW / 1000;
const VALID_UNTIL = NOW_SECONDS + 7_200;
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13)).publicKey();
const KERNEL = `0x${'11'.repeat(20)}`;
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SESSION = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const USER_OP_HASH = `0x${'33'.repeat(32)}`;
const TX_HASH = `0x${'44'.repeat(32)}`;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d';
const IMPLEMENTATION = '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D';
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const CALL_POLICY = '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2';
const TIMESTAMP_POLICY = '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F';
const ECDSA_SIGNER = '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF';
const CAP = 10_000_000_000n;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serialize(value) {
  return Buffer.from(JSON.stringify(value, (_, child) => (
    typeof child === 'bigint' ? child.toString() : child
  )), 'utf8').toString('base64');
}

function permissions() {
  const encodedCap = pad(`0x${CAP.toString(16)}`, { size: 32 });
  return [
    {
      target: USDC,
      valueLimit: '0',
      functionName: 'approve',
      args: [
        { condition: ParamCondition.EQUAL, value: ROUTER },
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: CAP.toString() },
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
      args: [null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: CAP.toString() }, null],
      callType: '0x00',
      selector: '0x0efe6a8b',
      rules: [{ params: [encodedCap], offset: 32, condition: ParamCondition.LESS_THAN_OR_EQUAL }],
    },
  ];
}

function permissionId(entries) {
  const policiesData = encodeAbiParameters(
    [{ name: 'policiesData', type: 'bytes[]' }],
    [entries.map((entry) => concatHex([entry.getPolicyInfoInBytes(), entry.getPolicyData()]))],
  );
  const signerData = encodeAbiParameters(
    [{ name: 'signerData', type: 'bytes' }],
    [concatHex([ECDSA_SIGNER, SESSION])],
  );
  return slice(keccak256(encodeAbiParameters(
    [{ name: 'policyAndSignerData', type: 'bytes[]' }],
    [[policiesData, '0x0000', signerData]],
  )), 0, 4).toLowerCase();
}

function approval({ validAfter = 0, validUntil = VALID_UNTIL } = {}) {
  const call = toCallPolicy({ policyVersion: '0.0.4', permissions: permissions() });
  const timestamp = toTimestampPolicy({ validAfter, validUntil });
  const id = permissionId([call, timestamp]);
  return {
    serializedApproval: serialize({
      permissionParams: { permissionId: id, policies: [call, timestamp] },
      action: { selector: '0xe9ae5c53', address: zeroAddress },
      validityData: { validAfter: 0, validUntil: 0 },
      accountParams: { initCode: '0x', accountAddress: KERNEL },
      enableSignature: '0x1234',
      isPreInstalled: false,
    }),
    permissionId: id,
    policyDigest: sha256(JSON.stringify([call, timestamp], (_, child) => (
      typeof child === 'bigint' ? child.toString() : child
    ))),
    policyData: [call.getPolicyInfoInBytes(), timestamp.getPolicyInfoInBytes()],
    validUntil,
  };
}

function makeHarness({ approvalOptions, record: recordOverrides } = {}) {
  const approved = approval(approvalOptions);
  const record = {
    serializedApproval: approved.serializedApproval,
    sessionPrivateKey: SESSION_PRIVATE_KEY,
    sessionKeyAddress: SESSION,
    stellarOwner: OWNER,
    kernelAddress: KERNEL,
    permissionId: approved.permissionId,
    policyDigest: approved.policyDigest,
    relayerOrigin: 'https://relayer.example',
    validUntilSeconds: approved.validUntil,
    status: 'active',
    bindingId: 'binding-1',
    bindingHash: sha256(`${OWNER}|${KERNEL}|${SESSION}|${approved.validUntil}`),
    activationUserOpHash: USER_OP_HASH,
    activationTxHash: TX_HASH,
    activatedAt: NOW_SECONDS - 10,
    createdAt: NOW_SECONDS - 20,
    ...recordOverrides,
  };
  const config = {
    publicOrigin: 'https://relayer.example',
    digests: { baseMandatePolicy: 'c'.repeat(64) },
    base: {
      chain: { id: 84532 },
      rpcUrl: 'https://base.example',
      bundlerRpcUrl: 'https://bundler.example',
      mandatePolicy: {
        chainId: 84532,
        kernelVersion: '0.3.1',
        kernelImplementation: IMPLEMENTATION,
        entryPointVersion: '0.7',
        entryPointAddress: ENTRY_POINT,
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
      },
    },
  };
  const permissionConfig = {
    permissionFlag: '0x0000',
    signer: ECDSA_SIGNER,
    policyData: approved.policyData,
  };
  const publicClient = {
    getChainId: vi.fn(async () => 84532),
    getBlock: vi.fn(async () => ({
      number: 1234n,
      hash: BLOCK_HASH,
      timestamp: BigInt(NOW_SECONDS - 1),
    })),
    getStorageAt: vi.fn(async () => pad(IMPLEMENTATION, { size: 32 })),
    readContract: vi.fn(async () => permissionConfig),
  };
  const kernelClient = {
    account: {
      address: KERNEL,
      entryPoint: { address: ENTRY_POINT, version: '0.7' },
      kernelVersion: '0.3.1',
      kernelPluginManager: { getIdentifier: vi.fn(() => approved.permissionId) },
    },
  };
  const makePublicClient = vi.fn(() => publicClient);
  const reconstructSessionClientFn = vi.fn(async () => kernelClient);
  const evaluate = (overrides = {}) => evaluateBaseMandateStatus({
    record,
    config,
    now: NOW,
    makePublicClient,
    reconstructSessionClientFn,
    ...overrides,
  });
  return {
    approved,
    record,
    config,
    permissionConfig,
    publicClient,
    kernelClient,
    makePublicClient,
    reconstructSessionClientFn,
    evaluate,
  };
}

describe('evaluateBaseMandateStatus', () => {
  it.each([
    ['NaN', Number.NaN],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['negative', -1],
    ['fractional', NOW + 0.5],
  ])('rejects %s evaluator time before RPC', async (_label, now) => {
    const h = makeHarness();

    const result = await h.evaluate({ now });

    expect(result).toMatchObject({ status: 'unknown', reasonCodes: ['TIME_MALFORMED'] });
    expect(h.makePublicClient).not.toHaveBeenCalled();
  });

  it('proves durable activation and a fresh installed permission without preparing a request', async () => {
    const h = makeHarness();

    const result = await h.evaluate();

    expect(result).toMatchObject({
      version: 3,
      status: 'active',
      expiresAt: VALID_UNTIL,
      reasonCodes: [],
      observed: {
        blockNumber: '1234',
        blockHash: BLOCK_HASH,
        blockTime: (NOW_SECONDS - 1) * 1000,
        implementation: IMPLEMENTATION,
        activation: {
          userOpHash: USER_OP_HASH,
          txHash: TX_HASH,
          activatedAt: NOW_SECONDS - 10,
        },
        permission: {
          permissionId: h.approved.permissionId,
          signer: ECDSA_SIGNER,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      checks: {
        chain: true,
        owner: true,
        kernel: true,
        session: true,
        permission: true,
        policy: true,
        binding: true,
        origin: true,
        implementation: true,
        freshness: true,
        reconstruction: true,
        activation: true,
      },
    });
    expect(h.publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'permissionConfig',
      args: [h.approved.permissionId],
      blockNumber: 1234n,
    }));
    expect(JSON.stringify(result)).not.toContain(SESSION_PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain(h.record.serializedApproval);
  });

  it.each([
    ['missing UserOperation hash', { activationUserOpHash: undefined }],
    ['malformed UserOperation hash', { activationUserOpHash: `0x${'AA'.repeat(32)}` }],
    ['missing transaction hash', { activationTxHash: undefined }],
    ['malformed transaction hash', { activationTxHash: '0x1234' }],
    ['missing activation timestamp', { activatedAt: undefined }],
    ['unsafe activation timestamp', { activatedAt: Number.MAX_SAFE_INTEGER + 1 }],
  ])('does not report active for %s but still reads current installation', async (_label, record) => {
    const h = makeHarness({ record });

    const result = await h.evaluate();

    expect(result.status).toBe('unknown');
    expect(result.reasonCodes).toContain('ACTIVATION_MISSING');
    expect(result.checks.activation).toBe(false);
    expect(result.observed.activation).toBeNull();
    expect(h.publicClient.readContract).toHaveBeenCalledOnce();
  });

  it.each([
    ['expiring', { validUntil: NOW_SECONDS + 2_699 }, 'EXPIRING'],
    ['expired', { validUntil: NOW_SECONDS - 1 }, 'EXPIRED'],
  ])('classifies timestamp boundary %s without preparation', async (status, approvalOptions, reason) => {
    const h = makeHarness({ approvalOptions });
    h.record.validUntilSeconds = h.approved.validUntil;
    h.record.bindingHash = sha256(`${OWNER}|${KERNEL}|${SESSION}|${h.approved.validUntil}`);

    const result = await h.evaluate();

    expect(result.status).toBe(status);
    expect(result.reasonCodes).toContain(reason);
  });

  it('rejects non-canonical delayed activation timestamps', async () => {
    const h = makeHarness({ approvalOptions: { validAfter: NOW_SECONDS + 10 } });
    const result = await h.evaluate();
    expect(result).toMatchObject({ status: 'mismatch', reasonCodes: ['POLICY_MISMATCH'] });
  });

  it('reports an on-chain uninstall as revoked', async () => {
    const h = makeHarness();
    h.permissionConfig.signer = zeroAddress;
    h.permissionConfig.policyData = [];

    const result = await h.evaluate();

    expect(result.status).toBe('revoked');
    expect(result.reasonCodes).toContain('PERMISSION_REVOKED');
  });

  it.each([
    ['owner', (h) => { h.record.stellarOwner = 'not-a-stellar-owner'; }, 'OWNER_MISMATCH'],
    ['kernel', (h) => { h.record.kernelAddress = `0x${'55'.repeat(20)}`; }, 'KERNEL_MISMATCH'],
    ['session', (h) => { h.record.sessionKeyAddress = `0x${'66'.repeat(20)}`; }, 'SESSION_MISMATCH'],
    ['origin', (h) => { h.record.relayerOrigin = 'https://evil.example'; }, 'ORIGIN_MISMATCH'],
    ['chain', (h) => { h.publicClient.getChainId.mockResolvedValue(8453); }, 'CHAIN_MISMATCH'],
    ['implementation', (h) => { h.publicClient.getStorageAt.mockResolvedValue(pad(`0x${'77'.repeat(20)}`, { size: 32 })); }, 'IMPLEMENTATION_MISMATCH'],
    ['non-canonical implementation slot', (h) => { h.publicClient.getStorageAt.mockResolvedValue(`0x01${'00'.repeat(11)}${IMPLEMENTATION.slice(2)}`); }, 'IMPLEMENTATION_MISMATCH'],
    ['Kernel version', (h) => { h.kernelClient.account.kernelVersion = '0.3.0'; }, 'KERNEL_VERSION_MISMATCH'],
    ['EntryPoint', (h) => { h.kernelClient.account.entryPoint.address = `0x${'88'.repeat(20)}`; }, 'ENTRY_POINT_MISMATCH'],
  ])('fails closed on %s mismatch', async (_label, mutate, reason) => {
    const h = makeHarness();
    mutate(h);

    const result = await h.evaluate();

    expect(result.status).toBe('mismatch');
    expect(result.reasonCodes).toContain(reason);
  });

  it.each([
    ['permissionId', 'PERMISSION_MISMATCH'],
    ['policyDigest', 'POLICY_MISMATCH'],
    ['relayerOrigin', 'ORIGIN_MISMATCH'],
    ['bindingId', 'BINDING_MISMATCH'],
    ['bindingHash', 'BINDING_MISMATCH'],
  ])('fails closed when durable %s identity is missing', async (field, reason) => {
    const h = makeHarness();
    delete h.record[field];

    const result = await h.evaluate();

    expect(result.status).toBe('mismatch');
    expect(result.reasonCodes).toContain(reason);
  });

  it('fails closed when the durable policy digest is altered', async () => {
    const h = makeHarness({ record: { policyDigest: 'd'.repeat(64) } });

    const result = await h.evaluate();

    expect(result.status).toBe('mismatch');
    expect(result.reasonCodes).toContain('POLICY_MISMATCH');
  });

  it('accepts a 12-second observation and rejects 13 seconds as stale', async () => {
    const boundary = makeHarness();
    boundary.publicClient.getBlock.mockResolvedValue({
      number: 1234n,
      hash: BLOCK_HASH,
      timestamp: BigInt(NOW_SECONDS - 12),
    });
    await expect(boundary.evaluate()).resolves.toMatchObject({ status: 'active' });

    const stale = makeHarness();
    stale.publicClient.getBlock.mockResolvedValue({
      number: 1234n,
      hash: BLOCK_HASH,
      timestamp: BigInt(NOW_SECONDS - 13),
    });
    await expect(stale.evaluate()).resolves.toMatchObject({
      status: 'unknown',
      reasonCodes: expect.arrayContaining(['BLOCK_STALE']),
    });
  });

  it.each([
    ['missing block number', { number: undefined }],
    ['numeric block number', { number: 1234 }],
    ['negative block number', { number: -1n }],
    ['malformed block hash', { hash: 'not-a-block-hash' }],
    ['uppercase block hash', { hash: `0x${'AB'.repeat(32)}` }],
    ['numeric block timestamp', { timestamp: NOW_SECONDS - 1 }],
    ['negative block timestamp', { timestamp: -1n }],
    ['unsafe block timestamp', { timestamp: BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) + 1n }],
  ])('rejects %s before anchored state reads', async (_label, blockOverride) => {
    const h = makeHarness();
    h.publicClient.getBlock.mockResolvedValue({
      number: 1234n,
      hash: BLOCK_HASH,
      timestamp: BigInt(NOW_SECONDS - 1),
      ...blockOverride,
    });

    const result = await h.evaluate();

    expect(result).toMatchObject({ status: 'unknown', reasonCodes: ['BLOCK_MALFORMED'] });
    expect(h.publicClient.getStorageAt).not.toHaveBeenCalled();
    expect(h.publicClient.readContract).not.toHaveBeenCalled();
  });

  it('maps RPC and unexpected failures to secret-free unknown evidence', async () => {
    const rpc = makeHarness();
    rpc.publicClient.getBlock.mockRejectedValue(new Error('RPC secret https://private.example'));
    const rpcResult = await rpc.evaluate();
    expect(rpcResult).toMatchObject({ status: 'unknown', reasonCodes: ['RPC_ERROR'] });
    expect(JSON.stringify(rpcResult)).not.toContain('private.example');

    const unexpected = makeHarness();
    Object.defineProperty(unexpected.record, 'stellarOwner', {
      configurable: true,
      get() { throw new Error('unexpected internal secret'); },
    });
    const unexpectedResult = await unexpected.evaluate();
    expect(unexpectedResult).toMatchObject({
      version: 3,
      status: 'unknown',
      reasonCodes: ['EVALUATOR_ERROR'],
    });
    expect(JSON.stringify(unexpectedResult)).not.toContain('internal secret');
  });
});
