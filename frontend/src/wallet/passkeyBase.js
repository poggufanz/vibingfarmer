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
import { createGaslessKernelClient } from '../base/paymaster.js'

const ENTRY_POINT = getEntryPoint('0.7')
const KERNEL_VERSION = KERNEL_V3_1
const DEPLOY_TIMEOUT_MS = 120_000

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
  // rp.id MUST equal the page's hostname: the SDK's sign-time assertionOptions carry no rpId,
  // so the browser defaults it to the current origin — a credential registered under the
  // ZeroDev dashboard's fixed domain (vibing-farmer.pages.dev) is then invisible to the sign
  // ceremony on any other origin (dev./preview subdomains fail with NotAllowedError after a
  // SUCCESSFUL register; proven live on dev.vibing-farmer.pages.dev 2026-07-19). Production
  // hostname equals the dashboard domain, so this is a no-op there; dev/preview/localhost get
  // per-origin credentials that both ceremonies agree on.
  rpID = typeof location !== 'undefined' ? location.hostname : undefined,
  deps = {},
}) {
  const {
    makePublicClient = defaultMakePublicClient,
    makeWebAuthnKey = toWebAuthnKey,
    makePasskeyValidator = toPasskeyValidator,
    makeKernelAccount = createKernelAccount,
    makeGaslessClient = createGaslessKernelClient,
  } = deps

  if (!passkeyServerUrl) {
    throw new Error(
      'VITE_ZERODEV_PASSKEY_SERVER_URL is missing. See docs/deploy-checklist.md for the ZeroDev dashboard passkey server.'
    )
  }

  const publicClient = makePublicClient()
  const webAuthnKey = await makeWebAuthnKey({
    passkeyName,
    passkeyServerUrl,
    rpID,
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

  // Deploy the account NOW (one sponsored no-op userOp, one extra passkey tap) if it has no
  // code yet. The relayer's session-key path (deserializePermissionAccount) was only ever proven
  // against a DEPLOYED account (SP0 spike / SP2 smoke): on a counterfactual account the first
  // session userOp carries factory initcode whose initConfig installs the permission AND an
  // enable-mode signature — the bundler simulates both and reverts AA23 "duplicate
  // permissionHash" (proven live, first in-app farm run). Deploying at onboarding keeps every
  // later session userOp on the proven enable-once configuration.
  const code = await publicClient.getCode({ address: kernelAccount.address })
  if (!code || code === '0x') {
    const kernelClient = makeGaslessClient({ account: kernelAccount, publicClient })
    const callData = await kernelAccount.encodeCalls([
      { to: kernelAccount.address, value: 0n, data: '0x' },
    ])
    const userOpHash = await kernelClient.sendUserOperation({ callData })
    await kernelClient.waitForUserOperationReceipt({ hash: userOpHash, timeout: DEPLOY_TIMEOUT_MS })
  }

  return { address: kernelAccount.address, kernelAccount, publicClient, passkeyValidator }
}

// Exported so read-only callers (e.g. base/dashboardPositions.js) can build the same viem
// client without duplicating chain/transport wiring or touching the passkey ceremony.
export function defaultMakePublicClient() {
  return createPublicClient({ chain: BASE_CHAIN, transport: http(BASE_SEPOLIA_RPC_URL) })
}
