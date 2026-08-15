import { StrKey } from '@stellar/stellar-sdk'

export const OWNER_READ_CURSOR_TTL_MS = 15 * 60_000

const PAYLOAD_KEYS = [
  'version',
  'networkId',
  'owner',
  'manifestHash',
  'snapshotThroughLedger',
  'afterLedger',
  'afterAddress',
  'expiresAt',
]
const EXPECTED_SCOPE_KEYS = new Set([
  'networkId',
  'owner',
  'manifestHash',
  'snapshotThroughLedger',
  'afterLedger',
  'afterAddress',
  'expiresAt',
])
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function cursorError() {
  return new Error('Invalid owner read cursor')
}

function validStrKey(value) {
  return (
    typeof value === 'string' &&
    (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))
  )
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function currentTime(now) {
  const value = typeof now === 'function' ? now() : now
  if (!nonNegativeSafeInteger(value)) throw cursorError()
  return value
}

function validatePayload(value, { current, ttlMs, encoding }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw cursorError()
  const keys = Object.keys(value)
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((key) => !PAYLOAD_KEYS.includes(key))) {
    throw cursorError()
  }
  if (
    value.version !== 1 ||
    typeof value.networkId !== 'string' ||
    value.networkId.length === 0 ||
    !validStrKey(value.owner) ||
    typeof value.manifestHash !== 'string' ||
    value.manifestHash.length === 0 ||
    !nonNegativeSafeInteger(value.snapshotThroughLedger) ||
    !nonNegativeSafeInteger(value.afterLedger) ||
    !validStrKey(value.afterAddress) ||
    !nonNegativeSafeInteger(value.expiresAt) ||
    value.expiresAt <= current ||
    (encoding && value.expiresAt > current + ttlMs)
  ) {
    throw cursorError()
  }
  return Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, value[key]]))
}

function validateExpectedScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw cursorError()
  const keys = Object.keys(scope)
  if (keys.some((key) => !EXPECTED_SCOPE_KEYS.has(key))) throw cursorError()
  if (
    typeof scope.networkId !== 'string' ||
    scope.networkId.length === 0 ||
    !validStrKey(scope.owner) ||
    (scope.manifestHash !== undefined &&
      (typeof scope.manifestHash !== 'string' || scope.manifestHash.length === 0)) ||
    (scope.snapshotThroughLedger !== undefined &&
      !nonNegativeSafeInteger(scope.snapshotThroughLedger)) ||
    (scope.afterLedger !== undefined && !nonNegativeSafeInteger(scope.afterLedger)) ||
    (scope.afterAddress !== undefined && !validStrKey(scope.afterAddress)) ||
    (scope.expiresAt !== undefined && !nonNegativeSafeInteger(scope.expiresAt))
  ) {
    throw cursorError()
  }
  return scope
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw cursorError()
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  let binary
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding)
  } catch {
    throw cursorError()
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  if (bytesToBase64Url(bytes) !== value) throw cursorError()
  return bytes
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

export function createOwnerReadCursorCodec({
  secret,
  now = () => Date.now(),
  ttlMs = OWNER_READ_CURSOR_TTL_MS,
}) {
  if (typeof secret !== 'string' || encoder.encode(secret).length < 32) throw cursorError()
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw cursorError()
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw cursorError()
  const keyPromise = subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )

  return {
    async encode(payload) {
      const current = currentTime(now)
      const candidate =
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        !Object.prototype.hasOwnProperty.call(payload, 'expiresAt')
          ? { ...payload, expiresAt: current + ttlMs }
          : payload
      const canonical = validatePayload(candidate, {
        current,
        ttlMs,
        encoding: true,
      })
      const body = encoder.encode(JSON.stringify(canonical))
      const signature = new Uint8Array(await subtle.sign('HMAC', await keyPromise, body))
      return `${bytesToBase64Url(body)}.${bytesToBase64Url(signature)}`
    },

    async decode(token, expectedScope) {
      const scope = validateExpectedScope(expectedScope)
      if (typeof token !== 'string' || token.length > 4096) throw cursorError()
      const parts = token.split('.')
      if (parts.length !== 2) throw cursorError()
      const body = base64UrlToBytes(parts[0])
      const signature = base64UrlToBytes(parts[1])
      if (!(await subtle.verify('HMAC', await keyPromise, signature, body))) throw cursorError()

      let parsed
      try {
        parsed = JSON.parse(decoder.decode(body))
      } catch {
        throw cursorError()
      }
      const payload = validatePayload(parsed, {
        current: currentTime(now),
        ttlMs,
        encoding: false,
      })
      if (!sameBytes(body, encoder.encode(JSON.stringify(payload)))) throw cursorError()
      for (const key of EXPECTED_SCOPE_KEYS) {
        if (scope[key] !== undefined && payload[key] !== scope[key]) throw cursorError()
      }
      return payload
    },
  }
}
