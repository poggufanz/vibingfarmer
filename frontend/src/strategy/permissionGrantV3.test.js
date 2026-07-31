// frontend/src/strategy/permissionGrantV3.test.js — IQ Alter remediation Task 5. The reviewed,
// BOUNDED Router V3 permission: an explicit cumulative ceiling (defaulting to exactly the planned
// movement, so a first run leaves ZERO repeat headroom), an absolute ledger expiry serialized once
// from a fresh ledger read, a run-independent scope identity, deterministic per-allocation
// execution IDs, and an all-or-nothing on-chain proof that forces fresh on any doubt.
//
// Router V3 is NOT deployed. `resolveRouterSchema` knows no V3 address, so the production default
// makes `proveReusablePermission` force fresh before it reads anything — the dormancy contract
// Task 4 established. These tests inject a schema resolver to exercise the live-V3 path.
import { describe, test, expect, vi } from 'vitest'
import {
  buildReusableApproval,
  buildScopeId,
  makeAllocationExecution,
  proveReusablePermission,
  scopeFieldsFromAgents,
  PERMISSION_POLICY_VERSION,
} from './permissionGrantV3.js'
import { resolveRouterSchema } from '../stellar/routerSchema.js'
import { AGENT_KIND_DEPOSIT, AGENT_KIND_BRIDGE } from '../stellar/grant.js'
import { classifyActiveAccount } from '../stellar/activeAccount.js'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const OWNER_2 = 'GDP5XLVDKWCHX2QNJH3XRKUFNHM47KLU3MITVT7BDPWJL2QLY2X3VKLU'
const ROUTER_V2 = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
// Shape-valid contract id standing in for a future deployed V3 router. Deliberately NOT added to
// ROUTER_SCHEMAS — the dormancy contract at routerSchema.js:47-54 forbids inventing an address.
const ROUTER_V3 = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const VAULT = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const VAULT_2 = 'CBEI5VJKKWLXKQUUUETBAPZSQQLH7I57TSIDTMV4WJMBKIGVF7NSNOFY'
const TOKEN = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
const TOKEN_2 = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_2 = 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J'
const SIGNER_PUB = 'GA2CMBS3LRY5MH64KKMHOYVA6WTLPMKRMIWEJDOIGHYPB7WMC3QHRCBU'
const SIGNER_PUB_2 = 'GB4XNXQEDPRU7FJTSM2DDDCQ5DRZSLEDG67PIQZC6CV6ZB7TM3UZ6SXQ'
const CODE_HASH = '0x' + 'c0de'.repeat(16)
const CODE_HASH_2 = '0x' + 'beef'.repeat(16)
const PERMISSION_ID = '0x' + '11'.repeat(32)

const DAY = 86_400
const WEEK = 604_800
const LEDGER_NOW = 1_400_000
const SECONDS_PER_LEDGER = 5
const NOW = 1_800_000_000

const HEX32 = /^0x[0-9a-f]{64}$/

// Every string that must be rejected as an asset-unit value. Units are bigint-safe canonical
// decimal integers everywhere in this codebase (Task 11) — no signs, no exponent, no fraction, no
// leading zero, no whitespace, no hex.
const INVALID_UNIT_STRINGS = [
  ['empty', ''],
  ['fractional', '12.5'],
  ['exponent', '1e10'],
  ['negative', '-5'],
  ['explicit plus', '+100'],
  ['leading space', ' 100'],
  ['trailing space', '100 '],
  ['hex', '0x10'],
  ['leading zero', '0100'],
  ['thousands separator', '1_000'],
  ['comma grouped', '1,000'],
  ['number not string', 100],
  ['bigint not string', 100n],
  ['null', null],
  ['undefined', undefined],
]

// --- buildReusableApproval -------------------------------------------------------------------

