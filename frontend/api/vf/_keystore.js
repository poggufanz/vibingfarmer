// VF key lifecycle. Keys: vf_<env>_ + base62(32 bytes CSPRNG). At rest: SHA-256 hex only.
// Plain SHA-256 (not argon2): 256-bit random keys are un-bruteforceable; slow hashes
// only add per-request latency.

export const SCOPES = ['strategy', 'market', 'tx', 'submit', 'scan']

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// Proper base-62 encoding of the byte array as one big-endian integer.
// 32 bytes (256 bits) → 43 chars; left-pad to `width` so length is deterministic
// (a raw big-int encoding of a value with small leading bytes could be shorter).
function base62(bytes, width) {
  let num = 0n
  for (const b of bytes) num = (num << 8n) | BigInt(b)
  let out = ''
  while (num > 0n) {
    out = B62[Number(num % 62n)] + out
    num /= 62n
  }
  return width ? out.padStart(width, '0') : out || '0'
}

export function generateKey(env) {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `vf_${env}_${base62(bytes, 43)}`
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function issueKey(store, { owner, scopes, rateLimit, env, expiresAt }) {
  const key = generateKey(env)
  const idBytes = new Uint8Array(8)
  crypto.getRandomValues(idBytes)
  const id = `vfk_${base62(idBytes)}`
  const hint = key.slice(0, 12) + '…'
  await store.keys.insert({
    id,
    key_hash: await sha256Hex(key),
    key_hint: hint,
    owner,
    scopes: JSON.stringify(scopes),
    rate_limit: rateLimit,
    expires_at: expiresAt ?? null,
    enabled: 1,
    created_at: Math.floor(Date.now() / 1000),
    last_used_at: null,
  })
  return { id, key, hint }
}

export async function verifyKey(store, plaintext, nowMs = Date.now()) {
  // Well-formedness only (prefix + alphanumeric + plausible length). Real keys are 43
  // chars; keep the floor at 32 so a shorter-but-shaped token is 'unknown', not 'malformed'.
  if (typeof plaintext !== 'string' || !/^vf_(test|live)_[0-9A-Za-z]{32,}$/.test(plaintext)) {
    return { ok: false, reason: 'malformed' }
  }
  const row = await store.keys.getByHash(await sha256Hex(plaintext))
  if (!row) return { ok: false, reason: 'unknown' }
  if (!row.enabled) return { ok: false, reason: 'revoked' }
  if (row.expires_at && nowMs / 1000 > row.expires_at) return { ok: false, reason: 'expired' }
  return { ok: true, keyId: row.id, scopes: JSON.parse(row.scopes), rateLimit: row.rate_limit }
}

export async function revokeKey(store, id, owner) {
  return store.keys.revoke(id, owner)
}
