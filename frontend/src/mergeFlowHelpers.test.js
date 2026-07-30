// frontend/src/mergeFlowHelpers.test.js — applyBaseLegOutcome: honest status lines + the
// dashboard owner-record backup write (dashboardPositions.js/skills.jsx/HistoryPanel.jsx/app.jsx
// all gate on the owner-scoped v2 record now — the legacy vf_base_owner*  keys are dual-write
// only, see applyBaseLegOutcome's own doc comment).
import { describe, it, expect, vi } from 'vitest'
import {
  applyBaseLegOutcome,
  mapBaseLegEvent,
  pollBaseLegUntilSettled,
  setupBaseMandate,
  readStoredBaseMandate,
  checkStoredBaseMandate,
  needsBaseMandateSetup,
  resolveBaseAvailability,
  baseMandateProbeAllocation,
  baseMandateRequiresReview,
} from './mergeFlowHelpers.js'
import { toBaseMandateView } from './strategy/baseMandateView.js'
import { readBaseMandate, readBaseOwner } from './wallet/baseBinding.js'

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    dump: () => Object.fromEntries(m),
  }
}

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

const activeEvidence = (overrides = {}) => ({
  version: 2,
  status: 'active',
  reasonCodes: [],
  expected: { chainId: 84532 },
  observed: {
    blockNumber: '101',
    blockHash: '0xblock',
    blockTime: Date.now(),
    implementation: '0ximpl',
    permission: { digest: 'permission-digest' },
    preparedCallDigest: 'prepared-call-digest',
  },
  checks: { chain: true, permission: true, prepared: true },
  ...overrides,
})

describe('setupBaseMandate — the 1-tap setup ceremony (never run automatically by a run)', () => {
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
    const getMandateStatus = vi.fn().mockResolvedValue(activeEvidence())
    // Before setup: nothing stored, gate stays closed.
    expect(
      await checkStoredBaseMandate({ getMandateStatus, storage, stellarOwner: 'GUSER' })()
    ).toBe(false)
    await setupBaseMandate({ connectedAddress: 'GUSER', deps: { ...deps, storage } })
    // After setup: the relayer confirms the just-written mandate, gate opens.
    expect(
      await checkStoredBaseMandate({ getMandateStatus, storage, stellarOwner: 'GUSER' })()
    ).toBe(true)
    expect(getMandateStatus).toHaveBeenCalledWith('APPROVAL', {
      stellarOwner: 'GUSER',
      kernelAddress: '0x0000000000000000000000000000000000000AA1',
      allocation: baseMandateProbeAllocation(),
    })
  })

  it('writes an owner-scoped BaseMandateRecordV2 beside the legacy vf_base_mandate key', async () => {
    const deps = okDeps()
    const storage = fakeStorage()
    await setupBaseMandate({ connectedAddress: 'GUSER', deps: { ...deps, storage } })
    const v2 = readBaseMandate('GUSER', storage)
    expect(v2).toMatchObject({
      version: 2,
      stellarOwner: 'GUSER',
      kernelAddress: '0x0000000000000000000000000000000000000AA1',
      serializedApproval: 'APPROVAL',
      sessionKeyAddress: '0xSESSION',
      expiresAt: 9999999999,
      status: 'active',
    })
    // A different owner never sees this record.
    expect(readBaseMandate('SOMEONE_ELSE', storage)).toBeNull()
  })
})

describe('checkStoredBaseMandate — owner-scoped gating (VF Wallet Task 6)', () => {
  // Strategy Task 13 (decision log #22, obligation D): the unscoped `{getMandateStatus, storage}`
  // legacy path this test locked is DELETED — checkStoredBaseMandate now requires `stellarOwner`.
  // Deleted in the same commit as the migration, never before it.

  it('a mandate set up for owner A is not visible to owner B (no silent adoption on wallet switch)', async () => {
    const deps = okDeps()
    const storage = fakeStorage()
    const getMandateStatus = vi.fn().mockResolvedValue(activeEvidence())
    await setupBaseMandate({ connectedAddress: 'GOWNERA', deps: { ...deps, storage } })
    expect(
      await checkStoredBaseMandate({ getMandateStatus, storage, stellarOwner: 'GOWNERB' })()
    ).toBe(false)
    expect(getMandateStatus).not.toHaveBeenCalled()
  })
})

