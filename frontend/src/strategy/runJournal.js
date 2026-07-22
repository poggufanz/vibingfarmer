// frontend/src/strategy/runJournal.js
// Strategy Task 6 (Pocket Crew redesign, Wave 1). A versioned, NON-SECRET milestone journal per
// (owner, runId) -- the durable record of which safe, already-confirmed facts a run has reached,
// so a page reload can restore them instead of re-deriving (or worse, assuming) them. Mirrors
// grantReceiptStore.js's storage shape: every row is tagged with its own tamper-detection
// fingerprint on write and re-verified on every read, so a corrupted or hand-edited row is
// indistinguishable from "nothing stored" -- both collapse to null.
//
// `loadRunJournal` is READ-ONLY. It never calls grant, pull, burn, deposit, or withdraw -- it
// only reports a `resumeAction` for the CALLER to act on, and only after an explicit user action
// (see sessionResume.js). This module has no wallet, network, or contract dependency at all.
import { hash } from '@stellar/stellar-sdk'
import { canonicalizeStrategy } from './canonicalStrategy.js'

const STORE_KEY = 'vf.runJournal.v1'

/** Exact versioned milestone vocabulary (brief Step 2), plus the two parameterized kinds below. */
export const RUN_MILESTONES = Object.freeze({
  PLAN_READY: 'plan-ready',
  PERMISSION_REVIEWED: 'permission-reviewed',
  GRANT_REQUESTED: 'grant-requested',
  GRANT_CONFIRMED: 'grant-confirmed',
  REUSE_CONFIRMED: 'reuse-confirmed',
  RECEIPT_READY: 'receipt-ready',
})

export const pullMilestone = (agentId) => `pull-confirmed:${agentId}`
export const depositMilestone = (agentId) => `deposit-confirmed:${agentId}`
export const baseJobMilestone = (jobId, status) => `base-job:${jobId}:${status}`

// Rank of the singleton (one-per-run) milestones, used only to pick the further-progressed
// resumeAction when more than one is present -- never to reject or overwrite a write. Every
// reached milestone is always kept; a stale/out-of-order write can never erase a later one.
const SINGLETON_RANK = {
  [RUN_MILESTONES.PLAN_READY]: 0,
  [RUN_MILESTONES.PERMISSION_REVIEWED]: 1,
  [RUN_MILESTONES.GRANT_REQUESTED]: 2,
  [RUN_MILESTONES.GRANT_CONFIRMED]: 3,
  [RUN_MILESTONES.REUSE_CONFIRMED]: 3,
  [RUN_MILESTONES.RECEIPT_READY]: 4,
}

let _memStore = null
function resolveStorage(injected) {
  if (injected) return injected
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch {
    /* SecurityError in some embeds -- fall through */
  }
  if (!_memStore) {
    const m = new Map()
    _memStore = {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, v),
      removeItem: (k) => m.delete(k),
    }
  }
  return _memStore
}

