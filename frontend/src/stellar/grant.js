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
import { assertActiveOwner } from './activeAccount.js'
import { signReviewedTransaction } from './walletKit.js'
import { rpcServer, buildInvokeTx, readContract } from './client.js'
import { signAgentDepositEntries } from './agentDeposit.js'
import { getRelayerAddress, submitViaRelay } from './relay.js'
import { signWithTimeout } from './agentSetup.js'
import {
  resolveOwnerTxModel,
  submitOwnerAuthorizedTx,
  signOwnerAuthEntry,
} from './ownerAuthorization.js'
import {
  NETWORK_PASSPHRASE,
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  SOROBAN_TOKEN_ADDRESS,
  TX_TIMEBOUND_SECONDS,
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

function signReviewedOwnerEnvelope({ built, activeAccount, sign, label }) {
  if (activeAccount?.version !== 1) return sign(built.xdr, label)
  return signReviewedTransaction({
    xdr: built.xdr,
    activeAccount,
    reviewedTxHash: built.tx.hash().toString('hex'),
  })
}

// Soroban testnet closes a ledger about every 5 seconds. The grant sets the SEP-41 allowance
// expiry as a LEDGER number, so a wall-clock grant duration converts at this rate.
const SECONDS_PER_LEDGER = 5
// How long a relayed router.pull auth entry stays valid (~30 min at 5s ledgers) — mirrors agentDeposit.
const AUTH_TTL_LEDGERS = 360

/** `AgentInit.kind` — 0 = Deposit (`target` = vault). Mirrors funding_router/src/types.rs. */
export const AGENT_KIND_DEPOSIT = 0
/** `AgentInit.kind` — 1 = Bridge (`target` = TokenMessengerMinter; mint_recipient +
 * destination_domain required). Mirrors funding_router/src/types.rs. */
export const AGENT_KIND_BRIDGE = 1

/**
 * Encode one `AgentInit` (soroban/contracts/funding_router/src/types.rs, v2) as a Soroban struct
 * ScVal. `#[contracttype]` structs are ScMaps keyed by field NAME in lexicographic order, so the
 * on-wire key order MUST be: cap, destination_domain, expiry, kind, mint_recipient,
 * period_duration, salt, signer, target, token. structScVal sorts the keys itself, so the object
 * below is written in that order purely for readability — the sort is what actually guarantees
 * the encoding matches the Rust struct.
 * @param {{signer:Uint8Array|string, salt:Uint8Array|string, cap:bigint|number, token:string,
 *          target:string, kind:number, mintRecipient:Uint8Array|string,
 *          destinationDomain:number, periodDuration:bigint|number, expiry:bigint|number}} p
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function agentInitScVal({
  signer,
  salt,
  cap,
  token,
  target,
  kind,
  mintRecipient,
  destinationDomain,
  periodDuration,
  expiry,
}) {
  return structScVal({
    cap: i128ScVal(cap),
    destination_domain: u32ScVal(destinationDomain),
    expiry: u64ScVal(expiry),
    kind: u32ScVal(kind),
    mint_recipient: bytes32ScVal(mintRecipient),
    period_duration: u64ScVal(periodDuration),
    salt: bytes32ScVal(salt),
    signer: bytes32ScVal(signer),
    target: addrScVal(target),
    token: addrScVal(token),
  })
}

/**
 * Encode one `TokenBudget` (soroban/contracts/funding_router/src/types.rs) as a Soroban struct
 * ScVal. Lexicographic field order: budget, token.
 * @param {{budget:bigint|number, token:string}} p
 * @returns {import('@stellar/stellar-sdk').xdr.ScVal}
 */
export function tokenBudgetScVal({ budget, token }) {
  return structScVal({
    budget: i128ScVal(budget),
    token: addrScVal(token),
  })
}

/** 32 fresh random bytes — a per-agent deploy salt so re-grants never collide with old addresses. */
function randomSalt() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32))
}