describe('buildReusableApproval — the reviewed ceiling and its absolute ledger expiry', () => {
  const base = {
    plannedUnitsNow: '100000000',
    currentLedger: LEDGER_NOW,
    durationSeconds: DAY,
    secondsPerLedger: SECONDS_PER_LEDGER,
  }

  test('defaults mandateCeilingUnits to plannedUnitsNow byte-for-byte', () => {
    const approval = buildReusableApproval({ ...base })
    expect(approval.mandateCeilingUnits).toBe(base.plannedUnitsNow)
    // Byte-for-byte, not merely numerically equal: an implicit buffer, a re-serialization through
    // Number, or any rounding would break string identity while passing a BigInt comparison.
    expect(approval.mandateCeilingUnits === approval.plannedUnitsNow).toBe(true)
  })

  test('the default ceiling leaves ZERO repeat headroom once the run is spent', () => {
    const approval = buildReusableApproval({ ...base })
    const headroom = BigInt(approval.mandateCeilingUnits) - BigInt(approval.plannedUnitsNow)
    expect(headroom).toBe(0n)
  })

  test('honors an explicit ceiling above plannedUnitsNow — raising exposure is a deliberate edit', () => {
    const approval = buildReusableApproval({ ...base, mandateCeilingUnits: '250000000' })
    expect(approval.mandateCeilingUnits).toBe('250000000')
    expect(BigInt(approval.mandateCeilingUnits) - BigInt(approval.plannedUnitsNow)).toBe(150000000n)
  })

  test('rejects a ceiling below plannedUnitsNow', () => {
    expect(() =>
      buildReusableApproval({ ...base, plannedUnitsNow: '1000', mandateCeilingUnits: '999' })
    ).toThrow(/ceiling/i)
  })

  test('rejects a ceiling below plannedUnitsNow beyond Number precision', () => {
    // 2^53 boundary: these two differ by 1 but are indistinguishable as Numbers.
    expect(() =>
      buildReusableApproval({
        ...base,
        plannedUnitsNow: '9007199254740993',
        mandateCeilingUnits: '9007199254740992',
      })
    ).toThrow(/ceiling/i)
  })

  test.each(INVALID_UNIT_STRINGS)('rejects plannedUnitsNow — %s', (_label, value) => {
    expect(() => buildReusableApproval({ ...base, plannedUnitsNow: value })).toThrow()
  })

  // `undefined` is excluded deliberately: it triggers the JS default parameter, which is the
  // documented "defaults to plannedUnitsNow" behaviour pinned by the first test in this block.
  test.each(INVALID_UNIT_STRINGS.filter(([label]) => label !== 'undefined'))(
    'rejects an explicit mandateCeilingUnits — %s',
    (_label, value) => {
      expect(() => buildReusableApproval({ ...base, mandateCeilingUnits: value })).toThrow()
    }
  )

  test.each([
    ['one hour', 3600],
    ['zero', 0],
    ['negative day', -86_400],
    ['two days', 172_800],
    ['a second past a week', 604_801],
    ['undefined', undefined],
    ['NaN', NaN],
    ['string day', '86400'],
  ])('rejects durationSeconds — %s (only 24h and 7d exist)', (_label, value) => {
    expect(() => buildReusableApproval({ ...base, durationSeconds: value })).toThrow(/duration/i)
  })

  test('serializes an absolute liveUntilLedger for the 24h selection', () => {
    const approval = buildReusableApproval({ ...base, durationSeconds: DAY })
    expect(approval.liveUntilLedger).toBe(LEDGER_NOW + Math.ceil(DAY / SECONDS_PER_LEDGER))
    expect(approval.durationSeconds).toBe(DAY)
  })

  test('serializes an absolute liveUntilLedger for the 7d selection', () => {
    const approval = buildReusableApproval({ ...base, durationSeconds: WEEK })
    expect(approval.liveUntilLedger).toBe(LEDGER_NOW + Math.ceil(WEEK / SECONDS_PER_LEDGER))
    expect(approval.durationSeconds).toBe(WEEK)
  })

  test('tracks the caller-supplied ledger — the ledger is read fresh, never cached in the module', () => {
    const early = buildReusableApproval({ ...base, currentLedger: LEDGER_NOW })
    const later = buildReusableApproval({ ...base, currentLedger: LEDGER_NOW + 1000 })
    expect(later.liveUntilLedger - early.liveUntilLedger).toBe(1000)
  })

  test('is pure — identical inputs give an identical absolute expiry, with no wall clock involved', () => {
    const a = buildReusableApproval({ ...base })
    const b = buildReusableApproval({ ...base })
    expect(b).toEqual(a)
  })

  test.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['string', '5'],
  ])('rejects secondsPerLedger — %s', (_label, value) => {
    expect(() => buildReusableApproval({ ...base, secondsPerLedger: value })).toThrow(/ledger/i)
  })

  test.each([
    ['negative', -1],
    ['fractional', 1_400_000.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['string', '1400000'],
  ])('rejects currentLedger — %s', (_label, value) => {
    expect(() => buildReusableApproval({ ...base, currentLedger: value })).toThrow(/ledger/i)
  })

  test('carries exactly the reviewed fields, and is frozen so nothing recomputes it after review', () => {
    const approval = buildReusableApproval({ ...base })
    expect(Object.keys(approval).sort()).toEqual(
      [
        'currentLedger',
        'durationSeconds',
        'liveUntilLedger',
        'mandateCeilingUnits',
        'plannedUnitsNow',
        'secondsPerLedger',
      ].sort()
    )
    expect(Object.isFrozen(approval)).toBe(true)
  })
})

