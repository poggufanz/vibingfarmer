// frontend/src/strategy/allocationReceipt.test.js
//
// allocationReceipt.js is the pure client producer for AllocationReceiptV2 -- the durable receipt
// type whose schema and enforcement already exist server-side (api/agent-index/migrations/
// 0005_execution_receipts.sql, api/agent-index/models.js). The "cross-layer" describe block below
// is the load-bearing check: it imports the REAL `toExecutionReceiptRow`/`toPhaseAttemptRow` from
// the server module and feeds them this producer's actual output, rather than asserting against
// this test's own guess of the expected shape.
//
// Fix round 1: the review found `confirmCustody` threw on exactly the ambiguous-evidence input
// the brief's own `unknown`/`amount:null` custody rule describes, making that state unreachable.
// The controller ruling: ambiguous evidence must never throw and must never un-confirm proven
// custody -- it keeps the last proven location and records the ambiguity in `custody.reason`;
// `unknown`/`confirmed:false` becomes reachable only at INSERT time via `createAllocationReceipt`'s
// `initialCustody`. Tests below reflect that redesign; the round-1 tests that asserted a throw for
// ambiguous evidence have been rewritten to assert the graceful, non-throwing behavior instead.
import { describe, test, expect } from 'vitest'
import { createAllocationReceipt, appendPhase, confirmCustody } from './allocationReceipt.js'
import { toExecutionReceiptRow, toPhaseAttemptRow } from '../../api/agent-index/models.js'

// Real-length placeholders (a Stellar G-account / C-contract address is 56 chars, a tx hash is
// 0x + 64 hex chars) -- StrategyReceipt.test.jsx documents why a short placeholder is unsafe: it
// can silently defeat a real overflow/shape assertion.
const OWNER = 'G' + 'A'.repeat(55)
const WORKER = 'G' + 'B'.repeat(55)
const AGENT = 'C' + 'C'.repeat(55)
const NETWORK_ID = 'stellar-testnet'
const RUN_ID = 'run-2026-08-01-000001'
const ALLOCATION_ID = `${RUN_ID}:deposit:0`
const EXECUTION_ID = `${RUN_ID}:exec:0`
const AMOUNT = { token: 'USDC', units: '10000000', decimals: 7 } // 1 USDC at 7dp
const INTENT = { allocationId: ALLOCATION_ID, kind: 'deposit', allocation: AMOUNT }
const PULL_HASH = '0x' + '1'.repeat(64)
const DEPOSIT_HASH = '0x' + '2'.repeat(64)
const NOW = 1_800_000_000_000

function baseReceipt(overrides = {}) {
  return createAllocationReceipt({
    networkId: NETWORK_ID,
    executionId: EXECUTION_ID,
    allocationId: ALLOCATION_ID,
    owner: OWNER,
    runId: RUN_ID,
    worker: WORKER,
    agent: AGENT,
    intent: INTENT,
    amount: AMOUNT,
    ...overrides,
  })
}

describe('createAllocationReceipt', () => {
  test('starts every phase not_started and custody confirmed at owner before any movement', () => {
    const r = baseReceipt()
    expect(r.version).toBe(2)
    expect(r.phases).toEqual({
      pull: 'not_started',
      stellar_deposit: 'not_started',
      cctp_burn: 'not_started',
      cctp_mint: 'not_started',
      base_deposit: 'not_started',
    })
    expect(r.custody).toEqual({ location: 'owner', confirmed: true, amount: AMOUNT, reason: null })
    expect(r.attempts).toEqual([])
    expect(r.parentAllocationId).toBeNull()
    expect(r.childId).toBeNull()
  })

  test('rejects a missing required identity field rather than silently building an invalid receipt', () => {
    expect(() => createAllocationReceipt({})).toThrow(/networkId/)
  })

  // Controller ruling point 3: unknown/confirmed:false is reachable ONLY at INSERT time.
  test('opens at unknown/unconfirmed with a null amount when the caller has no observed pre-movement position', () => {
    const r = baseReceipt({
      initialCustody: { location: 'unknown', reason: 'reconstructed execution' },
    })
    expect(r.custody).toEqual({
      location: 'unknown',
      confirmed: false,
      amount: null,
      reason: 'reconstructed execution',
    })
  })

  test('rejects an initialCustody location other than unknown', () => {
    expect(() => baseReceipt({ initialCustody: { location: 'stellar-vault' } })).toThrow(
      /initialCustody only supports "unknown"/
    )
  })

  test("copies intent at construction -- a later mutation of the caller's object does not rewrite the receipt", () => {
    const intent = { allocationId: ALLOCATION_ID, kind: 'deposit', allocation: { ...AMOUNT } }
    const r = createAllocationReceipt({
      networkId: NETWORK_ID,
      executionId: EXECUTION_ID,
      allocationId: ALLOCATION_ID,
      owner: OWNER,
      runId: RUN_ID,
      worker: WORKER,
      agent: AGENT,
      intent,
      amount: AMOUNT,
    })
    intent.kind = 'mutated-after-the-fact'
    expect(r.intent.kind).toBe('deposit')
  })
})

