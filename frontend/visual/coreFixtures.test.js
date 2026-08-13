import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/base/deploymentFacts.js', async () => {
  const { HARDENED_BASE_DEPLOYMENT_FIXTURE } =
    await import('../src/base/hardenedDeployment.fixture.js')
  return { RECORDED_BASE_DEPLOYMENT: HARDENED_BASE_DEPLOYMENT_FIXTURE }
})

import { reserveUnwind, postUnwindAttach, pollUnwindStatus } from '../src/base/relayerClient.js'
import { buildUnwindCalls } from '../src/base/withdrawBatch.js'
import { maxAtRisk } from '../src/strategy/permissionScope.js'

import {
  CORE_CAPTURE_PROJECTS,
  CORE_FIXTURE_ADDRESSES,
  CORE_FIXTURE_CLASSES,
  CORE_FIXTURE_CLOCK,
  CORE_FIXTURE_HASHES,
  CORE_FIXTURE_REGISTRY,
  CORE_FIXTURE_RUN,
  CORE_FIXTURE_STATES,
  CORE_FIXTURE_THEMES,
  buildCoreBaseWithdrawFixture,
  buildCoreCrewFixture,
  buildCoreDialogFixture,
  buildCoreMoneyFixture,
  buildCoreSettingsFixture,
  buildCoreStrategyFixture,
  createCoreFixtureContext,
  createCoreFixtureReaders,
  forbiddenNetworkCall,
  serializeCoreFixture,
  toCoreManagerMandateView,
  withCoreFixtureEnvironment,
} from './coreFixtures.js'

const expectedClasses = [
  'core-money',
  'core-strategy',
  'core-crew',
  'core-settings',
  'core-dialog',
  'core-base-withdraw',
]

function expectDeepFrozen(value, seen = new WeakSet()) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    seen.has(value)
  )
    return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) continue
    if ('value' in descriptor) expectDeepFrozen(descriptor.value, seen)
    else {
      expectDeepFrozen(descriptor.get, seen)
      expectDeepFrozen(descriptor.set, seen)
    }
  }
}

const FORBIDDEN_GRAPH_KEYS = [
  'address',
  'owner',
  'account',
  'allocationid',
  'runid',
  'custody',
  'signer',
  'secret',
  'private',
  'bearer',
  'capability',
  'sessionkey',
  'authorization',
  'cookie',
]

function normalizedFixtureKey(key) {
  return String(key)
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function expectPublicGraphHasNoForbiddenKeys(value, path = '$', seen = new WeakSet()) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    seen.has(value)
  )
    return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    expect(typeof key).toBe('string')
    const normalized = normalizedFixtureKey(key)
    expect(
      FORBIDDEN_GRAPH_KEYS.some((part) => normalized.includes(part)),
      `${path}.${key}`
    ).toBe(false)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) continue
    if ('value' in descriptor) {
      expectPublicGraphHasNoForbiddenKeys(descriptor.value, `${path}.${key}`, seen)
    } else {
      expectPublicGraphHasNoForbiddenKeys(descriptor.get, `${path}.${key}`, seen)
      expectPublicGraphHasNoForbiddenKeys(descriptor.set, `${path}.${key}`, seen)
    }
  }
}

