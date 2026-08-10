// frontend/src/wallet/passkeyBase.test.js
import { describe, test, expect, vi } from 'vitest'
import { createBaseSmartAccount, signWithRpId } from './passkeyBase.js'

const DEPLOY_USER_OP_HASH = `0x${'a'.repeat(64)}`
const DEPLOY_TX_HASH = `0x${'b'.repeat(64)}`

function undeployedAccountDeps(receipt, userOpHash = DEPLOY_USER_OP_HASH) {
  const kernelClient = {
    sendUserOperation: vi.fn(async () => userOpHash),
    waitForUserOperationReceipt: vi.fn(async () => receipt),
  }
  return {
    kernelClient,
    deps: {
      makePublicClient: vi.fn(() => ({ getCode: vi.fn(async () => '0x') })),
      makeGaslessClient: vi.fn(() => kernelClient),
      makeWebAuthnKey: vi.fn(async () => ({})),
      makePasskeyValidator: vi.fn(async () => ({})),
      makeKernelAccount: vi.fn(async () => ({
        address: '0x0000000000000000000000000000000000000abc',
        encodeCalls: vi.fn(async () => '0xnoop'),
      })),
    },
  }
}

describe('createBaseSmartAccount', () => {
  test('registers a webauthn key, builds a passkey validator (sudo-only, no session plugin), returns the owner address', async () => {
    const fakeWebAuthnKey = { pubKeyX: 1n, pubKeyY: 2n, authenticatorId: 'cred-1' }
    const fakePasskeyValidator = { address: '0xvalidator', signer: 'passkey' }
    const fakeKernelAccount = {
      address: '0xSMARTACCOUNT0000000000000000000000000001',
      encodeCalls: vi.fn(async () => '0xnoopCallData'),
    }
    const fakeKernelClient = {
      sendUserOperation: vi.fn(async () => DEPLOY_USER_OP_HASH),
      waitForUserOperationReceipt: vi.fn(async () => ({
        success: true,
        receipt: { status: 'success', transactionHash: DEPLOY_TX_HASH },
      })),
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

  test.each([
    [
      'outer failure with inner success',
      { success: false, receipt: { status: 'success', transactionHash: DEPLOY_TX_HASH } },
    ],
    [
      'outer success with inner revert',
      { success: true, receipt: { status: 'reverted', transactionHash: DEPLOY_TX_HASH } },
    ],
    ['missing nested receipt', { success: true }],
    [
      'malformed deployment transaction hash',
      { success: true, receipt: { status: 'success', transactionHash: '0x1' } },
    ],
  ])('rejects an undeployed Kernel when its deployment receipt has %s', async (_label, receipt) => {
    const { deps, kernelClient } = undeployedAccountDeps(receipt)

    await expect(
      createBaseSmartAccount({
        passkeyName: 'user@example.com',
        mode: 'register',
        passkeyServerUrl: 'https://passkeys.zerodev.app/test-project',
        deps,
      })
    ).rejects.toThrow()

    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1)
    expect(kernelClient.waitForUserOperationReceipt).toHaveBeenCalledTimes(1)
  })

  test('rejects a malformed deployment UserOperation hash before polling and never retries', async () => {
    const receipt = {
      success: true,
      receipt: { status: 'success', transactionHash: DEPLOY_TX_HASH },
    }
    const { deps, kernelClient } = undeployedAccountDeps(receipt, '0x1234')

    await expect(
      createBaseSmartAccount({
        passkeyName: 'user@example.com',
        mode: 'register',
        passkeyServerUrl: 'https://passkeys.zerodev.app/test-project',
        deps,
      })
    ).rejects.toThrow(/user operation hash/i)

    expect(kernelClient.sendUserOperation).toHaveBeenCalledTimes(1)
    expect(kernelClient.waitForUserOperationReceipt).not.toHaveBeenCalled()
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

  test('threads rpID through to the webauthn key (register+sign must share one rp scope)', async () => {
    const deps = {
      makePublicClient: vi.fn(() => ({ getCode: vi.fn(async () => '0x6001') })),
      makeWebAuthnKey: vi.fn(async (args) => {
        expect(args.rpID).toBe('dev.vibing-farmer.pages.dev')
        return {}
      }),
      makePasskeyValidator: vi.fn(async () => ({})),
      makeKernelAccount: vi.fn(async () => ({ address: '0xabc' })),
    }
    await createBaseSmartAccount({
      passkeyName: 'user@example.com',
      mode: 'register',
      passkeyServerUrl: 'https://passkeys.zerodev.app/test-project',
      rpID: 'dev.vibing-farmer.pages.dev',
      deps,
    })
    expect(deps.makeWebAuthnKey).toHaveBeenCalledTimes(1)
  })

  test('attaches rpID + a sign callback to the webauthn key (sign ceremony must carry the rp scope)', async () => {
    const fakeKey = {}
    const deps = {
      makePublicClient: vi.fn(() => ({ getCode: vi.fn(async () => '0x6001') })),
      makeWebAuthnKey: vi.fn(async () => fakeKey),
      makePasskeyValidator: vi.fn(async (_client, args) => {
        expect(args.webAuthnKey.rpID).toBe('vibing-farmer.pages.dev')
        expect(typeof args.webAuthnKey.signMessageCallback).toBe('function')
        return {}
      }),
      makeKernelAccount: vi.fn(async () => ({ address: '0xabc' })),
    }
    await createBaseSmartAccount({
      passkeyName: 'user@example.com',
      mode: 'login',
      passkeyServerUrl: 'https://passkeys.zerodev.app/test-project',
      rpID: 'vibing-farmer.pages.dev',
      deps,
    })
    expect(deps.makePasskeyValidator).toHaveBeenCalledTimes(1)
  })

  test('signWithRpId puts rpId into the assertion options (the SDK signer omits it)', async () => {
    let captured = null
    const startAuthenticationImpl = vi.fn(async (options) => {
      captured = options
      throw new Error('sentinel: stop before signature encoding')
    })
    await expect(
      signWithRpId(
        '0xdeadbeef',
        'vibing-farmer.pages.dev',
        84532,
        [{ id: 'cred-1', type: 'public-key' }],
        {
          startAuthenticationImpl,
        }
      )
    ).rejects.toThrow('sentinel')
    expect(captured.rpId).toBe('vibing-farmer.pages.dev')
    expect(captured.userVerification).toBe('required')
    expect(captured.allowCredentials).toEqual([{ id: 'cred-1', type: 'public-key' }])
    expect(typeof captured.challenge).toBe('string')
  })

  test('throws a clear error when no passkey server URL is provided or configured', async () => {
    await expect(
      createBaseSmartAccount({ passkeyName: 'x', mode: 'register', passkeyServerUrl: '', deps: {} })
    ).rejects.toThrow(/ZERODEV_PASSKEY_SERVER_URL/)
  })
})
