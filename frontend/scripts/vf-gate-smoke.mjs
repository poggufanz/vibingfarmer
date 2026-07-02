// VF gate smoke: full self-serve flow against a running instance.
//   npx tsx scripts/vf-gate-smoke.mjs            (vite dev on :5173)
//   SMOKE_BASE=https://preview.pages.dev npx tsx scripts/vf-gate-smoke.mjs
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk'

const BASE = process.env.SMOKE_BASE || 'http://localhost:5173'
const NET = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`✗ ${msg}`)
    process.exit(1)
  }
  console.log(`✓ ${msg}`)
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })

const kp = Keypair.random()

// 1. SEP-10
let r = await j(await fetch(`${BASE}/api/vf/auth/challenge?account=${kp.publicKey()}`, { headers: { Origin: BASE } }))
ok(r.status === 200, `challenge issued (${r.status})`)
const tx = TransactionBuilder.fromXDR(r.body.transaction, NET)
tx.sign(kp)
r = await j(await fetch(`${BASE}/api/vf/auth/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
  body: JSON.stringify({ transaction: tx.toXDR() }),
}))
ok(r.status === 200 && r.body.token, 'token issued')
const jwt = r.body.token

// 2. Issue a key (rateLimit 3 so the 429 loop is cheap)
r = await j(await fetch(`${BASE}/api/vf/keys`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ scopes: ['market'], env: 'test', rateLimit: 3 }),
}))
ok(r.status === 200 && r.body.key?.startsWith('vf_test_'), 'key issued (plaintext once)')
const { id, key } = r.body

// 3. Authed market calls
const authed = { Authorization: `Bearer ${key}` }
r = await j(await fetch(`${BASE}/api/vf/vault-facts?protocol=blend-usdc`, { headers: authed }))
ok(r.status === 200, 'vault-facts 200')
r = await j(await fetch(`${BASE}/api/vf/prices`, { headers: authed }))
ok([200, 502].includes(r.status), `prices reachable (${r.status})`) // 502 tolerated: upstream may flake
r = await j(await fetch(`${BASE}/api/vf/prices`, {}))
ok(r.status === 401, 'no key → 401')

// 4. Rate limit trips
let last = 0
for (let i = 0; i < 4; i++) {
  last = (await fetch(`${BASE}/api/vf/vault-facts`, { headers: authed })).status
}
ok(last === 429, 'per-key rate limit → 429')

// 5. Revoke → 401
r = await j(await fetch(`${BASE}/api/vf/keys`, {
  method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ id }),
}))
ok(r.status === 200, 'key revoked')
r = await j(await fetch(`${BASE}/api/vf/prices`, { headers: authed }))
ok(r.status === 401, 'revoked key → 401')

console.log('\nVF gate smoke: ALL GREEN')
