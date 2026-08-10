import { createHash } from 'node:crypto';
import {
  BASE_EVIDENCE_PHASES,
  BASE_EVIDENCE_STATES,
  validateBaseEvidence,
} from './baseEvidenceValidation.mjs';

const IDENTITY_FIELDS = ['networkId', 'owner', 'bindingId', 'executionId', 'allocationId', 'childId'];
const RECOVERY_IDENTITY_FIELDS = ['networkId', 'bindingId', 'executionId', 'allocationId', 'childId'];
const CHILD_FIELDS = new Set([
  'version', 'networkId', 'owner', 'agent', 'bindingId', 'executionId', 'allocationId', 'childId',
  'intent', 'lifecycle',
]);
const INTENT_FIELDS = new Set([
  'token', 'units', 'decimals', 'poolAddress', 'proxyTarget', 'runId', 'grantTxHash',
  'kernelAddress', 'bindingHash', 'baseJobId', 'minShares',
]);
const IDENTITY_FIELD_SET = new Set(IDENTITY_FIELDS);
const LIFECYCLE_FIELDS = new Set(['sequence', 'status', 'evidence', 'observedAt']);
const LIFECYCLE_REQUEST_FIELDS = new Set(['identity', 'expectedSequence', 'lifecycle']);
const BATCH_FIELDS = new Set(['idempotencyKey', 'burnUnits7', 'children']);
const EVIDENCE_REQUEST_FIELDS = new Set(['schemaVersion', 'identity', 'expectedRecoveryVersion', 'event']);
const EVIDENCE_EVENT_FIELDS = new Set(['eventId', 'phase', 'state', 'evidence', 'observedAt']);
const BATCH_ACK_FIELDS = new Set([
  'acknowledged', 'schemaVersion', 'idempotencyKey', 'requestDigest', 'children',
  'written', 'duplicates',
]);
const BATCH_CHILD_ACK_FIELDS = new Set(['identity', 'recoveryVersion']);
const EVIDENCE_ACK_FIELDS = new Set([
  'acknowledged', 'schemaVersion', 'identity', 'eventId', 'phase', 'state',
  'recoveryVersion', 'evidenceDigest', 'reportDigest', 'written', 'duplicates',
]);
const RECOVERY_IDENTITY_FIELD_SET = new Set(RECOVERY_IDENTITY_FIELDS);
const BASE_RECOVERY_ACTIONS = new Set([
  'poll-attestation', 'submit-mint', 'poll-mint',
  'submit-base-deposit', 'poll-base-deposit',
]);
const BASE_RECOVERY_PHASES = new Set(['cctp_attestation', 'cctp_mint', 'base_deposit']);
const RECOVERY_CLAIM_FIELDS = new Set([
  'identity', 'action', 'evidenceVersion', 'leaseToken',
]);
const RECOVERY_RENEW_FIELDS = new Set([
  'identity', 'action', 'evidenceVersion', 'holder', 'leaseToken',
]);
// These are the public shapes emitted by the Agent Index reporter-only handlers.  Keep claim,
// renew, and release separate: release intentionally returns no identity facts, while claim
// includes the closed bundle and renew only returns the refreshed lease.
const RECOVERY_CLAIM_ACK_FIELDS = new Set([
  'ok', 'identity', 'action', 'phase', 'reasonCode', 'evidenceVersion', 'lease', 'bundle',
]);
const RECOVERY_RENEW_ACK_FIELDS = new Set([
  'ok', 'identity', 'action', 'phase', 'evidenceVersion', 'lease',
]);
const RECOVERY_RELEASE_ACK_FIELDS = new Set(['ok']);
const RECOVERY_TOKEN_RE = /^[0-9a-f]{64}$/;

