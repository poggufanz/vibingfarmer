import { hash } from '@stellar/stellar-sdk'
import { selectBaseChildRecoveryAction } from '../../api/agent-index/recovery.js'
import {
  baseRecoveryIdentityKey,
  requireBaseRecoveryIdentity,
  sameBaseRecoveryIdentity,
} from './baseRecoveryIdentity.js'

const AGENT_INDEX_PATH = '/api/agent-index'
const RELAYER_RECOVERY_PATH = '/api/vf-cross/farm/recover'
const PROOF_PREFIX = 'vf-agent-index/receipt-proof/v1'
const LOWER_HEX_128 = /^[0-9a-f]{32}$/
const LOWER_HEX_256 = /^[0-9a-f]{64}$/
const ACTIONS = new Set([
  'poll-attestation',
  'submit-mint',
  'poll-mint',
  'submit-base-deposit',
  'poll-base-deposit',
])
const PUBLIC_BUNDLE_FIELDS = [
  'schemaVersion',
  'identity',
  'owner',
  'agent',
  'recoverable',
  'recoveryVersion',
  'intent',
  'phases',
  'events',
]
const IDENTITY_FIELDS = ['networkId', 'bindingId', 'executionId', 'allocationId', 'childId']
const SENSITIVE =
  /secret|private|capability|bearer|authorization|cookie|wallet|passkey|signedxdr|approval|sessionkey|leasetoken/i

export class BaseRecoveryClientError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BaseRecoveryClientError'
    Object.assign(this, options)
  }
}

function fail(message, options = {}) {
  throw new BaseRecoveryClientError(message, options)
}

function exactObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === fields.length && keys.every((key) => fields.includes(key))
}

function requireOptions(value, fields, step) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Base recovery request is malformed', { step, code: 'invalid-request' })
  }
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    fail('Base recovery request is malformed', { step, code: 'invalid-request' })
  }
  assertNoSensitive(value, { allowLeaseToken: step === 'execute' })
  return value
}

function assertNoSensitive(value, { allowLeaseToken = false, seen = new WeakSet() } = {}) {
  if (value == null || typeof value !== 'object') return
  if (seen.has(value)) fail('Base recovery value is cyclic', { code: 'invalid-request' })
  seen.add(value)
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE.test(key) && !(allowLeaseToken && key === 'leaseToken')) {
      fail('Base recovery value contains a sensitive field', { code: 'invalid-request' })
    }
    assertNoSensitive(entry, { allowLeaseToken, seen })
  }
  seen.delete(value)
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') throw new Error('unsupported JSON value')
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  )
}

