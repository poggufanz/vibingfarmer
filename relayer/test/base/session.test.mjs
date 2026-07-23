import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { toCallPolicy, toTimestampPolicy, CallPolicyVersion, ParamCondition } from '@zerodev/permissions/policies';
import { buildFarmPermissions } from '../../../frontend/src/base/policyEngine.js';
import { APPROVE_ABI, YIELD_ROUTER_ABI } from '../../src/base/orchestrator.mjs';

vi.mock('@zerodev/permissions', () => ({
  deserializePermissionAccount: vi.fn().mockResolvedValue({ address: '0xAccount', encodeCalls: vi.fn() }),
}));
vi.mock('@zerodev/permissions/signers', () => ({
  toECDSASigner: vi.fn().mockResolvedValue({ account: { address: '0xSessionKey' } }),
}));
vi.mock('@zerodev/sdk', () => ({
  createKernelAccountClient: vi.fn((args) => ({ ...args, account: args.account })),
  createZeroDevPaymasterClient: vi.fn(() => ({ sponsorUserOperation: vi.fn() })),
}));
vi.mock('@zerodev/sdk/constants', () => ({
  getEntryPoint: () => '0.7',
  KERNEL_V3_1: 'kernel-v3.1',
}));

const {
  reconstructSessionClient, decodeApproval, validateApprovalPolicy, validateMandateBinding,
  isStellarStrKey, deriveSessionAddress, MAX_CALL_CAP_UNITS,
} = await import('../../src/base/session.mjs');
const { deserializePermissionAccount } = await import('@zerodev/permissions');
const { createKernelAccountClient } = await import('@zerodev/sdk');

describe('reconstructSessionClient', () => {
  it('reconstructs the approved account using the session private key, then builds a kernel client bound to it', async () => {
    const chain = { id: 84532, name: 'baseSepolia' };
    const client = await reconstructSessionClient({
      chain,
      rpcUrl: 'https://sepolia.base.org',
      bundlerRpcUrl: 'https://rpc.zerodev.app/api/v3/proj/chain/84532',
      approval: 'serialized-approval-blob',
      // Valid 32-byte secp256k1 key: toECDSASigner is mocked so the derived account is ignored,
      // but the real viem privateKeyToAccount runs first and rejects a non-hex placeholder.
      sessionPrivateKey: `0x${'11'.repeat(32)}`,
    });

    expect(deserializePermissionAccount).toHaveBeenCalledWith(
      expect.anything(), '0.7', 'kernel-v3.1', 'serialized-approval-blob',
      expect.objectContaining({ account: expect.objectContaining({ address: '0xSessionKey' }) }),
    );
    expect(createKernelAccountClient).toHaveBeenCalledWith(
      expect.objectContaining({ account: expect.objectContaining({ address: '0xAccount' }), chain }),
    );
    expect(client.account.address).toBe('0xAccount');
  });
});

// VF Wallet Task 7 — Step 2 policy regression cases. Real buildFarmPermissions/toCallPolicy/
// toTimestampPolicy (not hand-rolled fakes) build the fixture, so this exercises the exact wire
// shape serializePermissionAccount produces in production, base64-encoded the same way
// @zerodev/permissions/utils.js's serializePermissionAccountParams does.
const YIELD_ROUTER_ADDRESS = `0x${'a1'.repeat(20)}`;
const USDC_ADDRESS = `0x${'b2'.repeat(20)}`;
const KERNEL_ADDRESS = `0x${'c3'.repeat(20)}`;
const OTHER_KERNEL_ADDRESS = `0x${'d4'.repeat(20)}`;
const POOL_ADDRESS = `0x${'e5'.repeat(20)}`;
const STELLAR_OWNER = `G${'A'.repeat(55)}`;
const SESSION_PRIVATE_KEY = `0x${'22'.repeat(32)}`;
const SESSION_KEY_ADDRESS = privateKeyToAccount(SESSION_PRIVATE_KEY).address;

function serializeParams(params) {
  const replacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
  return Buffer.from(JSON.stringify(params, replacer), 'utf8').toString('base64');
}