export class AgentIndexReporterError extends Error {
  constructor(message, { status = null, code = 'REPORTER_PERMANENT', cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}
export class AgentIndexReporterRetryableError extends AgentIndexReporterError {
  constructor(message, options = {}) { super(message, { ...options, code: 'REPORTER_RETRYABLE' }); }
}
export class AgentIndexEvidenceConflictError extends AgentIndexReporterError {
  constructor(message, options = {}) { super(message, { ...options, code: 'EVIDENCE_CONFLICT' }); }
}
export class AgentIndexBatchRetryableError extends AgentIndexReporterError {
  constructor(message, options = {}) { super(message, { ...options, code: 'BATCH_RETRYABLE' }); }
}
export class AgentIndexBatchPermanentError extends AgentIndexReporterError {
  constructor(message, options = {}) { super(message, { ...options, code: 'BATCH_PERMANENT' }); }
}
export class AgentIndexBatchConflictError extends AgentIndexReporterError {
  constructor(message, options = {}) { super(message, { ...options, code: 'BATCH_CONFLICT' }); }
}
export class AgentIndexRecoveryConflictError extends AgentIndexReporterError {
  constructor(message, options = {}) { super(message, { ...options, code: 'RECOVERY_CONFLICT' }); }
}
export class AgentIndexRecoveryVersionConflictError extends AgentIndexRecoveryConflictError {
  constructor(message, options = {}) { super(message, { ...options, code: 'RECOVERY_VERSION_CONFLICT' }); }
}
export class AgentIndexRecoveryLeaseConflictError extends AgentIndexRecoveryConflictError {
  constructor(message, options = {}) { super(message, { ...options, code: 'RECOVERY_LEASE_CONFLICT' }); }
}

export const BASE_SEPOLIA_POOL_TARGETS = new Map([
  ['0x389250872044368759d3db5c09b2706a6628d4e0', 'aave-v3'],
  ['0x5e843a639f0555e2a6669601621befc887bdb479', 'morpho-blue'],
  ['0xadd3c1a75c7cef2516b51750959bd829a4ad4761', 'moonwell'],
]);

function requireText(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required`);
  return value;
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).find((field) => !fields.has(field));
  if (unexpected) throw new Error(`unexpected ${label} field: ${unexpected}`);
}

function rejectSensitive(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`circular reporter payload at ${path}`);
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.includes('secret') || normalized.includes('private')
        || normalized.includes('sessionkey') || normalized.includes('serializedapproval')
        || normalized.includes('capability') || normalized.includes('bearer')
        || normalized.includes('leasetoken') || normalized.includes('authorization')
        || normalized.includes('wallet') || normalized.includes('passkey')
        || normalized.includes('diagnostic') || normalized.includes('endpoint')
        || normalized === 'approval' || normalized === 'mandate') {
      throw new Error(`secret/private/approval property rejected at ${path}.${key}`);
    }
    rejectSensitive(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('reporter payload contains an unsupported value');
  return encoded;
}

function recoveryIdentity(value) {
  exactObject(value, RECOVERY_IDENTITY_FIELD_SET, 'recovery identity');
  const output = Object.fromEntries(RECOVERY_IDENTITY_FIELDS.map((field) => [
    field, requireText(value[field], `identity.${field}`),
  ]));
  const marker = ':exec:';
  const split = output.executionId.indexOf(marker);
  if (split <= 0 || output.executionId.slice(split + marker.length) !== output.allocationId) {
    throw new Error('executionId must match runId and allocationId');
  }
  return output;
}

function sameRecoveryIdentity(actual, expected) {
  return RECOVERY_IDENTITY_FIELDS.every((field) => actual?.[field] === expected?.[field]);
}

function validateRecoveryClaimRequest(request, { renewal = false } = {}) {
  const fields = renewal ? RECOVERY_RENEW_FIELDS : RECOVERY_CLAIM_FIELDS;
  exactObject(request, fields, renewal ? 'Base recovery renewal' : 'Base recovery claim');
  const identity = recoveryIdentity(request.identity);
  if (!BASE_RECOVERY_ACTIONS.has(request.action)) {
    throw new Error('Base recovery action is invalid');
  }
  if (!Number.isSafeInteger(request.evidenceVersion) || request.evidenceVersion < 0) {
    throw new Error('evidenceVersion must be a non-negative safe integer');
  }
  if (!RECOVERY_TOKEN_RE.test(request.leaseToken || '')) {
    throw new Error('leaseToken must be 64 lowercase hex characters');
  }
  if (renewal && (typeof request.holder !== 'string' || !request.holder)) {
    throw new Error('recovery lease holder is required');
  }
  rejectSensitiveRecovery(request);
  return { ...request, identity };
}

// `rejectSensitive` intentionally rejects leaseToken for every legacy reporter envelope. Recovery
// requests are the one authenticated server-to-server exception: the token is accepted only at
// the exact top-level field and any recursively nested secret/private material remains forbidden.
function rejectSensitiveRecovery(value, path = '$', seen = new WeakSet(), root = true) {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`circular recovery reporter payload at ${path}`);
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const allowedTopLevelToken = root && key === 'leaseToken';
    if (!allowedTopLevelToken && (
      normalized.includes('secret') || normalized.includes('private')
      || normalized.includes('sessionkey') || normalized.includes('serializedapproval')
      || normalized.includes('capability') || normalized.includes('bearer')
      || normalized.includes('leasetoken') || normalized.includes('authorization')
      || normalized.includes('wallet') || normalized.includes('passkey')
      || normalized.includes('diagnostic') || normalized.includes('endpoint')
      || normalized === 'approval' || normalized === 'mandate'
    )) {
      throw new Error(`secret/private/approval property rejected at ${path}.${key}`);
    }
    rejectSensitiveRecovery(entry, `${path}.${key}`, seen, false);
  }
  seen.delete(value);
}

function validateRecoveryLeaseAcknowledgement(
  acknowledgement,
  expectedIdentity,
  expectedAction,
  expectedVersion,
  schemaVersion,
  { bundle = false, expectedLeaseToken = null, expectedHolder = null } = {},
) {
  const fields = bundle ? RECOVERY_CLAIM_ACK_FIELDS : RECOVERY_RENEW_ACK_FIELDS;
  exactObject(
    acknowledgement,
    fields,
    'Base recovery acknowledgement',
  );
  if (acknowledgement.ok !== true
      || !sameRecoveryIdentity(acknowledgement.identity, expectedIdentity)
      || acknowledgement.action !== expectedAction
      || acknowledgement.evidenceVersion !== expectedVersion) {
    throw new Error('Base recovery acknowledgement identity/version mismatch');
  }
  try {
    exactObject(acknowledgement.identity, RECOVERY_IDENTITY_FIELD_SET, 'recovery acknowledgement identity');
  } catch (error) {
    throw new Error('Base recovery acknowledgement identity mismatch', { cause: error });
  }
  const phase = acknowledgement.phase;
  if (!BASE_RECOVERY_PHASES.has(phase)) throw new Error('Base recovery acknowledgement phase is invalid');
  const leaseFields = bundle
    ? new Set([
      'identity', 'owner', 'action', 'phase', 'evidenceVersion', 'holder',
      'leaseToken', 'acquiredAt', 'expiresAt',
    ])
    : new Set(['holder', 'leaseToken', 'expiresAt']);
  exactObject(acknowledgement.lease, leaseFields, 'recovery lease');
  if (bundle) {
    if (!sameRecoveryIdentity(acknowledgement.lease.identity, expectedIdentity)
        || acknowledgement.lease.owner == null
        || acknowledgement.lease.action !== expectedAction
        || acknowledgement.lease.phase !== phase
        || acknowledgement.lease.evidenceVersion !== expectedVersion) {
      throw new Error('Base recovery acknowledgement lease identity mismatch');
    }
    exactObject(acknowledgement.lease.identity, RECOVERY_IDENTITY_FIELD_SET, 'recovery lease identity');
    if (typeof acknowledgement.lease.owner !== 'string' || !acknowledgement.lease.owner) {
      throw new Error('Base recovery acknowledgement lease owner is invalid');
    }
  }
  if (typeof acknowledgement.lease.holder !== 'string' || !acknowledgement.lease.holder
      || !RECOVERY_TOKEN_RE.test(acknowledgement.lease.leaseToken || '')
      || (expectedLeaseToken !== null
        && acknowledgement.lease.leaseToken !== expectedLeaseToken)
      || (expectedHolder !== null
        && acknowledgement.lease.holder !== expectedHolder)
      || (bundle && (!Number.isSafeInteger(acknowledgement.lease.acquiredAt)
        || acknowledgement.lease.acquiredAt < 0))
      || !Number.isSafeInteger(acknowledgement.lease.expiresAt)
      || acknowledgement.lease.expiresAt < 0) {
    throw new Error('Base recovery acknowledgement lease token or timing is invalid');
  }
  if (bundle && (typeof acknowledgement.reasonCode !== 'string' || !acknowledgement.reasonCode)) {
    throw new Error('Base recovery acknowledgement reason is invalid');
  }
  if (bundle) {
    if (!acknowledgement.bundle || typeof acknowledgement.bundle !== 'object'
        || Array.isArray(acknowledgement.bundle)) {
      throw new Error('Base recovery acknowledgement bundle is invalid');
    }
    rejectSensitiveRecovery(acknowledgement.bundle);
  }
  return acknowledgement;
}

function validateRecoveryReleaseAcknowledgement(
  acknowledgement, expectedIdentity, expectedAction, expectedVersion, schemaVersion,
) {
  exactObject(acknowledgement, RECOVERY_RELEASE_ACK_FIELDS, 'Base recovery release acknowledgement');
  if (acknowledgement.ok !== true) {
    throw new Error('Base recovery release acknowledgement is invalid');
  }
  return acknowledgement;
}

function validateEvidenceReport(request, schemaVersion) {
  exactObject(request, EVIDENCE_REQUEST_FIELDS, 'evidence request');
  if (request.schemaVersion !== schemaVersion) throw new Error('evidence schema mismatch');
  recoveryIdentity(request.identity);
  exactObject(request.event, EVIDENCE_EVENT_FIELDS, 'evidence event');
  if (!Number.isSafeInteger(request.expectedRecoveryVersion) || request.expectedRecoveryVersion < 0) {
    throw new Error('expectedRecoveryVersion must be a non-negative safe integer');
  }
  if (typeof request.event.eventId !== 'string' || !/^[0-9a-f]{64}$/.test(request.event.eventId)) {
    throw new Error('eventId must be 64 lowercase hex');
  }
  if (!BASE_EVIDENCE_PHASES.has(request.event.phase)
      || !BASE_EVIDENCE_STATES.has(request.event.state)) {
    throw new Error('evidence phase/state is invalid');
  }
  if (!Number.isSafeInteger(request.event.observedAt) || request.event.observedAt < 0) {
    throw new Error('observedAt must be a non-negative safe integer');
  }
  validateBaseEvidence(request.event.phase, request.event.state, request.event.evidence);
  rejectSensitive(request);
}

function validateChild(child) {
  exactObject(child, CHILD_FIELDS, 'Base child');
  exactObject(child.intent, INTENT_FIELDS, 'Base child intent');
  exactObject(child.lifecycle, LIFECYCLE_FIELDS, 'Base child lifecycle');
  rejectSensitive(child);
  if (child.version !== 1 || child.lifecycle.sequence !== 0 || child.lifecycle.status !== 'planned') {
    throw new Error('Base child intent protocol is invalid');
  }
  for (const field of ['agent']) requireText(child[field], field);
  for (const field of INTENT_FIELDS) {
    if (field === 'decimals') {
      if (!Number.isSafeInteger(child.intent[field]) || child.intent[field] < 0) {
        throw new Error('intent.decimals must be a non-negative safe integer');
      }
    } else {
      requireText(child.intent[field], `intent.${field}`);
    }
  }
  if (!Number.isSafeInteger(child.lifecycle.observedAt)) {
    throw new Error('Base child lifecycle observedAt is invalid');
  }
  if (child.executionId !== `${child.intent.runId}:exec:${child.allocationId}`) {
    throw new Error('executionId must match runId and allocationId');
  }
  if (!/^(0|[1-9]\d*)$/.test(child.intent.units)
      || !/^(0|[1-9]\d*)$/.test(child.intent.minShares)) {
    throw new Error('Base child amounts must be unsigned decimal strings');
  }
}

function childIdentity(child) {
  return {
    networkId: requireText(child?.networkId, 'networkId'),
    owner: requireText(child?.owner, 'owner'),
    bindingId: requireText(child?.bindingId, 'bindingId'),
    executionId: requireText(child?.executionId, 'executionId'),
    allocationId: requireText(child?.allocationId, 'allocationId'),
    childId: requireText(child?.childId, 'childId'),
  };
}

function sameIdentity(actual, expected) {
  return IDENTITY_FIELDS.every((field) => actual?.[field] === expected?.[field]);
}

function actionUrl(endpoint, action) {
  const url = new URL(endpoint);
  url.searchParams.set('action', action);
  return url.toString();
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('agent index reporter timed out'));
    }, timeoutMs);
  });
  timer.unref?.();
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeout]);
  } catch (error) {
    if (timedOut) throw new Error('agent index reporter timed out');
    throw new Error('agent index reporter is unavailable', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export function createAgentIndexReporter({
  endpoint,
  secret,
  schemaVersion = 1,
  timeoutMs = 5_000,
  fetchImpl = fetch,
} = {}) {
  if (schemaVersion !== 1) throw new Error('agent index reporter schema must equal 1');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('agent index reporter timeout must be a positive safe integer');
  }

  async function post(action, body, expectedStatus, expectedIdentity, expectedSequence) {
    if (!endpoint || !secret) throw new Error('agent index reporter is not configured');
    const response = await fetchWithTimeout(fetchImpl, actionUrl(endpoint, action), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, timeoutMs);
    if (response?.status !== expectedStatus || !response?.ok) {
      throw new Error(`agent index reporter returned HTTP ${response?.status ?? 'unknown'}`);
    }
    let acknowledgement;
    try {
      acknowledgement = await response.json();
    } catch (error) {
      throw new Error('agent index reporter acknowledgement is malformed', { cause: error });
    }
    if (acknowledgement?.acknowledged !== true) {
      throw new Error('agent index reporter acknowledgement is malformed');
    }
    if (acknowledgement.schemaVersion !== schemaVersion) {
      throw new Error('agent index reporter schema mismatch');
    }
    if (!sameIdentity(acknowledgement.identity, expectedIdentity)) {
      throw new Error('agent index reporter identity mismatch');
    }
    try {
      exactObject(acknowledgement.identity, IDENTITY_FIELD_SET, 'acknowledgement identity');
    } catch (error) {
      throw new Error('agent index reporter identity mismatch', { cause: error });
    }
    if (expectedSequence !== undefined && acknowledgement.sequence !== expectedSequence) {
      throw new Error('agent index reporter lifecycle sequence mismatch');
    }
    return acknowledgement;
  }

  async function commitIntent(child) {
    validateChild(child);
    const identity = childIdentity(child);
    return post('base-child-intent', { child }, 201, identity);
  }

  async function commitIntentBatch(batch) {
    exactObject(batch, BATCH_FIELDS, 'Base child intent batch');
    rejectSensitive(batch);
    requireText(batch.idempotencyKey, 'idempotencyKey');
    if (typeof batch.burnUnits7 !== 'string' || !/^[1-9]\d*$/.test(batch.burnUnits7)) {
      throw new Error('burnUnits7 must be a positive unsigned decimal string');
    }
    if (!Array.isArray(batch.children) || batch.children.length === 0) {
      throw new Error('Base child intent batch requires ordered children');
    }
    batch.children.forEach(validateChild);
    const identities = batch.children.map((entry) => recoveryIdentity({
      networkId: entry.networkId,
      bindingId: entry.bindingId,
      executionId: entry.executionId,
      allocationId: entry.allocationId,
      childId: entry.childId,
    }));
    const requestDigest = createHash('sha256').update(canonicalJson(batch)).digest('hex');
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, actionUrl(endpoint, 'base-child-intent-batch'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: canonicalJson(batch),
      }, timeoutMs);
    } catch (cause) {
      throw new AgentIndexBatchRetryableError('agent index batch delivery is unavailable', { cause });
    }
    if (response?.status !== 201 || !response?.ok) {
      const status = response?.status ?? null;
      const ErrorType = status === 409
        ? AgentIndexBatchConflictError
        : (status === 429 || status >= 500 || status == null)
          ? AgentIndexBatchRetryableError : AgentIndexBatchPermanentError;
      throw new ErrorType(`agent index reporter returned HTTP ${status ?? 'unknown'}`, { status });
    }
    let acknowledgement;
    try { acknowledgement = await response.json(); } catch (error) {
      throw new AgentIndexBatchPermanentError(
        'agent index reporter acknowledgement is malformed', { cause: error },
      );
    }
    let exactAcknowledgement = true;
    try {
      exactObject(acknowledgement, BATCH_ACK_FIELDS, 'batch acknowledgement');
    } catch { exactAcknowledgement = false; }
    if (!exactAcknowledgement
      || acknowledgement?.acknowledged !== true
      || acknowledgement.schemaVersion !== schemaVersion
      || acknowledgement.idempotencyKey !== batch.idempotencyKey
      || acknowledgement.requestDigest !== requestDigest
      || !Array.isArray(acknowledgement.children)
      || acknowledgement.children.length !== identities.length
      || !Number.isSafeInteger(acknowledgement.written)
      || !Number.isSafeInteger(acknowledgement.duplicates)
      || acknowledgement.written < 0
      || acknowledgement.duplicates < 0
      || acknowledgement.written + acknowledgement.duplicates !== identities.length
      || acknowledgement.children.some((entry, index) => {
        try {
          exactObject(entry, BATCH_CHILD_ACK_FIELDS, 'batch child acknowledgement');
          exactObject(entry.identity, RECOVERY_IDENTITY_FIELD_SET, 'batch acknowledgement identity');
          return !sameRecoveryIdentity(entry.identity, identities[index])
            || !Number.isSafeInteger(entry.recoveryVersion)
            || entry.recoveryVersion < 0;
        } catch { return true; }
      })) {
      throw new AgentIndexBatchPermanentError('agent index reporter batch acknowledgement is malformed');
    }
    return acknowledgement;
  }

  async function reportBaseEvidence(request) {
    validateEvidenceReport(request, schemaVersion);
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, actionUrl(endpoint, 'base-child-evidence'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: canonicalJson(request),
      }, timeoutMs);
    } catch (error) {
      throw new AgentIndexReporterRetryableError('agent index evidence delivery is unavailable', {
        cause: error,
      });
    }
    if (response?.status === 409) {
      throw new AgentIndexEvidenceConflictError('agent index evidence conflicts with immutable D1 state', {
        status: 409,
      });
    }
    if ([408, 425, 429].includes(response?.status) || (response?.status ?? 0) >= 500) {
      throw new AgentIndexReporterRetryableError('agent index evidence delivery is temporarily unavailable', {
        status: response?.status ?? null,
      });
    }
    if (response?.status !== 201 || !response?.ok) {
      throw new AgentIndexReporterError('agent index evidence delivery was rejected', {
        status: response?.status ?? null,
      });
    }
    let acknowledgement;
    try { acknowledgement = await response.json(); } catch (error) {
      throw new AgentIndexReporterError('agent index evidence acknowledgement is malformed', {
        cause: error,
      });
    }
    const expectedVersion = request.expectedRecoveryVersion + 1;
    const evidenceDigest = createHash('sha256')
      .update(canonicalJson(request.event.evidence)).digest('hex');
    const reportDigest = createHash('sha256').update(canonicalJson(request)).digest('hex');
    let exactAcknowledgement = true;
    try {
      exactObject(acknowledgement, EVIDENCE_ACK_FIELDS, 'evidence acknowledgement');
    } catch { exactAcknowledgement = false; }
    if (!exactAcknowledgement
      || acknowledgement?.acknowledged !== true
      || acknowledgement.schemaVersion !== schemaVersion
      || !sameRecoveryIdentity(acknowledgement.identity, request.identity)
      || acknowledgement.eventId !== request.event.eventId
      || acknowledgement.phase !== request.event.phase
      || acknowledgement.state !== request.event.state
      || acknowledgement.recoveryVersion !== expectedVersion
      || acknowledgement.evidenceDigest !== evidenceDigest
      || acknowledgement.reportDigest !== reportDigest
      || !Number.isSafeInteger(acknowledgement.written)
      || !Number.isSafeInteger(acknowledgement.duplicates)) {
      throw new AgentIndexReporterError('agent index evidence acknowledgement is malformed');
    }
    try {
      exactObject(acknowledgement.identity, RECOVERY_IDENTITY_FIELD_SET, 'evidence acknowledgement identity');
    } catch (error) {
      throw new AgentIndexReporterError('agent index evidence acknowledgement identity mismatch', {
        cause: error,
      });
    }
    return acknowledgement;
  }

  async function reportLifecycle(request) {
    exactObject(request, LIFECYCLE_REQUEST_FIELDS, 'lifecycle request');
    exactObject(request?.identity, IDENTITY_FIELD_SET, 'lifecycle identity');
    exactObject(request?.lifecycle, LIFECYCLE_FIELDS, 'lifecycle');
    rejectSensitive(request);
    const identity = childIdentity(request?.identity);
    if (!Number.isSafeInteger(request?.expectedSequence) || request.expectedSequence < 0
        || !Number.isSafeInteger(request?.lifecycle?.sequence) || request.lifecycle.sequence < 1
        || request.lifecycle.sequence !== request.expectedSequence + 1) {
      throw new Error('agent index lifecycle sequence is invalid');
    }
    return post(
      'base-child-lifecycle',
      request,
      200,
      identity,
      request.lifecycle.sequence,
    );
  }

  function recoveryConflictError(status, payload) {
    const rawCode = String(payload?.code || payload?.reasonCode || payload?.errorCode || '').toLowerCase();
    if (rawCode.includes('version') || rawCode.includes('stale')) {
      return new AgentIndexRecoveryVersionConflictError(
        'Agent Index Base recovery evidence version is stale', { status: 409 },
      );
    }
    if (rawCode.includes('lease') || rawCode.includes('holder') || rawCode.includes('token')) {
      return new AgentIndexRecoveryLeaseConflictError(
        'Agent Index Base recovery lease is held or stale', { status: 409 },
      );
    }
    return new AgentIndexRecoveryConflictError(
      'Agent Index Base recovery claim conflicts with durable evidence', { status },
    );
  }

  async function postRecovery(action, request, expectedStatus, { includeBundle = false } = {}) {
    if (!endpoint || !secret) throw new Error('agent index reporter is not configured');
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, actionUrl(endpoint, action), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      }, timeoutMs);
    } catch (cause) {
      throw new AgentIndexReporterRetryableError(
        'agent index Base recovery delivery is unavailable', { cause },
      );
    }
    let payload = null;
    if (response?.status !== expectedStatus || !response?.ok) {
      try { payload = await response.json(); } catch {}
      if (response?.status === 409) throw recoveryConflictError(409, payload);
      const status = response?.status ?? null;
      if ([408, 425, 429].includes(status) || (status ?? 0) >= 500 || status == null) {
        throw new AgentIndexReporterRetryableError(
          'agent index Base recovery delivery is temporarily unavailable', { status },
        );
      }
      throw new AgentIndexReporterError(
        `agent index Base recovery delivery was rejected with HTTP ${status ?? 'unknown'}`,
        { status },
      );
    }
    try {
      payload = await response.json();
    } catch (cause) {
      throw new AgentIndexReporterError(
        'agent index Base recovery acknowledgement is malformed', { cause },
      );
    }
    const expectedIdentity = request.identity;
    if (action === 'base-recovery-release') {
      return validateRecoveryReleaseAcknowledgement(
        payload,
        expectedIdentity,
        request.action,
        request.evidenceVersion,
        schemaVersion,
      );
    }
    return validateRecoveryLeaseAcknowledgement(
      payload,
      expectedIdentity,
      request.action,
      request.evidenceVersion,
      schemaVersion,
      {
        bundle: includeBundle,
        expectedLeaseToken: request.leaseToken,
        expectedHolder: action === 'base-recovery-renew' ? request.holder : null,
      },
    );
  }

  async function readBaseRecoveryClaim(request) {
    const validated = validateRecoveryClaimRequest(request);
    return postRecovery('base-recovery-claim', validated, 200, { includeBundle: true });
  }

  async function renewBaseRecoveryClaim(request) {
    const validated = validateRecoveryClaimRequest(request, { renewal: true });
    return postRecovery('base-recovery-renew', validated, 200);
  }

  async function releaseBaseRecoveryClaim(request) {
    const validated = validateRecoveryClaimRequest(request);
    return postRecovery('base-recovery-release', validated, 200);
  }

  // Explicit aliases make the lease lifecycle obvious to callers while retaining the claim names
  // used by the Task 14 protocol. All aliases share the same strict one-fetch implementation.
  const readBaseRecoveryLease = readBaseRecoveryClaim;
  const renewBaseRecoveryLease = renewBaseRecoveryClaim;
  const releaseBaseRecoveryLease = releaseBaseRecoveryClaim;

  async function probe({ baseCrossChainAvailable = true } = {}) {
    if (!endpoint || !secret) throw new Error('agent index reporter is not configured');
    const response = await fetchWithTimeout(fetchImpl, actionUrl(endpoint, 'base-child-ready'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }, timeoutMs);
    if (response?.status !== 200 || !response?.ok) {
      throw new Error(`agent index reporter returned HTTP ${response?.status ?? 'unknown'}`);
    }
    let acknowledgement;
    try {
      acknowledgement = await response.json();
    } catch (error) {
      throw new Error('agent index reporter readiness acknowledgement is malformed', { cause: error });
    }
    if (acknowledgement?.ready !== true) {
      throw new Error('agent index reporter store is not ready');
    }
    if (acknowledgement.schemaVersion !== schemaVersion) {
      throw new Error('agent index reporter schema mismatch');
    }
    const requireBaseStores = baseCrossChainAvailable === true;
    if (acknowledgement?.stores?.executionReceipts !== true
      || (requireBaseStores && (
        acknowledgement?.stores?.baseChildIntents !== true
        || acknowledgement?.stores?.baseRecoveryEvidence !== true
      ))) {
      throw new Error('agent index reporter canonical stores are not ready');
    }
    return acknowledgement;
  }

  return Object.freeze({
    commitIntent, commitIntentBatch, reportLifecycle, reportBaseEvidence, probe,
    readBaseRecoveryClaim, renewBaseRecoveryClaim, releaseBaseRecoveryClaim,
    readBaseRecoveryLease, renewBaseRecoveryLease, releaseBaseRecoveryLease,
  });
}
