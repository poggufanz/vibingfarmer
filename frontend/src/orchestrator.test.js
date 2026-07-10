// frontend/src/orchestrator.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Shared call-order journal — every user-signed-setup mock pushes a label so tests can assert
// the setup chain is STRICTLY sequential per agent (deploy → fund before the next agent starts).
const callOrder = []

const fundAgentMock = vi.fn(async () => ({ hash: 'hF', status: 'SUCCESS' }))
const registryAuthorizeAgentMock = vi.fn(async () => ({ hash: 'hR', status: 'SUCCESS' }))
// Option B: one FRESH agent_account deploy per worker — unique address per call.
const deployAgentForSessionMock = vi.fn()
vi.mock('./stellar/agentSetup.js', () => ({
  deployAgentForSession: (...a) => deployAgentForSessionMock(...a),
  fundAgent: (...a) => fundAgentMock(...a),
  registryAuthorizeAgent: (...a) => registryAuthorizeAgentMock(...a),
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

// user balance precheck → null (skipped); agent balances → 0n (fund required) unless overridden.
const readTokenBalanceMock = vi.fn(async () => null)
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
}))
// USE_FUNDING_ROUTER false → dispatch takes the LEGACY per-agent deploy/fund path exercised by
// this whole file. The router (one-popup) path is covered by orchestrator.router.test.js.
vi.mock('./stellar/config.js', () => ({
  SOROBAN_TOKEN_ADDRESS: 'CTOKEN',
  SOROBAN_DECIMALS: 7,
  SOROBAN_ACTIVE_VAULT_ADDRESS: 'CACTIVEVAULT',
  USE_FUNDING_ROUTER: false,
}))
vi.mock('./venice.js', () => ({ generateAgentSkills: vi.fn(async () => ({})) }))
vi.mock('./skills.js', () => ({ saveSkill: vi.fn() }))

