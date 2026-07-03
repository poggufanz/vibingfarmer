// frontend/src/stellar/agentDeposit.js
// The SP3-deferred primitive: authorize a vault.deposit(agent, amount) with the agent's
// ephemeral ed25519 session key. The agent is a Soroban custom account (1a) whose __check_auth
// (type Signature = BytesN<64>) ed25519-verifies sign(payload) over the SorobanAuthorization
// preimage hash and enforces the deposit cap on-chain. We sign the auth ENTRY (not the tx
// envelope) — the relayer is the inner-tx source and pays the fee, so the user signs nothing.
//
// Manual signing path is primary because it is deterministic and matches the contract's bare
// BytesN<64> signature exactly. (stellar-sdk's authorizeEntry helper packs signatures for
// Keypair signers; a custom account expects the bare sig — see pin-at-impl note.)
import { rpcServer, buildInvokeTx, readContract } from './client.js'
import { SOROBAN_ACTIVE_VAULT_ADDRESS, SOROBAN_TOKEN_ADDRESS, NETWORK_PASSPHRASE } from './config.js'
import { getRelayerAddress, submitViaRelay } from './relay.js'

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

// How many ledgers the deposit authorization stays valid (~30 min at 5s ledgers).
const AUTH_TTL_LEDGERS = 360

/**
 * Sign every auth entry credentialed to `agentAddress` with the session key, in place on `tx`.
 * @param {{tx:object, sessionKey:{rawPublicKey:Uint8Array, sign:(p:Uint8Array)=>Uint8Array}, validUntilLedger:number, agentAddress:string, server?:object}} p
 * @returns {Promise<{xdr:string}>}
 */
export async function signAgentDepositEntries({ tx, sessionKey, validUntilLedger, agentAddress }) {
  const { xdr, hash, Address } = await sdk()
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE))
  const wantScAddress = Address.fromString(agentAddress).toScAddress().toXDR('base64')

  for (const op of tx.operations) {
    const entries = op.auth || []
    for (const entry of entries) {
      if (entry.credentials().switch().name !== 'sorobanCredentialsAddress') continue
      const creds = entry.credentials().address()
      if (creds.address().toXDR('base64') !== wantScAddress) continue // not this agent

      creds.signatureExpirationLedger(validUntilLedger)
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId,
          nonce: creds.nonce(),
          signatureExpirationLedger: validUntilLedger,
          invocation: entry.rootInvocation(),
        })
      )
      const payload = hash(preimage.toXDR())
      const sig = Buffer.from(sessionKey.sign(new Uint8Array(payload))) // 64-byte ed25519
      creds.signature(xdr.ScVal.scvBytes(sig)) // bare BytesN<64> — what __check_auth expects
    }
  }
  return { xdr: tx.toEnvelope().toXDR('base64') }
}

/**
 * Build the invoke (source = relayer), assemble it, then sign the agent's deposit auth entry.
 * @param {{agentAddress:string, amount:bigint, relayer:string, sessionKey:object, vault?:string, server?:object}} p
 * @returns {Promise<{xdr:string}>}
 */
export async function buildAgentDeposit({
  agentAddress,
  amount,
  relayer,
  sessionKey,
  vault = SOROBAN_ACTIVE_VAULT_ADDRESS,
  server,
}) {
  const s = server || (await rpcServer())
  const { tx } = await buildInvokeTx({
    source: relayer,
    contract: vault,
    method: 'deposit',
    args: [{ addr: agentAddress }, { i128: BigInt(amount) }],
    server: s,
  })
  const latest = await s.getLatestLedger()
  const validUntilLedger = latest.sequence + AUTH_TTL_LEDGERS
  const { xdr: signedXdr } = await signAgentDepositEntries({
    tx,
    sessionKey,
    validUntilLedger,
    agentAddress,
    server: s,
  })

  // Re-simulate WITH the signed entry (enforcing mode). The first prepare ran in recording
  // mode, which SKIPS the custom account's __check_auth — its assembled footprint can miss
  // the agent contract's instance/wasm/nonce entries and the submit then traps with
  // scecExceededLimit "contract instance outside of the footprint". The ed25519 signature
  // covers (network id, nonce, expiration ledger, invocation) only — NOT footprint or
  // resources — so re-assembling around the same signed entry is safe.
  const { TransactionBuilder } = await sdk()
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  const prepared = await s.prepareTransaction(signedTx)
  return { xdr: prepared.toEnvelope().toXDR('base64') }
}

/**
 * Full gasless deposit: resolve the relayer, build + sign, submit via the relay.
 * @param {{agentAddress:string, amount:bigint, sessionKey:object, vault?:string, server?:object}} p
 * @returns {Promise<{hash:string, status:string, relayer?:string}|null>} null if relay unconfigured
 */
export async function runAgentDeposit({ agentAddress, amount, sessionKey, vault, server }) {
  const relayer = await getRelayerAddress()
  if (!relayer) return null
  const { xdr } = await buildAgentDeposit({
    agentAddress,
    amount,
    relayer,
    sessionKey,
    vault,
    server,
  })
  return submitViaRelay({ xdr })
}

/** Vault-share balance (i128 base units) of `addr`, or null on RPC failure. */
export async function readVaultShares(addr, { vault = SOROBAN_ACTIVE_VAULT_ADDRESS, server } = {}) {
  try {
    const v = await readContract({
      contract: vault,
      method: 'balance',
      args: [{ addr }],
      server,
    })
    return BigInt(v)
  } catch {
    return null
  }
}

/** Asset (VFUSD) balance (i128 base units) of `addr`, or null on RPC failure. */
export async function readTokenBalance(addr, { token = SOROBAN_TOKEN_ADDRESS, server } = {}) {
  try {
    const v = await readContract({ contract: token, method: 'balance', args: [{ addr }], server })
    return BigInt(v)
  } catch {
    return null
  }
}