describe('appendPhase', () => {
  test('pull and deposit are separate attempts carrying separate hashes -- never one hash for two phases', () => {
    const r1 = appendPhase(baseReceipt(), {
      attemptId: 'attempt-pull-1',
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: PULL_HASH },
      observedAt: NOW,
    })
    const r2 = appendPhase(r1, {
      attemptId: 'attempt-deposit-1',
      phase: 'stellar_deposit',
      status: 'confirmed',
      evidence: { txHash: DEPOSIT_HASH },
      observedAt: NOW + 1,
    })
    expect(r2.attempts).toHaveLength(2)
    expect(r2.attempts[0]).toMatchObject({
      attemptId: 'attempt-pull-1',
      phase: 'pull',
      evidence: { txHash: PULL_HASH },
    })
    expect(r2.attempts[1]).toMatchObject({
      attemptId: 'attempt-deposit-1',
      phase: 'stellar_deposit',
      evidence: { txHash: DEPOSIT_HASH },
    })
    expect(r2.attempts[0].evidence.txHash).not.toBe(r2.attempts[1].evidence.txHash)
    expect(r2.phases.pull).toBe('confirmed')
    expect(r2.phases.stellar_deposit).toBe('confirmed')
  })

  test('generates a real attemptId when the caller does not supply one', () => {
    const r = appendPhase(baseReceipt(), { phase: 'pull', status: 'submitted', observedAt: NOW })
    expect(typeof r.attempts[0].attemptId).toBe('string')
    expect(r.attempts[0].attemptId.length).toBeGreaterThan(0)
  })

  test('defaults attempt kind to "phase"', () => {
    const r = appendPhase(baseReceipt(), {
      attemptId: 'attempt-1',
      phase: 'pull',
      status: 'submitted',
      observedAt: NOW,
    })
    expect(r.attempts[0].kind).toBe('phase')
  })

  test('accepts the revoked-scope-reconciliation attempt kind', () => {
    const r = appendPhase(baseReceipt(), {
      attemptId: 'attempt-1',
      kind: 'revoked-scope-reconciliation',
      phase: 'pull',
      status: 'confirmed',
      observedAt: NOW,
    })
    expect(r.attempts[0].kind).toBe('revoked-scope-reconciliation')
  })

  test('never mutates the input receipt', () => {
    const original = baseReceipt()
    const phasesSnapshot = { ...original.phases }
    const result = appendPhase(original, {
      attemptId: 'attempt-1',
      phase: 'pull',
      status: 'submitted',
      observedAt: NOW,
    })
    expect(original.phases).toEqual(phasesSnapshot)
    expect(original.attempts).toEqual([])
    expect(result).not.toBe(original)
    expect(result.phases).not.toBe(original.phases)
    expect(result.attempts).not.toBe(original.attempts)
  })

  test("copies evidence at journal time -- a later mutation of the caller's object does not rewrite the attempt", () => {
    const evidence = { txHash: PULL_HASH }
    const r = appendPhase(baseReceipt(), {
      attemptId: 'attempt-1',
      phase: 'pull',
      status: 'confirmed',
      evidence,
      observedAt: NOW,
    })
    evidence.txHash = 'mutated-after-the-fact'
    expect(r.attempts[0].evidence.txHash).toBe(PULL_HASH)
  })

  test('never drops an existing attempt when appending another', () => {
    const r1 = appendPhase(baseReceipt(), {
      attemptId: 'attempt-1',
      phase: 'pull',
      status: 'submitted',
      observedAt: NOW,
    })
    const r2 = appendPhase(r1, {
      attemptId: 'attempt-2',
      phase: 'pull',
      status: 'confirmed',
      observedAt: NOW + 1,
    })
    expect(r2.attempts.map((a) => a.attemptId)).toEqual(['attempt-1', 'attempt-2'])
  })

  test('refuses to downgrade a confirmed phase to any other status', () => {
    const confirmed = appendPhase(baseReceipt(), {
      attemptId: 'attempt-1',
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: PULL_HASH },
      observedAt: NOW,
    })
    expect(() =>
      appendPhase(confirmed, {
        attemptId: 'attempt-2',
        phase: 'pull',
        status: 'failed',
        observedAt: NOW + 1,
      })
    ).toThrow(/confirmed evidence is never removed/)
  })

  test('re-confirming an already-confirmed phase is not a downgrade', () => {
    const confirmed = appendPhase(baseReceipt(), {
      attemptId: 'attempt-1',
      phase: 'pull',
      status: 'confirmed',
      observedAt: NOW,
    })
    const again = appendPhase(confirmed, {
      attemptId: 'attempt-2',
      phase: 'pull',
      status: 'confirmed',
      observedAt: NOW + 1,
    })
    expect(again.phases.pull).toBe('confirmed')
    expect(again.attempts).toHaveLength(2)
  })

  test('rejects an unrecognized phase', () => {
    expect(() =>
      appendPhase(baseReceipt(), { phase: 'withdraw', status: 'confirmed', observedAt: NOW })
    ).toThrow(/unknown phase/)
  })

  test('rejects an unrecognized phase status', () => {
    expect(() =>
      appendPhase(baseReceipt(), { phase: 'pull', status: 'done', observedAt: NOW })
    ).toThrow(/unknown phase status/)
  })

  test('rejects a non-integer observedAt', () => {
    expect(() =>
      appendPhase(baseReceipt(), { phase: 'pull', status: 'submitted', observedAt: 'not-a-number' })
    ).toThrow(/observedAt must be an integer/)
  })

  test('rejects a malformed receipt with a named error instead of a raw TypeError', () => {
    expect(() =>
      appendPhase({ phases: {}, custody: {} }, { phase: 'pull', status: 'submitted' })
    ).toThrow(/receipt.attempts must be an array/)
    expect(() =>
      appendPhase({ custody: {}, attempts: [] }, { phase: 'pull', status: 'submitted' })
    ).toThrow(/receipt.phases must be an object/)
  })
})

