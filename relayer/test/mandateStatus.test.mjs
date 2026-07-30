import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  concatHex,
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  pad,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { toCallPolicy, toTimestampPolicy, CallPolicyVersion } from '@zerodev/permissions/policies';
import { buildFarmPermissions } from '../../frontend/src/base/policyEngine.js';
import { APPROVE_ABI, YIELD_ROUTER_ABI } from '../src/base/orchestrator.mjs';
import { evaluateBaseMandateStatus } from '../src/mandateStatus.mjs';
import { loadDeploymentFacts } from '../src/deploymentFacts.mjs';

const NOW = 2_000_000_000_000;
const NOW_SECONDS = NOW / 1000;
const OWNER = `G${'A'.repeat(55)}`;
const KERNEL = `0x${'11'.repeat(20)}`;
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SESSION = privateKeyToAccount(SESSION_PRIVATE_KEY).address;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ROUTER = '0xF80aa8F571E6d24Ea72F051Fc6F9A9C516727B6d';
const POOL = '0x389250872044368759D3db5C09b2706A6628d4e0';
const IMPLEMENTATION = '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D';
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const CALL_POLICY = '0x9a52283276A0ec8740DF50bF01B28A80D880eaf2';
const TIMESTAMP_POLICY = '0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F';
const ECDSA_SIGNER = '0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF';
const PERMISSION_ID = '0x12345678';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function serialize(value) {
  return Buffer.from(JSON.stringify(value, (_, child) => (
    typeof child === 'bigint' ? child.toString() : child
  )), 'utf8').toString('base64');
}

function approval({
  accountAddress = KERNEL,
  validAfter = 0,
  validUntil = NOW_SECONDS + 7_200,
  permissionId = PERMISSION_ID,
  mutatePermissions = (permissions) => permissions,
} = {}) {
  const permissions = buildFarmPermissions({
    pools: [{ pool: POOL, cap: 5_000_000n }],
    yieldRouterAbi: YIELD_ROUTER_ABI,
    usdcAbi: APPROVE_ABI,
    yieldRouterAddress: ROUTER,
    usdcAddress: USDC,
  });
  const call = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions });
  const timestamp = toTimestampPolicy({ validAfter, validUntil });
  const callPolicyParams = {
    ...call.policyParams,
    permissions: mutatePermissions(call.policyParams.permissions),
  };
  return {
    serializedApproval: serialize({
      accountParams: { accountAddress, initCode: '0x' },
      permissionParams: {
        permissionId,
        policies: [{ policyParams: callPolicyParams }, { policyParams: timestamp.policyParams }],
      },
    }),
    policyData: [call.getPolicyInfoInBytes(), timestamp.getPolicyInfoInBytes()],
    validUntil,
  };
}

function bindingHash({
  stellarOwner = OWNER,
  kernelAddress = KERNEL,
  sessionKeyAddress = SESSION,
  expiresAt,
}) {
  return sha256(`${stellarOwner}|${kernelAddress}|${sessionKeyAddress}|${expiresAt / 1000}`);
}

