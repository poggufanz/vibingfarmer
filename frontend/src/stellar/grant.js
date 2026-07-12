// frontend/src/stellar/grant.js
// Single-signature grant flow — the funding_router side of agent setup. A SINGLE owner-signed grant tx
// (source == owner) covers the WHOLE auth tree: router.grant → nested SEP-41 token.approve →
// deploy_v2 of one fresh agent_account per worker. Because the tx source IS the owner, both
// owner.require_auth() calls (grant + the nested approve) are satisfied by SOURCE-ACCOUNT
// credentials, so signing the envelope is the only wallet interaction — a single signature, no separate
// SorobanAuthorizationEntry to sign (same insight as client.js buildCreateContractTx). Later
// worker funding is a RELAYED router.pull (agent session-key signs the pull auth entry; the relay
// fee-bumps) — zero further signatures. Revoke is the owner setting the SEP-41 allowance back to 0.
import { xdr } from '@stellar/stellar-sdk'
import { rpcServer, buildInvokeTx, submitUserTx, readContract } from './client.js'
import { signAgentDepositEntries } from './agentDeposit.js'
import { getRelayerAddress, submitViaRelay } from './relay.js'
import { signWithTimeout } from './agentSetup.js'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
} from './config.js'
import {
  addrScVal,
  i128ScVal,
  u32ScVal,
  u64ScVal,
  bytes32ScVal,
  structScVal,
  fromScVal,
} from './scval.js'

let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@stellar/stellar-sdk')
  return _sdk
}

// Soroban testnet closes a ledger about every 5 seconds. The grant sets the SEP-41 allowance
// expiry as a LEDGER number, so a wall-clock grant duration converts at this rate.
const SECONDS_PER_LEDGER = 5
// How long a relayed router.pull auth entry stays valid (~30 min at 5s ledgers) — mirrors agentDeposit.
const AUTH_TTL_LEDGERS = 360

/**
 * Encode one `AgentInit` (soroban/contracts/funding_router/src/types.rs) as a Soroban struct
 * ScVal. `#[contracttype]` structs are ScMaps keyed by field NAME in lexicographic order, so the
 * on-wire key order MUST be: cap, expiry, period_duration, salt, signer, vault. structScVal sorts
 * the keys itself, so the object below is written in that order purely for readability — the sort
 * is what actually guarantees the encoding matches the Rust struct.
 * @param {{signer:Uint8Array|string, salt:Uint8Array|string, cap:bigint|number, vault:string,
 *          periodDuration:bigint|number, expiry:bigint|number}} p
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function agentInitScVal({ signer, salt, cap, vault, periodDuration, expiry }) {
  return structScVal({
    cap: i128ScVal(cap),
    expiry: u64ScVal(expiry),
    period_duration: u64ScVal(periodDuration),
    salt: bytes32ScVal(salt),
    signer: bytes32ScVal(signer),
    vault: addrScVal(vault),
  })
}

/** 32 fresh random bytes — a per-agent deploy salt so re-grants never collide with old addresses. */
function randomSalt() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32))
}

/**
 * Build + simulate-assemble the ONE grant tx (source = owner). Returns the assembled unsigned XDR
 * plus the deployed agent addresses read from the pre-simulation retval. The `deploy_v2` addresses
 * are salt-derived and deterministic, so the simulated `Vec<Address>` matches what submit produces.
 * @param {{owner:string, budgetBaseUnits:bigint|number, durationSeconds:number,
 *          agentInits:Array<{signer:Uint8Array, salt?:Uint8Array, cap:bigint, vault:string,
 *          periodDuration:number, expiry:number}>, router?:string, server?:object}} p
 * @returns {Promise<{tx:object, xdr:string, agentAddresses:string[], expiryLedger:number}>}
 */
