// frontend/src/mergeFlowHelpers.test.js — preserves the money/custody projection tests while the
// mandate setup boundary migrates to owner-scoped, non-secret v3 records.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./base/deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } = await import('./base/hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

import {
  applyBaseLegOutcome,
  mapBaseLegEvent,
  pollBaseLegUntilSettled,
  setupBaseMandate,
  checkStoredBaseMandate,
  needsBaseMandateSetup,
  resolveBaseAvailability,
  baseMandateRequiresReview,
} from './mergeFlowHelpers.js'
import { toBaseMandateView } from './strategy/baseMandateView.js'
import { readBaseMandate, readBaseOwner, validateBaseMandate } from './wallet/baseBinding.js'

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial))
  const operations = []
  return {
    getItem: (k) => {
      operations.push(['get', k])
      return m.has(k) ? m.get(k) : null
    },
    setItem: (k, v) => {
      operations.push(['set', k])
      m.set(k, String(v))
    },
    removeItem: (k) => {
      operations.push(['remove', k])
      m.delete(k)
    },
    dump: () => Object.fromEntries(m),
    operations,
  }
}

const MANDATE_ID = 'ab'.repeat(16)
const CAPABILITY = 'cd'.repeat(32)
const OWNER = 'GUSER'
const KERNEL = '0x0000000000000000000000000000000000000aa1'
const SESSION = '0x0000000000000000000000000000000000000bb2'
const NOW = 2_000_000_000

function deterministicCrypto() {
  let call = 0
  return {
    getRandomValues(target) {
      call += 1
      target.fill(call === 1 ? 0xab : 0xcd)
      return target
    },
  }
}

const okDeps = () => ({
  ensureBaseOwner: vi.fn().mockResolvedValue({
    address: KERNEL,
    kernelAccount: {},
    publicClient: {},
    passkeyValidator: {},
    ownerMode: 'ceremony',
  }),
  createMandate: vi.fn().mockResolvedValue({
    serializedApproval: 'APPROVAL-SENTINEL',
    sessionKeyAddress: SESSION,
    sessionPrivateKey: 'PRIVATE-KEY-SENTINEL',
    expiry: NOW + 7_200,
  }),
  postMandate: vi.fn().mockResolvedValue({
    ok: true,
    status: 'pending_activation',
    mandateId: MANDATE_ID,
    bindingId: 'binding-1',
    bindingHash: 'binding-hash-1',
    relayerOrigin: 'https://relayer.example',
  }),
  waitForMandateActivation: vi.fn().mockResolvedValue(null),
  cryptoImpl: deterministicCrypto(),
})

const activeEvidence = (overrides = {}) => ({
  version: 3,
  mandateId: MANDATE_ID,
  stellarOwner: OWNER,
  kernelAddress: KERNEL,
  sessionKeyAddress: SESSION,
  relayerOrigin: 'https://relayer.example',
  validUntilSeconds: NOW + 7_200,
  status: 'active',
  bindingId: 'binding-1',
  bindingHash: 'binding-hash-1',
  reasonCodes: [],
  expected: { chainId: 84532, owner: OWNER, kernelAddress: KERNEL },
  observed: {
    blockNumber: '101',
    blockHash: `0x${'ab'.repeat(32)}`,
    blockTime: NOW,
    implementation: '0x0000000000000000000000000000000000000cc3',
    permission: { digest: 'permission-digest' },
    activation: {
      userOpHash: `0x${'33'.repeat(32)}`,
      txHash: `0x${'44'.repeat(32)}`,
      activatedAt: NOW - 10,
    },
  },
  checks: {
    chain: true,
    owner: true,
    kernel: true,
    session: true,
    permission: true,
    policy: true,
    binding: true,
    origin: true,
    implementation: true,
    freshness: true,
    reconstruction: true,
    activation: true,
  },
  ...overrides,
})