// --- buildScopeId ----------------------------------------------------------------------------

describe('buildScopeId — immutable scope identity, stable across runs', () => {
  const scope = () => ({
    network: NETWORK_PASSPHRASE,
    owner: OWNER,
    token: TOKEN,
    router: ROUTER_V3,
    agent: AGENT_1,
    code: CODE_HASH,
    signer: SIGNER_PUB,
    targetAllowlist: [VAULT],
    perRunCapUnits: '100000000',
    cumulativeCapUnits: '100000000',
    policyVersion: 3,
  })

  test('is a 0x-prefixed sha256 hex string', () => {
    expect(buildScopeId(scope())).toMatch(HEX32)
  })

  test.each([
    ['runId', { runId: 'run-2' }],
    ['timestamp', { timestamp: NOW }],
    ['createdAt', { createdAt: NOW }],
    ['allocationId', { allocationId: 'run-1:deposit:3' }],
    ['checkedAt', { checkedAt: NOW }],
  ])('ignores %s — the same scope in two different runs is the same scope', (_label, extra) => {
    expect(buildScopeId({ ...scope(), ...extra })).toBe(buildScopeId(scope()))
  })

  test('ignores target allowlist ORDER — a reordered, unchanged allowlist is the same scope', () => {
    const a = buildScopeId({ ...scope(), targetAllowlist: [VAULT, VAULT_2] })
    const b = buildScopeId({ ...scope(), targetAllowlist: [VAULT_2, VAULT] })
    expect(b).toBe(a)
  })

  test.each([
    ['network', { network: 'Other Network ; 2026' }],
    ['owner', { owner: OWNER_2 }],
    ['token', { token: TOKEN_2 }],
    ['router', { router: ROUTER_V2 }],
    ['agent', { agent: AGENT_2 }],
    ['code', { code: CODE_HASH_2 }],
    ['signer', { signer: SIGNER_PUB_2 }],
    ['target allowlist content', { targetAllowlist: [VAULT_2] }],
    ['per-run cap', { perRunCapUnits: '100000001' }],
    ['cumulative cap', { cumulativeCapUnits: '250000000' }],
    ['policy version', { policyVersion: 4 }],
  ])('changes when %s changes', (_label, over) => {
    expect(buildScopeId({ ...scope(), ...over })).not.toBe(buildScopeId(scope()))
  })

  test('distinguishes caps beyond Number precision', () => {
    const a = buildScopeId({ ...scope(), cumulativeCapUnits: '9007199254740992' })
    const b = buildScopeId({ ...scope(), cumulativeCapUnits: '9007199254740993' })
    expect(b).not.toBe(a)
  })
})

