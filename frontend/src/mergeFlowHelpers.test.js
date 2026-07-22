// frontend/src/mergeFlowHelpers.test.js — applyBaseLegOutcome: honest status lines + the
// dashboard-marker backup write (loadBasePositions gates on these exact localStorage keys).
import { describe, it, expect, vi } from 'vitest'
import {
  applyBaseLegOutcome,
  mapBaseLegEvent,
  pollBaseLegUntilSettled,
  setupBaseMandate,
  readStoredBaseMandate,
  checkStoredBaseMandate,
  needsBaseMandateSetup,
} from './mergeFlowHelpers.js'

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    dump: () => Object.fromEntries(m),
  }
}

describe('setupBaseMandate — the 1-tap setup ceremony (never run automatically by a run)', () => {
  const okDeps = () => ({
    ensureBaseOwner: vi.fn().mockResolvedValue({
      address: '0x0000000000000000000000000000000000000AA1',
      kernelAccount: {},
      publicClient: {},
      passkeyValidator: {},
      ownerMode: 'ceremony',
    }),
    createMandate: vi.fn().mockResolvedValue({
      serializedApproval: 'APPROVAL',
      sessionKeyAddress: '0xSESSION',
      sessionPrivateKey: '0xPRIV',
      expiry: 9999999999,
    }),
    postMandate: vi.fn().mockResolvedValue({ ok: true }),
  })

  it('happy path: owner -> mandate -> register -> writes vf_base_mandate, never the private key', async () => {
    const deps = okDeps()
    const storage = fakeStorage()
    const out = await setupBaseMandate({
      connectedAddress: 'GUSER',
      deps: { ...deps, storage },
    })
    expect(out).toEqual({
      kernelAddress: '0x0000000000000000000000000000000000000AA1',
      expiry: 9999999999,
    })
    expect(deps.ensureBaseOwner).toHaveBeenCalledWith({ connectedAddress: 'GUSER' })
    expect(deps.postMandate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPrivateKey: '0xPRIV' })
    )
    const stored = readStoredBaseMandate(storage)
    expect(stored).toEqual({
      serializedApproval: 'APPROVAL',
      sessionKeyAddress: '0xSESSION',
      kernelAddress: '0x0000000000000000000000000000000000000AA1',
      expiry: 9999999999,
    })
    expect(storage.getItem('vf_base_mandate')).not.toContain('0xPRIV')
  })

  it('createMandate is asked for a future expiry and at least one pool', async () => {
    const deps = okDeps()
    const before = Math.floor(Date.now() / 1000)
    await setupBaseMandate({ connectedAddress: 'GUSER', deps: { ...deps, storage: fakeStorage() } })
    const createArgs = deps.createMandate.mock.calls[0][0]
    expect(createArgs.expiry).toBeGreaterThan(before)
    expect(Array.isArray(createArgs.pools)).toBe(true)
    expect(createArgs.pools.length).toBeGreaterThan(0)
    expect(createArgs.pools[0].cap).toBeGreaterThan(0n)
  })

  it('a ceremony failure (e.g. cancelled) rejects — this is a direct call, not a settled leg', async () => {
    const deps = okDeps()
    deps.ensureBaseOwner.mockRejectedValue(new Error('user cancelled'))
    await expect(
      setupBaseMandate({ connectedAddress: 'GUSER', deps: { ...deps, storage: fakeStorage() } })
    ).rejects.toThrow('user cancelled')
  })

  it('gate recheck: checkStoredBaseMandate flips to true once the fresh mandate is written (the affordance clears itself)', async () => {
    const deps = okDeps()
    const storage = fakeStorage()
    const getMandateStatus = vi.fn().mockResolvedValue({ valid: true })
    // Before setup: nothing stored, gate stays closed.
    expect(await checkStoredBaseMandate({ getMandateStatus, storage })()).toBe(false)
    await setupBaseMandate({ connectedAddress: 'GUSER', deps: { ...deps, storage } })
    // After setup: the relayer confirms the just-written mandate, gate opens.
    expect(await checkStoredBaseMandate({ getMandateStatus, storage })()).toBe(true)
    expect(getMandateStatus).toHaveBeenCalledWith('APPROVAL')
  })
})

describe('needsBaseMandateSetup', () => {
  it('shows the affordance only when the relayer is healthy AND the mandate is what is missing', () => {
    expect(needsBaseMandateSetup({ healthy: true, mandateOk: false })).toBe(true)
    expect(needsBaseMandateSetup({ healthy: false, mandateOk: false })).toBe(false) // relayer down: not fixable by this tap
    expect(needsBaseMandateSetup({ healthy: true, mandateOk: true })).toBe(false) // already fine
    expect(needsBaseMandateSetup({ healthy: false, mandateOk: true })).toBe(false)
  })
})

