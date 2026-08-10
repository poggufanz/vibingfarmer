// Pure, DI-friendly route logic for /api/agent-index — no req/res, no real D1/RPC construction
// (that glue lives in ../agent-index.js, which is untested by design: everything worth testing
// here is testable without touching a network or a real Cloudflare binding).
import { randomBytes, randomUUID } from 'node:crypto'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { ingestAgentIndexPage, coverageProof } from './indexer.js'
import { commitBackfillAudit } from './backfill.js'
import {
  advanceBaseChildLifecycle,
  baseChildIdentity,
  ingestAssociationReport,
  ingestBaseChildIntent,
  joinBaseAssociations,
  mergeOwnerBaseAssociations,
  validateBaseChildIntentBatch,
} from './associations.js'
import {
  applyAuthenticatedReceiptMutation,
  issueReceiptChallenge,
  ReceiptAuthError,
  receiptProofMessage,
  receiptRequestDigest,
} from './executionReceipts.js'
import { selectBaseChildRecoveryAction, selectRecoveryAction } from './recovery.js'
import { D1_NETWORK_SCOPED_ADDRESS_CHUNK_SIZE } from './store.js'
import {
  AgentIndexConflictError,
  AgentIndexStoreError,
  AgentIndexUnavailableError,
  AgentIndexValidationError,
  assertNoSensitiveProperties,
  baseChildBatchDigest,
  baseChildRecoveryIdentity,
  BASE_RECOVERY_ACTIONS,
  validateBaseRecoveryRequest,
  validateBaseChildPhaseEvidence,
} from './models.js'
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

const DEFAULT_RECOVERY_LEASE_TTL_MS = 60_000

function agentIndexFailure(error) {
  if (error instanceof AgentIndexValidationError) {
    return { status: 400, body: { error: 'Invalid agent-index request' } }
  }
  if (error instanceof AgentIndexConflictError) {
    return { status: 409, body: { error: 'Agent-index mutation conflict' } }
  }
  if (error instanceof AgentIndexUnavailableError) {
    return { status: 503, body: { error: 'Agent-index dependency unavailable' } }
  }
  if (error instanceof AgentIndexStoreError) {
    return { status: 500, body: { error: 'Internal agent-index error' } }
  }
  if (error instanceof ReceiptAuthError) {
    if (error.code === 'replay') {
      return { status: 409, body: { error: 'Receipt proof was already used' } }
    }
    if (['proof', 'expired'].includes(error.code)) {
      return { status: 401, body: { error: 'Invalid or expired receipt proof' } }
    }
    if (error.code === 'authority') {
      return { status: 403, body: { error: 'Agent authority could not be verified' } }
    }
    if (error.code === 'invalid') {
      return { status: 400, body: { error: 'Invalid receipt mutation' } }
    }
  }
  return { status: 500, body: { error: 'Internal agent-index error' } }
}

function requireConfiguredNetwork(networkId, configuredNetworkId) {
  if (!configuredNetworkId) {
    throw new AgentIndexUnavailableError('Stellar network configuration is unavailable')
  }
  if (typeof networkId !== 'string' || !networkId) {
    throw new AgentIndexValidationError('networkId is required')
  }
  if (networkId !== configuredNetworkId) {
    throw new AgentIndexValidationError('Requested network does not match configured network')
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value) {
    throw new AgentIndexValidationError(`${field} is required`)
  }
  return value
}

function signerPublicKey(value) {
  if (typeof value === 'string' && StrKey.isValidEd25519PublicKey(value)) return value
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const raw = Buffer.from(value)
    if (raw.length === 32) return StrKey.encodeEd25519PublicKey(raw)
  }
  throw new ReceiptAuthError('authority', 'Agent signer authority is invalid')
}

async function readRecoveryAuthority(authorityReader, identity) {
  try {
    return await authorityReader(identity)
  } catch (error) {
    if (error instanceof AgentIndexValidationError || error instanceof AgentIndexUnavailableError) {
      throw error
    }
    throw new AgentIndexUnavailableError('Recovery authority RPC is unavailable', { cause: error })
  }
}

function validateRecoveryAuthority({ facts, owner }) {
  if (!facts || typeof facts !== 'object') {
    throw new ReceiptAuthError('authority', 'Agent authority is unavailable')
  }
  if (facts.routerOwner !== owner) {
    throw new ReceiptAuthError('authority', 'Router owner authority mismatch')
  }
  if (facts.scope?.owner !== owner) {
    throw new ReceiptAuthError('authority', 'Scope owner authority mismatch')
  }
  return { ...facts, signerPublicKey: signerPublicKey(facts.signer) }
}

function verifyRecoveryProof({ challenge, proof, publicKey }) {
  if (proof?.expiresAt !== challenge.expiresAt) {
    throw new ReceiptAuthError('proof', 'Challenge expiry does not match the signed proof')
  }
  let signature
  try {
    signature = Buffer.from(proof?.signature, 'base64url')
  } catch {
    throw new ReceiptAuthError('proof', 'Recovery proof signature is malformed')
  }
  if (signature.length !== 64) {
    throw new ReceiptAuthError('proof', 'Recovery proof signature is malformed')
  }
  if (
    !Keypair.fromPublicKey(publicKey).verify(Buffer.from(receiptProofMessage(challenge)), signature)
  ) {
    throw new ReceiptAuthError(
      'proof',
      'Recovery proof signature does not match the current agent signer'
    )
  }
}

function validateLease(lease, { release = false } = {}) {
  for (const field of ['networkId', 'executionId', 'allocationId', 'phase', 'leaseToken']) {
    requireText(lease?.[field], field)
  }
  if (!release) {
    requireText(lease?.owner, 'owner')
    requireText(lease?.holder, 'holder')
    if (!Number.isSafeInteger(lease?.now)) {
      throw new AgentIndexValidationError('lease.now must be a safe integer')
    }
    if (lease.ttlMs != null && (!Number.isSafeInteger(lease.ttlMs) || lease.ttlMs <= 0)) {
      throw new AgentIndexValidationError('lease.ttlMs must be a positive safe integer')
    }
  }
}

async function reporterGate({ secret, providedSecret }) {
  if (!secret) return { status: 503, body: { error: 'Agent-index writer is not configured' } }
  if (!providedSecret || !(await constantTimeEqual(providedSecret, secret))) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }
  return null
}

// The outer route uses the same constant-time gate before quota and dependency construction.
// Handlers repeat it so direct/in-process callers keep the identical security boundary.
export const reporterAuthenticationGate = reporterGate

