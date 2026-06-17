// frontend/src/strategy/rehydrate.js
// Pure glue: re-boot an ERC-7710 session from a persisted grant on page-load /
// wizard re-entry, so the user is never re-prompted within the validity window.
import { hasValidGrant, loadGrant } from './grantStore.js'
import { initSession } from './session.js'

/** @returns {{active: true, expiresAt: number, permissionContext: string} | {active: false}} */
export function rehydrateSession() {
  if (!hasValidGrant()) return { active: false }
  const g = loadGrant()
  initSession({ permissionContext: g.permissionContext, delegationManager: g.delegationManager })
  return { active: true, expiresAt: g.expiresAt, permissionContext: g.permissionContext }
}
