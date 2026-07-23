// Bounded router/registry event ingester + honest coverage proof (Pocket Crew My Money Task 3).
// ONE page per `ingestAgentIndexPage` call (the store's cursor field is the cross-call resume
// point — see store.js commitSourcePage); a caller (handler.js / keeper) loops calls across ticks
// for "bounded catch-up" rather than this module ever scanning an unbounded range itself.
//
// Decode reuse (ladder rung 2 — don't reinvent): funding_router `Deployed` events decode via
// stellar/routerEvents.js's `decodeDeployedEvent` (same lowercase-topic gotcha it already
// documents); registry `agent_authorized` events decode via stellar/events.js's generic
// `decodeEvent`. This module owns none of the raw ScVal decoding.
import { decodeDeployedEvent } from '../../src/stellar/routerEvents.js'
import { decodeEvent } from '../../src/stellar/events.js'
import { sourceIdFor } from './models.js'
import {
  AGENT_INDEX_FINALITY_LEDGERS,
  AGENT_INDEX_MAX_LAG_MS,
  AGENT_WASM_GENERATIONS,
  creatorForAddress,
} from '../../src/stellar/agentCreatorManifest.js'

/**
 * Decode one raw event record into `{agentAddress, ownerAddress, ledger, txHash}`, or `null` for
 * anything that isn't a `Deployed`/`agent_authorized` record this creator's kind is known to
 * emit, or that fails to decode. One malformed record never breaks the page.
 */
function decodeSourceEvent(source, rec) {
  if (source.kind === 'funding-router') {
    const d = decodeDeployedEvent(rec)
    if (!d || !d.agent || !d.owner || !d.txHash) return null
    return { agentAddress: d.agent, ownerAddress: d.owner, ledger: d.ledger, txHash: d.txHash }
  }
  if (source.kind === 'registry') {
    try {
      const e = decodeEvent(rec)
      if (e.type !== 'agent_authorized') return null
      const agentAddress = e.data?.agent
      const ownerAddress = e.data?.owner
      if (!agentAddress || !ownerAddress || !e.txHash) return null
      return { agentAddress, ownerAddress, ledger: e.ledger, txHash: e.txHash }
    } catch {
      return null
    }
  }
  return null
}

/**
 * Prove which agent_account wasm GENERATION deployed `agentAddress`, or `null` when it cannot be
 * proven — never a guess (brief Step 2: "reject rather than guess").
 *   - funding-router: the router only ever deploys its own constructor-pinned wasm (on-chain
 *     enforced), so the manifest's `supportedAgentWasmHashes` is authoritative — no RPC round trip.
 *   - registry: `authorize()` never pins a wasm (any agent whose scope it can read qualifies), so
 *     the event schema alone proves nothing. `eventSource.getAgentWasmHash` (an injected on-chain
 *     read, matching the pattern api/stellar-relay.js already uses for the same question) is
 *     required; its absence, a lookup failure, or a hash outside AGENT_WASM_GENERATIONS all mean
 *     "cannot prove" — reject, don't admit an unverifiable membership.
 */
async function resolveAgentGeneration(source, agentAddress, eventSource) {
  if (source.kind === 'funding-router') {
    for (const hash of source.supportedAgentWasmHashes ?? []) {
      const gen = AGENT_WASM_GENERATIONS.find((g) => g.wasmHash === hash)
      if (gen) return gen.generation
    }
    return null
  }
  if (!eventSource.getAgentWasmHash) return null
  let hash
  try {
    hash = await eventSource.getAgentWasmHash(agentAddress)
  } catch {
    return null
  }
  const gen = hash && AGENT_WASM_GENERATIONS.find((g) => g.wasmHash === hash)
  return gen ? gen.generation : null
}

function nextOrdinal(map, txHash) {
  const n = map.get(txHash) ?? 0
  map.set(txHash, n + 1)
  return n
}

