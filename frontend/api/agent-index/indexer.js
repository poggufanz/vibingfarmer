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
import { fromScVal } from '../../src/stellar/scval.js'
import { sourceIdFor } from './models.js'
import {
  AGENT_INDEX_FINALITY_LEDGERS,
  AGENT_INDEX_MAX_LAG_MS,
  AGENT_WASM_GENERATIONS,
  creatorForAddress,
} from '../../src/stellar/agentCreatorManifest.js'

/**
 * Classify one raw event record against `source`'s expected schema. Three outcomes:
 *   - `{ matched: false }` — the topic isn't this source's event at all. Safe to drop silently;
 *     the page still commits (a filtered RPC feed can still carry occasional off-topic noise).
 *   - `{ matched: true, decoded }` — the topic matched and the body decoded cleanly.
 *   - `{ matched: true, error }` — the topic matched but the body failed to decode (schema
 *     drift). Fail-closed: the caller MUST abort the whole page on this, never silently drop a
 *     membership while the page still commits and coverage still claims the range (Important 4).
 */
function decodeSourceEvent(source, rec) {
  if (source.kind === 'funding-router') {
    let topic0
    try {
      topic0 = fromScVal(rec.topic[0])
    } catch {
      return { matched: false }
    }
    if (topic0 !== 'deployed') return { matched: false }
    const d = decodeDeployedEvent(rec)
    if (!d || !d.agent || !d.owner || !d.txHash) {
      return {
        matched: true,
        error: new Error(
          `decodeSourceEvent: 'deployed' event failed to decode (pagingToken ${rec.pagingToken}) — schema drift?`
        ),
      }
    }
    return { matched: true, decoded: { agentAddress: d.agent, ownerAddress: d.owner, ledger: d.ledger, txHash: d.txHash } }
  }
  if (source.kind === 'registry') {
    let type
    try {
      type = fromScVal(rec.topic[0])
    } catch {
      return { matched: false }
    }
    if (type !== 'agent_authorized') return { matched: false }
    try {
      const e = decodeEvent(rec)
      const agentAddress = e.data?.agent
      const ownerAddress = e.data?.owner
      if (!agentAddress || !ownerAddress || !e.txHash) {
        return {
          matched: true,
          error: new Error(
            `decodeSourceEvent: 'agent_authorized' event missing required fields (pagingToken ${rec.pagingToken}) — schema drift?`
          ),
        }
      }
      return { matched: true, decoded: { agentAddress, ownerAddress, ledger: e.ledger, txHash: e.txHash } }
    } catch (err) {
      return {
        matched: true,
        error: new Error(
          `decodeSourceEvent: 'agent_authorized' event failed to decode (pagingToken ${rec.pagingToken}): ${err.message}`
        ),
      }
    }
  }
  return { matched: false }
}

/**
 * Turn one raw Soroban RPC `getEvents()` response into an honest `StellarEventSourceV1` page.
 * Pure — no I/O — so the real RPC adapter (`api/agent-index.js`) stays a thin, untested pass-
 * through while the actual interpretation logic here is fully unit-tested.
 *
 * Two review fixes live here:
 *   - Critical 2 (mid-ledger truncation loses deploys): a `cursor` in the response means the RPC
 *     may have cut the page off at `limit` mid-ledger — the boundary ledger (`maxSeenLedger`)
 *     could be only partially fetched. Never claim that ledger scanned, and never keep its
 *     (possibly incomplete) events for this page — they're dropped here so the NEXT page
 *     re-requests that ledger whole, rather than a deploy silently vanishing with no gap row.
 *     Truncation evidence ALWAYS overrides tip arithmetic below — in production `endLedger` is
 *     the pre-call tip snapshot and `latestLedger` is ~the same ledger moments later, so
 *     `endLedger >= latestLedger` is true on almost every call INCLUDING a truncated one. Trusting
 *     tip arithmetic there would silently drop everything past the `limit` cut (worse than the
 *     original bug this fixed). A response counts as truncated when it returned `limit` events, or
 *     when it returned ANY events alongside a `cursor` — only a genuinely EMPTY response with a
 *     cursor is the ambiguous case tip arithmetic gets to resolve (Livelock check 8 below).
 *   - Livelock check 8 (reachedTip robustness): if the SDK sets `cursor` on every response, even
 *     a complete/empty one, cursor presence alone can never prove "at tip" — an empty window
 *     would throw forever. `latestLedger` (the RPC's own reported chain tip AS OF THIS RESPONSE)
 *     is ledger-arithmetic proof instead: `endLedger >= latestLedger` means our request already
 *     reached the real tip, regardless of what `cursor` says. No `latestLedger` in the response
 *     at all is the genuinely ambiguous case — it falls back to the old cursor-only check, which
 *     stays fail-safe (never claims tip on a false premise; retries next tick).
 * @param {{ events: Array<{ledger?: number}>, cursor: string|null|undefined, latestLedger?: number,
 *   startLedger: number, endLedger: number, limit?: number }} p
 * @returns {{ events: Array, scannedThroughLedger: number, latestLedger: number|null }}
 */