describe('confirmCustody', () => {
  test('confirms stellar-agent custody only after an exact successful pull', () => {
    const r = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    expect(r.custody).toEqual({
      location: 'stellar-agent',
      confirmed: true,
      amount: AMOUNT,
      reason: null,
    })
  })

  // Redesigned per the controller ruling: ambiguous evidence must not throw, and must not
  // un-confirm the last proven custody (here, still the axiomatic owner/confirmed opening state).
  test('an ambiguous pull does not confirm stellar-agent custody -- keeps the last proven location instead', () => {
    const r = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: false,
      amount: AMOUNT,
    })
    expect(r.custody.location).toBe('owner')
    expect(r.custody.confirmed).toBe(true)
    expect(r.custody.amount).toEqual(AMOUNT)
    expect(r.custody.reason).toMatch(/claimed without evidence meeting its confirmation bar/)
  })

  test('confirms stellar-vault custody only after transaction success plus a matching event', () => {
    const afterPull = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    const r = confirmCustody(afterPull, {
      location: 'stellar-vault',
      txSuccess: true,
      matchingEvent: true,
      amount: AMOUNT,
    })
    expect(r.custody).toEqual({
      location: 'stellar-vault',
      confirmed: true,
      amount: AMOUNT,
      reason: null,
    })
  })

  // Mandatory mutation target (redesigned): "Let stellar-vault/confirmed be set on transaction
  // success alone, without the matching event -> RED." Controller ruling's own worked example:
  // after a confirmed pull, an ambiguous deposit does not make custody unknown -- the funds are
  // provably still at the agent, so the last PROVEN location (stellar-agent) is kept.
  test('an ambiguous deposit does not confirm stellar-vault custody on transaction success alone -- keeps stellar-agent', () => {
    const afterPull = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    const r = confirmCustody(afterPull, {
      location: 'stellar-vault',
      txSuccess: true,
      matchingEvent: false,
      amount: AMOUNT,
    })
    expect(r.custody.location).toBe('stellar-agent')
    expect(r.custody.confirmed).toBe(true)
    expect(r.custody.reason).toMatch(/claimed without evidence meeting its confirmation bar/)
  })

  // Parity fix: base-vault is the same "final landing pool" role as stellar-vault, one chain over.
  test('confirms base-vault custody only after transaction success plus a matching event', () => {
    const r = confirmCustody(baseReceipt(), {
      location: 'base-vault',
      txSuccess: true,
      matchingEvent: true,
      amount: AMOUNT,
    })
    expect(r.custody).toEqual({
      location: 'base-vault',
      confirmed: true,
      amount: AMOUNT,
      reason: null,
    })
  })

  test('an ambiguous base-vault deposit does not confirm custody on transaction success alone', () => {
    const r = confirmCustody(baseReceipt(), {
      location: 'base-vault',
      txSuccess: true,
      matchingEvent: false,
      amount: AMOUNT,
    })
    expect(r.custody.location).toBe('owner')
    expect(r.custody.confirmed).toBe(true)
  })

  test('never mutates the input receipt', () => {
    const original = baseReceipt()
    const custodySnapshot = { ...original.custody }
    const result = confirmCustody(original, {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    expect(original.custody).toEqual(custodySnapshot)
    expect(result).not.toBe(original)
    expect(result.custody).not.toBe(original.custody)
  })

  // Mandatory mutation target: "Allow confirmCustody to replace a confirmed custody with a weaker
  // one -> RED." This is a genuinely sufficient-evidence claim (both bars met), not an ambiguous
  // one -- it still throws. Controller ruling point 1: this part of the model is right and stays.
  test('refuses to replace a confirmed custody with a weaker confirmed location', () => {
    const afterPull = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    const afterVault = confirmCustody(afterPull, {
      location: 'stellar-vault',
      txSuccess: true,
      matchingEvent: true,
      amount: AMOUNT,
    })
    expect(() =>
      confirmCustody(afterVault, { location: 'stellar-agent', txSuccess: true, amount: AMOUNT })
    ).toThrow(/confirmed evidence is never removed/)
  })

  // Finding 2: a confirmed custody amount must never be silently dropped by a later confirmation.
  test('refuses to drop a confirmed custody amount when a later confirmation omits it', () => {
    const afterPull = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    expect(() =>
      confirmCustody(afterPull, { location: 'stellar-vault', txSuccess: true, matchingEvent: true })
    ).toThrow(/refusing to drop the confirmed custody amount/)
  })

  test('does not throw when a custody confirmation with no prior amount also has no amount', () => {
    const noAmountReceipt = baseReceipt({ amount: null })
    const r = confirmCustody(noAmountReceipt, { location: 'stellar-agent', txSuccess: true })
    expect(r.custody).toEqual({
      location: 'stellar-agent',
      confirmed: true,
      amount: null,
      reason: null,
    })
  })

  // Redesigned: an explicit ambiguity report must not throw and must not overwrite proven custody.
  test('an explicit unknown-location report never overwrites already-confirmed custody, and does not throw', () => {
    const r = confirmCustody(baseReceipt(), { location: 'unknown', reason: 'RPC gap' })
    expect(r.custody.location).toBe('owner')
    expect(r.custody.confirmed).toBe(true)
    expect(r.custody.amount).toEqual(AMOUNT)
    expect(r.custody.reason).toBe('RPC gap')
  })

  test('records the ambiguity reason without discarding the proven location or amount', () => {
    const afterPull = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    const r = confirmCustody(afterPull, {
      location: 'unknown',
      reason: 'stale NOT_FOUND on deposit read',
    })
    expect(r.custody).toEqual({
      location: 'stellar-agent',
      confirmed: true,
      amount: AMOUNT,
      reason: 'stale NOT_FOUND on deposit read',
    })
  })

  // Mandatory mutation target: "Emit 'agent' instead of 'stellar-agent' -> RED."
  test('emits the server vocabulary "stellar-agent", never the legacy client vocabulary "agent"', () => {
    const r = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    expect(r.custody.location).toBe('stellar-agent')
  })

  // Mandatory mutation target: "Emit a unit value through Number() -> a test using a value above
  // Number.MAX_SAFE_INTEGER must go RED. Do not use a round value -- it round-trips perfectly and
  // distinguishes nothing."
  test('preserves an exact bigint-scale units string above Number.MAX_SAFE_INTEGER without float rounding', () => {
    const hugeUnits = '123456789012345678901234567' // not round -- would drift if passed through Number()
    expect(Number.isSafeInteger(Number(hugeUnits))).toBe(false)
    const hugeAmount = { token: 'USDC', units: hugeUnits, decimals: 7 }
    const r = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: hugeAmount,
    })
    expect(r.custody.amount.units).toBe(hugeUnits)
    expect(typeof r.custody.amount.units).toBe('string')
  })

  test('rejects a non-exact-digit units string rather than coercing it', () => {
    expect(() =>
      confirmCustody(baseReceipt(), {
        location: 'stellar-agent',
        txSuccess: true,
        amount: { token: 'USDC', units: '12.5', decimals: 7 },
      })
    ).toThrow(/units must be an exact/)
  })

  test('rejects a negative decimals value', () => {
    expect(() =>
      confirmCustody(baseReceipt(), {
        location: 'stellar-agent',
        txSuccess: true,
        amount: { token: 'USDC', units: '100', decimals: -1 },
      })
    ).toThrow(/decimals must be a non-negative integer/)
  })

  test('rejects an unrecognized custody location', () => {
    expect(() =>
      confirmCustody(baseReceipt(), { location: 'base-proxy', txSuccess: true })
    ).toThrow(/unknown custody location/)
  })

  test('rejects a malformed receipt with a named error instead of a raw TypeError', () => {
    expect(() =>
      confirmCustody({ phases: {}, attempts: [] }, { location: 'stellar-agent', txSuccess: true })
    ).toThrow(/receipt.custody must be an object/)
  })
})