describe('setupBaseMandate v3 lifecycle', () => {
  it('generates canonical authority, writes pending before polling, then stores only verified public evidence', async () => {
    const deps = okDeps()
    const storage = fakeStorage()
    const trace = []
    deps.postMandate.mockImplementation(async (body) => {
      trace.push(['register', body.mandateId])
      return {
        ok: true,
        status: 'pending_activation',
        mandateId: MANDATE_ID,
        bindingId: 'binding-1',
        bindingHash: 'binding-hash-1',
        relayerOrigin: 'https://relayer.example',
      }
    })
    let pendingSnapshot
    deps.waitForMandateActivation.mockImplementation(async (identity) => {
      const pending = JSON.parse(storage.dump()[`vf_base_mandate_v3:${OWNER}`])
      pendingSnapshot = pending
      trace.push(['poll', pending.status, identity.mandateId])
      return activeEvidence()
    })
    const out = await setupBaseMandate({
      connectedAddress: OWNER,
      deps: { ...deps, storage },
    })
    expect(trace).toEqual([
      ['register', MANDATE_ID],
      ['poll', 'pending_activation', MANDATE_ID],
    ])
    expect(deps.postMandate).toHaveBeenCalledWith({
      mandateId: MANDATE_ID,
      capability: CAPABILITY,
      serializedApproval: 'APPROVAL-SENTINEL',
      sessionPrivateKey: 'PRIVATE-KEY-SENTINEL',
      sessionKeyAddress: SESSION,
      expiresAt: NOW + 7_200,
      stellarOwner: OWNER,
      kernelAddress: KERNEL,
    })
    expect(deps.waitForMandateActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        mandateId: MANDATE_ID,
        stellarOwner: OWNER,
        kernelAddress: KERNEL,
      })
    )
    expect(JSON.stringify(deps.waitForMandateActivation.mock.calls)).not.toMatch(
      /APPROVAL-SENTINEL|PRIVATE-KEY-SENTINEL|cdcdcdcd/
    )
    expect(pendingSnapshot).toMatchObject({
      version: 3,
      mandateId: MANDATE_ID,
      stellarOwner: OWNER,
      kernelAddress: KERNEL,
      sessionKeyAddress: SESSION,
      status: 'pending_activation',
    })
    expect(Object.keys(pendingSnapshot).sort()).toEqual(
      [
        'version',
        'mandateId',
        'stellarOwner',
        'kernelAddress',
        'sessionKeyAddress',
        'relayerOrigin',
        'validUntilSeconds',
        'status',
        'bindingId',
        'bindingHash',
        'reasonCodes',
        'expected',
        'observed',
        'checks',
      ].sort()
    )
    expect(JSON.stringify(pendingSnapshot)).not.toMatch(
      /APPROVAL-SENTINEL|PRIVATE-KEY-SENTINEL|cdcdcdcd|Bearer|Cookie|serializedApproval|sessionPrivateKey|capability/i
    )
    expect(readBaseMandate(OWNER, storage)).toEqual(activeEvidence())
    expect(out).toMatchObject({
      mandateId: MANDATE_ID,
      stellarOwner: OWNER,
      kernelAddress: KERNEL,
      sessionKeyAddress: SESSION,
      status: 'active',
    })
    expect(Object.keys(out).sort()).toEqual(
      [
        'version',
        'mandateId',
        'stellarOwner',
        'kernelAddress',
        'sessionKeyAddress',
        'relayerOrigin',
        'validUntilSeconds',
        'status',
        'bindingId',
        'bindingHash',
        'reasonCodes',
        'expected',
        'observed',
        'checks',
      ].sort()
    )
    const serialized = JSON.stringify({ out, storage: storage.dump() })
    expect(serialized).not.toMatch(
      /APPROVAL-SENTINEL|PRIVATE-KEY-SENTINEL|cdcdcdcd|Bearer|Cookie|serializedApproval|sessionPrivateKey|capability/i
    )
  })

  it('createMandate is asked for a future expiry and at least one pool', async () => {
    const deps = okDeps()
    deps.waitForMandateActivation.mockResolvedValue(activeEvidence())
    const before = Math.floor(Date.now() / 1000)
    await setupBaseMandate({ connectedAddress: 'GUSER', deps: { ...deps, storage: fakeStorage() } })
    const createArgs = deps.createMandate.mock.calls[0][0]
    expect(createArgs.expiry).toBeGreaterThan(before)
    expect(Array.isArray(createArgs.pools)).toBe(true)
    expect(createArgs.pools.length).toBeGreaterThan(0)
    expect(createArgs.pools[0].cap).toBeGreaterThan(0n)
  })

  it('registration rejection creates no active record', async () => {
    const deps = okDeps()
    deps.postMandate.mockRejectedValue(new Error('registration rejected'))
    const storage = fakeStorage()
    await expect(
      setupBaseMandate({ connectedAddress: OWNER, deps: { ...deps, storage } })
    ).rejects.toThrow(/Base mandate/i)
    expect(readBaseMandate(OWNER, storage)).toBeNull()
  })

  it('checkStoredBaseMandate uses one amount-free owner-scoped status read', async () => {
    const deps = okDeps()
    const storage = fakeStorage()
    deps.waitForMandateActivation.mockResolvedValue(activeEvidence())
    const getMandateStatus = vi.fn().mockResolvedValue(activeEvidence())
    await setupBaseMandate({ connectedAddress: OWNER, deps: { ...deps, storage } })
    expect(await checkStoredBaseMandate({ getMandateStatus, storage, stellarOwner: OWNER })()).toBe(
      true
    )
    expect(getMandateStatus).toHaveBeenCalledTimes(1)
    expect(getMandateStatus).toHaveBeenCalledWith(MANDATE_ID, {
      stellarOwner: OWNER,
      kernelAddress: KERNEL,
    })
  })

  it.each(['activation_uncertain', 'revoked', 'timeout'])(
    'leaves at most a non-secret unavailable pending record when polling stops as %s',
    async (reason) => {
      const deps = okDeps()
      const storage = fakeStorage()
      deps.waitForMandateActivation.mockRejectedValue(
        new Error(`poison ${reason} APPROVAL-SENTINEL PRIVATE-KEY-SENTINEL ${CAPABILITY}`)
      )

      let error
      try {
        await setupBaseMandate({ connectedAddress: OWNER, deps: { ...deps, storage } })
      } catch (caught) {
        error = caught
      }
      const pending = readBaseMandate(OWNER, storage)
      expect(error).toBeInstanceOf(Error)
      expect(String(error.message)).toMatch(/Base mandate/i)
      expect(JSON.stringify({ error: error.message, storage: storage.dump() })).not.toMatch(
        /APPROVAL-SENTINEL|PRIVATE-KEY-SENTINEL|cdcdcdcd|Bearer|Cookie/i
      )
      if (pending !== null) {
        expect(validateBaseMandate(pending, { stellarOwner: OWNER, now: NOW })).toBe('unavailable')
      }
    }
  )

  it('deletes legacy global, v2, and poisoned v3 approval records instead of adopting them', async () => {
    const deps = okDeps()
    deps.waitForMandateActivation.mockResolvedValue(activeEvidence())
    const storage = fakeStorage({
      vf_base_mandate: JSON.stringify({ serializedApproval: 'GLOBAL' }),
      [`vf_base_mandate_v2:${OWNER}`]: JSON.stringify({ version: 2, serializedApproval: 'V2' }),
      [`vf_base_mandate_v3:${OWNER}`]: JSON.stringify({
        ...activeEvidence(),
        serializedApproval: 'POISONED-V3',
      }),
    })

    await setupBaseMandate({ connectedAddress: OWNER, deps: { ...deps, storage } })
    const rawAfterSetup = storage.dump()
    expect(rawAfterSetup).not.toHaveProperty('vf_base_mandate')
    expect(rawAfterSetup).not.toHaveProperty(`vf_base_mandate_v2:${OWNER}`)
    expect(JSON.stringify(rawAfterSetup)).not.toMatch(
      /GLOBAL|\bV2\b|POISONED-V3|serializedApproval/
    )
    expect(readBaseMandate(OWNER, storage)).toEqual(activeEvidence())
    expect(JSON.stringify(storage.dump())).not.toMatch(
      /GLOBAL|\bV2\b|POISONED-V3|serializedApproval/
    )
  })
})

describe('checkStoredBaseMandate — owner-scoped gating (VF Wallet Task 6)', () => {
  // Strategy Task 13 (decision log #22, obligation D): the unscoped `{getMandateStatus, storage}`
  // legacy path this test locked is DELETED — checkStoredBaseMandate now requires `stellarOwner`.
  // Deleted in the same commit as the migration, never before it.

  it('a mandate set up for owner A is not visible to owner B (no silent adoption on wallet switch)', async () => {
    const ownerA = 'GOWNERA'
    const storage = fakeStorage({
      [`vf_base_mandate_v3:${ownerA}`]: JSON.stringify(
        activeEvidence({
          stellarOwner: ownerA,
          expected: { ...activeEvidence().expected, owner: ownerA },
        })
      ),
    })
    const getMandateStatus = vi.fn().mockResolvedValue(activeEvidence())
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
  const mandate = activeEvidence({ validUntilSeconds: now + 3600 })

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
