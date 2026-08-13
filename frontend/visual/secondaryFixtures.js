// Deterministic, display-only inputs for the Secondary route atlas.
//
// This module is intentionally boring: it contains frozen presentation data and synchronous
// loaders only. Production readers stay in their route components; the visual entrypoint injects
// these values at the composition boundary. Identity-looking strings below are text evidence,
// never credentials or authority records.

import { createEcosystemModel } from '../src/secondary/ecosystemModel.js'

const deepFreeze = (value, seen = new WeakSet()) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  if (seen.has(value)) return value
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

export const SECONDARY_NOW = '2026-08-11T00:00:00.000Z'
export const SECONDARY_NOW_MS = 1786406400000
export const SECONDARY_CHECKED_AT = '2026-08-10T23:59:00.000Z'
export const SECONDARY_STALE_CHECKED_AT = '2026-08-01T00:00:00.000Z'
export const SECONDARY_STALE_AFTER_MS = 86400000
export const SECONDARY_LEDGER = '12345'
export const SECONDARY_BLOCK = '67890'
export const SECONDARY_FIXTURE_CLOCK = deepFreeze({
  nowIso: SECONDARY_NOW,
  nowMs: SECONDARY_NOW_MS,
  checkedAtIso: SECONDARY_CHECKED_AT,
  confirmedLedger: SECONDARY_LEDGER,
  confirmedBlock: SECONDARY_BLOCK,
})

export const STELLAR_G_FIXTURE = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
export const STELLAR_C_FIXTURES = Object.freeze([
  'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC',
  'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J',
  'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77',
  'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU',
])
export const BASE_HEX_FIXTURES = Object.freeze([
  '0x0000000000000000000000000000000000000aa1',
  '0x00000000000000000000000000000000000000b2',
])

export const SECONDARY_AMOUNTS = deepFreeze({
  balance: { token: 'USDC', units: '1250000000', decimals: 7 },
  smallerBalance: { token: 'USDC', units: '450000000', decimals: 7 },
  requestCap: { token: 'requests', units: '60000', decimals: 0 },
})
export const SECONDARY_CANONICAL_AMOUNTS = SECONDARY_AMOUNTS

const states = Object.freeze([
  'loading',
  'current',
  'stale',
  'empty',
  'partial',
  'error',
  'unavailable',
])

export const SECONDARY_FIXTURE_STATES = deepFreeze(
  Object.fromEntries(
    states.map((state) => [
      state,
      Object.freeze({
        state,
        source: state === 'unavailable' ? null : 'secondary-fixture',
        checkedAt:
          state === 'loading' || state === 'empty' || state === 'error' || state === 'unavailable'
            ? null
            : state === 'stale'
              ? SECONDARY_STALE_CHECKED_AT
              : SECONDARY_CHECKED_AT,
        staleAfterMs: SECONDARY_STALE_AFTER_MS,
        confirmedLedger: ['current', 'stale'].includes(state) ? SECONDARY_LEDGER : null,
        confirmedBlock: ['current', 'stale'].includes(state) ? SECONDARY_BLOCK : null,
      }),
    ])
  )
)

export const SECONDARY_FACT_METADATA = deepFreeze({
  source: 'secondary-fixture',
  checkedAt: SECONDARY_CHECKED_AT,
  staleAfterMs: SECONDARY_STALE_AFTER_MS,
  confirmedLedger: SECONDARY_LEDGER,
  confirmedBlock: SECONDARY_BLOCK,
})

const factFor = (state, value = null) => ({
  ...SECONDARY_FIXTURE_STATES[state],
  value,
})

const vaultRows = Object.freeze([
  Object.freeze({ name: 'Autofarm Vault', protocol: 'blend-usdc', apy: 4.8, poolId: null }),
  Object.freeze({ name: 'Blend Capital v2', protocol: 'blend-v2', apy: 4.8, poolId: null }),
])

const replayGround = Object.freeze({
  amountInUsdc: 1000000,
  depegDate: '2023-03-11',
})

const replayMonteCarlo = Object.freeze({
  label: 'Pinned historical replay',
  seed: 20230311,
  manual: Object.freeze({
    p5: '950000000000000000',
    p50: '1000000000000000000',
    p95: '1050000000000000000',
  }),
  agentic: Object.freeze({ deterministic: '1100000000000000000' }),
  assumptions: Object.freeze({
    groundTruthSource: 'Pinned mainnet fork',
    manualDelay: 'Five reaction-delay samples',
    agenticDelay: 'First block after signal',
    iterations: 1000,
  }),
  provenance: Object.freeze({ signalBlock: 16800000, chainId: 1, depegDate: '2023-03-11' }),
})

const transactionRow = Object.freeze({
  type: 'transaction',
  txHash: 'a1b2c3d4'.repeat(8),
  vaultName: 'Autofarm Vault',
  protocol: 'blend-usdc',
  amountUsdc: '125.000000',
  apy: 4.8,
  workerLabel: 'Worker 1',
  gasPayedBy: 'fee-bump-relayer',
  network: 'stellar-testnet',
  status: 'confirmed',
  timestamp: SECONDARY_NOW_MS - 60000,
  verified: true,
  source: Object.freeze({ verified: true, hash: 'a1b2c3d4'.repeat(8) }),
})