export async function buildGrantTx({
  owner,
  budgetBaseUnits,
  durationSeconds,
  agentInits,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  server,
}) {
  if (!router) throw new Error('The funding router is not configured.')
  if (!agentInits || agentInits.length === 0)
    throw new Error('The grant requires at least one agent.')
  const s = server || (await rpcServer())
  const { Contract, TransactionBuilder, BASE_FEE } = await sdk()

  const latest = await s.getLatestLedger()
  const expiryLedger = latest.sequence + Math.ceil(durationSeconds / SECONDS_PER_LEDGER)

  const encoded = agentInits.map((a) =>
    agentInitScVal({
      signer: a.signer,
      salt: a.salt || randomSalt(),
      cap: a.cap,
      vault: a.vault,
      periodDuration: a.periodDuration,
      expiry: a.expiry,
    })
  )
  const agentsVec = xdr.ScVal.scvVec(encoded)

  const account = await s.getAccount(owner)
  const raw = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(router).call(
        'grant',
        addrScVal(owner),
        i128ScVal(BigInt(budgetBaseUnits)),
        u32ScVal(expiryLedger),
        agentsVec
      )
    )
    .setTimeout(60)
    .build()

  // Simulate FIRST to capture the retval (Vec<Address> of the to-be-deployed agents).
  const sim = await s.simulateTransaction(raw)
  if (sim.error || !sim.result)
    throw new Error(`Grant simulation failed: ${sim.error || 'no result'}`)
  const agentAddresses = fromScVal(sim.result.retval)

  // …then prepare (simulate + assemble, sets the resource fee). We do NOT re-prepare after signing:
  // the owner's tx-envelope signature covers footprint + resources, so a post-sign re-prepare would
  // invalidate it. (The re-prepare-after-sign trick is only for the agent ed25519 auth-entry path,
  // whose signature excludes the footprint — see buildAgentPull below.)
  const tx = await s.prepareTransaction(raw)
  return { tx, xdr: tx.toEnvelope().toXDR('base64'), agentAddresses, expiryLedger }
}

/**
 * Full single-signature grant: build → wallet-sign (timeout-capped) → submit. Prefers the relay fee-bump
 * (the relay now allowlists router.grant, so the user pays 0 XLM); falls back to a direct user-paid
 * submit only when the relay is unconfigured (returns null).
 * @param {{owner:string, budgetBaseUnits:bigint|number, durationSeconds:number, agentInits:Array,
 *          router?:string, server?:object, sign?:Function}} p
 * @returns {Promise<{hash:string, status:string, relayer?:string, agentAddresses:string[], expiryLedger:number}>}
 */
export async function submitGrant({
  owner,
  budgetBaseUnits,
  durationSeconds,
  agentInits,
  router,
  server,
  sign = signWithTimeout,
}) {
  const built = await buildGrantTx({
    owner,
    budgetBaseUnits,
    durationSeconds,
    agentInits,
    router,
    server,
  })
  const signed = await sign(built.xdr, 'grant')
  const relayed = await submitViaRelay({ xdr: signed })
  if (relayed) {
    if (relayed.status !== 'SUCCESS') throw new Error(`The grant relay returned ${relayed.status}.`)
    return {
      hash: relayed.hash,
      status: relayed.status,
      relayer: relayed.relayer,
      agentAddresses: built.agentAddresses,
      expiryLedger: built.expiryLedger,
    }
  }
  // Relay off → direct user-paid submit.
  const res = await submitUserTx({ signedXdr: signed, server })
  if (res.status !== 'SUCCESS') throw new Error(`The grant was not confirmed: ${res.status}.`)
  return {
    hash: res.hash,
    status: res.status,
    agentAddresses: built.agentAddresses,
    expiryLedger: built.expiryLedger,
  }
}

