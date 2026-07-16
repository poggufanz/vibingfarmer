// frontend/src/stellar/exit.js
// Owner exit — sweep the run's agents back to the user.
//
// `sweepAgents` is the exit-side twin of grant.js: ONE tx, ONE wallet signature, N agents. Soroban
// allows a single host-function invocation per transaction, so batching N `owner_withdraw` calls
// needs a contract to do the batching — exit_router.sweep. Because the tx source IS the owner,
// the owner.require_auth() in sweep AND the one inside every agent's owner_withdraw are all
// satisfied by SOURCE-ACCOUNT credentials, so signing the envelope covers the whole auth tree:
// one popup, however many agents. (Exactly how router.grant covers its nested token.approve.)
//
// `ownerWithdraw` is the single-agent primitive underneath, kept as the rollback path for when
// the exit router is not configured — N agents, N popups, which is what this file used to be.
import { xdr } from '@stellar/stellar-sdk'
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import { SOROBAN_EXIT_ROUTER_ADDRESS } from './config.js'
import { addrScVal, fromScVal } from './scval.js'

// How many agents to attempt per sweep transaction. Measured live on testnet: 5 agents fit the
// transaction budget, 6 raise Error(Budget, ExceededLimit). It is a starting guess, not a law —
// each owner_withdraw redeems through Blend, whose cost moves with pool state, so the real
// ceiling drifts. `sweepChunk` halves on the budget error rather than trusting this number.
export const MAX_AGENTS_PER_SWEEP = 5

// A blown resource budget is NOT a recoverable contract error: the host refuses the whole
// invocation, so an over-large sweep moves nothing at all rather than partially succeeding.
const isBudgetError = (e) => /Budget|ExceededLimit|ResourceLimitExceeded/i.test(e?.message || '')

/**
 * Sweep one batch in ONE transaction, writing each agent's result into `out` (indexed by its
 * position in the caller's full list). Halves and retries on a budget overrun: simulation raises
 * that inside buildInvokeTx, BEFORE any signature, so shrinking costs the user nothing.
 */
async function sweepChunk({ owner, agents, to, router, server, sign, out }) {
  try {
    const { xdr: unsigned } = await buildInvokeTx({
      source: owner,
      contract: router,
      method: 'sweep',
      args: [
        { addr: owner },
        xdr.ScVal.scvVec(agents.map((a) => addrScVal(a.address))),
        { addr: to },
      ],
      server,
    })
    const signed = await sign(unsigned)
    const res = await submitUserTx({ signedXdr: signed, server })
    // Callers zero the position on resolve, so an unconfirmed exit must not resolve.
    if (res.status !== 'SUCCESS') throw new Error(`The exit was not confirmed: ${res.status}.`)
    // No retval on a SUCCESS is not "0 swept" — it means we cannot tell what moved, and leaving
    // the zeros in place is the honest read. The position reconciles from chain either way.
    const swept = res.returnValue ? fromScVal(res.returnValue) : []
    agents.forEach((a, i) => {
      out.swept[a.index] = BigInt(swept[i] ?? 0)
      out.txHashes[a.index] = res.hash
    })
  } catch (e) {
    if (agents.length > 1 && isBudgetError(e)) {
      const mid = Math.ceil(agents.length / 2)
      await sweepChunk({ owner, agents: agents.slice(0, mid), to, router, server, sign, out })
      await sweepChunk({ owner, agents: agents.slice(mid), to, router, server, sign, out })
      return
    }
    // One batch failing must not strand the others — record why, per agent, and let the rest run.
    // The reason has to reach the caller: "the agent was empty" and "the RPC dropped the tx" look
    // identical from a 0, and only one of them is worth retrying.
    const reason = e?.message || String(e)
    agents.forEach((a) => {
      out.errors[a.index] = reason
    })
  }
}

/**
 * Sweep EVERY agent back to `to`, in as few user-signed transactions as the chain allows — ONE
 * for a normal run, which is the whole point: the deposit costs one signature, so the exit does
 * too. Only a position spread over more agents than fit a single transaction's budget needs more,
 * and then it is ceil(N / ~5) signatures rather than N.
 *
 * Returns, positionally per `agentAddresses`: the amount that agent gave up (0 = it had nothing,
 * or refused — revoked, expired, not ours), the transaction that swept it, and the chain's own
 * reason when its batch failed. Always resolves — a batch that failed is reported, not thrown, so
 * one dead agent reads the same here as it does on the per-agent path.
 * @param {{owner:string, agentAddresses:string[], to?:string, router?:string, server?:object,
 *          chunkSize?:number, sign?:Function}} p
 * @returns {Promise<{swept:bigint[], txHashes:string[], errors:(string|undefined)[]}>}
 */
export async function sweepAgents({
  owner,
  agentAddresses,
  to,
  router = SOROBAN_EXIT_ROUTER_ADDRESS,
  server,
  chunkSize = MAX_AGENTS_PER_SWEEP,
  sign = signTxXdr,
}) {
  if (!router) throw new Error('The exit router is not configured.')
  if (!agentAddresses?.length) throw new Error('sweepAgents requires at least one agentAddress.')
  const out = {
    swept: agentAddresses.map(() => 0n),
    txHashes: agentAddresses.map(() => undefined),
    errors: agentAddresses.map(() => undefined),
  }
  const indexed = agentAddresses.map((address, index) => ({ address, index }))
  for (let i = 0; i < indexed.length; i += chunkSize) {
    await sweepChunk({
      owner,
      agents: indexed.slice(i, i + chunkSize),
      to: to || owner,
      router,
      server,
      sign,
      out,
    })
  }
  return out
}

/** owner_withdraw(to) on the agent account — user-signed; redeems + sweeps to `to`. */
export async function ownerWithdraw({ owner, agentAddress, to }) {
  // By-agent, not by-vault: naming the wrong agent is not a harmless no-op, it invokes an account
  // the caller may not own. Never let a caller reach the chain without saying which agent.
  if (!agentAddress) throw new Error('ownerWithdraw requires an agentAddress.')
  const { xdr: unsigned } = await buildInvokeTx({
    source: owner,
    contract: agentAddress,
    method: 'owner_withdraw',
    args: [{ addr: to || owner }],
  })
  const signed = await signTxXdr(unsigned)
  const res = await submitUserTx({ signedXdr: signed })
  // Callers zero the position on resolve, so an unconfirmed exit must not resolve.
  if (res.status !== 'SUCCESS') throw new Error(`The exit was not confirmed: ${res.status}.`)
  return res
}
