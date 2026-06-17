// frontend/src/strategy/grantStore.js
// Persists the SINGLE ERC-7715 grant so the user is asked exactly once.
// Stores only non-secret data (opaque permissionContext, delegationManager address,
// expiry ms). The session private key is NEVER persisted — it is regenerated per
// page-load and re-used under the same root grant (see strategy/session.js).

const GRANT_KEY = 'yv_strategy_grant'

/**
 * @param {{permissionContext: string, delegationManager: string, expiresAt: number}} grant
 *   expiresAt is unix MILLISECONDS.
 */
export function saveGrant(grant) {
  if (!grant?.permissionContext || !grant?.delegationManager || !grant?.expiresAt) return
  localStorage.setItem(GRANT_KEY, JSON.stringify({
    permissionContext: grant.permissionContext,
    delegationManager: grant.delegationManager,
    expiresAt: grant.expiresAt,
  }))
}

/** @returns {{permissionContext, delegationManager, expiresAt}|null} */
export function loadGrant() {
  const raw = localStorage.getItem(GRANT_KEY)
  if (!raw) return null
  try {
    const g = JSON.parse(raw)
    if (!g?.permissionContext || !g?.delegationManager || !g?.expiresAt) return null
    return g
  } catch {
    return null
  }
}

export function clearGrant() {
  localStorage.removeItem(GRANT_KEY)
}

/** True when a complete, unexpired grant is stored. */
export function hasValidGrant() {
  const g = loadGrant()
  return !!g && g.expiresAt > Date.now()
}