export async function handleReceiptChallenge({
  request,
  store,
  authorityReader,
  now = Date.now(),
  challengeId,
}) {
  if (!store) {
    return { status: 503, body: { error: 'Receipt store unavailable', configured: false } }
  }
  if (typeof authorityReader !== 'function') {
    return { status: 503, body: { error: 'Receipt authority is not configured' } }
  }
  try {
    const challenge = await issueReceiptChallenge({
      request,
      store,
      authorityReader,
      now,
      challengeId,
    })
    return { status: 201, body: { ok: true, challenge } }
  } catch (error) {
    const failure = agentIndexFailure(error)
    if (failure.status === 400) {
      return { status: 400, body: { error: 'Invalid receipt challenge request' } }
    }
    if (failure.status === 503) {
      return { status: 503, body: { error: 'Receipt authority is unavailable' } }
    }
    return failure
  }
}

export async function handleReceiptWrite({
  body,
  proof,
  store,
  authorityReader,
  now = Date.now(),
  consumeToken,
}) {
  if (!store) {
    return { status: 503, body: { error: 'Receipt store unavailable', configured: false } }
  }
  try {
    if (typeof authorityReader !== 'function') {
      throw new AgentIndexUnavailableError('Receipt authority is not configured')
    }
    const result = await applyAuthenticatedReceiptMutation({
      body,
      proof,
      store,
      authorityReader,
      now,
      consumeToken,
    })
    return { status: 200, body: { ok: true, ...result } }
  } catch (error) {
    const failure = agentIndexFailure(error)
    if (failure.status === 400) {
      return { status: 400, body: { error: 'Invalid receipt mutation' } }
    }
    if (failure.status === 409) {
      if (error instanceof ReceiptAuthError) return failure
      return { status: 409, body: { error: 'Receipt mutation conflict' } }
    }
    return failure
  }
}

export async function handleReceiptRead({
  networkId,
  configuredNetworkId,
  owner,
  executionId,
  allocationId,
  store,
}) {
  if (!store?.readExecutionReceipt) {
    return { status: 503, body: { error: 'Receipt store unavailable', configured: false } }
  }
  try {
    requireConfiguredNetwork(networkId, configuredNetworkId)
    for (const [value, field] of [
      [owner, 'owner'],
      [executionId, 'executionId'],
      [allocationId, 'allocationId'],
    ]) {
      requireText(value, field)
    }
    const receipt = await store.readExecutionReceipt({
      networkId,
      owner,
      executionId,
      allocationId,
    })
    return receipt
      ? { status: 200, body: { receipt } }
      : { status: 404, body: { error: 'Receipt not found' } }
  } catch (error) {
    return agentIndexFailure(error)
  }
}

export async function handleRecoveryLeaseAcquire({
  lease,
  configuredNetworkId,
  store,
  secret,
  providedSecret,
}) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  if (!store?.acquireRecoveryLease) {
    return { status: 503, body: { error: 'Recovery lease store unavailable', configured: false } }
  }
  try {
    requireConfiguredNetwork(lease?.networkId, configuredNetworkId)
    validateLease(lease)
    const result = await store.acquireRecoveryLease(lease)
    return result.acquired
      ? { status: 200, body: { ok: true, lease: result } }
      : { status: 409, body: { error: 'Recovery lease is already held' } }
  } catch (error) {
    return agentIndexFailure(error)
  }
}

export async function handleRecoveryLeaseRelease({
  lease,
  configuredNetworkId,
  store,
  secret,
  providedSecret,
}) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  if (!store?.releaseRecoveryLease) {
    return { status: 503, body: { error: 'Recovery lease store unavailable', configured: false } }
  }
  try {
    requireConfiguredNetwork(lease?.networkId, configuredNetworkId)
    validateLease(lease, { release: true })
    const result = await store.releaseRecoveryLease(lease)
    return result.released
      ? { status: 200, body: { ok: true } }
      : { status: 409, body: { error: 'Recovery lease release conflict' } }
  } catch (error) {
    return agentIndexFailure(error)
  }
}

/**
 * Authenticates an owner-signed recovery request, consumes its one-time challenge, decides from
 * stored evidence, and claims the derived phase lease when automation may continue.
 */
