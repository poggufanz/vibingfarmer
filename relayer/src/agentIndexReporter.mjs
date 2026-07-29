const IDENTITY_FIELDS = ['networkId', 'owner', 'bindingId', 'allocationId', 'childId'];
const CHILD_FIELDS = new Set([
  'version', 'networkId', 'owner', 'agent', 'bindingId', 'allocationId', 'childId',
  'intent', 'lifecycle',
]);
const INTENT_FIELDS = new Set([
  'token', 'units', 'decimals', 'poolAddress', 'proxyTarget', 'runId', 'grantTxHash',
  'kernelAddress', 'bindingHash', 'baseJobId',
]);
const IDENTITY_FIELD_SET = new Set(IDENTITY_FIELDS);
const LIFECYCLE_FIELDS = new Set(['sequence', 'status', 'evidence', 'observedAt']);
const LIFECYCLE_REQUEST_FIELDS = new Set(['identity', 'expectedSequence', 'lifecycle']);

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
        || normalized === 'mandate') {
      throw new Error(`secret/private/approval property rejected at ${path}.${key}`);
    }
    rejectSensitive(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
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
}

function childIdentity(child) {
  return {
    networkId: requireText(child?.networkId, 'networkId'),
    owner: requireText(child?.owner, 'owner'),
    bindingId: requireText(child?.bindingId, 'bindingId'),
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

  return Object.freeze({ commitIntent, reportLifecycle });
}
