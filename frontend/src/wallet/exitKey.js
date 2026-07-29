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

// Same literal as stellar/ownerDiscovery.js's own DEFAULT_NETWORK_ID (the only network the D1
// agent index covers today) — copied rather than imported: ownerDiscovery.js transitively pulls
// in agentIndexClient.js -> agentCreatorManifest.js, which computes a manifest hash at MODULE LOAD
// time and crashes in some test environments (WithdrawModal.test.jsx) that never asked for any of
// that discovery machinery just to read/write a localStorage key.
const DEFAULT_NETWORK_ID = 'stellar-testnet'

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

// v2 owner-scoped MANUAL partial-exit key namespace (Pocket Crew "My money" Task 9). The legacy
// cache above is keyed by agent ONLY — it survives a wallet account switch in the same browser and
// will hand a later, DIFFERENT owner's partial-withdraw flow a signer keypair that was never
// theirs. Scoping by owner AND agent (and the network, so a future mainnet cache can never collide
// with testnet) makes an account switch fail closed by construction: a different owner reads a
// different storage key and simply finds nothing, rather than someone else's key. Only
// `stellar/partialWithdraw.js`'s MANUAL (user-initiated) exit-signer flow uses this namespace —
// `agents/exitExecutor.js`'s AUTONOMOUS auto-exit path is a distinct concern and keeps the legacy
// agent-only cache above unchanged.
const manualKeyV2 = (owner, agent) => `vf.manualExitKey.v2|${DEFAULT_NETWORK_ID}|${owner}|${agent}`

/** Save a manual (user-initiated) partial-exit key under the v2 owner-scoped namespace. */
export function saveManualExitKey({ owner, agent, publicKey, secret }) {
  localStorage.setItem(
    manualKeyV2(owner, agent),
    JSON.stringify({ owner, agent, publicKey, secret })
  )
}

/**
 * Load a manual partial-exit key for `owner`+`agent`, or null when absent OR untrustworthy — never
 * throws. Fails closed on every one of: an account switch (a different owner reads a different
 * storage key, so the old owner's key is simply never seen), a stored payload whose own
 * owner/agent fields don't match what was asked for (never trust a value that doesn't vouch for
 * itself), a corrupt/undecodable secret, or a secret whose derived public key doesn't match the
 * stored one. `ensureExitSigner` (partialWithdraw.js) already treats any null as "no key yet" and
 * registers a fresh one — so a bad key here self-heals on the very next attempt instead of being
 * reused into a repeated on-chain auth failure.
 * @param {{owner:string, agent:string}} p
 * @returns {Promise<{publicKey:string, secret:string}|null>}
 */
export async function loadManualExitKey({ owner, agent }) {
  const raw = localStorage.getItem(manualKeyV2(owner, agent))
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || parsed.owner !== owner || parsed.agent !== agent) return null
  if (!parsed.publicKey || !parsed.secret) return null
  try {
    const { Keypair } = await sdk()
    if (Keypair.fromSecret(parsed.secret).publicKey() !== parsed.publicKey) return null
  } catch {
    return null // undecodable secret — corrupt, never trusted
  }
  return { publicKey: parsed.publicKey, secret: parsed.secret }
}

/** Delete the v2 manual exit key for `owner`+`agent`. */
export function clearManualExitKey({ owner, agent }) {
  localStorage.removeItem(manualKeyV2(owner, agent))
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
