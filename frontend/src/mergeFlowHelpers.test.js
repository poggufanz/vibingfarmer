// frontend/src/mergeFlowHelpers.test.js — applyBaseLegOutcome: honest status lines + the
// dashboard-marker backup write (loadBasePositions gates on these exact localStorage keys).
import { describe, it, expect, vi } from 'vitest'
import {
  applyBaseLegOutcome,
  mapBaseLegEvent,
  pollBaseLegUntilSettled,
} from './mergeFlowHelpers.js'

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    dump: () => Object.fromEntries(m),
  }
}

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
    const existing = JSON.stringify({ mode: 'ceremony', passkeyName: 'vibing-farmer-base-GDRT7VBM' })
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
    const owner = mapBaseLegEvent('baseleg-owner', { status: 'done', address: '0x66fe3bb4ade38dd55504813cb0c8d77f3c7974e9' })
    expect(owner.memory.meta).toContain('0x66fe')

    const mandate = mapBaseLegEvent('baseleg-mandate', { sessionKeyAddress: '0xabcdefabcdefabcdefabcdef' })
    expect(mandate.step).toBe('approve')
    expect(mandate.stepStatus).toBe('confirmed')

    expect(mapBaseLegEvent('farm-burn-started', {}).stepStatus).toBe('running')
    const burn = mapBaseLegEvent('farm-burn-confirmed', { burnHash: 'b39a45bd12a225e70795deadbeef' })
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
    expect(mapBaseLegEvent('baseleg-failed', { stage: 'owner', error: 'x' }).log).toBe('AgentFailed')
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