/**
 * Build + simulate-assemble the ONE grant tx. `txSource` is the transaction's envelope source —
 * the owner itself for a classic G account, or a funded relayer G when the owner is a passkey C
 * account (which can never be a transaction source; see ownerAuthorization.js). The `grant` call's
 * `owner` ARGUMENT is unaffected either way — only WHO pays/sources the envelope changes. Returns
 * the assembled unsigned XDR plus the deployed agent addresses read from the pre-simulation
 * retval. The `deploy_v2` addresses are salt-derived and deterministic, so the simulated
 * `Vec<Address>` matches what submit produces.
 * @param {{owner:string, budgets:Array<{budget:bigint|number, token:string}>,
 *          durationSeconds:number, agentInits:Array<{signer:Uint8Array, salt?:Uint8Array,
 *          cap:bigint, token:string, target:string, kind:number,
 *          mintRecipient:Uint8Array|string, destinationDomain:number, periodDuration:number,
 *          expiry:number}>, router?:string, server?:object, txSource?:string}} p
 * @returns {Promise<{tx:object, xdr:string, agentAddresses:string[], expiryLedger:number,
 *          bridgeAgentAddress:string|null}>}
 */
export async function buildGrantTx({
  owner,
  budgets,
  durationSeconds,
  agentInits,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  server,
  txSource = owner,
}) {
  if (!router) throw new Error('The funding router is not configured.')
  if (!agentInits || agentInits.length === 0)
    throw new Error('The grant requires at least one agent.')
  const s = server || (await rpcServer())
  const { Contract, TransactionBuilder, BASE_FEE } = await sdk()

  const latest = await s.getLatestLedger()
  const expiryLedger = latest.sequence + Math.ceil(durationSeconds / SECONDS_PER_LEDGER)

  const budgetsVec = xdr.ScVal.scvVec(budgets.map(tokenBudgetScVal))

  const encoded = agentInits.map((a) =>
    agentInitScVal({
      signer: a.signer,
      salt: a.salt || randomSalt(),
      cap: a.cap,
      token: a.token,
      target: a.target,
      kind: a.kind,
      mintRecipient: a.mintRecipient,
      destinationDomain: a.destinationDomain,
      periodDuration: a.periodDuration,
      expiry: a.expiry,
    })
  )
  const agentsVec = xdr.ScVal.scvVec(encoded)

  const account = await s.getAccount(txSource)
  const raw = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(router).call(
        'grant',
        addrScVal(owner),
        budgetsVec,
        u32ScVal(expiryLedger),
        agentsVec
      )
    )
    // The grant is the ONE tx a human reads before signing — its timebound must outlive the
    // 120s the wallet path allows for that read. See TX_TIMEBOUND_SECONDS.
    .setTimeout(TX_TIMEBOUND_SECONDS)
    .build()

  // Simulate FIRST to capture the retval (Vec<Address> of the to-be-deployed agents).
  const sim = await s.simulateTransaction(raw)
  if (sim.error || !sim.result)
    throw new Error(`Grant simulation failed: ${sim.error || 'no result'}`)
  const agentAddresses = fromScVal(sim.result.retval)
  // Additive: when the LAST submitted agent is a Bridge-kind init, name its deployed address
  // explicitly — callers that folded a bridge agent onto the end of their `agents` array (the
  // funding_router deploy order mirrors input order) get it without re-deriving which index it was.
  // null whenever the grant deployed deposit-only agents, so existing callers see no change.
  const lastInit = agentInits[agentInits.length - 1]
  const bridgeAgentAddress =
    lastInit?.kind === AGENT_KIND_BRIDGE ? agentAddresses[agentAddresses.length - 1] : null

  // …then prepare (simulate + assemble, sets the resource fee). We do NOT re-prepare after signing:
  // the owner's tx-envelope signature covers footprint + resources, so a post-sign re-prepare would
  // invalidate it. (The re-prepare-after-sign trick is only for the agent ed25519 auth-entry path,
  // whose signature excludes the footprint — see buildAgentPull below.)
  const tx = await s.prepareTransaction(raw)
  return {
    tx,
    xdr: tx.toEnvelope().toXDR('base64'),
    agentAddresses,
    expiryLedger,
    bridgeAgentAddress,
  }
}

