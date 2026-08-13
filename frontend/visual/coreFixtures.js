// Deterministic source seams for the authenticated Pocket Crew visual atlas.
//
// This module is a test/visual boundary.  It deliberately does not replace production readers or
// defaults.  The browser harness can inject the returned models/readers into the real route roots,
// while the unit tests can validate the exact values and security boundary without mounting a
// route or touching the network.
import { buildMyMoneyModel } from '../src/money/myMoneyModel.js'
import { buildCrewPersonas } from '../src/crew/buildCrewPersonas.js'
import {
  normalizeCoreAmount,
  toBaseMandateManagerState,
  toLiveVenueView,
  toPermissionCopy,
} from '../src/core/coreRouteAdapters.js'

export const CORE_FIXTURE_CLOCK = Object.freeze({
  nowMs: Date.parse('2026-08-11T00:00:00.000Z'),
  nowIso: '2026-08-11T00:00:00.000Z',
  checkedAtMs: Date.parse('2026-08-10T23:59:00.000Z'),
  checkedAtIso: '2026-08-10T23:59:00.000Z',
  confirmedLedger: '12345',
  confirmedBlock: '67890',
})

export const CORE_FIXTURE_ADDRESSES = Object.freeze({
  stellarOwner: 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS',
  agentA: 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
  agentB: 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J',
  vault: 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77',
  token: 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
  baseKernel: '0x0000000000000000000000000000000000000aa1',
  basePool: '0x00000000000000000000000000000000000000b2',
})

export const CORE_FIXTURE_HASHES = Object.freeze({
  grant: `0x${'11'.repeat(32)}`,
  stellar: `0x${'22'.repeat(32)}`,
  burn: `0x${'33'.repeat(32)}`,
  baseUserOp: `0x${'44'.repeat(32)}`,
})

export const CORE_FIXTURE_RUN = 'run-core-fixture-20260811'

export const CORE_CAPTURE_PROJECTS = Object.freeze([
  'mobile-320',
  'mobile-360',
  'tablet-768',
  'desktop-1440',
])

export const CORE_FIXTURE_THEMES = Object.freeze(['forest', 'day-field', 'reduced-motion'])

export const CORE_FIXTURE_CLASSES = Object.freeze([
  'core-money',
  'core-strategy',
  'core-crew',
  'core-settings',
  'core-dialog',
  'core-base-withdraw',
])

const STATE_INVENTORIES = {
  'core-money': [
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
  ],
  'core-strategy': [
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
  ],
  'core-crew': ['armed', 'alarm-only', 'unknown', 'cancelled', 'empty', 'stable-child-marks'],
  'core-settings': [
    'default',
    'wallet',
    'mandate-ready',
    'mandate-missing',
    'mandate-expired',
    'mandate-revoked',
    'mandate-disconnected',
    'mandate-unavailable',
    'mandate-busy',
  ],
  'core-dialog': [
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
  ],
  'core-base-withdraw': [
    'idle',
    'submitting',
    'relaying',
    'polling',
    'confirmed',
    'failed',
    'submission-unknown',
    'in-transit',
  ],
}

function deepFreeze(value, seen = new WeakSet()) {
  const type = typeof value
  if (value === null || (type !== 'object' && type !== 'function') || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) continue
    if ('value' in descriptor) deepFreeze(descriptor.value, seen)
    else {
      deepFreeze(descriptor.get, seen)
      deepFreeze(descriptor.set, seen)
    }
  }
  return Object.freeze(value)
}

export const CORE_FIXTURE_STATES = deepFreeze({
  ...Object.fromEntries(Object.entries(STATE_INVENTORIES).map(([id, states]) => [id, [...states]])),
})

const captureCellsFor = (id, cap) =>
  CORE_FIXTURE_THEMES.flatMap((theme) =>
    CORE_CAPTURE_PROJECTS.map((project) => ({
      id: `${id}:${theme}:${project}`,
      fixture: id,
      cap,
      theme,
      project,
      screenshotBase: `${id}-${theme}`,
    }))
  )

const registryEntry = ({ id, cap, route, productionRoutes }) => ({
  id,
  cap,
  route,
  productionRoutes,
  screenshotBases: CORE_FIXTURE_THEMES.map((theme) => `${id}-${theme}`),
  states: CORE_FIXTURE_STATES[id],
  captureCells: captureCellsFor(id, cap),
})

export const CORE_FIXTURE_REGISTRY = deepFreeze({
  'core-money': registryEntry({
    id: 'core-money',
    cap: 'CAP-08',
    route: '/home',
    productionRoutes: ['/home'],
  }),
  'core-strategy': registryEntry({
    id: 'core-strategy',
    cap: 'CAP-09',
    route: '/strategy',
    productionRoutes: ['/strategy'],
  }),
  'core-crew': registryEntry({
    id: 'core-crew',
    cap: 'CAP-10',
    route: '/agent',
    productionRoutes: ['/agent'],
  }),
  'core-settings': registryEntry({
    id: 'core-settings',
    cap: 'CAP-12',
    route: '/settings',
    productionRoutes: ['/settings', '/settings?tab=wallet#base-mandate'],
  }),
  'core-dialog': registryEntry({
    id: 'core-dialog',
    cap: 'CAP-16',
    route: 'cross-route-dialogs',
    productionRoutes: ['/strategy', '/home', '/settings'],
  }),
  'core-base-withdraw': registryEntry({
    id: 'core-base-withdraw',
    cap: 'CAP-18',
    route: '/home',
    productionRoutes: ['/home'],
  }),
})

export const CORE_CAPTURE_CELLS = deepFreeze(
  Object.values(CORE_FIXTURE_REGISTRY).flatMap((entry) => entry.captureCells)
)

// Keys are normalized before comparison so `session-key-material`, `session_key_material`, and
// `sessionKeyMaterial` all fail closed. `token` is intentionally absent: it is the canonical
// amount DTO field and is not a secret by itself.
const FORBIDDEN_KEY_PARTS = Object.freeze([
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
])

function normalizedKey(key) {
  return String(key)
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function isForbiddenKey(key) {
  const normalized = normalizedKey(key)
  return FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part))
}