export async function requestRecovery({
  request,
  proof,
  store,
  authorityReader,
  now = Date.now(),
  leaseTtlMs = DEFAULT_RECOVERY_LEASE_TTL_MS,
}) {
  if (!request || typeof request !== 'object') {
    throw new AgentIndexValidationError('recovery request body is required')
  }
  const executionId = requireText(request.executionId, 'executionId')
  const allocationId = requireText(request.allocationId, 'allocationId')
  const childId =
    request.childId == null || request.childId === '' ? '' : requireText(request.childId, 'childId')
  const leaseOwner = requireText(request.leaseOwner, 'leaseOwner')
  if (!Number.isSafeInteger(request.expectedReceiptVersion) || request.expectedReceiptVersion < 0) {
    throw new AgentIndexValidationError(
      'expectedReceiptVersion must be a non-negative safe integer'
    )
  }
  if (
    !store?.readReceiptChallenge ||
    !store?.consumeReceiptChallenge ||
    !store?.readExecutionReceipt ||
    !store?.acquireRecoveryLease
  ) {
    throw new AgentIndexUnavailableError('Recovery store is unavailable')
  }
  if (typeof authorityReader !== 'function') {
    throw new AgentIndexUnavailableError('Recovery authority is not configured')
  }

  const challenge = await store.readReceiptChallenge({ challengeId: proof?.challengeId })
  if (!challenge) throw new ReceiptAuthError('proof', 'Recovery proof challenge does not exist')
  if (challenge.consumedAt != null) {
    throw new ReceiptAuthError('replay', 'Recovery proof challenge was already consumed')
  }
  if (now >= challenge.expiresAt) {
    throw new ReceiptAuthError('expired', 'Recovery proof challenge expired')
  }
  if (challenge.requestDigest !== receiptRequestDigest(request)) {
    throw new ReceiptAuthError('proof', 'Recovery proof challenge request digest mismatch')
  }

  const facts = await readRecoveryAuthority(authorityReader, {
    networkId: challenge.networkId,
    owner: challenge.owner,
    agent: challenge.agent,
  })
  const currentAuthority = validateRecoveryAuthority({ facts, owner: challenge.owner })
  verifyRecoveryProof({ challenge, proof, publicKey: currentAuthority.signerPublicKey })
  if (currentAuthority.scope?.revoked === true) {
    throw new ReceiptAuthError(
      'authority',
      'Agent scope was revoked; recovery cannot proceed without a replacement signer'
    )
  }

  const receipt = await store.readExecutionReceipt({
    networkId: challenge.networkId,
    executionId,
    allocationId,
    owner: challenge.owner,
  })
  if (receipt && receipt.agent !== challenge.agent) {
    throw new ReceiptAuthError(
      'authority',
      'Recovery agent does not match the receipt agent of record'
    )
  }
  const receiptChildId = receipt?.childId ?? ''
  if (receipt && childId !== receiptChildId) {
    throw new AgentIndexValidationError('childId does not match the stored receipt')
  }
  if (!receipt && childId !== '') {
    throw new AgentIndexValidationError('childId must be absent when no receipt exists')
  }
  // A missing receipt has no authoritative child identity and uses the one no-child lease key.
  const leaseChildId = receiptChildId

  const actualVersion = receipt?.version ?? 0
  const decision = selectRecoveryAction(receipt)
  const consumed = await store.consumeReceiptChallenge({
    challenge,
    consumeToken: randomUUID(),
    now,
  })
  if (!consumed) {
    throw new ReceiptAuthError('replay', 'Recovery proof challenge was already consumed')
  }

  if (request.expectedReceiptVersion !== actualVersion) {
    return {
      ok: false,
      status: 409,
      code: 'version-conflict',
      error: 'Receipt version has moved on since the caller last observed it',
      version: actualVersion,
    }
  }

  if (decision.phase == null) {
    return {
      ok: true,
      ...decision,
      version: actualVersion,
      receipt,
      lease: null,
    }
  }

  const leaseToken = randomUUID()
  const leaseResult = await store.acquireRecoveryLease({
    networkId: challenge.networkId,
    owner: challenge.owner,
    executionId,
    allocationId,
    childId: leaseChildId,
    phase: decision.phase,
    holder: leaseOwner,
    leaseToken,
    now,
    ttlMs: leaseTtlMs,
  })
  if (!leaseResult.acquired) {
    return {
      ok: false,
      status: 409,
      code: 'lease-conflict',
      error: 'Recovery lease is already held',
      version: actualVersion,
    }
  }

  return {
    ok: true,
    ...decision,
    version: actualVersion,
    receipt,
    lease: {
      holder: leaseOwner,
      leaseToken: leaseResult.leaseToken,
      expiresAt: leaseResult.expiresAt,
      phase: decision.phase,
    },
  }
}

/**
 * `POST /api/agent-index?action=recovery-request` (S2-D9). Authenticates the caller with the SAME
 * owner-signed challenge -> proof exchange `receipt-write` uses (a challenge must already exist,
 * issued via the unchanged `?action=receipt-challenge` route), then delegates to
 * `requestRecovery` to read the receipt under the authenticated network/owner,
 * decide the action, and atomically claim the lease for the phase that action would act on.
 *
 * The reporter bearer secret (`AGENT_INDEX_REPORTER_SECRET`) is deliberately NOT used here — that
 * would put a relay-only secret in the browser (Global Constraint), which is exactly why S2-D9
 * exists as a separate, owner-proof-gated route instead of extending `lease-acquire`.
 *
 * Map fact C: a lease conflict and a stale-receipt-version conflict are DIFFERENT events and must
 * not share a message (unlike `handleReceiptWrite`'s collapsed generic 409) — `requestRecovery`
 * already returns those as distinct, non-throwing results (`code: 'lease-conflict'` /
 * `'version-conflict'`), so they are passed straight through instead of being remapped to one
 * generic string here.
 * @param {object} p
 * @param {{executionId:string, allocationId:string, childId?:string|null,
 *   expectedReceiptVersion:number, leaseOwner:string}} p.request
 * @param {{challengeId:string, expiresAt:number, signature:string}} p.proof
 * @param {ReturnType<import('./store').createAgentIndexStore>|null} p.store
 * @param {(identity:{networkId:string, agent:string}) => Promise<object>} p.authorityReader
 * @param {number} [p.now]
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleRecoveryRequest({
  request,
  proof,
  store,
  authorityReader,
  now = Date.now(),
}) {
  if (!store) {
    return { status: 503, body: { error: 'Receipt store unavailable', configured: false } }
  }
  try {
    if (typeof authorityReader !== 'function') {
      throw new AgentIndexUnavailableError('Receipt authority is not configured')
    }
    const result = await requestRecovery({ request, proof, store, authorityReader, now })
    if (!result.ok) {
      return {
        status: result.status,
        body: { error: result.error, code: result.code, version: result.version },
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        action: result.action,
        reasonCode: result.reasonCode,
        reason: result.reason,
        phase: result.phase,
        version: result.version,
        receipt: result.receipt,
        lease: result.lease,
      },
    }
  } catch (error) {
    const failure = agentIndexFailure(error)
    if (failure.status === 400) {
      return { status: 400, body: { error: 'Invalid recovery request' } }
    }
    if (failure.status === 409) {
      // requestRecovery returns its OTHER 409s (lease-conflict, version-conflict) as structured,
      // non-throwing results above so they stay distinguishable per-message (map fact C) -- only a
      // replayed-challenge ReceiptAuthError reaches this throw path.
      if (error instanceof ReceiptAuthError) return failure
      return { status: 409, body: { error: 'Recovery request conflict' } }
    }
    return failure
  }
}

const BASE_RECOVERY_ACTION_PHASE = Object.freeze({
  'poll-attestation': 'cctp_attestation',
  'submit-mint': 'cctp_mint',
  'poll-mint': 'cctp_mint',
  'submit-base-deposit': 'base_deposit',
  'poll-base-deposit': 'base_deposit',
})
const BASE_RECOVERY_CLAIM_FIELDS = new Set(['identity', 'action', 'evidenceVersion', 'leaseToken'])
const BASE_RECOVERY_RENEW_FIELDS = new Set([
  'identity',
  'action',
  'evidenceVersion',
  'holder',
  'leaseToken',
])
const BASE_RECOVERY_RELEASE_FIELDS = new Set([
  'identity',
  'action',
  'evidenceVersion',
  'leaseToken',
])

function validateBaseRecoveryExactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentIndexValidationError(`${label} must be an object`)
  }
  const keys = Object.keys(value)
  if (
    keys.length !== fields.size ||
    keys.some((key) => !fields.has(key)) ||
    [...fields].some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new AgentIndexValidationError(`Invalid ${label}`)
  }
}

function validateBaseRecoveryClaimBody(body, fields = BASE_RECOVERY_CLAIM_FIELDS) {
  validateBaseRecoveryExactObject(body, fields, 'Base recovery claim')
  const identity = baseChildRecoveryIdentity(body.identity)
  if (!BASE_RECOVERY_ACTIONS.includes(body.action) || !BASE_RECOVERY_ACTION_PHASE[body.action]) {
    throw new AgentIndexValidationError('Base recovery claim action is not claimable')
  }
  if (!Number.isSafeInteger(body.evidenceVersion) || body.evidenceVersion < 0) {
    throw new AgentIndexValidationError('Base recovery claim evidence version is invalid')
  }
  if (typeof body.leaseToken !== 'string' || !/^[0-9a-f]{64}$/.test(body.leaseToken)) {
    throw new AgentIndexValidationError('Base recovery claim lease token is invalid')
  }
  if (Object.prototype.hasOwnProperty.call(body, 'holder')) {
    if (typeof body.holder !== 'string' || body.holder.length === 0 || body.holder.length > 128) {
      throw new AgentIndexValidationError('Base recovery claim holder is invalid')
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'now')) {
    if (!Number.isSafeInteger(body.now) || body.now < 0) {
      throw new AgentIndexValidationError('Base recovery claim time is invalid')
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'ttlMs')) {
    if (!Number.isSafeInteger(body.ttlMs) || body.ttlMs <= 0) {
      throw new AgentIndexValidationError('Base recovery claim TTL is invalid')
    }
  }
  return { ...body, identity }
}

function baseRecoveryClaimFailure(error) {
  const failure = agentIndexFailure(error)
  if (failure.status === 400) return { status: 400, body: { error: 'Invalid Base recovery claim' } }
  if (failure.status === 401 || failure.status === 403) {
    return { status: 403, body: { error: 'Base recovery authorization failed' } }
  }
  if (failure.status === 409) return failure
  return failure
}

function baseRecoveryPublicClaim({ identity, action, phase, reasonCode, evidenceVersion, lease }) {
  return { ok: true, identity, action, phase, reasonCode, evidenceVersion, lease }
}

function baseRecoveryReporterLease(claim) {
  if (!claim) return null
  return {
    identity: claim.identity,
    owner: claim.owner,
    action: claim.action,
    phase: claim.phase,
    evidenceVersion: claim.evidenceVersion,
    holder: claim.holder,
    leaseToken: claim.leaseToken,
    acquiredAt: claim.acquiredAt,
    expiresAt: claim.expiresAt,
  }
}

function baseRecoveryLeaseToken() {
  return randomBytes(32).toString('hex')
}

/**
 * Browser proof-gated Base recovery claim.  The caller signs only the full child identity and
 * expected version; selector action/phase and every lease fact are recomputed from D1 evidence.
 */
