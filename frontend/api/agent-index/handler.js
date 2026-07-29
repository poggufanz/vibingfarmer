// Pure, DI-friendly route logic for /api/agent-index — no req/res, no real D1/RPC construction
// (that glue lives in ../agent-index.js, which is untested by design: everything worth testing
// here is testable without touching a network or a real Cloudflare binding).
import { ingestAgentIndexPage, coverageProof } from './indexer.js'
import { commitBackfillAudit } from './backfill.js'
import { ingestAssociationReport, joinBaseAssociations } from './associations.js'
import {
  AGENT_CREATORS,
  AGENT_CREATOR_MANIFEST_HASH,
  AGENT_CREATOR_MANIFEST_VERSION,
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_INDEX_FINALITY_LEDGERS,
} from '../../src/stellar/agentCreatorManifest.js'

export const LIVE_MANIFEST = {
  version: AGENT_CREATOR_MANIFEST_VERSION,
  hash: AGENT_CREATOR_MANIFEST_HASH,
  schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
  creators: AGENT_CREATORS,
}

/** Constant-time secret compare (node:crypto.timingSafeEqual — available under the
 * nodejs_compat flag both Pages Functions and `vite dev` already run with). A length mismatch is
 * resolved via a same-length dummy compare first so a wrong-length guess takes the same time as a
 * right-length one; the byte-for-byte compare itself is the actual constant-time step. */
async function constantTimeEqual(a, b) {
  const { timingSafeEqual } = await import('node:crypto')
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/**
 * `POST /api/agent-index?action=ingest`. Runs one bounded page per source in parallel
 * (Promise.allSettled — one source's failure never aborts the others' pages, matches this repo's
 * worker-dispatch convention). Every dependency the real chain/D1 touches is injected; the
 * default export (../agent-index.js) supplies the real ones.
 * @param {object} p
 * @param {string} p.secret configured AGENT_INDEX_INGEST_SECRET ('' = not configured)
 * @param {string} p.providedSecret bearer token from the request
 * @param {ReturnType<import('./store').createAgentIndexStore>|null} p.store
 * @param {Array} [p.sources] manifest creators to ingest (defaults to every live creator)
 * @param {(source: object) => Promise<object>} p.eventSourceFor builds a StellarEventSourceV1
 * @param {(source: object, eventSource: object) => Promise<number>} p.finalizedLedgerFor
 * @param {number} [p.pageLimit]
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleIngest({
  secret,
  providedSecret,
  store,
  sources = AGENT_CREATORS,
  eventSourceFor,
  finalizedLedgerFor,
  pageLimit,
}) {
  if (!secret)
    return { status: 503, body: { error: 'Agent index ingest not configured', configured: false } }
  if (!providedSecret || !(await constantTimeEqual(providedSecret, secret))) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }
  if (!store)
    return { status: 503, body: { error: 'Agent index store unavailable', configured: false } }
  if (!eventSourceFor || !finalizedLedgerFor) {
    return { status: 500, body: { error: 'Ingest misconfigured' } }
  }

  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const eventSource = await eventSourceFor(source)
      const finalizedLedger = await finalizedLedgerFor(source, eventSource)
      return ingestAgentIndexPage({ source, store, eventSource, finalizedLedger, pageLimit })
    })
  )
  const results = settled.map((r, i) => {
    const sourceId = `${sources[i].networkId}:${sources[i].address}`
    return r.status === 'fulfilled'
      ? { sourceId, ok: true, ...r.value }
      : { sourceId, ok: false, error: r.reason?.message || String(r.reason) }
  })
  const failed = results.filter((r) => !r.ok).length
  return { status: 200, body: { results, ok: results.length - failed, failed } }
}

/**
 * The ONLY protected write path a historical backfill audit may post through. NOT wired to an
 * HTTP route today — `scripts/agent-index/backfill-legacy-agents.mjs` (Task 4) calls this
 * in-process (a direct ESM import), passing a locally-opened D1 store and
 * `AGENT_INDEX_INGEST_SECRET` as both `secret` and `providedSecret`. Same secret-gate shape as
 * `handleIngest` on purpose (a future `POST /api/agent-index?action=backfill-commit` route in
 * api/agent-index.js could wrap this unchanged), then delegates entirely to `backfill.js`'s
 * `commitBackfillAudit` — this function adds no membership-writing logic of its own, so there is
 * exactly one place in the codebase that can turn audit evidence into D1 rows.
 * @param {object} p
 * @param {string} p.secret configured backfill secret ('' = not configured)
 * @param {string} p.providedSecret bearer token from the request
 * @param {ReturnType<import('./store').createAgentIndexStore>|null} p.store
 * @param {object} p.audit a `BackfillAuditV1` (see backfill.js toBackfillAuditV1)
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleBackfillCommit({ secret, providedSecret, store, audit }) {
  if (!secret)
    return {
      status: 503,
      body: { error: 'Agent index backfill not configured', configured: false },
    }
  if (!providedSecret || !(await constantTimeEqual(providedSecret, secret))) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }
  if (!store)
    return { status: 503, body: { error: 'Agent index store unavailable', configured: false } }
  try {
    const result = await commitBackfillAudit({ store, audit })
    return { status: 200, body: { ok: true, ...result } }
  } catch (err) {
    return { status: 400, body: { error: err.message } }
  }
}

/** Protected server-to-server relayer association write. The binding attestation is accepted
 * only after indexed membership + a fresh on-chain scope_of read prove the owner-bound bridge
 * scope. Reporting remains analytics-only: callers decide how to surface this response and must
 * never change farm custody because this endpoint is unavailable. */
export async function handleAssociationReport({
  secret,
  providedSecret,
  idempotencyKey,
  store,
  report,
  scopeReader,
  poolTargets,
  scopeRequirements,
  now = Date.now(),
}) {
  if (!secret) {
    return {
      status: 503,
      body: { error: 'Agent index reporter not configured', configured: false },
    }
  }
  if (!providedSecret || !(await constantTimeEqual(providedSecret, secret))) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }
  if (!store) {
    return { status: 503, body: { error: 'Agent index store unavailable', configured: false } }
  }
  if (!scopeReader || !poolTargets || !scopeRequirements) {
    return { status: 500, body: { error: 'Association ingest misconfigured' } }
  }
  try {
    const result = await ingestAssociationReport({
      report,
      idempotencyKey,
      store,
      scopeReader,
      poolTargets,
      scopeRequirements,
      now,
    })
    return { status: 200, body: { ok: true, ...result } }
  } catch (err) {
    return { status: 400, body: { error: err.message } }
  }
}