// Strategy Task 13 (decision log #22, obligation D): the whole
// 'resolveBaseAvailability — legacy overload stays live (VF Wallet Task 6 hard gate)' describe
// block (the `{checkHealth, checkMandate, checkFunding}` shape and its dispatch branch) is
// DELETED — app.jsx's Base preflight now calls the canonical `{mandate, connection, health}`
// contract directly (see the describe block below, and app.jsx's `resolveBaseForPlan`). Deleted
// in the same commit as the migration, never before it.

describe('resolveBaseAvailability — canonical bound-mandate contract (Strategy Task 9)', () => {
  const now = Math.floor(Date.now() / 1000)
  const connection = {
    connected: true,
    stellarOwner: 'GUSER',
    kernelAddress: '0x0000000000000000000000000000000000000AA1',
    relayerOrigin: 'https://relayer.example',
  }
  const mandate = {
    version: 2,
    stellarOwner: 'GUSER',
    kernelAddress: '0x0000000000000000000000000000000000000aa1',
    sessionKeyAddress: '0x0000000000000000000000000000000000000BB2',
    relayerOrigin: 'https://relayer.example',
    expiresAt: now + 3600,
    status: 'active',
    bindingId: 'binding-1',
    bindingHash: '0xhash',
    reasonCodes: [],
    expected: { chainId: 84532 },
    observed: {
      blockNumber: '101',
      blockHash: '0xblock',
      blockTime: Date.now(),
      implementation: '0ximpl',
      permission: { digest: 'permission-digest' },
      preparedCallDigest: 'prepared-call-digest',
    },
    checks: { chain: true, permission: true, prepared: true },
  }

  it('offers Base only when the connected, active record and relayer health are all valid', async () => {
    const result = resolveBaseAvailability({ mandate, connection, health: true })

    expect(result.mandateView).toEqual(toBaseMandateView({ mandate, ...connection }))
    expect(await result.baseAvailable).toBe(true)
    expect(result.action).toBeNull()
  })

  it('requires an explicit connected state before a matching mandate can be ready', async () => {
    const { connected, ...connectionWithoutState } = connection
    const result = resolveBaseAvailability({
      mandate,
      connection: connectionWithoutState,
      health: true,
    })

    expect(await result.baseAvailable).toBe(false)
    expect(result.mandateView.status).toBe('unavailable')
    expect(result.mandateView.ready).toBe(false)
    expect(result.action).toEqual({
      label: 'Connect to check Base testnet',
      invalidatesPlan: false,
    })
  })

  it('keeps a disconnected first plan Stellar-only and offers connection instead of Base', async () => {
    const result = resolveBaseAvailability({
      mandate,
      connection: {
        stellarOwner: null,
        kernelAddress: null,
        relayerOrigin: null,
        connected: false,
      },
      health: true,
    })

    expect(await result.baseAvailable).toBe(false)
    expect(result.mandateView.status).toBe('unavailable')
    expect(result.action).toEqual({
      label: 'Connect to check Base testnet',
      invalidatesPlan: false,
    })
  })

  it('returns Rebuild plan after setup instead of inserting Base into a reviewed plan', async () => {
    const result = resolveBaseAvailability({
      mandate,
      connection: { ...connection, setupSucceeded: true },
      health: true,
    })

    expect(await result.baseAvailable).toBe(true)
    expect(result.action).toEqual({ label: 'Rebuild plan', invalidatesPlan: true })
  })

  it('fails closed for a relayer outage, malformed active record, or missing expected relayer origin', async () => {
    for (const input of [
      { mandate, connection, health: false },
      { mandate: { ...mandate, sessionKeyAddress: null }, connection, health: true },
      { mandate, connection: { ...connection, relayerOrigin: null }, health: true },
    ]) {
      expect(await resolveBaseAvailability(input).baseAvailable).toBe(false)
    }
  })
})

