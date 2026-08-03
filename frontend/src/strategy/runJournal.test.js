// frontend/src/strategy/runJournal.test.js — Strategy Task 6 (Pocket Crew redesign, Wave 1).
// Versioned, non-secret milestone journal per (owner, runId). Persists what happened (never
// what to do about it) so a page reload can restore the last confirmed milestone instead of
// guessing. Loading is READ-ONLY: it never calls grant/pull/burn/deposit/withdraw -- it hands
// back a `resumeAction` and lets the caller decide, with an explicit user action required before
// any idempotent continuation.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  RUN_MILESTONES,
  pullMilestone,
  depositMilestone,
  baseJobMilestone,
  appendMilestone,
  loadRunJournal,
  clearRunJournal,
} from './runJournal.js'

const OWNER = 'GCIOUP4UJAAFDBJNP5DY5CFJHBLEKGLHZ5E2AYRIIQ5VOZFVSTPRYHNS'
const OTHER_OWNER = 'GA2CMBS3LRY5MH64KKMHOYVA6WTLPMKRMIWEJDOIGHYPB7WMC3QHRCBU'
const RUN_ID = 'run-1'
const PLAN_FP = '0xplan'
const AGENT_FP = '0xagents'
const RECEIPT_FP = '0xreceipt'
const SECRET = 'SDNJDG6MB2WNZ2VVK5FIHCMPHR7DUGRC6L4LNXGY26YZ6TBRVR23Z2DZ' // realistic-looking secret shape

beforeEach(() => {
  const store = {}
  vi.stubGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
  })
})

describe('RUN_MILESTONES', () => {
  it('is the exact versioned non-secret milestone vocabulary from the brief', () => {
    expect(RUN_MILESTONES).toEqual({
      PLAN_READY: 'plan-ready',
      PERMISSION_REVIEWED: 'permission-reviewed',
      GRANT_REQUESTED: 'grant-requested',
      GRANT_CONFIRMED: 'grant-confirmed',
      REUSE_CONFIRMED: 'reuse-confirmed',
      RECEIPT_READY: 'receipt-ready',
    })
  })

  it('pullMilestone/depositMilestone/baseJobMilestone format per-agent and per-job kinds', () => {
    expect(pullMilestone('worker-1')).toBe('pull-confirmed:worker-1')
    expect(depositMilestone('worker-1')).toBe('deposit-confirmed:worker-1')
    expect(baseJobMilestone('job-1', 'submitted')).toBe('base-job:job-1:submitted')
  })
})

describe('appendMilestone + loadRunJournal round trip', () => {
  it('records a permission milestone with runId/planFingerprint/agentInitFingerprint/grantReceiptFingerprint', () => {
    appendMilestone({
      owner: OWNER,
      runId: RUN_ID,
      kind: RUN_MILESTONES.GRANT_CONFIRMED,
      planFingerprint: PLAN_FP,
      agentInitFingerprint: AGENT_FP,
      grantReceiptFingerprint: RECEIPT_FP,
    })
    const journal = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(journal.runId).toBe(RUN_ID)
    expect(journal.planFingerprint).toBe(PLAN_FP)
    expect(journal.agentInitFingerprint).toBe(AGENT_FP)
    expect(journal.grantReceiptFingerprint).toBe(RECEIPT_FP)
    expect(journal.milestones).toContain('grant-confirmed')
  })

  it('grantReceiptFingerprint is absent when the milestone has none yet (e.g. plan-ready)', () => {
    appendMilestone({
      owner: OWNER,
      runId: RUN_ID,
      kind: RUN_MILESTONES.PLAN_READY,
      planFingerprint: PLAN_FP,
    })
    const journal = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(journal.grantReceiptFingerprint).toBeNull()
  })

  it('returns null when nothing is stored for that (owner, runId)', () => {
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID })).toBeNull()
  })

  it('records per-agent and per-job milestones distinctly', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: pullMilestone('a') })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: depositMilestone('a') })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: baseJobMilestone('job-1', 'submitted') })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: baseJobMilestone('job-1', 'bridged') })
    const journal = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(journal.milestones).toEqual(
      expect.arrayContaining([
        'grant-confirmed',
        'pull-confirmed:a',
        'deposit-confirmed:a',
        'base-job:job-1:submitted',
        'base-job:job-1:bridged',
      ])
    )
  })
})

describe('monotonic / idempotent writes', () => {
  it('writing the same milestone twice does not duplicate it', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PLAN_READY })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PLAN_READY })
    const journal = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(journal.milestones.filter((m) => m === 'plan-ready')).toHaveLength(1)
  })

  it('writing an earlier milestone after a later one is recorded but never regresses resumeAction', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    const afterAdvanced = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PLAN_READY })
    const afterStale = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(afterStale.resumeAction).toBe(afterAdvanced.resumeAction)
    expect(afterStale.milestones).toContain('plan-ready')
    expect(afterStale.milestones).toContain('grant-confirmed')
  })
})