function toMembership(source, decoded, generation, runOrdinal, provenanceSource) {
  const isFundingRouter = source.kind === 'funding-router'
  return {
    networkId: source.networkId,
    agentAddress: decoded.agentAddress,
    ownerAddress: decoded.ownerAddress,
    creatorAddress: source.address,
    schemaVersion: source.schemaVersion,
    // v3-bridge is the only generation whose wasm can be EITHER deposit or bridge kind
    // (AgentScope.kind, agent_account/src/types.rs) — the Deployed/agent_authorized event schema
    // never carries that field, so 'unknown' is the honest value, never a guessed 'bridge'.
    kind: generation === 'agent-v3-bridge' ? 'unknown' : 'deposit',
    creationLedger: decoded.ledger,
    creationTx: decoded.txHash,
    grantTxHash: isFundingRouter ? decoded.txHash : null,
    runId: isFundingRouter ? `${source.networkId}:${source.address}:${decoded.txHash}` : null,
    runOrdinal: isFundingRouter ? runOrdinal : null,
    provenance: {
      source: provenanceSource,
      providerId: source._providerId,
      endpointClass: source._endpointClass,
      generation,
    },
  }
}

/**
 * Ingest ONE bounded page of `source`'s events into `store`. Resumes from the store's own
 * persisted cursor state (never from caller-supplied ledger numbers) so replaying this call is
 * always safe. Never guesses: an agent whose wasm generation can't be proven, or a source this
 * manifest doesn't recognize, throws rather than writing a membership it can't stand behind.
 *
 * @param {object} p
 * @param {import('../../src/stellar/agentCreatorManifest').AgentCreatorV1} p.source one manifest
 *   AGENT_CREATORS entry (networkId/address/kind/schemaVersion/coverageStartLedger/
 *   supportedAgentWasmHashes/discoverySources)
 * @param {ReturnType<import('./store').createAgentIndexStore>} p.store
 * @param {{
 *   providerId: string,
 *   endpointClass: 'live'|'archival',
 *   oldestAvailableLedger: number,
 *   latestAvailableLedger: number,
 *   getEvents: (p: {startLedger:number, endLedger:number, cursor?:string, limit:number}) =>
 *     Promise<{events: Array, cursor: string|null, scannedThroughLedger: number}>,
 *   getAgentWasmHash?: (agentAddress: string) => Promise<string|null>,
 * }} p.eventSource a `StellarEventSourceV1`. `scannedThroughLedger` is the RPC-CONFIRMED inclusive
 *   ledger this call actually scanned (<= endLedger) — real providers may window-cap a request
 *   short of what was asked; this field is how an empty page still advances honestly.
 * @param {number} p.finalizedLedger the already finality-margined ledger ceiling (caller applies
 *   AGENT_INDEX_FINALITY_LEDGERS before calling this) — the commit never claims `finalized`
 *   coverage past this, even when it scanned further into unsettled recent ledgers.
 * @param {number} [p.pageLimit]
 * @returns {Promise<{sourceId: string, status: 'idle'|'gapped'|'committed', fromLedger?: number,
 *   throughLedger?: number, membershipCount?: number}>}
 */
