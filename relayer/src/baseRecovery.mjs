// Base-only recovery authority. This module deliberately has no dependency on the forward farm,
// Stellar pull, or CCTP submission paths. It consumes an already-persisted closed evidence bundle
// and delegates at most one injected Task 8/10 safe seam.
import { createHash } from 'node:crypto';

export const BASE_RECOVERY_ACTIONS = Object.freeze([
  'poll-attestation', 'submit-mint', 'poll-mint',
  'submit-base-deposit', 'poll-base-deposit',
]);

export const BASE_RECOVERY_PHASES = Object.freeze([
  'cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit', 'base_position',
]);

const ACTION_SET = new Set(BASE_RECOVERY_ACTIONS);
const PHASE_SET = new Set(BASE_RECOVERY_PHASES);
const ACTION_PHASE = new Map([
  ['poll-attestation', 'cctp_attestation'],
  ['submit-mint', 'cctp_mint'],
  ['poll-mint', 'cctp_mint'],
  ['submit-base-deposit', 'base_deposit'],
  ['poll-base-deposit', 'base_deposit'],
]);
const IDENTITY_FIELDS = Object.freeze([
  'networkId', 'bindingId', 'executionId', 'allocationId', 'childId',
]);
const IDENTITY_SET = new Set(IDENTITY_FIELDS);
const INTENT_FIELDS = Object.freeze([
  'runId', 'grantTxHash', 'bindingHash', 'baseJobId', 'kernelAddress', 'poolAddress',
  'proxyTarget', 'token', 'units', 'decimals', 'minShares',
]);
const INTENT_SET = new Set(INTENT_FIELDS);
const PROJECTION_FIELDS = new Set([
  'identity', 'owner', 'agent', 'state', 'evidence', 'evidenceDigest',
  'recoveryVersion', 'eventId', 'observedAt', 'phase',
]);
const EVENT_FIELDS = new Set([
  'identity', 'owner', 'agent', 'phase', 'state', 'evidence', 'evidenceDigest',
  'recoveryVersion', 'eventId', 'observedAt',
]);
const EVIDENCE_FIELDS = new Set([
  'burnTxHash', 'expectationDigest', 'burnUnits7', 'amount', 'token', 'units', 'decimals',
  'destinationDomain', 'messageDigest', 'messageHash', 'messageHex', 'mintRecipient',
  'nonce', 'nonceHex', 'attestationDigest', 'evidenceVersion', 'mintTxHash',
  'attestationHash', 'transactionHash', 'blockNumber', 'blockHash', 'chainId',
  'yieldRouterAddress', 'yieldRouter', 'caller', 'poolAddress', 'assets', 'minShares',
  'shares', 'userOpHash', 'reconcileHandle', 'reasonCode', 'custodyLocation',
  'kernelCustodyConfirmed', 'custody', 'event',
]);
const DEPOSIT_EVENT_FIELDS = new Set([
  'address', 'topic0', 'logIndex', 'caller', 'poolAddress', 'assets', 'shares',
]);
const STATES = new Set(['submitting', 'submitted', 'confirmed', 'failed', 'unknown', 'blocked']);
const TERMINAL_PHASES = new Set(['cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit']);
const PHASE_ORDER = Object.freeze(['cctp_burn', 'cctp_attestation', 'cctp_mint', 'base_deposit']);
const PHASE_ORDER_INDEX = new Map(PHASE_ORDER.map((phase, index) => [phase, index]));
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9]\d*)$/;
const LOWER_TOKEN = /^[0-9a-f]{64}$/;
const PINNED_ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const RECONCILE_HANDLE_FIELDS = new Set(['entryPoint', 'sender', 'nonce', 'startBlock']);

const BURN_EVIDENCE = ['burnTxHash', 'expectationDigest', 'burnUnits7'];
const ATTESTATION_EVIDENCE = ['burnTxHash', 'expectationDigest', 'messageDigest', 'nonce'];
const MINT_EVIDENCE = [
  'burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest', 'nonce',
];
const BASE_DEPOSIT_EVIDENCE = [
  'chainId', 'yieldRouterAddress', 'caller', 'poolAddress', 'assets', 'minShares',
];
const PHASE_STATE_EVIDENCE = new Map([
  ['cctp_burn:submitted', { required: BURN_EVIDENCE }],
  ['cctp_burn:confirmed', { required: [...BURN_EVIDENCE, 'messageDigest', 'nonce'] }],
  ['cctp_burn:unknown', { required: [...BURN_EVIDENCE, 'reasonCode'] }],
  ['cctp_burn:failed', { required: ['reasonCode'] }],
  ['cctp_burn:blocked', { required: ['reasonCode'] }],
  ['cctp_attestation:confirmed', {
    required: [...ATTESTATION_EVIDENCE, 'attestationDigest', 'evidenceVersion'],
  }],
  ...['submitting', 'submitted', 'unknown'].map((state) => [
    `cctp_attestation:${state}`, { required: ATTESTATION_EVIDENCE },
  ]),
  ...['failed', 'blocked'].map((state) => [
    `cctp_attestation:${state}`, { required: [...ATTESTATION_EVIDENCE, 'reasonCode'] },
  ]),
  ['cctp_mint:confirmed', {
    required: [...MINT_EVIDENCE, 'evidenceVersion', 'mintTxHash'],
  }],
  ['cctp_mint:submitted', {
    required: [...MINT_EVIDENCE, 'evidenceVersion'], optional: ['mintTxHash'],
  }],
  ['cctp_mint:submitting', { required: MINT_EVIDENCE }],
  ['cctp_mint:unknown', { required: MINT_EVIDENCE, optional: ['mintTxHash'] }],
  ...['failed', 'blocked'].map((state) => [
    `cctp_mint:${state}`, { required: [...MINT_EVIDENCE, 'reasonCode'] },
  ]),
  ['base_deposit:submitting', {
    required: [...BASE_DEPOSIT_EVIDENCE, 'reconcileHandle'], optional: ['kernelAddress'],
  }],
  ['base_deposit:submitted', {
    required: [...BASE_DEPOSIT_EVIDENCE, 'userOpHash'], optional: ['kernelAddress', 'reconcileHandle'],
  }],
  ['base_deposit:confirmed', {
    required: [...BASE_DEPOSIT_EVIDENCE, 'shares', 'userOpHash', 'transactionHash', 'event'],
    optional: ['kernelAddress', 'reconcileHandle'],
  }],
  ['base_deposit:unknown', {
    required: BASE_DEPOSIT_EVIDENCE,
    optional: ['kernelAddress', 'reconcileHandle', 'userOpHash', 'transactionHash', 'reasonCode'],
  }],
  ['base_deposit:failed', {
    required: [...BASE_DEPOSIT_EVIDENCE, 'userOpHash', 'transactionHash', 'reasonCode'],
    optional: [
      'kernelAddress', 'reconcileHandle', 'custodyLocation', 'kernelCustodyConfirmed', 'custody',
    ],
  }],
  ['base_deposit:blocked', {
    required: [...BASE_DEPOSIT_EVIDENCE, 'reasonCode'],
    optional: [
      'kernelAddress', 'reconcileHandle', 'userOpHash', 'transactionHash',
      'custodyLocation', 'kernelCustodyConfirmed', 'custody',
    ],
  }],
]);

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !fields.has(key));
  if (unexpected) throw new Error(`unexpected ${label} field: ${unexpected}`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  return value;
}