/**
 * Full single-signature grant: build → authorize (wallet-sign for G, passkey auth entry for C) →
 * submit, routed through OwnerAuthorizationV1 (ownerAuthorization.js). A G owner prefers the relay
 * fee-bump (the relay allowlists router.grant, so the user pays 0 XLM) and safely falls back to a
 * direct user-paid submit only when the relay is unreachable. A C owner (passkey smart account)
 * can never source a classic transaction at all — its grant is sourced by a funded relayer G and
 * authorized via a Soroban auth entry, relay-only, with no user-funded fallback.
 * `activeAccount` defaults to a classic G owner, so every existing G-only caller is unaffected.
 * @param {{owner:string, budgets:Array<{budget:bigint|number, token:string}>,
 *          durationSeconds:number, agentInits:Array, router?:string, server?:object,
 *          sign?:Function, activeAccount?:{kind:'G'|'C', address:string},
 *          getRelayerAddress?:Function, kit?:object}} p
 * @returns {Promise<{hash:string, status:string, relayer?:string, agentAddresses:string[],
 *          expiryLedger:number, bridgeAgentAddress:string|null}>}
 */
export async function submitGrant({
  owner,
  budgets,
  durationSeconds,
  agentInits,
  router,
  server,
  sign = signWithTimeout,
  activeAccount = { kind: 'G', address: owner },
  getRelayerAddress: getRelayer = getRelayerAddress,
  kit,
}) {
  assertActiveOwner({ owner, activeAccount })
  const model = await resolveOwnerTxModel({ owner, activeAccount, getRelayerAddress: getRelayer })
  const built = await buildGrantTx({
    owner,
    budgets,
    durationSeconds,
    agentInits,
    router,
    server,
    txSource: model.source,
  })
  const result = await submitOwnerAuthorizedTx({
    model,
    build: async () => built,
    sign:
      model.kind === 'G'
        ? async () => signReviewedOwnerEnvelope({ built, activeAccount, sign, label: 'grant' })
        : async () =>
            signOwnerAuthEntry({ tx: built.tx, contractId: model.contractId, server, kit }),
    server,
    label: 'grant',
    classicSubmission: 'prefer-relay',
  })
  if (result.status !== 'SUCCESS') {
    throw new Error(
      result.channel === 'relay'
        ? `The grant relay returned ${result.status}.`
        : `The grant was not confirmed: ${result.status}.`
    )
  }
  return {
    hash: result.hash,
    status: result.status,
    relayer: result.relayer,
    agentAddresses: built.agentAddresses,
    expiryLedger: built.expiryLedger,
    bridgeAgentAddress: built.bridgeAgentAddress,
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
  assertActiveOwner({ owner, activeAccount })
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

/** The relay was reachable and REFUSED this transaction — distinct from `readAllowance`'s
 * deliberate swallow-to-zero. Task 5's proof-carrying preflight (allowanceProof.js) must never
 * mistake "the RPC did not answer" for "the owner set the allowance to zero"; those demand
 * opposite outcomes (retry/unproven vs. a legitimately drained budget). */
export class AllowanceReadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AllowanceReadError'
  }
}

/**
 * Strict current owner→router SEP-41 allowance read for the proof-carrying preflight
 * (allowanceProof.proveCurrentAllowance). Unlike `readAllowance` (whose 0-on-failure is the
 * right default for "should I bother the user with a grant popup"), a proof MUST distinguish a
 * confirmed zero allowance from "the RPC did not answer" — so this throws `AllowanceReadError`
 * on any read failure instead of coercing it to 0.
 * @param {{owner:string, router?:string, token?:string, server?:object}} p
 * @returns {Promise<{amount:bigint}>}
 */
