import { createHash } from 'node:crypto';

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
const EVIDENCE_PHASES = new Set(['cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit']);
const EVIDENCE_STATES = new Set(['submitting', 'submitted', 'confirmed', 'failed', 'unknown', 'blocked']);
const EVIDENCE_FIELDS = new Set([
  'burnTxHash', 'expectationDigest', 'burnUnits7', 'amount', 'token', 'units', 'decimals',
  'destinationDomain', 'messageHash', 'mintRecipient', 'messageDigest', 'attestationDigest',
  'evidenceVersion', 'nonce', 'attestationHash', 'mintTxHash', 'transactionHash', 'blockNumber',
  'blockHash', 'chainId', 'reasonCode', 'yieldRouterAddress', 'kernelAddress', 'caller',
  'poolAddress', 'assets', 'minShares', 'shares', 'userOpHash', 'entryPoint', 'sender', 'event',
]);
const DEPOSIT_EVENT_FIELDS = new Set([
  'address', 'topic0', 'logIndex', 'caller', 'poolAddress', 'assets', 'shares',
]);
const UNSIGNED_FIELDS = new Set([
  'burnUnits7', 'amount', 'units', 'decimals', 'destinationDomain', 'evidenceVersion', 'nonce',
  'blockNumber', 'chainId', 'assets', 'minShares', 'shares', 'logIndex',
]);
const BASE_COMMON_FIELDS = [
  'chainId', 'yieldRouterAddress', 'caller', 'poolAddress', 'assets', 'minShares',
];
const EVIDENCE_SCHEMAS = new Map([
  ['cctp_burn:confirmed', new Set(['burnTxHash', 'expectationDigest', 'burnUnits7'])],
  ['cctp_burn:unknown', new Set([
    'burnTxHash', 'expectationDigest', 'burnUnits7', 'reasonCode',
  ])],
  ['cctp_attestation:confirmed', new Set([
    'burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest', 'evidenceVersion',
  ])],
  ['cctp_mint:confirmed', new Set([
    'burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest',
    'evidenceVersion', 'mintTxHash',
  ])],
  ['cctp_mint:submitted', new Set([
    'burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest',
    'evidenceVersion', 'mintTxHash',
  ])],
  ['base_deposit:submitting', new Set(BASE_COMMON_FIELDS)],
  ['base_deposit:submitted', new Set([...BASE_COMMON_FIELDS, 'userOpHash'])],
  ['base_deposit:confirmed', new Set([
    ...BASE_COMMON_FIELDS, 'userOpHash', 'transactionHash', 'event',
  ])],
  ...['failed', 'unknown', 'blocked'].map((state) => [
    `base_deposit:${state}`,
    new Set([...BASE_COMMON_FIELDS, 'userOpHash', 'transactionHash', 'reasonCode']),
  ]),
]);
const LOWER_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const LOWER_EVM_HASH_RE = /^0x[0-9a-f]{64}$/;
const LOWER_DIGEST_RE = /^[0-9a-f]{64}$/;

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

function validateEvidenceObject(value, allowed = EVIDENCE_FIELDS, label = 'evidence', requireAll = false) {
  exactObject(value, allowed, label);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'event') {
      validateEvidenceObject(entry, DEPOSIT_EVENT_FIELDS, 'deposit event', true);
    } else if (UNSIGNED_FIELDS.has(key)) {
      if (typeof entry !== 'string' || !/^(0|[1-9]\d*)$/.test(entry)) {
        throw new Error(`${label}.${key} must be an unsigned decimal string`);
      }
    } else if (entry !== null && !['string', 'boolean'].includes(typeof entry)) {
      throw new Error(`${label}.${key} must be a bounded scalar`);
    }
  }
  if (requireAll) {
    const missing = [...allowed].find((field) => !Object.prototype.hasOwnProperty.call(value, field));
    if (missing) throw new Error(`${label}.${missing} is required`);
  }
}

function validatePhaseStateEvidence(phase, state, evidence) {
  const required = EVIDENCE_SCHEMAS.get(`${phase}:${state}`);
  if (!required) throw new Error('evidence phase/state schema is invalid');
  validateEvidenceObject(evidence, required, 'evidence', true);
  for (const field of ['yieldRouterAddress', 'caller', 'poolAddress']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field) && !LOWER_ADDRESS_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical address`);
    }
  }
  for (const field of ['userOpHash', 'transactionHash', 'mintTxHash']) {
    if (evidence[field] !== null && Object.prototype.hasOwnProperty.call(evidence, field)
        && !LOWER_EVM_HASH_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical hash`);
    }
  }
  for (const field of ['burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field) && !LOWER_DIGEST_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical digest`);
    }
  }
  if (evidence.event) {
    for (const field of ['address', 'caller', 'poolAddress']) {
      if (!LOWER_ADDRESS_RE.test(evidence.event[field])) {
        throw new Error(`deposit event.${field} must be a canonical address`);
      }
    }
    if (!LOWER_EVM_HASH_RE.test(evidence.event.topic0)) {
      throw new Error('deposit event.topic0 must be a canonical hash');
    }
  }
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
  if (!EVIDENCE_PHASES.has(request.event.phase) || !EVIDENCE_STATES.has(request.event.state)) {
    throw new Error('evidence phase/state is invalid');
  }
  if (!Number.isSafeInteger(request.event.observedAt) || request.event.observedAt < 0) {
    throw new Error('observedAt must be a non-negative safe integer');
  }
  validatePhaseStateEvidence(request.event.phase, request.event.state, request.event.evidence);
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
    const response = await fetchWithTimeout(fetchImpl, actionUrl(endpoint, 'base-child-intent-batch'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: canonicalJson(batch),
    }, timeoutMs);
    if (response?.status !== 201 || !response?.ok) {
      throw new Error(`agent index reporter returned HTTP ${response?.status ?? 'unknown'}`);
    }
    let acknowledgement;
    try { acknowledgement = await response.json(); } catch (error) {
      throw new Error('agent index reporter acknowledgement is malformed', { cause: error });
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
      || acknowledgement.children.some((entry, index) => {
        try {
          exactObject(entry, BATCH_CHILD_ACK_FIELDS, 'batch child acknowledgement');
          exactObject(entry.identity, RECOVERY_IDENTITY_FIELD_SET, 'batch acknowledgement identity');
          return !sameRecoveryIdentity(entry.identity, identities[index])
            || !Number.isSafeInteger(entry.recoveryVersion)
            || entry.recoveryVersion < 0;
        } catch { return true; }
      })) {
      throw new Error('agent index reporter batch acknowledgement is malformed');
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

  async function probe() {
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
    if (
      acknowledgement?.stores?.executionReceipts !== true
      || acknowledgement?.stores?.baseChildIntents !== true
      || acknowledgement?.stores?.baseRecoveryEvidence !== true
    ) {
      throw new Error('agent index reporter canonical stores are not ready');
    }
    return acknowledgement;
  }

  return Object.freeze({
    commitIntent, commitIntentBatch, reportLifecycle, reportBaseEvidence, probe,
  });
}
