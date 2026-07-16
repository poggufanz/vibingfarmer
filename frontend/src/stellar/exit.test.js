import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client.js', () => ({
  buildInvokeTx: vi.fn(async () => ({ xdr: 'BUILT' })),
  submitUserTx: vi.fn(async () => ({ hash: 'h1', status: 'SUCCESS' })),
}))
vi.mock('./walletKit.js', () => ({ signTxXdr: vi.fn(async () => 'SIGNED') }))

import { buildInvokeTx, submitUserTx } from './client.js'
import { ownerWithdraw } from './exit.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'

beforeEach(() => {
  buildInvokeTx.mockClear()
  submitUserTx.mockClear()
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
    expect(out).toEqual({ hash: 'h1', status: 'SUCCESS' })
  })
})
