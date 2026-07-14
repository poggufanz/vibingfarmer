// revoke.test.js — user-signed kill switch (Registry.revoke) + live agent_revoked subscription.
import { describe, test, it, expect, vi } from 'vitest'
vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn().mockResolvedValue({ tx: {}, xdr: 'UNSIGNED' }),
  submitUserTx: vi.fn().mockResolvedValue({ hash: 'rh1', status: 'SUCCESS' }),
  rpcServer: vi.fn(),
}))
vi.mock('./walletKit.js', () => ({ signTxXdr: vi.fn().mockResolvedValue('SIGNED') }))
import { revokeAgentOnChain, revokedAgentsForOwner, subscribeAgentRevoked } from './revoke.js'
import { buildInvokeTx, submitUserTx } from './client.js'
import { signTxXdr } from './walletKit.js'

describe('revokeAgentOnChain', () => {
  test('builds AgentAccount.revoke() on the agent itself, user-signs, and submits - one tx', async () => {
    const r = await revokeAgentOnChain({ owner: 'GOWNER', agent: 'CAGENT' })
    // Single user-signed invoke against the AGENT CONTRACT — the contract whose __check_auth
    // actually enforces the scope. Registry is metadata only and must not be the kill switch.
    // Relayer-independent (must work even if the gasless relay is down).
    expect(buildInvokeTx).toHaveBeenCalledTimes(1)
    expect(buildInvokeTx).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'GOWNER',
        contract: 'CAGENT',
        method: 'revoke',
        args: [],
      })
    )
    expect(signTxXdr).toHaveBeenCalledWith('UNSIGNED')
    expect(submitUserTx).toHaveBeenCalledWith(expect.objectContaining({ signedXdr: 'SIGNED' }))
    expect(r).toEqual({ hash: 'rh1', status: 'SUCCESS' })
  })
})

describe('revokedAgentsForOwner', () => {
  it('keeps only agent_revoked events whose owner matches (case-insensitive)', () => {
    const events = [
      { type: 'agent_revoked', data: { owner: 'GME', agent: 'CA1' } },
      { type: 'agent_revoked', data: { owner: 'GOTHER', agent: 'CA2' } }, // someone else's
      { type: 'agent_authorized', data: { owner: 'GME', agent: 'CA3' } }, // wrong type
      { type: 'agent_revoked', data: { owner: 'gme', agent: 'CA4' } }, // case differs
    ]
    expect(revokedAgentsForOwner(events, 'GME')).toEqual(['CA1', 'CA4'])
  })

  it('returns [] for an empty batch', () => {
    expect(revokedAgentsForOwner([], 'GME')).toEqual([])
  })
})

describe('subscribeAgentRevoked', () => {
  it('polls, fires the callback once per matching revocation, and stops on unsubscribe', async () => {
    // pollEvents (events.js) is already tested for decode/dedup — here we inject a fake `poll` so
    // this test owns only the subscribe loop's job: filter-by-owner + fire cb + stop on unsub.
    let cycles = 0
    const fakePoll = vi.fn(async ({ seen }) => {
      cycles += 1
      if (cycles === 1) {
        return {
          latestLedger: 11,
          seen,
          events: [
            { type: 'agent_revoked', data: { owner: 'GME', agent: 'CA_MINE' } },
            { type: 'agent_revoked', data: { owner: 'GELSE', agent: 'CA_THEIRS' } },
          ],
        }
      }
      return { latestLedger: 12, seen, events: [] }
    })
    const fakeServer = { getLatestLedger: vi.fn(async () => ({ sequence: 5 })) }
    const got = []
    const unsub = subscribeAgentRevoked('GME', (agent) => got.push(agent), {
      server: fakeServer,
      intervalMs: 1,
      poll: fakePoll,
    })
    await new Promise((r) => setTimeout(r, 20)) // let a few cycles run
    unsub()
    const callsAtStop = fakePoll.mock.calls.length
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toEqual(['CA_MINE']) // only this owner's agent, exactly once
    // unsubscribe halts the loop — no further polls after stop.
    expect(fakePoll.mock.calls.length).toBe(callsAtStop)
  })
})