export async function handleBaseRecoveryRequest({
  request,
  proof,
  store,
  authorityReader,
  now = Date.now(),
  leaseTtlMs = 30_000,
}) {
  if (!store)
    return { status: 503, body: { error: 'Base recovery store unavailable', configured: false } }
  try {
    const parsed = validateBaseRecoveryRequest(request)
    validateBaseRecoveryExactObject(
      proof,
      new Set(['challengeId', 'expiresAt', 'signature']),
      'Base recovery proof'
    )
    if (
      !store.readReceiptChallenge ||
      !store.consumeReceiptChallenge ||
      !store.readBaseChildRecoveryBundle ||
      !store.acquireBaseChildRecoveryLease
    ) {
      throw new AgentIndexUnavailableError('Base recovery store is unavailable')
    }
    if (typeof authorityReader !== 'function')
      throw new AgentIndexUnavailableError('Base recovery authority is not configured')
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(leaseTtlMs) ||
      leaseTtlMs <= 0
    ) {
      throw new AgentIndexValidationError('Base recovery claim time is invalid')
    }
    const challenge = await store.readReceiptChallenge({ challengeId: proof?.challengeId })
    if (!challenge)
      throw new ReceiptAuthError('proof', 'Base recovery proof challenge does not exist')
    if (challenge.consumedAt != null)
      throw new ReceiptAuthError('replay', 'Base recovery proof challenge was already consumed')
    if (now >= challenge.expiresAt)
      throw new ReceiptAuthError('expired', 'Base recovery proof challenge expired')
    if (challenge.requestDigest !== receiptRequestDigest(parsed))
      throw new ReceiptAuthError('proof', 'Base recovery proof challenge request digest mismatch')
    const currentAuthority = validateRecoveryAuthority({
      facts: await readRecoveryAuthority(authorityReader, {
        networkId: challenge.networkId,
        owner: challenge.owner,
        agent: challenge.agent,
      }),
      owner: challenge.owner,
    })
    verifyRecoveryProof({ challenge, proof, publicKey: currentAuthority.signerPublicKey })
    const identity = {
      networkId: challenge.networkId,
      bindingId: parsed.bindingId,
      executionId: parsed.executionId,
      allocationId: parsed.allocationId,
      childId: parsed.childId,
    }
    const bundle = await store.readBaseChildRecoveryBundle(identity)
    if (
      !bundle ||
      bundle.owner !== challenge.owner ||
      bundle.agent !== challenge.agent ||
      !baseChildRecoveryIdentity(bundle.identity) ||
      Object.entries(identity).some(([key, value]) => bundle.identity[key] !== value)
    ) {
      throw new ReceiptAuthError('authority', 'Base recovery child is not available to this signer')
    }
    const decision = selectBaseChildRecoveryAction(bundle)
    const consumed = await store.consumeReceiptChallenge({
      challenge,
      consumeToken: randomUUID(),
      now,
    })
    if (!consumed)
      throw new ReceiptAuthError('replay', 'Base recovery proof challenge was already consumed')
    if (parsed.expectedRecoveryVersion !== bundle.recoveryVersion) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'version-conflict',
          error: 'Base recovery evidence version has moved on since the caller observed it',
          evidenceVersion: bundle.recoveryVersion,
        },
      }
    }
    if (!decision.phase) {
      return {
        status: 200,
        body: baseRecoveryPublicClaim({
          identity,
          action: decision.action,
          phase: null,
          reasonCode: decision.reasonCode,
          evidenceVersion: bundle.recoveryVersion,
          lease: null,
        }),
      }
    }
    const leaseToken = baseRecoveryLeaseToken()
    const leaseResult = await store.acquireBaseChildRecoveryLease({
      identity,
      owner: challenge.owner,
      action: decision.action,
      phase: decision.phase,
      evidenceVersion: bundle.recoveryVersion,
      holder: parsed.leaseOwner,
      leaseToken,
      now,
      ttlMs: leaseTtlMs,
    })
    if (!leaseResult?.acquired) {
      return {
        status: 409,
        body: {
          ok: false,
          code: leaseResult?.code === 'version-conflict' ? 'version-conflict' : 'lease-conflict',
          error:
            leaseResult?.code === 'version-conflict'
              ? 'Base recovery evidence version has moved on since the caller observed it'
              : 'Base recovery lease is already held',
          ...(leaseResult?.currentVersion != null
            ? { evidenceVersion: leaseResult.currentVersion }
            : {}),
        },
      }
    }
    return {
      status: 200,
      body: baseRecoveryPublicClaim({
        identity,
        action: decision.action,
        phase: decision.phase,
        reasonCode: decision.reasonCode,
        evidenceVersion: bundle.recoveryVersion,
        lease: {
          holder: parsed.leaseOwner,
          leaseToken: leaseResult.leaseToken,
          expiresAt: leaseResult.expiresAt,
        },
      }),
    }
  } catch (error) {
    return baseRecoveryClaimFailure(error)
  }
}

