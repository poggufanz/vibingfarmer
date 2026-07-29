import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn(async () => ({ xdr: 'BUILT' })),
  submitUserTx: vi.fn(async () => ({ hash: 'h1', status: 'SUCCESS' })),
}))
const signReviewedTransactionMock = vi.fn(async () => 'SIGNED_REVIEWED')
vi.mock('./walletKit.js', () => ({
  signTxXdr: vi.fn(async () => 'SIGNED'),
  signReviewedTransaction: (...a) => signReviewedTransactionMock(...a),
  getActiveAccount: vi.fn(),
}))
const submitViaRelayMock = vi.fn()
const getRelayerAddressMock = vi.fn()
vi.mock('./relay.js', () => ({
  submitViaRelay: (...a) => submitViaRelayMock(...a),
  getRelayerAddress: (...a) => getRelayerAddressMock(...a),
  RelayRejectedError: class RelayRejectedError extends Error {},
}))
const signOwnerAuthEntryMock = vi.fn()
vi.mock('./ownerAuthorization.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, signOwnerAuthEntry: (...a) => signOwnerAuthEntryMock(...a) }
})

import { xdr, Keypair } from '@stellar/stellar-sdk'
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'
import { ownerWithdraw, sweepAgents } from './exit.js'
import { i128ScVal } from './scval.js'
// Fix 1 (fix loop 1): closes the loop from a real thrown OwnerActionSubmissionError, through
// sweepChunk's catch and out.errors, all the way to ownerActionOutcome — the exact path that used
// to flatten a post-sign relay loss into a string and lose it.
import { ownerActionOutcome } from '../money/ownerActions.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const OWNER_C = 'CCDXZ6BUA7TPR3EXQWJWUD7EYR6OUMJRYIKYXPE53HRJOJFY5CXEHTN5'
const RELAYER_G = Keypair.random().publicKey() // any well-formed G — never asserted by value
const AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT2 = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const ROUTER = 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J'
const ACTIVE_G = Object.freeze({
  version: 1,
  kind: 'G',
  address: OWNER,
  networkPassphrase: 'Test SDF Network ; September 2015',
  connectorId: 'freighter',
  epoch: 41,
})

/** A `sweep` retval as the chain sends it: Vec<i128> of the amount each agent gave up. */
const sweptScVal = (amounts) => xdr.ScVal.scvVec(amounts.map((a) => i128ScVal(a)))

beforeEach(() => {
  buildInvokeTx.mockReset()
  buildInvokeTx.mockResolvedValue({ xdr: 'BUILT' })
  submitUserTx.mockReset()
  submitUserTx.mockResolvedValue({ hash: 'h1', status: 'SUCCESS' })
  submitViaRelayMock.mockReset()
  getRelayerAddressMock.mockReset()
  signOwnerAuthEntryMock.mockReset()
  signReviewedTransactionMock.mockClear()
  signTxXdr.mockClear()
})

