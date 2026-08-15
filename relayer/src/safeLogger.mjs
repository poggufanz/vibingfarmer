// Operational logging boundary for the relayer.  Callers provide stable event codes and, at
// most, a small allow-listed set of public counters/identifiers.  Error objects and arbitrary
// request/provider values are intentionally opaque here; this module must remain safe even when
// a future caller accidentally hands it a circular object or a hostile provider error.

const CODE_RE = /^[A-Z][A-Z0-9]*(?:[._-][A-Z0-9]+)*$/;
const LOWER_CODE_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ID_RE = /^[0-9a-f]{32}$/;
const MAX_CODE_LENGTH = 64;
const MAX_DETAILS = 12;
const MAX_STRING = 128;
const SECRET_MARKER_RE = /(secret|private|plaintext|authorization|cookie|session|password|bearer|token|credential|provider)/i;
const SAFE_KEYS = new Set([
  'action', 'active', 'attempts', 'code', 'component', 'count', 'cursor', 'drained',
  'durationMs', 'id', 'jobId', 'limit', 'mandateId', 'method', 'migrated', 'pending',
  'phase', 'port', 'reasonCode', 'size', 'state', 'status', 'total', 'worker',
]);
const CLOSED_VALUES = Object.freeze({
  action: new Set(['cleanup', 'migrate', 'resume', 'start', 'stop']),
  component: new Set(['http', 'migration', 'queue', 'relayer', 'rpc', 'sqlite']),
  method: new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']),
  phase: new Set(['cctp_attestation', 'cctp_mint', 'base_deposit', 'recovery']),
  state: new Set(['done', 'error', 'failed', 'held', 'pending', 'recovery', 'running', 'stopped']),
  status: new Set(['active', 'dead', 'delivered', 'done', 'error', 'failed', 'pending', 'running', 'stopped']),
  worker: new Set(['association', 'base-evidence', 'base-recovery', 'mandate-activation', 'unwind']),
});

function safeCode(value, { lower = false } = {}) {
  const pattern = lower ? LOWER_CODE_RE : CODE_RE;
  return typeof value === 'string'
    && value.length <= MAX_CODE_LENGTH
    && pattern.test(value)
    && !SECRET_MARKER_RE.test(value);
}

function stableCode(value) {
  if (safeCode(value)) {
    return value;
  }
  return 'UNSPECIFIED_EVENT';
}

function safeValue(key, value) {
  if (!SAFE_KEYS.has(key)) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000) {
    return value;
  }
  if (typeof value !== 'string' || value.length > MAX_STRING || SECRET_MARKER_RE.test(value)) {
    return undefined;
  }
  if (key === 'jobId' || key === 'mandateId' || key === 'id') {
    return ID_RE.test(value) ? value : undefined;
  }
  if (key === 'code') {
    return safeCode(value) ? value : undefined;
  }
  if (CLOSED_VALUES[key]) {
    return CLOSED_VALUES[key].has(value) ? value : undefined;
  }
  if (key === 'reasonCode') {
    return safeCode(value, { lower: true }) ? value : undefined;
  }
  return undefined;
}

export function sanitizePublicMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Error) return {};
  const output = {};
  let count = 0;
  for (const key of Object.keys(value)) {
    if (count >= MAX_DETAILS) break;
    const safe = safeValue(key, value[key]);
    if (safe === undefined) continue;
    output[key] = safe;
    count += 1;
  }
  return output;
}

/** Return a JSON-safe, closed-shape representation suitable for status/evidence snapshots. */
export function safeSerialize(value) {
  return JSON.stringify(sanitizePublicMetadata(value));
}

function defaultSink(level, event) {
  const method = typeof console?.[level] === 'function' ? console[level] : console.log;
  method.call(console, JSON.stringify(event));
}

export function createSafeLogger({ sink, debug = false, mode = 'development' } = {}) {
  if (debug && (mode === 'production' || mode === 'staging')) {
    throw new Error('safe logger debug mode is unavailable in production');
  }
  const emit = typeof sink === 'function'
    ? sink
    : (event) => defaultSink(event.level, event);
  function log(level, code, details) {
    const event = Object.freeze({
      level,
      code: stableCode(code),
      details: Object.freeze(sanitizePublicMetadata(details)),
    });
    try {
      emit(event);
    } catch {
      // Logging must never take down the relayer or cause a second unsafe error path.
    }
    return event;
  }
  return Object.freeze({
    info(code, details) { return log('info', code, details); },
    warn(code, details) { return log('warn', code, details); },
    error(code, details) { return log('error', code, details); },
  });
}

export const createDefaultSafeLogger = (options = {}) => createSafeLogger(options);
