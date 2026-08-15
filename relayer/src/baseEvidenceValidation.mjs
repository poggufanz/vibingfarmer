export const BASE_EVIDENCE_PHASES = new Set([
  'cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit',
]);
export const BASE_EVIDENCE_STATES = new Set([
  'submitting', 'submitted', 'confirmed', 'failed', 'unknown', 'blocked',
]);

const DEPOSIT_EVENT_FIELDS = new Set(['address', 'topic0', 'logIndex', 'caller', 'poolAddress', 'assets', 'shares']);
export const PINNED_ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
export const RECONCILE_HANDLE_FIELDS = Object.freeze(['entryPoint', 'sender', 'nonce', 'startBlock']);
const RECONCILE_HANDLE_FIELD_SET = new Set(RECONCILE_HANDLE_FIELDS);
const UNSIGNED_FIELDS = new Set([
  'burnUnits7', 'evidenceVersion', 'chainId', 'assets', 'minShares', 'shares', 'logIndex',
]);
const BASE_COMMON_FIELDS = ['chainId', 'yieldRouterAddress', 'caller', 'poolAddress', 'assets', 'minShares'];
const CCTP_BURN_IMMUTABLE_FIELDS = ['burnTxHash', 'expectationDigest'];
const CCTP_ATTESTATION_IMMUTABLE_FIELDS = [...CCTP_BURN_IMMUTABLE_FIELDS, 'messageDigest', 'nonce'];
const CCTP_MINT_IMMUTABLE_FIELDS = [...CCTP_ATTESTATION_IMMUTABLE_FIELDS, 'attestationDigest'];
const BASE_EVIDENCE_SCHEMAS = new Map([
  ['cctp_burn:submitted', new Set([...CCTP_BURN_IMMUTABLE_FIELDS, 'burnUnits7'])],
  ['cctp_burn:confirmed', new Set([...CCTP_BURN_IMMUTABLE_FIELDS, 'burnUnits7'])],
  ['cctp_burn:unknown', new Set([...CCTP_BURN_IMMUTABLE_FIELDS, 'burnUnits7', 'reasonCode'])],
  ['cctp_burn:failed', new Set(['reasonCode'])],
  ['cctp_burn:blocked', new Set(['reasonCode'])],
  [
    'cctp_attestation:confirmed',
    new Set([...CCTP_BURN_IMMUTABLE_FIELDS, 'messageDigest', 'attestationDigest', 'evidenceVersion']),
  ],
  ...['submitting', 'submitted', 'unknown'].map((state) => [
    `cctp_attestation:${state}`,
    new Set(CCTP_ATTESTATION_IMMUTABLE_FIELDS),
  ]),
  ...['failed', 'blocked'].map((state) => [
    `cctp_attestation:${state}`,
    new Set([...CCTP_ATTESTATION_IMMUTABLE_FIELDS, 'reasonCode']),
  ]),
  [
    'cctp_mint:confirmed',
    new Set([...CCTP_BURN_IMMUTABLE_FIELDS, 'messageDigest', 'attestationDigest', 'evidenceVersion', 'mintTxHash']),
  ],
  ['cctp_mint:submitted', new Set([...CCTP_MINT_IMMUTABLE_FIELDS, 'evidenceVersion'])],
  ...['submitting', 'unknown'].map((state) => [`cctp_mint:${state}`, new Set(CCTP_MINT_IMMUTABLE_FIELDS)]),
  ...['failed', 'blocked'].map((state) => [
    `cctp_mint:${state}`,
    new Set([...CCTP_MINT_IMMUTABLE_FIELDS, 'reasonCode']),
  ]),
  ['base_deposit:submitting', new Set(BASE_COMMON_FIELDS)],
  ['base_deposit:submitted', new Set([...BASE_COMMON_FIELDS, 'userOpHash'])],
  ['base_deposit:confirmed', new Set([...BASE_COMMON_FIELDS, 'shares', 'userOpHash', 'transactionHash', 'event'])],
  ['base_deposit:failed', new Set([...BASE_COMMON_FIELDS, 'userOpHash', 'transactionHash', 'reasonCode'])],
  ['base_deposit:unknown', new Set(BASE_COMMON_FIELDS)],
  ['base_deposit:blocked', new Set([...BASE_COMMON_FIELDS, 'reasonCode'])],
]);
const BASE_EVIDENCE_OPTIONAL_FIELDS = new Map([
  ['cctp_burn:confirmed', ['messageDigest', 'nonce']],
  ['cctp_attestation:confirmed', ['nonce']],
  ['cctp_mint:submitted', ['mintTxHash']],
  ['cctp_mint:unknown', ['mintTxHash']],
  ['cctp_mint:confirmed', ['nonce']],
  ['base_deposit:failed', ['custodyLocation', 'kernelCustodyConfirmed', 'custody']],
  ['base_deposit:unknown', ['userOpHash', 'transactionHash', 'reasonCode']],
  ['base_deposit:blocked', ['userOpHash', 'transactionHash', 'kernelCustodyConfirmed', 'custodyLocation', 'custody']],
]);

