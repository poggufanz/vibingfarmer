// frontend/src/stellar/agentSetup.js
// The user-signed steps: per agent, deploy a FRESH agent_account instance pinning this run's
// session pubkey (Option B — a shared pre-deployed agent would reject any other key's deposit
// with failed ED25519 verification, since __check_auth only accepts the constructor-pinned
// signer), then register the scope on the Registry and fund the agent with the asset.
// Three user-signed txs via the wallet kit: deploy, registry.authorize, token.transfer.
import { buildCreateContractTx, buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import {
  SOROBAN_AGENT_WASM_HASH,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  SOROBAN_REGISTRY_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from './config.js'
import { addrScVal, boolScVal, i128ScVal, structScVal, u64ScVal } from './scval.js'

// Rolling cap window default — mirrors the orchestrator's PERIOD_DURATION.
const DEFAULT_PERIOD_DURATION = 86400

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
  // __constructor(owner: Address, signer: BytesN<32>, scope: AgentScope)
  const { xdr, contractAddress } = await buildCreateContractTx({
    source: owner,
    wasmHash: SOROBAN_AGENT_WASM_HASH,
    constructorArgs: [{ addr: owner }, { bytes32: sessionKey.rawPublicKey }, scope],
    server,
  })
  const signed = await signTxXdr(xdr)
  const res = await submitUserTx({ signedXdr: signed, server })
  // Fail fast: depositing through a contract that never landed would only fail later, opaquely.
  if (res.status !== 'SUCCESS') throw new Error(`agent deploy not confirmed: ${res.status}`)
  return contractAddress
}

/**
 * Register the agent's scope on the Registry, then fund it with the asset — user-signed.
 * Registry.authorize(owner, agent, vault, token, cap: i128, period_duration: u64, expiry: u64).
 * @param {{owner:string, agentAddress:string, vault:string, amount:bigint, capPerPeriod:bigint, periodDuration:number, expiry:number}} p
 * @returns {Promise<{hash:string, status:string}>} the authorize tx result
 */
export async function authorizeAndFundAgent({
  owner,
  agentAddress,
  vault,
  amount,
  capPerPeriod,
  periodDuration,
  expiry,
}) {
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
  })
  const signed = await signTxXdr(xdr)
  const authRes = await submitUserTx({ signedXdr: signed })

  // token.transfer(owner → agent, amount) — funds the agent so the vault can pull on deposit.
  const { xdr: fundXdr } = await buildInvokeTx({
    source: owner,
    contract: SOROBAN_TOKEN_ADDRESS,
    method: 'transfer',
    args: [{ addr: owner }, { addr: agentAddress }, { i128: BigInt(amount) }],
  })
  const fundSigned = await signTxXdr(fundXdr)
  await submitUserTx({ signedXdr: fundSigned })

  return authRes
}