describe('Core Pocket Crew visual fixture contract', () => {
  it('freezes the exact clock, display constants, hashes, and run identity', () => {
    expect(CORE_FIXTURE_CLOCK).toEqual({
      nowMs: Date.parse('2026-08-11T00:00:00.000Z'),
      nowIso: '2026-08-11T00:00:00.000Z',
      checkedAtMs: Date.parse('2026-08-10T23:59:00.000Z'),
      checkedAtIso: '2026-08-10T23:59:00.000Z',
      confirmedLedger: '12345',
      confirmedBlock: '67890',
    })
    expect(CORE_FIXTURE_ADDRESSES).toEqual({
      stellarOwner: 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS',
      agentA: 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
      agentB: 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J',
      vault: 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77',
      token: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
      baseKernel: '0x0000000000000000000000000000000000000aa1',
      basePool: '0x00000000000000000000000000000000000000b2',
    })
    expect(CORE_FIXTURE_HASHES).toEqual({
      grant: `0x${'11'.repeat(32)}`,
      stellar: `0x${'22'.repeat(32)}`,
      burn: `0x${'33'.repeat(32)}`,
      baseUserOp: `0x${'44'.repeat(32)}`,
    })
    expect(CORE_FIXTURE_RUN).toBe('run-core-fixture-20260811')
    for (const value of [
      CORE_FIXTURE_CLOCK,
      CORE_FIXTURE_ADDRESSES,
      CORE_FIXTURE_HASHES,
      CORE_FIXTURE_CLASSES,
      CORE_FIXTURE_STATES,
      CORE_FIXTURE_THEMES,
      CORE_CAPTURE_PROJECTS,
    ]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
  })

  it('registers exactly six Core classes and expands each to twelve WEB-12 cells', () => {
    expect(CORE_FIXTURE_CLASSES).toEqual(expectedClasses)
    expect(Object.keys(CORE_FIXTURE_REGISTRY)).toEqual(expectedClasses)
    expect(Object.keys(CORE_FIXTURE_REGISTRY)).not.toContain('core-drawer')
    expect(Object.values(CORE_FIXTURE_REGISTRY).every((entry) => Object.isFrozen(entry))).toBe(true)

    const cells = Object.values(CORE_FIXTURE_REGISTRY).flatMap((entry) => entry.captureCells)
    expect(cells).toHaveLength(72)
    expect(new Set(cells.map((cell) => cell.fixture))).toEqual(new Set(expectedClasses))
    expect(new Set(cells.map((cell) => cell.theme))).toEqual(
      new Set(['forest', 'day-field', 'reduced-motion'])
    )
    expect(new Set(cells.map((cell) => cell.project))).toEqual(
      new Set(['mobile-320', 'mobile-360', 'tablet-768', 'desktop-1440'])
    )
    for (const entry of Object.values(CORE_FIXTURE_REGISTRY)) {
      expect(entry.captureCells).toHaveLength(12)
      expect(entry.screenshotBases).toHaveLength(3)
      expect(entry.screenshotBases).toEqual([
        `${entry.id}-forest`,
        `${entry.id}-day-field`,
        `${entry.id}-reduced-motion`,
      ])
    }
  })

  it('publishes the required state inventories without adding a CAP-17 drawer', () => {
    expect(CORE_FIXTURE_STATES['core-money']).toEqual([
      'disconnected',
      'loading',
      'current',
      'stale',
      'empty',
      'partial-discovery',
      'problem',
      'unavailable',
      'disarmed',
      'recovery-opener',
    ])
    expect(CORE_FIXTURE_STATES['core-strategy']).toEqual([
      'plan',
      'protect',
      'start',
      'receipt',
      'yield-unavailable',
      'permission-fresh',
      'permission-reuse-verified',
      'permission-rejected',
      'permission-reuse-unavailable',
      'queued',
      'partial',
      'in-transit',
      'base-custody',
    ])
    expect(CORE_FIXTURE_STATES['core-crew']).toEqual([
      'armed',
      'alarm-only',
      'unknown',
      'cancelled',
      'empty',
      'stable-child-marks',
    ])
    expect(CORE_FIXTURE_STATES['core-settings']).toEqual([
      'default',
      'wallet',
      'mandate-ready',
      'mandate-missing',
      'mandate-expired',
      'mandate-revoked',
      'mandate-disconnected',
      'mandate-unavailable',
      'mandate-busy',
    ])
    expect(CORE_FIXTURE_STATES['core-dialog']).toEqual([
      'plan-edit',
      'plan-reset',
      'withdraw',
      'stop-access',
      'recovery',
      'settings-clear',
      'invalid',
      'submitting',
      'confirmed',
      'failed',
      'unknown',
    ])
    expect(CORE_FIXTURE_STATES['core-base-withdraw']).toEqual([
      'idle',
      'submitting',
      'relaying',
      'polling',
      'confirmed',
      'failed',
      'submission-unknown',
      'in-transit',
    ])
    expect(CORE_FIXTURE_REGISTRY['core-dialog'].cap).toBe('CAP-16')
    expect(CORE_FIXTURE_REGISTRY['core-base-withdraw'].cap).toBe('CAP-18')
  })

  it('rejects forbidden identity, custody, signer, and secret keys recursively', () => {
    const forbiddenKeys = [
      'address',
      'owner',
      'account',
      'allocationId',
      'runId',
      'custody',
      'signer',
      'signerSecret',
      'secret',
      'privateKey',
      'bearerToken',
      'capability',
      'sessionKey',
      'session-key-material',
    ]
    for (const key of forbiddenKeys) {
      expect(() => serializeCoreFixture({ safe: { [key]: 'redacted' } })).toThrow(/forbidden/i)
    }
    expect(() => serializeCoreFixture({ safe: [{ nested: { private: 'redacted' } }] })).toThrow(
      /forbidden/i
    )
    const symbolValue = { safe: 'ok' }
    symbolValue[Symbol('sessionKey')] = 'redacted'
    expect(() => serializeCoreFixture(symbolValue)).toThrow(/symbol|serializ|forbidden/i)
    const arrayValue = []
    arrayValue.sessionKey = 'redacted'
    expect(() => serializeCoreFixture(arrayValue)).toThrow(/forbidden/i)
    const exactEquivalent = { safe: { SESSION_KEY_MATERIAL: 'redacted' } }
    expect(() => serializeCoreFixture(exactEquivalent)).toThrow(/forbidden/i)
    expect(() => serializeCoreFixture({ safe: 1n })).toThrow(/serializ/i)

    const serialized = serializeCoreFixture({
      label: 'Technical details',
      technical: CORE_FIXTURE_ADDRESSES.agentA,
      hash: CORE_FIXTURE_HASHES.stellar,
      amount: { token: 'USDC', units: '9007199254740993', decimals: 7 },
    })
    expect(serialized).toContain(CORE_FIXTURE_ADDRESSES.agentA)
    expect(serialized).toContain(CORE_FIXTURE_HASHES.stellar)
    expect(serialized).not.toMatch(/session.?key|private.?key|capability|bearer|secret/i)
  })

  it('returns deterministic readers and context without ambient data', () => {
    expect(() => forbiddenNetworkCall()).toThrow('Core visual fixtures must not access the network')
    const readers = createCoreFixtureReaders()
    for (const reader of Object.values(readers)) {
      expect(typeof reader).toBe('function')
      if (reader === readers.random) {
        expect(() => reader()).toThrow(/nondeterministic randomness/i)
      } else {
        expect(() => reader()).toThrow(/must not access the network/i)
      }
    }
    const context = createCoreFixtureContext()
    expect(context.clock).toBe(CORE_FIXTURE_CLOCK)
    expect(context.nowMs).toBe(CORE_FIXTURE_CLOCK.nowMs)
    expect(context.readers).toBe(readers)
    expect(Object.isFrozen(context)).toBe(true)
  })

  it('scopes the fixed clock and browser/network guards and restores every global', async () => {
    const originalDateNow = Date.now
    const originalFetch = globalThis.fetch
    const originalXHR = globalThis.XMLHttpRequest
    const originalWebSocket = globalThis.WebSocket
    const originalStorage = globalThis.localStorage
    const originalBeacon = globalThis.navigator?.sendBeacon
    const originalRandom = Math.random
    const beforeFetch = globalThis.fetch
    await withCoreFixtureEnvironment(async ({ nowMs, readers }) => {
      expect(nowMs).toBe(CORE_FIXTURE_CLOCK.nowMs)
      expect(Date.now()).toBe(CORE_FIXTURE_CLOCK.nowMs)
      expect(globalThis.fetch).toBe(readers.fetch)
      expect(() => globalThis.fetch()).toThrow(/must not access the network/i)
      expect(globalThis.XMLHttpRequest).toBe(readers.xhr)
      expect(globalThis.WebSocket).toBe(readers.webSocket)
      expect(globalThis.localStorage).toBe(readers.storage)
      expect(globalThis.navigator.sendBeacon).toBe(readers.sendBeacon)
      expect(Math.random).toBe(readers.random)
      for (const reader of Object.values(readers)) {
        if (reader === readers.random) {
          expect(() => reader()).toThrow(/nondeterministic randomness/i)
        } else {
          expect(() => reader()).toThrow(/must not access the network/i)
        }
      }
    })
    expect(Date.now).toBe(originalDateNow)
    expect(globalThis.fetch).toBe(originalFetch)
    expect(globalThis.XMLHttpRequest).toBe(originalXHR)
    expect(globalThis.WebSocket).toBe(originalWebSocket)
    expect(globalThis.localStorage).toBe(originalStorage)
    expect(globalThis.navigator?.sendBeacon).toBe(originalBeacon)
    expect(Math.random).toBe(originalRandom)
    expect(globalThis.fetch).toBe(beforeFetch)
  })

  it('guards Math.random and restores it through nested and throwing fixture scopes', async () => {
    const originalRandom = Math.random
    await expect(
      withCoreFixtureEnvironment(async ({ readers }) => {
        expect(Math.random).toBe(readers.random)
        expect(() => Math.random()).toThrow(/nondeterministic randomness/i)

        const outerRandom = Math.random
        await withCoreFixtureEnvironment(async ({ readers: innerReaders }) => {
          expect(Math.random).toBe(innerReaders.random)
          expect(() => Math.random()).toThrow(/nondeterministic randomness/i)
        })
        expect(Math.random).toBe(outerRandom)
        throw new Error('random fixture callback failed')
      })
    ).rejects.toThrow('random fixture callback failed')
    expect(Math.random).toBe(originalRandom)
  })

  it('restores all guards through nested and throwing environments', async () => {
    const originalDateNow = Date.now
    const originalFetch = globalThis.fetch
    const originalXHR = globalThis.XMLHttpRequest
    const originalWebSocket = globalThis.WebSocket
    const originalStorage = globalThis.localStorage
    const originalBeacon = globalThis.navigator?.sendBeacon
    const originalRandom = Math.random
    await expect(
      withCoreFixtureEnvironment(async ({ readers }) => {
        const outerDateNow = Date.now
        const outerFetch = globalThis.fetch
        await withCoreFixtureEnvironment(async ({ readers: innerReaders }) => {
          expect(Date.now).not.toBe(outerDateNow)
          expect(globalThis.fetch).toBe(innerReaders.fetch)
          expect(globalThis.localStorage).toBe(innerReaders.storage)
          expect(() => innerReaders.storage()).toThrow()
        })
        expect(Date.now).toBe(outerDateNow)
        expect(globalThis.fetch).toBe(outerFetch)
        expect(() => readers.sendBeacon()).toThrow()
        throw new Error('fixture callback failed')
      })
    ).rejects.toThrow('fixture callback failed')
    expect(Date.now).toBe(originalDateNow)
    expect(globalThis.fetch).toBe(originalFetch)
    expect(globalThis.XMLHttpRequest).toBe(originalXHR)
    expect(globalThis.WebSocket).toBe(originalWebSocket)
    expect(globalThis.localStorage).toBe(originalStorage)
    expect(globalThis.navigator?.sendBeacon).toBe(originalBeacon)
    expect(Math.random).toBe(originalRandom)
  })

  it('keeps every state source-backed, materially distinct, and deeply frozen', () => {
    const builders = {
      'core-money': buildCoreMoneyFixture,
      'core-strategy': buildCoreStrategyFixture,
      'core-crew': buildCoreCrewFixture,
      'core-settings': buildCoreSettingsFixture,
      'core-dialog': buildCoreDialogFixture,
      'core-base-withdraw': buildCoreBaseWithdrawFixture,
    }
    for (const [id, build] of Object.entries(builders)) {
      for (const state of CORE_FIXTURE_STATES[id]) {
        const fixture = build(state)
        expectDeepFrozen(fixture)
        expectPublicGraphHasNoForbiddenKeys(fixture)
        expect(() => serializeCoreFixture(fixture.serializable)).not.toThrow()
        expect(JSON.stringify(fixture)).not.toMatch(
          /session.?key|private.?key|signer.?secret|capability.?blob|bearer.?token|execution.?credential/i
        )
      }
    }

    const strategyExpectations = {
      plan: ['plan', null, null],
      protect: ['protect', null, null],
      start: ['start', null, null],
      receipt: ['start', 'done', 100],
      'yield-unavailable': ['plan', null, null],
      'permission-fresh': ['protect', null, null],
      'permission-reuse-verified': ['protect', null, null],
      'permission-rejected': ['protect', null, null],
      'permission-reuse-unavailable': ['protect', null, null],
      queued: ['start', 'queued', 0],
      partial: ['start', 'depositing', 66],
      'in-transit': ['start', 'in-transit', null],
      'base-custody': ['start', 'confirmed', 100],
    }
    for (const [state, [stage, phase, progress]] of Object.entries(strategyExpectations)) {
      const fixture = buildCoreStrategyFixture(state)
      const props = fixture.createProps()
      expect(fixture.stage).toBe(stage)
      expect(props.eventPhase).toBe(phase)
      expect(props.progress).toBe(progress)
      if (phase === 'done') expect(props.eventPhase).not.toBe('in-transit')
      if (state === 'in-transit') {
        expect(props.eventPhase).not.toBe('done')
        expect(props.progress).not.toBe(100)
        expect(props.events.some((event) => event.name === 'farm-relay-dispatched')).toBe(true)
        expect(props.receipt).toBeNull()
      }
    }
    expect(buildCoreStrategyFixture('permission-rejected').permissionSummary.selected.status).toBe(
      'Rejected'
    )
    expect(
      buildCoreStrategyFixture('permission-reuse-unavailable').permissionSummary.selected.status
    ).toBe('Unavailable')

    const armed = buildCoreCrewFixture('armed')
    const alarmOnly = buildCoreCrewFixture('alarm-only')
    const unknown = buildCoreCrewFixture('unknown')
    expect(armed.createProps().model.protection.state).toBe('armed')
    expect(armed.createProps().model.protection.mandateExpiry).toBeGreaterThan(
      CORE_FIXTURE_CLOCK.nowMs / 1000
    )
    expect(alarmOnly.createProps().model.protection.mandateExpiry).toBeLessThan(
      CORE_FIXTURE_CLOCK.nowMs / 1000
    )
    expect(unknown.createProps().model.protection).toBeNull()
    expect(armed.keeperEvents.length).toBeGreaterThan(0)
    expect(armed.decisions.length).toBeGreaterThan(0)
    expect(armed.radar.source).toBe('keeper-events')
    expect(
      buildCoreCrewFixture('stable-child-marks')
        .createProps()
        .crew.personas.flatMap((persona) => persona.children)
    ).toHaveLength(2)
    expect(
      buildCoreCrewFixture('cancelled')
        .createProps()
        .crew.personas.flatMap((persona) => persona.children)[0].active
    ).toBe(false)

    const recovery = buildCoreMoneyFixture('recovery-opener')
    const current = buildCoreMoneyFixture('current')
    expect(recovery.recoveryOpener.available).toBe(true)
    expect(recovery.recoveryOpener.action).not.toBe(current.recoveryOpener.action)
    expect(recovery.createProps().baseActionsAvailable).toBe(true)
    expect(recovery.createProps().onRecoverBase).toEqual(expect.any(Function))
    expect(current.recoveryOpener.available).toBe(false)

    for (const state of CORE_FIXTURE_STATES['core-base-withdraw']) {
      const withdraw = buildCoreBaseWithdrawFixture(state)
      expect(withdraw.withdrawScenario.state).toBe(state)
      expect(withdraw.withdrawScenario.expectedStages.length).toBeGreaterThan(0)
      expect(withdraw.createProps().idleUsdc).toBe(1_000_000n)
      expect(withdraw.createProps().positions[0].minAssets).toBe(8_900_000n)
    }
  })

  it('provides complete source-shaped fresh permission rows for Protect max-at-risk math', () => {
    const props = buildCoreStrategyFixture('permission-fresh').createProps()
    const decision = props.permissionDecision
    expect(decision.reviewedAgentInits.length).toBeGreaterThan(0)

    for (const row of decision.reviewedAgentInits) {
      expect(row.periodSeconds).toBe(3600)
      expect(row.expiry).toBe(Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000) + 86_400)
      expect(() =>
        maxAtRisk({
          capPerPeriod: BigInt(row.cap.units),
          periodDuration: row.periodSeconds,
          expiry: row.expiry,
          nowSec: decision.checkedAt,
        })
      ).not.toThrow()
    }
  })

  it('keeps canonical ledger and block anchors as decimal strings at fixture source boundaries', () => {
    const currentModel = buildCoreMoneyFixture('current').createProps().model
    const partialModel = buildCoreMoneyFixture('partial-discovery').createProps().model

    expect(currentModel.confirmedLedger).toBe(CORE_FIXTURE_CLOCK.confirmedLedger)
    expect(typeof currentModel.confirmedLedger).toBe('string')
    expect(currentModel.confirmedBlock).toBeNull()
    expect(partialModel.confirmedBlock).toBe(CORE_FIXTURE_CLOCK.confirmedBlock)
    expect(typeof partialModel.confirmedBlock).toBe('string')

    // These are unchanged production-interface exceptions, not presentation anchors: the existing
    // reuse adapter validates `allowanceExpiryProof.latestLedger` with Number.isFinite, while Crew
    // identity assignment validates `createdLedger` with Number.isSafeInteger.
    const reuseDecision = buildCoreStrategyFixture('permission-reuse-verified').createProps()
    expect(typeof reuseDecision.permissionDecision.allowanceExpiryProof.latestLedger).toBe('number')
    const crewDiscovery = buildCoreCrewFixture('armed').createProps().crew.personas[0].children[0]
    expect(typeof crewDiscovery.discoveryRow.createdLedger).toBe('number')
  })

  it('uses canonical decimal strings at the mandate source boundary', () => {
    const ready = buildCoreSettingsFixture('mandate-ready')
    expect(ready.mandateSummary.capUnits).toBe('10000000000')
    expect(typeof ready.mandateSummary.capUnits).toBe('string')
    expect(ready.createProps().mandateView.perCallCap.units).toBe(10_000_000_000n)
    expect(toCoreManagerMandateView).toBeTypeOf('function')
  })

  it('keeps public builder graphs identity-free and exposes source identities only at mount factories', () => {
    const builders = [
      buildCoreMoneyFixture,
      buildCoreStrategyFixture,
      buildCoreCrewFixture,
      buildCoreSettingsFixture,
      buildCoreDialogFixture,
      buildCoreBaseWithdrawFixture,
    ]
    for (const build of builders) {
      const fixture = build()
      expectPublicGraphHasNoForbiddenKeys(fixture)
      expectDeepFrozen(fixture)
      expect(fixture.createProps).toEqual(expect.any(Function))
      expect(Object.isFrozen(fixture.createProps)).toBe(true)
      const mounted = fixture.createProps()
      expectDeepFrozen(mounted)
    }

    const moneyProps = buildCoreMoneyFixture('current').createProps()
    expect(moneyProps.account).toBe(CORE_FIXTURE_ADDRESSES.stellarOwner)
    expect(moneyProps.agents[0].address).toBe(CORE_FIXTURE_ADDRESSES.agentA)
    const strategyProps = buildCoreStrategyFixture('receipt').createProps()
    expect(strategyProps.runId).toBe(CORE_FIXTURE_RUN)
    expect(strategyProps.plan.agents[0].allocationId).toContain(CORE_FIXTURE_RUN)
    const crewProps = buildCoreCrewFixture('armed').createProps()
    expect(crewProps.model.protection.authority).toBe(CORE_FIXTURE_ADDRESSES.stellarOwner)
    const settingsProps = buildCoreSettingsFixture('mandate-ready').createProps()
    expect(settingsProps.mandateView.sessionKeyAddress).toBeTruthy()
    const withdrawProps = buildCoreBaseWithdrawFixture('confirmed').createProps()
    expect(withdrawProps.ownerKernelAccount.address).toBe(CORE_FIXTURE_ADDRESSES.baseKernel)
    expect(withdrawProps.stellarRecipient).toBe(CORE_FIXTURE_ADDRESSES.stellarOwner)
  })

  it('matches the real CAP-18 relayer DTOs and Withdraw amount contract without network access', async () => {
    const fixture = buildCoreBaseWithdrawFixture('confirmed')
    const props = fixture.createProps()
    const reserveSource = await props.seams.reserve()
    expect(reserveSource).toEqual({
      jobId: 'aabbccddeeff00112233445566778899',
      status: 'awaiting_burn',
    })

    const jobBytes = Uint8Array.from(
      'aabbccddeeff00112233445566778899'.match(/../g).map((value) => Number.parseInt(value, 16))
    )
    const cryptoImpl = {
      getRandomValues: vi.fn((buffer) => {
        if (buffer.length === 16) buffer.set(jobBytes)
        else buffer.fill(0xbb)
        return buffer
      }),
    }
    const reserve = await reserveUnwind({
      kernelAddress: props.ownerKernelAccount.address,
      recipientHint: props.stellarRecipient,
      deps: {
        cryptoImpl,
        fetchImpl: vi.fn(async (_url, options) => {
          const body = JSON.parse(options.body)
          expect(body.jobId).toBe(reserveSource.jobId)
          return { ok: true, status: 202, json: async () => reserveSource }
        }),
      },
    })
    expect(reserve).toEqual(reserveSource)

    const attachSource = await props.seams.attach()
    expect(Object.keys(attachSource).sort()).toEqual(['jobId', 'status', 'unwindTxHash'].sort())
    expect(['relay_pending', 'relay_running', 'done', 'blocked', 'uncertain']).toContain(
      attachSource.status
    )
    const attach = await postUnwindAttach({
      jobId: reserve.jobId,
      userOpHash: CORE_FIXTURE_HASHES.baseUserOp,
      unwindTxHash: CORE_FIXTURE_HASHES.burn,
      deps: {
        fetchImpl: vi.fn(async () => ({
          ok: true,
          status: 202,
          json: async () => attachSource,
        })),
      },
    })
    expect(attach).toEqual(attachSource)

    const pollSource = await props.seams.poll()
    expect(pollSource).toEqual({
      jobId: reserve.jobId,
      status: 'done',
      unwindTxHash: CORE_FIXTURE_HASHES.burn,
      mintTxHash: CORE_FIXTURE_HASHES.baseUserOp.slice(2),
    })
    const polled = await pollUnwindStatus({
      jobId: reserve.jobId,
      maxTries: 1,
      deps: {
        fetchImpl: vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => pollSource,
        })),
      },
    })
    expect(polled).toEqual(pollSource)

    expect(typeof props.idleUsdc).toBe('bigint')
    expect(typeof props.positions[0].minAssets).toBe('bigint')
    expect(
      buildUnwindCalls({
        positions: props.positions,
        stellarRecipient: props.stellarRecipient,
        idleUsdc: props.idleUsdc,
        deadline: BigInt(Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000)) + 600n,
        nowSeconds: BigInt(Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000)),
      }).length
    ).toBeGreaterThan(0)
  })

  it('provides deterministic adapter controls for every declared CAP-18 status', async () => {
    for (const state of CORE_FIXTURE_STATES['core-base-withdraw']) {
      const fixture = buildCoreBaseWithdrawFixture(state)
      const props = fixture.createProps()
      const read = await props.seams.read()
      expect(read.idleUsdc).toBe(1_000_000n)
      expect(read.positions[0].minAssets).toBe(8_900_000n)
      if (state === 'idle') continue
      if (state === 'submitting') {
        props.controls.releaseSend()
        await expect(props.seams.send({ onSubmitted: vi.fn() })).resolves.toMatchObject({
          evidenceStatus: 'verified',
        })
      } else if (state === 'relaying') {
        props.controls.releaseAttach()
        await expect(props.seams.attach()).resolves.toMatchObject({ status: 'relay_pending' })
      } else if (state === 'polling') {
        props.controls.releasePoll()
        await expect(props.seams.poll()).resolves.toMatchObject({ status: 'relay_running' })
      } else if (state === 'failed') {
        await expect(props.seams.send({ onSubmitted: vi.fn() })).rejects.toThrow(/relayer/i)
      } else if (state === 'submission-unknown') {
        await expect(props.seams.send({ onSubmitted: vi.fn() })).rejects.toMatchObject({
          code: 'submission_unknown',
        })
      } else {
        const projection = await props.seams.poll()
        expect(['relay_running', 'done']).toContain(projection.status)
      }
    }
  })

  it('does not consult ambient time while building any state', () => {
    const dateNow = vi.spyOn(Date, 'now')
    for (const state of CORE_FIXTURE_STATES['core-money']) buildCoreMoneyFixture(state)
    for (const state of CORE_FIXTURE_STATES['core-strategy']) buildCoreStrategyFixture(state)
    for (const state of CORE_FIXTURE_STATES['core-crew']) buildCoreCrewFixture(state)
    for (const state of CORE_FIXTURE_STATES['core-settings']) buildCoreSettingsFixture(state)
    for (const state of CORE_FIXTURE_STATES['core-dialog']) buildCoreDialogFixture(state)
    for (const state of CORE_FIXTURE_STATES['core-base-withdraw'])
      buildCoreBaseWithdrawFixture(state)
    expect(dateNow).not.toHaveBeenCalled()
    dateNow.mockRestore()
  })

  it('builds real source-shaped deterministic route seams for each Core class', () => {
    const builders = {
      'core-money': buildCoreMoneyFixture,
      'core-strategy': buildCoreStrategyFixture,
      'core-crew': buildCoreCrewFixture,
      'core-settings': buildCoreSettingsFixture,
      'core-dialog': buildCoreDialogFixture,
      'core-base-withdraw': buildCoreBaseWithdrawFixture,
    }
    for (const [id, build] of Object.entries(builders)) {
      const fixture = build()
      expect(fixture.id).toBe(id)
      expect(fixture.clock).toBe(CORE_FIXTURE_CLOCK)
      expect(fixture.readers).toBeDefined()
      expect(fixture.states).toEqual(CORE_FIXTURE_STATES[id])
      expect(fixture.route).toBe(CORE_FIXTURE_REGISTRY[id].route)
      expect(() => serializeCoreFixture(fixture.serializable)).not.toThrow()
    }
  })

  it('keeps large amounts exact and does not expose secrets in any builder payload', () => {
    const fixtures = [
      buildCoreMoneyFixture(),
      buildCoreStrategyFixture(),
      buildCoreCrewFixture(),
      buildCoreSettingsFixture(),
      buildCoreDialogFixture(),
      buildCoreBaseWithdrawFixture(),
    ]
    for (const fixture of fixtures) {
      expect(JSON.stringify(fixture.serializable)).not.toMatch(
        /secret|private.?key|capability|bearer|session.?key|signer.?material/i
      )
      expect(JSON.stringify(fixture.serializable)).not.toContain('9007199254740992')
    }
    expect(buildCoreMoneyFixture('current').displayAmount).toEqual({
      token: 'USDC',
      units: '9007199254740993',
      decimals: 7,
    })
  })
})