describe('applyBaseLegOutcome', () => {
  it('returns null for a run without a Base leg', () => {
    expect(applyBaseLegOutcome(null, { storage: fakeStorage() })).toBeNull()
  })

  it('maps a failed leg to AgentFailed with stage + error, writes nothing', () => {
    const storage = fakeStorage()
    const out = applyBaseLegOutcome(
      { success: false, stage: 'owner', error: 'NotAllowedError' },
      { storage }
    )
    expect(out.event).toBe('AgentFailed')
    expect(out.meta).toContain('owner')
    expect(out.meta).toContain('NotAllowedError')
    expect(storage.dump()).toEqual({})
  })

  it('finalStatus done -> deposited message + persists the dashboard owner markers', () => {
    const storage = fakeStorage()
    const out = applyBaseLegOutcome(
      { success: true, jobId: 'j1', finalStatus: 'done', baseAccount: '0x66fe' },
      { storage }
    )
    expect(out.event).toBe('OrchestratorPlanned')
    expect(out.meta).toContain('deposited on Base')
    expect(storage.dump()['vf_base_owner_address']).toBe('0x66fe')
    expect(JSON.parse(storage.dump()['vf_base_owner']).mode).toBe('ceremony')
  })

  it('does not clobber an existing vf_base_owner record (keeps passkeyName)', () => {
    const existing = JSON.stringify({
      mode: 'ceremony',
      passkeyName: 'vibing-farmer-base-GDRT7VBM',
    })
    const storage = fakeStorage({ vf_base_owner: existing })
    applyBaseLegOutcome(
      { success: true, jobId: 'j1', finalStatus: 'done', baseAccount: '0x66fe' },
      { storage }
    )
    expect(storage.dump()['vf_base_owner']).toBe(existing)
  })

  it('finalStatus error -> failure line that says funds are recoverable, never lost', () => {
    const out = applyBaseLegOutcome(
      { success: true, jobId: 'j2', finalStatus: 'error', baseAccount: '0x66fe' },
      { storage: fakeStorage() }
    )
    expect(out.event).toBe('AgentFailed')
    expect(out.meta).toContain('recoverable')
  })

  it('still-pending polling -> "submitted / settling", NOT "deposited"', () => {
    const out = applyBaseLegOutcome(
      { success: true, jobId: 'j3', finalStatus: 'pending', baseAccount: '0x66fe' },
      { storage: fakeStorage() }
    )
    expect(out.event).toBe('OrchestratorPlanned')
    expect(out.meta).toContain('settling')
    expect(out.meta).not.toContain('deposited on Base')
  })
})

describe('mapBaseLegEvent', () => {
  it('walks the full happy path: owner -> mandate(approve) -> burn(swap) -> relay -> completed(deposit)', () => {
    expect(mapBaseLegEvent('baseleg-owner', { status: 'pending' }).status).toBe('running')
    const owner = mapBaseLegEvent('baseleg-owner', {
      status: 'done',
      address: '0x66fe3bb4ade38dd55504813cb0c8d77f3c7974e9',
    })
    expect(owner.memory.meta).toContain('0x66fe')

    const mandate = mapBaseLegEvent('baseleg-mandate', {
      sessionKeyAddress: '0xabcdefabcdefabcdefabcdef',
    })
    expect(mandate.step).toBe('approve')
    expect(mandate.stepStatus).toBe('confirmed')

    expect(mapBaseLegEvent('farm-burn-started', {}).stepStatus).toBe('running')
    const burn = mapBaseLegEvent('farm-burn-confirmed', {
      burnHash: 'b39a45bd12a225e70795deadbeef',
    })
    expect(burn.step).toBe('swap')
    expect(burn.hash).toBe('b39a45bd12a225e70795deadbeef')
    expect(burn.log).toBe('SwapExecuted')

    expect(mapBaseLegEvent('farm-relay-dispatched', { jobId: 'j1' }).memory.meta).toContain('j1')

    const done = mapBaseLegEvent('farm-completed', { jobId: 'j1', finalStatus: 'done' })
    expect(done.status).toBe('completed')
    expect(done.step).toBe('deposit')
    expect(done.log).toBe('DepositExecuted')
  })

  it('completed-with-error and failure events mark the node failed, never lost-funds wording', () => {
    const err = mapBaseLegEvent('farm-completed', { jobId: 'j2', finalStatus: 'error' })
    expect(err.status).toBe('failed')
    expect(err.memory.meta).toContain('recoverable')

    const failed = mapBaseLegEvent('farm-failed', { stage: 'burn', error: 'trustline missing' })
    expect(failed.status).toBe('failed')
    expect(failed.memory.meta).toContain('trustline missing')
    expect(mapBaseLegEvent('baseleg-failed', { stage: 'owner', error: 'x' }).log).toBe(
      'AgentFailed'
    )
  })

  it('pending farm-completed keeps the node running (memory only), unknown events return null', () => {
    const pending = mapBaseLegEvent('farm-completed', { jobId: 'j3', finalStatus: 'pending' })
    expect(pending.status).toBeUndefined()
    expect(pending.memory.title).toContain('settling')
    expect(mapBaseLegEvent('orchestrator-step', {})).toBeNull()
  })
})

describe('pollBaseLegUntilSettled', () => {
  const noSleep = async () => {}

  it('keeps polling past the dispatch window and returns the terminal status', async () => {
    const seq = [{ status: 'pending' }, { status: 'pending' }, { status: 'done' }]
    const pollOnce = vi.fn(async () => seq.shift())
    const out = await pollBaseLegUntilSettled({ jobId: 'j1', pollOnce, sleep: noSleep })
    expect(out).toBe('done')
    expect(pollOnce).toHaveBeenCalledTimes(3)
  })

  it('survives transient poll failures and still settles', async () => {
    const pollOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ status: 'error' })
    expect(await pollBaseLegUntilSettled({ jobId: 'j2', pollOnce, sleep: noSleep })).toBe('error')
  })

  it('gives up quietly (null) when the budget runs out, and no-ops without a jobId', async () => {
    const pollOnce = vi.fn(async () => ({ status: 'pending' }))
    expect(
      await pollBaseLegUntilSettled({ jobId: 'j3', pollOnce, sleep: noSleep, maxTries: 3 })
    ).toBeNull()
    expect(pollOnce).toHaveBeenCalledTimes(3)
    expect(await pollBaseLegUntilSettled({ pollOnce, sleep: noSleep })).toBeNull()
  })
})