function requestDigest(request) {
  const bytes = hash(new TextEncoder().encode(JSON.stringify(canonicalize(request))))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function proofMessage({ networkId, owner, agent, challengeId, expiresAt, digest }) {
  return [PROOF_PREFIX, networkId, owner, agent, challengeId, String(expiresAt), digest].join('|')
}

function base64url(bytes) {
  const base64 = btoa(String.fromCharCode(...Uint8Array.from(bytes)))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function fetchJson({ url, init, step, fetchImpl }) {
  let response
  try {
    response = await fetchImpl(url, init)
  } catch {
    fail(`Base recovery ${step} request is unavailable`, {
      step,
      code: 'network-error',
    })
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { response, body }
}

function responseCode(response, body) {
  if (response.status === 409 && ['version-conflict', 'lease-conflict'].includes(body?.code)) {
    return body.code
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) return 'denied'
  if (response.status === 400) return 'invalid-request'
  if (response.status === 503) return 'unavailable'
  return 'server-error'
}

function requireIdentity(value, step = 'request') {
  try {
    return requireBaseRecoveryIdentity(value)
  } catch (cause) {
    fail('Base recovery identity is malformed', { step, code: 'invalid-request', cause })
  }
}

function requireBundle(body, expectedIdentity, step = 'read') {
  if (!exactObject(body, PUBLIC_BUNDLE_FIELDS)) {
    fail('Base recovery evidence response is malformed', { step, code: 'invalid-response' })
  }
  try {
    assertNoSensitive(body)
  } catch (cause) {
    fail('Base recovery evidence response is malformed', {
      step,
      code: 'invalid-response',
      cause,
    })
  }
  if (
    exactObject(body.identity, IDENTITY_FIELDS) &&
    IDENTITY_FIELDS.some((field) => body.identity[field] !== expectedIdentity[field])
  ) {
    fail('Base recovery evidence identity does not match the query', {
      step,
      code: 'identity-mismatch',
    })
  }
  let identity
  try {
    identity = requireBaseRecoveryIdentity(body.identity)
  } catch (cause) {
    fail('Base recovery evidence identity is malformed', {
      step,
      code: 'invalid-response',
      cause,
    })
  }
  if (!sameBaseRecoveryIdentity(identity, expectedIdentity)) {
    fail('Base recovery evidence identity does not match the query', {
      step,
      code: 'identity-mismatch',
    })
  }
  if (
    body.schemaVersion !== 1 ||
    typeof body.owner !== 'string' ||
    body.owner.length === 0 ||
    typeof body.agent !== 'string' ||
    body.agent.length === 0 ||
    typeof body.recoverable !== 'boolean' ||
    !Number.isSafeInteger(body.recoveryVersion) ||
    body.recoveryVersion < 0 ||
    !body.intent ||
    typeof body.intent !== 'object' ||
    Array.isArray(body.intent) ||
    !Array.isArray(body.phases) ||
    !Array.isArray(body.events)
  ) {
    fail('Base recovery evidence response is malformed', { step, code: 'invalid-response' })
  }
  // Calling the total selector here is a deliberate parse boundary. A valid-but-conflicting
  // bundle may select manual-review; the client must preserve that verdict rather than turn it
  // into a permissive transport fallback.
  selectBaseChildRecoveryAction(body)
  return body
}

/** Public, no-store read of one exact five-field Base child bundle. */
export async function readBaseRecoveryEvidence(options) {
  requireOptions(options, ['identity', 'fetchImpl', 'apiBase', 'signal'], 'read')
  const identity = requireIdentity(options.identity, 'read')
  const fetchImpl = options.fetchImpl ?? fetch
  const apiBase = options.apiBase ?? ''
  const query = new URLSearchParams({
    action: 'base-child-evidence',
    network: identity.networkId,
    binding: identity.bindingId,
    execution: identity.executionId,
    allocation: identity.allocationId,
    child: identity.childId,
  })
  const { response, body } = await fetchJson({
    url: `${apiBase}${AGENT_INDEX_PATH}?${query}`,
    init: { method: 'GET', cache: 'no-store', signal: options.signal },
    step: 'read',
    fetchImpl,
  })
  if (!response.ok) {
    fail('Base recovery evidence request failed', {
      step: 'read',
      status: response.status,
      code: responseCode(response, body),
    })
  }
  return requireBundle(body, identity)
}

/** One fresh bridge-agent proof and one Base-specific D1 lease claim. */
export async function requestBaseRecoveryClaim(options) {
  requireOptions(
    options,
    [
      'identity',
      'owner',
      'agentAddress',
      'expectedRecoveryVersion',
      'leaseOwner',
      'evidence',
      'resolveCredential',
      'fetchImpl',
      'apiBase',
      'now',
      'signal',
    ],
    'claim'
  )
  const identity = requireIdentity(options.identity, 'claim')
  const evidence = requireBundle(options.evidence, identity, 'claim')
  const owner = options.owner
  const agent = options.agentAddress
  const version = options.expectedRecoveryVersion
  const leaseOwner = options.leaseOwner
  const now = options.now ?? Date.now()
  if (
    typeof owner !== 'string' ||
    owner.length === 0 ||
    typeof agent !== 'string' ||
    agent.length === 0 ||
    evidence.owner !== owner ||
    evidence.agent !== agent ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    evidence.recoveryVersion !== version ||
    typeof leaseOwner !== 'string' ||
    leaseOwner.length < 1 ||
    leaseOwner.length > 128 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    typeof options.resolveCredential !== 'function'
  ) {
    fail('Base recovery claim request is malformed', { step: 'claim', code: 'invalid-request' })
  }
  const decision = selectBaseChildRecoveryAction(evidence)
  const credential = await options.resolveCredential({
    networkId: identity.networkId,
    owner,
    agentAddress: agent,
  })
  if (credential?.agentAddress !== agent || typeof credential.sign !== 'function') {
    fail('Base recovery bridge credential does not match the durable agent', {
      step: 'credential',
      code: 'credential-mismatch',
    })
  }
  const request = {
    executionId: identity.executionId,
    bindingId: identity.bindingId,
    allocationId: identity.allocationId,
    childId: identity.childId,
    expectedRecoveryVersion: version,
    leaseOwner,
  }
  const digest = requestDigest(request)
  const fetchImpl = options.fetchImpl ?? fetch
  const apiBase = options.apiBase ?? ''
  const challengeResult = await fetchJson({
    url: `${apiBase}${AGENT_INDEX_PATH}?action=receipt-challenge`,
    init: {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ networkId: identity.networkId, owner, agent, requestDigest: digest }),
      signal: options.signal,
    },
    step: 'challenge',
    fetchImpl,
  })
  const challengeBody = challengeResult.body
  const challenge = challengeBody?.challenge
  if (!challengeResult.response.ok || challengeBody?.ok !== true || !challenge) {
    fail('Base recovery challenge request failed', {
      step: 'challenge',
      status: challengeResult.response.status,
      code: responseCode(challengeResult.response, challengeBody),
    })
  }
  if (
    !exactObject(challengeBody, ['ok', 'challenge']) ||
    !exactObject(challenge, [
      'networkId',
      'owner',
      'agent',
      'challengeId',
      'expiresAt',
      'requestDigest',
      'createdAt',
    ]) ||
    challenge.networkId !== identity.networkId ||
    challenge.owner !== owner ||
    challenge.agent !== agent ||
    challenge.requestDigest !== digest ||
    typeof challenge.challengeId !== 'string' ||
    challenge.challengeId.length === 0 ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= now ||
    !Number.isSafeInteger(challenge.createdAt)
  ) {
    fail('Base recovery challenge response is malformed', {
      step: 'challenge',
      code: 'invalid-response',
    })
  }
  const signature = base64url(
    credential.sign(
      new TextEncoder().encode(
        proofMessage({
          networkId: identity.networkId,
          owner,
          agent,
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          digest,
        })
      )
    )
  )
  const claimResult = await fetchJson({
    url: `${apiBase}${AGENT_INDEX_PATH}?action=base-recovery-request`,
    init: {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request,
        proof: {
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          signature,
        },
      }),
      signal: options.signal,
    },
    step: 'claim',
    fetchImpl,
  })
  const body = claimResult.body
  if (!claimResult.response.ok || body?.ok !== true) {
    fail('Base recovery claim request failed', {
      step: 'claim',
      status: claimResult.response.status,
      code: responseCode(claimResult.response, body),
      version: body?.version ?? body?.evidenceVersion,
    })
  }
  const invalidClaim = () =>
    fail('Base recovery claim response is malformed', {
      step: 'claim',
      code: 'invalid-response',
      status: claimResult.response.status,
    })
  if (
    !exactObject(body, [
      'ok',
      'identity',
      'action',
      'phase',
      'reasonCode',
      'evidenceVersion',
      'lease',
    ]) ||
    !sameBaseRecoveryIdentity(body.identity, identity) ||
    body.action !== decision.action ||
    body.phase !== decision.phase ||
    body.reasonCode !== decision.reasonCode ||
    body.evidenceVersion !== version
  ) {
    invalidClaim()
  }
  if (decision.phase == null) {
    if (body.lease !== null) invalidClaim()
  } else if (
    !exactObject(body.lease, ['holder', 'leaseToken', 'expiresAt']) ||
    body.lease.holder !== leaseOwner ||
    !LOWER_HEX_256.test(body.lease.leaseToken) ||
    !Number.isSafeInteger(body.lease.expiresAt) ||
    body.lease.expiresAt <= now
  ) {
    invalidClaim()
  }
  return {
    identity,
    action: body.action,
    phase: body.phase,
    reasonCode: body.reasonCode,
    evidenceVersion: body.evidenceVersion,
    lease: body.lease,
  }
}

