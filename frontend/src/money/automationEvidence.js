// frontend/src/money/automationEvidence.js
// Pocket Crew "My money" Task 8: turns raw automation signals (keeper events, vault
// configuration reads, lifeboat state, risk-watch provenance) into the labels the My money route
// is allowed to show. Every label here must be earned by a POSITIVE observation — a keeper
// heartbeat inside a tested window, a readable strategy registration, an on-chain mandate. The
// absence of a contrary signal (no alert seen, no failure logged) is never itself evidence of
// health — it produces 'unavailable', not 'healthy'/'configured'/'armed'.
import { classifyFreshness } from './freshness.js'

// Same cadence as the keeper cron (keeper/src/radar-runner.mjs: "a 15-min cron") with headroom
// for one missed run before calling the heartbeat stale rather than crying wolf on ordinary
// jitter.
export const KEEPER_HEALTHY_WITHIN_MS = 35 * 60 * 1000

// Only these keeper-event types are execution/heartbeat evidence — vault_derisk / vault_mandate /
// vault_upgrade_* are real events too, but they say nothing about whether the keeper cron is
// currently compounding this vault (see classifyLifeboatAutomation for the derisk/mandate side).
const HEARTBEAT_TYPES = new Set(['compound', 'rebalance'])

/**
 * Keeper automation label from decoded keeper events (frontend/src/stellar/keeperEvents.js —
 * carries a real ledger-close-derived `closedAt`, never a `Date.now()` stamped at read time; an
 * event missing `closedAt` cannot be used as evidence at all). `events` may be in any order —
 * only the freshest heartbeat-type event counts.
 * @returns {{label:'healthy'|'stale'|'unavailable', lastHeartbeatAt:number|null, evidence:object|null}}
 */
export function classifyKeeperAutomation({ events = [], now, healthyWithinMs = KEEPER_HEALTHY_WITHIN_MS } = {}) {
  const heartbeats = events.filter(
    (e) => e && HEARTBEAT_TYPES.has(e.type) && Number.isFinite(e.closedAt)
  )
  if (heartbeats.length === 0) return { label: 'unavailable', lastHeartbeatAt: null, evidence: null }
  const latest = heartbeats.reduce((a, b) => (b.closedAt > a.closedAt ? b : a))
  const freshness = classifyFreshness({ checkedAt: latest.closedAt, now, staleAfterMs: healthyWithinMs })
  return {
    label: freshness === 'current' ? 'healthy' : 'stale',
    lastHeartbeatAt: latest.closedAt,
    evidence: latest,
  }
}

/**
 * A readable strategy registration / share price is proof the vault is wired up — NOT proof the
 * keeper cron is actively compounding it. Conflating the two would manufacture "running" out of a
 * one-time configuration read; this label only ever says 'configured' or 'unavailable'.
 */
export function classifyStrategyConfiguration({ pricePerShare, registered } = {}) {
  const known = registered === true || (pricePerShare != null && Number.isFinite(Number(pricePerShare)))
  return { label: known ? 'configured' : 'unavailable' }
}

/**
 * Lifeboat is a single vault-wide mandate (soroban/contracts/autofarm_vault) — never per-owner —
 * so its state and its authority (who currently holds it) are reported as two separate facts,
 * never collapsed into one "yours" claim. Mirrors lifeboat.js's own panelState() thresholds.
 * `state: 'unavailable'` (not 'disarmed') when there is no evidence at all — an unread mandate is
 * unknown, never presented as confidently off.
 */
export function classifyLifeboatAutomation({ derisked, mandateExpiry, authority, now } = {}) {
  if (derisked == null && mandateExpiry == null) {
    return { state: 'unavailable', authority: authority ?? null, scope: 'vault-wide' }
  }
  const nowS = Math.floor((now ?? Date.now()) / 1000)
  const state = derisked ? 'engaged' : mandateExpiry > nowS ? 'armed' : 'disarmed'
  return { state, authority: authority ?? null, scope: 'vault-wide' }
}

/**
 * Risk-watch recommendations (riskWatchStore.js) are read from THIS browser's local storage,
 * keyed by network + owner — never shared across wallets, never a server-side truth. Surfaced as
 * its own provenance fact so the UI never implies a cross-device or cross-wallet guarantee it
 * can't make.
 */
export function describeRiskWatchProvenance({ owner, networkId } = {}) {
  if (!owner || !networkId) {
    return { label: 'unavailable', scope: 'local', owner: owner ?? null, networkId: networkId ?? null }
  }
  return { label: 'This device', scope: 'local', owner, networkId }
}
