// frontend/src/stellar/agentSetup.js
// The one user-signed step: per agent, register the scope on the Registry and fund the agent
// with the asset. (The agent custom account is deployed at agent-create time — its constructor
// self-approves the vault, Phase 1. The demo reuses the pre-deployed SOROBAN_DEMO_AGENT.)
// Two user-signed txs via the wallet kit: registry.authorize, then token.transfer(owner→agent).
import { buildInvokeTx, buildCreateContractTx, submitUserTx, readContract, rpcServer } from './client.js'
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

/**
 * Wrapper around signTxXdr with a timeout and label for human-readable error context.
 * @param {string} xdr unsigned base64 transaction envelope
 * @param {string} label short description for error messages
 * @param {number} [timeoutMs=120000] max ms to wait for the wallet popup
 * @returns {Promise<string>} signed base64 XDR
 */
export async function signWithTimeout(xdr, label, timeoutMs = 120_000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  try {
    const result = await Promise.race([
      signTxXdr(xdr),
      new Promise((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true })
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

  const { Horizon, Asset, TransactionBuilder, Operation, BASE_FEE } = await import(
    '@stellar/stellar-sdk'
  )
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
      String(b.asset_issuer) === String(underlying.issuer),
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
  if (res.status !== 'SUCCESS') throw new Error(`agent deploy not confirmed: ${res.status}`)
  return contractAddress
}

/**
 * OPTIONAL Registry record: authorize(owner, agent, vault, token, cap, period, expiry) —
 * user-signed. NOT required for deposits: the vault's require_auth routes to the agent
 * account's own __check_auth, which enforces the constructor-pinned LOCAL scope and never
 * reads the Registry (verified: soroban/contracts/agent_account has zero registry calls; the
 * relay doesn't gate on it either). The Registry record only feeds the on-chain event indexer
 * (stellar/events.js force-graph) and the Registry.revoke kill-switch story, so the
 * orchestrator keeps it behind a flag, off the popup-critical path by default.
 * @param {{owner:string, agentAddress:string, vault:string, capPerPeriod:bigint, periodDuration:number, expiry:number, server?:object}} p
 * @returns {Promise<{hash:string, status:string}>}
 */
export async function registryAuthorizeAgent({
  owner,
  agentAddress,
  vault,
  capPerPeriod,
  periodDuration,
  expiry,
  server,
}) {
  // Step 0: establish trustline (SAC-wrapped assets need one before transfer).
  await ensureUserTrustline(owner)

  const { xdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_REGISTRY_ADDRESS,
    method: 'authorize',
    args: [
      { addr: owner },
      { addr: agentAddress },
      { addr: vault },
      { addr: SOROBAN_TOKEN_ADDRESS },
      { i128: BigInt(capPerPeriod) },
      { u64: periodDuration },
      { u64: expiry },
    ],
    server,
  })
  const signed = await signWithTimeout(xdr, 'registry authorize')
  const res = await submitUserTx({ signedXdr: signed, server })
  if (res.status !== 'SUCCESS') throw new Error(`registry authorize not confirmed: ${res.status}`)
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
  if (res.status !== 'SUCCESS') throw new Error(`agent funding not confirmed: ${res.status}`)
  return res
}