/** Capability-authenticated execution through one fixed same-origin proxy path. */
export async function executeBaseRecovery(options) {
  requireOptions(options, ['mandateId', 'claim', 'fetchImpl', 'signal'], 'execute')
  if (!LOWER_HEX_128.test(options.mandateId || '')) {
    fail('Base mandate identity is malformed', { step: 'execute', code: 'invalid-request' })
  }
  const claim = options.claim
  if (
    !exactObject(claim, [
      'identity',
      'action',
      'phase',
      'reasonCode',
      'evidenceVersion',
      'lease',
    ]) ||
    !ACTIONS.has(claim.action) ||
    !Number.isSafeInteger(claim.evidenceVersion) ||
    claim.evidenceVersion < 0 ||
    !claim.lease ||
    !exactObject(claim.lease, ['holder', 'leaseToken', 'expiresAt']) ||
    !LOWER_HEX_256.test(claim.lease.leaseToken)
  ) {
    fail('Base recovery claim is malformed', { step: 'execute', code: 'invalid-request' })
  }
  const identity = requireIdentity(claim.identity, 'execute')
  const request = {
    mandateId: options.mandateId,
    identity,
    action: claim.action,
    evidenceVersion: claim.evidenceVersion,
    leaseToken: claim.lease.leaseToken,
  }
  const { response, body } = await fetchJson({
    url: RELAYER_RECOVERY_PATH,
    init: {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: options.signal,
    },
    step: 'execute',
    fetchImpl: options.fetchImpl ?? fetch,
  })
  if (!response.ok || response.status !== 202) {
    fail('Base recovery execution request failed', {
      step: 'execute',
      status: response.status,
      code: responseCode(response, body),
    })
  }
  if (
    !exactObject(body, ['accepted', 'workId', 'identity', 'action', 'evidenceVersion', 'status']) ||
    body.accepted !== true ||
    !LOWER_HEX_256.test(body.workId) ||
    !sameBaseRecoveryIdentity(body.identity, identity) ||
    body.action !== claim.action ||
    body.evidenceVersion !== claim.evidenceVersion ||
    ![
      'pending',
      'running',
      'held',
      'done',
      'uncertain',
      'blocked',
      'owner_action_required',
    ].includes(body.status)
  ) {
    fail('Base recovery execution response is malformed', {
      step: 'execute',
      status: response.status,
      code: 'invalid-response',
    })
  }
  return body
}