const strategyRow = Object.freeze({
  type: 'strategy',
  strategyHash: `0x${'22'.repeat(32)}`,
  amountUsdc: '125.000000',
  riskLevel: 'low',
  strategySource: 'deterministic',
  vaultsSelected: Object.freeze([
    Object.freeze({ protocol: 'blend-usdc', name: 'Autofarm Vault' }),
  ]),
  timestamp: SECONDARY_NOW_MS - 120000,
})

const reasoningRow = Object.freeze({
  type: 'reasoning',
  vaultName: 'Autofarm Vault',
  protocol: 'blend-usdc',
  riskTier: 'low',
  yieldSource: 'lending',
  reasoning: 'The source-backed Stellar venue remains inside the selected risk limit.',
  expectedApy: 4.8,
  amountUsdc: '125.000000',
  riskLevel: 'low',
  modelUsed: 'deterministic',
  timestamp: SECONDARY_NOW_MS - 180000,
})

const baseActivityRow = Object.freeze({
  hash: `0x${'33'.repeat(32)}`,
  time: SECONDARY_NOW_MS - 240000,
  symbol: 'USDC',
  amount: 12.5,
  direction: 'in',
})

const developerKey = Object.freeze({
  id: 'fixture-key-1',
  key_hint: 'vf_test_ab12…',
  scopes: Object.freeze(['market', 'scan']),
  enabled: true,
  rate_limit: 60,
  created_at: '2026-08-01T00:00:00.000Z',
  expires_at: null,
})

const usageData = Object.freeze({
  usage: Object.freeze([Object.freeze({ key_id: 'fixture-key-1', day: '2026-08-11', count: 7 })]),
  cap: SECONDARY_AMOUNTS.requestCap,
  sinceDay: '2026-08-01',
})

const routePayload = (route, state) => {
  const amount = ['current', 'stale', 'partial'].includes(state) ? SECONDARY_AMOUNTS.balance : null
  const fact = factFor(state, amount)

  switch (route) {
    case 'landing':
      return { fact }
    case 'onboarding':
      return { fact, vaults: vaultRows, histories: Object.freeze({}) }
    case 'explorer':
      return {
        fact,
        amount,
        totalAssets: amount,
        facts: {
          totalAssets: factFor(state, amount),
          attestations: factFor(state, state === 'empty' ? null : null),
        },
        strategies: state === 'empty' || state === 'unavailable' ? [] : [strategyRow],
        onchain: Object.freeze([]),
      }
    case 'ecosystem':
      return {
        fact,
        cards: createEcosystemModel({ state }).cards,
        deployment: 'testnet',
        source: 'catalog',
        checkedAt: fact.checkedAt,
        staleAfterMs: fact.staleAfterMs,
      }
    case 'replay':
      return {
        fact,
        ground: ['current', 'stale'].includes(state) ? replayGround : null,
        mc: ['current', 'stale'].includes(state) ? replayMonteCarlo : null,
        error: state === 'error' ? 'Replay payload could not be verified.' : null,
      }
    case 'history':
      return {
        fact,
        facts: {
          transactions: factFor(state, amount),
          base: factFor(state, amount),
          strategies: factFor(state, amount),
          reasoning: factFor(state, null),
        },
        transactions: state === 'empty' || state === 'unavailable' ? [] : [transactionRow],
        baseRows: state === 'empty' || state === 'unavailable' ? [] : [baseActivityRow],
        strategies: state === 'empty' || state === 'unavailable' ? [] : [strategyRow],
        reasoning: state === 'empty' || state === 'unavailable' ? [] : [reasoningRow],
        baseLoading: state === 'loading',
      }
    case 'vault':
      return {
        fact,
        amount,
        facts: { tvl: factFor(state, amount), apy: factFor(state, amount) },
        venue: {
          venueKind: 'stellar-live',
          chain: 'stellar',
          yield: {
            state: ['current', 'stale'].includes(state) ? 'live' : 'unavailable',
            apy: ['current', 'stale'].includes(state) ? 4.8 : null,
            source: 'secondary-fixture',
            asOf: SECONDARY_CHECKED_AT,
            checkedAt: SECONDARY_CHECKED_AT,
          },
        },
        apyStats: ['current', 'stale'].includes(state)
          ? {
              values: [4.2, 4.4, 4.6, 4.8],
              avg7d: 4.5,
              current: 4.8,
              change7d: '+0.6%',
            }
          : null,
      }
    case 'tx':
      return { fact, amount, source: 'local-device' }
    case 'developers':
    case 'developer-keys':
    case 'developer-usage':
    case 'developer-docs':
      return {
        fact,
        facts: {
          overview: factFor(state, null),
          keys: factFor(state, null),
          usage: factFor(state, null),
          cap: factFor(state, SECONDARY_AMOUNTS.requestCap),
        },
        stats: { activeKeys: 1, today: 7 },
        keys: state === 'empty' || state === 'unavailable' ? [] : [developerKey],
        usage: usageData,
        data: usageData,
      }
    case 'skill-drawer':
    case 'dev-panel':
      return { fact, source: 'local-device' }
    default:
      throw new RangeError(`Unknown Secondary fixture route: ${route}`)
  }
}

