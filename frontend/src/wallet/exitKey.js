// frontend/src/wallet/exitKey.js
// Ephemeral ed25519 exit keypair management and on-chain contract registration.

import { buildInvokeTx } from '../stellar/client.js'
import { signTxXdr } from '../stellar/walletKit.js'
import { getRelayerAddress } from '../stellar/relay.js'
import {
  resolveOwnerTxModel,
  submitOwnerAuthorizedTx,
  signOwnerAuthEntry,
} from '../stellar/ownerAuthorization.js'

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

/**
 * Generate a new random ed25519 Keypair for the exit signer role.
 * @returns {Promise<{ publicKey: string, secret: string }>}
 */
export async function generateExitKey() {
  const { Keypair } = await sdk()
  const kp = Keypair.random()
  return {
    publicKey: kp.publicKey(),
    secret: kp.secret(),
  }
}

/** Cache key for storing exit signer credentials. */
const cacheKey = (agentAddress) => `yv_exit_key_${agentAddress.toLowerCase()}`

/** Save the generated key to local storage. */
export function saveExitKey(agentAddress, { publicKey, secret }) {
  localStorage.setItem(cacheKey(agentAddress), JSON.stringify({ publicKey, secret }))
}

/** Load the exit key credentials from local storage. */
export function loadExitKey(agentAddress) {
  const stored = localStorage.getItem(cacheKey(agentAddress))
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored)
    return parsed
  } catch {
    return null
  }
}

/** Delete the exit key credentials. */
export function clearExitKey(agentAddress) {
  localStorage.removeItem(cacheKey(agentAddress))
}

/**
 * Register the exit signer public key on the agent smart contract — `set_exit_signer(exit_pubkey:
 * BytesN<32>)`, owner-authorized, routed through OwnerAuthorizationV1. A classic G owner signs
 * the envelope and submits directly; a passkey C owner (which can never source that envelope)
 * signs a Soroban auth entry on a relayer-sourced tx and submits relay-only. `activeAccount`
 * defaults to a classic G owner, so every existing caller is unaffected.
 * @param {{owner:string, agentAddress:string, exitPublicKey:string,
 *          activeAccount?:{kind:'G'|'C', address:string}, getRelayerAddress?:Function,
 *          kit?:object, server?:object}} p
 */
export async function registerExitSigner({
  owner,
  agentAddress,
  exitPublicKey,
  activeAccount = { kind: 'G', address: owner },
  getRelayerAddress: getRelayer = getRelayerAddress,
  kit,
  server,
}) {
  const { StrKey } = await sdk()
  const pubBytes = StrKey.decodeEd25519PublicKey(exitPublicKey)

  const model = await resolveOwnerTxModel({ owner, activeAccount, getRelayerAddress: getRelayer })
  return submitOwnerAuthorizedTx({
    model,
    build: () =>
      buildInvokeTx({
        source: model.source,
        contract: agentAddress,
        method: 'set_exit_signer',
        args: [{ bytes32: pubBytes }],
        server,
      }),
    sign: (built) =>
      model.kind === 'G'
        ? signTxXdr(built.xdr)
        : signOwnerAuthEntry({ tx: built.tx, contractId: model.contractId, server, kit }),
    server,
    label: 'set exit signer',
    classicSubmission: 'direct',
  })
}
