// frontend/src/orchestrator.baseleg.test.js
// Task 8: dispatch() splits strategy.vaults by chain and runs the Base leg (Task 7's
// executeBaseLeg) as a settled sibling of the Stellar worker pipeline.
//
// Stubbing seam: this file follows orchestrator.test.js's REAL seam — module-level vi.mock() of
// every dependency dispatch touches (there is no `_buildWorkers` injection point in the real
// class; the brief's illustrative test used one, but the actual orchestrator.js has none). The
// legacy (non-router) path is used here since it's what orchestrator.test.js exercises and is the
// simplest fixture; only executeBaseLeg (./baseLeg.js) is additionally mocked for the Base leg.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const fundAgentMock = vi.fn(async () => ({ hash: 'hF', status: 'SUCCESS' }))
const deployAgentForSessionMock = vi.fn()
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

// Legacy path (USE_FUNDING_ROUTER: false) — same fixture as orchestrator.test.js.
vi.mock('./stellar/config.js', () => ({
  SOROBAN_TOKEN_ADDRESS: 'CTOKEN',
  SOROBAN_DECIMALS: 7,
  SOROBAN_ACTIVE_VAULT_ADDRESS: 'CACTIVEVAULT',
  USE_FUNDING_ROUTER: false,
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
      if (!this.sessionKey) this.sessionKey = { publicKey: `GSESSION${workerInstances.length}` }
      return this.sessionKey
    }
    async execute() {
      return { success: true, txHash: '0xW' }
    }
  },
  makeAgentId: (i, s) => `0x${i}${s}`,
}))

const executeBaseLegMock = vi.fn()
vi.mock('./baseLeg.js', () => ({
  executeBaseLeg: (...a) => executeBaseLegMock(...a),
}))

import { OrchestratorAgent } from './orchestrator.js'

describe('orchestrator base leg (Task 8)', () => {
  beforeEach(() => {
    deployAgentForSessionMock.mockReset()
    let n = 0
    deployAgentForSessionMock.mockImplementation(async () => `CFRESH${++n}`)
    fundAgentMock.mockClear()
    takeReusableAgentMock.mockReset()
    takeReusableAgentMock.mockResolvedValue(null)
    saveCachedAgentMock.mockClear()
    readTokenBalanceMock.mockReset()
    readTokenBalanceMock.mockImplementation(async (addr) => (addr === 'GUSER' ? null : 0n))
    workerInstances.length = 0
    executeBaseLegMock.mockReset()
    executeBaseLegMock.mockResolvedValue({ success: true, burnHash: 'B', jobId: 'j1' })
  })

  it('splits mixed strategy: stellar vaults go to workers, base vaults to executeBaseLeg', async () => {
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's1',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      {
        vaults: [
          { address: 'CSTELLAR', allocation: 0.6, chain: 'stellar' },
          { address: '0xBASE', allocation: 0.4, chain: 'base' },
        ],
      },
      100
    )
    // Only the stellar vault produced a worker.
    expect(workerInstances).toHaveLength(1)
    expect(workerInstances[0].vault).toBe('CSTELLAR')
    expect(executeBaseLegMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedAddress: 'GUSER',
        baseVaults: [expect.objectContaining({ address: '0xBASE' })],
        totalAmount: 100,
      })
    )
    expect(summary.baseLeg).toMatchObject({ success: true, jobId: 'j1' })
    expect(summary.completed).toBe(1) // Stellar-only count, Base leg reported separately
    expect(summary.failed).toBe(0)
  })

  it('no chain field on any vault keeps every vault on the Stellar path (regression)', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1b', onEvent: vi.fn() })
    const summary = await orch.dispatch({ vaults: [{ address: 'CSTELLAR', allocation: 1 }] }, 100)
    expect(workerInstances).toHaveLength(1)
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(summary.baseLeg).toBeNull()
  })

  it('base leg failure never rejects dispatch', async () => {
    executeBaseLegMock.mockResolvedValueOnce({ success: false, stage: 'farm', error: 'down' })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's2',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      { vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] },
      50
    )
    expect(summary.baseLeg).toEqual({ success: false, stage: 'farm', error: 'down' })
    // No stellar vaults in this strategy → the (empty) stellar leg still "succeeds" with 0 agents.
    expect(summary.completed).toBe(0)
    expect(summary.failed).toBe(0)
  })

  it('a rejected base leg promise (belt-and-braces) maps to a failed baseLeg summary, dispatch still resolves', async () => {
    executeBaseLegMock.mockRejectedValueOnce(new Error('unexpected throw'))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's2b',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      { vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] },
      50
    )
    expect(summary.baseLeg).toEqual({
      success: false,
      stage: 'dispatch',
      error: 'unexpected throw',
    })
  })

  it('no baseLegContext -> base vaults are refused loudly, not silently dropped', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's3', onEvent: vi.fn() })
    await expect(
      orch.dispatch({ vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] }, 50)
    ).rejects.toThrow(/base leg context/i)
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })
})
