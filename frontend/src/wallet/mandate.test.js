// frontend/src/wallet/mandate.test.js
import { describe, test, expect, vi } from 'vitest'
import { createMandate } from './mandate.js'
import { evaluateCall } from '../base/policyEngine.js'
import { ERC20_ABI, YIELD_ROUTER_ABI, YIELD_ROUTER_ADDRESS } from '../base/config.js'
import { ParamCondition } from '@zerodev/permissions/policies'
import { decodeAbiParameters, pad, toFunctionSelector, toHex } from 'viem'

const POOL_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const POOL_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const ATTACKER = '0xDEADDEADDEADDEADDEADDEADDEADDEADDEADDEAD'

function makeDeps({ sessionKeyAddress = '0xSESSIONKEY000000000000000000000000000001' } = {}) {
  const fakePermissionValidator = { address: '0xpermvalidator' }
  const fakeOwnerSideAccount = { address: '0xOWNERSIDEACCOUNT00000000000000000000001' }
  let capturedPermissions = null
  let capturedTimestampPolicy = null
  let capturedPolicies = null
  return {
    deps: {
      genSessionKey: vi.fn(() => '0xSESSIONPRIVKEY'),
      keyToAccount: vi.fn(() => ({ address: sessionKeyAddress })),
      makeECDSASigner: vi.fn(async ({ signer }) => ({ account: signer })),
      makeCallPolicy: vi.fn(({ permissions }) => {
        capturedPermissions = permissions
        return { kind: 'callPolicy', permissions }
      }),
      makeTimestampPolicy: vi.fn((args) => {
        capturedTimestampPolicy = args
        return { kind: 'timestampPolicy', ...args }
      }),
      makePermissionValidator: vi.fn(async (_client, args) => {
        expect(args.policies).toHaveLength(2) // callPolicy + timestampPolicy
        capturedPolicies = args.policies
        return fakePermissionValidator
      }),
      makeKernelAccount: vi.fn(async (_client, args) => {
        expect(args.plugins.regular).toBe(fakePermissionValidator)
        return fakeOwnerSideAccount
      }),
      serialize: vi.fn(async () => 'serialized-approval-blob'),
      emptyAccount: vi.fn((address) => ({ address, empty: true })),
    },
    getCapturedPermissions: () => capturedPermissions,
    getCapturedTimestampPolicy: () => capturedTimestampPolicy,
    getCapturedPolicies: () => capturedPolicies,
  }
}

