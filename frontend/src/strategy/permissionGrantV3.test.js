// frontend/src/strategy/permissionGrantV3.test.js — IQ Alter remediation Task F2. The reviewed,
// BOUNDED Router V3 permission: an explicit cumulative ceiling (defaulting to exactly the planned
// movement, so a first run leaves ZERO repeat headroom), an absolute ledger expiry serialized once
// from a fresh ledger read, a run-independent scope identity that actually mirrors the router's own
// `derive_scope_id`, deterministic per-allocation execution IDs, and an all-or-nothing on-chain
// proof that forces fresh on any doubt.
//
// Router V3 is NOT deployed. `resolveRouterSchema` knows no V3 address, so the production default
// makes `proveReusablePermission` force fresh before it reads anything — the dormancy contract
// Task 4 established. These tests inject a schema resolver to exercise the live-V3 path.
//
// Task F2 retired `buildScopeId`/`scopeFieldsFromAgents` (they hashed a JSON blob the router never
// produces — every V3 reuse decision was `scope-drift`, forever, by construction) in favor of
// `deriveScopeIdV3`, a byte-for-byte mirror of the router's `derive_scope_id`. The RULE this task
// enforces going forward: a cross-layer expectation may never be computed by the layer under test.
// `PINNED_SCOPE_ID_DEPOSIT`/`PINNED_SCOPE_ID_BRIDGE` below are copied verbatim from
// `funding_router/src/test.rs`'s `scope_id_matches_pinned_cross_layer_vector` (commit c39f9bf) —
// never computed by `deriveScopeIdV3` itself — and every fixture's `grant.scopeId` is one of these
// two literals, never a value this suite derives for itself.
import { describe, test, expect, vi } from 'vitest'
import {
  buildReusableApproval,
  deriveScopeIdV3,
  makeAllocationExecution,
  proveReusablePermission,
} from './permissionGrantV3.js'
import { resolveRouterSchema } from '../stellar/routerSchema.js'
import { AGENT_KIND_DEPOSIT, AGENT_KIND_BRIDGE } from '../stellar/grant.js'
import { classifyActiveAccount } from '../stellar/activeAccount.js'
import { NETWORK_PASSPHRASE } from '../stellar/config.js'
import {
  AGENT_WASM_GENERATIONS,
  AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3,
} from '../stellar/agentCreatorManifest.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const OWNER_2 = 'GDP5XLVDKWCHX2QNJH3XRKUFNHM47KLU3MITVT7BDPWJL2QLY2X3VKLU'
const ROUTER_V2 = 'CB675TTSFM6COTGHGB7K2I7IODPQ3HTHOTTTXU2LJHXXNGTS45NOTRSE'
// Shape-valid contract id standing in for a future deployed V3 router. Deliberately NOT added to
// ROUTER_SCHEMAS — the dormancy contract at routerSchema.js:47-54 forbids inventing an address.
const ROUTER_V3 = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

// --- Pinned cross-layer vectors (Task F2) ------------------------------------------------------
// Produced by the Rust `funding_router/src/test.rs::scope_id_matches_pinned_cross_layer_vector`
// (commit c39f9bf) and independently reproduced, byte-for-byte, in JS using `@stellar/stellar-sdk`.
// These are NOT hypotheses: if `deriveScopeIdV3` ever stops reproducing them, the JS
// implementation has drifted from the chain — the fix belongs in `deriveScopeIdV3`, never here.
const PINNED_TARGET = 'CCQKDIVDUSS2NJ5IVGVKXLFNV2X3BMNSWO2LLNVXXC43VO54XW7L65UW'
const PINNED_TOKEN = 'CCYLDMVTWS23NN5YXG5LXPF5X274BQOCYPCMLRWHZDE4VS6MZXHM6QJS'
const PINNED_SCOPE_ID_DEPOSIT = '775ad5a5c5f2ec6382447626694b4ca75b25a23d466cfa3fda505596861d3202'
const PINNED_SCOPE_ID_BRIDGE = '94e42b09c513c85d1d60633877efac275f528c3141a42743d7031523f04991d3'
const ZERO_MINT_RECIPIENT = new Uint8Array(32)
const PINNED_MINT_RECIPIENT_BRIDGE = new Uint8Array(32).fill(0xcd)

// Every `proveReusablePermission` fixture below uses these AS its target/token, so a "reuse"
// decision is a genuine end-to-end proof — real Rust-derived scope_id + real fixture inputs that
// hash to it via the independently-pinned `deriveScopeIdV3` — never a value the code under test
// invented for itself and then agreed with.
const VAULT = PINNED_TARGET
const TOKEN = PINNED_TOKEN
// "Not the pinned one" alternates for drift tests — pre-existing, already-valid checksummed
// addresses from this suite's own history, never fabricated.
const VAULT_2 = 'CDWHNHIHOGBPXAK23NCU37BCXRRHCNNCEG6IPE4Q7FXBYLTJ7UYYKM77'
const TOKEN_2 = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU'
const AGENT_1 = 'CCY452UMBSDG4VHHECJAW3T5Q5BUK5NJUK22IDI2MQBHAZLTIM256UAC'
const AGENT_2 = 'CDGDIPHBN3MSNURDX33IZBXXQTJPT7THAXSMVBAIOIXLOA6OF32IRS2J'
const SIGNER_PUB = 'GA2CMBS3LRY5MH64KKMHOYVA6WTLPMKRMIWEJDOIGHYPB7WMC3QHRCBU'
const SIGNER_PUB_2 = 'GB4XNXQEDPRU7FJTSM2DDDCQ5DRZSLEDG67PIQZC6CV6ZB7TM3UZ6SXQ'
const CODE_HASH = '0x' + 'c0de'.repeat(16)
const PERMISSION_ID = '0x' + '11'.repeat(32)
const OTHER_PERMISSION_ID = '0x' + '22'.repeat(32)