describe('account isolation', () => {
  it("two owners never see each other's journal for the same runId", () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PLAN_READY })
    expect(loadRunJournal({ owner: OTHER_OWNER, runId: RUN_ID })).toBeNull()
    appendMilestone({ owner: OTHER_OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    const mine = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    const theirs = loadRunJournal({ owner: OTHER_OWNER, runId: RUN_ID })
    expect(mine.milestones).toEqual(['plan-ready'])
    expect(theirs.milestones).toEqual(['grant-confirmed'])
  })

  it('treats owner case as non-semantic in the journal key — a mixed-case duplicate resolves to the same row', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PLAN_READY })
    const viaLower = loadRunJournal({ owner: OWNER.toLowerCase(), runId: RUN_ID })
    expect(viaLower).not.toBeNull()
    expect(viaLower.milestones).toEqual(['plan-ready'])
    // Writing through the lower-case form lands in the SAME row, not a shadow duplicate.
    appendMilestone({
      owner: OWNER.toLowerCase(),
      runId: RUN_ID,
      kind: RUN_MILESTONES.GRANT_CONFIRMED,
    })
    const viaOriginal = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(viaOriginal.milestones.sort()).toEqual(['grant-confirmed', 'plan-ready'])
  })
})

describe('corrupt / fingerprint-mismatch cleanup', () => {
  it('self-heals on corrupt stored JSON (treated as no journal)', () => {
    localStorage.setItem('vf.runJournal.v1', '{ not json')
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID })).toBeNull()
  })

  it('drops a tampered row whose recomputed fingerprint no longer matches', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PLAN_READY })
    const all = JSON.parse(localStorage.getItem('vf.runJournal.v1'))
    const key = Object.keys(all)[0]
    all[key].journal.milestones['tampered-injected'] = { at: 0 }
    localStorage.setItem('vf.runJournal.v1', JSON.stringify(all))
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID })).toBeNull()
  })

  it('a new planFingerprint for an existing runId discards the stale milestones instead of mixing them', () => {
    appendMilestone({
      owner: OWNER,
      runId: RUN_ID,
      kind: RUN_MILESTONES.GRANT_CONFIRMED,
      planFingerprint: PLAN_FP,
    })
    appendMilestone({
      owner: OWNER,
      runId: RUN_ID,
      kind: RUN_MILESTONES.PLAN_READY,
      planFingerprint: '0xdifferent-plan',
    })
    const journal = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(journal.planFingerprint).toBe('0xdifferent-plan')
    expect(journal.milestones).toEqual(['plan-ready'])
  })
})

describe('resumeAction (read-only, never invokes grant/pull/burn/deposit/withdraw)', () => {
  it('plan-ready alone offers an explicit resume (nothing irreversible happened)', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PLAN_READY })
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID }).resumeAction).toBe(
      'offer-explicit-resume'
    )
  })

  it('permission-reviewed alone offers an explicit resume', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PERMISSION_REVIEWED })
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID }).resumeAction).toBe(
      'offer-explicit-resume'
    )
  })

  it('an unconfirmed grant-requested (ambiguous wallet outcome) requires reconciliation first', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_REQUESTED })
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID }).resumeAction).toBe('reconcile')
  })

  it('a confirmed fresh grant, execution not yet started, offers an explicit resume', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_REQUESTED })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID }).resumeAction).toBe(
      'offer-explicit-resume'
    )
  })

  it('a confirmed reuse, execution not yet started, offers an explicit resume', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.REUSE_CONFIRMED })
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID }).resumeAction).toBe(
      'offer-explicit-resume'
    )
  })

  it('any mid-execution milestone (pull/deposit/base-job) forces reconciliation before anything else', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: pullMilestone('a') })
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID }).resumeAction).toBe('reconcile')
  })

  it('a completed run (receipt-ready) shows the receipt, nothing to resume', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: pullMilestone('a') })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: depositMilestone('a') })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.RECEIPT_READY })
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID }).resumeAction).toBe('show-receipt')
  })
})

describe('clearRunJournal', () => {
  it('drops the journal for (owner, runId)', () => {
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.PLAN_READY })
    clearRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID })).toBeNull()
  })

  it('no-ops safely on a missing owner/runId', () => {
    expect(() => clearRunJournal({ owner: null, runId: RUN_ID })).not.toThrow()
    expect(() => appendMilestone({ owner: null, runId: RUN_ID, kind: 'plan-ready' })).not.toThrow()
    expect(loadRunJournal({ owner: null, runId: RUN_ID })).toBeNull()
  })
})

describe('secret hygiene', () => {
  it('a journal entry never carries a session secret, even if a careless caller tried to pass one', () => {
    appendMilestone({
      owner: OWNER,
      runId: RUN_ID,
      kind: RUN_MILESTONES.GRANT_CONFIRMED,
      grantReceiptFingerprint: RECEIPT_FP,
      secret: SECRET, // not a real field on appendMilestone's contract -- must never leak through
    })
    const raw = localStorage.getItem('vf.runJournal.v1')
    expect(raw).not.toContain(SECRET)
    const journal = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(JSON.stringify(journal)).not.toContain(SECRET)
  })
})
