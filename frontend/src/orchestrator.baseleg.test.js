// frontend/src/orchestrator.baseleg.test.js
// Task 8 + Task 7 rework: dispatch() splits strategy.vaults by chain and runs the Base leg
// (baseLeg.js's executeBaseLeg) as a settled sibling of the Stellar worker pipeline — AND, per
// the grant-covers-burn design (docs/superpowers/specs/2026-07-21-grant-covers-burn-design.md
// §4-5), a mixed run's bridge agent joins the SAME single funding_router grant as the Stellar
// deposit workers, never a second signature. A bridge agent can only be created via the router
// (never the legacy per-agent deploy), so this file exercises the ROUTER path — same seam as
// orchestrator.router.test.js — with executeBaseLeg mocked (its own contract is baseLeg.test.js's
// job) and mergeFlowHelpers.js's readStoredBaseMandate mocked (its own contract is
// app.strategy.merge.test.jsx's job).
import { describe, it, expect, beforeEach, vi } from 'vitest'

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

const readStoredBaseMandateMock = vi.fn()
vi.mock('./mergeFlowHelpers.js', () => ({
  readStoredBaseMandate: (...a) => readStoredBaseMandateMock(...a),
}))

const takeReusableAgentMock = vi.fn(async () => null)
const saveCachedAgentMock = vi.fn()
vi.mock('./stellar/agentCache.js', () => ({
  takeReusableAgent: (...a) => takeReusableAgentMock(...a),
  saveCachedAgent: (...a) => saveCachedAgentMock(...a),
}))

vi.mock('./stellar/sessionKey.js', () => ({
  newSessionKey: (secret) => ({
    publicKey: secret ? 'GRESTORED' : 'GFRESH',
    secret,
    rawPublicKey: new Uint8Array(32),
    sign: () => new Uint8Array(64),
  }),
}))

const readTokenBalanceMock = vi.fn(async () => null)
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...a) => readTokenBalanceMock(...a),
}))

// Router path (default once funding_router is live) — the only path a bridge agent can go
// through, since deploying one requires the router's kind:Bridge AgentInit, never the legacy
// per-agent deploy call.
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
        this.sessionKey = {
          publicKey: `GPUB${workerInstances.length}`,
          secret: `S${workerInstances.length}`,
          rawPublicKey: new Uint8Array(32),
        }
      }
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
import { STELLAR_USDC_SAC } from './stellar/cctpBurn.js'

const KERNEL = '0x0000000000000000000000000000000000000AA1'

// grantAddresses walks agentInits in order; the LAST entry is the bridge agent iff its kind===1 —
// mirrors grant.js's own additive bridgeAgentAddress logic exactly, so the mock stays honest.
function fakeSubmitGrant({ agentInits }) {
  const agentAddresses = agentInits.map((_, i) => `CFRESH${i + 1}`)
  const last = agentInits[agentInits.length - 1]
  const bridgeAgentAddress = last?.kind === 1 ? agentAddresses[agentAddresses.length - 1] : null
  return { hash: 'HG', status: 'SUCCESS', agentAddresses, bridgeAgentAddress, expiryLedger: 9999 }
}

beforeEach(() => {
  workerInstances.length = 0
  submitGrantMock.mockReset()
  submitGrantMock.mockImplementation(async (args) => fakeSubmitGrant(args))
  runAgentPullMock.mockReset()
  runAgentPullMock.mockResolvedValue({ hash: 'HP', status: 'SUCCESS' })
  readAllowanceMock.mockReset()
  readAllowanceMock.mockResolvedValue({ amount: 0n, liveUntilLedger: null }) // forces the grant path
  takeReusableAgentMock.mockReset()
  takeReusableAgentMock.mockResolvedValue(null)
  saveCachedAgentMock.mockClear()
  readTokenBalanceMock.mockReset()
  readTokenBalanceMock.mockImplementation(async (addr) => (addr === 'GUSER' ? null : 0n))
  readStoredBaseMandateMock.mockReset()
  readStoredBaseMandateMock.mockReturnValue({
    kernelAddress: KERNEL,
    serializedApproval: 'APPROVAL',
    sessionKeyAddress: '0xSESSION',
    expiry: 9999999999,
  })
  executeBaseLegMock.mockReset()
  executeBaseLegMock.mockResolvedValue({ success: true, burnHash: 'B', jobId: 'j1' })
})

