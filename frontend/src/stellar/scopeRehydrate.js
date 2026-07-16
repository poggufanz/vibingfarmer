// Rebuild the in-memory `scopes` list (app.jsx) after a refresh / reconnect / wallet switch. The
// live grant path fills `scopes` from the `AgentScopeAuthorized` event as it happens, but that
// state is in-memory — a refresh empties the "Agent permissions · scoped on-chain" panel even
// though the grants and funds are untouched on-chain. This re-enumerates the owner's active agents
// and re-reads each scope on-chain (chain stays authoritative).
//
// Enumeration = UNION of two sources, deduped by agent address:
//   1. funding_router `Deployed` events (cross-device — the primary source).
//   2. the same-browser agent cache (backstop for the guarded retention invariant: max active
//      grant = 7d, RPC retention ~7.01d — a grant minutes from expiry could fall off getEvents but
//      still sit in this device's cache).
// Then scope_of() per agent → single-source summary rows identical in shape to the live path.
import {
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  USE_FUNDING_ROUTER,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  NETWORK_PASSPHRASE,
} from './config.js'
import { rpcServer } from './client.js'
import { loadCachedAgents, readAgentScope } from './agentCache.js'
import { fetchRouterDeployedEvents } from './routerEvents.js'
import { queryAgentsByOwner } from './events.js'
import { toSummary } from '../strategy/permissionScope.js'

// Longest grant preset (GrantPanel DURATION_PRESETS 7d). RPC retention below this means a
// cross-device rehydrate can silently miss an old-but-live grant — a deployment invariant we
// can't enforce from the browser, only warn about. ~5s/ledger is order-of-magnitude only.
const MAX_GRANT_SECONDS = 604800
const SECONDS_PER_LEDGER = 5

/** Warn (never throw) if RPC retention can't cover the longest possible active grant. */
async function warnIfRetentionShort(server) {
  try {
    const health = await server.getHealth()
    const retentionSec = Number(health?.ledgerRetentionWindow ?? 0) * SECONDS_PER_LEDGER
    if (retentionSec > 0 && retentionSec < MAX_GRANT_SECONDS) {
      console.warn(
        `[scopeRehydrate] RPC retention ~${Math.round(retentionSec / 86400)}d < max grant 7d - ` +
          'cross-device rehydrate may miss old grants; same-browser cache is the only backstop.'
      )
    }
  } catch {
    /* getHealth is optional signal — never block rehydrate on it */
  }
}

/**
 * Build the `scopes` rows for `owner` from on-chain state. Read-only: never mutates the cache.
 * @param {{
 *   owner: string,
 *   server?: object,            // injected RPC client (test seam)
 *   vault?: string,
 *   network?: string,
 *   nowSec?: number,
 *   includeRevoked?: boolean,   // default true (revoked rows shown; the UI decides their fate)
 *   includeExpired?: boolean,   // default true — an EXPIRED grant can still HOLD FUNDS, and an
 *                               // expired-with-funds agent is precisely when the user most needs
 *                               // the exit path. Hiding it here removed such agents from every
 *                               // withdraw list; 100 USDC sat invisible in two of them. Chain
 *                               // truth belongs in `scopes`; display filtering is the UI's job.
 *   fetchEvents?: Function,     // test seam
 *   loadCache?: Function,       // test seam
 *   readScope?: Function,       // test seam
 *   queryAgents?: Function,     // test seam (registry enumeration)
 * }} p
 * @returns {Promise<Array>} rows shaped exactly like the live AgentScopeAuthorized handler's
 */
export async function rehydrateScopes({
  owner,
  server,
  vault = SOROBAN_ACTIVE_VAULT_ADDRESS,
  network = NETWORK_PASSPHRASE,
  nowSec = Math.floor(Date.now() / 1000),
  includeRevoked = true,
  includeExpired = true,
  fetchEvents = fetchRouterDeployedEvents,
  loadCache = loadCachedAgents,
  readScope = readAgentScope,
  queryAgents = queryAgentsByOwner,
} = {}) {
  if (!owner) return []
  // No router deployed → the single-signature grant flow is off; nothing to rehydrate.
  if (!SOROBAN_FUNDING_ROUTER_ADDRESS || !USE_FUNDING_ROUTER) return []

  const s = server || (await rpcServer())
  await warnIfRetentionShort(s)

  // Union of THREE sources, deduped by agent address:
  //   1. funding_router Deployed events (cross-device, grant-path agents)
  //   2. same-browser agent cache (retention backstop)
  //   3. registry records (agents from the LEGACY direct-deploy path — never router-deployed,
  //      so invisible to source 1 on a fresh device. Two such agents held 100 USDC that every
  //      withdraw list missed because this union stopped at two sources.)
  // Every address is then verified against its own on-chain scope below, so a bogus entry from
  // any source can add nothing.
  const [events, registry] = await Promise.all([
    fetchEvents({
      server: s,
      routerAddress: SOROBAN_FUNDING_ROUTER_ADDRESS,
      owner,
    }).catch(() => []),
    queryAgents(owner, { server: s }).catch(() => []),
  ])
  const cached = loadCache({ owner, vault, network })
  const addresses = [
    ...new Set(
      [...events.map((e) => e.agent), ...cached.map((c) => c.agentAddress), ...registry].filter(
        Boolean
      )
    ),
  ]
  if (addresses.length === 0) return []

  // Chain is authoritative: re-read each scope. allSettled + null-drop so one dead RPC read
  // (or a self-destructed agent) never fabricates a row or aborts the batch.
  const settled = await Promise.allSettled(
    addresses.map((agent) => readScope(agent, { server: s }).then((scope) => ({ agent, scope })))
  )

  const rows = []
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value.scope) continue
    const { agent, scope } = r.value
    // toSummary divides cap over the period — a 0 period would throw. Never happens for a real
    // grant (period_duration is always > 0), but guard belt-and-braces against a decode glitch.
    if (Number(scope.period_duration ?? 0) <= 0) continue
    rows.push({
      ...toSummary({
        agent,
        vault: scope.vault,
        token: scope.token,
        capPerPeriod: BigInt(scope.cap_per_period ?? 0),
        periodDuration: Number(scope.period_duration),
        expiry: Number(scope.expiry ?? 0),
        nowSec,
      }),
      agentId: null,
      revoked: Boolean(scope.revoked),
      authorized: true,
    })
  }

  return rows.filter((row) => {
    if (!includeRevoked && row.revoked) return false
    if (!includeExpired && Number(row.expiry) <= nowSec) return false
    return true
  })
}