function requireSafeInteger(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${label} is invalid`);
  return value;
}

function rejectSensitive(value, path = '$', seen = new WeakSet(), root = true) {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`circular Base recovery bundle at ${path}`);
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const recoveryTokenAtEnvelope = root && key === 'leaseToken';
    if (!recoveryTokenAtEnvelope && (normalized.includes('secret') || normalized.includes('private')
      || normalized.includes('sessionkey') || normalized.includes('serializedapproval')
        || normalized.includes('capability') || normalized.includes('bearer')
        || normalized.includes('leasetoken') || normalized.includes('authorization')
        || normalized.includes('wallet') || normalized.includes('passkey')
        || normalized.includes('diagnostic') || normalized.includes('endpoint')
        || normalized === 'approval' || normalized === 'mandate')) {
      throw new Error(`sensitive Base recovery property rejected at ${path}.${key}`);
    }
    rejectSensitive(entry, `${path}.${key}`, seen, false);
  }
  seen.delete(value);
}

function validateIdentity(value, label = 'identity') {
  exactObject(value, IDENTITY_SET, label);
  const identity = Object.fromEntries(IDENTITY_FIELDS.map((field) => [
    field, requireText(value[field], `${label}.${field}`),
  ]));
  return Object.freeze(identity);
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function validateRecoveryIdentityMapping(identity) {
  const marker = ':exec:';
  const split = identity.executionId.indexOf(marker);
  if (split <= 0 || identity.executionId.slice(split + marker.length) !== identity.allocationId) {
    throw new Error('executionId must match allocationId');
  }
  return identity;
}

function validateExecutionMapping(identity, intent) {
  if (identity.executionId !== `${intent.runId}:exec:${identity.allocationId}`) {
    throw new Error('executionId does not match the immutable run/allocation mapping');
  }
}

function validateScalarEvidence(value, label) {
  if (value == null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return;
  throw new Error(`${label} must be a bounded scalar`);
}

function validatePhaseEvidenceGrammar(value, phase, state, label) {
  const grammar = PHASE_STATE_EVIDENCE.get(`${phase}:${state}`);
  if (!grammar) throw new Error(`${label} phase/state schema is invalid`);
  const allowed = new Set([...(grammar.required ?? []), ...(grammar.optional ?? [])]);
  exactObject(value, allowed, label);
  for (const field of grammar.required ?? []) {
    if (!Object.hasOwn(value, field) || value[field] == null || value[field] === '') {
      throw new Error(`${label}.${field} is required`);
    }
  }
}

function validateEvidence(value, phase, state, label = 'evidence') {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  validatePhaseEvidenceGrammar(value, phase, state, label);
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !EVIDENCE_FIELDS.has(key));
  if (unknown) throw new Error(`unexpected ${label} field: ${unknown}`);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'event') {
      exactObject(entry, DEPOSIT_EVENT_FIELDS, `${label}.event`);
      for (const [eventKey, eventValue] of Object.entries(entry)) {
        validateScalarEvidence(eventValue, `${label}.event.${eventKey}`);
      }
      if (!EVM_ADDRESS.test(String(entry.address)) || !EVM_HASH.test(String(entry.topic0))
          || !EVM_ADDRESS.test(String(entry.caller)) || !EVM_ADDRESS.test(String(entry.poolAddress))
          || !DECIMAL.test(String(entry.assets)) || !DECIMAL.test(String(entry.shares))
          || typeof entry.logIndex !== 'string' || !DECIMAL.test(entry.logIndex)) {
        throw new Error(`${label}.event contains a noncanonical deposit fact`);
      }
    } else if (key === 'reconcileHandle') {
      exactObject(entry, RECONCILE_HANDLE_FIELDS, `${label}.reconcileHandle`);
      if (!EVM_ADDRESS.test(String(entry.entryPoint))
          || entry.entryPoint !== PINNED_ENTRY_POINT
          || !EVM_ADDRESS.test(String(entry.sender))
          || entry.sender === `0x${'00'.repeat(20)}`
          || typeof entry.nonce !== 'string' || !DECIMAL.test(entry.nonce)
          || typeof entry.startBlock !== 'string' || !DECIMAL.test(entry.startBlock)) {
        throw new Error(`${label}.reconcileHandle is not canonical`);
      }
      if (Object.hasOwn(value, 'caller') && value.caller !== entry.sender) {
        throw new Error(`${label}.reconcileHandle.sender disagrees with caller`);
      }
    } else if (key === 'custody') {
      exactObject(entry, new Set(['location', 'confirmed']), `${label}.custody`);
      requireText(entry.location, `${label}.custody.location`);
      if (typeof entry.confirmed !== 'boolean') {
        throw new Error(`${label}.custody.confirmed must be boolean`);
      }
    } else {
      validateScalarEvidence(entry, `${label}.${key}`);
    }
  }
  for (const key of [
    'units', 'minShares', 'assets', 'shares', 'burnUnits7', 'amount', 'evidenceVersion',
  ]) {
    if (Object.hasOwn(value, key) && !DECIMAL.test(String(value[key]))) {
      throw new Error(`${label}.${key} must be an unsigned decimal string`);
    }
  }
  for (const key of [
    'yieldRouterAddress', 'yieldRouter', 'caller', 'poolAddress', 'kernelAddress',
  ]) {
    if (Object.hasOwn(value, key) && !EVM_ADDRESS.test(String(value[key]))) {
      throw new Error(`${label}.${key} must be a lowercase EVM address`);
    }
  }
  for (const key of [
    'userOpHash', 'transactionHash', 'mintTxHash', 'messageHash', 'attestationHash', 'blockHash',
  ]) {
    if (Object.hasOwn(value, key) && value[key] !== null && !EVM_HASH.test(String(value[key]))) {
      throw new Error(`${label}.${key} must be a canonical EVM hash`);
    }
  }
  for (const key of ['burnTxHash', 'expectationDigest']) {
    if (Object.hasOwn(value, key) && value[key] !== null && !DIGEST.test(String(value[key]))) {
      throw new Error(`${label}.${key} must be a lowercase digest`);
    }
  }
  for (const key of ['messageDigest', 'attestationDigest']) {
    if (Object.hasOwn(value, key) && value[key] !== null && !BYTES32.test(String(value[key]))) {
      throw new Error(`${label}.${key} must be a bytes32 digest`);
    }
  }
  for (const key of ['nonce', 'nonceHex', 'messageHex']) {
    if (Object.hasOwn(value, key) && value[key] !== null && typeof value[key] !== 'string') {
      throw new Error(`${label}.${key} must be a string`);
    }
  }
  if (Object.hasOwn(value, 'nonce') && value.nonce !== null
      && !BYTES32.test(String(value.nonce)) && !DECIMAL.test(String(value.nonce))) {
    throw new Error(`${label}.nonce must be a bytes32 or unsigned decimal`);
  }
  if (Object.hasOwn(value, 'kernelCustodyConfirmed')
      && typeof value.kernelCustodyConfirmed !== 'boolean') {
    throw new Error(`${label}.kernelCustodyConfirmed must be boolean`);
  }
  if (Object.hasOwn(value, 'evidenceDigest')
      && (!DIGEST.test(String(value.evidenceDigest)))) {
    throw new Error(`${label}.evidenceDigest must be a lowercase digest`);
  }
  if (phase === 'base_deposit' && state === 'confirmed') {
    exactObject(value.event, DEPOSIT_EVENT_FIELDS, `${label}.event`);
  }
  return value;
}

function validatePhaseEntry(value, phase, identity, fields, label) {
  if (value == null) return null;
  exactObject(value, fields, label);
  const entryIdentity = validateIdentity(value.identity, `${label}.identity`);
  if (!sameIdentity(entryIdentity, identity)) throw new Error(`${label}.identity mismatch`);
  if (value.phase !== phase || !PHASE_SET.has(value.phase)) throw new Error(`${label}.phase is invalid`);
  if (!STATES.has(value.state)) throw new Error(`${label}.state is invalid`);
  requireSafeInteger(value.recoveryVersion, `${label}.recoveryVersion`);
  requireSafeInteger(value.observedAt, `${label}.observedAt`);
  if (typeof value.eventId !== 'string' || !DIGEST.test(value.eventId)) {
    throw new Error(`${label}.eventId must be a lowercase digest`);
  }
  if (Object.hasOwn(value, 'evidenceDigest')
      && (!DIGEST.test(String(value.evidenceDigest)))) {
    throw new Error(`${label}.evidenceDigest must be a lowercase digest`);
  }
  if (Object.hasOwn(value, 'owner') && typeof value.owner !== 'string') {
    throw new Error(`${label}.owner is invalid`);
  }
  if (Object.hasOwn(value, 'agent') && typeof value.agent !== 'string') {
    throw new Error(`${label}.agent is invalid`);
  }
  if (Object.hasOwn(value, 'owner') !== Object.hasOwn(value, 'agent')) {
    throw new Error(`${label}.owner/agent must be paired`);
  }
  validateEvidence(value.evidence, phase, value.state, `${label}.evidence`);
  validatePhaseEvidenceShape(value.evidence, phase, value.state, label);
  return Object.freeze({ ...value, identity: entryIdentity });
}

function requireEvidenceKeys(evidence, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(evidence, key) || evidence[key] == null || evidence[key] === '') {
      throw new Error(`${label}.${key} is required`);
    }
  }
}

function validatePhaseEvidenceShape(evidence, phase, state, label) {
  if (phase === 'cctp_burn' && state === 'confirmed') {
    requireEvidenceKeys(
      evidence,
      ['burnTxHash', 'expectationDigest', 'burnUnits7', 'messageDigest', 'nonce'],
      label,
    );
  }
  if (phase === 'cctp_attestation') {
    requireEvidenceKeys(evidence, ['burnTxHash', 'expectationDigest', 'messageDigest', 'nonce'], label);
    if (state === 'confirmed') requireEvidenceKeys(evidence, ['attestationDigest'], label);
  }
  if (phase === 'cctp_mint') {
    requireEvidenceKeys(
      evidence,
      ['burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest', 'nonce'],
      label,
    );
    if (state === 'confirmed') requireEvidenceKeys(evidence, ['mintTxHash'], label);
  }
  if (phase === 'base_deposit') {
    requireEvidenceKeys(
      evidence,
      ['caller', 'poolAddress', 'assets', 'minShares'],
      label,
    );
    if (state === 'submitting') {
      requireEvidenceKeys(evidence, ['reconcileHandle'], label);
    }
    if (state === 'submitted') requireEvidenceKeys(evidence, ['userOpHash'], label);
    if (state === 'unknown' && !(
      hasEvidenceValue(evidence, 'userOpHash')
      || hasEvidenceValue(evidence, 'reconcileHandle')
    )) {
      throw new Error(`${label} requires a Base deposit reconcile identity`);
    }
    if (state === 'confirmed') {
      requireEvidenceKeys(evidence, ['userOpHash', 'transactionHash', 'shares', 'event'], label);
      if (evidence.shares !== evidence.event?.shares) {
        throw new Error(`${label}.shares must match the canonical deposit event`);
      }
    }
  }
}

function hasEvidenceValue(evidence, key) {
  return Object.hasOwn(evidence, key) && evidence[key] != null && evidence[key] !== '';
}

function validateEvents(events, identity) {
  if (!Array.isArray(events)) throw new Error('events must be an array');
  let previous = 0;
  const phaseStates = new Map();
  let highestPhase = -1;
  return events.map((event, index) => {
    const entry = validatePhaseEntry(event, event?.phase, identity, EVENT_FIELDS, `events[${index}]`);
    if (!entry || !TERMINAL_PHASES.has(entry.phase)) throw new Error('event phase is invalid');
    if (entry.recoveryVersion !== previous + 1) throw new Error('recovery event versions must be contiguous');
    const phaseIndex = PHASE_ORDER_INDEX.get(entry.phase);
    if (phaseIndex < highestPhase) throw new Error('recovery phase order regressed');
    highestPhase = Math.max(highestPhase, phaseIndex);
    const previousState = phaseStates.get(entry.phase);
    if (previousState === 'confirmed') throw new Error('confirmed recovery phase regressed');
    if (previousState) {
      const allowed = {
        submitting: new Set(['submitted', 'confirmed', 'failed', 'unknown', 'blocked']),
        submitted: new Set(['confirmed', 'failed', 'unknown', 'blocked']),
        unknown: new Set(['confirmed']),
        // Iris may publish an attestation failure while retaining the same immutable
        // message/nonce. Only that read-only CCTP phase may append a confirmed retry; mint and
        // deposit failures remain terminal/manual unless their own pinned reconciliation fact
        // selects a different safe action.
        failed: entry.phase === 'cctp_attestation' ? new Set(['confirmed']) : new Set(),
      };
      if (!allowed[previousState]?.has(entry.state)) {
        throw new Error('recovery phase state transition is invalid');
      }
    }
    const predecessor = PHASE_ORDER[phaseIndex - 1];
    if (phaseIndex > 0 && !events.slice(0, index).some((candidate) => (
      candidate?.phase === predecessor && candidate.state === 'confirmed'
    ))) {
      throw new Error('recovery phase prerequisite is not confirmed');
    }
    phaseStates.set(entry.phase, entry.state);
    previous = entry.recoveryVersion;
    return entry;
  });
}

function normalizePhases(value, identity) {
  const phases = Object.fromEntries(BASE_RECOVERY_PHASES.map((phase) => [phase, null]));
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const phase = entry?.phase;
      if (!PHASE_SET.has(phase) || phase === 'base_position') {
        throw new Error(`phases[${index}] is invalid`);
      }
      if (phases[phase]) throw new Error(`duplicate ${phase} phase projection`);
      phases[phase] = validatePhaseEntry(entry, phase, identity, PROJECTION_FIELDS, `phases[${index}]`);
    }
    return phases;
  }
  exactObject(value, new Set(BASE_RECOVERY_PHASES), 'phases');
  for (const phase of BASE_RECOVERY_PHASES) {
    phases[phase] = validatePhaseEntry(
      value[phase], phase, identity, PROJECTION_FIELDS, `phases.${phase}`,
    );
  }
  return phases;
}

function validateIntent(value, identity) {
  exactObject(value, INTENT_SET, 'intent');
  for (const key of ['runId', 'proxyTarget', 'token']) requireText(value[key], `intent.${key}`);
  if (value.token !== 'USDC') throw new Error('intent.token is not supported');
  if (!DIGEST.test(value.grantTxHash) || !DIGEST.test(value.bindingHash)) {
    throw new Error('intent grant/binding hash is invalid');
  }
  for (const key of ['kernelAddress', 'poolAddress']) {
    if (!EVM_ADDRESS.test(value[key])) throw new Error(`intent.${key} is invalid`);
  }
  for (const key of ['units', 'minShares']) {
    if (!DECIMAL.test(value[key])) throw new Error(`intent.${key} is invalid`);
  }
  requireSafeInteger(value.decimals, 'intent.decimals');
  if (value.baseJobId !== identity.childId) throw new Error('intent.baseJobId does not match childId');
  return Object.freeze({ ...value });
}

function projectionEquivalent(projection, event) {
  return projection?.eventId === event?.eventId
    && projection?.phase === event?.phase
    && projection?.state === event?.state
    && projection?.recoveryVersion === event?.recoveryVersion
    && projection?.observedAt === event?.observedAt
    && projection?.evidenceDigest === event?.evidenceDigest
    && JSON.stringify(projection?.evidence) === JSON.stringify(event?.evidence)
    && sameIdentity(projection?.identity, event?.identity);
}

function validateBaseDepositIntentFacts(entries, intent) {
  for (const entry of entries) {
    if (!entry || entry.phase !== 'base_deposit') continue;
    const evidence = entry.evidence;
    if (evidence.caller !== intent.kernelAddress) {
      throw new Error('base deposit caller disagrees with immutable Kernel intent');
    }
    if (evidence.reconcileHandle && evidence.reconcileHandle.sender !== intent.kernelAddress) {
      throw new Error('base deposit reconcile sender disagrees with immutable Kernel intent');
    }
    if (evidence.poolAddress !== intent.poolAddress) {
      throw new Error('base deposit pool disagrees with immutable intent');
    }
    if (evidence.assets !== intent.units) {
      throw new Error('base deposit assets disagree with immutable intent');
    }
    if (evidence.minShares !== intent.minShares) {
      throw new Error('base deposit minShares disagrees with immutable intent');
    }
  }
}

/**
 * Validate the closed internal bundle used by the relayer. It throws for callers that need a
 * typed validation boundary; selectBaseChildRecoveryAction catches all failures and is total.
 */
export function validateBaseRecoveryBundle(bundle) {
  exactObject(bundle, new Set([
    'schemaVersion', 'identity', 'owner', 'agent', 'recoverable', 'recoveryVersion',
    'intent', 'phases', 'events',
  ]), 'Base recovery bundle');
  if (bundle.schemaVersion !== 1) throw new Error('Base recovery bundle schema mismatch');
  const identity = validateIdentity(bundle.identity);
  requireText(bundle.owner, 'owner');
  requireText(bundle.agent, 'agent');
  if (bundle.recoverable !== true) throw new Error('Base recovery bundle is not recoverable');
  requireSafeInteger(bundle.recoveryVersion, 'recoveryVersion');
  const intent = validateIntent(bundle.intent, identity);
  validateExecutionMapping(identity, intent);
  const phases = normalizePhases(bundle.phases, identity);
  const events = validateEvents(bundle.events, identity);
  validateBaseDepositIntentFacts(
    [...events, ...Object.values(phases)],
    intent,
  );
  if (events.length !== bundle.recoveryVersion) {
    throw new Error('recoveryVersion does not match event head');
  }
  for (const event of events) {
    if (Object.hasOwn(event, 'owner') && event.owner !== bundle.owner) {
      throw new Error('event owner mismatch');
    }
    if (Object.hasOwn(event, 'agent') && event.agent !== bundle.agent) {
      throw new Error('event agent mismatch');
    }
  }
  for (const phase of Object.values(phases)) {
    if (phase && Object.hasOwn(phase, 'owner') && phase.owner !== bundle.owner) {
      throw new Error('phase owner mismatch');
    }
    if (phase && Object.hasOwn(phase, 'agent') && phase.agent !== bundle.agent) {
      throw new Error('phase agent mismatch');
    }
  }
  for (const phase of BASE_RECOVERY_PHASES) {
    const latest = [...events].reverse().find((event) => event.phase === phase);
    if (phases[phase] && (!latest || !projectionEquivalent(phases[phase], latest))) {
      throw new Error(`phase projection ${phase} disagrees with event head`);
    }
    if (!phases[phase] && latest) throw new Error(`phase projection ${phase} is missing`);
  }
  rejectSensitive(bundle);
  return Object.freeze({
    ...bundle,
    identity,
    intent,
    phases: Object.freeze(phases),
    events: Object.freeze(events),
  });
}

function manual() {
  return { action: 'manual-review', phase: null, reasonCode: 'base-manual-review' };
}

function result(action, reasonCode) {
  return { action, phase: action === 'no-movement' || action === 'complete'
    || action === 'owner-action-required' || action === 'manual-review' ? null : ACTION_PHASE.get(action), reasonCode };
}

function phaseEntries(bundle) {
  return Object.fromEntries(BASE_RECOVERY_PHASES.map((phase) => [phase, bundle.phases[phase]]));
}

function hasEvidence(entry, key) {
  return entry?.evidence && Object.hasOwn(entry.evidence, key)
    && entry.evidence[key] !== null && entry.evidence[key] !== '';
}

function valueOf(bundle, key) {
  const values = [];
  for (const event of bundle.events) if (hasEvidence(event, key)) values.push(event.evidence[key]);
  for (const entry of Object.values(bundle.phases)) if (hasEvidence(entry, key)) values.push(entry.evidence[key]);
  const unique = [...new Set(values.map(String))];
  return unique.length > 1 ? { conflict: true } : { value: unique[0] ?? null };
}

function confirmed(bundle, phase) {
  return bundle.phases[phase]?.state === 'confirmed';
}

function safeHandle(entry) {
  return hasEvidence(entry, 'userOpHash') || hasEvidence(entry, 'reconcileHandle');
}

function sameEvidenceFacts(left, right, fields) {
  return fields.every((field) => left?.evidence?.[field] === right?.evidence?.[field]);
}

function kernelCustody(entry) {
  return entry?.evidence?.custodyLocation === 'base-kernel'
    || entry?.evidence?.kernelCustodyConfirmed === true
    || (entry?.evidence?.custody?.location === 'base-kernel'
      && entry.evidence.custody.confirmed === true);
}

function exactDeposit(bundle, entry) {
  const evidence = entry?.evidence;
  const event = evidence?.event;
  const router = evidence?.yieldRouterAddress ?? evidence?.yieldRouter;
  if (!evidence || !event || !EVM_HASH.test(evidence.userOpHash || '')
      || !EVM_HASH.test(evidence.transactionHash || '')
      || !EVM_ADDRESS.test(router || '')
      || router.toLowerCase() !== evidence.event.address?.toLowerCase()
      || evidence.caller !== bundle.intent.kernelAddress
      || evidence.poolAddress !== bundle.intent.poolAddress
      || !DECIMAL.test(evidence.assets || '') || evidence.assets !== bundle.intent.units
      || !DECIMAL.test(evidence.minShares || '') || evidence.minShares !== bundle.intent.minShares
      || !DECIMAL.test(event.shares || '') || BigInt(event.shares) <= 0n
      || BigInt(event.shares) < BigInt(bundle.intent.minShares)
      || event.caller !== evidence.caller
      || event.poolAddress !== bundle.intent.poolAddress
      || event.assets !== evidence.assets
      || event.shares !== evidence.shares
      || !EVM_HASH.test(event.topic0 || '')
      || typeof event.logIndex !== 'string' || !DECIMAL.test(event.logIndex)) return false;
  return true;
}

/** Pure, total Base-only selector. It never returns a money-moving burn/pull/withdraw action. */
export function selectBaseChildRecoveryAction(input) {
  try {
    const bundle = validateBaseRecoveryBundle(input);
    const phases = phaseEntries(bundle);
    const hasEvents = bundle.events.length > 0;
    if (!hasEvents) return result('no-movement', 'base-no-movement', 'No Base movement is confirmed');

    for (const key of [
      'burnTxHash', 'expectationDigest', 'burnUnits7', 'messageDigest', 'attestationDigest', 'mintTxHash',
      'userOpHash', 'transactionHash', 'nonce', 'nonceHex',
    ]) {
      if (valueOf(bundle, key).conflict) return manual('base-conflicting-evidence');
    }

    const burn = phases.cctp_burn;
    if (burn?.state === 'failed' || burn?.state === 'blocked') {
      const hasMovementProof = ['burnTxHash', 'messageDigest', 'nonce', 'nonceHex'].some(
        (key) => valueOf(bundle, key).value,
      );
      if (!hasMovementProof && /revert/i.test(String(burn.evidence?.reasonCode ?? ''))) {
        return result('no-movement', 'base-burn-reverted', 'The Base burn definitively reverted');
      }
      return manual('base-burn-conflict');
    }
    if (!confirmed(bundle, 'cctp_burn')) return manual('base-burn-unconfirmed');

    const attestation = phases.cctp_attestation;
    if (!attestation || attestation.state !== 'confirmed') {
      return result('poll-attestation', 'base-attestation-pending', 'CCTP attestation is not confirmed');
    }
    if (!hasEvidence(attestation, 'messageDigest')
        || (attestation.state === 'confirmed' && !hasEvidence(attestation, 'attestationDigest'))) {
      return manual('base-attestation-evidence-missing');
    }
    if (!sameEvidenceFacts(burn, attestation, [
      'burnTxHash', 'expectationDigest', 'messageDigest', 'nonce',
    ])) return manual('base-attestation-facts-mismatch');

    const mint = phases.cctp_mint;
    if (!mint) return result('submit-mint', 'base-attestation-confirmed', 'Attestation is confirmed and mint is not fenced');
    if (mint.state === 'submitting') {
      if (!hasEvidence(mint, 'nonce') && !hasEvidence(mint, 'nonceHex') && !hasEvidence(mint, 'reconcileHandle')) {
        return manual('base-mint-reconcile-handle-missing');
      }
      return result('poll-mint', 'base-mint-submitting', 'Mint submission is fenced and must be reconciled');
    }
    if (mint.state === 'submitted' || mint.state === 'unknown') {
      return result('poll-mint', 'base-mint-pending', 'Mint outcome is not confirmed');
    }
    if (mint.state === 'failed' || mint.state === 'blocked') return manual('base-mint-unreconciled');
    if (mint.state !== 'confirmed' || !hasEvidence(mint, 'mintTxHash')) {
      return manual('base-mint-evidence-missing');
    }
    if (!sameEvidenceFacts(attestation, mint, [
      'burnTxHash', 'expectationDigest', 'messageDigest', 'attestationDigest', 'nonce',
    ])) return manual('base-mint-facts-mismatch');

    const deposit = phases.base_deposit;
    if (!deposit) return result('submit-base-deposit', 'base-mint-confirmed', 'Mint is confirmed and Base deposit is not fenced');
    if (deposit.state === 'submitting' || deposit.state === 'submitted' || deposit.state === 'unknown') {
      if (!safeHandle(deposit)) return manual('base-deposit-reconcile-handle-missing');
      return result('poll-base-deposit', 'base-deposit-pending', 'Base deposit is fenced and must be reconciled');
    }
    if (deposit.state === 'failed' || deposit.state === 'blocked') {
      const ownerCustody = kernelCustody(deposit);
      const definitiveProof = hasEvidence(deposit, 'transactionHash') || hasEvidence(deposit, 'userOpHash');
      const mandateInactive = /mandate[_-]?inactive/i.test(String(deposit.evidence?.reasonCode ?? ''));
      if (ownerCustody && ((deposit.state === 'failed' && definitiveProof)
        || (deposit.state === 'blocked' && mandateInactive))) {
        return result('owner-action-required', 'base-deposit-failed-kernel-custody', 'Kernel custody requires owner action');
      }
      return manual('base-deposit-failure-unproved');
    }
    if (deposit.state === 'confirmed') {
      if (!exactDeposit(bundle, deposit)) return manual('base-deposit-proof-invalid');
      return result('complete', 'base-deposit-confirmed', 'Base deposit is exactly confirmed');
    }
    return manual('base-deposit-state-invalid');
  } catch (error) {
    return manual('base-malformed-evidence', error?.message || 'Base recovery evidence is malformed');
  }
}

export function computeBaseRecoveryWorkId({ identity, evidenceVersion, action }) {
  const validatedIdentity = validateIdentity(identity);
  validateRecoveryIdentityMapping(validatedIdentity);
  requireSafeInteger(evidenceVersion, 'evidenceVersion');
  if (!ACTION_SET.has(action)) throw new Error('Base recovery action is invalid');
  const tuple = IDENTITY_FIELDS.map((field) => validatedIdentity[field]);
  tuple.push(evidenceVersion, action);
  return createHash('sha256')
    .update(`vf-base-recovery-work/v1\n${JSON.stringify(tuple)}`)
    .digest('hex');
}

export function validateBaseRecoveryRequest(request) {
  exactObject(request, new Set(['mandateId', 'identity', 'action', 'evidenceVersion', 'leaseToken']), 'farm recovery');
  const mandateId = requireText(request.mandateId, 'mandateId');
  if (!/^[0-9a-f]{32}$/.test(mandateId)) throw new Error('mandateId is invalid');
  const identity = validateIdentity(request.identity);
  validateRecoveryIdentityMapping(identity);
  if (!ACTION_SET.has(request.action)) throw new Error('Base recovery action is invalid');
  requireSafeInteger(request.evidenceVersion, 'evidenceVersion');
  if (!LOWER_TOKEN.test(request.leaseToken || '')) throw new Error('leaseToken is invalid');
  rejectSensitive(request);
  return Object.freeze({ ...request, identity });
}

const OPERATION_BY_ACTION = Object.freeze({
  'poll-attestation': 'pollAttestation',
  'submit-mint': 'submitMint',
  'poll-mint': 'pollMint',
  'submit-base-deposit': 'submitBaseDeposit',
  'poll-base-deposit': 'pollBaseDeposit',
});
const RECOVERY_CLAIM_FIELDS = new Set([
  'ok', 'identity', 'action', 'phase', 'reasonCode', 'evidenceVersion', 'lease', 'bundle',
]);
const RECOVERY_LEASE_FIELDS = new Set([
  'identity', 'owner', 'action', 'phase', 'evidenceVersion', 'holder',
  'leaseToken', 'acquiredAt', 'expiresAt',
]);

class BaseRecoveryClaimConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaseRecoveryClaimConflictError';
    this.code = 'RECOVERY_CLAIM_CONFLICT';
  }
}

function validateAuthoritativeRecoveryClaim(claim, record, claimToken, at) {
  try {
    exactObject(claim, RECOVERY_CLAIM_FIELDS, 'Base recovery claim');
    if (claim.ok !== true || claim.action !== record.action
        || claim.evidenceVersion !== record.evidenceVersion
        || typeof claim.reasonCode !== 'string' || !claim.reasonCode) {
      throw new Error('claim action/version/reason is not exact');
    }
    const identity = validateIdentity(claim.identity, 'Base recovery claim identity');
    if (!sameIdentity(identity, record.identity)) throw new Error('claim identity disagrees with work');
    const expectedPhase = ACTION_PHASE.get(record.action);
    if (claim.phase !== expectedPhase) throw new Error('claim phase disagrees with action');
    const bundle = validateBaseRecoveryBundle(claim.bundle);
    if (!sameIdentity(bundle.identity, record.identity)
        || bundle.recoveryVersion !== record.evidenceVersion) {
      throw new Error('claim bundle identity/version disagrees with work');
    }
    exactObject(claim.lease, RECOVERY_LEASE_FIELDS, 'Base recovery claim lease');
    const leaseIdentity = validateIdentity(claim.lease.identity, 'Base recovery lease identity');
    if (!sameIdentity(leaseIdentity, record.identity)
        || claim.lease.owner !== bundle.owner
        || claim.lease.action !== record.action
        || claim.lease.phase !== expectedPhase
        || claim.lease.evidenceVersion !== record.evidenceVersion
        || claim.lease.leaseToken !== claimToken) {
      throw new Error('claim lease identity/version/token disagrees with work');
    }
    if (typeof claim.lease.holder !== 'string' || !claim.lease.holder
        || claim.lease.holder.length > 128
        || typeof claim.lease.owner !== 'string' || !claim.lease.owner
        || !LOWER_TOKEN.test(claim.lease.leaseToken)
        || !Number.isSafeInteger(claim.lease.acquiredAt)
        || !Number.isSafeInteger(claim.lease.expiresAt)
        || claim.lease.acquiredAt < 0 || claim.lease.expiresAt <= at
        || claim.lease.acquiredAt > claim.lease.expiresAt) {
      throw new Error('claim lease timing/token is invalid');
    }
    return Object.freeze({ ...claim, identity, bundle });
  } catch (error) {
    if (error instanceof BaseRecoveryClaimConflictError) throw error;
    throw new BaseRecoveryClaimConflictError(error?.message || 'Base recovery claim is not authoritative');
  }
}

/**
 * Build a narrow executor around injected Task 8/10 seams. The module itself cannot construct a
 * route, choose an amount, or produce signing material. Poll actions invoke only their read/confirm
 * seam; the deposit submit action is separately gated by a fresh mandate evaluator.
 */
export function createBaseRecoveryExecutor({
  workStore,
  reporter,
  operations = {},
  freshActiveMandateGate = async () => ({ active: false }),
  localRecoveryGuard = async () => ({ valid: true }),
  now = () => Date.now(),
  leaseMs = 30_000,
} = {}) {
  if (!workStore || typeof workStore.get !== 'function' || typeof workStore.claim !== 'function'
      || typeof workStore.heartbeat !== 'function' || typeof workStore.finish !== 'function') {
    throw new Error('Base recovery work store is unavailable');
  }
  if (!reporter || typeof reporter.readBaseRecoveryClaim !== 'function'
      || typeof reporter.renewBaseRecoveryClaim !== 'function') {
    throw new Error('Base recovery reporter is unavailable');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('Base recovery lease is invalid');

  async function run(workId, { claim = null } = {}) {
    const record = workStore.get(workId);
    if (!record || ['done', 'uncertain', 'blocked', 'owner_action_required'].includes(record.state)) {
      return record || null;
    }
    const local = workStore.claim({ workId, holder: `recovery-${workId.slice(0, 12)}`, now: now(), leaseMs });
    if (!local) return workStore.get(workId);
    let authoritative = claim;
    let heartbeatTimer = null;
    let leaseLost = false;
    const claimToken = record.claimToken ?? workStore.getClaimToken?.(workId);
    const releaseRemoteClaim = async () => {
      if (typeof reporter.releaseBaseRecoveryClaim !== 'function'
          || typeof claimToken !== 'string' || !claimToken) return;
      try {
        await reporter.releaseBaseRecoveryClaim({
          identity: record.identity,
          action: record.action,
          evidenceVersion: record.evidenceVersion,
          leaseToken: claimToken,
        });
      } catch {
        // A remote release is best effort. Durable Task 8/10 checkpoints and the local work
        // lease remain authoritative when the Agent Index is unavailable.
      }
    };
    try {
      if (!authoritative) {
        if (typeof claimToken !== 'string' || !claimToken) {
          throw new Error('fresh Base recovery claim proof is required');
        }
        authoritative = await reporter.readBaseRecoveryClaim({
          identity: record.identity,
          action: record.action,
          evidenceVersion: record.evidenceVersion,
          leaseToken: claimToken,
        });
      }
      authoritative = validateAuthoritativeRecoveryClaim(
        authoritative, record, claimToken, now(),
      );
      const selection = selectBaseChildRecoveryAction(authoritative.bundle);
      if (selection.action !== record.action || selection.phase !== authoritative.phase) {
        return workStore.finish({
          workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
          state: 'blocked', reasonCode: 'base-recovery-selection-changed', now: now(),
        });
      }
      if (typeof claimToken !== 'string' || !claimToken) {
        throw new Error('fresh Base recovery claim proof is required');
      }
      const renewAuthority = async () => {
        if (leaseLost) {
          throw Object.assign(new Error('Base recovery lease is no longer authoritative'), {
            code: 'RECOVERY_LEASE_CONFLICT',
          });
        }
        try {
          // This callback is deliberately a single, explicit fence check. Send-capable
          // operations invoke it after their own durable Task 8/10 submitting checkpoint and
          // immediately before the external send, so a lease lost in that window means zero send.
          await reporter.renewBaseRecoveryClaim({
            identity: record.identity,
            action: record.action,
            evidenceVersion: record.evidenceVersion,
            holder: authoritative.lease?.holder,
            leaseToken: claimToken,
          });
          const renewed = workStore.heartbeat({
            workId, holder: local.leaseOwner, leaseToken: local.leaseToken, now: now(), leaseMs,
          });
          if (!renewed) {
            throw Object.assign(new Error('local Base recovery lease is stale'), {
              code: 'RECOVERY_LEASE_CONFLICT',
            });
          }
          return renewed;
        } catch (error) {
          leaseLost = true;
          throw error;
        }
      };
      await renewAuthority();
      const renewLeases = async () => {
        await renewAuthority();
      };
      heartbeatTimer = setInterval(() => {
        if (leaseLost) return;
        renewLeases().catch(() => { leaseLost = true; });
      }, Math.max(1, Math.floor(leaseMs / 3)));
      heartbeatTimer?.unref?.();
      if (leaseLost) {
        return typeof workStore.hold === 'function'
          ? workStore.hold({
            workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
            reasonCode: 'base-recovery-lease-unavailable', now: now(),
          })
          : workStore.get(workId);
      }
      // Re-read local farm/mandate linkage before every operation, including a revoked-mandate
      // owner-action projection. A stale/mutated local intent must never turn into a public
      // terminal result or reach a Task 8/10 seam.
      let localAuthority;
      try {
        localAuthority = await localRecoveryGuard(authoritative.bundle, record);
      } catch {
        return typeof workStore.hold === 'function'
          ? workStore.hold({
            workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
            reasonCode: 'base-recovery-local-authority-retryable', now: now(),
          })
          : workStore.get(workId);
      }
      if (!localAuthority || localAuthority.valid !== true) {
        return workStore.finish({
          workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
          state: 'blocked', reasonCode: 'base-recovery-local-authority-conflict', now: now(),
        });
      }
      if (record.action === 'submit-base-deposit') {
        let gate;
        try {
          gate = await freshActiveMandateGate(authoritative.bundle, record);
        } catch {
          return typeof workStore.hold === 'function'
            ? workStore.hold({
              workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
              reasonCode: 'base-recovery-authority-retryable', now: now(),
            })
            : workStore.get(workId);
        }
        if (!gate || gate.active !== true) {
          if (typeof operations.projectBaseDepositOwnerAction === 'function') {
            let projection;
            try {
              projection = await operations.projectBaseDepositOwnerAction({
                bundle: authoritative.bundle,
                identity: record.identity,
                evidenceVersion: record.evidenceVersion,
                action: record.action,
                work: record,
                reasonCode: 'mandate_inactive',
              });
            } catch {
              projection = { state: 'held', reasonCode: 'base-deposit-owner-action-projection-retryable' };
            }
            if (projection?.state === 'held' || projection?.state === 'retryable') {
              return workStore.hold({
                workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
                reasonCode: projection.reasonCode ?? 'base-deposit-owner-action-projection-retryable', now: now(),
              }) ?? workStore.get(workId);
            }
          }
          return workStore.finish({
            workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
            state: 'owner_action_required', reasonCode: 'mandate_inactive', now: now(),
          });
        }
      }
      if (leaseLost) {
        return typeof workStore.hold === 'function'
          ? workStore.hold({
            workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
            reasonCode: 'base-recovery-lease-unavailable', now: now(),
          })
          : workStore.get(workId);
      }
      const operationName = OPERATION_BY_ACTION[record.action];
      const operation = operations[operationName];
      if (typeof operation !== 'function') {
        return workStore.finish({
          workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
          state: 'blocked', reasonCode: 'safe-operation-unavailable', now: now(),
        });
      }
      const operationResult = await operation({
        bundle: authoritative.bundle,
        identity: record.identity,
        evidenceVersion: record.evidenceVersion,
        action: record.action,
        work: record,
        renewAuthority,
      });
      if (['held', 'retryable'].includes(operationResult?.state)
          && typeof workStore.hold === 'function') {
        return workStore.hold({
          workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
          reasonCode: operationResult.reasonCode ?? 'base-recovery-held', now: now(),
        }) ?? workStore.get(workId);
      }
      const nextState = leaseLost
        ? 'uncertain'
        : ['uncertain', 'blocked', 'owner_action_required', 'done'].includes(operationResult?.state)
          ? operationResult.state
          : 'done';
      return workStore.finish({
        workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
        state: nextState, reasonCode: operationResult?.reasonCode ?? null,
        checkpointRef: operationResult?.checkpointRef ?? null, now: now(),
      });
    } catch (error) {
      try {
        if (typeof workStore.hold === 'function'
            && ['RECOVERY_CONFLICT', 'RECOVERY_VERSION_CONFLICT', 'RECOVERY_LEASE_CONFLICT',
              'REPORTER_RETRYABLE', 'RECOVERY_CLAIM_CONFLICT'].includes(error?.code)) {
          return workStore.hold({
            workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
            reasonCode: error?.code === 'RECOVERY_CLAIM_CONFLICT'
              ? 'base-recovery-claim-conflict' : 'base-recovery-lease-unavailable', now: now(),
          }) ?? workStore.get(workId);
        }
        return workStore.finish({
          workId, holder: local.leaseOwner, leaseToken: local.leaseToken,
          state: 'uncertain', reasonCode: 'base-recovery-executor-error', now: now(),
        });
      } catch {
        return workStore.get(workId);
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await releaseRemoteClaim();
    }
  }

  return Object.freeze({ run });
}