// Task 5 (agent-generation eligibility gate): REAL cataloged wasm hashes, not placeholders —
// `generationForWasmHash` looks these up against the actual `AGENT_WASM_GENERATIONS` table, so a
// row using a made-up hash like CODE_HASH above can never resolve to a generation at all. Rows
// that must pass the eligibility gate (an injected, widened `eligibleGenerations`) use these
// instead; `AGENT_WASM_GENERATIONS[].wasmHash` is bare hex, on-chain-inspected rows are
// `0x`-prefixed, so the `0x` is added here to match the row shape, not the table shape.
const AGENT_V3_GENERATION = 'agent-v3'
const AGENT_V3_BRIDGE_GENERATION = 'agent-v3-bridge'
const REAL_CODE_V3 =
  '0x' + AGENT_WASM_GENERATIONS.find((g) => g.generation === AGENT_V3_GENERATION).wasmHash
const REAL_CODE_V3_BRIDGE =
  '0x' + AGENT_WASM_GENERATIONS.find((g) => g.generation === AGENT_V3_BRIDGE_GENERATION).wasmHash

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

// --- deriveScopeIdV3 --------------------------------------------------------------------------

describe("deriveScopeIdV3 — the mirror of the router's derive_scope_id (Task F2, pinned cross-layer vectors)", () => {
  // THE central assertion of this entire task. These two vectors are copied VERBATIM from
  // `funding_router/src/test.rs`'s `scope_id_matches_pinned_cross_layer_vector` (commit c39f9bf) —
  // never computed by this suite, never adjusted to fit. If `deriveScopeIdV3` ever stops
  // reproducing them, this function (not the constants) has drifted.
  test('reproduces the Rust-pinned vector — kind 0 (Deposit), zero mint_recipient, zero destination_domain', () => {
    const scopeId = deriveScopeIdV3({
      target: PINNED_TARGET,
      token: PINNED_TOKEN,
      kind: 0,
      mintRecipient: new Uint8Array(32),
      destinationDomain: 0,
    })
    expect(scopeId).toBe('775ad5a5c5f2ec6382447626694b4ca75b25a23d466cfa3fda505596861d3202')
  })

  test('reproduces the Rust-pinned vector — kind 1 (Bridge), mint_recipient 0xcd*32, destination_domain 6', () => {
    const scopeId = deriveScopeIdV3({
      target: PINNED_TARGET,
      token: PINNED_TOKEN,
      kind: 1,
      mintRecipient: new Uint8Array(32).fill(0xcd),
      destinationDomain: 6,
    })
    expect(scopeId).toBe(PINNED_SCOPE_ID_BRIDGE)
  })

  test('output convention: lowercase hex, NO 0x prefix, 64 characters — deliberately different from the retired buildScopeId', () => {
    const scopeId = deriveScopeIdV3({
      target: VAULT,
      token: TOKEN,
      kind: 0,
      mintRecipient: ZERO_MINT_RECIPIENT,
      destinationDomain: 0,
    })
    expect(scopeId).toMatch(/^[0-9a-f]{64}$/)
    expect(scopeId.startsWith('0x')).toBe(false)
  })

  test('is pure — identical inputs hash identically', () => {
    const args = {
      target: VAULT,
      token: TOKEN,
      kind: 0,
      mintRecipient: ZERO_MINT_RECIPIENT,
      destinationDomain: 0,
    }
    expect(deriveScopeIdV3(args)).toBe(deriveScopeIdV3({ ...args }))
  })

  test.each([
    ['target', { target: VAULT_2 }],
    ['token', { token: TOKEN_2 }],
    [
      'kind (with matching bridge fields)',
      { kind: 1, mintRecipient: PINNED_MINT_RECIPIENT_BRIDGE, destinationDomain: 6 },
    ],
    ['mintRecipient', { mintRecipient: new Uint8Array(32).fill(1) }],
    [
      'destinationDomain (with a non-zero kind so it is observable)',
      { kind: 1, mintRecipient: PINNED_MINT_RECIPIENT_BRIDGE, destinationDomain: 7 },
    ],
  ])('changes when %s changes', (_label, over) => {
    const base = {
      target: VAULT,
      token: TOKEN,
      kind: 0,
      mintRecipient: ZERO_MINT_RECIPIENT,
      destinationDomain: 0,
    }
    expect(deriveScopeIdV3({ ...base, ...over })).not.toBe(deriveScopeIdV3(base))
  })

  test('rejects a mintRecipient truncated to 31 bytes rather than silently padding it', () => {
    expect(() =>
      deriveScopeIdV3({
        target: VAULT,
        token: TOKEN,
        kind: 0,
        mintRecipient: new Uint8Array(31),
        destinationDomain: 0,
      })
    ).toThrow(/32 bytes/)
  })

  test('rejects a mintRecipient padded to 33 bytes rather than silently truncating it', () => {
    expect(() =>
      deriveScopeIdV3({
        target: VAULT,
        token: TOKEN,
        kind: 0,
        mintRecipient: new Uint8Array(33),
        destinationDomain: 0,
      })
    ).toThrow(/32 bytes/)
  })

  test('rejects a mintRecipient that is not a Uint8Array at all (e.g. a hex string)', () => {
    expect(() =>
      deriveScopeIdV3({
        target: VAULT,
        token: TOKEN,
        kind: 0,
        mintRecipient: '00'.repeat(32),
        destinationDomain: 0,
      })
    ).toThrow(/32 bytes/)
  })

  test.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['one past u32 max', 0x100000000],
    ['a numeric string', '1'],
  ])('rejects kind — %s', (_label, kind) => {
    expect(() =>
      deriveScopeIdV3({
        target: VAULT,
        token: TOKEN,
        kind,
        mintRecipient: ZERO_MINT_RECIPIENT,
        destinationDomain: 0,
      })
    ).toThrow(/u32/)
  })

  test.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['one past u32 max', 0x100000000],
    ['a numeric string', '6'],
  ])('rejects destinationDomain — %s', (_label, destinationDomain) => {
    expect(() =>
      deriveScopeIdV3({
        target: VAULT,
        token: TOKEN,
        kind: 1,
        mintRecipient: PINNED_MINT_RECIPIENT_BRIDGE,
        destinationDomain,
      })
    ).toThrow(/u32/)
  })

  test('accepts the maximum u32 value for kind/destinationDomain without throwing', () => {
    expect(() =>
      deriveScopeIdV3({
        target: VAULT,
        token: TOKEN,
        kind: 0xffffffff,
        mintRecipient: ZERO_MINT_RECIPIENT,
        destinationDomain: 0xffffffff,
      })
    ).not.toThrow()
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

// Every field here — target/token/kind/mintRecipient/destinationDomain — is EXACTLY the pinned
// Deposit-kind vector's inputs, so this fixture's derived scope id is `PINNED_SCOPE_ID_DEPOSIT` via
// the SAME `deriveScopeIdV3` the pinned-vector tests above verify independently against the Rust.
function agentInit(over = {}) {
  return {
    allocationId: 'run-1:deposit:0',
    kind: AGENT_KIND_DEPOSIT,
    token: TOKEN,
    target: VAULT,
    cap: { token: TOKEN, units: 25_000_000n, decimals: 7 },
    periodSeconds: DAY,
    expiry: NOW + 3600,
    // Bridge fields: zeroed by convention for a Deposit-kind allocation — grant.js's
    // `agentInitScVal` encodes them unconditionally regardless of kind, so a real AgentInit always
    // carries them.
    mintRecipient: ZERO_MINT_RECIPIENT,
    destinationDomain: 0,
    ...over,
  }
}

function permissionGrant(over = {}) {
  return {
    permissionId: PERMISSION_ID,
    // De-tautologized (Task F2): a LITERAL pinned constant, never computed by the code under test.
    // `agentInit()`'s default fields are exactly the pinned Deposit-kind vector's inputs, so this
    // is a genuine cross-layer match, not a fixture agreeing with itself.
    scopeId: PINNED_SCOPE_ID_DEPOSIT,
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

// `code` defaults to a REAL cataloged wasm hash (not a placeholder) so this row resolves to a real
// generation through `generationForWasmHash` — the eligibility gate (Task 5) runs unconditionally.
// `perRunCapUnits`/`cumulativeCapUnits` default to the SAME numbers `permissionGrant()` records
// (`perRunMaxUnits`/`mandateCeilingUnits`) — Task F2's new cap-drift check (7e) compares them.
function inspectedAgent(over = {}) {
  return {
    agentAddress: AGENT_1,
    signerPub: SIGNER_PUB,
    code: REAL_CODE_V3,
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

// Every default here is already mutually consistent (agentInit hashes to PINNED_SCOPE_ID_DEPOSIT,
// which is exactly `permissionGrant()`'s default scopeId; `inspectedAgent()`'s caps match
// `permissionGrant()`'s; `readLinkedPermission` answers PERMISSION_ID) — no depsWithScope-style
// helper is needed anymore: since the scope id is a literal pinned constant, not a value computed
// from `rows`, a plain `baseDeps()` call already reaches `reuse` on its own.
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
    // Same dormancy shape one gate deeper (Task 5): the production allowlist
    // (AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3) is `[]` until a real V3-capable generation is
    // deployed, so it is widened here to admit the two REAL cataloged generations these fixtures'
    // rows use — never the placeholder CODE_HASH generation (there isn't one; it resolves to
    // `null` and no allowlist can admit that).
    eligibleGenerations: [AGENT_V3_GENERATION, AGENT_V3_BRIDGE_GENERATION],
    readPermissionGrant: vi.fn(async () => permissionGrant()),
    readRemainingBudget: vi.fn(async () => '75000000'),
    proveAllowance: vi.fn(async () => ({ proven: true, reason: null, proof: provenProof() })),
    inspectAgents: vi.fn(async () => [inspectedAgent()]),
    // Task F2: every bound agent must PROVE, via this injected reader, that it is linked to
    // exactly THIS permission (the router's `linked_permission`, c39f9bf) — defaults to the happy
    // path (every queried agent answers with PERMISSION_ID); the `readLinkedPermission` describe
    // block below overrides this explicitly to exercise `'agent-not-linked'`.
    readLinkedPermission: vi.fn(async () => PERMISSION_ID),
    fetchCredential: vi.fn(() => ({ agentAddress: AGENT_1, signerPub: SIGNER_PUB })),
    ...over,
    agentInits: inits,
  }
}

// Maps allocationId -> the correct bound agent's credential, for the handful of multi-allocation
// tests below where AGENT_1 alone (baseDeps' default fetchCredential) would wrongly answer for a
// second allocation actually bound to AGENT_2.
const twoAgentCredentials = vi.fn(({ allocationId }) =>
  allocationId === 'run-1:deposit:0'
    ? { agentAddress: AGENT_1, signerPub: SIGNER_PUB }
    : { agentAddress: AGENT_2, signerPub: SIGNER_PUB_2 }
)

describe('proveReusablePermission — dormancy', () => {
  test('forces fresh with ZERO chain reads when the router is not a known V3 address', async () => {
    const deps = baseDeps({ resolveSchema: () => ({ version: 2, tokenMode: 'per-budget' }) })
    const decision = await proveReusablePermission(deps)
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('router-not-v3')
    expect(deps.readPermissionGrant).not.toHaveBeenCalled()
    expect(deps.readRemainingBudget).not.toHaveBeenCalled()
    expect(deps.proveAllowance).not.toHaveBeenCalled()
    expect(deps.inspectAgents).not.toHaveBeenCalled()
  })

  test('forces fresh when the router resolves to no schema at all', async () => {
    const deps = baseDeps({ resolveSchema: () => null })
    const decision = await proveReusablePermission(deps)
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('router-not-v3')
  })

  test('the PRODUCTION default resolver knows no V3 router — every live address is dormant', async () => {
    // The activation trigger: registering a real deployed V3 address in ROUTER_SCHEMAS.
    for (const address of [ROUTER_V2, ROUTER_V3]) {
      expect(resolveRouterSchema(address)?.version).not.toBe(3)
    }
    const { resolveSchema: _injected, ...withProductionResolver } = baseDeps()
    const decision = await proveReusablePermission(withProductionResolver)
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('router-not-v3')
  })
})

describe('proveReusablePermission — reuse', () => {
  test('reuses a bounded, unexpired, unrevoked permission with proven headroom', async () => {
    const decision = await proveReusablePermission(baseDeps())
    expect(decision.mode).toBe('reuse')
    expect(decision.freshReason).toBe(null)
    expect(decision.version).toBe(3)
    expect(decision.permissionId).toBe(PERMISSION_ID)
    // The returned scopeId is the pinned constant, reproduced by the code under test from the
    // reviewed allocation — never invented, never merely self-consistent.
    expect(decision.scopeId).toBe(PINNED_SCOPE_ID_DEPOSIT)
  })

  test('reports headroom as exact bigint arithmetic, never rounded or estimated', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
        readPermissionGrant: vi.fn(async () =>
          permissionGrant({ mandateCeilingUnits: '9007199254740993', confirmedSpentUnits: '1' })
        ),
        readRemainingBudget: vi.fn(async () => '9007199254740992'),
        // The bound row's own recorded cumulative cap must track the grant's new ceiling — Task
        // F2's cap-drift check (7e) compares them directly.
        inspectAgents: vi.fn(async () => [
          inspectedAgent({ cumulativeCapUnits: '9007199254740993' }),
        ]),
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
    const first = await proveReusablePermission(baseDeps({ runId: 'run-1' }))
    const second = await proveReusablePermission(baseDeps({ runId: 'run-2' }))
    expect(second.mode).toBe('reuse')
    expect(second.scopeId).toBe(first.scopeId)
    // ...but the executions themselves are per-run, so no two runs share an execution id.
    expect(second.executions[0].executionId).not.toBe(first.executions[0].executionId)
  })

  test('mints a well-formed execution for the one reviewed allocation', async () => {
    const decision = await proveReusablePermission(baseDeps())
    expect(decision.executions).toHaveLength(1)
    expect(decision.executions[0].executionId).toMatch(HEX32)
    expect(decision.executions[0].allocationId).toBe(agentInit().allocationId)
  })

  test('mints one unique execution per allocation under a single permission', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
        agentInits: [agentInit(), agentInit({ allocationId: 'run-1:deposit:1' })],
        fetchCredential: twoAgentCredentials,
        inspectAgents: vi.fn(async () => [
          inspectedAgent(),
          inspectedAgent({ agentAddress: AGENT_2 }),
        ]),
      })
    )
    expect(decision.mode).toBe('reuse')
    expect(decision.executions).toHaveLength(2)
    const ids = decision.executions.map((e) => e.executionId)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(HEX32)
  })
})

