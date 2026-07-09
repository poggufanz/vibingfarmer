// frontend/src/stellar/agentSetup.js
// The user-signed steps: per agent, deploy a FRESH agent_account instance pinning this run's
// session pubkey (Option B — a shared pre-deployed agent would reject any other key's deposit
// with failed ED25519 verification, since __check_auth only accepts the constructor-pinned
// signer), then fund the agent with the asset. Registry.authorize is OPTIONAL record-keeping
// (see registryAuthorizeAgent) — the deposit path never reads the Registry, so it is off the
// critical path by default to save one wallet popup per agent.
//
// Every function here builds its tx (fetching a FRESH source sequence) immediately before the
// wallet-sign — never pre-built — and hard-checks the submit status: a PENDING/FAILED setup tx
// that slid through silently would leave the next build with a stale sequence (txBadSeq) or a
// later deposit failing opaquely. Wallet signs are timeout-capped so a dismissed/stuck popup
// surfaces as an error instead of hanging the run forever.
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
// A wallet popup left unanswered must not hang the run: reject after this long.
export const WALLET_SIGN_TIMEOUT_MS = 120_000

/** Wallet-sign with a hard timeout — a dismissed/stuck popup rejects instead of hanging. */
async function signWithTimeout(xdr, label) {
  let timer
  try {
    return await Promise.race([
      signTxXdr(xdr),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${label} signature timed out after ${WALLET_SIGN_TIMEOUT_MS / 1000}s — wallet popup dismissed or stuck`
              )
            ),
          WALLET_SIGN_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
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
  // __constructor(owner: Address, signer: BytesN<32>, scope: AgentScope)
  const { xdr, contractAddress } = await buildCreateContractTx({
    source: owner,
    wasmHash: SOROBAN_AGENT_WASM_HASH,
    constructorArgs: [{ addr: owner }, { bytes32: sessionKey.rawPublicKey }, scope],
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
