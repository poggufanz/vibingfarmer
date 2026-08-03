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

// Fresh pass token so Enforcement B (worker-side assertion) lets execute() proceed.
const goodToken = () => ({
  protocolSlug: 'aave-v3',
  planIndex: 0,
  eligible: true,
  verdictHash: '1',
  asOf: Date.now(),
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
      eligibilityToken: goodToken(),
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

  test("emits the swap step as SKIPPED so the UI's 3-step progress can reach 3/3 (6/9 freeze regression)", async () => {
    // The exec screen counts swap/approve/deposit per agent; 'completed' confirms approve +
    // deposit, but swap is only ever set by a worker step event. Without this emission every
    // agent tops out at 2/3 → a 3-agent run freezes at 6/9 "waiting for relayer" forever.
    runAgentDeposit.mockResolvedValue({ hash: 'abc123', status: 'SUCCESS' })
    readVaultShares.mockResolvedValueOnce(0n).mockResolvedValue(50_000_000n)
    const events = []
    const w = new WorkerAgent({
      agentId: 'worker-1',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 50_000_000n,
      sessionId: 's1b',
      onEvent: (n, d) => events.push({ n, d }),
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
    })
    await w.execute()
    const swapIdx = events.findIndex(
      (e) => e.n === 'step' && e.d.step === 'swap' && e.d.status === 'skipped'
    )
    const depositIdx = events.findIndex((e) => e.n === 'step' && e.d.step === 'deposit')
    const completedIdx = events.findIndex((e) => e.n === 'completed')
    expect(swapIdx).toBeGreaterThan(-1) // emitted at all…
    expect(swapIdx).toBeLessThan(depositIdx) // …before the deposit step…
    expect(completedIdx).toBeGreaterThan(swapIdx) // …and the run still completes.
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
      eligibilityToken: goodToken(),
      verifyAttempts: 2,
      verifyIntervalMs: 0, // keep the test fast
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/shares did not increase/)
  })

  // Task 6 chunk C1 -- the deposit tx itself succeeded (a real hash was assigned by the relay)
  // but the confirming event (shares minting) never showed up. The orchestrator's receipt
  // producer needs to tell this apart from every OTHER deposit failure (missing agent, relay
  // unconfigured, gate-skipped, ...) so it can call confirmCustody with txSuccess:true,
  // matchingEvent:false -- proving custody correctly stays at stellar-agent rather than advancing
  // to stellar-vault on transaction success alone.
  test('a shares-did-not-increase failure carries the real txHash and txSuccess:true, not a plain failure', async () => {
    runAgentDeposit.mockResolvedValue({ hash: 'TXHASH-NO-MINT', status: 'SUCCESS' })
    readVaultShares.mockResolvedValue(0n)
    const w = new WorkerAgent({
      agentId: 'worker-2b',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 10_000_000n,
      sessionId: 's1',
      onEvent: () => {},
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
      verifyAttempts: 1,
      verifyIntervalMs: 0,
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.txHash).toBe('TXHASH-NO-MINT')
    expect(res.txSuccess).toBe(true)
  })

  // Task 6 chunk C1 -- runAgentDeposit's new indeterminate-outcome path (agentDeposit.js) must
  // surface through execute() as its own outcome: never success, never a plain failure.
  test('an indeterminate deposit (active account changed mid-submission) reports status:"unknown", never success', async () => {
    const submissionUnknown = new Error('active account changed after deposit dispatch')
    submissionUnknown.code = 'VF_SUBMISSION_UNKNOWN'
    submissionUnknown.custody = { location: 'unknown', confirmed: false }
    runAgentDeposit.mockRejectedValue(submissionUnknown)
    const w = new WorkerAgent({
      agentId: 'worker-2c',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 10_000_000n,
      sessionId: 's1',
      onEvent: () => {},
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.status).toBe('unknown')
    expect(res.custody).toEqual({ location: 'unknown', confirmed: false })
  })

  // Task 6 chunk C1 -- WorkerAgent must thread activeAccount/getCurrentActiveAccount/signal
  // straight through to runAgentDeposit so the indeterminate-outcome check above has anything to
  // check against at the real integration point (orchestrator constructs these per-worker).
  test('threads activeAccount/getCurrentActiveAccount/signal through to runAgentDeposit', async () => {
    runAgentDeposit.mockResolvedValue({ hash: 'abc123', status: 'SUCCESS' })
    readVaultShares.mockResolvedValueOnce(0n).mockResolvedValue(50_000_000n)
    const activeAccount = { version: 1, address: 'GUSER' }
    const getCurrentActiveAccount = () => activeAccount
    const signal = new AbortController().signal
    const w = new WorkerAgent({
      agentId: 'worker-2d',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 50_000_000n,
      sessionId: 's1',
      onEvent: () => {},
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
      activeAccount,
      getCurrentActiveAccount,
      signal,
    })
    await w.execute()
    expect(runAgentDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ activeAccount, getCurrentActiveAccount, signal })
    )
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
      eligibilityToken: goodToken(),
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Stellar relay is unavailable/)
  })

  test('maps submit-gate codes to user-facing copy', async () => {
    const events = []
    const w = new WorkerAgent({
      agentId: 'worker-gated',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 10_000_000n,
      sessionId: 's1',
      onEvent: (name, data) => events.push({ name, data }),
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
      submitGate: { check: () => ({ ok: false, reason: 'rate_anomaly' }) },
    })
    const res = await w.execute()
    expect(res.reason).toBe('Too many deposit attempts. Try again in one minute.')
    expect(events.find((e) => e.name === 'failed').data.error).toBe(res.reason)
    expect(runAgentDeposit).not.toHaveBeenCalled()
  })

  test('emits pull-confirmed once the relay reports SUCCESS, BEFORE the deposit is confirmed (Task 13, decision log #22 obligation B)', async () => {
    // Before this emit existed, flowState.js's PULL_CONFIRMED event had zero producers in the
    // tree, so a receipt could never legitimately record a pull leg. The relay's SUCCESS status
    // is the real, earliest evidence available here -- the deposit's own share-mint confirmation
    // (verifyMinted, slower) is separate and must not gate this earlier, distinct fact.
    runAgentDeposit.mockResolvedValue({ hash: 'abc123', status: 'SUCCESS' })
    readVaultShares.mockResolvedValueOnce(0n).mockResolvedValue(50_000_000n)
    const events = []
    const w = new WorkerAgent({
      agentId: 'worker-1',
      allocationId: 'run1:deposit:0',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 50_000_000n,
      sessionId: 's1',
      onEvent: (n, d) => events.push({ n, d }),
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
    })
    await w.execute()
    const pullIdx = events.findIndex((e) => e.n === 'pull-confirmed')
    const completedIdx = events.findIndex((e) => e.n === 'completed')
    expect(pullIdx).toBeGreaterThan(-1)
    expect(pullIdx).toBeLessThan(completedIdx)
    expect(events[pullIdx].d.allocationId).toBe('run1:deposit:0') // same emit() wrapper, same contract
  })

  test('does NOT emit pull-confirmed when the relay never reports SUCCESS (a rejected/unconfigured relay pulled nothing)', async () => {
    runAgentDeposit.mockResolvedValue(null)
    readVaultShares.mockResolvedValue(0n)
    const events = []
    const w = new WorkerAgent({
      agentId: 'worker-3',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 10_000_000n,
      sessionId: 's1',
      onEvent: (n, d) => events.push({ n, d }),
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
    })
    await w.execute()
    expect(events.some((e) => e.n === 'pull-confirmed')).toBe(false)
  })

  test('carries allocationId on every emitted event (Task 6 custody-keying contract)', async () => {
    runAgentDeposit.mockResolvedValue({ hash: 'abc123', status: 'SUCCESS' })
    readVaultShares.mockResolvedValueOnce(0n).mockResolvedValue(50_000_000n)
    const events = []
    const w = new WorkerAgent({
      agentId: 'worker-1',
      allocationId: 'run1:deposit:0',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 50_000_000n,
      sessionId: 's1',
      onEvent: (n, d) => events.push({ n, d }),
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
    })
    await w.execute()
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.d.allocationId === 'run1:deposit:0')).toBe(true)
  })

  test('defaults allocationId to null when not provided (legacy callers unaffected)', async () => {
    runAgentDeposit.mockResolvedValue(null)
    readVaultShares.mockResolvedValue(0n)
    const events = []
    const w = new WorkerAgent({
      agentId: 'worker-3',
      user: 'GUSER',
      vault: 'CCDX...',
      amount: 10_000_000n,
      sessionId: 's1',
      onEvent: (n, d) => events.push({ n, d }),
      agentAddress: 'CCRG...AGENT',
      sessionKey: sessionKey(),
      eligibilityToken: goodToken(),
    })
    await w.execute()
    expect(events.find((e) => e.n === 'failed').d.allocationId).toBeNull()
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
      eligibilityToken: goodToken(),
    })
    const res = await w.execute()
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Agent address is missing/)
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