async function readAndRecomputeBaseClaim({ body, store, now }) {
  const claim = await store.readBaseChildRecoveryClaim({
    ...body,
    now,
    includeVersionConflict: true,
  })
  if (!claim) return null
  if (claim.conflict === 'version') return claim
  const bundle = await store.readBaseChildRecoveryBundle(body.identity)
  if (
    !bundle ||
    claim.owner !== bundle.owner ||
    claim.agent !== bundle.agent ||
    !baseChildRecoveryIdentity(bundle.identity) ||
    Object.entries(body.identity).some(([key, value]) => bundle.identity[key] !== value)
  )
    return null
  if (
    bundle.recoveryVersion !== body.evidenceVersion ||
    claim.evidenceVersion !== body.evidenceVersion
  ) {
    return { conflict: 'version', currentVersion: bundle.recoveryVersion }
  }
  const decision = selectBaseChildRecoveryAction(bundle)
  if (
    decision.action !== body.action ||
    decision.phase !== BASE_RECOVERY_ACTION_PHASE[body.action] ||
    (decision.phase == null && BASE_RECOVERY_ACTION_PHASE[body.action] != null)
  )
    return null
  return { claim, bundle, decision }
}

/** Reporter-only exact claim read; never mounted as a public GET. */
export async function handleBaseRecoveryClaim({
  body,
  store,
  secret,
  providedSecret,
  now = Date.now(),
}) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  try {
    const parsed = validateBaseRecoveryClaimBody(body)
    if (!store?.readBaseChildRecoveryClaim || !store?.readBaseChildRecoveryBundle)
      throw new AgentIndexUnavailableError('Base recovery claim store is unavailable')
    const result = await readAndRecomputeBaseClaim({ body: parsed, store, now })
    if (!result) return { status: 404, body: { error: 'Base recovery claim not found' } }
    if (result.conflict === 'version')
      return {
        status: 409,
        body: {
          error: 'Base recovery evidence version has moved on',
          code: 'version-conflict',
          evidenceVersion: result.currentVersion,
        },
      }
    return {
      status: 200,
      body: {
        ok: true,
        identity: parsed.identity,
        action: result.decision.action,
        phase: result.decision.phase,
        reasonCode: result.decision.reasonCode,
        evidenceVersion: result.bundle.recoveryVersion,
        lease: baseRecoveryReporterLease(result.claim),
        bundle: result.bundle,
      },
    }
  } catch (error) {
    return baseRecoveryClaimFailure(error)
  }
}

export async function handleBaseRecoveryRenew({
  body,
  store,
  secret,
  providedSecret,
  now = Date.now(),
  leaseTtlMs = 30_000,
}) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  try {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(leaseTtlMs) ||
      leaseTtlMs <= 0
    ) {
      throw new AgentIndexValidationError('Base recovery renewal timing is invalid')
    }
    const parsed = validateBaseRecoveryClaimBody(body, BASE_RECOVERY_RENEW_FIELDS)
    if (
      !store?.readBaseChildRecoveryClaim ||
      !store?.readBaseChildRecoveryBundle ||
      !store?.renewBaseChildRecoveryLease
    )
      throw new AgentIndexUnavailableError('Base recovery claim store is unavailable')
    const result = await readAndRecomputeBaseClaim({ body: parsed, store, now })
    if (!result)
      return {
        status: 409,
        body: { error: 'Base recovery claim is stale', code: 'version-conflict' },
      }
    if (result.conflict === 'version')
      return {
        status: 409,
        body: {
          error: 'Base recovery evidence version has moved on',
          code: 'version-conflict',
          evidenceVersion: result.currentVersion,
        },
      }
    const renewed = await store.renewBaseChildRecoveryLease({
      ...parsed,
      phase: result.decision.phase,
      now,
      ttlMs: leaseTtlMs,
    })
    if (!renewed?.renewed)
      return {
        status: 409,
        body: { error: 'Base recovery lease is no longer held', code: 'lease-conflict' },
      }
    return {
      status: 200,
      body: {
        ok: true,
        identity: parsed.identity,
        action: parsed.action,
        phase: result.decision.phase,
        evidenceVersion: parsed.evidenceVersion,
        lease: {
          holder: parsed.holder,
          leaseToken: parsed.leaseToken,
          expiresAt: renewed.expiresAt,
        },
      },
    }
  } catch (error) {
    return baseRecoveryClaimFailure(error)
  }
}

export async function handleBaseRecoveryRelease({ body, store, secret, providedSecret }) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  try {
    const parsed = validateBaseRecoveryClaimBody(body, BASE_RECOVERY_RELEASE_FIELDS)
    if (!store?.releaseBaseChildRecoveryLease)
      throw new AgentIndexUnavailableError('Base recovery claim store is unavailable')
    const released = await store.releaseBaseChildRecoveryLease(parsed)
    return released?.released
      ? { status: 200, body: { ok: true } }
      : {
          status: 409,
          body: { error: 'Base recovery lease release conflict', code: 'lease-conflict' },
        }
  } catch (error) {
    return baseRecoveryClaimFailure(error)
  }
}