// --- makeAllocationExecution -----------------------------------------------------------------

describe('makeAllocationExecution — one deterministic, replay-safe execution per allocation', () => {
  const exec = (over = {}) => ({
    runId: 'run-1',
    allocationId: 'run-1:deposit:0',
    scopeId: '0x' + 'a1'.repeat(32),
    amountUnits: '25000000',
    ...over,
  })

  test('exposes the execution and its identity', () => {
    const e = makeAllocationExecution(exec())
    expect(e).toEqual({
      executionId: expect.stringMatching(HEX32),
      runId: 'run-1',
      allocationId: 'run-1:deposit:0',
      scopeId: exec().scopeId,
      amountUnits: '25000000',
    })
  })

  // This is the money-critical property. The router's V3 replay guard records execution_id only on
  // a SUCCESSFUL pull, so re-minting the SAME id after an INDETERMINATE submission (the relay
  // dropping a response) is safe by construction: the duplicate is rejected if the first landed,
  // and succeeds if it did not. A nonce here would move real funds twice on exactly that retry,
  // and would make Task 7's "resend the identical still-valid envelope, never rebuild" recovery
  // action unimplementable.
  test('is DETERMINISTIC — the same allocation always mints the same executionId', () => {
    expect(makeAllocationExecution(exec()).executionId).toBe(
      makeAllocationExecution(exec()).executionId
    )
  })

  test.each([
    ['allocationId', { allocationId: 'run-1:deposit:1' }],
    ['runId', { runId: 'run-2' }],
    ['amountUnits', { amountUnits: '25000001' }],
    ['scopeId', { scopeId: '0x' + 'b2'.repeat(32) }],
  ])('mints a different executionId when %s differs', (_label, over) => {
    expect(makeAllocationExecution(exec(over)).executionId).not.toBe(
      makeAllocationExecution(exec()).executionId
    )
  })

  test('distinguishes amounts beyond Number precision', () => {
    const a = makeAllocationExecution(exec({ amountUnits: '9007199254740992' }))
    const b = makeAllocationExecution(exec({ amountUnits: '9007199254740993' }))
    expect(b.executionId).not.toBe(a.executionId)
  })

  test.each(INVALID_UNIT_STRINGS)('rejects amountUnits — %s', (_label, value) => {
    expect(() => makeAllocationExecution(exec({ amountUnits: value }))).toThrow()
  })

  test.each([
    ['runId', 'runId'],
    ['allocationId', 'allocationId'],
    ['scopeId', 'scopeId'],
  ])('rejects a missing %s', (_label, key) => {
    expect(() => makeAllocationExecution(exec({ [key]: undefined }))).toThrow()
  })
})

// --- proveReusablePermission -----------------------------------------------------------------

const activeAccount = (over = {}) =>
  classifyActiveAccount({
    address: OWNER,
    networkPassphrase: NETWORK_PASSPHRASE,
    connectorId: 'freighter',
    epoch: 3,
    ...over,
  })

function agentInit(over = {}) {
  return {
    allocationId: 'run-1:deposit:0',
    kind: AGENT_KIND_DEPOSIT,
    token: TOKEN,
    target: VAULT,
    cap: { token: TOKEN, units: 25_000_000n, decimals: 7 },
    periodSeconds: DAY,
    expiry: NOW + 3600,
    ...over,
  }
}

function permissionGrant(over = {}) {
  return {
    permissionId: PERMISSION_ID,
    scopeId: null, // filled per-test from buildScopeId
    owner: OWNER,
    token: TOKEN,
    mandateCeilingUnits: '100000000',
    confirmedSpentUnits: '25000000',
    perRunMaxUnits: '50000000',
    liveUntilLedger: LEDGER_NOW + 10_000,
    revoked: false,
    ...over,
  }
}

