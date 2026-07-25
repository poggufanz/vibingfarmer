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
import { buildInvokeTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import { getRelayerAddress } from './relay.js'
import { SOROBAN_EXIT_ROUTER_ADDRESS } from './config.js'
import { addrScVal, fromScVal } from './scval.js'
import {
  resolveOwnerTxModel,
  submitOwnerAuthorizedTx,
  signOwnerAuthEntry,
  OwnerActionSubmissionError,
} from './ownerAuthorization.js'

// How many agents to attempt per sweep transaction. Calibrated live TWICE, and the numbers
// disagree: freshly deposited agents (funds still idle in the vault) fit 5 per tx, but the case
// that actually matters — funds the keeper long since compounded into Blend — pays for a full
// strategy unwind per agent, and the 2026-07-16 production session measured 5 AND 4 both blowing
// Error(Budget, ExceededLimit) while 3 landed. Calibrate for the expensive case: the cheap case
// merely costs one more (cheap) transaction, the expensive case costs failed simulations and
// extra popups. Still a guess, not a law — sweepChunk halves on the budget error regardless.
export const MAX_AGENTS_PER_SWEEP = 3

// A blown resource budget is NOT a recoverable contract error: the host refuses the whole
// invocation, so an over-large sweep moves nothing at all rather than partially succeeding.
const isBudgetError = (e) => /Budget|ExceededLimit|ResourceLimitExceeded/i.test(e?.message || '')

/** G signs the envelope directly (via the injectable `sign`, default signTxXdr — the wallet-kit
 *  popup); a C owner signs a Soroban auth entry sourced by the relayer. */
function ownerSign({ built, model, server, kit, sign = signTxXdr }) {
  return model.kind === 'G'
    ? sign(built.xdr)
    : signOwnerAuthEntry({ tx: built.tx, contractId: model.contractId, server, kit })
}

/**
 * Sweep one batch in ONE transaction, writing each agent's result into `out` (indexed by its
 * position in the caller's full list). Halves and retries on a budget overrun: simulation raises
 * that inside buildInvokeTx, BEFORE any signature, so shrinking costs the user nothing.
 */
async function sweepChunk({ agents, to, router, server, model, kit, sign, out }) {
  try {
    const result = await submitOwnerAuthorizedTx({
      model,
      build: () =>
        buildInvokeTx({
          source: model.source,
          contract: router,
          method: 'sweep',
          args: [
            { addr: model.owner },
            xdr.ScVal.scvVec(agents.map((a) => addrScVal(a.address))),
            { addr: to },
          ],
          server,
        }),
      sign: (built) => ownerSign({ built, model, server, kit, sign }),
      server,
      label: 'exit sweep',
      classicSubmission: 'direct',
      // 60s confirmation budget. Live sweeps have taken ~25s ledger-to-ledger, and the default
      // 20s poll declared a tx failed that went on to land — the UI then reported agents as
      // stranded whose funds were already in the owner's wallet.
      pollTries: 30,
    })
    // Callers zero the position on resolve, so an unconfirmed exit must not resolve. Only an
    // explicit FAILED is the chain's own word that the tx did not land — a genuine confirmed
    // failure. Fix 1 (fix loop 2): anything else (PENDING and friends) means the confirmation poll
    // ran out before we SAW an outcome, which is not proof of failure — reporting it as one is the
    // exact incident exit.js's own comment above (~line 71) documents happening for real.
    if (result.status !== 'SUCCESS') {
      if (result.status === 'FAILED')
        throw new Error(`The exit was not confirmed: ${result.status}.`)
      throw new OwnerActionSubmissionError(
        `The exit was not confirmed: ${result.status}. Check the chain before retrying.`,
        'VF_SUBMISSION_UNKNOWN',
        'unknown'
      )
    }
    // No retval on a SUCCESS is not "0 swept" — it means we cannot tell what moved, and leaving
    // the zeros in place is the honest read. The position reconciles from chain either way.
    const swept = result.returnValue ? fromScVal(result.returnValue) : []
    agents.forEach((a, i) => {
      out.txHashes[a.index] = result.hash
      const decoded = swept[i]
      if (decoded == null) {
        // Fix 2 (fix loop 2): a missing slot (no retval at all, or a vec shorter than this batch)
        // is the SAME "cannot tell what moved" gap the comment above already calls out — never the
        // chain proving this agent swept zero. Mark it, or agentController.js's fallback default
        // string (no `.submission`) swallows it into a confirmed failure indistinguishable from a
        // genuinely empty agent.
        out.swept[a.index] = 0n
        out.errors[a.index] = {
          message: "The sweep confirmed on-chain, but this agent's own result could not be decoded.",
          code: 'VF_SUBMISSION_UNKNOWN',
          submission: 'unknown',
        }
        return
      }
      out.swept[a.index] = BigInt(decoded)
    })
  } catch (e) {
    if (agents.length > 1 && isBudgetError(e)) {
      const mid = Math.ceil(agents.length / 2)
      await sweepChunk({ agents: agents.slice(0, mid), to, router, server, model, kit, sign, out })
      await sweepChunk({ agents: agents.slice(mid), to, router, server, model, kit, sign, out })
      return
    }
    // One batch failing must not strand the others — record why, per agent, and let the rest run.
    // The reason has to reach the caller: "the agent was empty" and "the RPC dropped the tx" look
    // identical from a 0, and only one of them is worth retrying. `code`/`submission` ride along
    // too (undefined for a bare on-chain Error) — a post-sign relay loss is an
    // OwnerActionSubmissionError (ownerAuthorization.js) with `code:'VF_SUBMISSION_UNKNOWN'` and
    // `submission:'unknown'`, and money/ownerActions.js's ownerActionOutcome reads exactly these
    // fields to keep that case distinct from a genuine confirmed failure. Fix 1 (fix loop 1): this
    // used to flatten to a bare string here, which erased that distinction before any consumer
    // could see it.
    const reason = e?.message || String(e)
    agents.forEach((a) => {
      out.errors[a.index] = { message: reason, code: e?.code, submission: e?.submission }
    })
  }
}

/**
 * Sweep EVERY agent back to `to`, in as few owner-authorized transactions as the chain allows —
 * ONE for a normal run, which is the whole point: the deposit costs one signature, so the exit
 * does too. Only a position spread over more agents than fit a single transaction's budget needs
 * more, and then it is ceil(N / ~3) signatures rather than N. Routed through OwnerAuthorizationV1:
 * a classic G owner signs the envelope and submits directly (the kill switch must keep working
 * with the relay down); a passkey C owner signs a Soroban auth entry sourced by a funded relayer G
 * and submits relay-only (no user-funded fallback — see ownerAuthorization.js).
 *
 * Returns, positionally per `agentAddresses`: the amount that agent gave up (0 = it had nothing,
 * or refused — revoked, expired, not ours), the transaction that swept it, and the chain's own
 * reason when its batch failed. Always resolves — a batch that failed is reported, not thrown, so
 * one dead agent reads the same here as it does on the per-agent path.
 * @param {{owner:string, agentAddresses:string[], to?:string, router?:string, server?:object,
 *          chunkSize?:number, activeAccount?:{kind:'G'|'C', address:string},
 *          getRelayerAddress?:Function, kit?:object, sign?:Function}} p sign is the G-envelope
 *          signer (default signTxXdr, the wallet-kit popup) — injectable so callers off the
 *          browser (e.g. scripts/exit-router-smoke.mjs) can sign with a local keypair instead.
 *          Unused for a C owner, which always signs via the passkey ceremony.
 * @returns {Promise<{swept:bigint[], txHashes:string[],
 *   errors:({message:string, code?:string, submission?:string}|undefined)[]}>} `errors[i].code`/
 *   `.submission` carry an OwnerActionSubmissionError's channel classification through undamaged
 *   (undefined for a bare on-chain failure) — money/ownerActions.js's ownerActionOutcome reads them.
 */
export async function sweepAgents({
  owner,
  agentAddresses,
  to,
  router = SOROBAN_EXIT_ROUTER_ADDRESS,
  server,
  chunkSize = MAX_AGENTS_PER_SWEEP,
  activeAccount = { kind: 'G', address: owner },
  getRelayerAddress: getRelayer = getRelayerAddress,
  kit,
  sign = signTxXdr,
}) {
  if (!router) throw new Error('The exit router is not configured.')
  if (!agentAddresses?.length) throw new Error('sweepAgents requires at least one agentAddress.')
  const model = await resolveOwnerTxModel({ owner, activeAccount, getRelayerAddress: getRelayer })
  const out = {
    swept: agentAddresses.map(() => 0n),
    txHashes: agentAddresses.map(() => undefined),
    errors: agentAddresses.map(() => undefined),
  }
  const indexed = agentAddresses.map((address, index) => ({ address, index }))
  for (let i = 0; i < indexed.length; i += chunkSize) {
    await sweepChunk({
      agents: indexed.slice(i, i + chunkSize),
      to: to || owner,
      router,
      server,
      model,
      kit,
      sign,
      out,
    })
  }
  return out
}

/**
 * owner_withdraw(to) on the agent account — routed through OwnerAuthorizationV1 (see sweepAgents'
 * docstring for the G-direct vs C-relay-only split). Redeems + sweeps the agent's full position
 * to `to`.
 * @param {{owner:string, agentAddress:string, to?:string, activeAccount?:{kind:'G'|'C', address:string},
 *          getRelayerAddress?:Function, kit?:object, server?:object}} p
 */
export async function ownerWithdraw({
  owner,
  agentAddress,
  to,
  activeAccount = { kind: 'G', address: owner },
  getRelayerAddress: getRelayer = getRelayerAddress,
  kit,
  server,
}) {
  // By-agent, not by-vault: naming the wrong agent is not a harmless no-op, it invokes an account
  // the caller may not own. Never let a caller reach the chain without saying which agent.
  if (!agentAddress) throw new Error('ownerWithdraw requires an agentAddress.')
  const model = await resolveOwnerTxModel({ owner, activeAccount, getRelayerAddress: getRelayer })
  const result = await submitOwnerAuthorizedTx({
    model,
    build: () =>
      buildInvokeTx({
        source: model.source,
        contract: agentAddress,
        method: 'owner_withdraw',
        args: [{ addr: to || owner }],
        server,
      }),
    sign: (built) => ownerSign({ built, model, server, kit }),
    server,
    label: 'exit',
    classicSubmission: 'direct',
  })
  // Callers zero the position on resolve, so an unconfirmed exit must not resolve. Same FAILED-vs-
  // everything-else split as sweepChunk above (Fix 1, fix loop 2): only an explicit FAILED is a
  // confirmed failure; anything else is an unproven outcome, not a lie that it failed.
  if (result.status !== 'SUCCESS') {
    if (result.status === 'FAILED') throw new Error(`The exit was not confirmed: ${result.status}.`)
    throw new OwnerActionSubmissionError(
      `The exit was not confirmed: ${result.status}. Check the chain before retrying.`,
      'VF_SUBMISSION_UNKNOWN',
      'unknown'
    )
  }
  return result
}