/**
 * Build the relayed router.pull(agent, amount) tx: source = relayer, the agent session key signs
 * ONLY the agent's auth entry (bare ed25519 BytesN<64>, what __check_auth expects). Mirrors
 * agentDeposit.buildAgentDeposit exactly (re-simulate WITH the signed entry so the enforcing-mode
 * footprint includes the agent contract). The owner's approval is already on-chain from the grant,
 * and the router → owner → agent transfer_from rides the router's implicit invoker auth.
 * @param {{agentAddress:string, amount:bigint, relayer:string, sessionKey:object, router?:string, server?:object}} p
 * @returns {Promise<{xdr:string}>}
 */
export async function buildAgentPull({
  agentAddress,
  amount,
  relayer,
  sessionKey,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  server,
}) {
  const s = server || (await rpcServer())
  const { tx } = await buildInvokeTx({
    source: relayer,
    contract: router,
    method: 'pull',
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
  const { TransactionBuilder } = await sdk()
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)
  const prepared = await s.prepareTransaction(signedTx)
  return { xdr: prepared.toEnvelope().toXDR('base64') }
}

/**
 * Full relayed pull: resolve the relayer, build + agent-sign, submit via the relay. null when the
 * relay is unconfigured (same contract as runAgentDeposit — caller decides the fallback).
 * @param {{agentAddress:string, amount:bigint, sessionKey:object, router?:string, server?:object}} p
 * @returns {Promise<{hash:string, status:string, relayer?:string}|null>}
 */
export async function runAgentPull({ agentAddress, amount, sessionKey, router, server }) {
  const relayer = await getRelayerAddress()
  if (!relayer) return null
  const { xdr } = await buildAgentPull({
    agentAddress,
    amount,
    relayer,
    sessionKey,
    router,
    server,
  })
  return submitViaRelay({ xdr })
}

/**
 * Current owner→router SEP-41 allowance. The SAC's `allowance(from, spender)` returns the
 * CURRENTLY-usable i128 — it already yields 0 once the ledger passes the allowance's
 * live_until_ledger, so `amount` alone is the authoritative "budget still spendable now" figure
 * (expiry folded in). live_until_ledger is not exposed by the public getter, hence null. A read
 * failure returns 0 — the safe side: the orchestrator then does a fresh grant rather than skipping
 * a needed one.
 * @param {{owner:string, router?:string, token?:string, server?:object}} p
 * @returns {Promise<{amount:bigint, liveUntilLedger:null}>}
 */
export async function readAllowance({
  owner,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  token = SOROBAN_TOKEN_ADDRESS,
  server,
}) {
  try {
    const amt = await readContract({
      contract: token,
      method: 'allowance',
      args: [{ addr: owner }, { addr: router }],
      server,
    })
    return { amount: BigInt(amt ?? 0), liveUntilLedger: null }
  } catch {
    return { amount: 0n, liveUntilLedger: null }
  }
}

/**
 * Kill switch — the owner sets the SEP-41 allowance back to 0. One user-signed wallet signature,
 * submitted DIRECTLY (not via the relay) so revocation still works when the relayer is down; that
 * independence is what backs the "user can revoke any time" guarantee (mirrors stellar/revoke.js).
 * expiration_ledger is a harmless current+1 (the SAC ignores it for a zero allowance).
 * @param {{owner:string, router?:string, token?:string, server?:object, sign?:Function}} p
 * @returns {Promise<{hash:string, status:string}>}
 */
export async function revokeGrant({
  owner,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  token = SOROBAN_TOKEN_ADDRESS,
  server,
  sign = signWithTimeout,
}) {
  const s = server || (await rpcServer())
  const latest = await s.getLatestLedger()
  const { xdr: unsigned } = await buildInvokeTx({
    source: owner,
    contract: token,
    method: 'approve',
    args: [{ addr: owner }, { addr: router }, { i128: 0n }, { u32: latest.sequence + 1 }],
    server: s,
  })
  const signed = await sign(unsigned, 'revoke grant')
  const res = await submitUserTx({ signedXdr: signed, server })
  if (res.status !== 'SUCCESS') throw new Error(`Revocation was not confirmed: ${res.status}.`)
  return res
}