describe('proveReusablePermission — forces fresh, all-or-nothing', () => {
  test('a Base (bridge) allocation forces fresh BEFORE any chain read', async () => {
    const deps = baseDeps({
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
      baseDeps({ getCurrentActiveAccount: () => activeAccount(over) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('account-stale')
  })

  // Same fail-open class as the `currentLedger` expiry gate above (both hardened in this round):
  // an absent `activeAccount`, or any record that is not a recognized V1 shape, must force fresh
  // rather than silently skip the account-binding check entirely. Before this fix
  // `if (activeAccount?.version === 1) {...}` skipped BOTH checks below it whenever the condition
  // was false — including these two cases, which used to sail straight through to a genuine reuse.
  test('no activeAccount at all forces fresh (fail-closed, not open)', async () => {
    const decision = await proveReusablePermission(baseDeps({ activeAccount: undefined }))
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('account-stale')
  })

  test('a non-V1 active account record forces fresh rather than skipping the check', async () => {
    const decision = await proveReusablePermission(
      baseDeps({ activeAccount: { ...activeAccount(), version: 2 } })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('account-stale')
  })

  test('a missing permission record forces fresh', async () => {
    const decision = await proveReusablePermission(
      baseDeps({ readPermissionGrant: vi.fn(async () => null) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('permission-missing')
  })

  test('a revoked permission forces fresh', async () => {
    const decision = await proveReusablePermission(
      baseDeps({ readPermissionGrant: vi.fn(async () => permissionGrant({ revoked: true })) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('permission-revoked')
  })

  test.each([
    ['exactly at the expiry ledger', 0],
    ['past the expiry ledger', 1],
  ])('an expired permission forces fresh — %s', async (_label, past) => {
    const decision = await proveReusablePermission(
      baseDeps({
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
    const decision = await proveReusablePermission(baseDeps({ currentLedger: value }))
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
      baseDeps({
        readPermissionGrant: vi.fn(async () => permissionGrant({ liveUntilLedger: value })),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('permission-expired')
  })

  test.each([
    ['zero remaining', '0'],
    ['one unit short', '24999999'],
  ])('insufficient remaining budget forces fresh — %s', async (_label, remaining) => {
    const decision = await proveReusablePermission(
      baseDeps({ readRemainingBudget: vi.fn(async () => remaining) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('headroom-insufficient')
  })

  test('a mutated allowance forces fresh', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
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
      baseDeps({
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
      baseDeps({ inspectAgents: vi.fn(async () => []) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-missing')
  })

  // Task 5 (IQ Alter remediation): closes the gate Task 4 wrote but never wired —
  // `AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3` stays `[]` in production, so every one of these
  // drives eligibility by injecting/widening `eligibleGenerations`, never by mutating that
  // constant. Runs strictly after `agent-missing` and strictly before the Task F2 scope-drift
  // derivation below (step 7a, before step 7b).
  describe("agent-generation eligibility (Task 5 closes Task 4's gate)", () => {
    test('a row whose generation is absent from the injected allowlist forces fresh', async () => {
      const decision = await proveReusablePermission(baseDeps({ eligibleGenerations: [] }))
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('agent-generation-ineligible')
    })

    test('a row whose generation IS in the injected allowlist passes the gate through to reuse', async () => {
      const decision = await proveReusablePermission(
        baseDeps({ eligibleGenerations: [AGENT_V3_GENERATION] })
      )
      expect(decision.mode).toBe('reuse')
      expect(decision.freshReason).toBe(null)
    })

    // The mutation this pins: change the `eligibleGenerations` DEFAULT parameter from the real
    // `AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3` to a hardcoded non-empty list. Destructuring
    // the injected override OUT (the same technique the dormancy block above uses for
    // `resolveSchema`) forces this call through the function's own default, not a test-supplied one.
    test('the PRODUCTION default allowlist ([]) marks a REAL cataloged generation ineligible — no generation has been added yet', async () => {
      const { eligibleGenerations: _injected, ...withProductionAllowlist } = baseDeps()
      const decision = await proveReusablePermission(withProductionAllowlist)
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('agent-generation-ineligible')
    })

    // Fix-round finding 8: the test above only pins "the default rejects agent-v3" — an
    // implementation that replaced the default with a hardcoded `[]` LITERAL (fully decoupled from
    // the exported constant) would ALSO pass it, and would stay silently green right up until a
    // real deploy adds a generation to AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3, at which point
    // the decoupled default would still read `[]` forever. This ties the default to the constant
    // by IDENTITY: arrays are mutable in place, so mutating the real exported array (never
    // reassigning it, and always restored in `finally`) is visible to every importer holding the
    // SAME object — including whatever default parameter expression `proveReusablePermission`
    // evaluates when no override is supplied. A decoupled default would not see this mutation and
    // would keep reporting ineligible.
    test('the default eligibleGenerations parameter IS the exported constant by reference, not a decoupled copy', async () => {
      expect(AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3).toEqual([])
      const original = [...AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3]
      try {
        AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3.push(AGENT_V3_GENERATION)
        const { eligibleGenerations: _injected, ...withProductionAllowlist } = baseDeps()
        const decision = await proveReusablePermission(withProductionAllowlist)
        expect(decision.mode).toBe('reuse')
        expect(decision.freshReason).toBe(null)
      } finally {
        AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3.length = 0
        AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3.push(...original)
      }
      expect(AGENT_GENERATIONS_ELIGIBLE_FOR_PERMISSION_V3).toEqual([])
    })

    test('a row whose code maps to no known generation at all forces fresh the same way — fail-closed, never a guess', async () => {
      const decision = await proveReusablePermission(
        baseDeps({
          inspectAgents: vi.fn(async () => [inspectedAgent({ code: CODE_HASH })]),
          eligibleGenerations: [AGENT_V3_GENERATION], // widened, but irrelevant: code resolves to null
        })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('agent-generation-ineligible')
    })

    test('checks EVERY row, not just the first', async () => {
      const decision = await proveReusablePermission(
        baseDeps({
          agentInits: [
            agentInit({ allocationId: 'run-1:deposit:0' }),
            agentInit({ allocationId: 'run-1:deposit:1' }),
          ],
          inspectAgents: vi.fn(async () => [
            inspectedAgent(), // agent-v3 — eligible
            inspectedAgent({ agentAddress: AGENT_2, code: REAL_CODE_V3_BRIDGE }), // NOT allowlisted below
          ]),
          eligibleGenerations: [AGENT_V3_GENERATION], // deliberately excludes agent-v3-bridge
        })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('agent-generation-ineligible')
    })

    test('the eligibility gate runs strictly after agent-missing, not before it', async () => {
      const decision = await proveReusablePermission(
        baseDeps({
          agentInits: [
            agentInit({ allocationId: 'run-1:deposit:0' }),
            agentInit({ allocationId: 'run-1:deposit:1' }),
          ],
          inspectAgents: vi.fn(async () => []),
          eligibleGenerations: [], // would ALSO force ineligible if it ran first — it must not
        })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('agent-missing')
    })
  })

  // --- Task F2: what the scope id does and does NOT bind ---------------------------------------
  // The false claim this task retired said the (fake) hash "catches code, signer, target, token
  // and cap drift at once." The real `derive_scope_id` binds ONLY target/token/kind/bridge-config.
  // These tests replace the old single-hash drift table with checks matching what actually catches
  // each kind of drift now — several distinct mechanisms, never one hash.
  describe('what deriveScopeIdV3 does NOT bind — documented, residual gap (code / signerPub)', () => {
    // Neither `code` (wasm hash) nor `signerPub` (session key) is bound by `derive_scope_id`, and
    // nothing else in this prover checks them: proving the router's PINNED wasm hash needs a
    // `config()` read that does not exist on this contract yet (see deriveScopeIdV3's own doc).
    // These two tests exist to make that gap undeniable, not to celebrate it — a bound row whose
    // code/signer silently drifted from what the permission was scoped to is NOT currently caught.
    test('a bound row whose code drifted to a DIFFERENT, still-eligible generation is NOT caught — reuses anyway', async () => {
      const decision = await proveReusablePermission(
        baseDeps({
          inspectAgents: vi.fn(async () => [inspectedAgent({ code: REAL_CODE_V3_BRIDGE })]),
        })
      )
      expect(decision.mode).toBe('reuse')
    })

    test('a bound row whose signerPub drifted is NOT caught — reuses anyway', async () => {
      const decision = await proveReusablePermission(
        baseDeps({
          inspectAgents: vi.fn(async () => [inspectedAgent({ signerPub: SIGNER_PUB_2 })]),
        })
      )
      expect(decision.mode).toBe('reuse')
    })
  })

  describe('what IS still caught, by a specific mechanism (never the retired hash)', () => {
    test('a bound row whose target drifted is caught at the BINDING step (agent-binding-unproven), not scope-drift', async () => {
      const decision = await proveReusablePermission(
        baseDeps({ inspectAgents: vi.fn(async () => [inspectedAgent({ target: VAULT_2 })]) })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('agent-binding-unproven')
    })

    test('a bound row whose token drifted from the permission is caught by the KEPT per-row token check (scope-drift)', async () => {
      const decision = await proveReusablePermission(
        baseDeps({ inspectAgents: vi.fn(async () => [inspectedAgent({ token: TOKEN_2 })]) })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('scope-drift')
    })

    test.each([
      ['per-run cap', { perRunCapUnits: '50000001' }],
      ['cumulative cap', { cumulativeCapUnits: '100000001' }],
    ])(
      "%s drift against the permission's own recorded ceiling is caught by the NEW cap-drift check",
      async (_label, over) => {
        const decision = await proveReusablePermission(
          baseDeps({ inspectAgents: vi.fn(async () => [inspectedAgent(over)]) })
        )
        expect(decision.mode).toBe('fresh')
        expect(decision.freshReason).toBe('agent-cap-drift')
      }
    )
  })

  describe('the scope-id derivation itself (Task F2, item 3)', () => {
    test('an agentInit whose target does not match what the permission is scoped to forces scope-drift — derived from the ALLOCATION, not the row', async () => {
      const decision = await proveReusablePermission(
        baseDeps({ agentInits: [agentInit({ target: VAULT_2 })] })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('scope-drift')
    })

    // `deriveScopeIdV3` hashes `grant.token` (the PERMISSION's own token), never `init.token` — so
    // an agentInit with the WRONG token does not change the derived scope id at all. The mismatch
    // instead surfaces at the binding step, which matches candidate rows on `init.token` directly.
    test("an agentInit whose OWN token differs from the permission's does not affect the derived scope id — the mismatch surfaces at binding instead", async () => {
      const decision = await proveReusablePermission(
        baseDeps({ agentInits: [agentInit({ token: TOKEN_2 })] })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('agent-binding-unproven')
    })

    // Mirrors the router's OWN invariant (`grant_v3`'s `ScopeMismatchV3` loop): every reviewed
    // allocation must derive the IDENTICAL scope id, not just the first. This is the mandatory
    // mutation the task brief pins: drop the `derivedScopeIds.some(...)` cross-check and this test
    // goes RED (the decision would incorrectly reach `reuse`, since agentInits[0] alone matches).
    test('two reviewed allocations that derive DIFFERENT scope ids force scope-drift for the WHOLE decision, even though the first alone matches the grant', async () => {
      const decision = await proveReusablePermission(
        baseDeps({
          agentInits: [
            agentInit({ allocationId: 'run-1:deposit:0' }), // derives PINNED_SCOPE_ID_DEPOSIT
            agentInit({ allocationId: 'run-1:deposit:1', target: VAULT_2 }), // derives something else
          ],
          inspectAgents: vi.fn(async () => [
            inspectedAgent(),
            inspectedAgent({ agentAddress: AGENT_2, target: VAULT_2 }),
          ]),
        })
      )
      expect(decision.mode).toBe('fresh')
      expect(decision.freshReason).toBe('scope-drift')
      expect(decision.executions).toEqual([])
    })
  })

  test('an allocation over the V4 per-execution cap forces fresh', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
        agentInits: [agentInit({ cap: { token: TOKEN, units: 25_000_000n, decimals: 7 } })],
        inspectAgents: vi.fn(async () => [inspectedAgent({ perExecutionMaxUnits: '24999999' })]),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('per-execution-cap')
  })

  // Defect 2: binding is an ASSIGNMENT (bucket by target/token, skip claimed addresses — V2's
  // `selectAgents` model), never a positional zip. It runs only after the scope checks above
  // already prove the reviewed allocation shape matches the permission, so these tests assert the
  // BINDING itself — the actual allocation→address map — not merely a refusal.
  test('rows arriving in a DIFFERENT ORDER still bind each allocation to the SAME agent — the assignment is a pure function of the row set, not of read order', async () => {
    const agentInits = [
      agentInit({ allocationId: 'run-1:deposit:0' }),
      agentInit({ allocationId: 'run-1:deposit:1' }),
    ]
    const mapOf = (decision) =>
      new Map(decision.executions.map((e) => [e.allocationId, e.agentAddress]))

    const inOrder = await proveReusablePermission(
      baseDeps({
        agentInits,
        fetchCredential: twoAgentCredentials,
        inspectAgents: vi.fn(async () => [
          inspectedAgent(),
          inspectedAgent({ agentAddress: AGENT_2 }),
        ]),
      })
    )
    const reversed = await proveReusablePermission(
      baseDeps({
        agentInits,
        fetchCredential: twoAgentCredentials,
        inspectAgents: vi.fn(async () => [
          inspectedAgent({ agentAddress: AGENT_2 }),
          inspectedAgent(),
        ]),
      })
    )

    expect(inOrder.mode).toBe('reuse')
    expect(reversed.mode).toBe('reuse')
    expect(mapOf(reversed)).toEqual(mapOf(inOrder))
    // Pin the actual mapping, not just "the two calls agree with each other."
    expect(mapOf(inOrder).get('run-1:deposit:0')).toBe(AGENT_1)
    expect(mapOf(inOrder).get('run-1:deposit:1')).toBe(AGENT_2)
  })

  test('an allocation whose target/token matches no candidate row forces fresh, not a guessed address', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
        agentInits: [
          agentInit({ allocationId: 'run-1:deposit:0' }),
          agentInit({ allocationId: 'run-1:deposit:1' }),
        ],
        inspectAgents: vi.fn(async () => [
          inspectedAgent(),
          // Wrong target — no agentInit above wants VAULT_2; both derive PINNED_SCOPE_ID_DEPOSIT
          // (target=VAULT), so scope checks pass and this isolates the claim-loop's own failure.
          inspectedAgent({ agentAddress: AGENT_2, target: VAULT_2 }),
        ]),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-binding-unproven')
  })

  // Two rows sharing an agentAddress is a malformed read: Array#sort is stable, so a comparator
  // that never returns 0 (this one doesn't) would let a tie fall back to whatever order the chain
  // read happened to return — reopening the exact non-determinism `.sort()` exists to close.
  test('two rows sharing an agentAddress force fresh — a malformed read, not a coincidence to sort around', async () => {
    const decision = await proveReusablePermission(
      baseDeps({ inspectAgents: vi.fn(async () => [inspectedAgent(), inspectedAgent()]) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-binding-unproven')
  })

  test('one allocation with no plausible candidate row forces the WHOLE decision fresh — never a partial bind', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
        agentInits: [
          agentInit({ allocationId: 'run-1:deposit:0' }),
          agentInit({ allocationId: 'run-1:deposit:1' }),
        ],
        inspectAgents: vi.fn(async () => [
          inspectedAgent(),
          inspectedAgent({ agentAddress: AGENT_2, target: VAULT_2 }), // no agentInit wants VAULT_2
        ]),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-binding-unproven')
    expect(decision.executions).toEqual([])
  })

  test('too few rows for the reviewed allocations still reports the more specific agent-missing, not agent-binding-unproven', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
        agentInits: [
          agentInit({ allocationId: 'run-1:deposit:0' }),
          agentInit({ allocationId: 'run-1:deposit:1' }),
        ],
        inspectAgents: vi.fn(async () => []),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-missing')
    expect(decision.executions).toEqual([])
  })

  // Every multi-row fixture up to this point carries an IDENTICAL perExecutionMaxUnits, so
  // rows[i] and bound[i] are indistinguishable by outcome. Here they diverge on purpose: rows
  // arrive in the REVERSE of canonical (sorted) order, and each agent's own cap is exactly enough
  // for the allocation it's actually bound to but not enough for the OTHER one — rows[i] indexing
  // checks the wrong agent's cap against each allocation and would force fresh; bound[i] passes.
  test('the per-execution cap is checked against the BOUND agent, not whatever row landed at that array index', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
        agentInits: [
          agentInit({
            allocationId: 'run-1:deposit:0',
            cap: { token: TOKEN, units: 25_000_000n, decimals: 7 },
          }),
          agentInit({
            allocationId: 'run-1:deposit:1',
            cap: { token: TOKEN, units: 20_000_000n, decimals: 7 },
          }),
        ],
        fetchCredential: twoAgentCredentials,
        inspectAgents: vi.fn(async () => [
          inspectedAgent({ agentAddress: AGENT_2, perExecutionMaxUnits: '20000000' }),
          inspectedAgent({ agentAddress: AGENT_1, perExecutionMaxUnits: '25000000' }),
        ]),
      })
    )
    expect(decision.mode).toBe('reuse')
    expect(decision.freshReason).toBe(null)
  })

  test('a missing execution credential forces fresh', async () => {
    const decision = await proveReusablePermission(baseDeps({ fetchCredential: vi.fn(() => null) }))
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('credential-missing')
  })

  // `fetchCredential` returning something is not enough — it must be the credential for the SAME
  // agent this allocation was just bound to. Fails closed today at on-chain auth even without this
  // check (see the code comment), but that's a downstream backstop, not a reason to skip checking
  // here — this proves the check itself, not just the existence check it sits behind.
  test('a credential for the WRONG agent forces fresh, not a mismatched signer accepted as reuse', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
        // The default single-allocation binding is AGENT_1; hand back a real credential, just for
        // the wrong address.
        fetchCredential: vi.fn(() => ({ agentAddress: AGENT_2, signerPub: SIGNER_PUB })),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('credential-missing')
  })

  test('one bad allocation forces the WHOLE decision fresh — never a partial reuse', async () => {
    const decision = await proveReusablePermission(
      baseDeps({
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
      baseDeps({ readPermissionGrant: vi.fn(async () => null) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.remainingHeadroomUnits).toBe(null)
    expect(decision.confirmedSpentUnits).toBe(null)
    expect(decision.executions).toEqual([])
  })
})

// --- readLinkedPermission (Task F2, item 5) ----------------------------------------------------
// `linked_permission(agent) -> Option<BytesN<32>>` (c39f9bf) closes a fail-open: the browser could
// previously only trust its OWN local cache that a bound agent belongs to this permission. This
// injected reader proves it from public on-chain state instead.
describe('readLinkedPermission — proving a bound agent belongs to THIS permission (Task F2)', () => {
  test('a bound agent linked to a DIFFERENT permission forces fresh (agent-not-linked)', async () => {
    const decision = await proveReusablePermission(
      baseDeps({ readLinkedPermission: vi.fn(async () => OTHER_PERMISSION_ID) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-not-linked')
  })

  test('a bound agent with no recorded link at all forces fresh (agent-not-linked)', async () => {
    const decision = await proveReusablePermission(
      baseDeps({ readLinkedPermission: vi.fn(async () => null) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-not-linked')
  })

  test("a read failure (the reader's own documented contract: resolve null/undefined, never throw) forces fresh the same way", async () => {
    const decision = await proveReusablePermission(
      baseDeps({ readLinkedPermission: vi.fn(async () => undefined) })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-not-linked')
  })

  test('checks EVERY bound agent, not just the first', async () => {
    const readLinkedPermission = vi.fn(async ({ agent }) =>
      agent === AGENT_1 ? PERMISSION_ID : OTHER_PERMISSION_ID
    )
    const decision = await proveReusablePermission(
      baseDeps({
        agentInits: [
          agentInit({ allocationId: 'run-1:deposit:0' }),
          agentInit({ allocationId: 'run-1:deposit:1' }),
        ],
        fetchCredential: twoAgentCredentials,
        readLinkedPermission,
        inspectAgents: vi.fn(async () => [
          inspectedAgent(),
          inspectedAgent({ agentAddress: AGENT_2 }),
        ]),
      })
    )
    expect(decision.mode).toBe('fresh')
    expect(decision.freshReason).toBe('agent-not-linked')
    expect(readLinkedPermission).toHaveBeenCalledTimes(2)
  })

  test('a linked agent reading exactly this permissionId passes the gate through to reuse, and is called with (router, agent)', async () => {
    const readLinkedPermission = vi.fn(async ({ router, agent }) => {
      expect(router).toBe(ROUTER_V3)
      expect(agent).toBe(AGENT_1)
      return PERMISSION_ID
    })
    const decision = await proveReusablePermission(baseDeps({ readLinkedPermission }))
    expect(decision.mode).toBe('reuse')
    expect(readLinkedPermission).toHaveBeenCalledTimes(1)
  })
})
