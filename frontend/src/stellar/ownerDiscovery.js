// Owner-scoped discovery envelope (OwnerDiscoveryV1): merges the durable D1 agent-index read
// (agentIndexClient.js) with additive browser/RPC hints (session agent cache, funding_router
// events, registry events) into ONE honest picture of "every agent this owner might have". The D1
// read is enumeration PROOF — hints can only ADD a verified missing candidate and surface a
// coverage discrepancy; they can never upgrade `partial` to `complete` (ambiguity resolution: when
// in doubt between trusting a hint and reporting reduced coverage, always report reduced
// coverage).
//
// Every candidate — whether the D1 index already knows it or a hint surfaced it — is re-read
// on-chain via scope_of before being trusted, same philosophy as scopeRehydrate.js's
// rehydrateScopes(): an owner mismatch QUARANTINES the row (proven not this owner's — dropped);
// a read failure KEEPS the row (never drops the whole owner over one dead RPC call), tagged
// `scopeReadStatus: 'failed'`; revoked/expired rows are always retained (an expired or revoked
// grant can still hold funds the owner needs to exit).
import { fetchOwnerAgentIndex } from './agentIndexClient.js'
import { loadCachedAgents, readAgentScope } from './agentCache.js'
import { fetchRouterDeployedEvents } from './routerEvents.js'
import { queryAgentsByOwner, discoverAgentsFromVault } from './events.js'
import {
  SOROBAN_FUNDING_ROUTER_ADDRESS,
  SOROBAN_ACTIVE_VAULT_ADDRESS,
  NETWORK_PASSPHRASE,
} from './config.js'
import { rpcServer } from './client.js'

// The only network the D1 index (agentCreatorManifest.js AGENT_CREATORS) covers today.
export const DEFAULT_NETWORK_ID = 'stellar-testnet'

const SOURCE_API = 'agent-index-api'
const SOURCE_CACHE = 'local-cache'
const SOURCE_RPC = 'rpc-router-events'
const SOURCE_REGISTRY = 'registry-events'
const SOURCE_VAULT = 'vault-discovery'

function emptyEnvelope(networkId, owner) {
  return {
    status: 'unavailable',
    networkId,
    owner: owner ?? null,
    agents: [],
    coverage: null,
    hints: { localCacheCount: 0, rpcEventCount: 0, registryCount: 0, vaultEventCount: 0 },
  }
}

// A hint-only candidate the D1 index has never indexed: its identity fields are genuinely
// unavailable (never guessed) — only the on-chain scope read below can vouch for it at all.
function placeholderApiFields(address) {
  return {
    address,
    kind: null,
    creator: null,
    createdLedger: null,
    createdTxHash: null,
    runId: null,
    runOrdinal: null,
    grantTxHash: null,
    association: 'unknown',
    associationSource: null,
    reportedAt: null,
    scopeCheckedAt: null,
    freshness: 'unknown',
    baseChildren: [],
  }
}

/**
 * Build the OwnerDiscoveryV1 envelope for `owner`. Read-only; never mutates any cache.
 * @param {{owner:string, networkId?:string, server?:object, vault?:string,
 *   fetchClient?:Function, loadCache?:Function, fetchRpcEvents?:Function,
 *   queryRegistry?:Function, discoverVaultAgents?:Function, readScope?:Function}} p
 * @returns {Promise<{status:'complete'|'partial'|'unavailable', networkId:string, owner:string,
 *   agents:Array, coverage:object|null, hints:object}>}
 */