describe('orchestrator base leg — mixed run costs exactly ONE grant signature', () => {
  it('splits mixed strategy: stellar vaults go to workers, base vaults to executeBaseLeg, ONE grant covers both', async () => {
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

    // Exactly ONE grant call, carrying the deposit worker AND the bridge agent.
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.agentInits).toHaveLength(2)
    expect(grantArgs.agentInits[0].kind).toBe(0) // deposit worker
    expect(grantArgs.agentInits[1].kind).toBe(1) // bridge, last
    expect(grantArgs.agentInits[1].mintRecipient).toBeInstanceOf(Uint8Array)
    expect(grantArgs.budgets).toHaveLength(2) // VFUSD + Circle USDC

    // The Base leg receives the SAME grant's bridge agent + its session key + the kernelAddress
    // orchestrator.js already read (never re-read by baseLeg.js — IMPORTANT 2 fix) — never signTx.
    expect(executeBaseLegMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedAddress: 'GUSER',
        bridgeAgentAddress: 'CFRESH2',
        bridgeSessionKey: expect.any(Object),
        kernelAddress: KERNEL,
        baseVaults: [expect.objectContaining({ address: '0xBASE' })],
        totalAmount: 100,
      })
    )
    const call = executeBaseLegMock.mock.calls[0][0]
    expect(call.signTx).toBeUndefined()

    expect(summary.baseLeg).toMatchObject({ success: true, jobId: 'j1' })
    expect(summary.completed).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it('an all-Base strategy (zero Stellar deposit workers) still grants — bridge init only, no deposit budget entry', async () => {
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-allbase',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await orch.dispatch({ vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] }, 50)

    expect(workerInstances).toHaveLength(0)
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.agentInits).toHaveLength(1)
    expect(grantArgs.agentInits[0].kind).toBe(1)
    expect(grantArgs.budgets).toEqual([{ budget: expect.any(BigInt), token: STELLAR_USDC_SAC }])
    expect(executeBaseLegMock).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeAgentAddress: 'CFRESH1' })
    )
  })

  it('a bridge leg forces the grant path even when the Stellar allowance already covers cached reuse (never partially cached)', async () => {
    readAllowanceMock.mockResolvedValue({ amount: 500_0000000n, liveUntilLedger: null })
    takeReusableAgentMock.mockResolvedValue({ agentAddress: 'CCACHED', secret: 'S' })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-forced',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await orch.dispatch(
      {
        vaults: [
          { address: 'CSTELLAR', allocation: 0.5, chain: 'stellar' },
          { address: '0xBASE', allocation: 0.5, chain: 'base' },
        ],
      },
      100
    )
    // A bridge agent can never come from cache — its presence forces the grant, which then also
    // deploys the (otherwise cache-eligible) Stellar worker fresh, rather than mixing reuse+grant.
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
    expect(takeReusableAgentMock).not.toHaveBeenCalled()
  })

  it('no chain field on any vault keeps every vault on the Stellar path (regression) — no mandate read, no bridge', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's1b', onEvent: vi.fn() })
    const summary = await orch.dispatch({ vaults: [{ address: 'CSTELLAR', allocation: 1 }] }, 100)
    expect(workerInstances).toHaveLength(1)
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(readStoredBaseMandateMock).not.toHaveBeenCalled()
    expect(summary.baseLeg).toBeNull()
    const grantArgs = submitGrantMock.mock.calls[0][0]
    expect(grantArgs.agentInits).toHaveLength(1) // deposit worker only, no bridge init appended
  })

  it('no stored Base mandate -> dispatch aborts before any work (mandate setup is its own ceremony, never a run)', async () => {
    readStoredBaseMandateMock.mockReturnValue(null)
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-nomandate',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await expect(
      orch.dispatch(
        {
          vaults: [
            { address: 'CSTELLAR', allocation: 0.5, chain: 'stellar' },
            { address: '0xBASE', allocation: 0.5, chain: 'base' },
          ],
        },
        100
      )
    ).rejects.toThrow(/no durable base mandate/i)
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('a failed grant fails BOTH legs — no partial agents, Base leg never reached', async () => {
    submitGrantMock.mockRejectedValue(new Error('grant signature declined'))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-grantfail',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await expect(
      orch.dispatch(
        {
          vaults: [
            { address: 'CSTELLAR', allocation: 0.5, chain: 'stellar' },
            { address: '0xBASE', allocation: 0.5, chain: 'base' },
          ],
        },
        100
      )
    ).rejects.toThrow(/Agent setup failed for all 1 agents/)
    expect(executeBaseLegMock).not.toHaveBeenCalled()
  })

  it('a failed grant on an ALL-BASE strategy (no Stellar worker to fail loudly) surfaces a message naming the real cause, not a generic one', async () => {
    // No Stellar workers here, so dispatch() itself does not reject (the pre-existing
    // "all agents failed" check only fires when workers.length > 0) — the Base leg's OWN
    // rejection is what must carry a useful message (MINOR fix: name grant-failure-or-no-router,
    // not the old vague "did not deploy an agent").
    submitGrantMock.mockRejectedValue(new Error('grant signature declined'))
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's-grantfail-allbase',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    const summary = await orch.dispatch(
      { vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] },
      50
    )
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(summary.baseLeg.success).toBe(false)
    expect(summary.baseLeg.error).toMatch(/funding router|grant failed/i)
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
    // No stellar vaults in this strategy -> the (empty) stellar leg still "succeeds" with 0 agents.
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

  it('mixed strategy: insufficient USDC (burn-token) balance aborts dispatch before any work', async () => {
    // VFUSD (readTokenBalance's default token) is a DIFFERENT asset from the CCTP burn token
    // (STELLAR_USDC_SAC) — a user flush with VFUSD can still be short the USDC the burn spends,
    // so this preflight must check the burn token specifically, not the vault-deposit total.
    readTokenBalanceMock.mockImplementation(async (addr, opts) => {
      if (opts?.token === STELLAR_USDC_SAC) return 1n // far short of the ~400_000_000n needed
      return addr === 'GUSER' ? null : 0n
    })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's4',
      onEvent: vi.fn(),
      baseLegContext: { connectedAddress: 'GUSER', signTx: vi.fn() },
    })
    await expect(
      orch.dispatch(
        {
          vaults: [
            { address: 'CSTELLAR', allocation: 0.6, chain: 'stellar' },
            { address: '0xBASE', allocation: 0.4, chain: 'base' },
          ],
        },
        100
      )
    ).rejects.toThrow(/USDC/i)
    // Abort-upfront: neither leg starts once the burn-token preflight fails.
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(submitGrantMock).not.toHaveBeenCalled()
    expect(workerInstances).toHaveLength(0)
  })

  it('mixed strategy: sufficient USDC (burn-token) balance proceeds as before', async () => {
    readTokenBalanceMock.mockImplementation(async (addr, opts) => {
      if (opts?.token === STELLAR_USDC_SAC) return 10_000_000_000n // plenty
      return addr === 'GUSER' ? null : 0n
    })
    const orch = new OrchestratorAgent({
      user: 'GUSER',
      sessionId: 's5',
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
    expect(summary.baseLeg).toMatchObject({ success: true })
    expect(workerInstances).toHaveLength(1)
    expect(submitGrantMock).toHaveBeenCalledTimes(1)
  })

  it('no baseLegContext -> base vaults are refused loudly, not silently dropped', async () => {
    const orch = new OrchestratorAgent({ user: 'GUSER', sessionId: 's3', onEvent: vi.fn() })
    await expect(
      orch.dispatch({ vaults: [{ address: '0xBASE', allocation: 1, chain: 'base' }] }, 50)
    ).rejects.toThrow(/base leg context/i)
    expect(executeBaseLegMock).not.toHaveBeenCalled()
    expect(submitGrantMock).not.toHaveBeenCalled()
  })
})