function unavailableBody({ networkId, owner, manifest, now }) {
  return {
    version: 1,
    networkId,
    owner,
    status: 'unavailable',
    agents: [],
    coverage: {
      manifestVersion: manifest.version,
      manifestHash: manifest.hash,
      schemaVersion: manifest.schemaVersion,
      indexedFromLedger: null,
      indexedThroughLedger: null,
      finalizedThroughLedger: null,
      contiguous: false,
      gaps: [],
      historicalBackfill: 'pending',
      requiredFinalityLedgers: AGENT_INDEX_FINALITY_LEDGERS,
      checkedAt: now,
    },
  }
}

const DEFAULT_READ_LIMIT = 200
const MAX_READ_LIMIT = 500

/**
 * `GET /api/agent-index?network=<networkId>&owner=<G-or-C-StrKey>&limit=<n>`. Public, read-only,
 * on-chain-derived data. An unreachable store returns a STRUCTURED `unavailable` response —
 * never `agents: []` mislabeled `complete`.
 * @param {object} p
 * @param {string} p.networkId
 * @param {string} p.owner
 * @param {ReturnType<import('./store').createAgentIndexStore>|null} p.store
 * @param {object} [p.manifest] defaults to the live AGENT_CREATORS manifest identity
 * @param {number} [p.now]
 * @param {string|number} [p.limit] optional page-size cap on `agents`, 1..500 (default 200);
 *   reject a malformed value rather than silently clamping it — never guess what the caller meant.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleRead({
  networkId,
  owner,
  store,
  manifest = LIVE_MANIFEST,
  now = Date.now(),
  limit,
}) {
  if (typeof networkId !== 'string' || !networkId) {
    return { status: 400, body: { error: 'Invalid network' } }
  }
  const { StrKey } = await import('@stellar/stellar-sdk')
  const isValidAddress = (a) =>
    typeof a === 'string' && !!a && (StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a))
  if (!isValidAddress(owner)) {
    return { status: 400, body: { error: 'Invalid owner' } }
  }
  let effectiveLimit = DEFAULT_READ_LIMIT
  if (limit !== undefined && limit !== null && limit !== '') {
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 1 || n > MAX_READ_LIMIT) {
      return { status: 400, body: { error: 'Invalid limit' } }
    }
    effectiveLimit = n
  }
  if (!store) {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }

  let memberships
  let coverage
  let associations
  try {
    ;[memberships, coverage, associations] = await Promise.all([
      store.readOwnerMemberships({ networkId, owner }),
      store.readCoverage({ networkId }),
      typeof store.readOwnerRunAllocations === 'function'
        ? store.readOwnerRunAllocations({ networkId, owner })
        : [],
    ])
  } catch {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }

  const proof = coverageProof({
    manifest,
    sources: coverage.sources,
    gaps: coverage.gaps,
    backfillAudit: coverage.backfillAudits,
    now,
  })
  const { status, ...coverageOut } = proof
  // Never trust stored rows blindly to be well-formed StrKeys — a membership whose address or
  // creator fails validation is dropped from the response, never guessed or coerced (Minor 7).
  const agents = memberships
    .filter((m) => isValidAddress(m.address) && isValidAddress(m.creator))
    .slice(0, effectiveLimit)
    .map((m) => ({
      address: m.address,
      kind: m.kind,
      creator: m.creator,
      createdLedger: m.createdLedger,
      createdTxHash: m.createdTxHash,
      runId: m.runId,
      runOrdinal: m.runOrdinal,
      grantTxHash: m.grantTxHash,
      provenance: m.provenance,
    }))
  const associatedAgents = joinBaseAssociations({ agents, associations, now })
  return {
    status: 200,
    body: { version: 1, networkId, owner, status, agents: associatedAgents, coverage: coverageOut },
  }
}