const workerInstances = []
vi.mock('./worker.js', () => ({
  WorkerAgent: class {
    constructor(c) {
      Object.assign(this, c)
      workerInstances.push(this)
    }
    async setupKey() {
      // Idempotent like the real worker — the orchestrator-provided key must survive.
      if (!this.sessionKey) this.sessionKey = { publicKey: `GSESSION${workerInstances.length}` }
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

describe('orchestrator (Stellar deploy + fund + dispatch)', () => {
  beforeEach(() => {
    callOrder.length = 0
    fundAgentMock.mockClear()
    fundAgentMock.mockImplementation(async ({ agentAddress }) => {
      callOrder.push(`fund:${agentAddress}`)
      return { hash: 'hF', status: 'SUCCESS' }
    })
    registryAuthorizeAgentMock.mockClear()
    registryAuthorizeAgentMock.mockImplementation(async ({ agentAddress }) => {
      callOrder.push(`registry:${agentAddress}`)
      return { hash: 'hR', status: 'SUCCESS' }
    })
    deployAgentForSessionMock.mockReset()
    let n = 0
    deployAgentForSessionMock.mockImplementation(async () => {
      const addr = `CFRESH${++n}`
      callOrder.push(`deploy:${addr}`)
      return addr
    })
    takeReusableAgentMock.mockReset()
    takeReusableAgentMock.mockResolvedValue(null)
    saveCachedAgentMock.mockClear()
    readTokenBalanceMock.mockReset()
    // user precheck (GUSER) → null skips the have/want guard; agents → 0n forces funding.
    readTokenBalanceMock.mockImplementation(async (addr) => (addr === 'GUSER' ? null : 0n))
    workerInstances.length = 0
  })

  const strategy = {
    vaults: [
      { address: 'CV1', allocation: 0.5 },
      { address: 'CV2', allocation: 0.5 },
    ],
  }

  it('deploys a FRESH agent per worker, then funds it (user-signed), then dispatches', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1', onEvent: () => {} })
    const res = await orch.dispatch(strategy, 100)
    expect(deployAgentForSessionMock).toHaveBeenCalledTimes(2)
    expect(deployAgentForSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'GUSER', cap: 50_0000000n })
    )
    expect(fundAgentMock).toHaveBeenCalledTimes(2)
    expect(fundAgentMock.mock.calls[0][0]).toMatchObject({
      owner: 'GUSER',
      agentAddress: 'CFRESH1',
      amount: 50_0000000n,
    })
    expect(fundAgentMock.mock.calls[1][0]).toMatchObject({ agentAddress: 'CFRESH2' })
    // Registry.authorize is record-keeping only — OFF the popup path by default.
    expect(registryAuthorizeAgentMock).not.toHaveBeenCalled()
    expect(res.completed).toBe(2)
  })

  it('runs the user-signed setup chain STRICTLY sequentially: agent 1 fully set up before agent 2 starts', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 'sq', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    // Same-source-account txs must never interleave (sequence-number race + popup pileup).
    expect(callOrder).toEqual([
      'deploy:CFRESH1',
      'fund:CFRESH1',
      'deploy:CFRESH2',
      'fund:CFRESH2',
      'execute:0x0sq',
      'execute:0x1sq',
    ])
  })

  it('threads the SAME session key into the deploy and leaves it on the worker (no regeneration)', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's2', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    expect(workerInstances).toHaveLength(2)
    workerInstances.forEach((w, i) => {
      // Deploy received the exact key object the worker holds — identity, not equality.
      expect(deployAgentForSessionMock.mock.calls[i][0].sessionKey).toBe(w.sessionKey)
      // And the worker deposits through the address that deploy returned.
      expect(w.agentAddress).toBe(`CFRESH${i + 1}`)
    })
  })

  it('emits AgentDeployed + AgentScopeAuthorized per worker with the fresh agent address', async () => {
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's3',
      onEvent: (n, d) => events.push({ n, d }),
    })
    await orch.dispatch(strategy, 100)
    const deployed = events.filter((e) => e.n === 'AgentDeployed')
    expect(deployed).toHaveLength(2)
    expect(deployed[0].d.agent).toBe('CFRESH1')
    expect(deployed[0].d.reused).toBe(false)
    const scoped = events.filter((e) => e.n === 'AgentScopeAuthorized')
    expect(scoped).toHaveLength(2)
    expect(scoped[0].d.agent).toBe('CFRESH1')
    expect(scoped[1].d.agent).toBe('CFRESH2')
    expect(scoped[0].d.token).toBe('CTOKEN')
  })

  it('caches every freshly deployed agent (address + session secret) for reuse', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's6', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    expect(saveCachedAgentMock).toHaveBeenCalledTimes(2)
    expect(saveCachedAgentMock.mock.calls[0][0]).toMatchObject({
      owner: 'GUSER',
      vault: 'CACTIVEVAULT',
      entry: expect.objectContaining({ agentAddress: 'CFRESH1', cap: '500000000' }),
    })
  })

  it('reuses a cached agent: skips the deploy popup and restores its pinned session key', async () => {
    takeReusableAgentMock
      .mockResolvedValueOnce({ agentAddress: 'CCACHED', secret: 'SCACHEDSECRET' })
      .mockResolvedValue(null)
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's7',
      onEvent: (n, d) => events.push({ n, d }),
    })
    const res = await orch.dispatch(strategy, 100)
    // Worker 1 adopted the cached agent — only worker 2 needed a deploy.
    expect(deployAgentForSessionMock).toHaveBeenCalledTimes(1)
    expect(workerInstances[0].agentAddress).toBe('CCACHED')
    expect(workerInstances[0].sessionKey.secret).toBe('SCACHEDSECRET')
    expect(workerInstances[1].agentAddress).toBe('CFRESH1')
    const deployed = events.filter((e) => e.n === 'AgentDeployed')
    expect(deployed[0].d).toMatchObject({ agent: 'CCACHED', reused: true })
    // Cache validation received the run context (cap headroom is checked against the amount).
    expect(takeReusableAgentMock.mock.calls[0][0]).toMatchObject({
      owner: 'GUSER',
      vault: 'CACTIVEVAULT',
      amount: 50_0000000n,
    })
    expect(res.completed).toBe(2)
  })

  it('skips the funding popup when the reused agent still holds enough of the asset', async () => {
    takeReusableAgentMock
      .mockResolvedValueOnce({ agentAddress: 'CCACHED', secret: 'SCACHEDSECRET' })
      .mockResolvedValue(null)
    readTokenBalanceMock.mockImplementation(async (addr) => {
      if (addr === 'GUSER') return null // precheck skipped
      if (addr === 'CCACHED') return 50_0000000n // already funded from an aborted prior run
      return 0n
    })
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's8', onEvent: () => {} })
    await orch.dispatch(strategy, 100)
    // Only the fresh agent needed funding — repeat run popups: 0 for the cached agent.
    expect(fundAgentMock).toHaveBeenCalledTimes(1)
    expect(fundAgentMock.mock.calls[0][0].agentAddress).toBe('CFRESH1')
  })

  it('records the Registry scope only when the registryAuthorize flag is on (default off)', async () => {
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's9',
      onEvent: () => {},
      registryAuthorize: true,
    })
    await orch.dispatch(strategy, 100)
    expect(registryAuthorizeAgentMock).toHaveBeenCalledTimes(2)
    // Still strictly sequential, registry between deploy and fund.
    expect(callOrder.slice(0, 6)).toEqual([
      'deploy:CFRESH1',
      'registry:CFRESH1',
      'fund:CFRESH1',
      'deploy:CFRESH2',
      'registry:CFRESH2',
      'fund:CFRESH2',
    ])
  })

  it('fails fast when the asset balance cannot cover the total (before any popup)', async () => {
    readTokenBalanceMock.mockResolvedValue(1n) // far below 100 VFUSD in base units
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's4', onEvent: () => {} })
    await expect(orch.dispatch(strategy, 100)).rejects.toThrow(/Insufficient VFUSD/)
    expect(deployAgentForSessionMock).not.toHaveBeenCalled()
    expect(fundAgentMock).not.toHaveBeenCalled()
  })

  it("one agent's setup failure marks THAT worker failed — the rest of the run continues", async () => {
    deployAgentForSessionMock
      .mockRejectedValueOnce(new Error('agent deploy signature timed out after 120s'))
      .mockImplementation(async () => {
        callOrder.push('deploy:CFRESH-OK')
        return 'CFRESH-OK'
      })
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's10',
      onEvent: (n, d) => events.push({ n, d }),
    })
    const res = await orch.dispatch(strategy, 100) // resolves — no all-or-nothing abort
    expect(res.completed).toBe(1)
    expect(res.failed).toBe(1)
    expect(res.results[0].success).toBe(false)
    expect(res.results[0].error).toMatch(/setup failed: .*timed out/)
    expect(res.results[1].success).toBe(true)
    // The failed worker was surfaced (drives the tile 'failed' state) and never dispatched.
    const failedEv = events.find((e) => e.n === 'failed')
    expect(failedEv.d).toMatchObject({ agentId: '0x0s10' })
    expect(callOrder.filter((c) => c.startsWith('execute:'))).toEqual(['execute:0x1s10'])
    // And the run still reported the setup step done (partial success, not an error abort).
    const stepDone = events.find(
      (e) =>
        e.n === 'orchestrator-step' && e.d.step === 'authorizing-scope' && e.d.status === 'done'
    )
    expect(stepDone).toBeTruthy()
  })

  it('aborts cleanly (error step + throw) only when EVERY agent setup failed', async () => {
    deployAgentForSessionMock.mockRejectedValue(new Error('agent deploy not confirmed: FAILED'))
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's5',
      onEvent: (n, d) => events.push({ n, d }),
    })
    await expect(orch.dispatch(strategy, 100)).rejects.toThrow(/setup failed for all 2 agents/)
    expect(fundAgentMock).not.toHaveBeenCalled()
    const err = events.find((e) => e.n === 'orchestrator-step' && e.d.status === 'error')
    expect(err.d.step).toBe('authorizing-scope')
    // No worker was dispatched — the run never enters the infinite-"started" limbo.
    expect(callOrder.some((c) => c.startsWith('execute:'))).toBe(false)
  })
})
