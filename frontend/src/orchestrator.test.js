// frontend/src/orchestrator.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'

const authorizeAndFundAgentMock = vi.fn(async () => ({ hash: 'h1', status: 'SUCCESS' }))
vi.mock('./stellar/agentSetup.js', () => ({
  authorizeAndFundAgent: (...a) => authorizeAndFundAgentMock(...a),
}))
// null → balance precheck in dispatch is skipped (have/want guard)
const readTokenBalanceMock = vi.fn(async () => null)
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
}))
vi.mock('./stellar/config.js', () => ({
  SOROBAN_TOKEN_ADDRESS: 'CTOKEN',
  SOROBAN_DEMO_AGENT: 'CDEMOAGENT',
  SOROBAN_DECIMALS: 7,
}))
vi.mock('./venice.js', () => ({ generateAgentSkills: vi.fn(async () => ({})) }))
vi.mock('./skills.js', () => ({ saveSkill: vi.fn() }))

vi.mock('./worker.js', () => ({
  WorkerAgent: class {
    constructor(c) {
      Object.assign(this, c)
    }
    async setupKey() {
      this.sessionKey = { publicKey: 'GSESSION' }
      return this.sessionKey
    }
    async execute() {
      return { success: true, txHash: '0xW' }
    }
  },
  makeAgentId: (i, s) => `0x${i}${s}`,
}))

import { OrchestratorAgent } from './orchestrator.js'

describe('orchestrator (Stellar authorize + fund + dispatch)', () => {
  beforeEach(() => {
    authorizeAndFundAgentMock.mockClear()
    authorizeAndFundAgentMock.mockResolvedValue({ hash: 'h1', status: 'SUCCESS' })
    readTokenBalanceMock.mockClear()
    readTokenBalanceMock.mockResolvedValue(null)
  })

  const strategy = {
    vaults: [
      { address: 'CV1', allocation: 0.5 },
      { address: 'CV2', allocation: 0.5 },
    ],
  }

  it('authorizes + funds ONE agent per worker (user-signed), then dispatches', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1', onEvent: () => {} })
    const res = await orch.dispatch(strategy, 100)
    expect(authorizeAndFundAgentMock).toHaveBeenCalledTimes(2)
    expect(authorizeAndFundAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'GUSER', agentAddress: 'CDEMOAGENT' }),
    )
    expect(res.completed).toBe(2)
  })

  it('emits AgentScopeAuthorized per worker for the revoke UI', async () => {
    const events = []
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's3', onEvent: (n, d) => events.push({ n, d }) })
    await orch.dispatch(strategy, 100)
    const scoped = events.filter((e) => e.n === 'AgentScopeAuthorized')
    expect(scoped).toHaveLength(2)
    expect(scoped[0].d.agent).toBe('CDEMOAGENT')
    expect(scoped[0].d.token).toBe('CTOKEN')
  })

  it('fails fast when the asset balance cannot cover the total (before any popup)', async () => {
    readTokenBalanceMock.mockResolvedValue(1n) // far below 100 VFUSD in base units
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's4', onEvent: () => {} })
    await expect(orch.dispatch(strategy, 100)).rejects.toThrow(/Insufficient VFUSD/)
    expect(authorizeAndFundAgentMock).not.toHaveBeenCalled()
  })
})
