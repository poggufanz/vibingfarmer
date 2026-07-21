// frontend/src/orchestrator.router.test.js
// Router (single-signature grant) path of the orchestrator. The LEGACY per-agent deploy/fund path is
// covered by orchestrator.test.js (whose config mock omits USE_FUNDING_ROUTER → falsy → legacy);
// here USE_FUNDING_ROUTER is mocked true so dispatch takes setupViaRouter.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const callOrder = []

// grant.js — the single-signature primitives. submitGrant returns one fresh agent address per AgentInit.
const submitGrantMock = vi.fn()
const runAgentPullMock = vi.fn()
const readAllowanceMock = vi.fn()
vi.mock('./stellar/grant.js', () => ({
  submitGrant: (...a) => submitGrantMock(...a),
  runAgentPull: (...a) => runAgentPullMock(...a),
  readAllowance: (...a) => readAllowanceMock(...a),
  AGENT_KIND_DEPOSIT: 0,
  AGENT_KIND_BRIDGE: 1,
}))

// Legacy setup helpers must NEVER be called on the router path.
const deployAgentForSessionMock = vi.fn()
const fundAgentMock = vi.fn()
vi.mock('./stellar/agentSetup.js', () => ({
  deployAgentForSession: (...a) => deployAgentForSessionMock(...a),
  fundAgent: (...a) => fundAgentMock(...a),
  registryAuthorizeAgent: vi.fn(),
}))

const takeReusableAgentMock = vi.fn(async () => null)
const saveCachedAgentMock = vi.fn()
vi.mock('./stellar/agentCache.js', () => ({
  takeReusableAgent: (...a) => takeReusableAgentMock(...a),
  saveCachedAgent: (...a) => saveCachedAgentMock(...a),
}))

vi.mock('./stellar/sessionKey.js', () => ({
  newSessionKey: (secret) => ({
    publicKey: 'GRESTORED',
    secret,
    rawPublicKey: new Uint8Array(32),
    sign: () => new Uint8Array(64),
  }),
}))

const readTokenBalanceMock = vi.fn(async () => null)
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
}))

// USE_FUNDING_ROUTER true → dispatch takes the router path.
vi.mock('./stellar/config.js', () => ({
  SOROBAN_TOKEN_ADDRESS: 'CTOKEN',
  SOROBAN_DECIMALS: 7,
  SOROBAN_ACTIVE_VAULT_ADDRESS: 'CACTIVEVAULT',
  USE_FUNDING_ROUTER: true,
}))
vi.mock('./strategist.js', () => ({ generateAgentSkills: vi.fn(async () => ({})) }))
vi.mock('./skills.js', () => ({ saveSkill: vi.fn() }))

const workerInstances = []
vi.mock('./worker.js', () => ({
  WorkerAgent: class {
    constructor(c) {
      Object.assign(this, c)
      workerInstances.push(this)
    }
    async setupKey() {
      if (!this.sessionKey) {
        const n = workerInstances.indexOf(this)
        this.sessionKey = {
          publicKey: `GPUB${n}`,
          secret: `SSEC${n}`,
          rawPublicKey: new Uint8Array(32).fill(n + 1),
        }
      }
      return this.sessionKey
    }
    async execute() {
      callOrder.push(`execute:${this.agentId}`)
      return { success: true, txHash: '0xW' }
    }
  },
  makeAgentId: (i, s) => `0x${i}${s}`,
}))

import { OrchestratorAgent } from './orchestrator.js'
import { ZERO32 } from './stellar/cctpBurn.js'

const strategy = {
  vaults: [
    { address: 'CV1', allocation: 0.4 },
    { address: 'CV2', allocation: 0.4 },
    { address: 'CV3', allocation: 0.2 },
  ],
}
// total 100 → 40 / 40 / 20 VFUSD = 40_0000000 / 40_0000000 / 20_0000000 base units; total 100_0000000.
const TOTAL_UNITS = 100_0000000n