export async function handleBaseChildIntent({
  child,
  configuredNetworkId,
  store,
  secret,
  providedSecret,
}) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  if (!store?.createBaseChildIntent) {
    return { status: 503, body: { error: 'Base child store unavailable', configured: false } }
  }
  try {
    requireConfiguredNetwork(child?.networkId, configuredNetworkId)
    const result = await ingestBaseChildIntent({ child, store })
    return {
      status: 201,
      body: {
        acknowledged: true,
        identity: baseChildIdentity(child),
        schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
        ...result,
      },
    }
  } catch (error) {
    return agentIndexFailure(error)
  }
}

export async function handleBaseChildIntentBatch({
  batch,
  configuredNetworkId,
  store,
  secret,
  providedSecret,
  authorityReader,
  poolTargets,
  scopeRequirements,
  maxBatchSize,
}) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  try {
    requireConfiguredNetwork(batch?.children?.[0]?.networkId, configuredNetworkId)
    if (!store?.reserveBaseChildIntentBatch || !store?.readMembershipsByAgentAddresses) {
      throw new AgentIndexUnavailableError('Base child batch store is unavailable')
    }
    if (typeof authorityReader !== 'function') {
      throw new AgentIndexUnavailableError('Base child authority reader is unavailable')
    }
    if (maxBatchSize === null) {
      throw new AgentIndexUnavailableError('Base child batch limit is misconfigured')
    }
    const result = await validateBaseChildIntentBatch({
      batch,
      store,
      authorityReader,
      poolTargets,
      scopeRequirements,
      supportedNetworkId: configuredNetworkId,
      ...(maxBatchSize == null ? {} : { maxBatchSize }),
    })
    return {
      status: 201,
      body: {
        acknowledged: true,
        schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
        idempotencyKey: batch.idempotencyKey,
        requestDigest: baseChildBatchDigest(batch),
        children: result.children,
        written: result.written,
        duplicates: result.duplicates,
      },
    }
  } catch (error) {
    return agentIndexFailure(error)
  }
}

const EVIDENCE_REQUEST_FIELDS = new Set([
  'schemaVersion',
  'identity',
  'expectedRecoveryVersion',
  'event',
])
const EVIDENCE_EVENT_FIELDS = new Set(['eventId', 'phase', 'state', 'evidence', 'observedAt'])
const RECOVERY_IDENTITY_FIELDS = new Set([
  'networkId',
  'bindingId',
  'executionId',
  'allocationId',
  'childId',
])

function requireExactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentIndexValidationError(`${label} must be an object`)
  }
  const keys = Object.keys(value)
  const unexpected = keys.find((key) => !fields.has(key))
  const missing = [...fields].find((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (unexpected || missing) throw new AgentIndexValidationError(`Invalid ${label}`)
}

function validateEvidenceRequest(request) {
  try {
    requireExactObject(request, EVIDENCE_REQUEST_FIELDS, 'Base child evidence request')
    requireExactObject(request.identity, RECOVERY_IDENTITY_FIELDS, 'Base child recovery identity')
    requireExactObject(request.event, EVIDENCE_EVENT_FIELDS, 'Base child evidence event')
    if (request.schemaVersion !== AGENT_INDEX_SCHEMA_VERSION) {
      throw new AgentIndexValidationError('Unsupported Base child evidence schema')
    }
    baseChildRecoveryIdentity(request.identity)
    assertNoSensitiveProperties(request)
    validateBaseChildPhaseEvidence({
      phase: request.event.phase,
      state: request.event.state,
      evidence: request.event.evidence ?? {},
    })
  } catch (error) {
    if (error instanceof AgentIndexValidationError) throw error
    throw new AgentIndexValidationError('Invalid Base child phase evidence', { cause: error })
  }
}

export async function handleBaseChildEvidenceWrite({
  request,
  configuredNetworkId,
  store,
  secret,
  providedSecret,
}) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  try {
    validateEvidenceRequest(request)
    requireConfiguredNetwork(request.identity.networkId, configuredNetworkId)
    if (!store?.advanceBaseChildPhase) {
      throw new AgentIndexUnavailableError('Base child evidence store is unavailable')
    }
    const result = await store.advanceBaseChildPhase(request)
    return {
      status: 201,
      body: {
        acknowledged: true,
        schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
        identity: request.identity,
        eventId: request.event.eventId,
        phase: request.event.phase,
        state: request.event.state,
        recoveryVersion: result.recoveryVersion,
        evidenceDigest: result.evidenceDigest,
        reportDigest: result.reportDigest,
        written: result.written,
        duplicates: result.duplicates,
      },
    }
  } catch (error) {
    return agentIndexFailure(error)
  }
}

const PUBLIC_EVIDENCE_FIELDS = new Set([
  'burnTxHash',
  'expectationDigest',
  'burnUnits7',
  'messageDigest',
  'attestationDigest',
  'evidenceVersion',
  'mintTxHash',
  'userOpHash',
  'transactionHash',
  'blockNumber',
  'blockHash',
  'chainId',
  'kernelAddress',
  'yieldRouterAddress',
  'yieldRouter',
  'caller',
  'poolAddress',
  'assets',
  'minShares',
  'shares',
  'nonce',
  'reconcileHandle',
  'reasonCode',
  'custodyLocation',
  'kernelCustodyConfirmed',
  'token',
  'units',
  'decimals',
  'destinationDomain',
  'messageHash',
  'attestationHash',
  'mintRecipient',
  'logIndex',
  'event',
  'custody',
])

const PUBLIC_BASE_INTENT_FIELDS = [
  'runId',
  'grantTxHash',
  'bindingHash',
  'baseJobId',
  'kernelAddress',
  'poolAddress',
  'proxyTarget',
  'token',
  'units',
  'decimals',
  'minShares',
]
const PUBLIC_BASE_EVENT_FIELDS = [
  'eventId',
  'identity',
  'owner',
  'agent',
  'recoveryVersion',
  'phase',
  'state',
  'evidence',
  'observedAt',
]

function publicBaseScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function publicBaseEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output = {}
  for (const field of [
    'address',
    'topic0',
    'logIndex',
    'caller',
    'poolAddress',
    'assets',
    'shares',
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, field) && publicBaseScalar(value[field])) {
      output[field] = value[field]
    }
  }
  return output
}

function publicBaseReconcileHandle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const output = {}
  for (const field of ['entryPoint', 'sender', 'nonce', 'startBlock']) {
    if (Object.prototype.hasOwnProperty.call(value, field) && publicBaseScalar(value[field])) {
      output[field] = value[field]
    }
  }
  return Object.keys(output).length === 4 ? output : null
}

