import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn(async () => ({ xdr: 'BUILT' })),
  submitUserTx: vi.fn(async () => ({ hash: 'h1', status: 'SUCCESS' })),
}))
vi.mock('./walletKit.js', () => ({ signTxXdr: vi.fn(async () => 'SIGNED') }))

import { xdr } from '@stellar/stellar-sdk'
import { buildInvokeTx, submitUserTx } from './client.js'
import { ownerWithdraw, sweepAgents } from './exit.js'
import { i128ScVal } from './scval.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT2 = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const ROUTER = 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J'

/** A `sweep` retval as the chain sends it: Vec<i128> of the amount each agent gave up. */
const sweptScVal = (amounts) => xdr.ScVal.scvVec(amounts.map((a) => i128ScVal(a)))

beforeEach(() => {
  buildInvokeTx.mockReset()
  buildInvokeTx.mockResolvedValue({ xdr: 'BUILT' })
  submitUserTx.mockReset()
  submitUserTx.mockResolvedValue({ hash: 'h1', status: 'SUCCESS' })
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

  it('returns the hash and status on a confirmed exit', async () => {
    const out = await ownerWithdraw({ owner: OWNER, agentAddress: AGENT, to: OWNER })
    expect(out).toMatchObject({ hash: 'h1', status: 'SUCCESS' })
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
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, to: OWNER, router: ROUTER })

    expect(submitUserTx).toHaveBeenCalledTimes(1)
    const call = buildInvokeTx.mock.calls[0][0]
    expect(call).toMatchObject({ source: OWNER, contract: ROUTER, method: 'sweep' })
    // args = (owner, Vec<Address> agents, to) — the agent vec is a raw ScVal, encodeArgs passes it through.
    expect(call.args).toHaveLength(3)
    expect(call.args[1].vec()).toHaveLength(2)
    expect(out.swept).toEqual([50_000_000n, 20_000_000n])
    expect(out.txHashes).toEqual(['sweep1', 'sweep1'])
  })

  it('decodes a partial sweep as the zeros the chain reported', async () => {
    submitUserTx.mockResolvedValueOnce({
      hash: 'sweep1',
      status: 'SUCCESS',
      returnValue: sweptScVal([50_000_000n, 0n]),
    })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([50_000_000n, 0n])
  })

  it('reports zeros rather than guessing when the chain returns no retval', async () => {
    submitUserTx.mockResolvedValueOnce({ hash: 'sweep1', status: 'SUCCESS' })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([0n, 0n])
  })

  it('never reports an unconfirmed sweep as swept', async () => {
    // Callers zero the position on a swept amount, so a tx we have not SEEN confirm must not
    // produce one — but the reason still has to reach the user rather than vanish into a 0.
    submitUserTx.mockResolvedValueOnce({ hash: 'h2', status: 'PENDING' })
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([0n, 0n])
    expect(out.errors[0]).toMatch(/not confirmed/i)
  })

  it('splits a position too big for one transaction instead of failing it', async () => {
    // Live testnet: 5 agents fit the tx budget, 6 do not. 12 agents must cost 3 signatures,
    // not one impossible transaction — and certainly not 12.
    submitUserTx.mockImplementation(async () => ({
      hash: 'sweepN',
      status: 'SUCCESS',
      returnValue: sweptScVal(Array(5).fill(1_000n)),
    }))
    await sweepAgents({ owner: OWNER, agentAddresses: manyAgents(12), router: ROUTER })
    expect(submitUserTx).toHaveBeenCalledTimes(3)
    expect(buildInvokeTx.mock.calls.map((c) => c[0].args[1].vec().length)).toEqual([5, 5, 2])
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
    expect(out.errors).toEqual([undefined, 'Transaction xyz failed on-chain.'])
  })

  it('reports the chain error per agent rather than a bare row of zeros', async () => {
    // All zeros with no explanation reads as "every agent politely declined". It was a failure, and
    // "the RPC dropped it" (retry) must not look like "the agent is empty" (do not).
    submitUserTx.mockRejectedValue(new Error('Transaction xyz failed on-chain.'))
    const out = await sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: ROUTER })
    expect(out.swept).toEqual([0n, 0n])
    expect(out.errors).toEqual([
      'Transaction xyz failed on-chain.',
      'Transaction xyz failed on-chain.',
    ])
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
    await expect(
      sweepAgents({ owner: OWNER, agentAddresses: AGENTS, router: '' })
    ).rejects.toThrow(/not configured/i)
    expect(submitUserTx).not.toHaveBeenCalled()
  })
})