export async function readAllowanceStrict({
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
    return { amount: BigInt(amt ?? 0) }
  } catch (err) {
    throw new AllowanceReadError(`Current allowance read failed: ${err?.message || err}`)
  }
}

/**
 * Read the confirmed ledger sequence + ledger close time of a submitted transaction — the ONLY
 * legitimate source for `GrantReceiptV1.confirmedAt` (never `Date.now()`, a browser clock the
 * chain never agreed to). Throws rather than returning a partial/fabricated receipt when the tx
 * is not confirmed SUCCESS, or when the RPC response is missing the ledger/createdAt fields a
 * confirmed transaction is expected to carry.
 * @param {{hash:string, server?:object}} p
 * @returns {Promise<{confirmedLedger:number, confirmedAt:number}>}
 */
export async function readConfirmedLedger({ hash, server }) {
  const s = server || (await rpcServer())
  const res = await s.getTransaction(hash)
  if (res.status !== 'SUCCESS')
    throw new Error(`Transaction ${hash} is not confirmed: ${res.status}.`)
  const confirmedLedger = Number(res.ledger)
  const confirmedAt = Number(res.createdAt)
  if (!Number.isFinite(confirmedLedger) || !Number.isFinite(confirmedAt))
    throw new Error(`Confirmed transaction ${hash} is missing ledger/createdAt from the RPC.`)
  return { confirmedLedger, confirmedAt }
}

/**
 * Kill switch — the owner sets the SEP-41 router allowance back to 0, routed through
 * OwnerAuthorizationV1. A classic G owner signs the envelope and submits DIRECTLY (never via the
 * relay) so revocation still works when the relayer is down — that independence is what backs the
 * "user can revoke any time" guarantee (mirrors stellar/revoke.js's agent kill switch). A passkey
 * C owner can never source that envelope at all, so it signs a Soroban auth entry on a
 * relayer-sourced tx and submits relay-only (no user-funded fallback — see ownerAuthorization.js).
 * `activeAccount` defaults to a classic G owner, so every existing caller is unaffected.
 * expiration_ledger is a harmless current+1 (the SAC ignores it for a zero allowance).
 * @param {{owner:string, router?:string, token?:string, server?:object, sign?:Function,
 *          activeAccount?:{kind:'G'|'C', address:string}, getRelayerAddress?:Function,
 *          kit?:object}} p
 * @returns {Promise<{hash:string, status:string}>}
 */
export async function revokeGrant({
  owner,
  router = SOROBAN_FUNDING_ROUTER_ADDRESS,
  token = SOROBAN_TOKEN_ADDRESS,
  server,
  sign = signWithTimeout,
  activeAccount = { kind: 'G', address: owner },
  getRelayerAddress: getRelayer = getRelayerAddress,
  kit,
}) {
  const s = server || (await rpcServer())
  const model = await resolveOwnerTxModel({ owner, activeAccount, getRelayerAddress: getRelayer })
  const latest = await s.getLatestLedger()
  const built = await buildInvokeTx({
    source: model.source,
    contract: token,
    method: 'approve',
    args: [{ addr: owner }, { addr: router }, { i128: 0n }, { u32: latest.sequence + 1 }],
    server: s,
  })
  const res = await submitOwnerAuthorizedTx({
    model,
    build: async () => built,
    sign:
      model.kind === 'G'
        ? async () => signReviewedOwnerEnvelope({
            built,
            activeAccount,
            sign,
            label: 'revoke grant',
          })
        : async () =>
            signOwnerAuthEntry({ tx: built.tx, contractId: model.contractId, server: s, kit }),
    server: s,
    label: 'revoke grant',
    classicSubmission: 'direct',
  })
  if (res.status !== 'SUCCESS') throw new Error(`Revocation was not confirmed: ${res.status}.`)
  return { hash: res.hash, status: res.status }
}
