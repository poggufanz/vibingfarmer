import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const KEYRING_ERROR = 'env RELAYER_SESSION_KEY_ENCRYPTION_KEYS is invalid';
const ENVELOPE_ERROR = 'encrypted session key envelope is invalid';
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function keyringError() {
  return new Error(KEYRING_ERROR);
}

function envelopeError() {
  return new Error(ENVELOPE_ERROR);
}

function decodeBase64Key(value) {
  if (!BASE64.test(value)) throw keyringError();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw keyringError();
  return key;
}

function decodeBase64url(value) {
  if (!BASE64URL.test(value)) throw envelopeError();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw envelopeError();
  return decoded;
}

function envelopeParts(value) {
  if (typeof value !== 'string') throw envelopeError();
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw envelopeError();

  let keyId;
  try {
    keyId = decodeURIComponent(parts[1]);
  } catch {
    throw envelopeError();
  }
  if (!KEY_ID.test(keyId) || encodeURIComponent(keyId) !== parts[1]) throw envelopeError();

  const iv = decodeBase64url(parts[2]);
  const tag = decodeBase64url(parts[3]);
  const ciphertext = decodeBase64url(parts[4]);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw envelopeError();
  return { keyId, iv, tag, ciphertext };
}

function findKey(keys, keyId) {
  const wanted = createHash('sha256').update(keyId, 'utf8').digest();
  let selected;
  for (const [candidateId, candidateKey] of keys) {
    const candidate = createHash('sha256').update(candidateId, 'utf8').digest();
    if (timingSafeEqual(wanted, candidate)) selected = candidateKey;
  }
  return selected;
}

export function parseSecretKeyring(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw keyringError();

  const keys = new Map();
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator !== entry.lastIndexOf(':')) throw keyringError();
    const keyId = entry.slice(0, separator);
    const encodedKey = entry.slice(separator + 1);
    if (!KEY_ID.test(keyId) || keys.has(keyId)) throw keyringError();
    keys.set(keyId, decodeBase64Key(encodedKey));
  }

  const activeKeyId = keys.keys().next().value;
  if (!activeKeyId) throw keyringError();
  return { activeKeyId, keys };
}

export function createSecretEnvelope(keyring) {
  const { activeKeyId, keys } = keyring || {};
  const activeKey = keys instanceof Map ? keys.get(activeKeyId) : undefined;
  if (!KEY_ID.test(activeKeyId || '') || !Buffer.isBuffer(activeKey) || activeKey.length !== 32) {
    throw keyringError();
  }

  return Object.freeze({
    seal(plaintext, aad) {
      if (typeof plaintext !== 'string' || plaintext.length === 0 || typeof aad !== 'string') {
        throw envelopeError();
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', activeKey, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${encodeURIComponent(activeKeyId)}.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
    },

    open(envelope, aad) {
      if (typeof aad !== 'string') throw envelopeError();
      const { keyId, iv, tag, ciphertext } = envelopeParts(envelope);
      const key = findKey(keys, keyId);
      if (!key) throw envelopeError();
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        return { plaintext, needsRotation: keyId !== activeKeyId };
      } catch {
        throw envelopeError();
      }
    },
  });
}