function cloneSerializable(value, path = '$', ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot serialize non-finite value at ${path}`)
    return value
  }
  if (typeof value === 'bigint') throw new TypeError(`Cannot serialize bigint at ${path}`)
  if (typeof value !== 'object') throw new TypeError(`Cannot serialize value at ${path}`)
  if (ancestors.has(value)) throw new TypeError(`Cannot serialize cyclic value at ${path}`)

  ancestors.add(value)
  try {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`Cannot serialize non-plain object at ${path}`)
    }
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          throw new TypeError(`Cannot serialize symbol property at ${path}`)
        }
        if (key !== 'length' && !/^\d+$/.test(key)) {
          if (isForbiddenKey(key)) throw new TypeError(`Forbidden fixture key "${key}" at ${path}`)
          throw new TypeError(`Cannot serialize array property "${key}" at ${path}`)
        }
      }
      return value.map((entry, index) => cloneSerializable(entry, `${path}[${index}]`, ancestors))
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol')
        throw new TypeError(`Cannot serialize symbol property at ${path}`)
    }
    const output = {}
    for (const key of Object.keys(value).sort()) {
      if (isForbiddenKey(key)) throw new TypeError(`Forbidden fixture key "${key}" at ${path}`)
      output[key] = cloneSerializable(value[key], `${path}.${key}`, ancestors)
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}

/** Serialize only safe display/test data. Identity and signer-shaped fields are never accepted. */
export function serializeCoreFixture(value) {
  return JSON.stringify(cloneSerializable(value))
}

export function forbiddenNetworkCall() {
  throw new Error('Core visual fixtures must not access the network')
}

export function forbiddenRandomCall() {
  throw new Error('Core visual fixtures must not use nondeterministic randomness')
}

const CORE_FIXTURE_READERS = deepFreeze({
  fetch: forbiddenNetworkCall,
  rpc: forbiddenNetworkCall,
  readRpc: forbiddenNetworkCall,
  relayer: forbiddenNetworkCall,
  readRelayer: forbiddenNetworkCall,
  relay: forbiddenNetworkCall,
  wallet: forbiddenNetworkCall,
  signer: forbiddenNetworkCall,
  faucet: forbiddenNetworkCall,
  xhr: forbiddenNetworkCall,
  webSocket: forbiddenNetworkCall,
  sendBeacon: forbiddenNetworkCall,
  storage: forbiddenNetworkCall,
  random: forbiddenRandomCall,
})

export function createCoreFixtureReaders() {
  return CORE_FIXTURE_READERS
}

function setGlobalGuard(target, key, value, restore) {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, key)
  const descriptor = hadOwn ? Object.getOwnPropertyDescriptor(target, key) : undefined
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value,
    })
  } catch {
    try {
      target[key] = value
    } catch {
      return
    }
  }
  restore.push(() => {
    try {
      if (hadOwn) Object.defineProperty(target, key, descriptor)
      else delete target[key]
    } catch {
      // A host-owned non-configurable property can be restored only by its host. In ordinary
      // Vitest/jsdom/Chromium contexts the descriptor above is configurable and this is not hit.
    }
  })
}

/**
 * Run a fixture callback with a fixed clock, blocked browser/network readers, and blocked
 * nondeterministic randomness. The original globals are restored before the returned promise
 * settles, including when the callback throws.
 */
export async function withCoreFixtureEnvironment(callback) {
  if (typeof callback !== 'function') throw new TypeError('fixture callback is required')
  const readers = createCoreFixtureReaders()
  const restore = []
  const originalDateNow = Date.now
  setGlobalGuard(Date, 'now', () => CORE_FIXTURE_CLOCK.nowMs, restore)
  setGlobalGuard(Math, 'random', readers.random, restore)
  for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket']) {
    setGlobalGuard(
      globalThis,
      key,
      readers[key === 'fetch' ? 'fetch' : key === 'XMLHttpRequest' ? 'xhr' : 'webSocket'],
      restore
    )
  }
  if (globalThis.navigator && typeof globalThis.navigator === 'object') {
    setGlobalGuard(globalThis.navigator, 'sendBeacon', readers.sendBeacon, restore)
  }
  setGlobalGuard(globalThis, 'localStorage', readers.storage, restore)

  try {
    return await callback({
      clock: CORE_FIXTURE_CLOCK,
      nowMs: CORE_FIXTURE_CLOCK.nowMs,
      readers,
    })
  } finally {
    // Keep an explicit reference in this scope so a test can detect if another helper accidentally
    // replaced Date.now during the fixture callback; restoration always returns the original.
    void originalDateNow
    for (const undo of restore.reverse()) undo()
  }
}

export function createCoreFixtureContext() {
  return Object.freeze({
    clock: CORE_FIXTURE_CLOCK,
    nowMs: CORE_FIXTURE_CLOCK.nowMs,
    nowIso: CORE_FIXTURE_CLOCK.nowIso,
    checkedAtMs: CORE_FIXTURE_CLOCK.checkedAtMs,
    checkedAtIso: CORE_FIXTURE_CLOCK.checkedAtIso,
    readers: createCoreFixtureReaders(),
  })
}

const DISPLAY_AMOUNT = Object.freeze({ token: 'USDC', units: '9007199254740993', decimals: 7 })
const SMALL_AMOUNT = Object.freeze({ token: 'USDC', units: '1250000000', decimals: 7 })

function sourceAmount(units = SMALL_AMOUNT.units) {
  return { token: 'USDC', units: String(units), decimals: 7 }
}

function moneyAgent(address, { problem = false, custody = 'stellar-vault' } = {}) {
  return {
    address,
    scope: {
      state: 'known',
      value: { vault: CORE_FIXTURE_ADDRESSES.vault, revoked: problem, expiry: 0 },
    },
    amount: sourceAmount(problem ? '500000000' : '1250000000'),
    executionStatus: problem ? 'idle' : 'succeeded',
    custody: { location: custody },
    custodyBreakdown: [],
    problems: problem ? ['scope-revoked'] : [],
  }
}

function moneyInputs(state) {
  const owner = state === 'disconnected' ? null : CORE_FIXTURE_ADDRESSES.stellarOwner
  const activeAgents = [
    moneyAgent(CORE_FIXTURE_ADDRESSES.agentA),
    moneyAgent(CORE_FIXTURE_ADDRESSES.agentB),
  ]
  const base = {
    confirmedTotal: { state: 'known', amount: sourceAmount('2500000000') },
    yield: {
      state: 'live',
      apy: 4.8,
      source: 'defillama',
      checkedAt: CORE_FIXTURE_CLOCK.checkedAtMs,
    },
    earned: { state: 'unavailable', amount: null },
    unattributed: {},
    custodyBreakdown: { 'stellar-vault': '2500000000' },
    agentCount: activeAgents.length,
    problemAgentCount: 0,
    agents: activeAgents,
    checkedAt: CORE_FIXTURE_CLOCK.checkedAtMs,
    // Presentation/source boundary: confirmation anchors stay canonical decimal strings. The
    // money model forwards this field unchanged; no display precision is gained by coercing it.
    confirmedLedger: CORE_FIXTURE_CLOCK.confirmedLedger,
    confirmedBlock: null,
    source: 'stellar-rpc',
  }
  const discovery = {
    status: 'complete',
    agents: activeAgents.map((agent, index) => ({
      address: agent.address,
      cap: index === 0 ? '2500000000' : '2000000000',
    })),
  }
  const protection = {
    state: state === 'disarmed' || state === 'empty' ? 'disarmed' : 'armed',
    authority: owner,
    mandateExpiry: Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000) + 86_400,
  }

  if (state === 'loading') return { owner, discovery: null, money: null, protection: null }
  if (state === 'unavailable') {
    return {
      owner,
      discovery,
      money: { ...base, confirmedTotal: { state: 'unavailable', amount: null } },
      protection,
    }
  }
  if (state === 'empty') {
    return {
      owner,
      discovery: { status: 'complete', agents: [] },
      money: {
        ...base,
        confirmedTotal: { state: 'known', amount: sourceAmount('0') },
        custodyBreakdown: {},
        agentCount: 0,
        agents: [],
        yield: { state: 'unavailable', apy: null },
      },
      protection,
    }
  }
  if (state === 'partial-discovery') {
    return {
      owner,
      discovery: { status: 'partial', agents: [discovery.agents[0]] },
      money: {
        ...base,
        unattributed: {
          [CORE_FIXTURE_ADDRESSES.baseKernel]: {
            state: 'unavailable',
            amount: null,
            checkedAt: null,
          },
        },
        // Presentation/source boundary: keep the Base confirmation anchor as its canonical
        // decimal string. The production model forwards it unchanged.
        confirmedBlock: CORE_FIXTURE_CLOCK.confirmedBlock,
      },
      protection: null,
    }
  }
  if (state === 'problem') {
    const recovery = moneyAgent(CORE_FIXTURE_ADDRESSES.agentB, { problem: true })
    return {
      owner,
      discovery,
      money: {
        ...base,
        agents: [activeAgents[0], recovery],
        problemAgentCount: 1,
        confirmedTotal: { state: 'known', amount: sourceAmount('1750000000') },
      },
      protection,
    }
  }
  if (state === 'stale') {
    return {
      owner,
      discovery,
      money: { ...base, checkedAt: CORE_FIXTURE_CLOCK.checkedAtMs - 180_000 },
      protection,
    }
  }
  return { owner, discovery, money: base, protection }
}

function recoveryOpenerFor(state) {
  return state === 'recovery-opener'
    ? {
        available: true,
        action: 'recover-base-account',
        label: 'Recover Base account',
        reason: 'The owner can open the separate Base recovery ceremony from this device.',
      }
    : {
        available: false,
        action: 'recovery-unavailable',
        label: 'Recover Base account',
        reason: 'Base recovery is unavailable until a local Base account is available.',
      }
}

export function buildCoreMoneyFixture(state = 'current') {
  if (!CORE_FIXTURE_STATES['core-money'].includes(state)) {
    throw new RangeError(`Unknown core-money state: ${state}`)
  }
  const requestedState = state
  const modelState = state === 'recovery-opener' ? 'current' : state
  const inputs = moneyInputs(modelState)
  const model = buildMyMoneyModel({ ...inputs, now: CORE_FIXTURE_CLOCK.nowMs })
  const venue = toLiveVenueView(
    modelState === 'unavailable'
      ? { venueKind: 'stellar-live', yield: { state: 'unavailable' } }
      : {
          venueKind: 'stellar-live',
          chain: 'stellar',
          yield: {
            state: 'live',
            apy: 4.8,
            asOf: CORE_FIXTURE_CLOCK.checkedAtIso,
            source: 'defillama',
            checkedAt: CORE_FIXTURE_CLOCK.checkedAtIso,
          },
        }
  )
  const serializable = {
    id: 'core-money',
    state: requestedState,
    route: '/home',
    displayAmount: DISPLAY_AMOUNT,
    source: 'stellar-rpc',
    checkedAt: CORE_FIXTURE_CLOCK.checkedAtIso,
    states: CORE_FIXTURE_STATES['core-money'],
  }
  const createProps = () =>
    deepFreeze({
      model,
      agents: inputs.money?.agents ?? [],
      discovery: inputs.discovery,
      account: inputs.owner,
      venue: 'Autofarm Vault',
      nowMs: CORE_FIXTURE_CLOCK.nowMs,
      baseActionsAvailable: requestedState === 'recovery-opener',
      baseUnavailableReason:
        requestedState === 'recovery-opener'
          ? null
          : 'Base recovery is unavailable until a local Base account is available.',
      onRecoverBase: requestedState === 'recovery-opener' ? () => undefined : undefined,
    })

  return deepFreeze({
    id: 'core-money',
    cap: 'CAP-08',
    route: '/home',
    state: requestedState,
    states: CORE_FIXTURE_STATES['core-money'],
    clock: CORE_FIXTURE_CLOCK,
    readers: createCoreFixtureReaders,
    displayAmount: normalizeCoreAmount(DISPLAY_AMOUNT),
    venue,
    recoveryOpener: recoveryOpenerFor(requestedState),
    createProps,
    mountProps: createProps,
    serializable,
  })
}

function strategyPlan(state = 'plan') {
  const makeDeposit = (index, units = '2500000000') => {
    const amount = sourceAmount(units)
    return {
      allocationId: `${CORE_FIXTURE_RUN}:deposit:${index}`,
      kind: 'deposit',
      hostNetworkId: 'stellar-testnet',
      allocation: amount,
      cap: amount,
      periodSeconds: 3600,
      expiry: Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000) + 86_400,
      destination: 'Stellar deposit',
      children: [],
    }
  }
  const makeBridge = () => {
    const amount = sourceAmount('1250000000')
    return {
      allocationId: `${CORE_FIXTURE_RUN}:bridge:0`,
      kind: 'bridge',
      hostNetworkId: 'stellar-testnet',
      allocation: amount,
      cap: amount,
      periodSeconds: 3600,
      expiry: Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000) + 86_400,
      destination: 'Base Sepolia proxy custody',
      children: [],
    }
  }
  const agents =
    state === 'partial'
      ? [makeDeposit(0, '1250000000'), makeDeposit(1, '1250000000')]
      : ['in-transit', 'base-custody'].includes(state)
        ? [makeDeposit(0), makeBridge()]
        : [makeDeposit(0)]
  const totalUnits = agents.reduce((sum, agent) => sum + BigInt(agent.allocation.units), 0n)
  const amount = sourceAmount(totalUnits.toString())
  return {
    amount,
    agents,
    truth: {
      agentIsolationCount: agents.length,
      stellarVenueCount: agents.filter((agent) => agent.kind === 'deposit').length,
      baseUsesProxyVaults: agents.some((agent) => agent.kind === 'bridge'),
    },
  }
}

function reuseDecision() {
  return {
    mode: 'reuse',
    confirmationCount: 0,
    grantReceiptFingerprint: CORE_FIXTURE_HASHES.grant,
    allowanceExpiryProof: {
      gapFree: true,
      noLaterMutation: true,
      // Unchanged production interface exception: coreRouteAdapters.hasAllowanceProof requires a
      // finite numeric latestLedger, and reusePreflight compares it arithmetically to expiry.
      latestLedger: Number(CORE_FIXTURE_CLOCK.confirmedLedger),
      approvals: [{ amount: sourceAmount('2500000000'), expiryLedger: 13000 }],
    },
    agents: [
      {
        allocationId: `${CORE_FIXTURE_RUN}:deposit:0`,
        agentAddress: CORE_FIXTURE_ADDRESSES.agentA,
        scopeExpiry: 13000,
        headroom: sourceAmount('2500000000'),
      },
    ],
  }
}

function freshDecision(plan) {
  return {
    mode: 'fresh',
    // Unchanged production interface exception: ProtectStage passes checkedAt as nowSec to
    // permissionScope.maxAtRisk, whose arithmetic contract is Unix seconds (not an ISO string or
    // millisecond timestamp).
    checkedAt: Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000),
    confirmationCount: 1,
    txHash: CORE_FIXTURE_HASHES.grant,
    grantReceiptFingerprint: CORE_FIXTURE_HASHES.grant,
    // Unchanged production interface exception: Stellar grant/receipt DTOs and dispatch readers
    // treat expiryLedger as an absolute numeric ledger sequence for arithmetic and XDR fields.
    expiryLedger: Number(CORE_FIXTURE_CLOCK.confirmedLedger) + 1000,
    agentAddresses: plan.agents.map((_, index) =>
      index === 0 ? CORE_FIXTURE_ADDRESSES.agentA : CORE_FIXTURE_ADDRESSES.agentB
    ),
    reviewedBudgets: plan.agents.map((agent) => agent.cap),
    reviewedAgentInits: plan.agents.map((agent, index) => ({
      allocationId: agent.allocationId,
      // Keep the rows source-shaped like reusePreflight's reviewed AgentInit projection. In
      // particular, ProtectStage's real maxAtRisk call requires periodSeconds and expiry.
      kind: agent.kind === 'bridge' ? 1 : 0,
      token: CORE_FIXTURE_ADDRESSES.token,
      target: CORE_FIXTURE_ADDRESSES.vault,
      cap: agent.cap,
      periodSeconds: agent.periodSeconds,
      expiry: agent.expiry,
      signerFingerprint: `0x${'55'.repeat(32)}`,
      saltFingerprint: `0x${'66'.repeat(32)}`,
      destinationDomain: agent.kind === 'bridge' ? 6 : 0,
      mintRecipient: agent.kind === 'bridge' ? CORE_FIXTURE_ADDRESSES.basePool : null,
      agentAddress: index === 0 ? CORE_FIXTURE_ADDRESSES.agentA : CORE_FIXTURE_ADDRESSES.agentB,
    })),
  }
}

function sourceEvent(name, data) {
  return { name, data }
}

function strategyEvents(state, plan) {
  const depositAgents = plan.agents.filter((agent) => agent.kind === 'deposit')
  const first = depositAgents[0]
  const queue = (agent, queueIndex) =>
    sourceEvent('worker-queued', {
      allocationId: agent.allocationId,
      agentId: queueIndex === 0 ? CORE_FIXTURE_ADDRESSES.agentA : CORE_FIXTURE_ADDRESSES.agentB,
      agent: queueIndex === 0 ? CORE_FIXTURE_ADDRESSES.agentA : CORE_FIXTURE_ADDRESSES.agentB,
      queueIndex,
    })
  const start = (agent, queueIndex) =>
    sourceEvent('worker-started', {
      allocationId: agent.allocationId,
      agentId: queueIndex === 0 ? CORE_FIXTURE_ADDRESSES.agentA : CORE_FIXTURE_ADDRESSES.agentB,
      agent: queueIndex === 0 ? CORE_FIXTURE_ADDRESSES.agentA : CORE_FIXTURE_ADDRESSES.agentB,
      queueIndex,
    })
  if (state === 'queued') return [queue(first, 0)]
  if (state === 'partial') {
    const second = depositAgents[1]
    return [
      queue(first, 0),
      start(first, 0),
      sourceEvent('step', { allocationId: first.allocationId, step: 'deposit', status: 'pending' }),
      sourceEvent('completed', {
        allocationId: first.allocationId,
        agentId: CORE_FIXTURE_ADDRESSES.agentA,
        vault: CORE_FIXTURE_ADDRESSES.vault,
        txHash: CORE_FIXTURE_HASHES.stellar,
        gasMethod: 'fee-bump',
        relayer: 'core-fixture-relayer',
      }),
      queue(second, 1),
      start(second, 1),
      sourceEvent('step', {
        allocationId: second.allocationId,
        step: 'deposit',
        status: 'pending',
      }),
    ]
  }
  if (state === 'receipt') {
    return [
      queue(first, 0),
      start(first, 0),
      sourceEvent('step', { allocationId: first.allocationId, step: 'deposit', status: 'pending' }),
      sourceEvent('completed', {
        allocationId: first.allocationId,
        agentId: CORE_FIXTURE_ADDRESSES.agentA,
        vault: CORE_FIXTURE_ADDRESSES.vault,
        txHash: CORE_FIXTURE_HASHES.stellar,
        gasMethod: 'fee-bump',
        relayer: 'core-fixture-relayer',
      }),
    ]
  }
  if (['in-transit', 'base-custody'].includes(state)) {
    const events = [
      queue(first, 0),
      start(first, 0),
      sourceEvent('step', { allocationId: first.allocationId, step: 'deposit', status: 'pending' }),
      sourceEvent('completed', {
        allocationId: first.allocationId,
        agentId: CORE_FIXTURE_ADDRESSES.agentA,
        vault: CORE_FIXTURE_ADDRESSES.vault,
        txHash: CORE_FIXTURE_HASHES.stellar,
        gasMethod: 'fee-bump',
        relayer: 'core-fixture-relayer',
      }),
      sourceEvent('farm-burn-started', {
        address: CORE_FIXTURE_ADDRESSES.stellarOwner,
        amountUnits: '1250000000',
      }),
      sourceEvent('farm-burn-confirmed', { burnHash: CORE_FIXTURE_HASHES.burn }),
      sourceEvent('farm-relay-dispatched', { jobId: `${CORE_FIXTURE_RUN}:bridge-job` }),
    ]
    if (state === 'base-custody') {
      events.push(
        sourceEvent('farm-completed', {
          jobId: `${CORE_FIXTURE_RUN}:bridge-job`,
          status: 'done',
          steps: ['burn', 'attestation', 'mint', 'deposit'],
        })
      )
    }
    return events
  }
  return []
}

function strategyReceipt(state, plan, permissionDecision) {
  // A dispatch receipt is durable settlement evidence. In-transit is deliberately unresolved:
  // StartStage must continue deriving its lane from live bridge events until the relayer returns a
  // settled receipt, never render a pending receipt as if it were already authoritative.
  if (!['receipt', 'base-custody'].includes(state)) return null
  const allocations = plan.agents.map((agent, index) => {
    const bridge = agent.kind === 'bridge'
    const base = bridge && state === 'base-custody'
    const agentAddress = index === 0 ? CORE_FIXTURE_ADDRESSES.agentA : CORE_FIXTURE_ADDRESSES.agentB
    return {
      allocationId: agent.allocationId,
      amount: agent.allocation,
      networkContext: {
        executionNetwork: 'stellar-testnet',
        sourceNetwork: 'stellar-testnet',
        destinationNetwork: bridge ? 'base-sepolia' : 'stellar-testnet',
        currentCustodyNetwork: base ? 'base-sepolia' : 'stellar-testnet',
        transit: false,
      },
      executionStatus: 'succeeded',
      custody: {
        location: base ? 'base-proxy' : 'stellar-vault',
        confirmed: true,
        checkedAt: CORE_FIXTURE_CLOCK.checkedAtMs,
        source: 'receipt',
        amount: agent.allocation,
      },
      txHash: bridge ? CORE_FIXTURE_HASHES.burn : CORE_FIXTURE_HASHES.stellar,
      error: null,
      evidence: { allocationId: agent.allocationId, agentAddress },
    }
  })
  return {
    version: 1,
    runId: CORE_FIXTURE_RUN,
    planFingerprint: CORE_FIXTURE_HASHES.grant,
    permission: {
      ...permissionDecision,
      status: 'confirmed',
      txHash: CORE_FIXTURE_HASHES.grant,
    },
    branches: {
      stellar: {
        status: 'succeeded',
        results: allocations.filter(
          (a) => a.networkContext.destinationNetwork === 'stellar-testnet'
        ),
      },
      base: bridgeBranch(state, allocations),
    },
    allocations,
    source: 'dispatch-receipt',
    checkedAt: CORE_FIXTURE_CLOCK.checkedAtMs,
  }
}

function bridgeBranch(state, allocations) {
  const result = allocations.find(
    (allocation) => allocation.networkContext.destinationNetwork === 'base-sepolia'
  )
  if (!result) return { status: 'not-planned', results: [] }
  return {
    status: state === 'in-transit' ? 'pending' : 'succeeded',
    results: [result],
  }
}

export function buildCoreStrategyFixture(state = 'plan') {
  if (!CORE_FIXTURE_STATES['core-strategy'].includes(state)) {
    throw new RangeError(`Unknown core-strategy state: ${state}`)
  }
  const plan = strategyPlan(state)
  const freshDecisionValue = freshDecision(plan)
  const reuseDecisionValue = reuseDecision()
  const fresh = toPermissionCopy('fresh-grant', freshDecisionValue)
  const reuse = toPermissionCopy('stellar-reuse-verified', reuseDecisionValue)
  const reuseUnavailable = toPermissionCopy('stellar-reuse-verified', {
    mode: 'reuse',
    confirmationCount: 0,
  })
  const rejected = {
    ...fresh,
    status: 'Rejected',
    copy: 'The wallet rejected this fresh grant request.',
  }
  const selectedPermission =
    state === 'permission-fresh'
      ? fresh
      : state === 'permission-reuse-verified'
        ? reuse
        : state === 'permission-rejected'
          ? rejected
          : state === 'permission-reuse-unavailable'
            ? reuseUnavailable
            : null
  const permissionDecision =
    state === 'permission-reuse-verified'
      ? reuseDecisionValue
      : state === 'permission-reuse-unavailable'
        ? { mode: 'reuse', confirmationCount: 0 }
        : freshDecisionValue
  const events = strategyEvents(state, plan)
  const receipt = strategyReceipt(state, plan, permissionDecision)
  const stage = ['plan', 'yield-unavailable'].includes(state)
    ? 'plan'
    : [
          'protect',
          'permission-fresh',
          'permission-reuse-verified',
          'permission-rejected',
          'permission-reuse-unavailable',
        ].includes(state)
      ? 'protect'
      : 'start'
  const eventPhase =
    state === 'queued'
      ? 'queued'
      : state === 'partial'
        ? 'depositing'
        : state === 'receipt'
          ? 'done'
          : state === 'base-custody'
            ? 'confirmed'
            : state === 'in-transit'
              ? 'in-transit'
              : null
  const progress =
    state === 'queued'
      ? 0
      : state === 'partial'
        ? 66
        : ['receipt', 'base-custody'].includes(state)
          ? 100
          : null
  const serializable = {
    id: 'core-strategy',
    state,
    route: '/strategy',
    displayAmount: sourceAmount('2500000000'),
    venue: 'Autofarm Vault → Blend Capital v2',
    baseDisclosure: 'Base Sepolia proxy. Custody only. No protocol yield.',
    states: CORE_FIXTURE_STATES['core-strategy'],
  }
  const venue = toLiveVenueView({
    venueKind: 'stellar-live',
    chain: 'stellar',
    yield:
      state === 'yield-unavailable'
        ? { state: 'unavailable' }
        : {
            state: 'live',
            apy: 4.8,
            asOf: CORE_FIXTURE_CLOCK.checkedAtIso,
            source: 'defillama',
            checkedAt: CORE_FIXTURE_CLOCK.checkedAtIso,
          },
  })
  const createProps = () =>
    deepFreeze({
      stage,
      reached: stage === 'plan' ? ['plan'] : ['plan', 'protect', 'start'],
      eventPhase,
      progress,
      events,
      receipt,
      permission: permissionDecision,
      permissionDecision,
      plan,
      runId: CORE_FIXTURE_RUN,
      stellarVenue: venue,
      base: { connected: false, healthy: null, mandateView: null, action: null },
      onGenerate: async () => undefined,
      onRetryLive: async () => undefined,
      onAcceptPlan: () => undefined,
      onConnectForBase: () => undefined,
      onSetupBase: () => undefined,
      onRebuildPlan: () => undefined,
      protectProps: {
        owner: CORE_FIXTURE_ADDRESSES.stellarOwner,
        onConnectWallet: async () => CORE_FIXTURE_ADDRESSES.stellarOwner,
        onRetryPreflight: async () => permissionDecision,
        onRequestGrant:
          state === 'permission-rejected'
            ? async () => {
                throw new Error('User declined the request.')
              }
            : async () => ({ agentAddresses: [CORE_FIXTURE_ADDRESSES.agentA] }),
        onConfirmReuse: async () => ({ agentAddresses: [CORE_FIXTURE_ADDRESSES.agentA] }),
        onEditPlan: () => undefined,
      },
      startProps: {
        permission: permissionDecision,
        events,
        receipt,
        runId: CORE_FIXTURE_RUN,
        onViewMoney: () => undefined,
        onViewCrew: () => undefined,
        onMakeAnotherDeposit: () => undefined,
      },
    })
  return deepFreeze({
    id: 'core-strategy',
    cap: 'CAP-09',
    route: '/strategy',
    state,
    states: CORE_FIXTURE_STATES['core-strategy'],
    clock: CORE_FIXTURE_CLOCK,
    readers: createCoreFixtureReaders,
    stage,
    eventPhase,
    progress,
    receipt: null,
    receiptState: receipt ? 'settled' : 'unresolved',
    eventSummary: { count: events.length, phase: eventPhase },
    permissionSummary: {
      fresh: toPermissionCopy('fresh-grant', { mode: 'fresh', confirmationCount: 1 }),
      reuse,
      reuseUnavailable,
      rejected,
      selected: selectedPermission,
    },
    venue,
    createProps,
    mountProps: createProps,
    serializable,
  })
}

function crewSource(state) {
  const unknown = state === 'unknown'
  const cancelled = state === 'cancelled'
  const stable = state === 'stable-child-marks'
  const addresses = stable
    ? [CORE_FIXTURE_ADDRESSES.agentA, CORE_FIXTURE_ADDRESSES.agentB]
    : [CORE_FIXTURE_ADDRESSES.agentA]
  const agents = addresses.map((address, index) => ({
    address,
    scope: { value: { revoked: cancelled, vault: CORE_FIXTURE_ADDRESSES.vault }, state: 'known' },
    amount: sourceAmount(index === 0 ? '1250000000' : '750000000'),
    custody: { location: 'stellar-vault' },
    custodyBreakdown: [
      {
        location: 'stellar-vault',
        amount: sourceAmount(index === 0 ? '1250000000' : '750000000'),
      },
    ],
    problems: [],
    executionStatus: cancelled ? 'idle' : 'succeeded',
  }))
  const discoveryAgents = addresses.map((address, index) => ({
    address,
    allocationId: `${CORE_FIXTURE_RUN}:deposit:${index}`,
    runId: CORE_FIXTURE_RUN,
    runOrdinal: index,
    creator: CORE_FIXTURE_ADDRESSES.stellarOwner,
    // Unchanged production interface exception: personas.js requires createdLedger to be a
    // Number.isSafeInteger for indexed identity assignment/sorting.
    createdLedger: Number(CORE_FIXTURE_CLOCK.confirmedLedger) + index,
    createdTxHash: CORE_FIXTURE_HASHES.stellar,
    verified: !unknown,
    phase: 'deployed',
    source: 'creation-event',
    provenance: {
      source: 'router-event',
      providerId: 'core-fixture',
      endpointClass: 'fixture',
      generation: 'core-fixture-v1',
    },
  }))
  const moneyRead = {
    status: 'complete',
    agents,
    baseGroups: [],
    associationCoverage: { state: 'complete' },
    baseSourceCoverage: { state: 'complete' },
    basePositionCoverage: { state: 'complete' },
  }
  return {
    discovery: {
      status: state === 'empty' ? 'complete' : 'complete',
      networkId: 'stellar-testnet',
      agents: state === 'empty' ? [] : discoveryAgents,
    },
    moneyRead: state === 'empty' ? { ...moneyRead, agents: [] } : moneyRead,
    moneyAgents: state === 'empty' ? [] : agents,
  }
}

function crewProtection(state) {
  if (state === 'unknown') return null
  const nowSeconds = Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000)
  return {
    state: state === 'empty' || state === 'cancelled' ? 'disarmed' : 'armed',
    authority: CORE_FIXTURE_ADDRESSES.stellarOwner,
    ownerIsAuthority: true,
    mandateExpiry:
      state === 'alarm-only'
        ? nowSeconds - 60
        : state === 'empty'
          ? nowSeconds - 60
          : nowSeconds + 86_400,
    source: 'vault-protection-read',
    checkedAt: CORE_FIXTURE_CLOCK.checkedAtMs,
  }
}

function crewKeeper(state) {
  return {
    label:
      state === 'armed' || state === 'stable-child-marks'
        ? 'healthy'
        : state === 'alarm-only'
          ? 'stale'
          : 'unavailable',
    lastHeartbeatAt:
      state === 'armed' || state === 'stable-child-marks' ? CORE_FIXTURE_CLOCK.checkedAtMs : null,
    source: 'keeper-events',
    checkedAt: CORE_FIXTURE_CLOCK.checkedAtMs,
  }
}

function crewKeeperEvents(state) {
  if (!['armed', 'stable-child-marks'].includes(state)) return []
  return [
    {
      id: `${CORE_FIXTURE_RUN}:keeper:compound`,
      kind: 'compound_executed',
      totalGainUsdc: '1.25',
      txHash: `0x${'55'.repeat(32)}`,
      closedAt: CORE_FIXTURE_CLOCK.checkedAtMs,
    },
    {
      id: `${CORE_FIXTURE_RUN}:keeper:rebalance`,
      kind: 'rebalance_executed',
      amountUsdc: '0.50',
      fromLabel: 'Blend v2',
      toLabel: 'Autofarm Vault',
      txHash: `0x${'66'.repeat(32)}`,
      closedAt: CORE_FIXTURE_CLOCK.checkedAtMs - 60_000,
    },
  ]
}

function crewDecisions(state) {
  if (!['armed', 'stable-child-marks'].includes(state)) return []
  return [
    {
      id: `${CORE_FIXTURE_RUN}:decision:1`,
      tone: 'kept',
      title: 'Keep Blend v2 allocation',
      detail: 'Council kept the live Stellar yield venue after the eligibility check.',
      time: CORE_FIXTURE_CLOCK.checkedAtIso,
    },
  ]
}

export function buildCoreCrewFixture(state = 'armed') {
  if (!CORE_FIXTURE_STATES['core-crew'].includes(state)) {
    throw new RangeError(`Unknown core-crew state: ${state}`)
  }
  const source = crewSource(state)
  const crew = buildCrewPersonas(source)
  const children = [
    ...crew.personas.flatMap((persona) => persona.children),
    ...crew.pendingAssignments,
  ]
  const protection = crewProtection(state)
  const keeper = crewKeeper(state)
  const keeperEvents = crewKeeperEvents(state)
  const decisions = crewDecisions(state)
  const model = {
    protection,
    yield: {
      venueKind: 'stellar-live',
      chain: 'stellar',
      yield: {
        state: 'live',
        apy: 4.8,
        asOf: CORE_FIXTURE_CLOCK.checkedAtIso,
        source: 'defillama',
        checkedAt: CORE_FIXTURE_CLOCK.checkedAtIso,
      },
    },
  }
  const serializable = {
    id: 'core-crew',
    state,
    route: '/agent',
    network: 'Stellar testnet',
    states: CORE_FIXTURE_STATES['core-crew'],
    childMarkSeed: 'stable account evidence',
  }
  const createProps = () =>
    deepFreeze({ crew, model, keeper, keeperEvents, decisions, nowMs: CORE_FIXTURE_CLOCK.nowMs })
  return deepFreeze({
    id: 'core-crew',
    cap: 'CAP-10',
    route: '/agent',
    state,
    states: CORE_FIXTURE_STATES['core-crew'],
    clock: CORE_FIXTURE_CLOCK,
    readers: createCoreFixtureReaders,
    keeper,
    keeperEvents,
    decisions,
    radar: {
      source: 'keeper-events',
      state: protection?.state === 'armed' ? 'armed' : (protection?.state ?? 'unknown'),
      sweepActive: state === 'armed' || state === 'stable-child-marks',
      checkedAt: CORE_FIXTURE_CLOCK.checkedAtMs,
    },
    crewSummary: {
      status: crew.status,
      productiveCount: crew.productiveAgentCount,
      activeCount: crew.activeCount,
      childCount: children.length,
    },
    createProps,
    mountProps: createProps,
    serializable,
  })
}

function mandateView(status = 'ready') {
  return {
    status,
    evidence: { stellarOwner: CORE_FIXTURE_ADDRESSES.stellarOwner },
    kernelAddress: CORE_FIXTURE_ADDRESSES.baseKernel,
    sessionKeyAddress: '0x0000000000000000000000000000000000000cc3',
    allowedActions: ['USDC transfer', 'YieldRouter deposit'],
    destination: CORE_FIXTURE_ADDRESSES.basePool,
    perCallCap: {
      usdc: '10,000',
      units: '10000000000',
      decimals: 6,
      nonCumulative: true,
      cumulative: false,
    },
    repeatedCalls: true,
    durationDays: 7,
    validUntilSeconds: Math.floor(CORE_FIXTURE_CLOCK.nowMs / 1000) + 604800,
    primaryCopy: 'Base setup uses a separate disclosed permission.',
    renewalCopy: 'Renewal creates a fresh seven-day permission window.',
    revokeCopy: 'Revoke the relayer-held copy.',
    outageCopy: 'During a relayer outage, Base is unavailable.',
  }
}

/**
 * Adapter for the production BaseMandateManager boundary. Fixture/source DTOs stay canonical
 * decimal strings; the manager's existing BigInt comparison is the only place that receives a
 * BigInt. This keeps screenshots and serialized evidence JSON-safe without changing production
 * policy semantics.
 */
export function toCoreManagerMandateView(view) {
  if (view == null) return null
  if (typeof view !== 'object' || typeof view.perCallCap?.units !== 'string') {
    throw new TypeError('mandate view must carry canonical decimal cap units')
  }
  if (!/^(0|[1-9][0-9]*)$/.test(view.perCallCap.units)) {
    throw new TypeError('mandate cap units must be canonical decimal')
  }
  return deepFreeze({
    ...view,
    perCallCap: { ...view.perCallCap, units: BigInt(view.perCallCap.units) },
  })
}

export function buildCoreSettingsFixture(state = 'default') {
  if (!CORE_FIXTURE_STATES['core-settings'].includes(state)) {
    throw new RangeError(`Unknown core-settings state: ${state}`)
  }
  const mandateStatus = state.startsWith('mandate-') ? state.replace('mandate-', '') : 'ready'
  const connected = !['mandate-disconnected'].includes(state)
  const busy = state === 'mandate-busy'
  const view = state === 'default' || state === 'wallet' ? null : mandateView(mandateStatus)
  const managerState = toBaseMandateManagerState({
    connected,
    accountEpoch: connected ? CORE_FIXTURE_RUN : null,
    capturedEpoch: connected ? CORE_FIXTURE_RUN : null,
    busy,
    mandateView: view,
  })
  const serializable = {
    id: 'core-settings',
    state,
    route: '/settings',
    deepLink: state === 'wallet' ? '/settings?tab=wallet#base-mandate' : '/settings',
    states: CORE_FIXTURE_STATES['core-settings'],
  }
  const createProps = () => {
    const managerView = toCoreManagerMandateView(view)
    return deepFreeze({
      mandateView: managerView,
      connected,
      busy,
      error: null,
      onSetup: undefined,
      onRenew: undefined,
      onRevoke: undefined,
      onRefresh: undefined,
    })
  }
  return deepFreeze({
    id: 'core-settings',
    cap: 'CAP-12',
    route: '/settings',
    state,
    states: CORE_FIXTURE_STATES['core-settings'],
    clock: CORE_FIXTURE_CLOCK,
    readers: createCoreFixtureReaders,
    mandateSummary: view
      ? {
          status: view.status,
          capUnits: view.perCallCap.units,
          capDecimals: view.perCallCap.decimals,
          repeatedCalls: view.repeatedCalls,
        }
      : null,
    managerSummary: { state: managerState.state },
    createProps,
    mountProps: createProps,
    serializable,
  })
}

export function buildCoreDialogFixture(state = 'plan-edit') {
  if (!CORE_FIXTURE_STATES['core-dialog'].includes(state)) {
    throw new RangeError(`Unknown core-dialog state: ${state}`)
  }
  const serializable = {
    id: 'core-dialog',
    state,
    route: 'cross-route-dialogs',
    callers: ['Strategy Plan', 'My Money Withdraw', 'Stop access', 'Recovery', 'Settings clear'],
    states: CORE_FIXTURE_STATES['core-dialog'],
  }
  const dialog = {
    caller: state === 'settings-clear' ? 'Settings clear' : state,
    open: true,
    status: ['invalid', 'submitting', 'confirmed', 'failed', 'unknown'].includes(state)
      ? state
      : 'idle',
  }
  const createProps = () => deepFreeze({ dialog })
  return deepFreeze({
    id: 'core-dialog',
    cap: 'CAP-16',
    route: 'cross-route-dialogs',
    state,
    states: CORE_FIXTURE_STATES['core-dialog'],
    clock: CORE_FIXTURE_CLOCK,
    readers: createCoreFixtureReaders,
    dialog,
    createProps,
    mountProps: createProps,
    serializable,
  })
}

const CORE_WITHDRAW_JOB_ID = 'aabbccddeeff00112233445566778899'

function withdrawScenarioSummary(state) {
  const statusByState = {
    idle: 'idle',
    submitting: 'signing',
    relaying: 'relaying',
    polling: 'polling',
    confirmed: 'done',
    failed: 'error',
    'submission-unknown': 'submission_unknown',
    'in-transit': 'pending',
  }
  const expectedStages = {
    idle: ['idle'],
    submitting: ['reserving', 'signing'],
    relaying: ['reserving', 'signing', 'relaying'],
    polling: ['reserving', 'signing', 'relaying', 'polling'],
    confirmed: ['reserving', 'signing', 'relaying', 'polling', 'done'],
    failed: ['reserving', 'signing', 'error'],
    'submission-unknown': ['reserving', 'signing', 'submission_unknown'],
    'in-transit': ['reserving', 'signing', 'relaying', 'polling', 'pending'],
  }
  return {
    state,
    realStatus: statusByState[state],
    expectedStages: expectedStages[state],
    responseContract: {
      reserve: 'job + awaiting_burn',
      attach: 'relay_pending | relay_running | done | blocked | uncertain',
      poll: 'awaiting_burn | relay_pending | relay_running | done | blocked | uncertain | expired',
    },
  }
}

function createWithdrawSource(state) {
  const jobId = CORE_WITHDRAW_JOB_ID
  const positions = [
    {
      pool: CORE_FIXTURE_ADDRESSES.basePool,
      poolName: 'Base Sepolia proxy',
      shares: 1_000_000n,
      assets: 9_000_000n,
      minAssets: 8_900_000n,
      decimals: 6,
    },
  ]
  const idleUsdc = 1_000_000n
  const evidence = {
    evidenceStatus: 'verified',
    userOpHash: CORE_FIXTURE_HASHES.baseUserOp,
    unwindTxHash: CORE_FIXTURE_HASHES.burn,
    burned: '10000000',
    exited: '1',
    skipped: '0',
  }
  const doneProjection = {
    status: 'done',
    jobId,
    unwindTxHash: CORE_FIXTURE_HASHES.burn,
    mintTxHash: CORE_FIXTURE_HASHES.baseUserOp.slice(2),
  }
  const runningProjection = {
    status: 'relay_running',
    jobId,
    unwindTxHash: CORE_FIXTURE_HASHES.burn,
  }
  const reserve = { jobId, status: 'awaiting_burn' }
  const attach = { jobId, status: 'relay_pending', unwindTxHash: CORE_FIXTURE_HASHES.burn }
  let releaseSend = () => undefined
  let releaseAttach = () => undefined
  let releasePoll = () => undefined
  const held = (releaseValue) => {
    let resolve
    const promise = new Promise((answer) => {
      resolve = () => answer(releaseValue)
    })
    return { promise, release: () => resolve?.() }
  }
  const sendGate = state === 'submitting' ? held(evidence) : null
  const attachGate = state === 'relaying' ? held(attach) : null
  const pollGate = state === 'polling' ? held(runningProjection) : null
  releaseSend = sendGate?.release ?? releaseSend
  releaseAttach = attachGate?.release ?? releaseAttach
  releasePoll = pollGate?.release ?? releasePoll
  const adapters = {
    reserveUnwind: async () => reserve,
    signAndSubmitUnwind: async ({ onSubmitted } = {}) => {
      if (state === 'failed') throw new Error('relayer unavailable')
      if (state === 'submission-unknown') {
        const error = new Error('unwind submission status is unknown')
        error.code = 'submission_unknown'
        throw error
      }
      if (sendGate) {
        await sendGate.promise
        await onSubmitted?.(evidence.userOpHash)
        return evidence
      }
      await onSubmitted?.(evidence.userOpHash)
      return evidence
    },
    postUnwindAttach: async () => {
      if (attachGate) return attachGate.promise
      return attach
    },
    pollUnwindStatus: async () => {
      if (pollGate) return pollGate.promise
      return state === 'in-transit' || state === 'polling' ? runningProjection : doneProjection
    },
    readPositions: async () => ({ positions, idleUsdc }),
  }
  const seams = {
    reserve: adapters.reserveUnwind,
    send: adapters.signAndSubmitUnwind,
    attach: adapters.postUnwindAttach,
    poll: adapters.pollUnwindStatus,
    read: adapters.readPositions,
  }
  return {
    adapters,
    seams,
    controls: { releaseSend, releaseAttach, releasePoll },
    positions,
    idleUsdc,
    reserve,
    evidence,
    attach,
    runningProjection,
    doneProjection,
  }
}

export function buildCoreBaseWithdrawFixture(state = 'idle') {
  if (!CORE_FIXTURE_STATES['core-base-withdraw'].includes(state)) {
    throw new RangeError(`Unknown core-base-withdraw state: ${state}`)
  }
  const serializable = {
    id: 'core-base-withdraw',
    state,
    route: '/home',
    network: 'Base Sepolia',
    disclosure: 'Base Sepolia proxy. Custody only. No protocol yield.',
    states: CORE_FIXTURE_STATES['core-base-withdraw'],
  }
  const scenario = withdrawScenarioSummary(state)
  const source = createWithdrawSource(state)
  const positions = source.positions
  const idleUsdc = source.idleUsdc
  const createProps = () =>
    deepFreeze({
      ownerKernelAccount: { address: CORE_FIXTURE_ADDRESSES.baseKernel },
      publicClient: {},
      positions,
      idleUsdc,
      stellarRecipient: CORE_FIXTURE_ADDRESSES.stellarOwner,
      withdrawAdapters: source.adapters,
      seams: source.seams,
      readPositions: source.adapters.readPositions,
      controls: source.controls,
    })
  const createAdapters = () => deepFreeze(source.adapters)
  return deepFreeze({
    id: 'core-base-withdraw',
    cap: 'CAP-18',
    route: '/home',
    state,
    states: CORE_FIXTURE_STATES['core-base-withdraw'],
    clock: CORE_FIXTURE_CLOCK,
    readers: createCoreFixtureReaders,
    withdrawScenario: { ...scenario, createAdapters },
    positionSummary: { count: positions.length, idleUnits: idleUsdc.toString() },
    createProps,
    mountProps: createProps,
    serializable,
  })
}

// Stable aliases keep the fixture seam readable at call sites that organize by route rather than
// CAP id. They point to the same builders and do not create another fixture registry.
export const buildMoneyFixture = buildCoreMoneyFixture
export const buildStrategyFixture = buildCoreStrategyFixture
export const buildCrewFixture = buildCoreCrewFixture
export const buildSettingsFixture = buildCoreSettingsFixture
export const buildDialogFixture = buildCoreDialogFixture
export const buildBaseWithdrawFixture = buildCoreBaseWithdrawFixture
