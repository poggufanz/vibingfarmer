// frontend/src/wallet/mandate.js
// The "set once" ceremony (design spec Approach C §4 / §6 step 1): the Base owner (passkey)
// approves ONE session-key policy covering every whitelisted pool for this farming run. Ports
// the exact owner/session-key split proven live in spikes/smart-sessions/session-test.mjs — only
// the owner validator changes (throwaway ECDSA there, for spike simplicity; a real passkey here,
// via wallet/passkeyBase.js). Adds expiry via `toTimestampPolicy`, which the delivered SP0 spike
// never exercised (see Global Constraints) — verified against docs.zerodev.app/smart-accounts/
// permissions/policies/timestamp, 2026-07-05.
import { toPermissionValidator, serializePermissionAccount } from '@zerodev/permissions'
import { toECDSASigner } from '@zerodev/permissions/signers'
import { toCallPolicy, toTimestampPolicy, CallPolicyVersion } from '@zerodev/permissions/policies'
import { createKernelAccount, addressToEmptyAccount } from '@zerodev/sdk'
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { buildDepositPermissions } from '../base/policyEngine.js'

const ENTRY_POINT = getEntryPoint('0.7')
const KERNEL_VERSION = KERNEL_V3_1

/**
 * @typedef {import('../base/policyEngine.js').PoolCap} PoolCap
 */

/**
 * Create the mandate: a fresh ephemeral session key + a call-policy scoped to
 * `YieldRouter.deposit` on exactly `pools`, each capped at its own `cap`, expiring at `expiry`.
 * The OWNER (passkey) approves the session key by ADDRESS ONLY (`addressToEmptyAccount`) — the
 * owner-side build here never touches the session private key, mirroring session-test.mjs.
 * @param {{
 *   kernelAccount: object,      // from createBaseSmartAccount — informational only, not reused directly
 *   publicClient: object,
 *   passkeyValidator: object,   // the SAME validator object createBaseSmartAccount returned
 *   pools: PoolCap[],
 *   expiry: number,             // unix seconds
 *   deps?: object,
 * }} p
 * @returns {Promise<{ serializedApproval: string, sessionKeyAddress: string, sessionPrivateKey: string, permissions: Array<object>, expiry: number }>}
 */
export async function createMandate({ kernelAccount, publicClient, passkeyValidator, pools, expiry, deps = {} }) {
  if (!Array.isArray(pools) || pools.length === 0) throw new Error('createMandate requires at least one pool')
  if (!expiry || expiry <= Math.floor(Date.now() / 1000)) throw new Error('expiry must be in the future')

  const {
    genSessionKey = generatePrivateKey,
    keyToAccount = privateKeyToAccount,
    makeECDSASigner = toECDSASigner,
    makeCallPolicy = toCallPolicy,
    makeTimestampPolicy = toTimestampPolicy,
    makePermissionValidator = toPermissionValidator,
    makeKernelAccount = createKernelAccount,
    serialize = serializePermissionAccount,
    emptyAccount = addressToEmptyAccount,
  } = deps

  // Fresh ephemeral session key. sessionPrivateKey is returned to the caller ONLY so it can be
  // handed to the orchestrator/relayer's secure keystore (SP2) — never log it, never persist it
  // client-side beyond that handoff. It can only ever sign a deposit into a whitelisted pool,
  // under cap, before expiry — enforced on-chain, not by anyone's discipline about the key.
  const sessionPrivateKey = genSessionKey()
  const sessionKeyAddress = keyToAccount(sessionPrivateKey).address

  const emptySessionSigner = await makeECDSASigner({ signer: emptyAccount(sessionKeyAddress) })

  const permissions = buildDepositPermissions({ pools, yieldRouterAbi: (await import('../base/config.js')).YIELD_ROUTER_ABI })
  const callPolicy = makeCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions })
  const timestampPolicy = makeTimestampPolicy({ validAfter: 0, validUntil: expiry })

  const permissionPlugin = await makePermissionValidator(publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    signer: emptySessionSigner,
    policies: [callPolicy, timestampPolicy],
  })

  const ownerSideAccount = await makeKernelAccount(publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    plugins: { sudo: passkeyValidator, regular: permissionPlugin },
  })

  const serializedApproval = await serialize(ownerSideAccount)

  return { serializedApproval, sessionKeyAddress, sessionPrivateKey, permissions, expiry }
}