function inspectedAgent(over = {}) {
  return {
    agentAddress: AGENT_1,
    signerPub: SIGNER_PUB,
    code: CODE_HASH,
    target: VAULT,
    token: TOKEN,
    perRunCapUnits: '50000000',
    cumulativeCapUnits: '100000000',
    perExecutionMaxUnits: '50000000',
    ...over,
  }
}

function provenProof(over = {}) {
  return {
    version: 1,
    gapFree: true,
    noLaterMutation: true,
    approvals: [
      {
        amount: { token: TOKEN, units: '100000000', decimals: 7 },
        expiryLedger: LEDGER_NOW + 10_000,
      },
    ],
    latestLedger: LEDGER_NOW,
    proofHash: '0x' + 'ab'.repeat(32),
    ...over,
  }
}

function baseDeps(over = {}) {
  const inits = over.agentInits || [agentInit()]
  return {
    runId: 'run-1',
    owner: OWNER,
    router: ROUTER_V3,
    network: NETWORK_PASSPHRASE,
    planFingerprint: '0x' + 'f0'.repeat(32),
    permissionId: PERMISSION_ID,
    activeAccount: activeAccount(),
    getCurrentActiveAccount: () => activeAccount(),
    approval: buildReusableApproval({
      plannedUnitsNow: '25000000',
      mandateCeilingUnits: '100000000',
      currentLedger: LEDGER_NOW,
      durationSeconds: DAY,
      secondsPerLedger: SECONDS_PER_LEDGER,
    }),
    currentLedger: LEDGER_NOW,
    nowSec: NOW,
    server: {},
    storage: {},
    // Injected so the module never itself decides which router generation is live: the production
    // default is the real resolveRouterSchema, which knows no V3 address today.
    resolveSchema: () => ({ version: 3, tokenMode: 'reusable-permission' }),
    readPermissionGrant: vi.fn(async () => permissionGrant()),
    readRemainingBudget: vi.fn(async () => '75000000'),
    proveAllowance: vi.fn(async () => ({ proven: true, reason: null, proof: provenProof() })),
    inspectAgents: vi.fn(async () => [inspectedAgent()]),
    fetchCredential: vi.fn(() => ({ agentAddress: AGENT_1, signerPub: SIGNER_PUB })),
    ...over,
    agentInits: inits,
  }
}

// Wire the fixture's grant to the scopeId its own agent rows hash to, so the module's recomputation
// has something real to agree with. Built through the module's own projection helper (the hashing
// RULES are pinned independently by the buildScopeId block above, so this cannot hide a hash bug).
function depsWithScope(over = {}) {
  const deps = baseDeps(over)
  const rows = [inspectedAgent(), inspectedAgent({ agentAddress: AGENT_2 })].slice(
    0,
    deps.agentInits.length
  )
  const scopeId = buildScopeId({
    network: deps.network,
    owner: deps.owner,
    token: TOKEN,
    router: deps.router,
    policyVersion: PERMISSION_POLICY_VERSION,
    ...scopeFieldsFromAgents(rows),
  })
  return {
    ...deps,
    inspectAgents: over.inspectAgents || vi.fn(async () => rows),
    readPermissionGrant:
      over.readPermissionGrant ||
      vi.fn(async () => permissionGrant({ scopeId, ...(over.grantOver || {}) })),
    expectedScopeId: scopeId,
  }
}

