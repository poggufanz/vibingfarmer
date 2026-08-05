import { describe, it, expect } from 'vitest';
import { createSecretEnvelope, parseSecretKeyring } from '../src/secretEnvelope.mjs';

const ACTIVE_KEY = Buffer.alloc(32, 0x11);
const PREVIOUS_KEY = Buffer.alloc(32, 0x22);

function keyring(entries = [
  ['2026-08', ACTIVE_KEY],
  ['2026-07', PREVIOUS_KEY],
]) {
  return parseSecretKeyring(entries.map(([kid, key]) => `${kid}:${key.toString('base64')}`).join(','));
}

describe('parseSecretKeyring', () => {
  it('parses comma-separated 32-byte base64 keys and makes the first key active', () => {
    const parsed = keyring();

    expect(parsed.activeKeyId).toBe('2026-08');
    expect(parsed.keys.get('2026-08')).toEqual(ACTIVE_KEY);
    expect(parsed.keys.get('2026-07')).toEqual(PREVIOUS_KEY);
  });

  it.each([
    ['', 'an empty keyring'],
    ['missing-colon', 'an entry without a key separator'],
    ['same:not-base64,same:not-base64', 'duplicate key IDs'],
    [`short:${Buffer.alloc(31).toString('base64')}`, 'a key that is not 32 bytes'],
    [`bad key:${ACTIVE_KEY.toString('base64')}`, 'a malformed key ID'],
  ])('rejects %s', (raw) => {
    expect(() => parseSecretKeyring(raw)).toThrow(/RELAYER_SESSION_KEY_ENCRYPTION_KEYS/i);
  });
});

describe('createSecretEnvelope', () => {
  it('round-trips UTF-8 plaintext with authenticated UTF-8 AAD', () => {
    const cipher = createSecretEnvelope(keyring());
    const envelope = cipher.seal('session-private-key-秘密', 'mandate:123');

    expect(envelope).toMatch(/^v1\.2026-08\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cipher.open(envelope, 'mandate:123')).toEqual({
      plaintext: 'session-private-key-秘密',
      needsRotation: false,
    });
  });

  it('uses a fresh random IV for every encryption', () => {
    const cipher = createSecretEnvelope(keyring());

    expect(cipher.seal('same secret', 'same aad')).not.toBe(cipher.seal('same secret', 'same aad'));
  });

  it.each([
    (envelope) => envelope.replace(/.$/, envelope.endsWith('A') ? 'B' : 'A'),
    (envelope) => {
      const parts = envelope.split('.');
      parts[3] = parts[3].endsWith('A') ? `${parts[3].slice(0, -1)}B` : `${parts[3].slice(0, -1)}A`;
      return parts.join('.');
    },
    () => 'v2.2026-08.not-an-iv.not-a-tag.not-a-ciphertext',
    () => 'v1.2026-08.bad.bad.bad.extra',
  ])('rejects tampered or malformed envelopes', (tamper) => {
    const cipher = createSecretEnvelope(keyring());
    const envelope = cipher.seal('private material', 'bound aad');

    expect(() => cipher.open(tamper(envelope), 'bound aad')).toThrow(/encrypted session key envelope/i);
  });

  it('rejects an envelope when its AAD has changed', () => {
    const cipher = createSecretEnvelope(keyring());
    const envelope = cipher.seal('private material', 'bound aad');

    expect(() => cipher.open(envelope, 'other aad')).toThrow(/encrypted session key envelope/i);
  });

  it('decrypts an envelope sealed with a previous key and requests rotation', () => {
    const oldOnly = createSecretEnvelope(keyring([['2026-07', PREVIOUS_KEY]]));
    const activeCipher = createSecretEnvelope(keyring());
    const oldEnvelope = oldOnly.seal('old private material', 'mandate:old');

    expect(activeCipher.open(oldEnvelope, 'mandate:old')).toEqual({
      plaintext: 'old private material',
      needsRotation: true,
    });
  });

  it('does not reveal plaintext or key material in errors', () => {
    const cipher = createSecretEnvelope(keyring());
    const plaintext = 'private-session-key-never-log';
    const key = ACTIVE_KEY.toString('base64');
    const envelope = cipher.seal(plaintext, 'bound aad');
    const tampered = envelope.replace(/.$/, envelope.endsWith('A') ? 'B' : 'A');

    try {
      cipher.open(tampered, 'bound aad');
      throw new Error('expected envelope opening to fail');
    } catch (error) {
      expect(error.message).not.toContain(plaintext);
      expect(error.message).not.toContain(key);
    }
  });
});
