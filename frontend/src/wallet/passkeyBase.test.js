// frontend/src/wallet/passkeyBase.test.js
import { describe, test, expect, vi } from 'vitest'
import { createBaseSmartAccount } from './passkeyBase.js'

describe('createBaseSmartAccount', () => {
  test('registers a webauthn key, builds a passkey validator (sudo-only, no session plugin), returns the owner address', async () => {
    const fakeWebAuthnKey = { pubKeyX: 1n, pubKeyY: 2n, authenticatorId: 'cred-1' }
    const fakePasskeyValidator = { address: '0xvalidator', signer: 'passkey' }
    const fakeKernelAccount = { address: '0xSMARTACCOUNT0000000000000000000000000001' }

    const deps = {
      makePublicClient: vi.fn(() => ({ chain: 'fake-public-client' })),
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
  })

  test('mode "login" requests an existing-credential assertion, not a new registration', async () => {
    const deps = {
      makePublicClient: vi.fn(() => ({})),
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