function buildFakeApproval({
  accountAddress = KERNEL_ADDRESS,
  cap = MAX_CALL_CAP_UNITS,
  expiry = Math.floor(Date.now() / 1000) + 3600,
} = {}) {
  const permissions = buildFarmPermissions({
    pools: [{ pool: POOL_ADDRESS, cap }],
    yieldRouterAbi: YIELD_ROUTER_ABI,
    usdcAbi: APPROVE_ABI,
    yieldRouterAddress: YIELD_ROUTER_ADDRESS,
    usdcAddress: USDC_ADDRESS,
  });
  const callPolicy = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions });
  const timestampPolicy = toTimestampPolicy({ validAfter: 0, validUntil: expiry });
  return serializeParams({
    accountParams: { accountAddress, initCode: '0x' },
    permissionParams: { policies: [callPolicy, timestampPolicy] },
  });
}

describe('decodeApproval', () => {
  it('decodes the real serializePermissionAccount wire shape with no RPC client involved', () => {
    const decoded = decodeApproval(buildFakeApproval());
    expect(decoded.accountAddress).toBe(KERNEL_ADDRESS);
    expect(decoded.permissions.map((p) => p.functionName)).toEqual(['approve', 'deposit']);
    expect(decoded.validUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('throws on a malformed blob', () => {
    expect(() => decodeApproval('not-a-real-approval')).toThrow(/malformed/i);
  });

  it('throws when the account address is missing', () => {
    const blob = Buffer.from(JSON.stringify({ permissionParams: { policies: [] } })).toString('base64');
    expect(() => decodeApproval(blob)).toThrow(/malformed/i);
  });
});

describe('isStellarStrKey', () => {
  it('accepts a valid G or C address', () => {
    expect(isStellarStrKey(STELLAR_OWNER)).toBe(true);
    expect(isStellarStrKey(`C${'A'.repeat(55)}`)).toBe(true);
  });

  it('rejects non-Stellar / malformed values', () => {
    expect(isStellarStrKey('0xnotstellar')).toBe(false);
    expect(isStellarStrKey('')).toBe(false);
    expect(isStellarStrKey(null)).toBe(false);
    expect(isStellarStrKey(undefined)).toBe(false);
    expect(isStellarStrKey(STELLAR_OWNER.slice(0, -1))).toBe(false); // one char short
  });
});

describe('deriveSessionAddress', () => {
  it('derives the same address viem privateKeyToAccount would', () => {
    expect(deriveSessionAddress(SESSION_PRIVATE_KEY)).toBe(SESSION_KEY_ADDRESS);
  });
});

describe('validateApprovalPolicy', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;

  function approvePerm(cap) {
    return {
      target: USDC_ADDRESS, valueLimit: 0n, functionName: 'approve',
      args: [{ condition: ParamCondition.EQUAL, value: YIELD_ROUTER_ADDRESS }, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap }],
    };
  }
  function depositPerm(cap) {
    return {
      target: YIELD_ROUTER_ADDRESS, valueLimit: 0n, functionName: 'deposit',
      args: [null, { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: cap }, null],
    };
  }
  const base = { usdcAddress: USDC_ADDRESS, yieldRouterAddress: YIELD_ROUTER_ADDRESS, validUntil: future };

  it('accepts the exact approve+deposit shape at the 10,000 USDC per-call cap', () => {
    expect(validateApprovalPolicy({ ...base, permissions: [approvePerm(MAX_CALL_CAP_UNITS), depositPerm(MAX_CALL_CAP_UNITS)] }))
      .toEqual({ ok: true });
  });

  it('the cap is per-call and non-cumulative: repeat calls at the cap are each independently accepted (nothing sums across calls)', () => {
    const permissions = [approvePerm(MAX_CALL_CAP_UNITS), depositPerm(MAX_CALL_CAP_UNITS)];
    expect(validateApprovalPolicy({ ...base, permissions }).ok).toBe(true);
    expect(validateApprovalPolicy({ ...base, permissions }).ok).toBe(true);
    expect(validateApprovalPolicy({ ...base, permissions }).ok).toBe(true);
  });

  it('rejects a policy whose cap exceeds 10,000 USDC by even one unit', () => {
    const overCap = MAX_CALL_CAP_UNITS + 1n;
    expect(validateApprovalPolicy({ ...base, permissions: [approvePerm(overCap), depositPerm(overCap)] }).ok).toBe(false);
  });

  it('rejects a policy that includes a withdraw permission', () => {
    const result = validateApprovalPolicy({
      ...base,
      permissions: [
        approvePerm(MAX_CALL_CAP_UNITS), depositPerm(MAX_CALL_CAP_UNITS),
        { target: YIELD_ROUTER_ADDRESS, valueLimit: 0n, functionName: 'withdraw', args: [] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/withdraw/i);
  });

  it('rejects a policy targeting a nonallowlisted contract/function', () => {
    const result = validateApprovalPolicy({
      ...base,
      permissions: [{ target: `0x${'ff'.repeat(20)}`, valueLimit: 0n, functionName: 'transfer', args: [] }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/nonallowlisted/i);
  });

  it('rejects an expired approval (validUntil in the past)', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(validateApprovalPolicy({
      ...base, validUntil: past, permissions: [approvePerm(MAX_CALL_CAP_UNITS), depositPerm(MAX_CALL_CAP_UNITS)],
    })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a permission with no cap constraint at all (fail closed, not open-ended)', () => {
    const result = validateApprovalPolicy({
      ...base,
      permissions: [{ target: USDC_ADDRESS, valueLimit: 0n, functionName: 'approve', args: [{ condition: ParamCondition.EQUAL, value: YIELD_ROUTER_ADDRESS }] }],
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateMandateBinding', () => {
  const nowSeconds = Math.floor(Date.now() / 1000);

  function validParams(over = {}) {
    return {
      serializedApproval: buildFakeApproval({ accountAddress: KERNEL_ADDRESS }),
      sessionPrivateKey: SESSION_PRIVATE_KEY,
      sessionKeyAddress: SESSION_KEY_ADDRESS,
      stellarOwner: STELLAR_OWNER,
      kernelAddress: KERNEL_ADDRESS,
      usdcAddress: USDC_ADDRESS,
      yieldRouterAddress: YIELD_ROUTER_ADDRESS,
      now: nowSeconds,
      ...over,
    };
  }

  it('accepts a well-formed, exactly-bound approval', () => {
    expect(validateMandateBinding(validParams())).toEqual({ ok: true, derivedSessionAddress: SESSION_KEY_ADDRESS });
  });

  it('rejects when sessionKeyAddress does not match the address derived from sessionPrivateKey', () => {
    expect(validateMandateBinding(validParams({ sessionKeyAddress: `0x${'99'.repeat(20)}` })).ok).toBe(false);
  });

  it('rejects an unparseable sessionPrivateKey', () => {
    expect(validateMandateBinding(validParams({ sessionPrivateKey: 'not-a-key' })).ok).toBe(false);
  });

  // A second kernel cannot execute owner A's approval: the approval's accountParams.accountAddress
  // is fixed at mandate-creation time (cryptographically what the ZeroDev policy was enabled for),
  // so a request claiming a different kernelAddress is rejected here regardless of what it sends.
  // (The companion "owner B cannot reach owner A's binding" half of Step 5's acceptance criterion
  // is enforced by the store's composite key, not here — nothing in the approval blob itself
  // encodes a Stellar owner; see mandateStore.test.mjs/sqliteStores.test.mjs and baseBinding.js's
  // module doc for that boundary.)
  it('rejects when kernelAddress does not match the approval\'s own account address', () => {
    expect(validateMandateBinding(validParams({ kernelAddress: OTHER_KERNEL_ADDRESS })).ok).toBe(false);
  });

  it('rejects a non-Stellar stellarOwner', () => {
    expect(validateMandateBinding(validParams({ stellarOwner: 'not-a-stellar-address' })).ok).toBe(false);
  });

  it('rejects a malformed kernelAddress', () => {
    expect(validateMandateBinding(validParams({ kernelAddress: 'not-an-address' })).ok).toBe(false);
  });

  it('rejects when the approval\'s own embedded policy has expired', () => {
    const approval = buildFakeApproval({ accountAddress: KERNEL_ADDRESS, expiry: nowSeconds - 10 });
    expect(validateMandateBinding(validParams({ serializedApproval: approval })).ok).toBe(false);
  });

  it('rejects when the approval\'s policy cap exceeds 10,000 USDC', () => {
    const approval = buildFakeApproval({ accountAddress: KERNEL_ADDRESS, cap: MAX_CALL_CAP_UNITS + 1n });
    expect(validateMandateBinding(validParams({ serializedApproval: approval })).ok).toBe(false);
  });
});
