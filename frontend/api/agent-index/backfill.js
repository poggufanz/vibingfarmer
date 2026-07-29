// Historical direct-deploy agent backfill audit (Pocket Crew My Money Task 4). An agent_account
// deployed directly (deploy-seed.sh, predating the funding_router — see agentCreatorManifest.js
// AGENT_WASM_GENERATIONS 'agent-v1' header) never emits a router `Deployed` or registry
// `agent_authorized` event, so the ordinary Task 3 indexer can never discover it. This module is
// the ONLY place that may produce a `result: 'verified'` agent_backfill_audits row — the ONE thing
// coverageProof (indexer.js) accepts to flip `historicalBackfill` out of 'pending'. Never write
// 'verified' from a run that isn't actually complete — see toBackfillAuditV1's invariant check and
// the Task 4 brief's "never silently convert a partial audit into verified by hand".
//
// Two layers, same split as store.js/handler.js elsewhere in this index:
//   - pure: classifyCandidate / deriveVerdict / toBackfillAuditV1 / buildBackfillAudit — no I/O,
//     fully unit-tested here.
//   - commitBackfillAudit — the only function that touches `store` (D1), gated behind
//     handler.js's handleBackfillCommit exactly like handleIngest gates ordinary ingestion.
import {
  AGENT_INDEX_SCHEMA_VERSION,
  AGENT_WASM_GENERATIONS,
} from '../../src/stellar/agentCreatorManifest.js'
import { sourceIdFor } from './models.js'

export const BACKFILL_METHOD_V1 = 'legacy-direct-deploy-audit-v1'

// Matches AGENT_CREATORS' own `kind` vocabulary ('funding-router' | 'registry') for the two
// evidence kinds that map onto a real `agent_index_sources` row; the other three are
// supplementary evidence the audit still tracks and reports on but can never produce their own
// agent_backfill_audits row (that table's source_id is FK'd to agent_index_sources — see
// migrations/0002_agent_index.sql).
export const AUDIT_SOURCE_KINDS = [
  'funding-router',
  'registry',
  'vault',
  'horizon-account',
  'relayer-log',
]
const SOURCE_KINDS_WITH_ROW = new Set(['funding-router', 'registry'])

export const BACKFILL_AUDIT_VERDICTS = ['verified', 'partial', 'failed']

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${field} must be a non-empty string`)
  return value
}
function requireInt(value, field) {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`)
  return value
}
function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value
}
function requireOneOf(value, options, field) {
  if (!options.includes(value))
    throw new Error(`${field} must be one of ${options.join(', ')}, got ${JSON.stringify(value)}`)
  return value
}

/** Shapes+validates one `sources[]` coverage-evidence entry. */
function toSourceCoverageEntry(entry, i) {
  const s = entry || {}
  requireOneOf(s.kind, AUDIT_SOURCE_KINDS, `sources[${i}].kind`)
  requireString(s.address, `sources[${i}].address`)
  if (s.providerId !== null && typeof s.providerId !== 'string')
    throw new Error(`sources[${i}].providerId must be a string or null`)
  if (s.oldestAvailableLedger !== null && !Number.isInteger(s.oldestAvailableLedger))
    throw new Error(`sources[${i}].oldestAvailableLedger must be an integer or null`)
  requireInt(s.fromLedger, `sources[${i}].fromLedger`)
  requireInt(s.throughLedger, `sources[${i}].throughLedger`)
  if (s.throughLedger < s.fromLedger)
    throw new Error(`sources[${i}].throughLedger must be >= fromLedger`)
  if (typeof s.contiguous !== 'boolean')
    throw new Error(`sources[${i}].contiguous must be a boolean`)
  if (s.evidenceHash !== null && typeof s.evidenceHash !== 'string')
    throw new Error(`sources[${i}].evidenceHash must be a string or null`)
  return {
    kind: s.kind,
    address: s.address,
    providerId: s.providerId ?? null,
    oldestAvailableLedger: s.oldestAvailableLedger ?? null,
    fromLedger: s.fromLedger,
    throughLedger: s.throughLedger,
    contiguous: s.contiguous,
    evidenceHash: s.evidenceHash ?? null,
  }
}

