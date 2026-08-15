// sessionResume.test.js — wizard resume snapshot persisted per wallet address.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveResume, loadResume, clearResume } from './sessionResume.js'
import { appendMilestone, RUN_MILESTONES, pullMilestone, loadRunJournal } from './runJournal.js'

const ADDR = '0xAbC0000000000000000000000000000000000001'
const RUN_ID = 'run-1'
const STRATEGY = {
  agents: [{ id: 'worker-1', vault: { addr: '0xVault', name: 'A', apy: '4.8' }, allocation: 100 }],
  total: 100,
  blendedApy: '4.8',
}

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

describe('sessionResume', () => {
  it('round-trips a snapshot for an address', () => {
    saveResume(ADDR, { stage: 'done', amount: '100', risk: 'med', strategy: STRATEGY })
    const snap = loadResume(ADDR)
    expect(snap.stage).toBe('done')
    expect(snap.amount).toBe('100')
    expect(snap.risk).toBe('med')
    expect(snap.strategy.agents).toHaveLength(1)
  })

  it('is case-insensitive on address', () => {
    saveResume(ADDR.toLowerCase(), { stage: 'done', amount: '50', risk: 'low', strategy: STRATEGY })
    expect(loadResume(ADDR.toUpperCase())?.amount).toBe('50')
  })

  it('returns null when nothing is stored', () => {
    expect(loadResume(ADDR)).toBeNull()
  })

  it('does NOT persist a snapshot without strategy agents (nothing to resume)', () => {
    saveResume(ADDR, { stage: 'done', amount: '100', risk: 'med', strategy: { agents: [] } })
    expect(loadResume(ADDR)).toBeNull()
  })

  it('returns null and self-heals on corrupt JSON', () => {
    localStorage.setItem('yv_resume_' + ADDR.toLowerCase(), '{ not json')
    expect(loadResume(ADDR)).toBeNull()
    // corrupt entry dropped
    expect(localStorage.getItem('yv_resume_' + ADDR.toLowerCase())).toBeNull()
  })

  it('clears a stored snapshot', () => {
    saveResume(ADDR, { stage: 'done', amount: '100', risk: 'med', strategy: STRATEGY })
    clearResume(ADDR)
    expect(loadResume(ADDR)).toBeNull()
  })

  it('no-ops safely on missing address', () => {
    expect(() => saveResume(null, { strategy: STRATEGY })).not.toThrow()
    expect(loadResume(null)).toBeNull()
    expect(() => clearResume(undefined)).not.toThrow()
  })
})

// A saved strategy snapshot is no longer, by itself, taken to mean the run finished ('done').
// `loadResume` now attaches the safe, journal-derived `resumeAction` (Task 6's runJournal.js) for
// whatever runId the snapshot carries — read-only, never a grant/pull/burn/deposit/withdraw call.
//
// Journal calls below use OWNER (ADDR.toLowerCase()) directly -- the SAME canonical form
// loadResume/clearResume normalize `address` to internally, so these tests exercise a genuine
// match rather than coasting on the fail-closed fallback.
const OWNER = ADDR.toLowerCase()

describe('sessionResume + runJournal (safe resume, replaces the old "any saved strategy = done" assumption)', () => {
  it('a snapshot with no runId (nothing to reconcile against) resolves resumeAction to null', () => {
    saveResume(ADDR, { stage: 'done', amount: '100', risk: 'med', strategy: STRATEGY })
    expect(loadResume(ADDR).resumeAction).toBeNull()
  })

  it('a runId with nothing journaled yet (missing/corrupt/tampered/quota-lost write) fails CLOSED to reconcile, never trusts stale "done"', () => {
    saveResume(ADDR, {
      stage: 'done',
      amount: '100',
      risk: 'med',
      strategy: STRATEGY,
      runId: RUN_ID,
    })
    // no appendMilestone call at all -- simulates a missing/corrupt/never-written journal
    const snap = loadResume(ADDR)
    expect(snap.stage).toBe('done') // the stale field is still there, but is not trusted alone
    expect(snap.resumeAction).toBe('reconcile')
  })

  it('stage="done" alone does NOT imply the run is complete -- mid-execution journal state forces reconcile', () => {
    saveResume(ADDR, {
      stage: 'done',
      amount: '100',
      risk: 'med',
      strategy: STRATEGY,
      runId: RUN_ID,
    })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: pullMilestone('worker-1') })
    const snap = loadResume(ADDR)
    expect(snap.stage).toBe('done') // the stale field is still there, but is not trusted alone
    expect(snap.resumeAction).toBe('reconcile')
  })

  it('a completed run journal (receipt-ready) resolves resumeAction to show-receipt', () => {
    saveResume(ADDR, {
      stage: 'done',
      amount: '100',
      risk: 'med',
      strategy: STRATEGY,
      runId: RUN_ID,
    })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.RECEIPT_READY })
    expect(loadResume(ADDR).resumeAction).toBe('show-receipt')
  })

  it('a confirmed-but-not-yet-executed run offers an explicit resume, never an automatic one', () => {
    saveResume(ADDR, {
      stage: 'done',
      amount: '100',
      risk: 'med',
      strategy: STRATEGY,
      runId: RUN_ID,
    })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.REUSE_CONFIRMED })
    expect(loadResume(ADDR).resumeAction).toBe('offer-explicit-resume')
  })

  it('resumeAction is case-insensitive on the address argument -- one canonical case closes the seam between the snapshot key and the journal key', () => {
    saveResume(ADDR, {
      stage: 'done',
      amount: '100',
      risk: 'med',
      strategy: STRATEGY,
      runId: RUN_ID,
    })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.RECEIPT_READY })
    expect(loadResume(ADDR.toUpperCase())?.resumeAction).toBe('show-receipt')
    expect(loadResume(ADDR.toLowerCase())?.resumeAction).toBe('show-receipt')
  })

  it('reading the resume snapshot never itself calls grant/pull/burn/deposit/withdraw -- loadResume stays a pure read', () => {
    saveResume(ADDR, {
      stage: 'done',
      amount: '100',
      risk: 'med',
      strategy: STRATEGY,
      runId: RUN_ID,
    })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_REQUESTED })
    const before = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    loadResume(ADDR)
    const after = loadRunJournal({ owner: OWNER, runId: RUN_ID })
    expect(after).toEqual(before) // untouched by the read
  })

  it('clearResume(address, runId) drops both the snapshot and its journal', () => {
    saveResume(ADDR, {
      stage: 'done',
      amount: '100',
      risk: 'med',
      strategy: STRATEGY,
      runId: RUN_ID,
    })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    clearResume(ADDR, RUN_ID)
    expect(loadResume(ADDR)).toBeNull()
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID })).toBeNull()
  })

  it('clearResume(address) with no runId still clears the snapshot but leaves the journal alone', () => {
    saveResume(ADDR, {
      stage: 'done',
      amount: '100',
      risk: 'med',
      strategy: STRATEGY,
      runId: RUN_ID,
    })
    appendMilestone({ owner: OWNER, runId: RUN_ID, kind: RUN_MILESTONES.GRANT_CONFIRMED })
    clearResume(ADDR)
    expect(loadResume(ADDR)).toBeNull()
    // journal is untouched -- no runId was given to clear it
    expect(loadRunJournal({ owner: OWNER, runId: RUN_ID })?.resumeAction).toBe(
      'offer-explicit-resume'
    )
  })
})
