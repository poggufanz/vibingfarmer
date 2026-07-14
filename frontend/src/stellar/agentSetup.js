// frontend/src/stellar/agentSetup.js
// The user-signed steps: per agent, deploy a FRESH agent_account instance pinning this run's
// session pubkey (Option B — a shared pre-deployed agent would reject any other key's deposit
// with failed ED25519 verification, since __check_auth only accepts the constructor-pinned
// signer), then fund the agent with the asset. Registry.authorize is OPTIONAL record-keeping
// (see registryAuthorizeAgent) — the deposit path never reads the Registry, so it is off the
// critical path by default to save one wallet signature per agent.
//
// Every function here builds its tx (fetching a FRESH source sequence) immediately before the
// wallet-sign — never pre-built — and hard-checks the submit status: a PENDING/FAILED setup tx
// that slid through silently would leave the next build with a stale sequence (txBadSeq) or a
// later deposit failing opaquely. Wallet signs are timeout-capped so a dismissed/stuck signature request
// surfaces as an error instead of hanging the run forever.
import {
  buildCreateContractTx,
  buildInvokeTx,
  submitUserTx,
  readContract,
  rpcServer,
} from './client.js'
import { signTxXdr } from './walletKit.js'
import {
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_AGENT_WASM_HASH,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
} from './config.js'
import {
  addrScVal,
  i128ScVal,
  u64ScVal,
  bytes32ScVal,
  boolScVal,
  voidScVal,
  structScVal,
} from './scval.js'

const DEFAULT_PERIOD_DURATION = 86400
// A wallet signature left unanswered must not hang the run: reject after this long.
export const WALLET_SIGN_TIMEOUT_MS = 120_000

/** Wallet-sign with a hard timeout — a dismissed/stuck signature request rejects instead of hanging.
 *  Exported so the single-signature grant flow (stellar/grant.js) signs its single grant tx through the
 *  exact same timeout-capped wallet path, not a second hand-rolled copy. */