function publicEvidence(value, phase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!PUBLIC_EVIDENCE_FIELDS.has(key)) continue
    if (key === 'nonce' && phase === 'base_deposit') continue
    if (key === 'event') {
      output[key] = publicBaseEvent(entry)
      continue
    }
    if (key === 'reconcileHandle') {
      const handle = publicBaseReconcileHandle(entry)
      if (handle) output[key] = handle
      continue
    }
    if (key === 'custody') {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const custody = {}
        for (const field of ['location', 'confirmed']) {
          if (
            Object.prototype.hasOwnProperty.call(entry, field) &&
            publicBaseScalar(entry[field])
          ) {
            custody[field] = entry[field]
          }
        }
        output[key] = custody
      }
      continue
    }
    if (publicBaseScalar(entry)) output[key] = entry
  }
  return output
}

function publicBaseIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output = {}
  for (const field of PUBLIC_BASE_INTENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field) && publicBaseScalar(value[field])) {
      output[field] = value[field]
    }
  }
  return output
}

function publicBaseIdentity(value, fallback) {
  return baseChildRecoveryIdentity(value ?? fallback)
}

export function publicBaseChildEvidenceSummary(bundle) {
  const identity = baseChildRecoveryIdentity(bundle.identity)
  return {
    schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
    identity,
    owner: typeof bundle.owner === 'string' ? bundle.owner : '',
    agent: typeof bundle.agent === 'string' ? bundle.agent : '',
    recoverable: bundle.recoverable === true,
    recoveryVersion: bundle.recoveryVersion,
    intent: publicBaseIntent(bundle.intent),
    phases: (bundle.phases ?? []).map((phase) => ({
      identity: publicBaseIdentity(phase.identity, identity),
      phase: phase.phase,
      state: phase.state,
      eventId: phase.eventId,
      recoveryVersion: phase.recoveryVersion,
      observedAt: phase.observedAt,
      evidence: publicEvidence(phase.evidence, phase.phase),
    })),
    events: (bundle.events ?? []).map((event) => {
      const output = {}
      for (const field of PUBLIC_BASE_EVENT_FIELDS) {
        if (field === 'identity') {
          output.identity = publicBaseIdentity(event.identity, identity)
        } else if (field === 'evidence') {
          output.evidence = publicEvidence(event.evidence, event.phase)
        } else if (
          Object.prototype.hasOwnProperty.call(event, field) &&
          publicBaseScalar(event[field])
        ) {
          output[field] = event[field]
        }
      }
      return output
    }),
  }
}

export async function handleBaseChildEvidenceRead({ identity, configuredNetworkId, store }) {
  try {
    requireExactObject(identity, RECOVERY_IDENTITY_FIELDS, 'Base child recovery identity')
    const normalized = baseChildRecoveryIdentity(identity)
    if (configuredNetworkId !== undefined) {
      requireConfiguredNetwork(normalized.networkId, configuredNetworkId)
    }
    if (!store?.readPublicBaseChildEvidence) {
      throw new AgentIndexUnavailableError('Base child evidence store is unavailable')
    }
    const bundle = await store.readPublicBaseChildEvidence(normalized)
    if (!bundle) return { status: 404, body: { error: 'Base child evidence not found' } }
    return { status: 200, body: publicBaseChildEvidenceSummary(bundle) }
  } catch (error) {
    return agentIndexFailure(error)
  }
}

export async function handleReporterReadiness({ store, secret, providedSecret }) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  if (!store?.probeReadiness) {
    return { status: 503, body: { error: 'Base child store unavailable', configured: false } }
  }
  try {
    const result = await store.probeReadiness()
    if (
      result?.writable !== true ||
      result?.schemaVersion !== AGENT_INDEX_SCHEMA_VERSION ||
      result?.stores?.executionReceipts !== true ||
      result?.stores?.baseChildIntents !== true ||
      result?.stores?.baseRecoveryEvidence !== true
    ) {
      return { status: 503, body: { error: 'Base child store unavailable', configured: true } }
    }
    return {
      status: 200,
      body: {
        ready: true,
        schemaVersion: result.schemaVersion,
        stores: {
          executionReceipts: true,
          baseChildIntents: true,
          baseRecoveryEvidence: true,
        },
      },
    }
  } catch {
    return { status: 503, body: { error: 'Base child store unavailable', configured: true } }
  }
}

export async function handleBaseChildLifecycle({
  request,
  configuredNetworkId,
  store,
  secret,
  providedSecret,
}) {
  const gate = await reporterGate({ secret, providedSecret })
  if (gate) return gate
  if (!store?.advanceBaseChildLifecycle) {
    return { status: 503, body: { error: 'Base child store unavailable', configured: false } }
  }
  try {
    requireConfiguredNetwork(request?.identity?.networkId, configuredNetworkId)
    const result = await advanceBaseChildLifecycle({ ...request, store })
    return {
      status: 200,
      body: {
        acknowledged: true,
        identity: request.identity,
        sequence: result.sequence,
        schemaVersion: AGENT_INDEX_SCHEMA_VERSION,
        written: result.written,
        duplicates: result.duplicates,
      },
    }
  } catch (error) {
    return agentIndexFailure(error)
  }
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
      : { sourceId, ok: false, error: 'AGENT_INDEX_SOURCE_UNAVAILABLE' }
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
  } catch {
    return { status: 400, body: { error: 'AGENT_INDEX_BACKFILL_FAILED' } }
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
  } catch {
    return { status: 400, body: { error: 'AGENT_INDEX_ASSOCIATION_FAILED' } }
  }
}

function unavailableBody({ networkId, owner, manifest, now, pagination }) {
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
    pagination: pagination ?? {
      hasMore: false,
      nextCursor: null,
      snapshotThroughLedger: null,
      coverageStatus: 'unavailable',
    },
  }
}

const DEFAULT_READ_LIMIT = 200
const MAX_READ_LIMIT = 500

