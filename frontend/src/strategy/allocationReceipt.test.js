// frontend/src/strategy/allocationReceipt.test.js
//
// allocationReceipt.js is the pure client producer for AllocationReceiptV2 -- the durable receipt
// type whose schema and enforcement already exist server-side (api/agent-index/migrations/
// 0005_execution_receipts.sql, api/agent-index/models.js). The "cross-layer" describe block below
// is the load-bearing check: it imports the REAL `toExecutionReceiptRow`/`toPhaseAttemptRow` from
// the server module and feeds them this producer's actual output, rather than asserting against
// this test's own guess of the expected shape (task-6a-brief.md is explicit that a prior
// cross-layer comparison which could never be equal survived review exactly because the test
// computed its own expectation instead of consulting the real validator).
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

function baseReceipt() {
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
})

describe('confirmCustody', () => {
  test('confirms stellar-agent custody only after an exact successful pull', () => {
    const r = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    expect(r.custody).toEqual({ location: 'stellar-agent', confirmed: true, amount: AMOUNT, reason: null })
  })

  test('refuses stellar-agent custody without a successful pull', () => {
    expect(() =>
      confirmCustody(baseReceipt(), { location: 'stellar-agent', txSuccess: false, amount: AMOUNT })
    ).toThrow(/does not meet its confirmation bar/)
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
    expect(r.custody).toEqual({ location: 'stellar-vault', confirmed: true, amount: AMOUNT, reason: null })
  })

  // Mandatory mutation target: "Let stellar-vault/confirmed be set on transaction success alone,
  // without the matching event -> RED."
  test('refuses to confirm stellar-vault custody on transaction success alone, without the matching event', () => {
    const afterPull = confirmCustody(baseReceipt(), {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    expect(() =>
      confirmCustody(afterPull, {
        location: 'stellar-vault',
        txSuccess: true,
        matchingEvent: false,
        amount: AMOUNT,
      })
    ).toThrow(/does not meet its confirmation bar/)
  })

  test('never mutates the input receipt', () => {
    const original = baseReceipt()
    const custodySnapshot = { ...original.custody }
    const result = confirmCustody(original, { location: 'stellar-agent', txSuccess: true, amount: AMOUNT })
    expect(original.custody).toEqual(custodySnapshot)
    expect(result).not.toBe(original)
    expect(result.custody).not.toBe(original.custody)
  })

  // Mandatory mutation target: "Allow confirmCustody to replace a confirmed custody with a weaker
  // one -> RED."
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

  test('an explicit unknown-location report never overwrites already-confirmed custody', () => {
    expect(() => confirmCustody(baseReceipt(), { location: 'unknown', reason: 'RPC gap' })).toThrow(
      /confirmed evidence is never removed/
    )
  })

  // Mandatory mutation target: "Emit 'agent' instead of 'stellar-agent' -> RED."
  test('emits the server vocabulary "stellar-agent", never the legacy client vocabulary "agent"', () => {
    const r = confirmCustody(baseReceipt(), { location: 'stellar-agent', txSuccess: true, amount: AMOUNT })
    expect(r.custody.location).toBe('stellar-agent')
    expect(r.custody.location).not.toBe('agent')
  })

  // Mandatory mutation target: "Emit a unit value through Number() -> a test using a value above
  // Number.MAX_SAFE_INTEGER must go RED. Do not use a round value -- it round-trips perfectly and
  // distinguishes nothing."
  test('preserves an exact bigint-scale units string above Number.MAX_SAFE_INTEGER without float rounding', () => {
    const hugeUnits = '123456789012345678901234567' // not round -- would drift if passed through Number()
    expect(Number.isSafeInteger(Number(hugeUnits))).toBe(false)
    const hugeAmount = { token: 'USDC', units: hugeUnits, decimals: 7 }
    const r = confirmCustody(baseReceipt(), { location: 'stellar-agent', txSuccess: true, amount: hugeAmount })
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

  test('rejects an unrecognized custody location', () => {
    expect(() => confirmCustody(baseReceipt(), { location: 'base-proxy', txSuccess: true })).toThrow(
      /unknown custody location/
    )
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
    r = confirmCustody(r, { location: 'stellar-vault', txSuccess: true, matchingEvent: true, amount: AMOUNT })

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
})