export function scanRpcEventsPage({ events = [], cursor, latestLedger, startLedger, endLedger, limit }) {
  const tipKnown = Number.isInteger(latestLedger)
  const truncated = (Number.isInteger(limit) && events.length >= limit) || (!!cursor && events.length > 0)
  const reachedTip = !truncated && (tipKnown ? endLedger >= latestLedger : !cursor)
  const maxSeenLedger = events.reduce((m, e) => Math.max(m, e.ledger || 0), startLedger - 1)
  if (reachedTip) {
    return {
      events,
      scannedThroughLedger: Math.min(endLedger, latestLedger ?? endLedger),
      latestLedger: tipKnown ? latestLedger : null,
    }
  }
  return {
    // Truncated (or ambiguous, no latestLedger to prove otherwise): only ledgers strictly before
    // the boundary are provably complete.
    events: events.filter((e) => (e.ledger || 0) < maxSeenLedger),
    scannedThroughLedger: maxSeenLedger - 1,
    latestLedger: tipKnown ? latestLedger : null,
  }
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
 *     Promise<{events: Array, cursor: string|null, scannedThroughLedger: number, latestLedger?: number}>,
 *   getAgentWasmHash?: (agentAddress: string) => Promise<string|null>,
 * }} p.eventSource a `StellarEventSourceV1`. `scannedThroughLedger` is the RPC-CONFIRMED inclusive
 *   ledger this call actually scanned (<= endLedger) — real providers may window-cap a request
 *   short of what was asked; this field is how an empty page still advances honestly.
 *   `latestLedger`, when the provider reports it, is the chain tip AS OF THIS RESPONSE — persisted
 *   per source (0003_agent_index_bounds.sql) and is what `coverageProof` binds completeness to
 *   (Critical 1: gap-free is not enough, coverage must also reach the real tip).
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

  const reportedLatestAvailable = Number.isInteger(eventSource.latestAvailableLedger)
    ? eventSource.latestAvailableLedger
    : null

  // Live-provider retention floor (also covers an archival provider's own bounded window): this
  // provider can never certify a range older than what it reports it has. Commit an empty page
  // spanning exactly the hole — the documented store.js resume protocol — so the cursor advances
  // past ledgers this call could never have proven, then record the gap.
  if (Number.isInteger(eventSource.oldestAvailableLedger) && fromLedger < eventSource.oldestAvailableLedger) {
    const gapThrough = Math.min(eventSource.oldestAvailableLedger - 1, finalizedLedger)
    if (gapThrough < fromLedger) {
      return { sourceId, status: 'idle' }
    }
    // agent_index_gaps.source_id is a real FK against agent_index_sources — on a source's very
    // first-ever page there is no row yet. `ensureSourceRow` seeds the "nothing indexed yet"
    // sentinel row FIRST (a no-op if the row already exists), so `recordGap` can ALWAYS run
    // before the substantive commit below, uniformly — a crash between recordGap and the commit
    // then always leaves the gap on record behind a cursor that hasn't moved past it, never the
    // reverse (Important 3: gap-branch atomicity ordering).
    await store.ensureSourceRow({
      sourceId,
      networkId: source.networkId,
      creatorAddress: source.address,
      fromLedger,
      providerId: eventSource.providerId,
      endpointClass: eventSource.endpointClass,
      reportedOldestLedger: eventSource.oldestAvailableLedger,
      reportedLatestLedger: reportedLatestAvailable,
    })
    await store.recordGap({
      sourceId,
      networkId: source.networkId,
      fromLedger,
      throughLedger: gapThrough,
      reason: `${eventSource.endpointClass}-provider:${eventSource.providerId}:below-oldest-available-ledger`,
    })
    await store.commitSourcePage({
      sourceId,
      fromLedger,
      throughLedger: gapThrough,
      finalizedThroughLedger: gapThrough,
      cursor: existing?.cursor ?? null,
      memberships: [],
      providerId: eventSource.providerId,
      endpointClass: eventSource.endpointClass,
      reportedOldestLedger: eventSource.oldestAvailableLedger,
      reportedLatestLedger: reportedLatestAvailable,
    })
    return { sourceId, status: 'gapped', fromLedger, throughLedger: gapThrough }
  }

  const requestEnd = reportedLatestAvailable ?? finalizedLedger
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
  // Critical 1 / Spec-missing 5: the response's own reported chain tip, persisted per-source so
  // coverageProof can bind completeness to it. Falls back to the pre-call snapshot
  // (`eventSource.latestAvailableLedger`) when this particular getEvents() call didn't report one.
  const reportedLatestLedger = Number.isInteger(res.latestLedger) ? res.latestLedger : reportedLatestAvailable

  // Stable paging-token order → dedupe by pagingToken (raw duplicate records) then by agent
  // address (a LATER duplicate for an already-seen agent can never change its owner/creator —
  // first occurrence wins within this page; everything else is dropped for that agent). A
  // matching-topic record that fails to decode is fail-closed: abort the WHOLE page rather than
  // silently dropping membership while coverage still advances (Important 4).
  const seenPagingToken = new Set()
  const byAgent = new Map()
  for (const rec of res.events || []) {
    const pt = rec.pagingToken
    if (pt != null) {
      if (seenPagingToken.has(pt)) continue
      seenPagingToken.add(pt)
    }
    const result = decodeSourceEvent(source, rec)
    if (result.error) {
      await store.recordSourceError({
        sourceId,
        networkId: source.networkId,
        creatorAddress: source.address,
        fromLedger,
        message: result.error.message,
      })
      throw result.error
    }
    if (!result.decoded) continue
    if (!byAgent.has(result.decoded.agentAddress)) byAgent.set(result.decoded.agentAddress, result.decoded)
  }

  // Spec-partial 6: a duplicate `deployed`/`agent_authorized` event for an agent ALREADY indexed
  // by a prior page must never rewrite its identity via commitSourcePage's ON CONFLICT DO UPDATE.
  // Drop (and count) any candidate whose agent address already has a membership row — an
  // identical re-emission has nothing to change (a harmless no-op skip); one with different
  // immutable fields (owner/creator/creation ledger/tx — a spoof or corrupt replay) is exactly
  // the rewrite this guard exists to prevent.
  const candidateAddresses = [...byAgent.keys()]
  const existingMemberships = candidateAddresses.length
    ? await store.readMembershipsByAgentAddresses({ networkId: source.networkId, agentAddresses: candidateAddresses })
    : []
  const existingByAddress = new Map(existingMemberships.map((m) => [m.address, m]))
  let duplicateCount = 0
  const toResolve = []
  for (const decoded of byAgent.values()) {
    const priorRow = existingByAddress.get(decoded.agentAddress)
    if (priorRow) {
      const isIdentical =
        priorRow.owner === decoded.ownerAddress &&
        priorRow.creator === source.address &&
        priorRow.createdLedger === decoded.ledger &&
        priorRow.createdTxHash === decoded.txHash
      if (!isIdentical) duplicateCount += 1
      continue
    }
    toResolve.push(decoded)
  }

  const provenanceSource =
    source.discoverySources?.[0] ?? (source.kind === 'funding-router' ? 'router-event' : 'registry-event')
  const ordinalByTx = new Map()
  const memberships = []
  for (const decoded of toResolve) {
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
    providerId: eventSource.providerId,
    endpointClass: eventSource.endpointClass,
    reportedOldestLedger: Number.isInteger(eventSource.oldestAvailableLedger) ? eventSource.oldestAvailableLedger : null,
    reportedLatestLedger,
  })
  return {
    sourceId,
    status: 'committed',
    fromLedger,
    throughLedger,
    membershipCount: memberships.length,
    ...(duplicateCount > 0 ? { duplicateCount } : {}),
  }
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
    // Critical 1: completeness requires coverage to reach the real chain tip, not merely to be
    // internally gap-free. `reportedLatestLedger` is the provider's OWN reported tip, persisted
    // per source at ingest time (0003_agent_index_bounds.sql) — no tip ever known for this source
    // means this can never claim complete, only an honest catching-up 'partial'.
    const tipKnown = Number.isInteger(row.reportedLatestLedger)
    const atTip = tipKnown && row.indexedThroughLedger >= row.reportedLatestLedger - AGENT_INDEX_FINALITY_LEDGERS
    if (!identityMatches || !startsAtCreator || !fresh || row.status !== 'ok' || !atTip) {
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
