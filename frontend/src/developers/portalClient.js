// Portal HTTP client — session (JWT) side only. The vf_ API key never touches this module.
const base = '/api/vf'

async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
  return body
}

export async function signIn({ account, signChallenge }) {
  const { transaction } = await jfetch(
    `${base}/auth/challenge?account=${encodeURIComponent(account)}`
  )
  const signed = await signChallenge(transaction)
  const { token } = await jfetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: signed }),
  })
  return token
}

const authed = (jwt) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` })

export async function listKeys(jwt) {
  return (await jfetch(`${base}/keys`, { headers: authed(jwt) })).keys
}

export async function createKey(jwt, { scopes, env, rateLimit }) {
  return jfetch(`${base}/keys`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ scopes, env, rateLimit }),
  })
}

export async function revokeKey(jwt, id) {
  return (
    await jfetch(`${base}/keys`, {
      method: 'DELETE',
      headers: authed(jwt),
      body: JSON.stringify({ id }),
    })
  ).revoked
}