export async function ingestAgentIndexPage({
  source,
  store,
  eventSource,
  finalizedLedger,
  pageLimit = 200,
}) {
  if (!source || !creatorForAddress(source.address)) {
    throw new Error(`ingestAgentIndexPage: unknown creator "${source?.address}" — not in the manifest`)
  }
  if (!Number.isInteger(finalizedLedger)) {
    throw new Error('ingestAgentIndexPage requires an integer finalizedLedger')
  }
  const sourceId = sourceIdFor({ networkId: source.networkId, creatorAddress: source.address })
  const { sources } = await store.readCoverage({ networkId: source.networkId })
  const existing = sources.find((s) => s.sourceId === sourceId)
  const fromLedger = existing ? existing.indexedThroughLedger + 1 : source.coverageStartLedger

  // Live-provider retention floor (also covers an archival provider's own bounded window): this
  // provider can never certify a range older than what it reports it has. Commit an empty page
  // spanning exactly the hole — the documented store.js resume protocol — so the cursor advances
  // past ledgers this call could never have proven, then record the gap (agent_index_gaps.source_id
  // is a real FK against agent_index_sources — on a source's very first-ever page there is no
  // source row yet, so the commit MUST land first). The gap stays on record forever regardless of
  // order — coverageProof's `contiguous` never goes true until something closes it.
  if (Number.isInteger(eventSource.oldestAvailableLedger) && fromLedger < eventSource.oldestAvailableLedger) {
    const gapThrough = Math.min(eventSource.oldestAvailableLedger - 1, finalizedLedger)
    if (gapThrough < fromLedger) {
      return { sourceId, status: 'idle' }
    }
    await store.commitSourcePage({
      sourceId,
      fromLedger,
      throughLedger: gapThrough,
      finalizedThroughLedger: gapThrough,
      cursor: existing?.cursor ?? null,
      memberships: [],
    })
    await store.recordGap({
      sourceId,
      networkId: source.networkId,
      fromLedger,
      throughLedger: gapThrough,
      reason: `${eventSource.endpointClass}-provider:${eventSource.providerId}:below-oldest-available-ledger`,
    })
    return { sourceId, status: 'gapped', fromLedger, throughLedger: gapThrough }
  }

  const requestEnd = Number.isInteger(eventSource.latestAvailableLedger)
    ? eventSource.latestAvailableLedger
    : finalizedLedger
  if (requestEnd < fromLedger) {
    return { sourceId, status: 'idle' } // chain hasn't moved past what's already indexed
  }

  const res = await eventSource.getEvents({
    startLedger: fromLedger,
    endLedger: requestEnd,
    cursor: existing?.cursor ?? undefined,
    limit: pageLimit,
  })
  if (!Number.isInteger(res?.scannedThroughLedger) || res.scannedThroughLedger < fromLedger) {
    throw new Error(`ingestAgentIndexPage: eventSource reported no confirmed scanned range for ${sourceId}`)
  }
  // Never advance further than the RPC actually confirmed, even on an empty page.
  const throughLedger = Math.min(res.scannedThroughLedger, requestEnd)

  // Stable paging-token order → dedupe by pagingToken (raw duplicate records) then by agent
  // address (a LATER duplicate for an already-seen agent can never change its owner/creator —
  // first occurrence wins, everything else in this page is dropped for that agent).
  const seenPagingToken = new Set()
  const byAgent = new Map()
  for (const rec of res.events || []) {
    const pt = rec.pagingToken
    if (pt != null) {
      if (seenPagingToken.has(pt)) continue
      seenPagingToken.add(pt)
    }
    const decoded = decodeSourceEvent(source, rec)
    if (!decoded) continue
    if (!byAgent.has(decoded.agentAddress)) byAgent.set(decoded.agentAddress, decoded)
  }

  const provenanceSource =
    source.discoverySources?.[0] ?? (source.kind === 'funding-router' ? 'router-event' : 'registry-event')
  const ordinalByTx = new Map()
  const memberships = []
  for (const decoded of byAgent.values()) {
    const generation = await resolveAgentGeneration(source, decoded.agentAddress, eventSource)
    if (!generation) {
      throw new Error(
        `ingestAgentIndexPage: cannot prove wasm generation for agent ${decoded.agentAddress} ` +
          `(source ${sourceId}) — refusing to guess`
      )
    }
    const runOrdinal = source.kind === 'funding-router' ? nextOrdinal(ordinalByTx, decoded.txHash) : null
    memberships.push(
      toMembership(
        { ...source, _providerId: eventSource.providerId, _endpointClass: eventSource.endpointClass },
        decoded,
        generation,
        runOrdinal,
        provenanceSource
      )
    )
  }

  const finalizedThroughLedger = Math.max(fromLedger - 1, Math.min(throughLedger, finalizedLedger))
  await store.commitSourcePage({
    sourceId,
    fromLedger,
    throughLedger,
    finalizedThroughLedger,
    cursor: res.cursor ?? null,
    memberships,
  })
  return { sourceId, status: 'committed', fromLedger, throughLedger, membershipCount: memberships.length }
}

/**
 * Pure coverage-truth function: never touches I/O, never guesses. `manifest` is the identity
 * bundle a caller is claiming coverage against — `{version, hash, schemaVersion, creators}`
 * (production callers pass AGENT_CREATOR_MANIFEST_VERSION/HASH/AGENT_INDEX_SCHEMA_VERSION/
 * AGENT_CREATORS; tests inject a small fixture bundle). `sources`/`gaps` are
 * `store.readCoverage(...)`'s rows; `backfillAudit` is its `backfillAudits` array (param name
 * kept singular per the brief's exact signature).
 * @returns {{
 *   manifestVersion: string, manifestHash: string, schemaVersion: number,
 *   indexedFromLedger: number|null, indexedThroughLedger: number|null,
 *   finalizedThroughLedger: number|null, contiguous: boolean, gaps: Array,
 *   historicalBackfill: 'verified'|'pending'|'failed', requiredFinalityLedgers: number,
 *   checkedAt: number, status: 'complete'|'partial',
 * }}
 */
