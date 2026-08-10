import { createHash, timingSafeEqual } from 'node:crypto';

const MANDATE_ID_PATTERN = /^[0-9a-f]{32}$/;
const UNWIND_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;
const CAPABILITY_HASH_PATTERN = /^[0-9a-f]{64}$/;

function invalidCapabilityError() {
  return new Error('invalid mandate capability');
}

function invalidUnwindCapabilityError() {
  return new Error('invalid unwind capability');
}

function isMandateId(value) {
  return typeof value === 'string' && MANDATE_ID_PATTERN.test(value);
}

function isCapability(value) {
  return typeof value === 'string' && CAPABILITY_PATTERN.test(value);
}

function isCapabilityHash(value) {
  return typeof value === 'string' && CAPABILITY_HASH_PATTERN.test(value);
}

export function requireMandateId(value) {
  if (!isMandateId(value)) throw invalidCapabilityError();
  return value;
}

export function requireCapability(value) {
  if (!isCapability(value)) throw invalidCapabilityError();
  return value;
}

export function hashCapability(capability) {
  return createHash('sha256').update(requireCapability(capability), 'utf8').digest('hex');
}

export function capabilityMatches(capability, expectedHash) {
  if (!isCapability(capability) || !isCapabilityHash(expectedHash)) return false;

  const candidateDigest = createHash('sha256').update(capability, 'utf8').digest();
  const expectedDigest = Buffer.from(expectedHash, 'hex');
  return timingSafeEqual(candidateDigest, expectedDigest);
}

export function parseBearerCapability(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;

  const capability = header.slice('Bearer '.length);
  return isCapability(capability) ? capability : null;
}

export function mandateCookieName(mandateId) {
  return `__Host-vf-mandate-${requireMandateId(mandateId)}`;
}

export function requireUnwindJobId(value) {
  if (typeof value !== 'string' || !UNWIND_JOB_ID_PATTERN.test(value)) {
    throw invalidUnwindCapabilityError();
  }
  return value;
}

export function unwindCookieName(jobId) {
  return `__Host-vf-unwind-${requireUnwindJobId(jobId)}`;
}

function requireCookieMaxAgeSeconds(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidCapabilityError();
  return value;
}

function serializeMandateCookie({ mandateId, capability = '', maxAgeSeconds }) {
  const name = mandateCookieName(mandateId);
  return `${name}=${capability}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function serializeMandateCapabilityCookie(input) {
  const { mandateId, capability, maxAgeSeconds } = input ?? {};
  return serializeMandateCookie({
    mandateId,
    capability: requireCapability(capability),
    maxAgeSeconds: requireCookieMaxAgeSeconds(maxAgeSeconds),
  });
}

export function serializeUnwindCapabilityCookie(input) {
  const { jobId, capability, maxAgeSeconds } = input ?? {};
  return `${unwindCookieName(jobId)}=${requireCapability(capability)}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${requireCookieMaxAgeSeconds(maxAgeSeconds)}`;
}

export function clearMandateCapabilityCookie(input) {
  const { mandateId } = input ?? {};
  return serializeMandateCookie({ mandateId, maxAgeSeconds: 0 });
}
