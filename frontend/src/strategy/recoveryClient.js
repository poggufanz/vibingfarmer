import { hash } from '@stellar/stellar-sdk'
import { loadCachedAgents } from '../stellar/agentCache.js'
import { newSessionKey } from '../stellar/sessionKey.js'

const AGENT_INDEX_PATH = '/api/agent-index'
const PROOF_PREFIX = 'vf-agent-index/receipt-proof/v1'

export class RecoveryClientError extends Error {
  constructor(message, { step, status = null, code, body = null, version, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'RecoveryClientError'
    this.step = step
    this.status = status
    this.code = code
    this.body = body
    if (version !== undefined) this.version = version
  }
}

function fail(message, options) {
  throw new RecoveryClientError(message, options)
}

function requireText(value, field, step = 'request') {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} is required`, { step, code: 'invalid-request' })
  }
  return value
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite numbers are not serializable')
    return value
  }
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
  return [
    PROOF_PREFIX,
    networkId,
    owner,
    agent,
    challengeId,
    String(expiresAt),
    digest,
  ].join('|')
}

function base64url(bytes) {
  const base64 = btoa(String.fromCharCode(...Uint8Array.from(bytes)))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function fetchJson({ url, init, step, fetchImpl }) {
  let response
  try {
    response = await fetchImpl(url, init)
  } catch (cause) {
    fail(`Recovery ${step} request could not reach the server`, {
      step,
      code: 'network-error',
      cause,
    })
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    // A non-JSON response is never interpreted as a successful protocol response.
  }
  return { response, body }
}

function failureCode(step, status, body) {
  if (status === 400) return 'invalid-request'
  if (status === 401) return 'proof-rejected'
  if (status === 403) return 'authority-mismatch'
  if (status === 404 && step === 'read') return 'not-found'
  if (status === 409) {
    return ['version-conflict', 'lease-conflict'].includes(body?.code) ? body.code : 'conflict'
  }
  if (status === 503) return 'unavailable'
  return 'server-error'
}

function responseFailure(step, response, body) {
  fail(body?.error || `Recovery ${step} request failed (HTTP ${response.status})`, {
    step,
    status: response.status,
    code: failureCode(step, response.status, body),
    body,
    version: body?.version,
  })
}

function assertReceiptIdentity(receipt, identity, step = 'read') {
  for (const field of ['networkId', 'owner', 'executionId', 'allocationId']) {
    if (receipt?.[field] !== identity[field]) {
      fail(`Receipt ${field} does not match the requested identity`, {
        step,
        status: step === 'read' ? 200 : null,
        code: 'identity-mismatch',
        body: receipt,
      })
    }
  }
}

/** Public, unauthenticated read of one exact execution receipt. */
export async function readRecoveryReceipt({
  networkId,
  owner,
  executionId,
  allocationId,
  fetchImpl = fetch,
  apiBase = '',
}) {
  const identity = {
    networkId: requireText(networkId, 'networkId', 'read'),
    owner: requireText(owner, 'owner', 'read'),
    executionId: requireText(executionId, 'executionId', 'read'),
    allocationId: requireText(allocationId, 'allocationId', 'read'),
  }
  const query = new URLSearchParams({
    action: 'receipt',
    network: identity.networkId,
    owner: identity.owner,
    execution: identity.executionId,
    allocation: identity.allocationId,
  })
  const { response, body } = await fetchJson({
    url: `${apiBase}${AGENT_INDEX_PATH}?${query}`,
    init: { method: 'GET' },
    step: 'read',
    fetchImpl,
  })
  if (response.status === 404) return { receipt: null, version: 0 }
  if (!response.ok || !body?.receipt) responseFailure('read', response, body)
  assertReceiptIdentity(body.receipt, identity)
  if (!Number.isSafeInteger(body.receipt.version) || body.receipt.version < 0) {
    fail('Receipt response carries an invalid row version', {
      step: 'read',
      status: response.status,
      code: 'invalid-response',
      body,
    })
  }
  return { receipt: body.receipt, version: body.receipt.version }
}

/** Restore the signer for one exact cached agent. Never calls newSessionKey without a secret. */
export function resolveRecoveryCredential({
  networkId,
  owner,
  vault,
  agentAddress,
  storage,
  loadCache = loadCachedAgents,
  restoreSessionKey = newSessionKey,
}) {
  requireText(vault, 'vault', 'credential')
  requireText(agentAddress, 'agentAddress', 'credential')
  const entry = loadCache({ owner, vault, network: networkId, storage }).find(
    (candidate) => candidate?.agentAddress === agentAddress
  )
  if (!entry || typeof entry.secret !== 'string' || entry.secret.length === 0) {
    fail(`No cached signing credential exists for original agent ${agentAddress}`, {
      step: 'credential',
      code: 'credential-not-found',
    })
  }
  const sessionKey = restoreSessionKey(entry.secret)
  if (entry.signerPub && sessionKey.publicKey !== entry.signerPub) {
    fail(`Cached signing credential does not match original agent ${agentAddress}`, {
      step: 'credential',
      code: 'credential-mismatch',
    })
  }
  return { ...sessionKey, agentAddress }
}

/** One authenticated recovery claim. Calling again performs a wholly fresh challenge exchange. */
export async function requestRecoveryAction({
  networkId,
  owner,
  executionId,
  allocationId,
  childId,
  expectedReceiptVersion,
  leaseOwner,
  receipt = null,
  agentAddress,
  vault,
  storage,
  resolveCredential = resolveRecoveryCredential,
  fetchImpl = fetch,
  apiBase = '',
}) {
  const identity = {
    networkId: requireText(networkId, 'networkId'),
    owner: requireText(owner, 'owner'),
    executionId: requireText(executionId, 'executionId'),
    allocationId: requireText(allocationId, 'allocationId'),
  }
  if (!Number.isSafeInteger(expectedReceiptVersion) || expectedReceiptVersion < 0) {
    fail('expectedReceiptVersion must be a non-negative safe integer', {
      step: 'request',
      code: 'invalid-request',
    })
  }
  requireText(leaseOwner, 'leaseOwner')
  if (receipt) assertReceiptIdentity(receipt, identity, 'request')
  if (receipt?.agent && agentAddress && receipt.agent !== agentAddress) {
    fail('Caller agent mapping does not match receipt evidence', {
      step: 'credential',
      code: 'agent-mismatch',
    })
  }
  const originalAgent = receipt?.agent || agentAddress
  if (!originalAgent) {
    fail('An original allocation-to-agent mapping is required when no receipt exists', {
      step: 'credential',
      code: 'missing-agent-mapping',
    })
  }
  const credential = await resolveCredential({
    ...identity,
    vault,
    storage,
    agentAddress: originalAgent,
  })
  if (credential?.agentAddress !== originalAgent || typeof credential?.sign !== 'function') {
    fail('Resolved credential does not match the original agent', {
      step: 'credential',
      code: 'credential-mismatch',
    })
  }

  const request = {
    executionId: identity.executionId,
    allocationId: identity.allocationId,
    ...(childId == null || childId === '' ? {} : { childId: requireText(childId, 'childId') }),
    expectedReceiptVersion,
    leaseOwner,
  }
  const digest = requestDigest(request)
  const challengeResult = await fetchJson({
    url: `${apiBase}${AGENT_INDEX_PATH}?action=receipt-challenge`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        networkId: identity.networkId,
        owner: identity.owner,
        agent: originalAgent,
        requestDigest: digest,
      }),
    },
    step: 'challenge',
    fetchImpl,
  })
  const challenge = challengeResult.body?.challenge
  if (!challengeResult.response.ok || challengeResult.body?.ok !== true || !challenge) {
    responseFailure('challenge', challengeResult.response, challengeResult.body)
  }
  if (
    challenge.networkId !== identity.networkId ||
    challenge.owner !== identity.owner ||
    challenge.agent !== originalAgent ||
    challenge.requestDigest !== digest ||
    typeof challenge.challengeId !== 'string' ||
    !Number.isSafeInteger(challenge.expiresAt)
  ) {
    fail('Recovery challenge does not match the exact request identity', {
      step: 'challenge',
      status: challengeResult.response.status,
      code: 'invalid-response',
      body: challengeResult.body,
    })
  }
  const signature = base64url(
    credential.sign(
      new TextEncoder().encode(
        proofMessage({
          networkId: identity.networkId,
          owner: identity.owner,
          agent: originalAgent,
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          digest,
        })
      )
    )
  )
  const recoveryResult = await fetchJson({
    url: `${apiBase}${AGENT_INDEX_PATH}?action=recovery-request`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request,
        proof: {
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
          signature,
        },
      }),
    },
    step: 'recovery',
    fetchImpl,
  })
  const body = recoveryResult.body
  if (!recoveryResult.response.ok || body?.ok !== true) {
    responseFailure('recovery', recoveryResult.response, body)
  }
  if (!Number.isSafeInteger(body.version) || body.version < 0) {
    fail('Recovery response carries an invalid row version', {
      step: 'recovery',
      status: recoveryResult.response.status,
      code: 'invalid-response',
      body,
    })
  }
  if (body.receipt) {
    assertReceiptIdentity(body.receipt, identity, 'recovery')
    if (body.receipt.agent !== originalAgent || body.receipt.version !== body.version) {
      fail('Recovery response receipt does not match its signer/version', {
        step: 'recovery',
        status: recoveryResult.response.status,
        code: 'invalid-response',
        body,
      })
    }
  }
  if (body.phase == null && body.lease !== null) {
    fail('No-action recovery verdict unexpectedly carries a lease', {
      step: 'recovery',
      status: recoveryResult.response.status,
      code: 'invalid-response',
      body,
    })
  }
  return body
}