function readAll(storage) {
  try {
    return JSON.parse(resolveStorage(storage).getItem(STORE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function writeAll(all, storage) {
  try {
    resolveStorage(storage).setItem(STORE_KEY, JSON.stringify(all))
  } catch {
    /* quota/serialization failure -- best-effort, never fatal */
  }
}

// Owner is a Stellar G... strkey (case-sensitive, already canonical) -- exact match, no
// normalization, matching grantReceiptStore.js/reusePreflight.js's convention (not the legacy
// lowercase-0x-address convention in sessionResume.js).
const bucketKey = (owner, runId) => `${owner}|${runId}`

function fingerprintRow(journal) {
  const payload = JSON.stringify(canonicalizeStrategy(journal))
  return '0x' + hash(payload).toString('hex') // hash() accepts a string directly (no Buffer needed)
}

/** Read + tamper-check one row. Missing, corrupt, or fingerprint-mismatched all collapse to null
 * so a caller can never special-case a bad read into a good one. */
function readRow(all, key) {
  const row = all[key]
  if (!row || !row.journal) return null
  try {
    if (fingerprintRow(row.journal) !== row.fingerprint) return null
    return row.journal
  } catch {
    return null
  }
}

function writeRow(all, key, journal, storage) {
  all[key] = { journal, fingerprint: fingerprintRow(journal) }
  writeAll(all, storage)
}

function emptyJournal(owner, runId) {
  return {
    version: 1,
    owner,
    runId,
    planFingerprint: null,
    agentInitFingerprint: null,
    grantReceiptFingerprint: null,
    milestones: {}, // kind -> { at }
  }
}

/**
 * Append one milestone for (owner, runId). Idempotent (writing the same kind again is a no-op
 * beyond filling in a not-yet-known fingerprint) and monotonic (an out-of-order write is still
 * recorded -- see SINGLETON_RANK -- but can never erase a milestone already reached). A NEW
 * planFingerprint or agentInitFingerprint for an EXISTING runId means the run was re-planned
 * under the same id: the stale row is discarded rather than mixed with the new one.
 * @param {{owner:string, runId:string, kind:string, planFingerprint?:string,
 *          agentInitFingerprint?:string, grantReceiptFingerprint?:string, at?:number,
 *          storage?:object}} p
 */
export function appendMilestone({
  owner,
  runId,
  kind,
  planFingerprint = null,
  agentInitFingerprint = null,
  grantReceiptFingerprint = null,
  at = Date.now(),
  storage,
} = {}) {
  if (!owner || !runId || !kind) return
  const all = readAll(storage)
  const key = bucketKey(owner, runId)
  let journal = readRow(all, key)

  const mismatched =
    journal &&
    ((planFingerprint && journal.planFingerprint && journal.planFingerprint !== planFingerprint) ||
      (agentInitFingerprint &&
        journal.agentInitFingerprint &&
        journal.agentInitFingerprint !== agentInitFingerprint))
  if (mismatched) journal = null // fingerprint-mismatch cleanup: stale run, start over

  if (!journal) journal = emptyJournal(owner, runId)

  if (!journal.milestones[kind]) journal.milestones[kind] = { at }
  if (planFingerprint) journal.planFingerprint = planFingerprint
  if (agentInitFingerprint) journal.agentInitFingerprint = agentInitFingerprint
  if (grantReceiptFingerprint) journal.grantReceiptFingerprint = grantReceiptFingerprint

  writeRow(all, key, journal, storage)
}

/** Highest-rank singleton milestone present, or -1 if none. */
function furthestSingletonRank(kinds) {
  let rank = -1
  for (const k of kinds) if (SINGLETON_RANK[k] > rank) rank = SINGLETON_RANK[k]
  return rank
}

const isExecutionMilestone = (k) =>
  k.startsWith('pull-confirmed:') || k.startsWith('deposit-confirmed:') || k.startsWith('base-job:')

/** Read-only classification of what a caller may safely offer the user next. Never itself decides
 * to grant/pull/burn/deposit/withdraw -- only names the safe next step. */
function classifyResumeAction(kinds) {
  if (kinds.has(RUN_MILESTONES.RECEIPT_READY)) return 'show-receipt'
  if ([...kinds].some(isExecutionMilestone)) return 'reconcile' // mid-flight -- must re-check chain state first
  const rank = furthestSingletonRank(kinds)
  if (rank === 3) return 'offer-explicit-resume' // permission confirmed, execution not started
  if (rank === 2) return 'reconcile' // grant-requested with no confirmation -- ambiguous wallet outcome
  if (rank >= 0) return 'offer-explicit-resume' // plan-ready / permission-reviewed -- nothing irreversible yet
  return null
}

/**
 * Load the journal for (owner, runId). READ-ONLY: performs no grant/pull/burn/deposit/withdraw
 * call, ever -- it is pure localStorage plus a fingerprint check. Returns null when there is
 * nothing safely resumable (missing, corrupt, or tampered).
 * @param {{owner:string, runId:string, storage?:object}} p
 * @returns {{runId, owner, planFingerprint, agentInitFingerprint, grantReceiptFingerprint,
 *            milestones:string[], resumeAction:'reconcile'|'offer-explicit-resume'|'show-receipt'}|null}
 */
export function loadRunJournal({ owner, runId, storage } = {}) {
  if (!owner || !runId) return null
  const journal = readRow(readAll(storage), bucketKey(owner, runId))
  if (!journal) return null
  const kinds = new Set(Object.keys(journal.milestones || {}))
  if (kinds.size === 0) return null
  return {
    runId: journal.runId,
    owner: journal.owner,
    planFingerprint: journal.planFingerprint,
    agentInitFingerprint: journal.agentInitFingerprint,
    grantReceiptFingerprint: journal.grantReceiptFingerprint,
    milestones: [...kinds],
    resumeAction: classifyResumeAction(kinds),
  }
}

/** Drop the journal for (owner, runId) -- e.g. once its receipt has been shown, or on revoke. */
export function clearRunJournal({ owner, runId, storage } = {}) {
  if (!owner || !runId) return
  const all = readAll(storage)
  delete all[bucketKey(owner, runId)]
  writeAll(all, storage)
}
