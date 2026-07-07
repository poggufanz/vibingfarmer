// frontend/src/wallet/passkeyBase.test.js
import { describe, test, expect, vi } from 'vitest'
import { createBaseSmartAccount } from './passkeyBase.js'

describe('createBaseSmartAccount', () => {
  test('registers a webauthn key, builds a passkey validator (sudo-only, no session plugin), returns the owner address', async () => {
    const fakeWebAuthnKey = { pubKeyX: 1n, pubKeyY: 2n, authenticatorId: 'cred-1' }
    const fakePasskeyValidator = { address: '0xvalidator', signer: 'passkey' }
    const fakeKernelAccount = {
      address: '0xSMARTACCOUNT0000000000000000000000000001',
      encodeCalls: vi.fn(async () => '0xnoopCallData'),
    }
    const fakeKernelClient = {
      sendUserOperation: vi.fn(async () => '0xdeployOp'),
      waitForUserOperationReceipt: vi.fn(async () => ({ success: true })),
    }

    const deps = {
      makePublicClient: vi.fn(() => ({
        chain: 'fake-public-client',
        getCode: vi.fn(async () => '0x'), // counterfactual — not deployed yet
      })),
      makeGaslessClient: vi.fn(() => fakeKernelClient),
      makeWebAuthnKey: vi.fn(async (args) => {
        expect(args.passkeyName).toBe('user@example.com')
        expect(args.mode).toBe('register')
        expect(args.passkeyServerUrl).toBe('https://passkeys.zerodev.app/test-project')
        return fakeWebAuthnKey
      }),
      makePasskeyValidator: vi.fn(async (_client, args) => {
        expect(args.webAuthnKey).toBe(fakeWebAuthnKey)
        expect(args.kernelVersion).toBeDefined()
        expect(args.entryPoint).toBeDefined()
        return fakePasskeyValidator
      }),
      makeKernelAccount: vi.fn(async (_client, args) => {
        expect(args.plugins.sudo).toBe(fakePasskeyValidator)
        expect(args.plugins.regular).toBeUndefined() // owner-only: no session plugin at this stage
        return fakeKernelAccount
      }),
    }

    const result = await createBaseSmartAccount({
      passkeyName: 'user@example.com',
      mode: 'register',
      passkeyServerUrl: 'https://passkeys.zerodev.app/test-project',
      deps,
    })

    expect(result.address).toBe(fakeKernelAccount.address)
    expect(result.kernelAccount).toBe(fakeKernelAccount)
    expect(result.passkeyValidator).toBe(fakePasskeyValidator)
    expect(deps.makeWebAuthnKey).toHaveBeenCalledTimes(1)
    // Counterfactual account MUST be deployed during onboarding (duplicate-permissionHash guard):
    // one sponsored no-op userOp, awaited to a receipt.
    expect(deps.makeGaslessClient).toHaveBeenCalledTimes(1)
    expect(fakeKernelClient.sendUserOperation).toHaveBeenCalledWith({ callData: '0xnoopCallData' })
    expect(fakeKernelClient.waitForUserOperationReceipt).toHaveBeenCalledTimes(1)
  })

  test('skips the deploy userOp when the account already has code on-chain', async () => {
    const fakeKernelClient = { sendUserOperation: vi.fn(), waitForUserOperationReceipt: vi.fn() }
    const deps = {
      makePublicClient: vi.fn(() => ({ getCode: vi.fn(async () => '0x60016000') })),
      makeGaslessClient: vi.fn(() => fakeKernelClient),
      makeWebAuthnKey: vi.fn(async () => ({})),
      makePasskeyValidator: vi.fn(async () => ({})),
      makeKernelAccount: vi.fn(async () => ({ address: '0xdeployed', encodeCalls: vi.fn() })),
    }
    const result = await createBaseSmartAccount({
      passkeyName: 'user@example.com',
      mode: 'login',
      passkeyServerUrl: 'https://passkeys.zerodev.app/test-project',
      deps,
    })
    expect(result.address).toBe('0xdeployed')
    expect(deps.makeGaslessClient).not.toHaveBeenCalled()
    expect(fakeKernelClient.sendUserOperation).not.toHaveBeenCalled()
  })

  test('mode "login" requests an existing-credential assertion, not a new registration', async () => {
    const deps = {
      makePublicClient: vi.fn(() => ({ getCode: vi.fn(async () => '0x6001') })),
      makeWebAuthnKey: vi.fn(async (args) => {
        expect(args.mode).toBe('login')
        return {}
      }),
      makePasskeyValidator: vi.fn(async () => ({})),
      makeKernelAccount: vi.fn(async () => ({ address: '0xabc' })),
    }
    await createBaseSmartAccount({
      passkeyName: 'user@example.com',
      mode: 'login',
      passkeyServerUrl: 'https://passkeys.zerodev.app/test-project',
      deps,
    })
    expect(deps.makeWebAuthnKey).toHaveBeenCalled()
  })

  test('throws a clear error when no passkey server URL is provided or configured', async () => {
    await expect(
      createBaseSmartAccount({ passkeyName: 'x', mode: 'register', passkeyServerUrl: '', deps: {} })
    ).rejects.toThrow(/ZERODEV_PASSKEY_SERVER_URL/)
  })
})
