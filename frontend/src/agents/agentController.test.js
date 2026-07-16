import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../stellar/exit.js', () => ({
  ownerWithdraw: vi.fn(async () => ({ hash: 'h1', status: 'SUCCESS' })),
}))
vi.mock('./transactionStore.js', () => ({ saveTransaction: vi.fn() }))

import { ownerWithdraw } from '../stellar/exit.js'
import { withdrawFromVault, withdrawAllFromVault } from './agentController.js'

const USER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT = 'CDWHNHIHYQ7YSJXFSNVKRJRAJNBS6XXQBGKB5UUFQAEXKFVHMOFKM77A'
const VAULT = 'CDWHNHIHYQ7YSJXFSNVKRJRAJNBS6XXQBGKB5UUFQAEXKFVHMOFKM77A'

beforeEach(() => {
  ownerWithdraw.mockClear()
  ownerWithdraw.mockResolvedValue({ hash: 'h1', status: 'SUCCESS' })
})

describe('withdrawFromVault', () => {
  it('sweeps the agent the caller names, to the user wallet', async () => {
    await withdrawFromVault(VAULT, '1000', USER, AGENT)
    expect(ownerWithdraw).toHaveBeenCalledWith({ owner: USER, agentAddress: AGENT, to: USER })
  })

  it('throws instead of falling back to a hardcoded demo agent', async () => {
    // The demo agent is owned by vf-deployer and holds none of the user's funds. Defaulting to it
    // made every withdraw target a stranger's account, fail on-chain, and report success.
    await expect(withdrawFromVault(VAULT, '1000', USER)).rejects.toThrow(/agent/i)
    expect(ownerWithdraw).not.toHaveBeenCalled()
  })
})

describe('withdrawAllFromVault', () => {
  const AGENTS = ['CA_ONE', 'CA_TWO', 'CA_THREE']

  it('sweeps every agent, sequentially, and reports each one', async () => {
    ownerWithdraw
      .mockResolvedValueOnce({ hash: 'h1', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'h2', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'h3', status: 'SUCCESS' })
    const out = await withdrawAllFromVault(VAULT, USER, AGENTS)
    expect(ownerWithdraw).toHaveBeenCalledTimes(3)
    expect(out).toEqual([
      { agentAddress: 'CA_ONE', ok: true, txHash: 'h1' },
      { agentAddress: 'CA_TWO', ok: true, txHash: 'h2' },
      { agentAddress: 'CA_THREE', ok: true, txHash: 'h3' },
    ])
  })

  it('keeps sweeping after one agent fails, so the rest are not stranded', async () => {
    ownerWithdraw
      .mockResolvedValueOnce({ hash: 'h1', status: 'SUCCESS' })
      .mockRejectedValueOnce(new Error('The exit was not confirmed: FAILED.'))
      .mockResolvedValueOnce({ hash: 'h3', status: 'SUCCESS' })
    const out = await withdrawAllFromVault(VAULT, USER, AGENTS)
    expect(ownerWithdraw).toHaveBeenCalledTimes(3)
    expect(out.map((r) => r.ok)).toEqual([true, false, true])
    expect(out[1].error).toMatch(/not confirmed/i)
  })

  it('reports progress before each wallet popup', async () => {
    const seen = []
    await withdrawAllFromVault(VAULT, USER, AGENTS, (p) => seen.push(p))
    expect(seen).toEqual([
      { index: 0, total: 3, agentAddress: 'CA_ONE' },
      { index: 1, total: 3, agentAddress: 'CA_TWO' },
      { index: 2, total: 3, agentAddress: 'CA_THREE' },
    ])
  })

  it('throws when there is no agent to sweep rather than doing nothing quietly', async () => {
    await expect(withdrawAllFromVault(VAULT, USER, [])).rejects.toThrow(/at least one agent/i)
    expect(ownerWithdraw).not.toHaveBeenCalled()
  })
})