export async function signWithTimeout(xdr, label) {
  let timer
  try {
    const result = await Promise.race([
      signTxXdr(xdr),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Wallet signature for ${label} timed out after ${WALLET_SIGN_TIMEOUT_MS / 1000} seconds. The request may have been dismissed or stalled.`
              )
            ),
          WALLET_SIGN_TIMEOUT_MS
        )
      }),
    ])
    return result
  } catch (err) {
    throw new Error(`${label}: ${err?.message || err}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ensure the owner's classic Stellar account has a trustline for the token's
 * underlying asset (SAC-wrapped classic assets require a trustline before
 * transfer).  If the token is Soroban-native (no underlying_asset method) or
 * the trustline already exists, this is a no-op.
 */
async function ensureUserTrustline(owner) {
  let underlying
  try {
    underlying = await readContract({
      contract: SOROBAN_TOKEN_ADDRESS,
      method: 'underlying_asset',
      args: [],
    })
  } catch {
    // Token is Soroban-native — no trustline needed.
    return
  }
  if (!underlying) return

  const { Horizon, Asset, TransactionBuilder, Operation, BASE_FEE } =
    await import('@stellar/stellar-sdk')
  const horizon = new Horizon.Server(HORIZON_URL)
  let acct
  try {
    acct = await horizon.loadAccount(owner)
  } catch {
    return
  }
  const hasTrust = acct.balances.some(
    (b) =>
      b.asset_type !== 'native' &&
      String(b.asset_code) === String(underlying.code) &&
      String(b.asset_issuer) === String(underlying.issuer)
  )
  if (hasTrust) return

  const asset = new Asset(String(underlying.code), String(underlying.issuer))
  const server = await rpcServer()
  const source = await server.getAccount(owner)
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(30)
    .build()
  const xdr = tx.toEnvelope().toXDR('base64')
  const signed = await signTxXdr(xdr)
  const built = TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE)
  await horizon.submitTransaction(built)
}

/**
 * Deploy a fresh agent_account for THIS run's session key (Option B: fresh agent per run).
 * create-from-wasm-hash (the wasm is already uploaded on-chain — no upload step); the
 * constructor pins `sessionKey.rawPublicKey` as the account's signer and self-approves
 * scope.vault to pull up to `cap` of scope.token. User-signed AND user-paid: the relay only
 * fee-bumps vault-deposit invokes (server allowlist, fail-closed), so a deploy could never go
 * through it. period_start 0 → enforce()'s rolling reset starts the window on first deposit.
 * @param {{ owner:string, sessionKey:{rawPublicKey:Uint8Array}, cap:bigint|number,
 *           vault?:string, periodDuration?:number, expiry:number, server?:object }} p
 * @returns {Promise<string>} the freshly deployed agent C... address
 */
export async function deployAgentForSession({
  owner,
  sessionKey,
  cap,
  vault = SOROBAN_ACTIVE_VAULT_ADDRESS,
  periodDuration = DEFAULT_PERIOD_DURATION,
  expiry,
  server,
}) {
  // AgentScope struct (soroban/contracts/agent_account/src/types.rs) — Rust field order.
  const scope = structScVal({
    owner: addrScVal(owner),
    vault: addrScVal(vault),
    token: addrScVal(SOROBAN_TOKEN_ADDRESS),
    cap_per_period: i128ScVal(BigInt(cap)),
    period_duration: u64ScVal(periodDuration),
    spent_in_period: i128ScVal(0n),
    period_start: u64ScVal(0),
    expiry: u64ScVal(expiry),
    revoked: boolScVal(false),
  })
  // __constructor(owner: Address, signer: BytesN<32>, scope: AgentScope, router: Option<Address>)
  // Legacy direct deploy — no funding_router deployed this agent, so router = None (ScVal Void).
  const { xdr, contractAddress } = await buildCreateContractTx({
    source: owner,
    wasmHash: SOROBAN_AGENT_WASM_HASH,
    constructorArgs: [{ addr: owner }, { bytes32: sessionKey.rawPublicKey }, scope, voidScVal()],
    server,
  })
  const signed = await signWithTimeout(xdr, 'agent deploy')
  const res = await submitUserTx({ signedXdr: signed, server })
  // Fail fast: depositing through a contract that never landed would only fail later, opaquely.
  if (res.status !== 'SUCCESS')
    throw new Error(`Agent deployment was not confirmed: ${res.status}.`)
  return contractAddress
}

/**
 * OPTIONAL Registry record: authorize(agent) — user-signed. The hardened Registry derives
 * every record field from the agent contract's own scope_of() (caller supplies ONLY the
 * agent address — nothing forgeable) and requires the DERIVED owner's signature. NOT
 * required for deposits: the vault's require_auth routes to the agent account's own
 * __check_auth, which enforces the constructor-pinned LOCAL scope and never reads the
 * Registry. The record only feeds the on-chain event indexer (stellar/events.js
 * force-graph); the enforcing kill switch is AgentAccount.revoke() (see revoke.js).
 * @param {{owner:string, agentAddress:string, server?:object}} p
 * @returns {Promise<{hash:string, status:string}>}
 */
export async function registryAuthorizeAgent({ owner, agentAddress, server }) {
  // Step 0: establish trustline (SAC-wrapped assets need one before transfer).
  await ensureUserTrustline(owner)

  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_REGISTRY_ADDRESS,
    method: 'authorize',
    args: [{ addr: agentAddress }],
    server,
  })
  const signed = await signWithTimeout(xdr, 'registry authorize')
  const res = await submitUserTx({ signedXdr: signed, server })
  if (res.status !== 'SUCCESS')
    throw new Error(`Registry authorization was not confirmed: ${res.status}.`)
  return res
}

/**
 * Fund the agent with the asset so the vault can pull on deposit —
 * token.transfer(owner → agent, amount), user-signed. Status-checked: an unconfirmed funding
 * would doom the later deposit simulation (insufficient balance) with a far worse error.
 * @param {{owner:string, agentAddress:string, amount:bigint, server?:object}} p
 * @returns {Promise<{hash:string, status:string}>}
 */
export async function fundAgent({ owner, agentAddress, amount, server }) {
  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_TOKEN_ADDRESS,
    method: 'transfer',
    args: [{ addr: owner }, { addr: agentAddress }, { i128: BigInt(amount) }],
    server,
  })
  const signed = await signWithTimeout(xdr, 'agent funding')
  const res = await submitUserTx({ signedXdr: signed, server })
  if (res.status !== 'SUCCESS') throw new Error(`Agent funding was not confirmed: ${res.status}.`)
  return res
}
