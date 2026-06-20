// Ephemeral ed25519 agent session key. The agent's on-chain custom account (1a) registers
// `rawPublicKey` as its signer; __check_auth ed25519-verifies sign(payload) against it.
// We use the SDK's Keypair (ed25519) directly — no extra crypto dependency.
import { Keypair } from '@stellar/stellar-sdk'

/**
 * @typedef {object} SessionKey
 * @property {string}   publicKey     G... ed25519 strkey
 * @property {Uint8Array} rawPublicKey 32-byte ed25519 public key (BytesN<32> for the registry)
 * @property {string}   secret        S... secret (keep client-side only; never send to the relay)
 * @property {(payload: Uint8Array) => Buffer} sign  64-byte ed25519 signature over the payload
 */

/**
 * Create (or restore from a secret) an agent session key.
 * @param {string} [secret] restore from this S... secret; omit to generate a fresh key
 * @returns {SessionKey}
 */
export function newSessionKey(secret) {
  const kp = secret ? Keypair.fromSecret(secret) : Keypair.random()
  return {
    publicKey: kp.publicKey(),
    rawPublicKey: kp.rawPublicKey(),
    secret: kp.secret(),
    sign: (payload) => kp.sign(Buffer.from(payload)),
  }
}
