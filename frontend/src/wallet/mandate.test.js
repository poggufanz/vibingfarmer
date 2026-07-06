// frontend/src/wallet/mandate.test.js
import { describe, test, expect, vi } from 'vitest'
import { createMandate } from './mandate.js'
import { evaluateCall } from '../base/policyEngine.js'
import { YIELD_ROUTER_ADDRESS } from '../base/config.js'

const POOL_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const POOL_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const ATTACKER = '0xDEADDEADDEADDEADDEADDEADDEADDEADDEADDEAD'

function makeDeps({ sessionKeyAddress = '0xSESSIONKEY000000000000000000000000000001' } = {}) {
  const fakePermissionValidator = { address: '0xpermvalidator' }
  const fakeOwnerSideAccount = { address: '0xOWNERSIDEACCOUNT00000000000000000000001' }
  let capturedPermissions = null
  let capturedTimestampPolicy = null
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
  }
}

describe('createMandate', () => {
  test('approves the session key by address only — never touches the session private key on the owner side', async () => {
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
    expect(result.permissions).toHaveLength(1)
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

  test('the resulting permissions + expiry, fed through evaluateCall, reproduce every session-test.mjs scenario plus the new cap/expiry ones', async () => {
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

    // 1) in-policy deposit on pool A within cap -> ALLOWED (mirrors session-test.mjs Test 1)
    expect(
      evaluateCall({
        permissions,
        to: YIELD_ROUTER_ADDRESS,
        functionName: 'deposit',
        args: [POOL_A, 10n, 1n],
        expiry,
      }).allowed
    ).toBe(true)

    // 2) wrong selector: sweep -> REJECTED (mirrors session-test.mjs Test 2)
    expect(
      evaluateCall({
        permissions,
        to: YIELD_ROUTER_ADDRESS,
        functionName: 'sweep',
        args: [ATTACKER],
        expiry,
      }).allowed
    ).toBe(false)

    // 3) wrong target -> REJECTED (mirrors session-test.mjs Test 3)
    expect(
      evaluateCall({
        permissions,
        to: ATTACKER,
        functionName: 'deposit',
        args: [POOL_A, 10n, 1n],
        expiry,
      }).allowed
    ).toBe(false)

    // 4) over cap on pool B -> REJECTED (NEW)
    expect(
      evaluateCall({
        permissions,
        to: YIELD_ROUTER_ADDRESS,
        functionName: 'deposit',
        args: [POOL_B, 20_000_001n, 1n],
        expiry,
      }).allowed
    ).toBe(false)

    // 5) after expiry -> REJECTED (NEW)
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