/**
 * Validate+normalize a `BackfillAuditV1` (brief Step 1 shape). This is the single honesty gate:
 * a `verdict: 'verified'` audit is REJECTED here (throws) unless the evidence it carries actually
 * supports it — every source contiguous AND zero unresolved candidates. There is no other way to
 * mark historical coverage closed; a caller can never hand-flip `verdict` without the evidence to
 * back it, because this function re-derives the same check `deriveVerdict` uses and refuses to
 * normalize a mismatch.
 */
export function toBackfillAuditV1(audit) {
  const a = audit || {}
  const auditId = requireString(a.auditId, 'auditId')
  const networkId = requireString(a.networkId, 'networkId')
  const fromLedger = requireInt(a.fromLedger, 'fromLedger')
  const throughLedger = requireInt(a.throughLedger, 'throughLedger')
  if (throughLedger < fromLedger) throw new Error('throughLedger must be >= fromLedger')
  const directSetupCutoffLedger = requireInt(a.directSetupCutoffLedger, 'directSetupCutoffLedger')
  const creatorManifestVersion = requireString(a.creatorManifestVersion, 'creatorManifestVersion')
  const sources = requireArray(a.sources, 'sources').map(toSourceCoverageEntry)
  const candidates = requireArray(a.candidates, 'candidates')
  const verifiedAgents = requireArray(a.verifiedAgents, 'verifiedAgents')
  const rejectedCandidates = requireArray(a.rejectedCandidates, 'rejectedCandidates')
  const unresolvedCandidates = requireArray(a.unresolvedCandidates, 'unresolvedCandidates')
  const verdict = requireOneOf(a.verdict, BACKFILL_AUDIT_VERDICTS, 'verdict')
  const completedAt = requireInt(a.completedAt, 'completedAt')

  // Every candidate lands in exactly one bucket — a mismatch here means a classification bug
  // silently dropped or double-counted a candidate, never a thing to normalize past.
  if (
    verifiedAgents.length + rejectedCandidates.length + unresolvedCandidates.length !==
    candidates.length
  ) {
    throw new Error(
      'toBackfillAuditV1: verifiedAgents + rejectedCandidates + unresolvedCandidates must partition candidates exactly'
    )
  }

  if (verdict === 'verified') {
    if (unresolvedCandidates.length !== 0)
      throw new Error(
        'toBackfillAuditV1: verdict cannot be "verified" while unresolvedCandidates is non-empty'
      )
    if (sources.length === 0 || !sources.every((s) => s.contiguous === true))
      throw new Error(
        'toBackfillAuditV1: verdict cannot be "verified" without every source reporting contiguous coverage'
      )
  }

  return {
    auditId,
    networkId,
    fromLedger,
    throughLedger,
    directSetupCutoffLedger,
    creatorManifestVersion,
    sources,
    candidates,
    verifiedAgents,
    rejectedCandidates,
    unresolvedCandidates,
    verdict,
    completedAt,
  }
}

/** Pure verdict rollup from source coverage + unresolved candidates. Never returns 'failed' —
 * per the brief, every enumerated failure mode (missing provider, retention miss, unavailable
 * source, truncated pagination, unrecognized wasm, failed scope_of, missing cutoff coverage)
 * produces 'partial'; 'failed' stays in the type for a caller to flag a run that could not
 * meaningfully attempt anything, but this function never invents that state itself. */
export function deriveVerdict({ sources, unresolvedCandidates }) {
  const allContiguous =
    Array.isArray(sources) && sources.length > 0 && sources.every((s) => s.contiguous === true)
  const noUnresolved = (unresolvedCandidates?.length ?? 0) === 0
  return allContiguous && noUnresolved ? 'verified' : 'partial'
}