async function validateOwnerAssociationMemberships({
  associations,
  store,
  networkId,
  owner,
  isValidAddress,
}) {
  const addresses = [...new Set(associations.map((row) => row.bridgeAgentAddress))]
  const addressSet = new Set(addresses)
  if (addresses.some((address) => !isValidAddress(address))) {
    throw new AgentIndexValidationError('Base association agent address is invalid')
  }
  const memberships = []
  for (let offset = 0; offset < addresses.length; offset += D1_NETWORK_SCOPED_ADDRESS_CHUNK_SIZE) {
    memberships.push(
      ...(await store.readMembershipsByAgentAddresses({
        networkId,
        agentAddresses: addresses.slice(offset, offset + D1_NETWORK_SCOPED_ADDRESS_CHUNK_SIZE),
      }))
    )
  }
  const membershipByAddress = new Map()
  for (const membership of memberships) {
    if (
      membership.networkId !== networkId ||
      membership.owner !== owner ||
      !addressSet.has(membership.address) ||
      membershipByAddress.has(membership.address)
    ) {
      throw new AgentIndexValidationError('Base association membership scope is invalid')
    }
    membershipByAddress.set(membership.address, membership)
  }
  for (const association of associations) {
    if (
      association.networkId !== networkId ||
      association.ownerAddress !== owner ||
      membershipByAddress.get(association.bridgeAgentAddress)?.address !==
        association.bridgeAgentAddress
    ) {
      throw new AgentIndexValidationError('Base association has no exact owner membership')
    }
  }
}

/**
 * `GET /api/agent-index?network=<networkId>&owner=<G-or-C-StrKey>&limit=<n>&cursor=<token>`.
 * Public, read-only,
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
  cursor,
  cursorCodec,
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
  if (limit !== undefined && limit !== null) {
    const n =
      typeof limit === 'number'
        ? limit
        : typeof limit === 'string' && /^\d+$/u.test(limit)
          ? Number(limit)
          : Number.NaN
    if (!Number.isInteger(n) || n < 1 || n > MAX_READ_LIMIT) {
      return { status: 400, body: { error: 'Invalid limit' } }
    }
    effectiveLimit = n
  }
  if (!store) {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }
  // Both stores remain required during the dual-read migration. The 0006 intent/lifecycle model
  // is authoritative; 0004 rows are compatibility fallback for children not yet dual-written.
  // Missing either reader is a deploy/version skew and must never look like a complete empty set.
  if (
    typeof store.readOwnerBaseChildIntents !== 'function' ||
    typeof store.readOwnerRunAllocations !== 'function' ||
    typeof store.readOwnerMembershipsPage !== 'function' ||
    typeof store.readOwnerMaximumCreationLedger !== 'function' ||
    typeof store.readMembershipsByAgentAddresses !== 'function'
  ) {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }

  const startedFromCursor = cursor !== undefined && cursor !== null && cursor !== ''
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    return { status: 400, body: { error: 'Invalid cursor' } }
  }
  if (startedFromCursor && !cursorCodec) {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }

  let coverage
  let proof
  try {
    coverage = await store.readCoverage({ networkId })
    proof = coverageProof({
      manifest,
      sources: coverage.sources,
      gaps: coverage.gaps,
      backfillAudit: coverage.backfillAudits,
      now,
    })
  } catch {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }

  let afterLedger = -1
  let afterAddress = ''
  let snapshotThroughLedger
  if (startedFromCursor) {
    try {
      const decoded = await cursorCodec.decode(cursor, {
        networkId,
        owner,
        manifestHash: manifest.hash,
      })
      snapshotThroughLedger = decoded.snapshotThroughLedger
      afterLedger = decoded.afterLedger
      afterAddress = decoded.afterAddress
    } catch {
      return { status: 400, body: { error: 'Invalid cursor' } }
    }
  } else if (Number.isSafeInteger(proof.finalizedThroughLedger)) {
    snapshotThroughLedger = proof.finalizedThroughLedger
  } else if (proof.status !== 'complete') {
    try {
      snapshotThroughLedger =
        (await store.readOwnerMaximumCreationLedger({ networkId, owner })) ?? 0
    } catch {
      return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
    }
  } else {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }

  let memberships
  let hasMore
  let authoritativeChildren
  let legacyAssociations
  try {
    const [page, children, legacy] = await Promise.all([
      store.readOwnerMembershipsPage({
        networkId,
        owner,
        limit: effectiveLimit,
        afterLedger,
        afterAddress,
        snapshotThroughLedger,
      }),
      store.readOwnerBaseChildIntents({ networkId, owner }),
      store.readOwnerRunAllocations({ networkId, owner }),
    ])
    memberships = page.rows
    hasMore = page.hasMore
    authoritativeChildren = children
    legacyAssociations = legacy
  } catch {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }

  const { status: coverageStatus, ...coverageOut } = proof
  // Never trust stored rows blindly to be well-formed StrKeys — a membership whose address or
  // creator fails validation is dropped from the response, never guessed or coerced (Minor 7).
  const agents = memberships
    .filter((m) => isValidAddress(m.address) && isValidAddress(m.creator))
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
  const pageAddresses = new Set(agents.map((agent) => agent.address))
  let associations
  try {
    associations = mergeOwnerBaseAssociations({
      authoritativeChildren,
      legacyAssociations,
    })
    await validateOwnerAssociationMemberships({
      associations,
      store,
      networkId,
      owner,
      isValidAddress,
    })
  } catch {
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }
  const pageAssociations = associations.filter((row) => pageAddresses.has(row.bridgeAgentAddress))
  let associatedAgents
  try {
    associatedAgents = joinBaseAssociations({ agents, associations: pageAssociations, now })
  } catch (error) {
    if (!(error instanceof AgentIndexValidationError)) throw error
    return { status: 200, body: unavailableBody({ networkId, owner, manifest, now }) }
  }

  let nextCursor = null
  if (hasMore) {
    if (!cursorCodec) {
      return {
        status: 200,
        body: unavailableBody({
          networkId,
          owner,
          manifest,
          now,
          pagination: {
            hasMore: true,
            nextCursor: null,
            snapshotThroughLedger,
            coverageStatus,
          },
        }),
      }
    }
    const boundary = memberships.at(-1)
    try {
      nextCursor = await cursorCodec.encode({
        version: 1,
        networkId,
        owner,
        manifestHash: manifest.hash,
        snapshotThroughLedger,
        afterLedger: boundary.createdLedger,
        afterAddress: boundary.address,
      })
    } catch {
      return {
        status: 200,
        body: unavailableBody({
          networkId,
          owner,
          manifest,
          now,
          pagination: {
            hasMore: true,
            nextCursor: null,
            snapshotThroughLedger,
            coverageStatus,
          },
        }),
      }
    }
  }
  return {
    status: 200,
    body: {
      version: 1,
      networkId,
      owner,
      status: hasMore || startedFromCursor ? 'partial' : coverageStatus,
      agents: associatedAgents,
      coverage: coverageOut,
      pagination: { hasMore, nextCursor, snapshotThroughLedger, coverageStatus },
    },
  }
}
