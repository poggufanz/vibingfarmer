import { describe, test, expect, vi, beforeEach } from 'vitest'

// Stellar deposit path is mocked so execute() runs without a chain or relay.
vi.mock('./stellar/agentDeposit.js', () => ({
  runAgentDeposit: vi.fn(),
  readVaultShares: vi.fn(),
}))
// memory.js writes to localStorage (absent in the node test env) — mock it.
vi.mock('./memory.js', () => ({
  writeMemory: vi.fn(),
  createEntry: (step, status, data = {}, lesson) => ({ step, status, ...data, lesson }),
  buildLesson: () => 'lesson',
}))

import { WorkerAgent, makeAgentId, makePlanId } from './worker.js'
import { runAgentDeposit, readVaultShares } from './stellar/agentDeposit.js'

const sessionKey = () => ({
  rawPublicKey: new Uint8Array(32),
  sign: () => new Uint8Array(64),
  publicKey: 'GSESSION',
})

describe('WorkerAgent (Stellar)', () => {
  beforeEach(() => vi.clearAllMocks())

  test('deposits via the relay and confirms minted shares', async () => {
    // Arrange: baseline 0 → minted 50_000_000.
    runAgentDeposit.mockResolvedValue({ hash: 'abc123', status: 'SUCCESS' })
    readVaultShares.mockResolvedValueOnce(0n).mockResolvedValue(50_000_000n)
    const w = new WorkerAgent({
      agentId: 'worker-1',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 50_000_000n,
      sessionId: 's1',
      onEvent: () => {},
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
    })
    // Act
    const res = await w.execute()
    // Assert
    expect(res.success).toBe(true)
    expect(res.txHash).toBe('abc123')
    expect(runAgentDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ agentAddress: 'CCRG...AGENT', amount: 50_000_000n })
    )
  })

  test('fails honestly when shares did not increase', async () => {
    runAgentDeposit.mockResolvedValue({ hash: 'abc', status: 'SUCCESS' })
    readVaultShares.mockResolvedValue(0n) // baseline 0, stays 0 → no mint
    const w = new WorkerAgent({
      agentId: 'worker-2',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 10_000_000n,
      sessionId: 's1',
      onEvent: () => {},
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      verifyAttempts: 2,
      verifyIntervalMs: 0, // keep the test fast
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/shares did not increase/)
  })

  test('fails when the relay is unconfigured (null result)', async () => {
    runAgentDeposit.mockResolvedValue(null)
    readVaultShares.mockResolvedValue(0n)
    const w = new WorkerAgent({
      agentId: 'worker-3',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 10_000_000n,
      sessionId: 's1',
      onEvent: () => {},
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/relay unconfigured/)
  })

  test('fails when no agentAddress was provided', async () => {
    const w = new WorkerAgent({
      agentId: 'worker-4',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 10_000_000n,
      sessionId: 's1',
      onEvent: () => {},
      sessionKey: sessionKey(),
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/agentAddress missing/)
    expect(runAgentDeposit).not.toHaveBeenCalled()
  })
})

describe('id helpers', () => {
  test('makeAgentId is a deterministic 0x bytes32', () => {
    const a = makeAgentId(0, 's1')
    expect(a).toBe(makeAgentId(0, 's1'))
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
  })
  test('makePlanId is deterministic and a bigint', () => {
    expect(makePlanId('s1')).toBe(makePlanId('s1'))
    expect(typeof makePlanId('s1')).toBe('bigint')
  })
})
