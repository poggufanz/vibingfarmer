// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createActiveAccountEpochStore, createEpochBoundRun } from './app.jsx'
import { bindBaseLegCustodyDeps, reconcileBaseLegEpochCustody } from './orchestrator.js'

const G = Object.freeze({
  version: 1,
  kind: 'G',
  address: 'GOWNER',
  networkPassphrase: 'Test SDF Network ; September 2015',
  connectorId: 'freighter',
  epoch: 1,
})
const C = Object.freeze({ ...G, kind: 'C', address: 'COWNER', connectorId: 'vf-wallet', epoch: 2 })

describe('active account application state', () => {
  it('clears old-owner review, receipt, Base and My Money state before installing a switched account', () => {
    const clear = vi.fn()
    const store = createActiveAccountEpochStore({ initial: G, clear })

    store.install(C)

    expect(clear).toHaveBeenCalledWith(G)
    expect(store.current()).toBe(C)
  })

  it('rejects stale completions after C→G and C1→C2 transitions', () => {
    const store = createActiveAccountEpochStore({ initial: C, clear: vi.fn() })
    const c1 = store.capture()
    store.install(G)
    expect(() => store.assertCurrent(c1)).toThrow(/active wallet account changed/i)

    const g = store.capture()
    const c2 = Object.freeze({ ...C, address: 'COTHER', epoch: 3 })
    store.install(c2)
    expect(() => store.assertCurrent(g)).toThrow(/active wallet account changed/i)
  })

  it('aborts a running orchestration and drops stale events, completion and error renders', () => {
    let current = G
    const event = vi.fn()
    const completion = vi.fn()
    const failure = vi.fn()
    const run = createEpochBoundRun({ captured: G, getCurrent: () => current, onEvent: event })

    expect(run.onEvent('worker-started', { agentId: 'a1' })).toBe(true)
    current = C
    run.cancel()

    expect(run.signal.aborted).toBe(true)
    expect(run.onEvent('worker-completed', { agentId: 'a1' })).toBe(false)
    expect(run.commit(completion)).toBe(false)
    expect(run.commit(failure)).toBe(false)
    expect(event).toHaveBeenCalledTimes(1)
    expect(completion).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled()
  })

  it('binds Base pull and burn custody boundaries to the captured account', async () => {
    let current = G
    const pull = vi.fn(async () => {
      current = C
      return { hash: 'pull', status: 'SUCCESS' }
    })
    const burn = vi.fn(async () => ({ hash: 'burn', status: 'SUCCESS' }))
    const deps = bindBaseLegCustodyDeps({
      activeAccount: G,
      getCurrentActiveAccount: () => current,
      runAgentPullFn: pull,
      loadRunAgentBurn: async () => burn,
    })

    await expect(deps.runAgentPull({ amount: 1n })).resolves.toMatchObject({
      hash: 'pull',
      status: 'SUCCESS',
    })
    await expect(deps.runAgentBurn({ amount: 1n })).rejects.toMatchObject({
      code: 'ACTIVE_ACCOUNT_CHANGED',
    })
    expect(pull).toHaveBeenCalledOnce()
    expect(burn).not.toHaveBeenCalled()
  })

  it('preserves unknown Base custody when a pull response is not confirmation', async () => {
    const unknown = Object.assign(new Error('pull outcome unknown'), {
      code: 'VF_SUBMISSION_UNKNOWN',
      submission: 'unknown',
      custody: { location: 'unknown', confirmed: false },
      result: { hash: 'pull', status: 'PENDING' },
    })
    const deps = bindBaseLegCustodyDeps({
      activeAccount: G,
      getCurrentActiveAccount: () => G,
      runAgentPullFn: vi.fn(async () => {
        throw unknown
      }),
    })

    await expect(deps.runAgentPull({ amount: 1n })).rejects.toBe(unknown)
    const reconciled = reconcileBaseLegEpochCustody(
      {
        success: false,
        custody: { location: 'owner', confirmed: true },
        allocations: [{ custody: { location: 'owner', confirmed: true } }],
      },
      deps
    )
    expect(reconciled.custody).toEqual({ location: 'unknown', confirmed: false })
    expect(reconciled.allocations[0].custody).toEqual({
      location: 'unknown',
      confirmed: false,
    })
  })
})
