// frontend/src/strategy/monitorLoop.test.js
import { describe, it, expect, vi } from 'vitest'
import { createMonitorLoop } from './monitorLoop.js'

const calmState = { market: { turbulence: 'calm' } }

function makeDeps(overrides = {}) {
  const saved = []
  const reflect = vi.fn()
  return {
    saved, reflect,
    deps: {
      getState: vi.fn(async () => calmState),
      runGates: vi.fn(() => ({ allocations: [{ address: '0xB', allocation: 1 }], violations: [] })),
      simulate: vi.fn(() => ({ riskAdjustedScore: 6, projectedAnnualUsdc: 140 })),
      council: vi.fn(async () => ({ verdict: 'keep', reason: null, confidence: 0.8, citedRules: ['yield-uplift'], specialists: [], resolvedBy: 'unanimous' })),
      execute: vi.fn(async () => '0xtxhash'),
      reflect,
      journal: { saveCycle: (r) => saved.push(r) },
      heartbeatMs: 10_000,
      ...overrides,
    },
  }
}

describe('createMonitorLoop', () => {
  it('idle heartbeat journals verdict idle, no execute', async () => {
    const { saved, deps } = makeDeps()
    const loop = createMonitorLoop(deps)
    await loop.submitIdea(null)
    expect(deps.execute).not.toHaveBeenCalled()
    expect(saved[0]).toMatchObject({ cycle: 1, phase: 'observe', verdict: 'idle', turbulence: 'calm' })
  })

  it('keep verdict executes, reflects success, journals txHash + citedRules', async () => {
    const { saved, reflect, deps } = makeDeps()
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(deps.execute).toHaveBeenCalledOnce()
    expect(reflect).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'keep', outcome: 'success', citedRules: ['yield-uplift'] }))
    expect(saved[0]).toMatchObject({ cycle: 1, phase: 'execute', verdict: 'keep', txHash: '0xtxhash', citedRules: ['yield-uplift'] })
  })

  it('discard verdict journals reason, no execute/reflect', async () => {
    const { saved, reflect, deps } = makeDeps({
      council: vi.fn(async () => ({ verdict: 'discard', reason: 'Risk Analyst', confidence: 0.9, citedRules: [], specialists: [], resolvedBy: 'veto' })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(deps.execute).not.toHaveBeenCalled()
    expect(reflect).not.toHaveBeenCalled()
    expect(saved[0]).toMatchObject({ verdict: 'discard', reason: 'Risk Analyst' })
  })

  it('NEVER STOPS: throwing execute → crash row, reflects failure, loop survives', async () => {
    const { saved, reflect, deps } = makeDeps({ execute: vi.fn(async () => { throw new Error('rpc timeout') }) })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(saved[0]).toMatchObject({ phase: 'crash', verdict: 'crash', error: 'rpc timeout' })
    expect(reflect).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }))
    await loop.submitIdea(null)
    expect(saved[1]).toMatchObject({ cycle: 2, verdict: 'idle' })
  })

  it('throwing getState is caught as crash and never rejects', async () => {
    const { saved, deps } = makeDeps({ getState: vi.fn(async () => { throw new Error('no rpc') }) })
    const loop = createMonitorLoop(deps)
    await expect(loop.submitIdea(null)).resolves.toBeUndefined()
    expect(saved[0]).toMatchObject({ verdict: 'crash', error: 'no rpc' })
  })

  it('start() runs an immediate tick then on interval; stop() halts', async () => {
    vi.useFakeTimers()
    const { saved, deps } = makeDeps()
    const loop = createMonitorLoop(deps)
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(loop.isRunning()).toBe(true)
    expect(saved.length).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saved.length).toBe(2)
    loop.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(saved.length).toBe(2)
    expect(loop.isRunning()).toBe(false)
    vi.useRealTimers()
  })

  it('start() is idempotent', async () => {
    vi.useFakeTimers()
    const { saved, deps } = makeDeps()
    const loop = createMonitorLoop(deps)
    loop.start(); loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(saved.length).toBe(1)
    loop.stop()
    vi.useRealTimers()
  })

  it('gated idea sleeps without simulate/council/execute (saves AI credit)', async () => {
    const { saved, deps } = makeDeps({
      gates: vi.fn(() => ({ passed: false, blockedBy: 'turbulence', reason: 'turbulent market — deposit blocked', results: [] })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'deposit', proposed: [], currentAllocations: [] })
    expect(deps.gates).toHaveBeenCalledOnce()
    expect(deps.simulate).not.toHaveBeenCalled()
    expect(deps.council).not.toHaveBeenCalled()
    expect(deps.execute).not.toHaveBeenCalled()
    expect(saved[0]).toMatchObject({ cycle: 1, phase: 'gate', verdict: 'gated', gate: 'turbulence' })
  })

  it('passing gates proceed to council as before', async () => {
    const { saved, deps } = makeDeps({
      gates: vi.fn(() => ({ passed: true, blockedBy: null, reason: null, results: [] })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(deps.council).toHaveBeenCalledOnce()
    expect(saved[0]).toMatchObject({ verdict: 'keep' })
  })

  it('defaults to pass-through gates when none injected', async () => {
    const { deps } = makeDeps()
    delete deps.gates
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(deps.council).toHaveBeenCalledOnce()
  })
})

describe('createMonitorLoop recordDecision', () => {
  it('records a decision on keep (council deliberated)', async () => {
    const recordDecision = vi.fn()
    const { deps } = makeDeps({ recordDecision })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(recordDecision).toHaveBeenCalledOnce()
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ cycle: 1, verdict: expect.objectContaining({ verdict: 'keep' }) }),
    )
  })

  it('records a decision on discard', async () => {
    const recordDecision = vi.fn()
    const { deps } = makeDeps({
      recordDecision,
      council: vi.fn(async () => ({ verdict: 'discard', reason: 'Risk Analyst', confidence: 0.9, citedRules: [], specialists: [], resolvedBy: 'veto' })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(recordDecision).toHaveBeenCalledOnce()
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: expect.objectContaining({ verdict: 'discard' }) }),
    )
  })

  it('does NOT record on idle (no council ran)', async () => {
    const recordDecision = vi.fn()
    const { deps } = makeDeps({ recordDecision })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea(null)
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('does NOT record on a gated cycle', async () => {
    const recordDecision = vi.fn()
    const { deps } = makeDeps({ recordDecision, gates: () => ({ passed: false, blockedBy: 'gas', reason: 'gas too high' }) })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('a throwing recordDecision never breaks the cycle', async () => {
    const recordDecision = vi.fn(() => { throw new Error('storage full') })
    const { saved, deps } = makeDeps({ recordDecision })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(saved[0]).toMatchObject({ verdict: 'keep' }) // journal still wrote → loop survived
  })
})

describe('createMonitorLoop curate (ACE grow)', () => {
  it('curates on a failed execution (harmful outcome)', async () => {
    const curate = vi.fn()
    const { deps } = makeDeps({ curate, execute: vi.fn(async () => { throw new Error('reverted') }) })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(curate).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', reason: 'reverted' }))
  })

  it('curates when the council resolved by ai-conflict', async () => {
    const curate = vi.fn()
    const { deps } = makeDeps({
      curate,
      council: vi.fn(async () => ({ verdict: 'keep', reason: null, confidence: 0.6, citedRules: ['yield-uplift'], specialists: [], resolvedBy: 'ai-conflict' })),
    })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(curate).toHaveBeenCalledWith(expect.objectContaining({ resolvedBy: 'ai-conflict' }))
  })

  it('does NOT curate on a clean unanimous keep', async () => {
    const curate = vi.fn()
    const { deps } = makeDeps({ curate })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(curate).not.toHaveBeenCalled()
  })

  it('a throwing curate never stops the loop', async () => {
    const curate = vi.fn(() => { throw new Error('venice down') })
    const { saved, deps } = makeDeps({ curate, council: vi.fn(async () => ({ verdict: 'keep', confidence: 0.6, citedRules: ['yield-uplift'], specialists: [], resolvedBy: 'ai-conflict' })) })
    const loop = createMonitorLoop(deps)
    await loop.submitIdea({ kind: 'rebalance', proposed: [], currentAllocations: [] })
    expect(saved[0]).toMatchObject({ verdict: 'keep' }) // journal still wrote → loop survived
  })
})