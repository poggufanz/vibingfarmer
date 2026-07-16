import { describe, it, expect, vi, beforeEach } from 'vitest'

// The exit router is deployed, so the ONE-signature sweep is the default. Flipping this to '' is
// the production rollback lever (unset VITE_SOROBAN_EXIT_ROUTER_ADDRESS), so both paths are
// exercised here. Everything else in config.js stays real — the module graph depends on it.
let exitRouter = 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J'
vi.mock('../stellar/config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get SOROBAN_EXIT_ROUTER_ADDRESS() {
    return exitRouter
  },
}))
vi.mock('../stellar/exit.js', () => ({
  ownerWithdraw: vi.fn(async () => ({ hash: 'h1', status: 'SUCCESS' })),
  sweepAgents: vi.fn(async () => ({ swept: [], txHashes: [], errors: [] })),
}))
vi.mock('./transactionStore.js', () => ({ saveTransaction: vi.fn() }))

import { ownerWithdraw, sweepAgents } from '../stellar/exit.js'
import { withdrawFromVault, withdrawAllFromVault } from './agentController.js'

const USER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const AGENT = 'CDWHNHIHYQ7YSJXFSNVKRJRAJNBS6XXQBGKB5UUFQAEXKFVHMOFKM77A'
const VAULT = 'CDWHNHIHYQ7YSJXFSNVKRJRAJNBS6XXQBGKB5UUFQAEXKFVHMOFKM77A'
const AGENTS = ['CA_ONE', 'CA_TWO', 'CA_THREE']

beforeEach(() => {
  exitRouter = 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J'
  ownerWithdraw.mockClear()
  ownerWithdraw.mockResolvedValue({ hash: 'h1', status: 'SUCCESS' })
  sweepAgents.mockClear()
  sweepAgents.mockResolvedValue({ swept: [], txHashes: [], errors: [] })
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

describe('withdrawAllFromVault — one-signature sweep', () => {
  it('sweeps every agent in ONE call, not one per agent', async () => {
    // The whole point: the deposit side costs one signature, so the exit side must too.
    sweepAgents.mockResolvedValue({
      swept: [10n, 20n, 30n],
      txHashes: ['sweep1', 'sweep1', 'sweep1'],
      errors: [],
    })
    const out = await withdrawAllFromVault(VAULT, USER, AGENTS)
    expect(sweepAgents).toHaveBeenCalledTimes(1)
    expect(sweepAgents).toHaveBeenCalledWith({
      owner: USER,
      agentAddresses: AGENTS,
      to: USER,
    })
    expect(ownerWithdraw).not.toHaveBeenCalled()
    expect(out).toEqual([
      { agentAddress: 'CA_ONE', ok: true, txHash: 'sweep1' },
      { agentAddress: 'CA_TWO', ok: true, txHash: 'sweep1' },
      { agentAddress: 'CA_THREE', ok: true, txHash: 'sweep1' },
    ])
  })

  it('reports an agent that swept nothing as failed, not as done', async () => {
    // The tx succeeding says only that SOME agent paid out. Calling the 0-amount agent ok is how a
    // half-done withdraw reports "Position updated" and then has its balance reappear on reconcile.
    sweepAgents.mockResolvedValue({
      swept: [10n, 0n, 30n],
      txHashes: ['sweep1', 'sweep1', 'sweep1'],
      errors: [],
    })
    const out = await withdrawAllFromVault(VAULT, USER, AGENTS)
    expect(out.map((r) => r.ok)).toEqual([true, false, true])
    expect(out[1].error).toMatch(/nothing to sweep|refused/i)
  })

  it("passes the chain's own reason through instead of a blanket 'nothing to sweep'", async () => {
    // A transient RPC failure and an empty agent both land as 0. Reporting both as "nothing to
    // sweep" tells the user to give up on a withdraw that would have worked on a retry.
    sweepAgents.mockResolvedValue({
      swept: [10n, 0n, 0n],
      txHashes: ['sweep1', undefined, undefined],
      errors: [undefined, 'RPC rejected the transaction: txBadSeq', undefined],
    })
    const out = await withdrawAllFromVault(VAULT, USER, AGENTS)
    expect(out[1].error).toMatch(/txBadSeq/)
    expect(out[2].error).toMatch(/nothing to sweep|refused/i)
  })

  it('reports every agent as failed when the chain returns no per-agent result', async () => {
    // A missing retval means we cannot tell what moved — claiming success for all is the lie.
    sweepAgents.mockResolvedValue({ swept: [], txHashes: [], errors: [] })
    const out = await withdrawAllFromVault(VAULT, USER, AGENTS)
    expect(out.every((r) => !r.ok)).toBe(true)
  })

  it('throws when there is no agent to sweep rather than doing nothing quietly', async () => {
    await expect(withdrawAllFromVault(VAULT, USER, [])).rejects.toThrow(/at least one agent/i)
    expect(sweepAgents).not.toHaveBeenCalled()
  })
})

describe('withdrawAllFromVault — per-agent fallback (exit router unset)', () => {
  beforeEach(() => {
    exitRouter = ''
  })

  it('sweeps every agent, sequentially, and reports each one', async () => {
    ownerWithdraw
      .mockResolvedValueOnce({ hash: 'h1', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'h2', status: 'SUCCESS' })
      .mockResolvedValueOnce({ hash: 'h3', status: 'SUCCESS' })
    const out = await withdrawAllFromVault(VAULT, USER, AGENTS)
    expect(sweepAgents).not.toHaveBeenCalled()
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
})
