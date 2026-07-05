// frontend/src/wallet/passkeyBase.js
// Passkey-owned Base ERC-4337 (ZeroDev Kernel v3.1) smart account — the OWNER side. This is a
// SEPARATE WebAuthn credential from the Stellar passkey (wallet/passkeyStellar.js): ZeroDev's
// passkey validator brokers registration/assertion through its own `passkeyServerUrl` (verified
// against docs.zerodev.app/onboarding/passkeys/overview, 2026-07-05), a different relying-party
// flow than the browser-direct navigator.credentials calls smart-account-kit uses for Stellar.
// Same physical authenticator (Face ID / Windows Hello / device secure element), two logical
// credentials — the user sees two "use your passkey" prompts across onboarding, not one shared
// credential object. All ZeroDev calls are injectable (mirrors wallet/account.js's `kit`
// injection idiom) so this module's tests never touch a real WebAuthn ceremony or network.
import { http, createPublicClient } from 'viem'
import { createKernelAccount } from '@zerodev/sdk'
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants'
import {
  toPasskeyValidator,
  toWebAuthnKey,
  WebAuthnMode,
  PasskeyValidatorContractVersion,
} from '@zerodev/passkey-validator'
import { BASE_CHAIN, BASE_SEPOLIA_RPC_URL, ZERODEV_PASSKEY_SERVER_URL } from '../base/config.js'

const ENTRY_POINT = getEntryPoint('0.7')
const KERNEL_VERSION = KERNEL_V3_1

/**
 * Provision (register) or reconnect to (login) the passkey-owned Base smart account.
 * @param {{
 *   passkeyName: string,
 *   mode: 'register'|'login',
 *   passkeyServerUrl?: string,
 *   deps?: { makePublicClient?: Function, makeWebAuthnKey?: Function, makePasskeyValidator?: Function, makeKernelAccount?: Function },
 * }} p
 * @returns {Promise<{ address: string, kernelAccount: object, publicClient: object, passkeyValidator: object }>}
 */
export async function createBaseSmartAccount({
  passkeyName,
  mode,
  passkeyServerUrl = ZERODEV_PASSKEY_SERVER_URL,
  deps = {},
}) {
  const {
    makePublicClient = defaultMakePublicClient,
    makeWebAuthnKey = toWebAuthnKey,
    makePasskeyValidator = toPasskeyValidator,
    makeKernelAccount = createKernelAccount,
  } = deps

  if (!passkeyServerUrl) {
    throw new Error(
      'VITE_ZERODEV_PASSKEY_SERVER_URL missing — see docs/deploy-checklist.md (ZeroDev dashboard passkey server)'
    )
  }

  const publicClient = makePublicClient()
  const webAuthnKey = await makeWebAuthnKey({
    passkeyName,
    passkeyServerUrl,
    mode: mode === 'login' ? WebAuthnMode.Login : WebAuthnMode.Register,
    passkeyServerHeaders: {},
  })
  const passkeyValidator = await makePasskeyValidator(publicClient, {
    webAuthnKey,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
  })
  const kernelAccount = await makeKernelAccount(publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    plugins: { sudo: passkeyValidator },
  })

  return { address: kernelAccount.address, kernelAccount, publicClient, passkeyValidator }
}

function defaultMakePublicClient() {
  return createPublicClient({ chain: BASE_CHAIN, transport: http(BASE_SEPOLIA_RPC_URL) })
}
