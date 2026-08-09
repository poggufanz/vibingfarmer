export const BASE_EVIDENCE_PHASES = new Set([
  'cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit',
]);
export const BASE_EVIDENCE_STATES = new Set([
  'submitting', 'submitted', 'confirmed', 'failed', 'unknown', 'blocked',
]);

const DEPOSIT_EVENT_FIELDS = new Set([
  'address', 'topic0', 'logIndex', 'caller', 'poolAddress', 'assets', 'shares',
]);
const UNSIGNED_FIELDS = new Set([
  'burnUnits7', 'evidenceVersion', 'chainId', 'assets', 'minShares', 'shares', 'logIndex',
]);
const BASE_COMMON_FIELDS = [
  'chainId', 'yieldRouterAddress', 'caller', 'poolAddress', 'assets', 'minShares',
];
const BASE_EVIDENCE_SCHEMAS = new Map([
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

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unexpected = Object.keys(value).find((field) => !fields.has(field));
  if (unexpected) throw new Error(`${label}.${unexpected} is not allowlisted`);
  const missing = [...fields].find((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing) throw new Error(`${label}.${missing} is required`);
}

function validateEvidenceObject(value, fields, label) {
  exactObject(value, fields, label);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'event') {
      validateEvidenceObject(entry, DEPOSIT_EVENT_FIELDS, 'deposit event');
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
  validateEvidenceObject(evidence, fields, 'evidence');
  for (const field of ['yieldRouterAddress', 'caller', 'poolAddress']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field)
        && !LOWER_ADDRESS_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical address`);
    }
  }
  for (const field of ['userOpHash', 'transactionHash', 'mintTxHash']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field)
        && evidence[field] !== null && !LOWER_EVM_HASH_RE.test(evidence[field])) {
      throw new Error(`evidence.${field} must be a canonical hash`);
    }
  }
  for (const field of ['burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest']) {
    if (Object.prototype.hasOwnProperty.call(evidence, field)
        && !LOWER_DIGEST_RE.test(evidence[field])) {
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
  return evidence;
}