const payloads = Object.fromEntries(
  [
    'landing',
    'onboarding',
    'explorer',
    'ecosystem',
    'replay',
    'history',
    'vault',
    'tx',
    'developers',
    'developer-keys',
    'developer-usage',
    'developer-docs',
    'skill-drawer',
    'dev-panel',
  ].map((route) => [
    route,
    Object.fromEntries(states.map((state) => [state, routePayload(route, state)])),
  ])
)

export const SECONDARY_FIXTURE_PAYLOADS = deepFreeze(payloads)

export const SECONDARY_OWNED_CLASSES = Object.freeze([
  'CAP-02',
  'CAP-03',
  'CAP-04',
  'CAP-05',
  'CAP-06',
  'CAP-07',
  'CAP-11',
  'CAP-13',
  'CAP-14',
  'CAP-15',
  'CAP-17',
  'CAP-19',
])

export const SECONDARY_ROUTE_FIXTURES = deepFreeze({
  landing: { cap: 'CAP-02', route: 'landing', payloadRoute: 'landing' },
  onboarding: { cap: 'CAP-03', route: 'onboarding', payloadRoute: 'onboarding' },
  explorer: { cap: 'CAP-04', route: 'explorer', payloadRoute: 'explorer' },
  ecosystem: { cap: 'CAP-05', route: 'ecosystem', payloadRoute: 'ecosystem' },
  replay: { cap: 'CAP-06', route: 'replay', payloadRoute: 'replay' },
  history: { cap: 'CAP-11', route: 'history', payloadRoute: 'history' },
  vault: { cap: 'CAP-13', route: 'vault', payloadRoute: 'vault' },
  tx: { cap: 'CAP-14', route: 'tx', payloadRoute: 'tx' },
  developers: { cap: 'CAP-15', route: 'developers', payloadRoute: 'developers' },
  'developer-keys': { cap: 'CAP-15', route: 'developers', payloadRoute: 'developers' },
  'developer-usage': { cap: 'CAP-15', route: 'developers', payloadRoute: 'developers' },
  'developer-docs': { cap: 'CAP-15', route: 'developers', payloadRoute: 'developers' },
  'skill-drawer': { cap: 'CAP-17', route: 'skill-drawer', payloadRoute: 'skill-drawer' },
  'dev-panel': { cap: 'CAP-19', route: 'dev-panel', payloadRoute: 'dev-panel' },
})

export const SECONDARY_CLASS_ROUTES = deepFreeze({
  'CAP-02': 'landing',
  'CAP-03': 'onboarding',
  'CAP-04': 'explorer',
  'CAP-05': 'ecosystem',
  'CAP-06': 'replay',
  // CAP-07 is the unauthenticated compatibility class; it reuses the public landing composition.
  'CAP-07': 'landing',
  'CAP-11': 'history',
  'CAP-13': 'vault',
  'CAP-14': 'tx',
  'CAP-15': 'developers',
  'CAP-17': 'skill-drawer',
  'CAP-19': 'dev-panel',
})

export function secondaryPayload(route, state = 'current') {
  const entry = SECONDARY_FIXTURE_PAYLOADS[route]
  if (!entry || !entry[state]) throw new RangeError(`Unknown Secondary fixture: ${route}/${state}`)
  return entry[state]
}

export function createSecondaryLoader(route, state = 'current') {
  const payload = secondaryPayload(route, state)
  return () => payload
}

export function createSecondaryLoaders(state = 'current') {
  const loaders = Object.fromEntries(
    Object.keys(SECONDARY_FIXTURE_PAYLOADS).map((route) => [
      route,
      createSecondaryLoader(route, state),
    ])
  )
  return deepFreeze(loaders)
}

export const SECONDARY_LOADERS = deepFreeze(createSecondaryLoaders())

export const loadOnboardingFixture = deepFreeze(createSecondaryLoader('onboarding'))
export const loadExplorerFixture = deepFreeze(createSecondaryLoader('explorer'))
export const loadEcosystemFixture = deepFreeze(createSecondaryLoader('ecosystem'))
export const loadReplayFixture = deepFreeze(createSecondaryLoader('replay'))
export const loadHistoryFixture = deepFreeze(createSecondaryLoader('history'))
export const loadVaultFixture = deepFreeze(createSecondaryLoader('vault'))
export const loadTxFixture = deepFreeze(createSecondaryLoader('tx'))
export const loadDevelopersFixture = deepFreeze(createSecondaryLoader('developers'))
