import { hash } from '@stellar/stellar-sdk'
import { selectRecoveryAction } from '../../api/agent-index/recovery.js'
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

function optionalChildId(value) {
  return value == null || value === '' ? null : requireText(value, 'childId')
}

function requireAllocationMapping(mapping, identity) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    fail('An authoritative allocation mapping is required when no receipt exists', {
      step: 'credential',
      code: 'missing-allocation-mapping',
    })
  }
  for (const field of ['networkId', 'owner', 'executionId', 'allocationId']) {
    if (mapping[field] !== identity[field]) {
      fail(`Allocation mapping ${field} does not match the recovery request`, {
        step: 'credential',
        code: 'allocation-mapping-mismatch',
      })
    }
  }
  if (!Object.prototype.hasOwnProperty.call(mapping, 'childId')) {
    fail('Allocation mapping must carry its authoritative child identity', {
      step: 'credential',
      code: 'missing-allocation-mapping',
    })
  }
  return {
    agentAddress: requireText(mapping.agentAddress, 'allocationMapping.agentAddress'),
    childId: optionalChildId(mapping.childId),
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
  allocationMapping,
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
  const suppliedChild = childId === undefined ? undefined : optionalChildId(childId)
  let originalAgent
  let originalChild
  if (receipt) {
    assertReceiptIdentity(receipt, identity, 'request')
    originalAgent = requireText(receipt.agent, 'receipt.agent')
    originalChild = optionalChildId(receipt.childId)
    if (agentAddress && agentAddress !== originalAgent) {
      fail('Caller agent mapping does not match receipt evidence', {
        step: 'credential',
        code: 'agent-mismatch',
      })
    }
    if (suppliedChild !== undefined && suppliedChild !== originalChild) {
      fail('Caller child mapping does not match receipt evidence', {
        step: 'credential',
        code: 'child-mismatch',
      })
    }
    if (allocationMapping) {
      const mapping = requireAllocationMapping(allocationMapping, identity)
      if (mapping.agentAddress !== originalAgent || mapping.childId !== originalChild) {
        fail('Caller allocation mapping does not match receipt evidence', {
          step: 'credential',
          code: 'allocation-mapping-mismatch',
        })
      }
    }
  } else {
    const mapping = requireAllocationMapping(allocationMapping, identity)
    originalAgent = mapping.agentAddress
    originalChild = mapping.childId
    if (agentAddress && agentAddress !== originalAgent) {
      fail('Caller agent mapping does not match the authoritative allocation mapping', {
        step: 'credential',
        code: 'agent-mismatch',
      })
    }
    if (suppliedChild !== undefined && suppliedChild !== originalChild) {
      fail('Caller child mapping does not match the authoritative allocation mapping', {
        step: 'credential',
        code: 'child-mismatch',
      })
    }
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
    ...(originalChild == null ? {} : { childId: originalChild }),
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
  const invalidSuccess = (message) =>
    fail(message, {
      step: 'recovery',
      status: recoveryResult.response.status,
      code: 'invalid-response',
      body,
    })
  if (body.version !== expectedReceiptVersion) {
    invalidSuccess('Recovery response version does not match the requested version')
  }
  if ((body.version === 0) !== (body.receipt == null)) {
    invalidSuccess('Recovery response receipt presence does not match its row version')
  }
  if (body.receipt) {
    assertReceiptIdentity(body.receipt, identity, 'recovery')
    if (body.receipt.agent !== originalAgent || body.receipt.version !== body.version) {
      invalidSuccess('Recovery response receipt does not match its signer/version')
    }
    if (optionalChildId(body.receipt.childId) !== originalChild) {
      invalidSuccess('Recovery response receipt child does not match the requested allocation')
    }
  }
  const decision = selectRecoveryAction(body.receipt)
  for (const field of ['action', 'phase', 'reasonCode', 'reason']) {
    if (body[field] !== decision[field]) {
      invalidSuccess(`Recovery response ${field} does not match durable receipt evidence`)
    }
  }
  if (decision.phase == null) {
    if (body.lease !== null) invalidSuccess('No-action recovery verdict unexpectedly carries a lease')
  } else if (
    !body.lease ||
    body.lease.holder !== leaseOwner ||
    body.lease.phase !== decision.phase ||
    typeof body.lease.leaseToken !== 'string' ||
    body.lease.leaseToken.length === 0 ||
    !Number.isSafeInteger(body.lease.expiresAt) ||
    body.lease.expiresAt <= Date.now()
  ) {
    invalidSuccess('Actionable recovery verdict does not carry a valid matching lease')
  }
  return body
}