beforeEach(() => {
  callOrder.length = 0
  workerInstances.length = 0
  submitGrantMock.mockReset()
  submitGrantMock.mockImplementation(async ({ agentInits }) => {
    callOrder.push(`grant:${agentInits.length}`)
    return {
      hash: 'HG',
      status: 'SUCCESS',
      agentAddresses: agentInits.map((_, i) => `CFRESH${i + 1}`),
      expiryLedger: 9999,
    }
  })
  runAgentPullMock.mockReset()
  runAgentPullMock.mockImplementation(async ({ agentAddress }) => {
    callOrder.push(`pull:${agentAddress}`)
    return { hash: 'HP', status: 'SUCCESS' }
  })
  readAllowanceMock.mockReset()
  readAllowanceMock.mockResolvedValue({ amount: 0n, liveUntilLedger: null }) // 0 → forces a grant
  takeReusableAgentMock.mockReset()
  takeReusableAgentMock.mockResolvedValue(null)
  saveCachedAgentMock.mockClear()
  deployAgentForSessionMock.mockClear()
  fundAgentMock.mockClear()
  readTokenBalanceMock.mockReset()
  readTokenBalanceMock.mockImplementation(async (addr) => (addr === 'GUSER' ? null : 0n))
})

describe('orchestrator router path - first run (a single signature)', () => {
  it('issues exactly a single grant signature for N=3 agents, then a relayed pull per worker', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1', onEvent: () => {} })
    const res = await orch.dispatch(strategy, 100)

    // ONE grant for all three agents — the single wallet signature.
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.agentInits).toHaveLength(3)
    // v2 shape: budgets is an array of {budget, token} (single farm-token entry here); budget
    // defaults to the run total, caps are the per-agent amounts. Every deposit-kind AgentInit
    // field is asserted so a future grantFreshAgents drift (wrong kind/target/token) goes red here
    // instead of silently building a tx the router would reject.
    expect(grantArgs.budgets).toEqual([{ budget: TOTAL_UNITS, token: 'CTOKEN' }])
    expect(grantArgs.agentInits).toEqual([
      expect.objectContaining({
        cap: 40_0000000n,
        token: 'CTOKEN',
        target: 'CACTIVEVAULT',
        kind: 0,
        mintRecipient: ZERO32,
        destinationDomain: 0,
      }),
      expect.objectContaining({ cap: 40_0000000n, kind: 0, target: 'CACTIVEVAULT' }),
      expect.objectContaining({ cap: 20_0000000n, kind: 0, target: 'CACTIVEVAULT' }),
    ])

    // Funding is a relayed pull per worker — NOT a legacy deploy/fund signature.
    expect(runAgentPullMock).toHaveBeenCalledTimes(3)
    expect(deployAgentForSessionMock).not.toHaveBeenCalled()
    expect(fundAgentMock).not.toHaveBeenCalled()

    // Agents come from the grant retval, in order.
    expect(workerInstances.map((w) => w.agentAddress)).toEqual(['CFRESH1', 'CFRESH2', 'CFRESH3'])
    expect(res.completed).toBe(3)
  })

  it('pulls funds to every agent BEFORE any worker deposit runs', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's2', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    const firstExecute = callOrder.findIndex((c) => c.startsWith('execute:'))
    const lastPull = callOrder.map((c) => c.startsWith('pull:')).lastIndexOf(true)
    expect(lastPull).toBeGreaterThanOrEqual(0)
    expect(firstExecute).toBeGreaterThan(lastPull) // every pull precedes the first deposit
  })

  it('caches every freshly granted agent (address + session secret) for reuse', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's3', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    expect(saveCachedAgentMock).toHaveBeenCalledTimes(3)
    expect(saveCachedAgentMock.mock.calls[0][0]).toMatchObject({
      owner: 'GUSER',
      vault: 'CACTIVEVAULT',
      entry: expect.objectContaining({ agentAddress: 'CFRESH1', cap: '400000000' }),
    })
  })

  it('honors a user-chosen budget larger than the run total (signature-free repeat headroom)', async () => {
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's4',
      onEvent: () => {},
      grantBudgetUnits: 500_0000000n, // 5x total
    })
    await orch.dispatch(strategy, 100)
    expect(submitGrantMock.mock.calls[0][0].budgets).toEqual([
      { budget: 500_0000000n, token: 'CTOKEN' },
    ])
  })
})