function makeHarness({ approvalOptions, record: recordOverrides, allocation: allocationOverrides } = {}) {
  const approved = approval(approvalOptions);
  const expiresAt = approved.validUntil * 1000;
  const record = {
    serializedApproval: approved.serializedApproval,
    sessionPrivateKey: SESSION_PRIVATE_KEY,
    sessionKeyAddress: SESSION,
    stellarOwner: OWNER,
    kernelAddress: KERNEL,
    relayerOrigin: 'https://relayer.example',
    expiresAt,
    status: 'active',
    bindingId: 'binding-1',
    bindingHash: bindingHash({ expiresAt }),
    createdAt: NOW - 1_000,
    ...recordOverrides,
  };
  const config = {
    publicOrigin: 'https://relayer.example',
    digests: { baseMandatePolicy: 'c'.repeat(64) },
    base: {
      chain: { id: 84532 },
      rpcUrl: 'https://base.example',
      bundlerRpcUrl: 'https://bundler.example',
      usdcAddress: USDC,
      yieldRouterAddress: ROUTER,
      allowedPools: [POOL],
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
    permissionFlag: '0x0001',
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
  const encodeCalls = vi.fn(async () => '0xfeed');
  const prepareUserOperation = vi.fn(async ({ callData }) => ({
    sender: KERNEL,
    nonce: 9n,
    callData,
    signature: '0x',
  }));
  const sendUserOperation = vi.fn();
  const kernelClient = {
    account: {
      address: KERNEL,
      encodeCalls,
      kernelPluginManager: { getIdentifier: vi.fn(() => PERMISSION_ID) },
    },
    prepareUserOperation,
    sendUserOperation,
  };
  const allocation = {
    allocationId: 'run-42:bridge:aave-v3',
    poolAddress: POOL,
    amount: { token: 'USDC', units: '1000000', decimals: 6 },
    minShares: '980000',
    ...allocationOverrides,
  };
  const makePublicClient = vi.fn(() => publicClient);
  const reconstructSessionClientFn = vi.fn(async () => kernelClient);
  const evaluate = (overrides = {}) => evaluateBaseMandateStatus({
    record,
    config,
    allocation,
    now: NOW,
    makePublicClient,
    reconstructSessionClientFn,
    ...overrides,
  });
  return {
    approved,
    record,
    config,
    allocation,
    permissionConfig,
    publicClient,
    kernelClient,
    encodeCalls,
    prepareUserOperation,
    sendUserOperation,
    makePublicClient,
    reconstructSessionClientFn,
    evaluate,
  };
}

describe('evaluateBaseMandateStatus', () => {
  it('proves the installed permission and prepares the exact approve+deposit operation without sending', async () => {
    const h = makeHarness();

    const result = await h.evaluate();

    expect(result.status).toBe('active');
    expect(result.reasonCodes).toEqual([]);
    expect(result.expected).toMatchObject({
      chainId: 84532,
      relayerOrigin: 'https://relayer.example',
      kernelImplementation: IMPLEMENTATION,
      entryPointAddress: ENTRY_POINT,
      owner: OWNER,
      kernelAddress: KERNEL,
      sessionKeyAddress: SESSION,
      permissionId: PERMISSION_ID,
      bindingId: 'binding-1',
      bindingHash: h.record.bindingHash,
      expiresAt: h.record.expiresAt,
    });
    expect(result.observed).toMatchObject({
      blockNumber: '1234',
      blockHash: BLOCK_HASH,
      blockTime: (NOW_SECONDS - 1) * 1000,
      implementation: IMPLEMENTATION,
      preparedCallDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      permission: {
        permissionId: PERMISSION_ID,
        signer: ECDSA_SIGNER,
        policyData: h.approved.policyData,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(Object.values(result.checks).every((value) => value === true)).toBe(true);

    const calls = h.encodeCalls.mock.calls[0][0];
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => ({ to: call.to, value: call.value }))).toEqual([
      { to: USDC, value: 0n },
      { to: ROUTER, value: 0n },
    ]);
    expect(decodeFunctionData({ abi: APPROVE_ABI, data: calls[0].data })).toMatchObject({
      functionName: 'approve',
      args: [ROUTER, 1_000_000n],
    });
    expect(decodeFunctionData({ abi: YIELD_ROUTER_ABI, data: calls[1].data })).toMatchObject({
      functionName: 'deposit',
      args: [POOL, 1_000_000n, 980_000n],
    });
    expect(h.prepareUserOperation).toHaveBeenCalledWith({ callData: '0xfeed' });
    expect(h.sendUserOperation).not.toHaveBeenCalled();
    const exposed = JSON.stringify(result);
    expect(exposed).not.toContain(SESSION_PRIVATE_KEY);
    expect(exposed).not.toContain(h.record.serializedApproval);
  });

  it.each([
    ['not_yet_valid', { approvalOptions: { validAfter: NOW_SECONDS + 10 } }, 'NOT_YET_VALID'],
    ['expiring', { approvalOptions: { validUntil: NOW_SECONDS + 2_699 } }, 'EXPIRING'],
    ['expired', { approvalOptions: { validUntil: NOW_SECONDS - 1 } }, 'EXPIRED'],
  ])('classifies timestamp boundary %s before any preparation', async (status, options, reason) => {
    const h = makeHarness(options);
    const result = await h.evaluate();

    expect(result.status).toBe(status);
    expect(result.reasonCodes).toContain(reason);
    expect(h.prepareUserOperation).not.toHaveBeenCalled();
    expect(h.sendUserOperation).not.toHaveBeenCalled();
  });

  it('reports an on-chain uninstall/revoke and never treats preparation or a no-op as evidence', async () => {
    const h = makeHarness();
    h.permissionConfig.signer = zeroAddress;
    h.permissionConfig.policyData = [];

    const result = await h.evaluate();

    expect(result.status).toBe('revoked');
    expect(result.reasonCodes).toContain('PERMISSION_REVOKED');
    expect(h.reconstructSessionClientFn).not.toHaveBeenCalled();
    expect(h.prepareUserOperation).not.toHaveBeenCalled();
    expect(h.sendUserOperation).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', (h) => { h.record.stellarOwner = 'not-a-stellar-owner'; }, 'OWNER_MISMATCH'],
    ['kernel', (h) => { h.record.kernelAddress = `0x${'33'.repeat(20)}`; }, 'KERNEL_MISMATCH'],
    ['session', (h) => { h.record.sessionKeyAddress = `0x${'44'.repeat(20)}`; }, 'SESSION_MISMATCH'],
    ['binding', (h) => { h.record.bindingHash = 'forged-binding'; }, 'BINDING_MISMATCH'],
    ['origin', (h) => { h.record.relayerOrigin = 'https://other.example'; }, 'ORIGIN_MISMATCH'],
    ['chain', (h) => { h.publicClient.getChainId.mockResolvedValue(8453); }, 'CHAIN_MISMATCH'],
    ['implementation', (h) => { h.publicClient.getStorageAt.mockResolvedValue(pad(`0x${'55'.repeat(20)}`, { size: 32 })); }, 'IMPLEMENTATION_MISMATCH'],
    ['permission', (h) => { h.permissionConfig.signer = `0x${'66'.repeat(20)}`; }, 'PERMISSION_MISMATCH'],
    ['policy', (h) => { h.permissionConfig.policyData = [concatHex(['0x0001', `0x${'77'.repeat(20)}`])]; }, 'POLICY_MISMATCH'],
  ])('fails closed on %s mismatch', async (_label, mutate, reason) => {
    const h = makeHarness();
    mutate(h);

    const result = await h.evaluate();

    expect(result.status).toBe('mismatch');
    expect(result.reasonCodes).toContain(reason);
    expect(h.sendUserOperation).not.toHaveBeenCalled();
  });

  it.each([
    ['wildcard target', (permissions) => [{ ...permissions[0], target: zeroAddress }, permissions[1]]],
    ['wildcard selector', (permissions) => [{ ...permissions[0], selector: '0x00000000' }, permissions[1]]],
    ['broader extra call', (permissions) => [...permissions, { ...permissions[1], target: POOL }]],
    ['approve recipient', (permissions) => [{ ...permissions[0], args: [null, permissions[0].args[1]] }, permissions[1]]],
    ['approve amount', (permissions) => [{ ...permissions[0], args: [permissions[0].args[0], null] }, permissions[1]]],
    ['deposit amount', (permissions) => [permissions[0], { ...permissions[1], args: [null, null, null] }]],
    ['native value', (permissions) => [{ ...permissions[0], valueLimit: 1n }, permissions[1]]],
    ['call type', (permissions) => [{ ...permissions[0], callType: 1 }, permissions[1]]],
  ])('rejects a %s policy before RPC or preparation', async (_label, mutatePermissions) => {
    const h = makeHarness({ approvalOptions: { mutatePermissions } });

    const result = await h.evaluate();

    expect(result.status).toBe('mismatch');
    expect(result.reasonCodes).toContain('POLICY_MISMATCH');
    expect(h.makePublicClient).not.toHaveBeenCalled();
    expect(h.sendUserOperation).not.toHaveBeenCalled();
  });

  it.each([
    ['target', { target: `0x${'88'.repeat(20)}` }],
    ['selector', { selector: '0xffffffff' }],
    ['recipient', { recipient: `0x${'99'.repeat(20)}` }],
    ['asset', { amount: { token: 'DAI', units: '1000000', decimals: 6 } }],
    ['amount', { amount: { token: 'USDC', units: '-1', decimals: 6 } }],
    ['value', { value: '1' }],
    ['call type', { callType: 'delegatecall' }],
    ['paymaster', { paymaster: `0x${'aa'.repeat(20)}` }],
  ])('rejects request-side %s mutation rather than preparing it', async (_label, allocation) => {
    const h = makeHarness({ allocation });

    const result = await h.evaluate();

    expect(result.status).toBe('mismatch');
    expect(result.reasonCodes).toContain('ALLOCATION_MISMATCH');
    expect(h.prepareUserOperation).not.toHaveBeenCalled();
    expect(h.sendUserOperation).not.toHaveBeenCalled();
  });

  it('maps malformed approval, stale block, RPC timeout, and prepare failure to safe non-active states', async () => {
    const malformed = makeHarness({ record: { serializedApproval: 'not-base64-json' } });
    const malformedResult = await malformed.evaluate();
    expect(malformedResult.status).toBe('mismatch');
    expect(malformedResult.reasonCodes).toContain('APPROVAL_MALFORMED');

    const stale = makeHarness();
    stale.publicClient.getBlock.mockResolvedValue({
      number: 1234n,
      hash: BLOCK_HASH,
      timestamp: BigInt(NOW_SECONDS - 2_701),
    });
    const staleResult = await stale.evaluate();
    expect(staleResult.status).toBe('unknown');
    expect(staleResult.reasonCodes).toContain('BLOCK_STALE');

    const rpc = makeHarness();
    rpc.publicClient.getBlock.mockRejectedValue(new Error('RPC timeout at https://secret-rpc'));
    const rpcResult = await rpc.evaluate();
    expect(rpcResult.status).toBe('unknown');
    expect(rpcResult.reasonCodes).toContain('RPC_ERROR');
    expect(JSON.stringify(rpcResult)).not.toContain('secret-rpc');

    const prepare = makeHarness();
    prepare.prepareUserOperation.mockRejectedValue(new Error('bundler secret failure'));
    const prepareResult = await prepare.evaluate();
    expect(prepareResult.status).toBe('unknown');
    expect(prepareResult.reasonCodes).toContain('PREPARE_FAILED');
    expect(JSON.stringify(prepareResult)).not.toContain('bundler secret failure');

    for (const h of [malformed, stale, rpc, prepare]) {
      expect(h.sendUserOperation).not.toHaveBeenCalled();
    }
  });

  it('ignores client-forged global and user expected facts', async () => {
    const h = makeHarness();
    h.allocation.expected = {
      chainId: 1,
      owner: 'GFORGED',
      kernelAddress: zeroAddress,
      policyDigest: 'forged',
      relayerOrigin: 'https://evil.example',
    };

    const result = await h.evaluate();

    expect(result.status).toBe('mismatch');
    expect(result.expected).toMatchObject({
      chainId: 84532,
      owner: OWNER,
      kernelAddress: KERNEL,
      relayerOrigin: 'https://relayer.example',
    });
    expect(result.reasonCodes).toContain('ALLOCATION_MISMATCH');
  });

  it.skipIf(!process.env.VF_BASE_SEPOLIA_MANDATE_SMOKE)(
    'read-only Base Sepolia smoke prepares the exact calls without submitting or consuming a nonce',
    async () => {
      const needSmoke = (name) => {
        const value = process.env[name];
        if (!value) throw new Error(`live smoke requires ${name}`);
        return value;
      };
      const rpcUrl = needSmoke('VF_BASE_SEPOLIA_RPC_URL');
      const bundlerRpcUrl = needSmoke('VF_BASE_SEPOLIA_BUNDLER_RPC_URL');
      const record = JSON.parse(needSmoke('VF_BASE_SEPOLIA_MANDATE_RECORD'));
      const allocation = JSON.parse(needSmoke('VF_BASE_SEPOLIA_MANDATE_ALLOCATION'));
      const publicOrigin = needSmoke('VF_BASE_SEPOLIA_RELAYER_ORIGIN');
      const facts = loadDeploymentFacts();
      const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
      const config = {
        publicOrigin,
        digests: facts.digests,
        base: {
          chain: baseSepolia,
          rpcUrl,
          bundlerRpcUrl,
          publicClient,
          usdcAddress: facts.base.usdcAddress,
          yieldRouterAddress: facts.base.yieldRouterAddress,
          allowedPools: facts.base.allowedPools,
          mandatePolicy: facts.base.mandatePolicy,
        },
      };
      const nonceAbi = [{
        type: 'function', name: 'getNonce', stateMutability: 'view',
        inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'uint192' }],
        outputs: [{ name: 'nonce', type: 'uint256' }],
      }];
      const readNonce = () => publicClient.readContract({
        address: facts.base.mandatePolicy.entryPointAddress,
        abi: nonceAbi,
        functionName: 'getNonce',
        args: [record.kernelAddress, 0n],
      });

      const nonceBefore = await readNonce();
      const result = await evaluateBaseMandateStatus({ record, config, allocation });
      const nonceAfter = await readNonce();

      expect(result.status).toBe('active');
      expect(result.observed.preparedCallDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(nonceAfter).toBe(nonceBefore);
    },
  );
});
