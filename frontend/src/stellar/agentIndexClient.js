// Thin, validated fetch client for GET /api/agent-index — the D1 owner-membership + coverage
// read (frontend/api/agent-index/handler.js handleRead). Pure network + structural validation:
// no on-chain reads, no browser/RPC hints (ownerDiscovery.js adds those on top). Never trusts the
// server's word alone — a response whose manifest identity doesn't match THIS bundle's own frozen
// manifest (agentCreatorManifest.js) can never be trusted as 'complete', only downgraded to
// 'partial' (ambiguity resolution: always report reduced coverage over trusting a mismatched
// source). Same fail-closed convention as relay.js: never throws, an unreachable/invalid response
// resolves to an honest `unavailable` result.
import {
  AGENT_CREATOR_MANIFEST_HASH,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_INDEX_FINALITY_LEDGERS,
} from './agentCreatorManifest.js'

const AGENT_INDEX_PATH = '/api/agent-index'
const NULL_HINTS = { localCacheCount: null, rpcEventCount: null, registryCount: null }

function unavailableResult(networkId, owner) {
  return {
    status: 'unavailable',
    networkId: networkId ?? null,
    owner: owner ?? null,
    agents: [],
    coverage: null,
    hints: { ...NULL_HINTS },
  }
}

/**
 * `GET /api/agent-index?network=<networkId>&owner=<owner>&limit=<limit>`. `hints` is always
 * null-filled here — this client has no browser/RPC hint sources of its own; ownerDiscovery.js
 * replaces it with real counts once it gathers them.
 * @param {{owner:string, networkId?:string, limit?:number, fetchImpl?:Function, apiBase?:string}} p
 * @returns {Promise<{status:'complete'|'partial'|'unavailable', networkId:string, owner:string,
 *   agents:Array, coverage:object|null, hints:object}>}
 */
export async function fetchOwnerAgentIndex({
  owner,
  networkId = 'stellar-testnet',
  limit,
  fetchImpl = fetch,
  apiBase = '',
} = {}) {
  if (!owner || !networkId) return unavailableResult(networkId, owner)

  const params = new URLSearchParams({ network: networkId, owner })
  if (limit != null) params.set('limit', String(limit))

  let res
  try {
    res = await fetchImpl(`${apiBase}${AGENT_INDEX_PATH}?${params.toString()}`)
  } catch {
    return unavailableResult(networkId, owner) // unreachable — fail closed, never fabricate
  }
  if (!res.ok) return unavailableResult(networkId, owner)

  let body
  try {
    body = await res.json()
  } catch {
    return unavailableResult(networkId, owner) // a non-JSON body must not be guessed at
  }

  // Identity/schema gate: a response for the wrong owner/network, or a shape this client version
  // doesn't recognize, is NEVER trusted (Task 6 brief: "remains complete only when owner/network/
  // schema validate").
  if (
    !body ||
    body.version !== 1 ||
    body.networkId !== networkId ||
    body.owner !== owner ||
    !Array.isArray(body.agents) ||
    !body.coverage ||
    typeof body.coverage !== 'object'
  ) {
    return unavailableResult(networkId, owner)
  }

  // An unrecognized body.status (neither 'complete' nor 'partial') has no trustworthy agents/
  // coverage attached to it either — short-circuit to the same empty-agents shape every other
  // `unavailable` result uses, rather than silently carrying the raw body's agents/coverage
  // through under an 'unavailable' label.
  if (body.status !== 'complete' && body.status !== 'partial') return unavailableResult(networkId, owner)
  let status = body.status

  const coverage = body.coverage
  // Manifest-identity + finality-margin re-check: a stale/tampered/misconfigured server could
  // claim 'complete' against a manifest this client doesn't recognize, or a weaker finality
  // margin than this bundle requires — either downgrades the claim, never upgrades it.
  const manifestTrusted =
    coverage.manifestHash === AGENT_CREATOR_MANIFEST_HASH &&
    coverage.manifestVersion === AGENT_CREATOR_MANIFEST_VERSION &&
    coverage.schemaVersion === AGENT_INDEX_SCHEMA_VERSION &&
    Number.isInteger(coverage.requiredFinalityLedgers) &&
    coverage.requiredFinalityLedgers >= AGENT_INDEX_FINALITY_LEDGERS
  // The server derives `status` from exactly this coverage evidence too (api/agent-index/
  // indexer.js coverageProof) — re-checking only the manifest identity above and trusting the
  // server's own `status` word for the rest would defeat "never trusts the server's word alone".
  // Zero open gaps, a verified historical backfill, and a non-null indexed-through tip are the
  // same three conjuncts the coverage semantics require for 'complete' (a NULL tip is never
  // complete) — re-derive them here too, not just the manifest identity.
  const coverageTrusted =
    coverage.contiguous === true &&
    Array.isArray(coverage.gaps) &&
    coverage.gaps.length === 0 &&
    coverage.historicalBackfill === 'verified' &&
    coverage.indexedThroughLedger != null
  if (status === 'complete' && !(manifestTrusted && coverageTrusted)) status = 'partial'

  const agents = body.agents
    .filter((a) => a && typeof a.address === 'string' && a.address)
    .map((a) => ({ ...a })) // passthrough — runOrdinal/association/baseChildren/etc never recomputed here

  return { status, networkId, owner, agents, coverage, hints: { ...NULL_HINTS } }
}