const LOWER_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const LOWER_EVM_HASH_RE = /^0x[0-9a-f]{64}$/;
const LOWER_DIGEST_RE = /^[0-9a-f]{64}$/;
const LOWER_CCTP_DIGEST_RE = /^0x[0-9a-f]{64}$/;
const UNSIGNED_DECIMAL_RE = /^(0|[1-9]\d*)$/;

function canonicalHandleAddress(value, label) {
  if (typeof value !== 'string' || !LOWER_ADDRESS_RE.test(value)) {
    throw new Error(`reconcileHandle.${label} must be a canonical address`);
  }
  return value;
}

/**
 * Normalize the immutable chain facts used to recover a Base deposit without a replacement
 * UserOperation.  Evidence accepts this field as optional for historical rows, but every new
 * orchestrator submission carries the complete canonical shape.
 */
export function normalizeReconcileHandle(value, { sender = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('reconcileHandle must be an object');
  }
  const keys = Object.keys(value);
  if (keys.length !== RECONCILE_HANDLE_FIELDS.length || keys.some((field) => !RECONCILE_HANDLE_FIELD_SET.has(field))) {
    throw new Error('reconcileHandle must contain exactly entryPoint, sender, nonce, and startBlock');
  }
  const entryPoint = canonicalHandleAddress(value.entryPoint, 'entryPoint');
  if (entryPoint !== PINNED_ENTRY_POINT) {
    throw new Error('reconcileHandle.entryPoint is not the pinned EntryPoint');
  }
  const handleSender = canonicalHandleAddress(value.sender, 'sender');
  if (handleSender === `0x${'00'.repeat(20)}`) {
    throw new Error('reconcileHandle.sender must not be the zero address');
  }
  if (sender !== null && canonicalHandleAddress(sender, 'expected sender') !== handleSender) {
    throw new Error('reconcileHandle.sender disagrees with the Kernel caller');
  }
  for (const field of ['nonce', 'startBlock']) {
    if (typeof value[field] !== 'string' || !UNSIGNED_DECIMAL_RE.test(value[field])) {
      throw new Error(`reconcileHandle.${field} must be a canonical unsigned decimal string`);
    }
  }
  return Object.freeze({
    entryPoint,
    sender: handleSender,
    nonce: value.nonce,
    startBlock: value.startBlock,
  });
}

export const validateReconcileHandle = normalizeReconcileHandle;

function exactObject(value, fields, label, requiredFields = fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).find((field) => !fields.has(field));
  if (unexpected) throw new Error(`${label}.${unexpected} is not allowlisted`);
  const missing = [...requiredFields].find((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing) throw new Error(`${label}.${missing} is required`);
}

function validateEvidenceObject(value, fields, label, { optionalFields = [], requiredFields = fields } = {}) {
  const allowed = new Set([...fields, ...optionalFields]);
  exactObject(value, allowed, label, requiredFields);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'event') {
      validateEvidenceObject(entry, DEPOSIT_EVENT_FIELDS, 'deposit event');
    } else if (key === 'custody') {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).some((field) => !['location', 'confirmed'].includes(field)) ||
        typeof entry.location !== 'string' ||
        typeof entry.confirmed !== 'boolean'
      ) {
        throw new Error(`${label}.${key} must contain only location and confirmed`);
      }
    } else if (key === 'reconcileHandle') {
      normalizeReconcileHandle(entry, { sender: value.caller ?? null });
    } else if (key === 'nonce') {
      if (typeof entry !== 'string' || (!UNSIGNED_DECIMAL_RE.test(entry) && !LOWER_CCTP_DIGEST_RE.test(entry))) {
        throw new Error(`${label}.${key} must be a canonical decimal or bytes32 nonce`);
      }
    } else if (UNSIGNED_FIELDS.has(key)) {
      if (typeof entry !== 'string' || !/^(0|[1-9]\d*)$/.test(entry)) {
        throw new Error(`${label}.${key} must be an unsigned decimal string`);
      }
    } else if (entry !== null && !['string', 'boolean'].includes(typeof entry)) {
      throw new Error(`${label}.${key} must be a bounded scalar`);
    }
  }
}

export function validateBaseEvidence(phase, state, evidence) {
  const fields = BASE_EVIDENCE_SCHEMAS.get(`${phase}:${state}`);
  if (!fields) throw new Error('Base evidence phase/state schema is invalid');
  const schemaKey = `${phase}:${state}`;
  validateEvidenceObject(evidence, fields, 'evidence', {
    optionalFields: [
      ...(BASE_EVIDENCE_OPTIONAL_FIELDS.get(schemaKey) ?? []),
      ...(phase === 'base_deposit' ? ['kernelAddress', 'reconcileHandle'] : []),
    ],
  });
  for (const field of ['yieldRouterAddress', 'caller', 'poolAddress', 'kernelAddress']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field) && !LOWER_ADDRESS_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical address`);
    }
  }
  for (const field of ['userOpHash', 'transactionHash', 'mintTxHash']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field)
        && evidence[field] !== null && !LOWER_EVM_HASH_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical hash`);
    }
  }
  for (const field of ['burnTxHash', 'expectationDigest']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field) && !LOWER_DIGEST_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical digest`);
    }
  }
  for (const field of ['messageDigest', 'attestationDigest']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field) && !LOWER_CCTP_DIGEST_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical 0x-prefixed digest`);
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
  return evidence;
}
