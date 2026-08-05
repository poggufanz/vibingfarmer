import { describe, expect, it } from 'vitest';
import {
  capabilityMatches,
  clearMandateCapabilityCookie,
  hashCapability,
  mandateCookieName,
  parseBearerCapability,
  requireCapability,
  requireMandateId,
  serializeMandateCapabilityCookie,
} from '../src/capability.mjs';

const MANDATE_ID = '0123456789abcdef0123456789abcdef';
const CAPABILITY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CAPABILITY_HASH = 'a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e';

function errorText(action) {
  try {
    action();
  } catch (error) {
    return String(error?.message ?? error);
  }
  throw new Error('expected action to throw');
}

describe('mandate capability boundary', () => {
  // Catches accepting non-canonical IDs that could select a different durable mandate.
  it.each([
    ['missing', undefined],
    ['uppercase', MANDATE_ID.toUpperCase()],
    ['short', MANDATE_ID.slice(0, -1)],
    ['non-hex', `${MANDATE_ID.slice(0, -1)}g`],
    ['surrounding whitespace', ` ${MANDATE_ID}`],
    ['array', [MANDATE_ID]],
  ])('rejects a %s mandate ID without reflecting it', (_label, value) => {
    const message = errorText(() => requireMandateId(value));

    if (typeof value === 'string') expect(message).not.toContain(value);
    expect(message).not.toContain(MANDATE_ID);
  });

  // Catches normalizing mandate IDs instead of preserving their one canonical representation.
  it('returns a canonical mandate ID unchanged', () => {
    expect(requireMandateId(MANDATE_ID)).toBe(MANDATE_ID);
  });

  // Catches accepting attacker-controlled or shortened bearer secrets as capabilities.
  it.each([
    ['missing', undefined],
    ['uppercase', CAPABILITY.toUpperCase()],
    ['short', CAPABILITY.slice(0, -1)],
    ['non-hex', `${CAPABILITY.slice(0, -1)}g`],
    ['surrounding whitespace', ` ${CAPABILITY}`],
    ['array', [CAPABILITY]],
  ])('rejects a %s capability without reflecting it', (_label, value) => {
    const message = errorText(() => requireCapability(value));

    if (typeof value === 'string') expect(message).not.toContain(value);
    expect(message).not.toContain(CAPABILITY);
  });

  // Catches case folding or alteration of an authentication secret before durable hashing.
  it('returns a canonical capability unchanged', () => {
    expect(requireCapability(CAPABILITY)).toBe(CAPABILITY);
  });

  // Catches a non-SHA-256 or non-lowercase capability digest being stored for authentication.
  it('hashes a canonical capability to the independently derived SHA-256 fixture', () => {
    expect(hashCapability(CAPABILITY)).toBe(CAPABILITY_HASH);
  });

  // Catches hashing malformed input rather than rejecting it at the authentication boundary.
  it.each([CAPABILITY.toUpperCase(), CAPABILITY.slice(1), `${CAPABILITY.slice(0, -1)}g`])(
    'refuses to hash malformed capabilities',
    (value) => {
      expect(() => hashCapability(value)).toThrow();
    },
  );

  // Catches permissive authorization parsing, including proxy/header-merge variants.
  it.each([
    ['missing', undefined],
    ['lowercase scheme', `bearer ${CAPABILITY}`],
    ['uppercase scheme', `BEARER ${CAPABILITY}`],
    ['leading whitespace', ` Bearer ${CAPABILITY}`],
    ['trailing whitespace', `Bearer ${CAPABILITY} `],
    ['double spaces', `Bearer  ${CAPABILITY}`],
    ['tab separator', `Bearer\t${CAPABILITY}`],
    ['second token', `Bearer ${CAPABILITY} extra`],
    ['array/repeated header', [`Bearer ${CAPABILITY}`, `Bearer ${CAPABILITY}`]],
    ['malformed secret', `Bearer ${CAPABILITY.toUpperCase()}`],
  ])('rejects %s bearer authorization', (_label, header) => {
    expect(parseBearerCapability(header)).toBeNull();
  });

  // Catches accepting canonical credentials only after an unsafe header normalization.
  it('parses one exact Bearer capability', () => {
    expect(parseBearerCapability(`Bearer ${CAPABILITY}`)).toBe(CAPABILITY);
  });

  // Catches variable-length timing comparisons or exceptions from malformed candidate/hash input.
  it.each([
    ['matching canonical secret and digest', CAPABILITY, CAPABILITY_HASH, true],
    ['wrong same-length secret', `f${CAPABILITY.slice(1)}`, CAPABILITY_HASH, false],
    ['short secret', CAPABILITY.slice(1), CAPABILITY_HASH, false],
    ['uppercase secret', CAPABILITY.toUpperCase(), CAPABILITY_HASH, false],
    ['short expected hash', CAPABILITY, CAPABILITY_HASH.slice(1), false],
    ['uppercase expected hash', CAPABILITY, CAPABILITY_HASH.toUpperCase(), false],
    ['non-hex expected hash', CAPABILITY, `${CAPABILITY_HASH.slice(0, -1)}g`, false],
    ['missing expected hash', CAPABILITY, undefined, false],
  ])('matches %s safely', (_label, capability, expectedHash, expected) => {
    expect(() => capabilityMatches(capability, expectedHash)).not.toThrow();
    expect(capabilityMatches(capability, expectedHash)).toBe(expected);
  });

  // Catches a cookie name that does not bind browser authority to its canonical mandate ID.
  it('builds the only allowed host cookie name', () => {
    expect(mandateCookieName(MANDATE_ID)).toBe(`__Host-vf-mandate-${MANDATE_ID}`);
  });

  // Catches insecure cookie attributes or accidental Domain scoping, including on localhost.
  it('serializes the canonical host-only capability cookie exactly', () => {
    expect(serializeMandateCapabilityCookie({
      mandateId: MANDATE_ID,
      capability: CAPABILITY,
      maxAgeSeconds: 4319,
    })).toBe(`__Host-vf-mandate-${MANDATE_ID}=${CAPABILITY}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=4319`);
  });

  // Catches expired, fractional, or coerced lifetimes that can extend browser-held authority.
  it.each([0, -1, 1.5, Number.NaN, '60', undefined])(
    'rejects non-positive or non-integer cookie max age %p',
    (maxAgeSeconds) => {
      expect(() => serializeMandateCapabilityCookie({
        mandateId: MANDATE_ID,
        capability: CAPABILITY,
        maxAgeSeconds,
      })).toThrow();
    },
  );

  // Catches a clear operation that leaves a differently scoped authentication cookie behind.
  it('clears the same host-only cookie with exactly Max-Age=0', () => {
    expect(clearMandateCapabilityCookie({ mandateId: MANDATE_ID }))
      .toBe(`__Host-vf-mandate-${MANDATE_ID}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  });
});