function toVerifiedMembership(c) {
  const isRouter = c.evidenceKind === 'router-event'
  return {
    networkId: c.networkId,
    agentAddress: c.address,
    ownerAddress: c.ownerAddress,
    // A genuinely direct-deployed agent has no creator CONTRACT at all — pointing creatorAddress
    // at itself keeps the column a valid StrKey (handleRead drops rows whose creator fails
    // StrKey validation) while `provenance.evidenceKind` stays the honest record of how it was
    // actually found.
    creatorAddress: c.creatorAddress ?? c.address,
    schemaVersion: c.schemaVersion ?? AGENT_INDEX_SCHEMA_VERSION,
    kind: c.kind ?? 'unknown',
    creationLedger: c.creationLedger,
    creationTx: c.creationTx,
    grantTxHash: isRouter ? c.creationTx : null,
    runId: null,
    runOrdinal: null,
    provenance: {
      source: 'backfill-audit',
      evidenceKind: c.evidenceKind ?? null,
      evidenceHash: c.evidenceHash ?? null,
    },
  }
}

/**
 * Verify ONE candidate on-chain (brief Step 2's four checks). Never guesses: any check this
 * function cannot actually resolve (a scope_of read that failed, a wasm-hash lookup that
 * errored) comes back `unresolved`, never a hopeful `verified`.
 * @param {{candidate: object, directSetupCutoffLedger?: number}} p
 * @returns {{status: 'verified'|'rejected'|'unresolved', reason: string|null, candidate: object, membership?: object}}
 */
export function classifyCandidate({ candidate, directSetupCutoffLedger }) {
  const c = candidate || {}
  if (!c.address) return { status: 'unresolved', reason: 'missing-address', candidate: c }

  // 1. contract wasm hash must be one this manifest recognizes.
  if (c.wasmLookupFailed)
    return { status: 'unresolved', reason: 'wasm-lookup-failed', candidate: c }
  const knownWasm = AGENT_WASM_GENERATIONS.some((g) => g.wasmHash === c.wasmHash)
  if (!knownWasm) return { status: 'rejected', reason: 'unrecognized-wasm', candidate: c }

  // 2. scope_of must decode: owner/target(-or-vault)/token/expiry/revoked. `kind` is checked
  // separately, NOT required to exist on-chain: only agent-v3-bridge's AgentScope ever grew a
  // `kind` field — every earlier generation's real scope_of() (verified live against the
  // pre-hardening demo agent while building this audit) has no such field at all, so requiring
  // it here would permanently unresolve every legacy agent this audit exists to close. `target`
  // vs `vault` is the same renamed-field situation scopeRehydrate.js already documents.
  if (c.scope == null) return { status: 'unresolved', reason: 'scope_of-failed', candidate: c }
  const { owner, token, expiry, revoked } = c.scope
  const target = c.scope.target ?? c.scope.vault
  if ([owner, target, token, expiry, revoked].some((v) => v === undefined))
    return { status: 'unresolved', reason: 'scope-incomplete', candidate: c }

  // 3. no seeded/demo address assigned to an unrelated owner — generalized: the owner this
  // candidate's evidence CLAIMS must match the owner the agent's own on-chain scope reports.
  if (owner !== c.ownerAddress)
    return { status: 'rejected', reason: 'owner-mismatch', candidate: c }

  // 4. provenance must point to a real creation/funding/registry transaction.
  if (c.creationLedger == null || !c.creationTx)
    return { status: 'unresolved', reason: 'missing-provenance', candidate: c }

  // A "direct-deploy" candidate found only via vault/Horizon/relayer-log evidence AFTER the
  // production cutoff (once the router became the mandatory path — see
  // agentCreatorManifest.js isLegacyDirectSetupAllowed) is out of scope for a HISTORICAL audit;
  // anything that recent should already be router/registry-tracked.
  const isTrackedEvidence =
    c.evidenceKind === 'router-event' || c.evidenceKind === 'registry-authorization'
  if (
    Number.isInteger(directSetupCutoffLedger) &&
    c.creationLedger > directSetupCutoffLedger &&
    !isTrackedEvidence
  ) {
    return { status: 'rejected', reason: 'post-cutoff-direct-deploy', candidate: c }
  }

  return { status: 'verified', reason: null, candidate: c, membership: toVerifiedMembership(c) }
}

