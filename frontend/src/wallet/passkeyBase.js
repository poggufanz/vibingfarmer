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
import {
  b64ToBytes,
  base64FromUint8Array,
  findQuoteIndices,
  hexStringToUint8Array,
  isRIP7212SupportedNetwork,
  parseAndNormalizeSig,
  uint8ArrayToHexString,
} from '@zerodev/webauthn-key'
import { encodeAbiParameters } from 'viem'
import {
  BASE_CHAIN,
  BASE_SEPOLIA_RPC_URL,
  ZERODEV_PASSKEY_SERVER_URL,
  ZERODEV_PASSKEY_RP_ID,
} from '../base/config.js'
import { createGaslessKernelClient } from '../base/paymaster.js'

const ENTRY_POINT = getEntryPoint('0.7')
const KERNEL_VERSION = KERNEL_V3_1
const DEPLOY_TIMEOUT_MS = 120_000

// Clone of the SDK's private signMessageUsingWebAuthn with ONE addition: rpId in the
// assertion options. toPasskeyValidator prefers webAuthnKey.signMessageCallback(message,
// webAuthnKey.rpID, chainId, allowCredentials) over that internal signer, which is the
// supported seam for this. The signature encoding below must stay byte-identical to the
// SDK's (same abi tuple, same helpers — all public exports of @zerodev/webauthn-key).
// ponytail: drop this whole function when ZeroDev threads rpId upstream.
export async function signWithRpId(message, rpID, chainId, allowCredentials, deps = {}) {
  let messageContent
  if (typeof message === 'string') messageContent = message
  else if ('raw' in message && typeof message.raw === 'string') messageContent = message.raw
  else if ('raw' in message && message.raw instanceof Uint8Array)
    messageContent = message.raw.toString()
  else throw new Error('Unsupported message format')
  const formattedMessage = messageContent.startsWith('0x')
    ? messageContent.slice(2)
    : messageContent
  const challenge = base64FromUint8Array(hexStringToUint8Array(formattedMessage), true)
  const assertionOptions = {
    challenge,
    allowCredentials,
    userVerification: 'required',
    rpId: rpID,
  }
  const startAuthentication =
    deps.startAuthenticationImpl ?? (await import('@simplewebauthn/browser')).startAuthentication
  const cred = await startAuthentication(assertionOptions)
  const { authenticatorData } = cred.response
  const authenticatorDataHex = uint8ArrayToHexString(b64ToBytes(authenticatorData))
  const clientDataJSON = atob(cred.response.clientDataJSON)
  const { beforeType } = findQuoteIndices(clientDataJSON)
  const { signature } = cred.response
  const signatureHex = uint8ArrayToHexString(b64ToBytes(signature))
  const { r, s } = parseAndNormalizeSig(signatureHex)
  return encodeAbiParameters(
    [
      { name: 'authenticatorData', type: 'bytes' },
      { name: 'clientDataJSON', type: 'string' },
      { name: 'responseTypeLocation', type: 'uint256' },
      { name: 'r', type: 'uint256' },
      { name: 's', type: 'uint256' },
      { name: 'usePrecompiled', type: 'bool' },
    ],
    [
      authenticatorDataHex,
      clientDataJSON,
      beforeType,
      BigInt(r),
      BigInt(s),
      isRIP7212SupportedNetwork(chainId),
    ]
  )
}

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
  // The rp scope every ceremony must share. The hosted ZeroDev server IGNORES client-sent
  // rpID and always registers under the dashboard domain — and per WebAuthn that domain (the
  // registrable eTLD+1, pages.dev being on the Public Suffix List) is valid on every subdomain.
  // So pin register AND sign to it: the SDK's own sign path omits rpId, the browser then
  // defaults the assertion to the current origin, and a preview subdomain can't see the
  // credential (register OK, sign NotAllowedError — proven live on dev.vibing-farmer.pages.dev
  // 2026-07-19). Sign-side enforcement = signWithRpId attached below.
  rpID = ZERODEV_PASSKEY_RP_ID,
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
  // Pin the sign-time rp scope (see rpID param comment). ??= lets injected test keys carry
  // their own callback.
  webAuthnKey.rpID = rpID
  webAuthnKey.signMessageCallback ??= signWithRpId
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
