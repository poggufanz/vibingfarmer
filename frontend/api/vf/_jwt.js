// Minimal HS256 compact JWT over WebCrypto — no new dependency for one algorithm.

const enc = new TextEncoder()

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const b64uJson = (obj) => b64u(enc.encode(JSON.stringify(obj)))

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

export async function signJwt(payload, secret, ttlSec) {
  const iat = Math.floor(Date.now() / 1000)
  const body = { ...payload, iat, exp: iat + ttlSec }
  const head = b64uJson({ alg: 'HS256', typ: 'JWT' })
  const data = `${head}.${b64uJson(body)}`
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data))
  return `${data}.${b64u(sig)}`
}

export async function verifyJwt(token, secret, nowMs = Date.now()) {
  try {
    const [h, p, s] = String(token).split('.')
    if (!h || !p || !s) return null
    const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : ''
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad), (c) =>
      c.charCodeAt(0)
    )
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      sig,
      enc.encode(`${h}.${p}`)
    )
    if (!ok) return null
    const payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof payload.exp !== 'number' || nowMs / 1000 > payload.exp) return null
    return payload
  } catch {
    return null
  }
}
