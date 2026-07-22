// sessionResume.js
// Persist the wizard "resume snapshot" so a page refresh re-enters the active
// session instead of resetting to step 1. Keyed by wallet address (lowercased),
// same convention as positionsStore. Only a snapshot with strategy agents is
// worth restoring — anything else is treated as "no session to resume".
//
// SECURITY: stores only non-secret UI state (stage, amount, risk, strategy meta, runId).
// The ephemeral session key lives elsewhere (stellar/sessionKey + keyVault) and is
// never written here.
//
// Strategy Task 6 (Pocket Crew redesign, Wave 1): the OLD assumption here was that any saved
// snapshot with agents means the run is 'done' -- a page reload just trusted the caller's
// `stage` field at face value. That is exactly wrong for a run that reloaded mid-grant or
// mid-worker-dispatch. `loadResume` now attaches `resumeAction`: 'reconcile' |
// 'offer-explicit-resume' | 'show-receipt' | null, read from runJournal.js's safe, journal-
// derived milestones for the snapshot's `runId` (when one was recorded). This is a PURE READ
// (runJournal.loadRunJournal never calls grant/pull/burn/deposit/withdraw); `stage` stays in the
// snapshot for backward compatibility but must never be trusted alone -- check `resumeAction`.
import { loadRunJournal, clearRunJournal } from './runJournal.js'

const keyFor = (address) => `yv_resume_${String(address).toLowerCase()}`

const hasAgents = (snap) => Array.isArray(snap?.strategy?.agents) && snap.strategy.agents.length > 0

/**
 * Persist the resume snapshot for an address. No-op when there is nothing
 * resumable (no address, or a strategy without agents).
 * @param {string} address
 * @param {{stage: string, amount: string|number, risk: string, strategy: object, runId?: string}} snapshot
 */
export function saveResume(address, snapshot) {
  if (!address || !hasAgents(snapshot)) return
  try {
    localStorage.setItem(
      keyFor(address),
      JSON.stringify({
        stage: snapshot.stage,
        amount: snapshot.amount,
        risk: snapshot.risk,
        strategy: snapshot.strategy,
        runId: snapshot.runId ?? null,
        savedAt: Date.now(),
      })
    )
  } catch {
    // localStorage unavailable/full — non-fatal, session still lives in memory.
  }
}

/**
 * Restore the resume snapshot for an address, plus the safe `resumeAction` read from the run
 * journal for its `runId` (null when the snapshot has no runId, or nothing is journaled for it).
 * @param {string} address
 * @returns {{stage: string, amount: string, risk: string, strategy: object, runId: string|null,
 *            savedAt: number, resumeAction: 'reconcile'|'offer-explicit-resume'|'show-receipt'|null}|null}
 */
export function loadResume(address) {
  if (!address) return null
  let raw
  try {
    raw = localStorage.getItem(keyFor(address))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const snap = JSON.parse(raw)
    if (!hasAgents(snap)) return null
    const journal = snap.runId ? loadRunJournal({ owner: address, runId: snap.runId }) : null
    return { ...snap, resumeAction: journal?.resumeAction ?? null }
  } catch {
    // Corrupt/partial value — drop it and behave as "no session".
    try {
      localStorage.removeItem(keyFor(address))
    } catch {
      /* ignore */
    }
    return null
  }
}

/**
 * Drop the stored snapshot (on new strategy / disconnect / revoke). When `runId` is given, also
 * drops that run's journal -- e.g. once its receipt has been shown, or on an explicit revoke.
 * @param {string} address
 * @param {string} [runId]
 */
export function clearResume(address, runId) {
  if (!address) return
  try {
    localStorage.removeItem(keyFor(address))
  } catch {
    /* ignore */
  }
  if (runId) clearRunJournal({ owner: address, runId })
}
