// frontend/src/base/session.js
// Reconstruct a DISPATCHABLE session client from a mandate's serialized approval + the session
// private key — the "orchestrator" side of spikes/smart-sessions/session-test.mjs's proven
// owner/session split. In production this runs on the relayer (SP2), which holds
// `sessionPrivateKey` in its own secure store; it is included here so SP3's own live-testnet
// smoke (Task 3.7) can prove the mandate actually enforces its policy end-to-end without waiting
// on SP2 to exist.
import { privateKeyToAccount } from 'viem/accounts'
import { deserializePermissionAccount } from '@zerodev/permissions'
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants'
import { createGaslessKernelClient } from './paymaster.js'

const ENTRY_POINT = getEntryPoint('0.7')
const KERNEL_VERSION = KERNEL_V3_1

/**
 * @param {{ publicClient: object, serializedApproval: string, sessionPrivateKey: string, deps?: object }} p
 * @returns {Promise<object>} a gasless kernelClient scoped to exactly what the mandate approved
 */
export async function reconstructSessionClient({ publicClient, serializedApproval, sessionPrivateKey, deps = {} }) {
  const {
    keyToAccount = privateKeyToAccount,
    deserialize = deserializePermissionAccount,
    makeGaslessClient = createGaslessKernelClient,
  } = deps

  const sessionSigner = keyToAccount(sessionPrivateKey)
  const account = await deserialize(publicClient, ENTRY_POINT, KERNEL_VERSION, serializedApproval, sessionSigner)

  return makeGaslessClient({ account, publicClient })
}