describe('proveReusablePermission — dormancy', () => {
  test('forces fresh with ZERO chain reads when the router is not a known V3 address', async () => {
    const deps = depsWithScope({ resolveSchema: () => ({ version: 2, tokenMode: 'per-budget' }) })
    const decision = await proveReusablePermission(deps)
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('router-not-v3')
    expect(deps.readPermissionGrant).not.toHaveBeenCalled()
    expect(deps.readRemainingBudget).not.toHaveBeenCalled()
    expect(deps.proveAllowance).not.toHaveBeenCalled()
    expect(deps.inspectAgents).not.toHaveBeenCalled()
  })

  test('forces fresh when the router resolves to no schema at all', async () => {
    const deps = depsWithScope({ resolveSchema: () => null })
    const decision = await proveReusablePermission(deps)
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('router-not-v3')
  })

  test('the PRODUCTION default resolver knows no V3 router — every live address is dormant', async () => {
    // The activation trigger: registering a real deployed V3 address in ROUTER_SCHEMAS.
    for (const address of [ROUTER_V2, ROUTER_V3]) {
      expect(resolveRouterSchema(address)?.version).not.toBe(3)
    }
    const { resolveSchema: _injected, ...withProductionResolver } = depsWithScope()
    const decision = await proveReusablePermission(withProductionResolver)
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('router-not-v3')
  })
})

describe('proveReusablePermission — reuse', () => {
  test('reuses a bounded, unexpired, unrevoked permission with proven headroom', async () => {
    const decision = await proveReusablePermission(depsWithScope())
    expect(decision.mode).toBe('reuse')
    expect(decision.freshReason).toBe(null)
    expect(decision.version).toBe(3)
    expect(decision.permissionId).toBe(PERMISSION_ID)
  })

  test('reports headroom as exact bigint arithmetic, never rounded or estimated', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({
        grantOver: { mandateCeilingUnits: '9007199254740993', confirmedSpentUnits: '1' },
        readRemainingBudget: vi.fn(async () => '9007199254740992'),
      })
    )
    expect(decision.mode).toBe('reuse')
    // Every figure must survive a Number round-trip untouched: 9007199254740993 collapses to
    // ...992 as a Number, so a single Number() anywhere in this path is visible here.
    expect(decision.mandateCeilingUnits).toBe('9007199254740993')
    expect(decision.confirmedSpentUnits).toBe('1')
    expect(decision.remainingHeadroomUnits).toBe('9007199254740992')
  })

  test('is stable across runs — the same scope in a different run reuses the same permission', async () => {
    const first = await proveReusablePermission(depsWithScope({ runId: 'run-1' }))
    const second = await proveReusablePermission(depsWithScope({ runId: 'run-2' }))
    expect(second.mode).toBe('reuse')
    expect(second.scopeId).toBe(first.scopeId)
    // ...but the executions themselves are per-run, so no two runs share an execution id.
    expect(second.executions[0].executionId).not.toBe(first.executions[0].executionId)
  })

  test('mints a well-formed execution for the one reviewed allocation', async () => {
    const decision = await proveReusablePermission(depsWithScope())
    expect(decision.executions).toHaveLength(1)
    expect(decision.executions[0].executionId).toMatch(HEX32)
    expect(decision.executions[0].allocationId).toBe(agentInit().allocationId)
  })
})

