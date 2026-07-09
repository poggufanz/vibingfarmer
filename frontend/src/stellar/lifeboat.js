// frontend/src/stellar/lifeboat.js
// Mandate grant (user-signed set_mandate) + panel-state mapping. The exit.js pattern:
// buildInvokeTx -> wallet sign -> submitUserTx. Deps are injectable for tests only.
import { buildInvokeTx as realBuild, submitUserTx as realSubmit } from './client.js'
import { signTxXdr as realSign } from './walletKit.js'
import { SOROBAN_AUTOFARM_VAULT_ADDRESS } from './config.js'

// Shared verbatim with the vault contract (LifeboatEngaged.reason_code) and keeper REASON.
export const REASON_LABELS = { 1: 'Utilization spike', 2: 'Liquidity drop', 3: 'Oracle divergence' }

export function panelState({ derisked, mandateExpiry, nowS }) {
  if (derisked) return 'ENGAGED'
  return mandateExpiry > nowS ? 'ARMED' : 'DISARMED'
}

/**
 * User-signed set_mandate(now + hours). The lifeboat's authority is time-boxed by design —
 * an expired mandate disarms the keeper until the user re-grants.
 * @param {{ owner: string, hours?: number, deps?: object }} p deps is a test seam only
 * @returns {Promise<{hash: string, status: string}>}
 */
export async function grantMandate({ owner, hours = 24, deps = {} }) {
  const buildInvokeTx = deps.buildInvokeTx || realBuild
  const signTxXdr = deps.signTxXdr || realSign
  const submitUserTx = deps.submitUserTx || realSubmit
  const nowS = deps.nowS ?? Math.floor(Date.now() / 1000)
  const expiry = nowS + hours * 3600
  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_AUTOFARM_VAULT_ADDRESS,
    method: 'set_mandate',
    args: [{ u64: expiry }],
  })
  const signed = await signTxXdr(xdr)
  return submitUserTx({ signedXdr: signed })
}