describe('orchestrator router path - repeat run (zero further signatures)', () => {
  it('skips the grant entirely when allowance covers the run AND every worker reuses a cached agent', async () => {
    readAllowanceMock.mockResolvedValue({ amount: 500_0000000n, liveUntilLedger: null })
    let n = 0
    takeReusableAgentMock.mockImplementation(async () => {
      n += 1
      return { agentAddress: `CCACHED${n}`, secret: `SCACHED${n}` }
    })
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's5',
      onEvent: (e, d) => events.push({ e, d }),
    })
    const res = await orch.dispatch(strategy, 100)

    // zero further signatures: no grant.
    expect(submitGrantMock).not.toHaveBeenCalled()
    // Funding still flows via relayed pulls (agents drained after the prior run) — 0 further signatures.
    expect(runAgentPullMock).toHaveBeenCalledTimes(3)
    expect(workerInstances.map((w) => w.agentAddress)).toEqual(['CCACHED1', 'CCACHED2', 'CCACHED3'])
    const deployed = events.filter((x) => x.e === 'AgentDeployed')
    expect(deployed.every((x) => x.d.reused === true)).toBe(true)
    expect(res.completed).toBe(3)
  })

  it('falls back to the grant signature when allowance is insufficient even if agents are cached', async () => {
    readAllowanceMock.mockResolvedValue({ amount: 1n, liveUntilLedger: null }) // below run total
    takeReusableAgentMock.mockResolvedValue({ agentAddress: 'CCACHED', secret: 'S' })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's6', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    expect(submitGrantMock).toHaveBeenCalledTimes(1) // grant signature required
  })

  it('falls back to the grant signature when even one worker has no reusable cached agent', async () => {
    readAllowanceMock.mockResolvedValue({ amount: 500_0000000n, liveUntilLedger: null })
    // Two workers reuse, the third cannot → all-or-nothing: a grant is required (grant is the only
    // way to create the missing agent).
    takeReusableAgentMock
      .mockResolvedValueOnce({ agentAddress: 'CCACHED1', secret: 'S1' })
      .mockResolvedValueOnce({ agentAddress: 'CCACHED2', secret: 'S2' })
      .mockResolvedValue(null)
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's7', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    // Fresh grant deploys all three (the two cached picks are not committed on a partial reuse).
    expect(workerInstances.map((w) => w.agentAddress)).toEqual(['CFRESH1', 'CFRESH2', 'CFRESH3'])
  })
})

describe('orchestrator router path - failure isolation', () => {
  it('aborts the whole run when the single grant fails (no agents get deployed)', async () => {
    submitGrantMock.mockRejectedValue(new Error('grant signature timed out after 120s'))
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's8',
      onEvent: (e, d) => events.push({ e, d }),
    })
    await expect(orch.dispatch(strategy, 100)).rejects.toThrow(
      /Agent setup failed for all 3 agents/
    )
    expect(runAgentPullMock).not.toHaveBeenCalled()
    const err = events.find((x) => x.e === 'orchestrator-step' && x.d.status === 'error')
    expect(err.d.step).toBe('authorizing-scope')
  })

  it("one worker's pull failure isolates that worker; the rest of the run continues", async () => {
    runAgentPullMock.mockReset()
    runAgentPullMock.mockImplementation(async ({ agentAddress }) => {
      if (agentAddress === 'CFRESH2') throw new Error('router pull reported FAILED')
      return { hash: 'HP', status: 'SUCCESS' }
    })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's9', onEvent: () => {} })
    const res = await orch.dispatch(strategy, 100)
    expect(res.completed).toBe(2)
    expect(res.failed).toBe(1)
    const failed = res.results.find((r) => !r.success)
    expect(failed.error).toMatch(/Setup failed: .*router pull reported FAILED/)
  })
})