describe('Base mandate evidence review helpers', () => {
  it('builds a canonical read-only catalog probe', () => {
    expect(baseMandateProbeAllocation({ runId: 'run-9' })).toMatchObject({
      allocationId: expect.stringMatching(/^run-9:bridge:/),
      amount: { token: 'USDC', units: '1', decimals: 6 },
      minShares: '0',
    })
  })

  it('requires review for a material evidence change or any non-verified status', () => {
    const previous = activeEvidence()
    expect(baseMandateRequiresReview(previous, activeEvidence())).toBe(false)
    expect(baseMandateRequiresReview(null, activeEvidence())).toBe(true)
    expect(baseMandateRequiresReview(previous, activeEvidence({ status: 'revoked' }))).toBe(true)
    expect(
      baseMandateRequiresReview(
        previous,
        activeEvidence({
          observed: { ...previous.observed, permission: { digest: 'changed' } },
        })
      )
    ).toBe(true)
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

  // VF Wallet Task 6 re-review fix: dashboardPositions.js/skills.jsx/HistoryPanel.jsx/app.jsx's
  // withdraw guard all gate on the v2 owner record now, not the legacy keys — this backup must
  // restore THAT, or a wiped/corrupt v2 record at settle time reproduces the 2026-07-19 incident
  // one layer down (deposited position invisible on the dashboard).
  it('given stellarOwner, restores the v2 owner record when it was missing at settle time', () => {
    const storage = fakeStorage()
    applyBaseLegOutcome(
      { success: true, jobId: 'j1', finalStatus: 'done', baseAccount: '0x66fe' },
      { storage, stellarOwner: 'GUSER' }
    )
    expect(readBaseOwner('GUSER', storage)).toMatchObject({
      version: 2,
      stellarOwner: 'GUSER',
      kernelAddress: '0x66fe',
    })
  })

  it('given stellarOwner, restores the v2 owner record when it was corrupt at settle time', () => {
    const storage = fakeStorage({ 'vf_base_owner_v2:GUSER': '{not valid json' })
    applyBaseLegOutcome(
      { success: true, jobId: 'j1', finalStatus: 'done', baseAccount: '0x66fe' },
      { storage, stellarOwner: 'GUSER' }
    )
    expect(readBaseOwner('GUSER', storage).kernelAddress).toBe('0x66fe')
  })

  it('given stellarOwner, an existing v2 record keeps its passkeyName/createdAt (kernelAddress + updatedAt refresh)', () => {
    const storage = fakeStorage()
    applyBaseLegOutcome(
      { success: true, jobId: 'j0', finalStatus: 'done', baseAccount: '0xOLD' },
      { storage, stellarOwner: 'GUSER' }
    )
    const first = readBaseOwner('GUSER', storage)
    applyBaseLegOutcome(
      { success: true, jobId: 'j1', finalStatus: 'done', baseAccount: '0x66fe' },
      { storage, stellarOwner: 'GUSER' }
    )
    const second = readBaseOwner('GUSER', storage)
    expect(second.kernelAddress).toBe('0x66fe')
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('without stellarOwner, writes only the legacy keys (no crash, no v2 write) — pre-migration callers still work', () => {
    const storage = fakeStorage()
    applyBaseLegOutcome(
      { success: true, jobId: 'j1', finalStatus: 'done', baseAccount: '0x66fe' },
      { storage }
    )
    expect(storage.dump()['vf_base_owner_address']).toBe('0x66fe')
    expect(Object.keys(storage.dump()).some((k) => k.startsWith('vf_base_owner_v2:'))).toBe(false)
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