export function coverageProof({ manifest, sources = [], gaps = [], backfillAudit = [], now = Date.now() }) {
  const creators = manifest?.creators ?? []
  const bySourceId = new Map(sources.map((s) => [s.sourceId, s]))
  const knownSourceIds = new Set(
    creators.map((c) => sourceIdFor({ networkId: c.networkId, creatorAddress: c.address }))
  )
  // A source row this manifest doesn't recognize (e.g. a retired/dropped creator, or corrupt
  // data) can never be trusted toward completeness.
  const hasUnknownSource = sources.some((s) => !knownSourceIds.has(s.sourceId))

  const contiguous = gaps.length === 0

  let everyCreatorCoveredAndFresh = creators.length > 0 && !hasUnknownSource
  for (const creator of creators) {
    const sourceId = sourceIdFor({ networkId: creator.networkId, creatorAddress: creator.address })
    const row = bySourceId.get(sourceId)
    if (!row) {
      everyCreatorCoveredAndFresh = false
      continue
    }
    const identityMatches =
      row.manifestHash === manifest.hash &&
      row.manifestVersion === manifest.version &&
      row.schemaVersion === manifest.schemaVersion
    const startsAtCreator = row.indexedFromLedger <= creator.coverageStartLedger
    const fresh = Number.isFinite(row.lastSuccessAt) && now - row.lastSuccessAt * 1000 <= AGENT_INDEX_MAX_LAG_MS
    if (!identityMatches || !startsAtCreator || !fresh || row.status !== 'ok') {
      everyCreatorCoveredAndFresh = false
    }
  }

  // Creators with no deploy evidence (conservative coverageStartLedger === 1, see
  // agentCreatorManifest.js header) can never prove full coverage from ledger scanning alone —
  // only an independent backfillAudit can close that hole. 'pending' is DERIVED from the absence
  // of a verified audit row, never itself written as an audit result (models.js BACKFILL_RESULTS
  // is only ['verified','failed']).
  const needsBackfill = creators.filter((c) => c.coverageStartLedger === 1)
  let historicalBackfill = 'verified'
  if (needsBackfill.length > 0) {
    let sawMissing = false
    let sawFailure = false
    for (const creator of needsBackfill) {
      const sourceId = sourceIdFor({ networkId: creator.networkId, creatorAddress: creator.address })
      const rows = backfillAudit.filter((a) => a.sourceId === sourceId)
      if (rows.some((a) => a.result === 'verified')) continue
      if (rows.length === 0) sawMissing = true
      else sawFailure = true
    }
    historicalBackfill = sawMissing ? 'pending' : sawFailure ? 'failed' : 'verified'
  }

  const finite = (arr) => arr.filter((v) => Number.isFinite(v))
  const indexedFromLedgers = finite(sources.map((s) => s.indexedFromLedger))
  const indexedThroughLedgers = finite(sources.map((s) => s.indexedThroughLedger))
  const finalizedThroughLedgers = finite(sources.map((s) => s.finalizedThroughLedger))

  const status =
    everyCreatorCoveredAndFresh && contiguous && historicalBackfill === 'verified' ? 'complete' : 'partial'

  return {
    manifestVersion: manifest.version,
    manifestHash: manifest.hash,
    schemaVersion: manifest.schemaVersion,
    indexedFromLedger: indexedFromLedgers.length ? Math.min(...indexedFromLedgers) : null,
    indexedThroughLedger: indexedThroughLedgers.length ? Math.min(...indexedThroughLedgers) : null,
    finalizedThroughLedger: finalizedThroughLedgers.length ? Math.min(...finalizedThroughLedgers) : null,
    contiguous,
    gaps,
    historicalBackfill,
    requiredFinalityLedgers: AGENT_INDEX_FINALITY_LEDGERS,
    checkedAt: now,
    status,
  }
}