export async function discoverOwnerScopes({
  owner,
  networkId = DEFAULT_NETWORK_ID,
  server,
  vault = SOROBAN_ACTIVE_VAULT_ADDRESS,
  fetchClient = fetchOwnerAgentIndex,
  loadCache = loadCachedAgents,
  fetchRpcEvents = fetchRouterDeployedEvents,
  queryRegistry = queryAgentsByOwner,
  discoverVaultAgents = discoverAgentsFromVault,
  readScope = readAgentScope,
} = {}) {
  if (!owner) return emptyEnvelope(networkId, owner)

  const client = await fetchClient({ owner, networkId }).catch(() => ({
    status: 'unavailable',
    networkId,
    owner,
    agents: [],
    coverage: null,
  }))

  // Neither of these seams has its own internal try/catch (unlike every fetch below, which is
  // `.catch`-guarded individually) — a throwing rpcServer() (SDK load failure) or a throwing
  // injected loadCache must degrade to "no server / no cache hints" rather than crash the whole
  // envelope build.
  let s = server ?? null
  if (!s) {
    try {
      s = await rpcServer()
    } catch {
      s = null
    }
  }
  let cached = []
  try {
    cached = loadCache({ owner, vault, network: NETWORK_PASSPHRASE })
  } catch {
    cached = []
  }
  const [rpcEvents, registryAgents, vaultAgents] = await Promise.all([
    SOROBAN_FUNDING_ROUTER_ADDRESS
      ? fetchRpcEvents({ server: s, routerAddress: SOROBAN_FUNDING_ROUTER_ADDRESS, owner }).catch(() => [])
      : Promise.resolve([]),
    queryRegistry(owner, { server: s }).catch(() => []),
    discoverVaultAgents(owner, { server: s }).catch(() => []),
  ])

  const hints = {
    localCacheCount: cached.length,
    rpcEventCount: rpcEvents.length,
    registryCount: registryAgents.length,
    vaultEventCount: vaultAgents.length,
  }

  // Candidate union, deduped by address — dedup never drops WHICH sources saw an address
  // (discoverySources below), and an API-known row's identity is never overwritten by a hint stub.
  const candidates = new Map()
  const addCandidate = (address, source, apiRow) => {
    if (!address) return
    const c = candidates.get(address) || { address, sources: new Set(), apiRow: null }
    c.sources.add(source)
    if (apiRow) c.apiRow = apiRow
    candidates.set(address, c)
  }
  for (const row of client.agents ?? []) addCandidate(row.address, SOURCE_API, row)
  for (const entry of cached) addCandidate(entry.agentAddress, SOURCE_CACHE)
  for (const ev of rpcEvents) addCandidate(ev.agent, SOURCE_RPC)
  for (const addr of registryAgents) addCandidate(addr, SOURCE_REGISTRY)
  for (const addr of vaultAgents) addCandidate(addr, SOURCE_VAULT)

  // Chain is authoritative: re-read every candidate's scope. readAgentScope never throws (catches
  // internally), so allSettled here is belt-and-braces, not load-bearing.
  const settled = await Promise.allSettled(
    [...candidates.values()].map(async (c) => ({ ...c, scope: await readScope(c.address, { server: s }) }))
  )

  const agents = []
  let sawQuarantine = false
  let sawReadFailure = false
  let sawHintOnlyCandidate = false
  let sawUnverifiedHint = false

  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    const { address, sources, apiRow, scope } = r.value
    const discoverySources = [...sources].sort()
    if (scope == null) {
      // apiRow present = the D1 index already proved this address is the owner's — a dead RPC
      // read must not drop it (see the CFAIL/CGOOD test). apiRow absent = ONLY a hint (local
      // cache is client-mutable and stale-prone) claimed this address, and the one read that
      // could vouch for it just failed: zero evidence backs membership, so it must NOT become a
      // row. It still counts as a coverage discrepancy (an unverifiable candidate the D1 index
      // never indexed) so a 'complete' claim still downgrades — but never upgrades `unavailable`
      // to `partial` on its own, because it never reaches `agents`.
      if (!apiRow) {
        sawUnverifiedHint = true
        continue
      }
      sawReadFailure = true
      agents.push({
        ...apiRow,
        address,
        discoverySources,
        scopeReadStatus: 'failed',
        vault: null,
        revoked: null,
        expiry: null,
        authorized: null,
      })
      continue
    }
    if (String(scope.owner) !== String(owner)) {
      sawQuarantine = true
      continue // proven not this owner's agent — quarantined, never included
    }
    if (!apiRow) sawHintOnlyCandidate = true
    agents.push({
      ...(apiRow || placeholderApiFields(address)),
      address,
      discoverySources,
      scopeReadStatus: 'ok',
      // agent_account v3 renamed AgentScope.vault -> target; dual-support (scopeRehydrate.js).
      vault: scope.target ?? scope.vault ?? null,
      revoked: Boolean(scope.revoked),
      expiry: Number(scope.expiry ?? 0),
      authorized: true,
    })
  }

  let status = client.status === 'complete' || client.status === 'partial' ? client.status : 'unavailable'
  if (status === 'unavailable' && agents.length > 0) status = 'partial' // known hints beat empty
  // A quarantined row, a scope read failure, a hint-only candidate the API never indexed, or an
  // unverifiable hint (couldn't even be read) are all evidence the D1 index's "complete" claim
  // doesn't fully hold — surface it as a discrepancy. sawUnverifiedHint never contributes to the
  // `agents.length > 0` upgrade above (it never reaches `agents`), only to this downgrade.
  if (status === 'complete' && (sawQuarantine || sawReadFailure || sawHintOnlyCandidate || sawUnverifiedHint))
    status = 'partial'

  return { status, networkId, owner, agents, coverage: client.coverage ?? null, hints }
}
