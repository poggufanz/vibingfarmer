// frontend/api/agent-index/recovery.test.js — Task 7 Chunk A.
//
// Ordinary selector fixtures use the real `createAllocationReceipt`/`appendPhase`/
// `confirmCustody` producer path. Defensive manual/Base fixtures explicitly say when no production
// orchestrator caller can emit the shape; corrupted closed-vocabulary rows are hand-built only to
// prove totality. There is no shared receipt fixture factory in this repo (map fact H).
//
// `requestRecovery` tests use the SAME `fakeD1()` (node:sqlite `DatabaseSync(':memory:')` running
// the real migration SQL) duplicated verbatim in 5 other test files (store.test.js:22-66 is the
// reference copy) plus the SAME authenticated-proof pattern executionReceipts.test.js already
// established (`issueReceiptChallenge` + a real Ed25519 `Keypair` signature over
// `receiptProofMessage`).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Keypair } from '@stellar/stellar-sdk'
import { createAgentIndexStore } from './store.js'
import {
  applyAuthenticatedReceiptMutation,
  issueReceiptChallenge,
  receiptProofMessage,
  receiptRequestDigest,
} from './executionReceipts.js'
import { requestRecovery } from './handler.js'
import { RECOVERY_REASON_CODES, selectRecoveryAction } from './recovery.js'
import {
  createAllocationReceipt,
  appendPhase,
  confirmCustody,
} from '../../src/strategy/allocationReceipt.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

// ── same in-memory-D1 helper as store.test.js / handler.test.js (map fact H) ──
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0001_vf_gate.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0002_agent_index.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0003_agent_index_bounds.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0004_agent_associations.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0005_execution_receipts.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0006_base_child_intents.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, '0007_agent_membership_owner_pages.sql'), 'utf8'))
  function bound(sql, args) {
    return {
      run() {
        const info = sqlite.prepare(sql).run(...args)
        return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } }
      },
      first(column) {
        const row = sqlite.prepare(sql).get(...args)
        if (!row) return null
        return column ? row[column] : row
      },
      all() {
        const rows = sqlite.prepare(sql).all(...args)
        return { success: true, results: rows }
      },
    }
  }
  return {
    prepare(sql) {
      return { bind: (...args) => bound(sql, args) }
    },
    batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((s) => s.run())
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
    _raw: sqlite,
  }
}

const NETWORK = 'stellar-testnet'
const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21)).publicKey()
const AGENT = 'CAUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSSKJJFEUSS3Y4'
const OTHER_AGENT = 'CAVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCUKRKFIVCVLQ3'
const SESSION = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 22))
const NOW = 2_000_000_000_000
const AMOUNT = { token: 'USDC', units: '1000000', decimals: 6 }
const VALID_V3_EXECUTION_ID = '0x' + 'ab'.repeat(32)