function defaultWait(ms, signal) {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Bounded public evidence polling. No claim or executor dependency exists on this surface. */
export async function pollBaseRecoveryEvidence(options) {
  requireOptions(
    options,
    [
      'identity',
      'afterVersion',
      'signal',
      'limit',
      'intervalMs',
      'readEvidence',
      'wait',
      'fetchImpl',
      'apiBase',
    ],
    'poll'
  )
  const identity = requireIdentity(options.identity, 'poll')
  if (
    !Number.isSafeInteger(options.afterVersion) ||
    options.afterVersion < 0 ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 20 ||
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 0 ||
    options.intervalMs > 60_000
  ) {
    fail('Base recovery poll bounds are malformed', { step: 'poll', code: 'invalid-request' })
  }
  const readEvidence = options.readEvidence ?? readBaseRecoveryEvidence
  const wait = options.wait ?? defaultWait
  let last = null
  for (let attempt = 0; attempt < options.limit; attempt += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    const next = await readEvidence({
      identity,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      apiBase: options.apiBase,
    })
    requireBundle(next, identity, 'poll')
    if (next.recoveryVersion < options.afterVersion) {
      fail('Base recovery evidence version regressed', { step: 'poll', code: 'invalid-response' })
    }
    last = next
    if (next.recoveryVersion > options.afterVersion) return { status: 'advanced', bundle: next }
    if (attempt + 1 < options.limit) await wait(options.intervalMs, options.signal)
  }
  return { status: 'timeout', bundle: last }
}

const NON_ACTIONABLE = new Set([
  'no-movement',
  'manual-review',
  'owner-action-required',
  'complete',
])

function requireProjection(value, { identity, version }) {
  try {
    assertNoSensitive(value)
  } catch (cause) {
    fail('Base recovery projection is malformed', {
      step: 'project',
      code: 'invalid-response',
      cause,
    })
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !sameBaseRecoveryIdentity(value.identity, identity) ||
    value.version !== version ||
    (!ACTIONS.has(value.action) && !NON_ACTIONABLE.has(value.action)) ||
    (value.phase !== null && typeof value.phase !== 'string') ||
    (value.reasonCode !== null && typeof value.reasonCode !== 'string')
  ) {
    fail('Base recovery projection is malformed', {
      step: 'project',
      code: 'invalid-response',
    })
  }
  return value
}

function publicExecutionResult(result, pollStatus) {
  return {
    status: result.status,
    workId: result.workId,
    identity: requireIdentity(result.identity, 'execute'),
    action: result.action,
    evidenceVersion: result.evidenceVersion,
    pollStatus,
  }
}

/**
 * Browser controller for one exact Base-child identity.
 *
 * The controller deliberately keeps the D1 lease inside the claim -> execute call frame. UI
 * callbacks and returned values receive only public projections/identities. Calls for the same
 * five-field identity join the exact same promise; identity collisions remain independent.
 */
export function createBaseRecoveryActionRunner(dependencies = {}) {
  const requiredFunctions = [
    'getActiveAccount',
    'getMandateId',
    'readEvidence',
    'projectEvidence',
    'requestClaim',
    'executeRecovery',
    'pollEvidence',
    'resolveCredential',
  ]
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies) ||
    requiredFunctions.some((name) => typeof dependencies[name] !== 'function') ||
    typeof dependencies.leaseOwner !== 'string' ||
    dependencies.leaseOwner.length < 1 ||
    dependencies.leaseOwner.length > 128 ||
    !Number.isSafeInteger(dependencies.pollLimit) ||
    dependencies.pollLimit < 1 ||
    dependencies.pollLimit > 20 ||
    !Number.isSafeInteger(dependencies.pollIntervalMs) ||
    dependencies.pollIntervalMs < 0 ||
    dependencies.pollIntervalMs > 60_000 ||
    (dependencies.getSignal !== undefined && typeof dependencies.getSignal !== 'function')
  ) {
    fail('Base recovery runner configuration is malformed', {
      step: 'runner',
      code: 'invalid-request',
    })
  }

  const onProjection =
    typeof dependencies.onProjection === 'function' ? dependencies.onProjection : () => {}
  const onPending = typeof dependencies.onPending === 'function' ? dependencies.onPending : () => {}
  const onError = typeof dependencies.onError === 'function' ? dependencies.onError : () => {}
  const inFlight = new Map()

  const captureAccount = () => {
    const account = dependencies.getActiveAccount()
    if (
      !account ||
      account.version !== 1 ||
      typeof account.address !== 'string' ||
      account.address.length === 0
    ) {
      fail('Base recovery active account is unavailable', {
        step: 'account',
        code: 'active-account-unavailable',
      })
    }
    return { version: account.version, address: account.address, epoch: account.epoch }
  }

  const assertCurrent = (captured) => {
    const current = dependencies.getActiveAccount()
    if (
      !current ||
      current.version !== captured.version ||
      current.address !== captured.address ||
      current.epoch !== captured.epoch
    ) {
      fail('Base recovery account changed', {
        step: 'account',
        code: 'active-account-changed',
      })
    }
  }

  const readAndProject = async ({ identity, key, captured, signal }) => {
    const evidence = requireBundle(
      await dependencies.readEvidence({ identity, signal }),
      identity,
      'read'
    )
    assertCurrent(captured)
    if (evidence.owner !== captured.address) {
      fail('Base recovery evidence owner does not match the active account', {
        step: 'read',
        code: 'identity-mismatch',
      })
    }
    const projection = requireProjection(dependencies.projectEvidence(evidence), {
      identity,
      version: evidence.recoveryVersion,
    })
    assertCurrent(captured)
    onProjection(key, projection)
    return { evidence, projection }
  }

  const runNew = async ({ identity, key, captured, signal }) => {
    onPending(key, true)
    let projection = null
    try {
      assertCurrent(captured)
      const initial = await readAndProject({ identity, key, captured, signal })
      projection = initial.projection
      if (!ACTIONS.has(projection.action)) return { skipped: projection.action }

      const claim = await dependencies.requestClaim({
        identity,
        owner: initial.evidence.owner,
        agentAddress: initial.evidence.agent,
        expectedRecoveryVersion: initial.evidence.recoveryVersion,
        leaseOwner: dependencies.leaseOwner,
        evidence: initial.evidence,
        resolveCredential: dependencies.resolveCredential,
        signal,
      })
      assertCurrent(captured)

      const mandateId = await dependencies.getMandateId({
        identity,
        evidence: initial.evidence,
        projection,
      })
      assertCurrent(captured)
      const accepted = await dependencies.executeRecovery({
        mandateId,
        claim,
        signal,
      })
      assertCurrent(captured)
      const polled = await dependencies.pollEvidence({
        identity,
        afterVersion: initial.evidence.recoveryVersion,
        limit: dependencies.pollLimit,
        intervalMs: dependencies.pollIntervalMs,
        signal,
      })
      assertCurrent(captured)
      if (!polled || !['advanced', 'timeout'].includes(polled.status) || !polled.bundle) {
        fail('Base recovery poll response is malformed', {
          step: 'poll',
          code: 'invalid-response',
        })
      }
      const bundle = requireBundle(polled.bundle, identity, 'poll')
      if (bundle.owner !== captured.address) {
        fail('Base recovery evidence owner does not match the active account', {
          step: 'poll',
          code: 'identity-mismatch',
        })
      }
      const next = requireProjection(dependencies.projectEvidence(bundle), {
        identity,
        version: bundle.recoveryVersion,
      })
      assertCurrent(captured)
      onProjection(key, polled.status === 'timeout' ? { ...next, syncing: true } : next)
      return publicExecutionResult(accepted, polled.status)
    } catch (error) {
      if (error?.code === 'version-conflict') {
        await readAndProject({ identity, key, captured, signal })
        return { status: 'version-conflict' }
      }
      if (error?.code === 'lease-conflict' && projection) {
        assertCurrent(captured)
        onProjection(key, {
          ...projection,
          action: 'recovery-in-progress',
          phase: null,
          reasonCode: 'base-recovery-in-progress',
          syncing: true,
        })
        return { status: 'lease-conflict' }
      }
      const code =
        error?.name === 'AbortError'
          ? 'aborted'
          : error?.code === 'active-account-changed'
            ? 'active-account-changed'
            : 'base-recovery-failed'
      try {
        assertCurrent(captured)
        onError(key, { code })
      } catch {
        // A stale owner must not update the next account's recovery surface.
      }
      if (error?.name === 'AbortError' || error?.code === 'active-account-changed') throw error
      throw new BaseRecoveryClientError('Base recovery could not be completed', {
        step: 'runner',
        code,
      })
    } finally {
      try {
        assertCurrent(captured)
        onPending(key, false)
      } catch {
        // Account replacement owns clearing the old account's pending surface.
      }
    }
  }

  return {
    run(value) {
      const identity = requireIdentity(value, 'runner')
      const key = baseRecoveryIdentityKey(identity)
      const existing = inFlight.get(key)
      if (existing) return existing
      const captured = captureAccount()
      const signal = dependencies.getSignal?.() ?? dependencies.signal
      const promise = runNew({ identity, key, captured, signal })
      inFlight.set(key, promise)
      void promise.then(
        () => {
          if (inFlight.get(key) === promise) inFlight.delete(key)
        },
        () => {
          if (inFlight.get(key) === promise) inFlight.delete(key)
        }
      )
      return promise
    },
  }
}

export { baseRecoveryIdentityKey }
