// frontend/src/orchestrator.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'

const authorizeAndFundAgentMock = vi.fn(async () => ({ hash: 'h1', status: 'SUCCESS' }))
// Option B: one FRESH agent_account deploy per worker — unique address per call.
const deployAgentForSessionMock = vi.fn()
vi.mock('./stellar/agentSetup.js', () => ({
  authorizeAndFundAgent: (...a) => authorizeAndFundAgentMock(...a),
  deployAgentForSession: (...a) => deployAgentForSessionMock(...a),
}))
// null → balance precheck in dispatch is skipped (have/want guard)
const readTokenBalanceMock = vi.fn(async () => null)
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
}))
vi.mock('./stellar/config.js', () => ({
  SOROBAN_TOKEN_ADDRESS: 'CTOKEN',
  SOROBAN_DECIMALS: 7,
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
      return { success: true, txHash: '0xW' }
    }
  },
  makeAgentId: (i, s) => `0x${i}${s}`,
}))

import { OrchestratorAgent } from './orchestrator.js'

describe('orchestrator (Stellar deploy + authorize + fund + dispatch)', () => {
  beforeEach(() => {
    authorizeAndFundAgentMock.mockClear()
    authorizeAndFundAgentMock.mockResolvedValue({ hash: 'h1', status: 'SUCCESS' })
    deployAgentForSessionMock.mockReset()
    let n = 0
    deployAgentForSessionMock.mockImplementation(async () => `CFRESH${++n}`)
    readTokenBalanceMock.mockClear()
    readTokenBalanceMock.mockResolvedValue(null)
    workerInstances.length = 0
  })

  const strategy = {
    vaults: [
      { address: 'CV1', allocation: 0.5 },
      { address: 'CV2', allocation: 0.5 },
    ],
  }

  it('deploys a FRESH agent per worker, then authorizes + funds it (user-signed), then dispatches', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1', onEvent: () => {} })
    const res = await orch.dispatch(strategy, 100)
    expect(deployAgentForSessionMock).toHaveBeenCalledTimes(2)
    expect(deployAgentForSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'GUSER', cap: 50_0000000n })
    )
    expect(authorizeAndFundAgentMock).toHaveBeenCalledTimes(2)
    expect(authorizeAndFundAgentMock.mock.calls[0][0]).toMatchObject({
      owner: 'GUSER',
      agentAddress: 'CFRESH1',
    })
    expect(authorizeAndFundAgentMock.mock.calls[1][0]).toMatchObject({ agentAddress: 'CFRESH2' })
    expect(res.completed).toBe(2)
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
    const scoped = events.filter((e) => e.n === 'AgentScopeAuthorized')
    expect(scoped).toHaveLength(2)
    expect(scoped[0].d.agent).toBe('CFRESH1')
    expect(scoped[1].d.agent).toBe('CFRESH2')
    expect(scoped[0].d.token).toBe('CTOKEN')
  })

  it('fails fast when the asset balance cannot cover the total (before any popup)', async () => {
    readTokenBalanceMock.mockResolvedValue(1n) // far below 100 VFUSD in base units
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's4', onEvent: () => {} })
    await expect(orch.dispatch(strategy, 100)).rejects.toThrow(/Insufficient VFUSD/)
    expect(deployAgentForSessionMock).not.toHaveBeenCalled()
    expect(authorizeAndFundAgentMock).not.toHaveBeenCalled()
  })

  it('surfaces a deploy failure as an authorizing-scope error and aborts', async () => {
    deployAgentForSessionMock.mockRejectedValue(new Error('agent deploy not confirmed: FAILED'))
    const events = []
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's5',
      onEvent: (n, d) => events.push({ n, d }),
    })
    await expect(orch.dispatch(strategy, 100)).rejects.toThrow(/deploy not confirmed/)
    expect(authorizeAndFundAgentMock).not.toHaveBeenCalled()
    const err = events.find((e) => e.n === 'orchestrator-step' && e.d.status === 'error')
    expect(err.d.step).toBe('authorizing-scope')
  })
})