function authority(overrides = {}) {
  return {
    routerOwner: OWNER,
    scope: { owner: OWNER, revoked: false, expiry: BigInt(Math.floor(NOW / 1000) + 3600) },
    signer: SESSION.rawPublicKey(),
    scopeLedger: 42,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// selectRecoveryAction: pure state-table rows, built through the real producer
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Matches createEvidenceRecorder's own construction (orchestrator.js:149-164): fresh receipt,
// version 2, custody opens at owner/confirmed with no evidence needed (allocationReceipt.js's own
// axiomatic pre-movement default).
function freshReceipt(overrides = {}) {
  return createAllocationReceipt({
    networkId: NETWORK,
    executionId: 'run-1:exec:run-1:deposit:0',
    allocationId: 'run-1:deposit:0',
    owner: OWNER,
    runId: 'run-1',
    worker: 'GWORKERPUBKEY0000000000000000000000000000000000000000000',
    agent: AGENT,
    intent: { allocationId: 'run-1:deposit:0', kind: 'deposit', allocation: AMOUNT },
    amount: AMOUNT,
    ...overrides,
  })
}

describe('selectRecoveryAction (pure state table)', () => {
  it('exports the stable machine-readable reason-code contract', () => {
    expect(RECOVERY_REASON_CODES).toEqual({
      NO_RECEIPT: 'no-receipt',
      BASE_EVIDENCE_UNAVAILABLE: 'base-evidence-unavailable',
      CUSTODY_EVIDENCE_GAP: 'custody-evidence-gap',
      CONTRADICTORY_STELLAR_EVIDENCE: 'contradictory-stellar-evidence',
      PULL_NOT_STARTED: 'pull-not-started',
      PULL_FAILED: 'pull-failed',
      PULL_V3_UNCERTAIN: 'pull-v3-uncertain',
      PULL_V2_UNCERTAIN: 'pull-v2-uncertain',
      PULL_STATUS_UNRECOGNIZED: 'pull-status-unrecognized',
      DEPOSIT_CONFIRMED: 'deposit-confirmed',
      DEPOSIT_NOT_STARTED: 'deposit-not-started',
      DEPOSIT_FAILED: 'deposit-failed',
      DEPOSIT_UNCERTAIN: 'deposit-uncertain',
      DEPOSIT_STATUS_UNRECOGNIZED: 'deposit-status-unrecognized',
    })
  })

  it('R1: an absent receipt (never submitted) permits exactly one pull', () => {
    // Producer: absence itself -- readExecutionReceipt returns null when the run crashed before
    // its first evidence POST ever succeeded (map fact A/E: "not_started" is never persisted).
    expect(selectRecoveryAction(null)).toMatchObject({ action: 'pull', phase: 'pull' })
  })

  it('a freshly created, never-attempted receipt also permits exactly one pull', () => {
    // Producer: createAllocationReceipt() alone, before any record() call -- phases.pull is its
    // creation-time 'not_started' default (allocationReceipt.js:135-137).
    const receipt = freshReceipt()
    expect(receipt.phases.pull).toBe('not_started')
    expect(selectRecoveryAction(receipt)).toMatchObject({ action: 'pull', phase: 'pull' })
  })

  it('R2: an uncertain pull carrying v3ExecutionId resubmits the identical envelope', () => {
    // Producer: orchestrator.js:830-837 (dispatchPermissioned) spreads v3EvidenceExtra into the
    // pull:submitted evidence whenever the pull ran through pull_v3.
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'submitted',
      evidence: { v3ExecutionId: VALID_V3_EXECUTION_ID },
    })
    expect(selectRecoveryAction(receipt)).toMatchObject({
      action: 'resubmit-identical-envelope',
      phase: 'pull',
    })
  })

  it.each([
    'x',
    true,
    {},
    [VALID_V3_EXECUTION_ID],
    { toString: VALID_V3_EXECUTION_ID },
    '0x' + 'AB'.repeat(32),
    '0x' + 'ab'.repeat(31),
  ])('rejects malformed truthy v3ExecutionId %j and fails closed to poll', (v3ExecutionId) => {
    // appendPhase and receipt persistence accept free-form JSON attempt evidence. Only a string
    // with the exact bytes32 wire shape proves the V3 replay guard; JSON coercion is not proof.
    const receipt = appendPhase(freshReceipt(), {
      phase: 'pull',
      status: 'submitted',
      evidence: { v3ExecutionId },
    })
    expect(() => selectRecoveryAction(receipt)).not.toThrow()
    expect(selectRecoveryAction(receipt)).toMatchObject({
      action: 'poll',
      reasonCode: RECOVERY_REASON_CODES.PULL_V2_UNCERTAIN,
    })
  })

  it('R3: an uncertain pull with NO v3ExecutionId polls and never resubmits (the double-spend guard)', () => {
    // Producer: orchestrator.js:882-890, the pull's VF_SUBMISSION_UNKNOWN catch branch when v3Exec
    // is null (a V2/legacy dispatch) -- no v3EvidenceExtra is spread in.
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'unknown',
      evidence: { reason: 'relay timeout', txHash: null },
    })
    receipt = confirmCustody(receipt, { location: 'unknown', reason: 'relay timeout' })
    const decision = selectRecoveryAction(receipt)
    expect(decision.action).toBe('poll')
    expect(decision.action).not.toBe('resubmit-identical-envelope')
  })

  it('R4: confirmed agent custody permits deposit and forbids pull', () => {
    // Producer: orchestrator.js:867-876 -- record(pull:confirmed) followed by
    // custody({location:'stellar-agent', txSuccess:true}), both landed before the crash.
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: 'tx-1' },
    })
    receipt = confirmCustody(receipt, {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    const decision = selectRecoveryAction(receipt)
    expect(decision.action).toBe('deposit')
    expect(decision.action).not.toBe('pull')
  })

  it('never re-pulls when pull is confirmed but the trailing custody write has not landed yet', () => {
    // Producer: orchestrator.js:867-871 posts pull:confirmed as its OWN record() call; the
    // custody({location:'stellar-agent',...}) call happens AFTER, purely in-memory, and is only
    // carried to the server on the NEXT record() call (stellar_deposit:'submitted', line 915). A
    // crash between these two lines persists exactly this: pull_status='confirmed' with
    // custody_location still 'owner'. See report `## Brief divergences` for the full trace. This
    // is the single most serious defect this selector must avoid (brief): once phases.pull is
    // confirmed, pull must never fire again even though custody itself is stale.
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: 'tx-1' },
    })
    expect(receipt.custody).toMatchObject({ location: 'owner', confirmed: true })
    const decision = selectRecoveryAction(receipt)
    expect(decision.action).not.toBe('pull')
    expect(decision.action).toBe('deposit')
  })

  it('R5: a confirmed deposit phase is complete', () => {
    // Producer: orchestrator.js:923-927 (record(stellar_deposit:confirmed)) followed by
    // custody({location:'stellar-vault', txSuccess:true, matchingEvent:true}).
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: 'tx-1' },
    })
    receipt = confirmCustody(receipt, {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    receipt = appendPhase(receipt, {
      phase: 'stellar_deposit',
      status: 'confirmed',
      evidence: { txHash: 'tx-2' },
    })
    receipt = confirmCustody(receipt, {
      location: 'stellar-vault',
      txSuccess: true,
      matchingEvent: true,
      amount: AMOUNT,
    })
    expect(selectRecoveryAction(receipt)).toMatchObject({ action: 'complete', phase: null })
  })

  it('is complete even when the terminal stellar-vault custody write never lands (verified producer gap)', () => {
    // Producer: orchestrator.js's dispatch loop calls record(stellar_deposit:confirmed) then
    // custody({location:'stellar-vault',...}) with NO further record() call afterward in the
    // success branch (confirmed by exhaustive reading -- there is no "final sync" write). So the
    // custody('stellar-vault') update is NEVER posted to the durable server-side receipt today;
    // custody_location persists at 'stellar-agent' forever even though the deposit fully
    // succeeded. selectRecoveryAction must treat phases.stellar_deposit==='confirmed' alone as
    // terminal, not require custody.location==='stellar-vault' (see report divergence).
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: 'tx-1' },
    })
    receipt = confirmCustody(receipt, {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    receipt = appendPhase(receipt, {
      phase: 'stellar_deposit',
      status: 'confirmed',
      evidence: { txHash: 'tx-2' },
    })
    expect(receipt.custody.location).toBe('stellar-agent')
    expect(selectRecoveryAction(receipt)).toMatchObject({ action: 'complete', phase: null })
  })

  it('a failed pull that moved no money permits a fresh pull', () => {
    // Producer: orchestrator.js:893-897, the pull's plain-Error catch branch -- no custody() call
    // at all, so custody stays at its owner/confirmed creation default.
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'failed',
      evidence: { reason: 'relay down' },
    })
    expect(receipt.custody).toMatchObject({ location: 'owner', confirmed: true })
    expect(selectRecoveryAction(receipt)).toMatchObject({ action: 'pull', phase: 'pull' })
  })

  it.each([
    ['failed', 'confirmed'],
    ['not_started', 'confirmed'],
    ['failed', 'submitted'],
    ['not_started', 'failed'],
  ])(
    'fails closed for contradictory owner custody with pull:%s and stellar_deposit:%s',
    (pullStatus, depositStatus) => {
      // No current production caller emits this cross-phase contradiction: both orchestrator
      // loops advance pull/custody before recording a deposit. The schema producer accepts it,
      // however, and the binding review requires these corruption/future-writer shapes to block.
      let receipt = freshReceipt()
      if (pullStatus !== 'not_started') {
        receipt = appendPhase(receipt, {
          phase: 'pull',
          status: pullStatus,
          evidence: { reason: 'fixture contradiction' },
        })
      }
      receipt = appendPhase(receipt, {
        phase: 'stellar_deposit',
        status: depositStatus,
        evidence: { reason: 'fixture contradiction' },
      })
      expect(receipt.custody).toMatchObject({ location: 'owner', confirmed: true })
      expect(selectRecoveryAction(receipt)).toMatchObject({
        action: 'manual-review',
        phase: null,
        reasonCode: RECOVERY_REASON_CODES.CONTRADICTORY_STELLAR_EVIDENCE,
      })
    }
  )

  it('keeps every defensive manual-review branch non-actionable with phase:null', () => {
    // None of these five shapes has a current production caller: they are constructor-only,
    // schema-allowed contradictions, or corrupted closed-vocabulary rows. They exist solely to
    // pin the fail-closed selector contract; they are not claimed as live producer evidence.
    const custodyGap = createAllocationReceipt({
      networkId: NETWORK,
      executionId: 'exec-gap',
      allocationId: 'alloc-gap',
      owner: OWNER,
      runId: 'run-gap',
      worker: 'worker-gap',
      agent: AGENT,
      intent: {},
      initialCustody: { location: 'unknown', reason: 'unobserved' },
    })
    const contradiction = appendPhase(freshReceipt(), {
      phase: 'stellar_deposit',
      status: 'failed',
      evidence: {},
    })
    const unknownPull = {
      ...freshReceipt(),
      phases: { ...freshReceipt().phases, pull: 'corrupt' },
    }
    let vaultContradiction = appendPhase(freshReceipt(), {
      phase: 'pull',
      status: 'confirmed',
      evidence: {},
    })
    vaultContradiction = confirmCustody(vaultContradiction, {
      location: 'stellar-vault',
      txSuccess: true,
      matchingEvent: true,
      amount: AMOUNT,
    })
    let unknownDeposit = appendPhase(freshReceipt(), {
      phase: 'pull',
      status: 'confirmed',
      evidence: {},
    })
    unknownDeposit = confirmCustody(unknownDeposit, {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    unknownDeposit = {
      ...unknownDeposit,
      phases: { ...unknownDeposit.phases, stellar_deposit: 'corrupt' },
    }

    for (const receipt of [
      custodyGap,
      contradiction,
      unknownPull,
      vaultContradiction,
      unknownDeposit,
    ]) {
      expect(selectRecoveryAction(receipt)).toMatchObject({
        action: 'manual-review',
        phase: null,
      })
    }
  })

  it('a failed deposit retries the deposit (never re-pulls) while funds remain with the agent', () => {
    // Producer: orchestrator.js:948-952, the deposit's plain-failure branch.
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: 'tx-1' },
    })
    receipt = confirmCustody(receipt, {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    receipt = appendPhase(receipt, {
      phase: 'stellar_deposit',
      status: 'failed',
      evidence: { reason: 'shares not minted' },
    })
    expect(selectRecoveryAction(receipt)).toMatchObject({
      action: 'deposit',
      phase: 'stellar_deposit',
    })
  })

  it('an uncertain deposit polls rather than resubmitting (deposit idempotency is not established)', () => {
    // Producer: orchestrator.js:941-946, the deposit's VF_SUBMISSION_UNKNOWN branch.
    let receipt = freshReceipt()
    receipt = appendPhase(receipt, {
      phase: 'pull',
      status: 'confirmed',
      evidence: { txHash: 'tx-1' },
    })
    receipt = confirmCustody(receipt, {
      location: 'stellar-agent',
      txSuccess: true,
      amount: AMOUNT,
    })
    receipt = appendPhase(receipt, {
      phase: 'stellar_deposit',
      status: 'unknown',
      evidence: { reason: 'worker timeout' },
    })
    receipt = confirmCustody(receipt, { location: 'unknown', reason: 'worker timeout' })
    const decision = selectRecoveryAction(receipt)
    expect(decision.action).toBe('poll')
    expect(decision.phase).toBe('stellar_deposit')
  })

  it('R6: every Base-touching receipt fails closed to blocked-reconcile naming the missing producer (S2-D8)', () => {
    // Producer: confirmCustody/appendPhase are general-purpose pure functions -- fully capable of
    // constructing these shapes even though no CURRENT orchestrator.js code path drives them this
    // way (map fact A: the Base leg never writes to execution_receipts at all today). The
    // fail-closed verdict exists precisely so a FUTURE Base evidence producer lands safely; see
    // report `## Brief divergences` for why this fixture is producer-backed at the function level.
    const custodyCase = confirmCustody(freshReceipt(), {
      location: 'cctp-transit',
      txSuccess: true,
      matchingEvent: true,
      amount: AMOUNT,
    })
    const custodyDecision = selectRecoveryAction(custodyCase)
    expect(custodyDecision.action).toBe('blocked-reconcile')
    expect(custodyDecision.reason).toMatch(/nonce|attestation|UserOperation/i)
    expect(custodyDecision.reason).not.toBe('')

    const burnCase = appendPhase(freshReceipt(), {
      phase: 'cctp_burn',
      status: 'submitted',
      evidence: {},
    })
    const burnDecision = selectRecoveryAction(burnCase)
    expect(burnDecision.action).toBe('blocked-reconcile')
    expect(burnDecision.reason).toMatch(/nonce|attestation|UserOperation/i)

    const vaultCase = confirmCustody(freshReceipt(), {
      location: 'base-vault',
      txSuccess: true,
      matchingEvent: true,
      amount: AMOUNT,
    })
    expect(selectRecoveryAction(vaultCase)).toMatchObject({ action: 'blocked-reconcile' })
  })

  it('R11: every producible (phase, status) crash point maps to a safe, defined action', () => {
    // The complete producible set per map fact A: only `pull` and `stellar_deposit` are ever
    // recorded, each with statuses {submitted, confirmed, unknown, failed}. Each row below
    // reconstructs the EXACT receipt state a crash at that point would leave, replaying the same
    // record()/custody() call sequence orchestrator.js performs up to (and stopping at) the crash.
    const cases = [
      // -- pull phase (custody has not moved past owner at the crash point) --
      [
        'pull:submitted (mid-pull, no outcome yet -- orchestrator.js:833-837)',
        () => appendPhase(freshReceipt(), { phase: 'pull', status: 'submitted', evidence: {} }),
        'poll',
      ],
      [
        'pull:confirmed, trailing custody write not yet landed (orchestrator.js:867-871)',
        () =>
          appendPhase(freshReceipt(), {
            phase: 'pull',
            status: 'confirmed',
            evidence: { txHash: 't' },
          }),
        'deposit',
      ],
      [
        'pull:unknown (orchestrator.js:882-891)',
        () => {
          let r = appendPhase(freshReceipt(), {
            phase: 'pull',
            status: 'unknown',
            evidence: { reason: 'x' },
          })
          return confirmCustody(r, { location: 'unknown', reason: 'x' })
        },
        'poll',
      ],
      [
        'pull:failed (orchestrator.js:893-897)',
        () =>
          appendPhase(freshReceipt(), {
            phase: 'pull',
            status: 'failed',
            evidence: { reason: 'x' },
          }),
        'pull',
      ],
      // -- stellar_deposit phase (pull already confirmed/skipped -- custody at stellar-agent) --
      [
        'stellar_deposit:submitted (orchestrator.js:915-919)',
        () => {
          let r = appendPhase(freshReceipt(), {
            phase: 'pull',
            status: 'confirmed',
            evidence: { txHash: 't' },
          })
          r = confirmCustody(r, { location: 'stellar-agent', txSuccess: true, amount: AMOUNT })
          return appendPhase(r, { phase: 'stellar_deposit', status: 'submitted', evidence: {} })
        },
        'poll',
      ],
      [
        'stellar_deposit:confirmed, trailing vault custody write not yet landed (orchestrator.js:923-936)',
        () => {
          let r = appendPhase(freshReceipt(), {
            phase: 'pull',
            status: 'confirmed',
            evidence: { txHash: 't' },
          })
          r = confirmCustody(r, { location: 'stellar-agent', txSuccess: true, amount: AMOUNT })
          return appendPhase(r, {
            phase: 'stellar_deposit',
            status: 'confirmed',
            evidence: { txHash: 't2' },
          })
        },
        'complete',
      ],
      [
        'stellar_deposit:unknown (orchestrator.js:941-946)',
        () => {
          let r = appendPhase(freshReceipt(), {
            phase: 'pull',
            status: 'confirmed',
            evidence: { txHash: 't' },
          })
          r = confirmCustody(r, { location: 'stellar-agent', txSuccess: true, amount: AMOUNT })
          r = appendPhase(r, {
            phase: 'stellar_deposit',
            status: 'unknown',
            evidence: { reason: 'x' },
          })
          return confirmCustody(r, { location: 'unknown', reason: 'x' })
        },
        'poll',
      ],
      [
        'stellar_deposit:failed (orchestrator.js:948-952)',
        () => {
          let r = appendPhase(freshReceipt(), {
            phase: 'pull',
            status: 'confirmed',
            evidence: { txHash: 't' },
          })
          r = confirmCustody(r, { location: 'stellar-agent', txSuccess: true, amount: AMOUNT })
          return appendPhase(r, {
            phase: 'stellar_deposit',
            status: 'failed',
            evidence: { reason: 'x' },
          })
        },
        'deposit',
      ],
    ]
    for (const [label, build, expectedAction] of cases) {
      const receipt = build()
      const decision = selectRecoveryAction(receipt)
      expect(decision.action, label).toBe(expectedAction)
      expect(typeof decision.action).toBe('string')
      expect(Object.values(RECOVERY_REASON_CODES)).toContain(decision.reasonCode)
      expect(decision.reason.length > 0, label).toBe(true)
    }
  })

  it('is total: an unrecognized phase status still returns a defined, fail-closed action, never throws/undefined', () => {
    // Not producer-backed (RECEIPT_PHASE_STATUSES is a closed, enforced vocabulary) -- a pure
    // defensive/totality check, hand-built past the real producer's own validation on purpose.
    const receipt = {
      ...freshReceipt(),
      phases: { ...freshReceipt().phases, pull: 'weird-status' },
    }
    const decision = selectRecoveryAction(receipt)
    expect(decision.action).toBeTypeOf('string')
    expect(decision.action).toBe('manual-review')
    expect(decision).toMatchObject({ phase: null, reasonCode: 'pull-status-unrecognized' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// requestRecovery: authenticated lease claim
// ─────────────────────────────────────────────────────────────────────────────────────────────

function baseRequest(overrides = {}) {
  return {
    executionId: 'run-2:exec:run-2:deposit:0',
    allocationId: 'run-2:deposit:0',
    childId: null,
    expectedReceiptVersion: 0,
    leaseOwner: 'holder-a',
    ...overrides,
  }
}

async function signedRecoveryArgs({
  store,
  request,
  challengeId,
  authorityFacts = authority(),
  signer = SESSION,
  owner = OWNER,
  agent = AGENT,
  issuedAt = NOW,
  appliedAt = NOW,
  leaseTtlMs,
}) {
  const digest = receiptRequestDigest(request)
  const challenge = await issueReceiptChallenge({
    request: { networkId: NETWORK, owner, agent, requestDigest: digest },
    store,
    authorityReader: async () => authorityFacts,
    now: issuedAt,
    challengeId,
  })
  const signature = signer
    .sign(Buffer.from(receiptProofMessage(challenge), 'utf8'))
    .toString('base64url')
  return {
    request,
    proof: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, signature },
    store,
    authorityReader: async () => authorityFacts,
    now: appliedAt,
    ...(leaseTtlMs != null ? { leaseTtlMs } : {}),
  }
}

async function claim(options) {
  return requestRecovery(await signedRecoveryArgs(options))
}

function recoveryReceipt() {
  return createAllocationReceipt({
    networkId: NETWORK,
    owner: OWNER,
    executionId: 'run-2:exec:run-2:deposit:0',
    runId: 'run-2',
    allocationId: 'run-2:deposit:0',
    parentAllocationId: null,
    childId: null,
    worker: 'worker-0',
    agent: AGENT,
    intent: { kind: 'deposit', token: 'USDC', units: '1000000', decimals: 6 },
    amount: AMOUNT,
  })
}

function mutationReceipt() {
  return appendPhase(recoveryReceipt(), { phase: 'pull', status: 'submitted', evidence: {} })
}

async function seedReceipt({
  store,
  receipt = mutationReceipt(),
  attempt,
  expectedVersion = 0,
  challengeId,
}) {
  const body = {
    expectedVersion,
    receipt,
    attempt: attempt ?? {
      attemptId: `attempt-${challengeId}`,
      kind: 'phase',
      phase: 'pull',
      status: 'submitted',
      evidence: {},
      observedAt: NOW,
    },
  }
  const digest = receiptRequestDigest(body)
  const challenge = await issueReceiptChallenge({
    request: {
      networkId: NETWORK,
      owner: receipt.owner,
      agent: receipt.agent,
      requestDigest: digest,
    },
    store,
    authorityReader: async () =>
      authority({ routerOwner: receipt.owner, scope: { owner: receipt.owner, revoked: false } }),
    now: NOW,
    challengeId,
  })
  const signature = SESSION.sign(Buffer.from(receiptProofMessage(challenge), 'utf8')).toString(
    'base64url'
  )
  return applyAuthenticatedReceiptMutation({
    body,
    proof: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, signature },
    store,
    authorityReader: async () =>
      authority({ routerOwner: receipt.owner, scope: { owner: receipt.owner, revoked: false } }),
    now: NOW,
    consumeToken: `consume-${challengeId}`,
  })
}

let db
let store

beforeEach(() => {
  db = fakeD1()
  store = createAgentIndexStore(db)
})

describe('requestRecovery (authenticated lease claim)', () => {
  it('claims the pull lease and returns pull for a never-submitted execution', async () => {
    const result = await claim({ store, request: baseRequest(), challengeId: 'challenge-fresh' })
    expect(result).toMatchObject({
      ok: true,
      action: 'pull',
      phase: 'pull',
      version: 0,
      receipt: null,
    })
    expect(result.lease).toMatchObject({ holder: 'holder-a', phase: 'pull' })
    expect(result.lease.leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(result.lease.leaseToken).not.toBe('holder-a')
  })

  it('consumes a successful recovery proof so the same signed challenge cannot replay', async () => {
    const args = await signedRecoveryArgs({
      store,
      request: baseRequest(),
      challengeId: 'challenge-one-time',
    })
    await expect(requestRecovery(args)).resolves.toMatchObject({ ok: true })
    await expect(requestRecovery(args)).rejects.toMatchObject({ code: 'replay' })
    await expect(
      store.readReceiptChallenge({ challengeId: 'challenge-one-time' })
    ).resolves.toMatchObject({ consumedAt: NOW })
  })

  it('R7: forged wire custody/action fields never change the decision -- it comes only from stored evidence', async () => {
    // The receipt evidence backing this claim is genuinely absent (never submitted), so the ONLY
    // safe action is 'pull'. `request` here carries extra, digest-bound-but-never-read fields
    // (`custody`, `action`) an attacker fully controls (they can sign anything they like) -- if
    // requestRecovery/selectRecoveryAction ever consulted them, the decision would flip to
    // 'complete' and a caller could talk itself out of ever pulling. This is mutation-proved in
    // the chunk report.
    const forged = baseRequest({
      custody: { location: 'stellar-vault', confirmed: true },
      action: 'complete',
    })
    const result = await claim({ store, request: forged, challengeId: 'challenge-forged' })
    expect(result.ok).toBe(true)
    expect(result.action).toBe('pull')
    expect(result.action).not.toBe('complete')
  })

  it.each([
    [
      'manual-review',
      () =>
        appendPhase(recoveryReceipt(), {
          phase: 'stellar_deposit',
          status: 'failed',
          evidence: { reason: 'contradictory persisted evidence' },
        }),
    ],
    [
      'blocked-reconcile',
      () =>
        appendPhase(recoveryReceipt(), {
          phase: 'cctp_burn',
          status: 'submitted',
          evidence: {},
        }),
    ],
  ])('returns %s with phase:null and claims no lease', async (action, buildReceipt) => {
    // Neither defensive fixture has a current production wire producer: orchestrator never emits
    // the contradiction and the Base leg never writes execution_receipts. This assertion covers
    // the requestRecovery no-lease contract required for any such stored/future-writer row.
    const receipt = buildReceipt()
    vi.spyOn(store, 'readExecutionReceipt').mockResolvedValue(receipt)
    const result = await claim({
      store,
      request: baseRequest({ expectedReceiptVersion: receipt.version }),
      challengeId: `challenge-no-lease-${action}`,
    })
    expect(result).toMatchObject({ ok: true, action, phase: null, lease: null })
    const leaseCount = db._raw
      .prepare('SELECT COUNT(*) AS count FROM execution_recovery_leases')
      .get()
    expect(leaseCount.count).toBe(0)
  })

  it('R8: two concurrent claims for the same (execution, allocation, child, phase) -- exactly one acquires', async () => {
    const request = baseRequest({ leaseOwner: 'ignored-per-call' })
    const results = await Promise.all([
      claim({
        store,
        request: { ...request, leaseOwner: 'holder-a' },
        challengeId: 'challenge-race-a',
      }),
      claim({
        store,
        request: { ...request, leaseOwner: 'holder-b' },
        challengeId: 'challenge-race-b',
      }),
    ])
    const winner = results.find((result) => result.ok)
    const loser = results.find((result) => !result.ok)
    expect(winner).toMatchObject({ ok: true, action: 'pull', phase: 'pull' })
    expect(loser).toMatchObject({ ok: false, status: 409, code: 'lease-conflict' })
    expect(loser.lease).toBeUndefined()
    const leaseRows = db._raw.prepare('SELECT holder FROM execution_recovery_leases').all()
    expect(leaseRows).toEqual([{ holder: winner.lease.holder }])
  })

  it('R9: an expired lease can be taken over by a different holder', async () => {
    const request = baseRequest()
    const first = await claim({
      store,
      request: { ...request, leaseOwner: 'holder-a' },
      challengeId: 'challenge-expiry-a',
      issuedAt: NOW,
      appliedAt: NOW,
    })
    expect(first).toMatchObject({ ok: true })
    const takeover = await claim({
      store,
      request: { ...request, leaseOwner: 'holder-b' },
      challengeId: 'challenge-expiry-b',
      issuedAt: NOW + 61_000,
      appliedAt: NOW + 61_000, // past the default 60s TTL -- caller-supplied clock (map fact D)
    })
    expect(takeover).toMatchObject({ ok: true, action: 'pull' })
    expect(takeover.lease).toMatchObject({ holder: 'holder-b' })
  })

  it('R10: a stale receipt version claims no lease and returns a conflict distinguishable from a lease conflict', async () => {
    await seedReceipt({ store, challengeId: 'challenge-seed-stale' })
    const stale = await claim({
      store,
      request: baseRequest({ expectedReceiptVersion: 0 }), // caller still believes nothing exists
      challengeId: 'challenge-stale-version',
    })
    expect(stale).toMatchObject({ ok: false, status: 409, code: 'version-conflict', version: 1 })
    expect(stale.error).not.toBe('Recovery lease is already held')
    const leaseRows = db._raw
      .prepare('SELECT COUNT(*) AS count FROM execution_recovery_leases')
      .get()
    expect(leaseRows.count).toBe(0)

    const correct = await claim({
      store,
      request: baseRequest({ expectedReceiptVersion: 1 }),
      challengeId: 'challenge-correct-version',
    })
    expect(correct.ok).toBe(true)
  })

  it('R12: a genuine absent receipt has one no-child lease and rejects child-scoped claims', async () => {
    const request = baseRequest()
    const parent = await claim({
      store,
      request: { ...request, childId: null },
      challengeId: 'challenge-child-parent',
    })
    const childClaim = claim({
      store,
      request: { ...request, childId: 'child-1' },
      challengeId: 'challenge-child-child',
    })
    expect(parent).toMatchObject({ ok: true, action: 'pull' })
    await expect(childClaim).rejects.toThrow(/childId.*absent.*receipt/i)
    const leaseRows = db._raw
      .prepare('SELECT child_id FROM execution_recovery_leases ORDER BY child_id')
      .all()
    expect(leaseRows).toEqual([{ child_id: '' }])
  })

  it('R13: a revoked scope blocks with the 403 authority path, not a silent success', async () => {
    const revoked = authority({ scope: { owner: OWNER, revoked: true, expiry: 0n } })
    await expect(
      claim({
        store,
        request: baseRequest(),
        challengeId: 'challenge-revoked',
        authorityFacts: revoked,
      })
    ).rejects.toThrow(/revoked|replacement signer/i)
    const leaseRows = db._raw
      .prepare('SELECT COUNT(*) AS count FROM execution_recovery_leases')
      .get()
    expect(leaseRows.count).toBe(0)
  })

  it('rejects a caller whose proven agent does not match the receipt agent of record', async () => {
    await seedReceipt({ store, challengeId: 'challenge-seed-agent-mismatch' })
    await expect(
      claim({
        store,
        request: baseRequest(),
        challengeId: 'challenge-wrong-agent',
        agent: OTHER_AGENT,
      })
    ).rejects.toThrow(/agent/i)
  })

  it('fails closed (throws) when the store or authority reader is unavailable', async () => {
    await expect(
      requestRecovery({
        request: baseRequest(),
        proof: {},
        store: null,
        authorityReader: async () => authority(),
      })
    ).rejects.toThrow()
    await expect(
      requestRecovery({ request: baseRequest(), proof: {}, store, authorityReader: null })
    ).rejects.toThrow()
  })
})