/**
 * Classify every candidate and assemble the full `BackfillAuditV1`. Pure — `sources` is the
 * caller's already-gathered per-source coverage evidence (archival router/registry paging
 * results), `candidates` the full raw pool from every bullet-1..5 discovery path.
 */
export function buildBackfillAudit({
  auditId,
  networkId,
  fromLedger,
  throughLedger,
  directSetupCutoffLedger,
  creatorManifestVersion,
  sources,
  candidates,
  completedAt,
}) {
  const results = (candidates ?? []).map((c) =>
    classifyCandidate({ candidate: c, directSetupCutoffLedger })
  )
  const verifiedAgents = results.filter((r) => r.status === 'verified').map((r) => r.membership)
  const rejectedCandidates = results
    .filter((r) => r.status === 'rejected')
    .map((r) => ({ candidate: r.candidate, reason: r.reason }))
  const unresolvedCandidates = results
    .filter((r) => r.status === 'unresolved')
    .map((r) => ({ candidate: r.candidate, reason: r.reason }))
  const verdict = deriveVerdict({ sources, unresolvedCandidates })

  return toBackfillAuditV1({
    auditId,
    networkId,
    fromLedger,
    throughLedger,
    directSetupCutoffLedger,
    creatorManifestVersion,
    sources,
    candidates,
    verifiedAgents,
    rejectedCandidates,
    unresolvedCandidates,
    verdict,
    completedAt,
  })
}

/**
 * The only function that writes backfill results to D1. Posts every verified membership
 * (regardless of the overall verdict — an individually-verified candidate has real on-chain
 * provenance whether or not the REST of the sweep is complete) then persists one immutable
 * agent_backfill_audits row per manifest-tracked source (funding-router/registry) — `result`
 * is 'verified' ONLY when the whole audit verdict is 'verified' AND that specific source
 * reported contiguous coverage; every other case persists 'failed', which is what lets
 * coverageProof (indexer.js) distinguish "never attempted" (pending) from "attempted, not yet
 * closed" (failed) — see models.js BACKFILL_RESULTS / indexer.js coverageProof.
 * @param {{store: ReturnType<import('./store').createAgentIndexStore>, audit: object, method?: string}} p
 */
export async function commitBackfillAudit({ store, audit, method = BACKFILL_METHOD_V1 }) {
  if (!store) throw new Error('commitBackfillAudit requires a store')
  const a = toBackfillAuditV1(audit)

  let membershipsPosted = 0
  for (const membership of a.verifiedAgents) {
    await store.upsertMembership(membership)
    membershipsPosted++
  }

  let auditRowsWritten = 0
  for (const s of a.sources) {
    if (!SOURCE_KINDS_WITH_ROW.has(s.kind)) continue // no agent_index_sources row to FK against
    const sourceId = sourceIdFor({ networkId: a.networkId, creatorAddress: s.address })
    await store.ensureSourceRow({
      sourceId,
      networkId: a.networkId,
      creatorAddress: s.address,
      fromLedger: s.fromLedger,
      providerId: s.providerId,
      endpointClass: 'archival',
      reportedOldestLedger: s.oldestAvailableLedger,
    })
    await store.recordBackfillAudit({
      networkId: a.networkId,
      sourceId,
      method,
      result: a.verdict === 'verified' && s.contiguous ? 'verified' : 'failed',
      fromLedger: s.fromLedger,
      throughLedger: s.throughLedger,
      evidence: {
        auditId: a.auditId,
        evidenceHash: s.evidenceHash,
        providerId: s.providerId,
        oldestAvailableLedger: s.oldestAvailableLedger,
      },
      notes: `verdict=${a.verdict}`,
    })
    auditRowsWritten++
  }

  return { verdict: a.verdict, membershipsPosted, auditRowsWritten }
}