describe('proveReusablePermission — forces fresh, all-or-nothing', () => {
  test('a Base (bridge) allocation forces fresh BEFORE any chain read', async () => {
    const deps = depsWithScope({
      agentInits: [
        agentInit(),
        agentInit({ allocationId: 'run-1:bridge:1', kind: AGENT_KIND_BRIDGE }),
      ],
    })
    const decision = await proveReusablePermission(deps)
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('base-required')
    expect(deps.readPermissionGrant).not.toHaveBeenCalled()
    expect(deps.readRemainingBudget).not.toHaveBeenCalled()
    expect(deps.proveAllowance).not.toHaveBeenCalled()
    expect(deps.inspectAgents).not.toHaveBeenCalled()
  })

  test.each([
    ['a changed address', { address: OWNER_2 }],
    ['a bumped epoch', { epoch: 4 }],
    ['a different connector', { connectorId: 'xbull' }],
  ])('a stale active account forces fresh — %s', async (_label, over) => {
    const decision = await proveReusablePermission(
      depsWithScope({ getCurrentActiveAccount: () => activeAccount(over) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('account-stale')
  })

  test('a missing permission record forces fresh', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({ readPermissionGrant: vi.fn(async () => null) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('permission-missing')
  })

  test('a revoked permission forces fresh', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({ readPermissionGrant: vi.fn(async () => permissionGrant({ revoked: true })) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('permission-revoked')
  })

  test.each([
    ['exactly at the expiry ledger', 0],
    ['past the expiry ledger', 1],
  ])('an expired permission forces fresh — %s', async (_label, past) => {
    const decision = await proveReusablePermission(
      depsWithScope({
        currentLedger: LEDGER_NOW,
        readPermissionGrant: vi.fn(async () =>
          permissionGrant({ liveUntilLedger: LEDGER_NOW - past })
        ),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('permission-expired')
  })

  // Fail-CLOSED, not open: `currentLedger` has no production source today (orchestrator.js's
  // revalidateReuse leaves it unset), and `undefined >= n` is `false` — so without this guard an
  // absent/malformed ledger reads an EXPIRED permission as live. No other gate substitutes for
  // expiry, so this must force fresh on its own, never fall through to the comparison.
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a non-integer', LEDGER_NOW + 0.5],
    ['a string', String(LEDGER_NOW)],
  ])('a malformed currentLedger forces fresh as expired — %s', async (_label, value) => {
    const decision = await proveReusablePermission(depsWithScope({ currentLedger: value }))
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('permission-expired')
  })

  // The identical failure one field over: `Number(undefined)` is `NaN`, and every comparison
  // against `NaN` is `false` — a malformed `grant.liveUntilLedger` is exactly as fail-open as a
  // malformed `currentLedger` unless it gets the same guard.
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a non-integer', LEDGER_NOW + 0.5],
    ['a string', String(LEDGER_NOW + 10_000)],
  ])('a malformed grant.liveUntilLedger forces fresh as expired — %s', async (_label, value) => {
    const decision = await proveReusablePermission(
      depsWithScope({ grantOver: { liveUntilLedger: value } })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('permission-expired')
  })

  test.each([
    ['zero remaining', '0'],
    ['one unit short', '24999999'],
  ])('insufficient remaining budget forces fresh — %s', async (_label, remaining) => {
    const decision = await proveReusablePermission(
      depsWithScope({ readRemainingBudget: vi.fn(async () => remaining) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('headroom-insufficient')
  })

  test('a mutated allowance forces fresh', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({
        proveAllowance: vi.fn(async () => ({
          proven: false,
          reason: 'mutated',
          proof: provenProof(),
        })),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('allowance-mutated')
  })

  test.each([
    ['an event gap', { gapFree: false }],
    ['an unproven latest version', { noLaterMutation: false }],
  ])('a gapped allowance proof forces fresh — %s', async (_label, over) => {
    const decision = await proveReusablePermission(
      depsWithScope({
        proveAllowance: vi.fn(async () => ({
          proven: true,
          reason: null,
          proof: provenProof(over),
        })),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('allowance-proof-gapped')
  })

  test('a missing agent forces fresh', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({ inspectAgents: vi.fn(async () => []) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-missing')
  })

  test.each([
    ['code', { code: CODE_HASH_2 }],
    ['signer', { signerPub: SIGNER_PUB_2 }],
    ['target', { target: VAULT_2 }],
    ['token', { token: TOKEN_2 }],
    ['per-run cap', { perRunCapUnits: '50000001' }],
    ['cumulative cap', { cumulativeCapUnits: '100000001' }],
  ])('%s drift against the recorded scope forces fresh', async (_label, over) => {
    const decision = await proveReusablePermission(
      depsWithScope({ inspectAgents: vi.fn(async () => [inspectedAgent(over)]) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('scope-drift')
  })

  test('an allocation over the V4 per-execution cap forces fresh', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({
        agentInits: [agentInit({ cap: { token: TOKEN, units: 25_000_000n, decimals: 7 } })],
        inspectAgents: vi.fn(async () => [inspectedAgent({ perExecutionMaxUnits: '24999999' })]),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('per-execution-cap')
  })

  // Defect 2: `inspectAgents` is an injected chain read with no ordering — and no SIZE — contract,
  // and no `AgentInit`/row pair shares any field the other could be matched against (confirmed
  // against `agentCache.js`'s `inspectReusableAgents`, the closest production candidate — its rows
  // carry no per-allocation reference at all; see the task report). Binding `executions[i]` to
  // `rows[i]` by array position lets an allocation land on the wrong agent — the exact address a
  // real `pull_v3` moves funds to — the instant there is more than one allocation to disambiguate.
  // With exactly one, position and identity are the same thing; with more than one, nothing here
  // can tell a correct pairing from an incorrect one, so it forces fresh rather than guess.
  test('rows longer than agentInits forces fresh — an untracked extra candidate is not evidence', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({
        inspectAgents: vi.fn(async () => [
          inspectedAgent(),
          inspectedAgent({ agentAddress: AGENT_2 }),
        ]),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-binding-unproven')
  })

  // Same underlying evidence as the test above (an agent present that no reviewed allocation
  // needed), stated from the brief's other angle: a row belongs to zero reviewed allocations.
  test('a row present for an allocation that was never reviewed forces fresh, not a silent extra candidate', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({
        agentInits: [agentInit()],
        inspectAgents: vi.fn(async () => [
          inspectedAgent(),
          inspectedAgent({ agentAddress: AGENT_2 }), // belongs to no reviewed allocation
        ]),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-binding-unproven')
  })

  // The proof technique orchestrator.router.test.js's own recent identity-matching fix round used:
  // reverse the chain read's array relative to review order, and show a swap would have happened.
  // Here there is no identity signal to fall back on, so — unlike that downstream fix — reordering
  // can only be handled by refusing to guess: BOTH orders of the SAME two-row set force fresh
  // identically, proving the decision does not depend on (and so cannot be fooled by) `rows`' order.
  test.each([
    ['in review order', [AGENT_1, AGENT_2]],
    ['reversed — a positional zip would swap the two', [AGENT_2, AGENT_1]],
  ])(
    'rows %s still force fresh — a wrong pairing never reaches an execution',
    async (_label, order) => {
      const decision = await proveReusablePermission(
        depsWithScope({
          agentInits: [
            agentInit({ allocationId: 'run-1:deposit:0' }),
            agentInit({ allocationId: 'run-1:deposit:1' }),
          ],
          inspectAgents: vi.fn(async () =>
            order.map((agentAddress) => inspectedAgent({ agentAddress }))
          ),
        })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('agent-binding-unproven')
      expect(decision.executions).toEqual([])
    }
  )

  // "An allocation whose agent is absent from rows entirely" and "a row present for an allocation
  // that was never reviewed" collapse to the SAME evidence once there is more than one allocation:
  // whatever the exact mismatch, more than one allocation makes the whole binding unprovable.
  test('a second allocation with no plausible agent at all still forces fresh, not a partial bind', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({
        agentInits: [
          agentInit({ allocationId: 'run-1:deposit:0' }),
          agentInit({ allocationId: 'run-1:deposit:1' }),
        ],
        inspectAgents: vi.fn(async () => []),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-missing') // too few rows is still the more specific reason
    expect(decision.executions).toEqual([])
  })

  test('a missing execution credential forces fresh', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({ fetchCredential: vi.fn(() => null) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('credential-missing')
  })

  test('one bad allocation forces the WHOLE decision fresh — never a partial reuse', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({
        agentInits: [agentInit(), agentInit({ allocationId: 'run-1:deposit:1' })],
        // Only the second allocation's agent is missing.
        inspectAgents: vi.fn(async () => [inspectedAgent()]),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.executions).toEqual([])
  })

  test('a fresh decision never carries headroom figures a caller could act on', async () => {
    const decision = await proveReusablePermission(
      depsWithScope({ readPermissionGrant: vi.fn(async () => null) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.remainingHeadroomUnits).toBe(null)
    expect(decision.confirmedSpentUnits).toBe(null)
    expect(decision.executions).toEqual([])
  })
})
