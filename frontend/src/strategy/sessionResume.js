// sessionResume.js
// Persist the wizard "resume snapshot" so a page refresh re-enters the active
// session instead of resetting to step 1. Keyed by wallet address (lowercased),
// same convention as positionsStore. Only a snapshot with strategy agents is
// worth restoring — anything else is treated as "no session to resume".
//
// SECURITY: stores only non-secret UI state (stage, amount, risk, strategy meta).
// The ERC-7715 grant + ephemeral session key live elsewhere (grantStore/session)
// and are never written here.

const keyFor = (address) => `yv_resume_${String(address).toLowerCase()}`

const hasAgents = (snap) => Array.isArray(snap?.strategy?.agents) && snap.strategy.agents.length > 0

/**
 * Persist the resume snapshot for an address. No-op when there is nothing
 * resumable (no address, or a strategy without agents).
 * @param {string} address
 * @param {{stage: string, amount: string|number, risk: string, strategy: object}} snapshot
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
        savedAt: Date.now(),
      })
    )
  } catch {
    // localStorage unavailable/full — non-fatal, session still lives in memory.
  }
}

/**
 * Restore the resume snapshot for an address.
 * @param {string} address
 * @returns {{stage: string, amount: string, risk: string, strategy: object, savedAt: number}|null}
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
    return snap
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

/** Drop the stored snapshot (on new strategy / disconnect / revoke). */
export function clearResume(address) {
  if (!address) return
  try {
    localStorage.removeItem(keyFor(address))
  } catch {
    /* ignore */
  }
}