describe('ownerWithdraw', () => {
  it('invokes owner_withdraw on the AGENT contract, sourced by the owner', async () => {
    await ownerWithdraw({ owner: OWNER, agentAddress: AGENT, to: OWNER })
    expect(buildInvokeTx).toHaveBeenCalledWith(
      expect.objectContaining({ source: OWNER, contract: AGENT, method: 'owner_withdraw' })
    )
  })

  it('requires an agentAddress rather than sweeping an implicit default', async () => {
    // owner_withdraw is by-agent: a wrong agent is not a no-op, it is a call against an account
    // the user does not own. Missing must be loud, never defaulted.
    await expect(ownerWithdraw({ owner: OWNER, to: OWNER })).rejects.toThrow(/agentAddress/i)
    expect(submitUserTx).not.toHaveBeenCalled()
  })

  it('throws when the exit tx is not confirmed SUCCESS', async () => {
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'PENDING' })
    await expect(ownerWithdraw({ owner: OWNER, agentAddress: AGENT, to: OWNER })).rejects.toThrow(
      /not confirmed/i
    )
  })

  it('Fix 1 (fix loop 2): a PENDING poll-exhaustion throws OwnerActionSubmissionError(unknown), not a bare Error', async () => {
    // The poll ran out before we SAW an outcome — that is not proof the exit failed, and a bare
    // Error here (undefined code/submission) is exactly what used to report a landed transaction
    // as failed (the incident exit.js:71-73 documents).
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'PENDING' })
    await expect(
      ownerWithdraw({ owner: OWNER, agentAddress: AGENT, to: OWNER })
    ).rejects.toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' })
  })

  it('Fix 1 (fix loop 2): an explicit FAILED status still throws a bare confirmed failure, never unknown', async () => {
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'FAILED' })
    const err = await ownerWithdraw({ owner: OWNER, agentAddress: AGENT, to: OWNER }).catch(
      (e) => e
    )
    expect(err.message).toMatch(/not confirmed/i)
    expect(err.code).toBeUndefined()
    expect(err.submission).toBeUndefined()
  })

  it('returns the hash and status on a confirmed exit', async () => {
    const out = await ownerWithdraw({ owner: OWNER, agentAddress: AGENT, to: OWNER })
    expect(out).toMatchObject({ hash: 'h1', status: 'SUCCESS' })
  })

  it('C owner: sources from the relayer, signs a passkey auth entry, relay-only', async () => {
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C')
    submitViaRelayMock.mockResolvedValue({ hash: 'hc1', status: 'SUCCESS' })

    const out = await ownerWithdraw({
      owner: OWNER_C,
      agentAddress: AGENT,
      to: OWNER_C,
      activeAccount: { kind: 'C', address: OWNER_C },
    })

    expect(buildInvokeTx).toHaveBeenCalledWith(
      expect.objectContaining({ source: RELAYER_G, contract: AGENT, method: 'owner_withdraw' })
    )
    expect(signOwnerAuthEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: OWNER_C })
    )
    expect(submitUserTx).not.toHaveBeenCalled()
    expect(out).toMatchObject({ hash: 'hc1', status: 'SUCCESS' })
  })
})