describe('cross-layer: the real server validator (api/agent-index/models.js)', () => {
  test('a receipt this producer builds is accepted by the real toExecutionReceiptRow, unchanged', () => {
    let r = baseReceipt()
    r = appendPhase(r, {
      attemptId: 'attempt-pull-1',
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: PULL_HASH },
      observedAt: NOW,
    })
    r = appendPhase(r, {
      attemptId: 'attempt-deposit-1',
      phase: 'stellar_deposit',
      status: 'confirmed',
      evidence: { txHash: DEPOSIT_HASH },
      observedAt: NOW + 1,
    })
    r = confirmCustody(r, { location: 'stellar-agent', txSuccess: true, amount: AMOUNT })
    r = confirmCustody(r, {
      location: 'stellar-vault',
      txSuccess: true,
      matchingEvent: true,
      amount: AMOUNT,
    })

    const intentDigest = 'a'.repeat(64) // server computes this in production; a real-shaped stand-in here
    let row
    expect(() => {
      row = toExecutionReceiptRow(r, intentDigest)
    }).not.toThrow()
    expect(row.receipt_format).toBe(2)
    expect(row.custody_location).toBe('stellar-vault')
    expect(row.custody_confirmed).toBe(1)
    expect(row.custody_token).toBe(AMOUNT.token)
    expect(row.custody_units).toBe(AMOUNT.units)
    expect(row.custody_decimals).toBe(AMOUNT.decimals)
    expect(row.pull_status).toBe('confirmed')
    expect(row.stellar_deposit_status).toBe('confirmed')
    expect(row.cctp_burn_status).toBe('not_started')

    for (const attempt of r.attempts) {
      expect(() => toPhaseAttemptRow(attempt)).not.toThrow()
    }
  })

  test('a receipt with parentAllocationId/childId populated survives the real validator', () => {
    const r = createAllocationReceipt({
      networkId: NETWORK_ID,
      executionId: EXECUTION_ID,
      allocationId: `${RUN_ID}:bridge:pool-a`,
      owner: OWNER,
      runId: RUN_ID,
      parentAllocationId: `${RUN_ID}:bridge`,
      childId: 'child-0',
      worker: WORKER,
      agent: AGENT,
      intent: INTENT,
      amount: AMOUNT,
    })
    const intentDigest = 'b'.repeat(64)
    let row
    expect(() => {
      row = toExecutionReceiptRow(r, intentDigest)
    }).not.toThrow()
    expect(row.parent_allocation_id).toBe(`${RUN_ID}:bridge`)
    expect(row.child_id).toBe('child-0')
  })

  test('a receipt whose custody.amount is null survives the real validator', () => {
    const r = createAllocationReceipt({
      networkId: NETWORK_ID,
      executionId: EXECUTION_ID,
      allocationId: ALLOCATION_ID,
      owner: OWNER,
      runId: RUN_ID,
      worker: WORKER,
      agent: AGENT,
      intent: INTENT,
      // amount omitted -- custody.amount stays null
    })
    const intentDigest = 'c'.repeat(64)
    let row
    expect(() => {
      row = toExecutionReceiptRow(r, intentDigest)
    }).not.toThrow()
    expect(row.custody_token).toBeNull()
    expect(row.custody_units).toBeNull()
    expect(row.custody_decimals).toBeNull()
  })

  // Controller ruling: "Test both: the ambiguous path returns a receipt, and an INSERT-time
  // unknown receipt survives toExecutionReceiptRow."
  test('an INSERT-time unknown/unconfirmed receipt survives the real validator', () => {
    const r = baseReceipt({
      amount: null,
      initialCustody: { location: 'unknown', reason: 'reconstructed execution' },
    })
    const intentDigest = 'd'.repeat(64)
    let row
    expect(() => {
      row = toExecutionReceiptRow(r, intentDigest)
    }).not.toThrow()
    expect(row.custody_location).toBe('unknown')
    expect(row.custody_confirmed).toBe(0)
    expect(row.custody_units).toBeNull()
    expect(row.custody_reason).toBe('reconstructed execution')
  })
})