const CALL_PERMISSION_ABI = [
  {
    type: 'tuple[]',
    components: [
      { name: 'callType', type: 'bytes1' },
      { name: 'target', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      { name: 'valueLimit', type: 'uint256' },
      {
        name: 'rules',
        type: 'tuple[]',
        components: [
          { name: 'condition', type: 'uint8' },
          { name: 'offset', type: 'uint64' },
          { name: 'params', type: 'bytes32[]' },
        ],
      },
    ],
  },
]

describe('createMandate', () => {
  test('approves the session key by address only - never touches the session private key on the owner side', async () => {
    const { deps } = makeDeps()
    const expiry = Math.floor(Date.now() / 1000) + 3600
    const fakeKernelAccount = { address: '0xowner' }
    const fakePasskeyValidator = { address: '0xpasskeyvalidator' }

    await createMandate({
      kernelAccount: fakeKernelAccount,
      publicClient: {},
      passkeyValidator: fakePasskeyValidator,
      pools: [{ pool: POOL_A, cap: 100_000_000n }],
      expiry,
      deps,
    })

    expect(deps.emptyAccount).toHaveBeenCalledWith('0xSESSIONKEY000000000000000000000000000001')
    // The owner-side ECDSA signer wraps the EMPTY account, not a real signer with the private key.
    const ecdsaCallArgs = deps.makeECDSASigner.mock.calls[0][0]
    expect(ecdsaCallArgs.signer.empty).toBe(true)
  })

  test('returns a serialized approval + the session key address + the expiry', async () => {
    const { deps } = makeDeps({ sessionKeyAddress: '0xSESSIONKEY000000000000000000000000000099' })
    const expiry = Math.floor(Date.now() / 1000) + 7200

    const result = await createMandate({
      kernelAccount: { address: '0xowner' },
      publicClient: {},
      passkeyValidator: { address: '0xpasskeyvalidator' },
      pools: [{ pool: POOL_A, cap: 100_000_000n }],
      expiry,
      deps,
    })

    expect(result.serializedApproval).toBe('serialized-approval-blob')
    expect(result.sessionKeyAddress).toBe('0xSESSIONKEY000000000000000000000000000099')
    expect(result.expiry).toBe(expiry)
    expect(result.permissions).toHaveLength(2)
    expect(result.permissions[0]).toMatchObject({
      target: USDC_ADDRESS,
      valueLimit: 0n,
      abi: ERC20_ABI,
      functionName: 'approve',
    })
    expect(result.permissions[1]).toMatchObject({
      target: YIELD_ROUTER_ADDRESS,
      valueLimit: 0n,
      functionName: 'deposit',
    })
  })

  test('installs SDK-encoded call and timestamp policies with exact targets, selectors, rules, value limits, and expiry', async () => {
    const harness = makeDeps()
    // Exercise the real ZeroDev policy builders while keeping all wallet/network operations mocked.
    delete harness.deps.makeCallPolicy
    delete harness.deps.makeTimestampPolicy
    const expiry = Math.floor(Date.now() / 1000) + 3600
    const cap = 100_000_000n

    await createMandate({
      kernelAccount: { address: '0xowner' },
      publicClient: {},
      passkeyValidator: { address: '0xpasskeyvalidator' },
      pools: [{ pool: POOL_A, cap }],
      expiry,
      deps: harness.deps,
    })

    const [callPolicy, timestampPolicy] = harness.getCapturedPolicies()
    expect(callPolicy.policyParams.type).toBe('call')
    expect(timestampPolicy.policyParams.type).toBe('timestamp')

    const [encodedPermissions] = decodeAbiParameters(
      CALL_PERMISSION_ABI,
      callPolicy.getPolicyData()
    )
    expect(encodedPermissions).toHaveLength(2)
    expect(encodedPermissions.map((permission) => permission.target.toLowerCase())).toEqual([
      USDC_ADDRESS.toLowerCase(),
      YIELD_ROUTER_ADDRESS.toLowerCase(),
    ])
    expect(encodedPermissions.map((permission) => permission.selector)).toEqual([
      toFunctionSelector(ERC20_ABI.find((item) => item.name === 'approve')),
      toFunctionSelector(YIELD_ROUTER_ABI.find((item) => item.name === 'deposit')),
    ])
    expect(encodedPermissions.map((permission) => permission.valueLimit)).toEqual([0n, 0n])
    expect(encodedPermissions[0].rules).toEqual([
      {
        condition: ParamCondition.EQUAL,
        offset: 0n,
        params: [pad(YIELD_ROUTER_ADDRESS, { size: 32 }).toLowerCase()],
      },
      {
        condition: ParamCondition.LESS_THAN_OR_EQUAL,
        offset: 32n,
        params: [toHex(cap, { size: 32 })],
      },
    ])
    expect(encodedPermissions[1].rules).toEqual([
      {
        condition: ParamCondition.LESS_THAN_OR_EQUAL,
        offset: 32n,
        params: [toHex(cap, { size: 32 })],
      },
    ])

    expect(
      decodeAbiParameters(
        [
          { type: 'uint48', name: 'validAfter' },
          { type: 'uint48', name: 'validUntil' },
        ],
        timestampPolicy.getPolicyData()
      )
    ).toEqual([0, expiry])
  })

  test('rejects a past-or-now expiry', async () => {
    const { deps } = makeDeps()
    await expect(
      createMandate({
        kernelAccount: { address: '0xowner' },
        publicClient: {},
        passkeyValidator: { address: '0xpv' },
        pools: [{ pool: POOL_A, cap: 1n }],
        expiry: Math.floor(Date.now() / 1000) - 1,
        deps,
      })
    ).rejects.toThrow(/expiry must be in the future/)
  })

  test('rejects an empty pool list', async () => {
    const { deps } = makeDeps()
    await expect(
      createMandate({
        kernelAccount: { address: '0xowner' },
        publicClient: {},
        passkeyValidator: { address: '0xpv' },
        pools: [],
        expiry: Math.floor(Date.now() / 1000) + 3600,
        deps,
      })
    ).rejects.toThrow(/at least one pool/)
  })

  test('the defensive local preflight mirrors every session-test.mjs scenario plus the new cap/expiry ones', async () => {
    const { deps, getCapturedPermissions } = makeDeps()
    const expiry = Math.floor(Date.now() / 1000) + 3600

    const { permissions } = await createMandate({
      kernelAccount: { address: '0xowner' },
      publicClient: {},
      passkeyValidator: { address: '0xpv' },
      pools: [
        { pool: POOL_A, cap: 100_000_000n },
        { pool: POOL_B, cap: 20_000_000n },
      ],
      expiry,
      deps,
    })

    expect(getCapturedPermissions()).toBe(permissions)

    // 1) exact relayer approval -> ALLOWED.
    expect(
      evaluateCall({
        permissions,
        to: USDC_ADDRESS,
        functionName: 'approve',
        args: [YIELD_ROUTER_ADDRESS, 10n],
        expiry,
      }).allowed
    ).toBe(true)

    // 2) approval to any other spender -> REJECTED.
    const wrongSpender = evaluateCall({
      permissions,
      to: USDC_ADDRESS,
      functionName: 'approve',
      args: [ATTACKER, 10n],
      expiry,
    })
    expect(wrongSpender.allowed).toBe(false)
    expect(wrongSpender.reason).toMatch(/EQUAL/)

    // 3) in-policy deposit on pool A within cap -> ALLOWED (mirrors session-test.mjs Test 1)
    expect(
      evaluateCall({
        permissions,
        to: YIELD_ROUTER_ADDRESS,
        functionName: 'deposit',
        args: [POOL_A, 10n, 1n],
        expiry,
      }).allowed
    ).toBe(true)

    // 4) wrong selector: sweep -> REJECTED (mirrors session-test.mjs Test 2)
    expect(
      evaluateCall({
        permissions,
        to: YIELD_ROUTER_ADDRESS,
        functionName: 'sweep',
        args: [ATTACKER],
        expiry,
      }).allowed
    ).toBe(false)

    // 5) wrong target -> REJECTED (mirrors session-test.mjs Test 3)
    expect(
      evaluateCall({
        permissions,
        to: ATTACKER,
        functionName: 'deposit',
        args: [POOL_A, 10n, 1n],
        expiry,
      }).allowed
    ).toBe(false)

    // 6) over the aggregate cap (= max of the two pool caps, 100_000_000n) -> REJECTED (NEW).
    // Per-pool caps are not expressible in @zerodev CallPolicy (see policyEngine module note); the
    // session policy enforces one per-call cap = the largest allocation.
    expect(
      evaluateCall({
        permissions,
        to: YIELD_ROUTER_ADDRESS,
        functionName: 'deposit',
        args: [POOL_B, 100_000_001n, 1n],
        expiry,
      }).allowed
    ).toBe(false)

    // 7) after expiry -> REJECTED (NEW)
    expect(
      evaluateCall({
        permissions,
        to: YIELD_ROUTER_ADDRESS,
        functionName: 'deposit',
        args: [POOL_A, 10n, 1n],
        expiry,
        now: expiry + 1,
      }).allowed
    ).toBe(false)
  })
})