describe('sweepAgents', () => {
  const AGENTS = [AGENT, AGENT2]
  /** N distinct-enough agent addresses — only their identity matters to these tests. */
  const manyAgents = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? AGENT2 : AGENT))

  it('sweeps N agents through ONE exit_router invocation sourced by the owner', async () => {
    // One invocation = one envelope = one wallet popup, however many agents. This is the whole
    // reason the contract exists; per-agent calls are what it replaces.
    submitUserTx.mockResolvedValueOnce({
      hash: 'sweep1',
      status: 'SUCCESS',
      returnValue: sweptScVal([50_000_000n, 20_000_000n]),
    })
    const out = await sweepAgents({
      owner: OWNER,
      agentAddresses: AGENTS,
      to: OWNER,
      router: ROUTER,
    })

    expect(submitUserTx).toHaveBeenCalledTimes(1)
    const call = buildInvokeTx.mock.calls[0][0]
    expect(call).toMatchObject({ source: OWNER, contract: ROUTER, method: 'sweep' })
    // args = (owner, Vec<Address> agents, to) — the agent vec is a raw ScVal, encodeArgs passes it through.
    expect(call.args).toHaveLength(3)
    expect(call.args[1].vec()).toHaveLength(2)
    expect(out.swept).toEqual([50_000_000n, 20_000_000n])
    expect(out.txHashes).toEqual(['sweep1', 'sweep1'])
  })

  it('uses an injected sign (e.g. a script signing off-browser) instead of the wallet-kit default', async () => {
    // Regression: sign used to be silently dropped, so scripts/exit-router-smoke.mjs's local-
    // keypair signer (and its popup count, the script's whole assertion) went unused.
    submitUserTx.mockResolvedValueOnce({
      hash: 'sweep1',
      status: 'SUCCESS',
      returnValue: sweptScVal([50_000_000n, 20_000_000n]),
    })
    const sign = vi.fn(async (x) => `SIGNED_INJECTED:${x}`)
    await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, to: OWNER, router: ROUTER, sign })
    expect(sign).toHaveBeenCalledTimes(1)
    expect(submitUserTx).toHaveBeenCalledWith(
      expect.objectContaining({ signedXdr: 'SIGNED_INJECTED:BUILT' })
    )
    expect(signTxXdr).not.toHaveBeenCalled()
  })

  it('decodes a partial sweep as the zeros the chain reported', async () => {
    submitUserTx.mockResolvedValueOnce({
      hash: 'sweep1',
      status: 'SUCCESS',
      returnValue: sweptScVal([50_000_000n, 0n]),
    })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([50_000_000n, 0n])
    // Fix 2 (fix loop 2): a PROVEN zero (the chain's own vec says 0 for this agent) gets no error —
    // only a MISSING slot does. Collapsing the two was the bug; this guards they stay apart.
    expect(out.errors).toEqual([undefined, undefined])
  })

  it('reports zeros rather than guessing when the chain returns no retval', async () => {
    submitUserTx.mockResolvedValueOnce({ hash: 'sweep1', status: 'SUCCESS' })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([0n, 0n])
  })

  it('Fix 2 (fix loop 2): marks a missing per-agent retval slot as undecodable, so ownerActionOutcome reads it as unknown, never confirmed-failed', async () => {
    // exit.js's own comment already says a SUCCESS with no retval means "we cannot tell what
    // moved" — before Fix 2 that landed as a bare 0 with NO error, indistinguishable from the
    // chain proving this agent swept zero. agentController.js's fallback default string (no
    // `.submission`) then read it as a confirmed failure it never was.
    submitUserTx.mockResolvedValueOnce({ hash: 'sweep1', status: 'SUCCESS' })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([0n, 0n])
    expect(out.errors[0]).toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' })
    expect(out.errors[1]).toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' })
    const outcome = ownerActionOutcome({ agentAddress: AGENT, ok: false, error: out.errors[0] })
    expect(outcome.outcome).toBe('unknown')
  })

  it('never reports an unconfirmed sweep as swept', async () => {
    // Callers zero the position on a swept amount, so a tx we have not SEEN confirm must not
    // produce one — but the reason still has to reach the user rather than vanish into a 0.
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'PENDING' })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([0n, 0n])
    expect(out.errors[0].message).toMatch(/not confirmed/i)
  })

  it('Fix 1 (fix loop 2): G owner — a PENDING poll-exhaustion carries VF_SUBMISSION_UNKNOWN through out.errors, and ownerActionOutcome reads it as unknown, never confirmed-failed', async () => {
    // The G-owner mirror of the existing C-owner regression test below: a G owner exits several
    // agents, the sweep is submitted, and ledger congestion pushes confirmation past pollTries —
    // this must land the SAME unknown outcome the C-owner post-sign relay loss does, not a
    // confirmed failure that invites retrying a transaction that may still land.
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'PENDING' })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: [AGENT], router: ROUTER })
    expect(out.swept).toEqual([0n])
    expect(out.errors[0]).toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' })
    const outcome = ownerActionOutcome({ agentAddress: AGENT, ok: false, error: out.errors[0] })
    expect(outcome.outcome).toBe('unknown')
  })

  it('Fix 1 (fix loop 2): G owner — an explicit FAILED status stays a genuine confirmed-failed, never unknown', async () => {
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'FAILED' })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: [AGENT], router: ROUTER })
    expect(out.errors[0].code).toBeUndefined()
    expect(out.errors[0].submission).toBeUndefined()
    const outcome = ownerActionOutcome({ agentAddress: AGENT, ok: false, error: out.errors[0] })
    expect(outcome.outcome).toBe('confirmed-failed')
  })

  it('splits a position too big for one transaction instead of failing it', async () => {
    // Live calibration: 3 Blend-compounded agents fit the tx budget, 4 do not. 12 agents must
    // cost 4 signatures, not one impossible transaction — and certainly not 12.
    submitUserTx.mockImplementation(async () => ({
      hash: 'sweepN',
      status: 'SUCCESS',
      returnValue: sweptScVal(Array(3).fill(1_000n)),
    }))
    await sweepAgents({ owner: OWNER, agentAddresses: manyAgents(12), router: ROUTER })
    expect(submitUserTx).toHaveBeenCalledTimes(4)
    expect(buildInvokeTx.mock.calls.map((c) => c[0].args[1].vec().length)).toEqual([3, 3, 3, 3])
  })

  it('halves the batch when the chain says the budget is blown, rather than giving up', async () => {
    // The per-agent cost is not fixed (each owner_withdraw redeems through Blend), so the ceiling
    // drifts and MAX_AGENTS_PER_SWEEP is only a guess. Simulation raises this BEFORE any
    // signature, so shrinking is free — a hard failure here would be a withdraw the user cannot do.
    buildInvokeTx.mockRejectedValueOnce(new Error('HostError: Error(Budget, ExceededLimit)'))
    submitUserTx.mockResolvedValue({
      hash: 'half',
      status: 'SUCCESS',
      returnValue: sweptScVal([7n, 7n]),
    })
    const out = await sweepAgents({
      owner: OWNER,
      agentAddresses: manyAgents(4),
      router: ROUTER,
      chunkSize: 4,
    })
    // 4 blew the budget -> retried as 2 + 2.
    expect(buildInvokeTx.mock.calls.map((c) => c[0].args[1].vec().length)).toEqual([4, 2, 2])
    expect(out.swept).toEqual([7n, 7n, 7n, 7n])
  })

  it('preserves the reviewed V1 capability across recursive budget splits and signs every G chunk', async () => {
    buildInvokeTx
      .mockRejectedValueOnce(new Error('HostError: Error(Budget, ExceededLimit)'))
      .mockResolvedValue({
        xdr: 'BUILT',
        tx: { hash: () => Buffer.from('11'.repeat(32), 'hex') },
      })
    submitUserTx.mockResolvedValue({
      hash: 'half',
      status: 'SUCCESS',
      returnValue: sweptScVal([7n, 7n]),
    })

    await sweepAgents({
      owner: OWNER,
      agentAddresses: manyAgents(4),
      router: ROUTER,
      chunkSize: 4,
      activeAccount: ACTIVE_G,
      getCurrentActiveAccount: () => ACTIVE_G,
    })

    expect(signReviewedTransactionMock).toHaveBeenCalledTimes(2)
    for (const [request] of signReviewedTransactionMock.mock.calls) {
      expect(request.activeAccount).toBe(ACTIVE_G)
      expect(request.getCurrentActiveAccount()).toBe(ACTIVE_G)
    }
    expect(signTxXdr).not.toHaveBeenCalled()
  })

  it('keeps a batch that swept, even when another batch fails outright', async () => {
    buildInvokeTx.mockResolvedValue({ xdr: 'BUILT' })
    submitUserTx
      .mockResolvedValueOnce({ hash: 's1', status: 'SUCCESS', returnValue: sweptScVal([9n]) })
      .mockRejectedValueOnce(new Error('Transaction xyz failed on-chain.'))
    const out = await sweepAgents({
      owner: OWNER,
      agentAddresses: manyAgents(2),
      router: ROUTER,
      chunkSize: 1,
    })
    expect(out.swept).toEqual([9n, 0n])
    expect(out.errors).toEqual([
      undefined,
      expect.objectContaining({ message: 'Transaction xyz failed on-chain.' }),
    ])
  })

  it('reports the chain error per agent rather than a bare row of zeros', async () => {
    // All zeros with no explanation reads as "every agent politely declined". It was a failure, and
    // "the RPC dropped it" (retry) must not look like "the agent is empty" (do not).
    submitUserTx.mockRejectedValue(new Error('Transaction xyz failed on-chain.'))
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([0n, 0n])
    expect(out.errors).toEqual([
      expect.objectContaining({ message: 'Transaction xyz failed on-chain.' }),
      expect.objectContaining({ message: 'Transaction xyz failed on-chain.' }),
    ])
    // A bare on-chain Error carries no code/submission — ownerActionOutcome must still read this as
    // a genuine confirmed failure, never a maybe (the regression Fix 1 guards against in reverse).
    expect(out.errors[0].code).toBeUndefined()
    expect(out.errors[0].submission).toBeUndefined()
  })

  it('resolves an array even when every batch fails, like the per-agent path does', async () => {
    // withdrawAllFromVault documents an always-an-array contract. The fallback loop honours it for
    // any failure; throwing only on this path would make the two branches disagree about a dead
    // agent, and cost the caller the per-agent breakdown it exists to show.
    submitUserTx.mockRejectedValue(new Error('nope'))
    await expect(
      sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    ).resolves.toMatchObject({ swept: [0n, 0n] })
  })

  it('refuses an empty agent list rather than submitting a tx that can only fail', async () => {
    await expect(sweepAgents({ owner: OWNER, agentAddresses: [], router: ROUTER })).rejects.toThrow(
      /at least one agent/i
    )
    expect(submitUserTx).not.toHaveBeenCalled()
  })

  it('refuses to run without a configured router', async () => {
    await expect(sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: '' })).rejects.toThrow(
      /not configured/i
    )
    expect(submitUserTx).not.toHaveBeenCalled()
  })

  it('C owner: sweeps sourced from the relayer, signs a passkey auth entry, relay-only', async () => {
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C')
    submitViaRelayMock.mockResolvedValue({
      hash: 'sweepC',
      status: 'SUCCESS',
      returnValue: sweptScVal([5n, 5n]),
    })

    const out = await sweepAgents({
      owner: OWNER_C,
      agentAddresses: AGENTS,
      router: ROUTER,
      activeAccount: { kind: 'C', address: OWNER_C },
    })

    expect(buildInvokeTx).toHaveBeenCalledWith(
      expect.objectContaining({ source: RELAYER_G, contract: ROUTER, method: 'sweep' })
    )
    expect(submitUserTx).not.toHaveBeenCalled()
    expect(out.swept).toEqual([5n, 5n])
  })

  it('C owner: a post-sign relay loss carries code+submission through out.errors, and ownerActionOutcome reads it as unknown, never confirmed-failed', async () => {
    // Fix 1: the ceremony (WebAuthn) already ran, then the relay went silent — relayOnly throws
    // OwnerActionSubmissionError('...', 'VF_SUBMISSION_UNKNOWN', 'unknown'). Before Fix 1,
    // sweepChunk's catch flattened this to `e.message`, so ownerActionOutcome could never see
    // `.submission` and reported the sweep as a confirmed failure — inviting a retry of a
    // transaction that may already have landed.
    getRelayerAddressMock.mockResolvedValue(RELAYER_G)
    signOwnerAuthEntryMock.mockResolvedValue('SIGNED_C')
    submitViaRelayMock.mockResolvedValue(null) // relay unreachable AFTER signing

    const out = await sweepAgents({
      owner: OWNER_C,
      agentAddresses: [AGENT],
      router: ROUTER,
      activeAccount: { kind: 'C', address: OWNER_C },
    })

    expect(out.swept).toEqual([0n])
    expect(out.errors[0]).toMatchObject({ code: 'VF_SUBMISSION_UNKNOWN', submission: 'unknown' })
    const outcome = ownerActionOutcome({ agentAddress: AGENT, ok: false, error: out.errors[0] })
    expect(outcome.outcome).toBe('unknown')
  })

  it('C owner: fails BEFORE the passkey ceremony when no relayer is funded', async () => {
    getRelayerAddressMock.mockResolvedValue(null)
    await expect(
      sweepAgents({
        owner: OWNER_C,
        agentAddresses: AGENTS,
        router: ROUTER,
        activeAccount: { kind: 'C', address: OWNER_C },
      })
    ).rejects.toMatchObject({ code: 'VF_FEE_PAYER_UNAVAILABLE' })
    expect(signOwnerAuthEntryMock).not.toHaveBeenCalled()
    expect(buildInvokeTx).not.toHaveBeenCalled()
  })
})
