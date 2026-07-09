// On-chain strategy attestation (Soroban). User signs the inner attest tx
// (attester = user → require_auth satisfied by source-account auth); the relay
// fee-bumps so the user pays 0 XLM. hashStrategy stays pure in src/attestation.js.
import { buildInvokeTx, readContract } from './client.js'
import { submitViaRelay } from './relay.js'
import { signTxXdr } from './walletKit.js'
import { SOROBAN_ATTESTATION_ADDRESS } from './config.js'

/**
 * Attest a strategy hash on-chain. Returns { hash, status } on success, or null
 * when the relay is unconfigured/unreachable. Never throws on relay failure.
 * @param {{ attester: string, strategyHash: string, label?: string, server?: object }} p
 * @returns {Promise<{ hash: string, status: string, relayer?: string } | null>}
 */
export async function attestOnChain({ attester, strategyHash, label, server }) {
  const sym = String(label || 'strategy').slice(0, 9) // symbol_short! max 9 chars
  const { xdr } = await buildInvokeTx({
    source: attester,
    contract: SOROBAN_ATTESTATION_ADDRESS,
    method: 'attest',
    args: [{ addr: attester }, { bytes32: strategyHash }, { symbol: sym }],
    server,
  })
  const signed = await signTxXdr(xdr) // user wallet signs the inner tx
  return submitViaRelay({ xdr: signed }) // server wraps in fee-bump, pays XLM
}

/**
 * Read how many attestations an address has recorded.
 * @param {string} attester
 * @param {{ server?: object }} [opts]
 * @returns {Promise<number | null>}
 */
export async function readAttestationCount(attester, { server } = {}) {
  try {
    const n = await readContract({
      contract: SOROBAN_ATTESTATION_ADDRESS,
      method: 'count_of',
      args: [{ addr: attester }],
      server,
    })
    return Number(n)
  } catch {
    return null
  }
}
