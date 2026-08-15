import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  newSessionKey: vi.fn(),
  readTokenBalance: vi.fn(async () => null),
  readVaultShares: vi.fn(),
  runAgentDeposit: vi.fn(),
  readBaseMandate: vi.fn(() => ({ kernelAddress: '0x1111111111111111111111111111111111111111' })),
  submitGrant: vi.fn(),
  runAgentPull: vi.fn(),
  readAllowance: vi.fn(),
  deployAgentForSession: vi.fn(),
  fundAgent: vi.fn(),
  registryAuthorizeAgent: vi.fn(),
  takeReusableAgent: vi.fn(),
  saveCachedAgent: vi.fn(),
  postReceiptEvidence: vi.fn(),
  worker: vi.fn(),
  event: vi.fn(),
}))

vi.mock('./stellar/sessionKey.js', () => ({
  newSessionKey: (...args) => calls.newSessionKey(...args),
}))
vi.mock('./stellar/agentDeposit.js', () => ({
  readTokenBalance: (...args) => calls.readTokenBalance(...args),
  readVaultShares: (...args) => calls.readVaultShares(...args),
  runAgentDeposit: (...args) => calls.runAgentDeposit(...args),
}))
vi.mock('./wallet/baseBinding.js', () => ({
  readBaseMandate: (...args) => calls.readBaseMandate(...args),
}))
vi.mock('./stellar/grant.js', () => ({
  submitGrant: (...args) => calls.submitGrant(...args),
  runAgentPull: (...args) => calls.runAgentPull(...args),
  readAllowance: (...args) => calls.readAllowance(...args),
  AGENT_KIND_DEPOSIT: 0,
  AGENT_KIND_BRIDGE: 1,
}))
vi.mock('./stellar/agentSetup.js', () => ({
  deployAgentForSession: (...args) => calls.deployAgentForSession(...args),
  fundAgent: (...args) => calls.fundAgent(...args),
  registryAuthorizeAgent: (...args) => calls.registryAuthorizeAgent(...args),
}))
vi.mock('./stellar/agentCache.js', () => ({
  takeReusableAgent: (...args) => calls.takeReusableAgent(...args),
  saveCachedAgent: (...args) => calls.saveCachedAgent(...args),
}))
vi.mock('./stellar/agentIndexReceiptClient.js', () => ({
  postReceiptEvidence: (...args) => calls.postReceiptEvidence(...args),
}))
vi.mock('./worker.js', () => ({
  WorkerAgent: class {
    constructor() {
      calls.worker()
    }
  },
  makeAgentId: (index, sessionId) => `${sessionId}:${index}`,
}))
vi.mock('./strategist.js', () => ({ generateAgentSkills: vi.fn() }))
vi.mock('./skills.js', () => ({ saveSkill: vi.fn() }))
vi.mock('./stellar/agentCreatorManifest.js', () => ({
  isLegacyDirectSetupAllowed: vi.fn(() => false),
}))

import { OrchestratorAgent } from './orchestrator.js'

const baseVault = {
  chain: 'base',
  address: '0x1111111111111111111111111111111111111112',
  allocation: 1,
}

function orchestrator() {
  return new OrchestratorAgent({
    user: 'GOWNER',
    sessionId: 'session-unavailable',
    baseLegContext: { connectedAddress: 'GOWNER', signTx: vi.fn() },
    onEvent: calls.event,
  })
}

function expectNoExecutionSideEffects() {
  for (const dependency of Object.values(calls)) expect(dependency).not.toHaveBeenCalled()
}

describe('OrchestratorAgent legacy Base deployment fence', () => {
  beforeEach(() => {
    for (const dependency of Object.values(calls)) dependency.mockClear()
  })

  it('rejects a legacy crafted Base strategy before balance/mandate/key/grant/relay/worker work', async () => {
    await expect(
      orchestrator().dispatch({ runId: 'run-legacy-crafted', vaults: [baseVault] }, 1)
    ).rejects.toMatchObject({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' })

    expectNoExecutionSideEffects()
  })

  it('rejects a direct permissioned bridge dispatch before validation, grant, storage, or pull', async () => {
    const plan = {
      runId: 'run-permission-crafted',
      planFingerprint: '0xcrafted',
      agents: [{ allocationId: 'run-permission-crafted:bridge:base', kind: 'bridge' }],
    }

    await expect(
      orchestrator().dispatchPermissioned(plan, { permissionDecision: { mode: 'fresh' } })
    ).rejects.toMatchObject({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' })

    expectNoExecutionSideEffects()
  })

  it('guards the lower-level router setup/grant helpers before key setup or wallet submission', async () => {
    const orch = orchestrator()
    const setupKey = vi.fn()
    const bridgeInit = {
      kind: 1,
      cap: 1n,
      token: 'CUSDC',
      rawPublicKey: new Uint8Array(32),
    }

    await expect(
      orch.setupViaRouter([{ amount: 1n, setupKey }], 2_000_000_000, bridgeInit)
    ).rejects.toMatchObject({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' })
    await expect(
      orch.grantFreshAgents([], 0n, 2_000_000_000, 1_900_000_000, bridgeInit)
    ).rejects.toMatchObject({ code: 'BASE_CROSS_CHAIN_UNAVAILABLE' })

    expect(setupKey).not.toHaveBeenCalled()
    expectNoExecutionSideEffects()
  })
})
