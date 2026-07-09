# VF API Gateway + Developer Key Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `vf_...` API key (issued from a self-serve `/developers` portal with SEP-10 wallet sign-in) authenticates all VF gateway endpoints (`/api/vf/*`), which proxy upstreams using server-held secrets, with per-key rate limiting + metering in Cloudflare D1.

**Architecture:** All inside the existing Pages project. Node-style handlers in `frontend/api/vf/` dispatched by one router handler, exposed via ONE Pages catch-all function (`functions/api/vf/[[path]].js`) and ONE vite middleware mount. Key store = D1 (binding `VF_DB`) behind a tiny store interface with an in-memory twin for tests/dev. SEP-10 challenge/token → hand-rolled HS256 JWT → key CRUD. Gateway endpoints wrap existing pure modules (`strategy/eligibilityGate`, `strategy/vaultFacts`, relay `feeBumpAndSubmit`).

**Tech Stack:** Cloudflare Pages Functions + D1, `@stellar/stellar-sdk` ^16 (`WebAuth`), WebCrypto (`crypto.subtle` — no new deps), zod, vitest.

**Spec:** `docs/superpowers/specs/2026-07-02-vf-api-gate-design.md` (read it first).

## Global Constraints

- **NEVER `git add -A` / `git add .`** — `planning/` and `docs/superpowers/` are tracked-but-must-stay-uncommitted. Always `git add <explicit paths>`.
- Branch: create `feature/api-gate` from current HEAD at Task 1; do NOT touch uncommitted wallet files (`frontend/src/wallet/**`, `planning/**`).
- Non-custodial HARD RULE: gateway returns analysis + UNSIGNED XDR only; `/submit` only relays device-signed XDR through `assertVaultDeposit`; no user secret in any request/response.
- Secrets: upstream keys (`DEEPSEEK_API_KEY`, `TAVILY_API_KEY`, `STELLAR_RELAYER_SECRET`, `VF_AUTH_SIGNING_KEY`, `VF_JWT_SECRET`) read from `process.env` server-side only; NEVER in responses or logs. Log key `id` only, never the key.
- VF keys: `vf_live_`/`vf_test_` + base62(32 bytes CSPRNG); stored as SHA-256 hex; plaintext returned exactly once.
- Handler style: Node `(req, res)` default export, mirror `frontend/api/faucet.js` / `_guard.js` conventions (405 wrong method, 503 `{configured:false}`, generic errors, no stack traces to client).
- Tests: vitest, run scoped `cd frontend && npx vitest run api/vf` (fast); full `npm test` at Task 14. Test style mirrors `frontend/api/faucet.test.js` (mockReq/mockRes, env in beforeEach).
- Commits: conventional (`feat:`, `test:`, `chore:`), no step numbers in messages, no attribution footer.
- All new server files live under `frontend/api/vf/`; files prefixed `_` are import-only (not routed).

---

### Task 1: Branch, store layer (`_db.js`), migration, wrangler binding, adapter env passthrough

**Files:**
- Create: `frontend/api/vf/_db.js`
- Create: `frontend/api/vf/_db.test.js`
- Create: `frontend/migrations/0001_vf_gate.sql`
- Modify: `frontend/wrangler.jsonc` (add `d1_databases`)
- Modify: `frontend/api/_pagesAdapter.js` (one line: `req.env = env`)
- Modify: `frontend/.dev.vars.example`, `frontend/.env.example` (document new vars)

**Interfaces (Produces — later tasks rely on these exact names):**
```js
// _db.js
export function memoryStore()            // in-memory store (tests + vite dev fallback)
export function d1Store(db)              // same interface over a D1 binding
export function storeFrom(req)           // req.env?.VF_DB ? d1Store(...) : shared memoryStore
// store interface (both impls):
// keys:    { insert(row), getByHash(hash), list(owner), revoke(id, owner), touch(id, ts) }
//   row = { id, key_hash, key_hint, owner, scopes (JSON string), rate_limit,
//           expires_at (int|null), enabled (0|1), created_at, last_used_at }
//   revoke returns true if a row owned by `owner` was disabled, else false
// counters:{ bump(keyId, windowStart) -> Promise<number>  // post-increment count
//            pruneBefore(ts) }
// usage:   { log(keyId, day, endpoint) }
```

- [ ] **Step 1: Branch**

```bash
git checkout -b feature/api-gate
```

- [ ] **Step 2: Write failing tests**

`frontend/api/vf/_db.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { memoryStore, storeFrom } from './_db.js'

const row = (over = {}) => ({
  id: 'vfk_1', key_hash: 'h1', key_hint: 'vf_test_ab12', owner: 'GAAA',
  scopes: '["market"]', rate_limit: 60, expires_at: null, enabled: 1,
  created_at: 1000, last_used_at: null, ...over,
})

describe('memoryStore', () => {
  it('insert + getByHash roundtrip', async () => {
    const s = memoryStore()
    await s.keys.insert(row())
    const got = await s.keys.getByHash('h1')
    expect(got.id).toBe('vfk_1')
    expect(await s.keys.getByHash('nope')).toBeNull()
  })
  it('list returns only the owner rows, without key_hash', async () => {
    const s = memoryStore()
    await s.keys.insert(row())
    await s.keys.insert(row({ id: 'vfk_2', key_hash: 'h2', owner: 'GBBB' }))
    const mine = await s.keys.list('GAAA')
    expect(mine).toHaveLength(1)
    expect(mine[0].id).toBe('vfk_1')
    expect(mine[0].key_hash).toBeUndefined()
  })
  it('revoke disables only own key', async () => {
    const s = memoryStore()
    await s.keys.insert(row())
    expect(await s.keys.revoke('vfk_1', 'GBBB')).toBe(false)
    expect(await s.keys.revoke('vfk_1', 'GAAA')).toBe(true)
    expect((await s.keys.getByHash('h1')).enabled).toBe(0)
  })
  it('counters.bump post-increments per (key, window)', async () => {
    const s = memoryStore()
    expect(await s.counters.bump('vfk_1', 100)).toBe(1)
    expect(await s.counters.bump('vfk_1', 100)).toBe(2)
    expect(await s.counters.bump('vfk_1', 160)).toBe(1)
  })
  it('usage.log accumulates per (key, day, endpoint)', async () => {
    const s = memoryStore()
    await s.usage.log('vfk_1', '2026-07-02', 'prices')
    await s.usage.log('vfk_1', '2026-07-02', 'prices')
    expect(s._usage.get('vfk_1|2026-07-02|prices')).toBe(2)
  })
})

describe('storeFrom', () => {
  it('falls back to a shared memory store without VF_DB', () => {
    const a = storeFrom({ env: {} })
    const b = storeFrom({})
    expect(a).toBe(b) // singleton so dev-issued keys survive across requests
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/_db.test.js`
Expected: FAIL — cannot resolve `./_db.js`

- [ ] **Step 4: Implement `frontend/api/vf/_db.js`**

```js
// VF gate store. One interface, two backends:
//  - d1Store(db): Cloudflare D1 binding (prod/preview; schema in migrations/0001_vf_gate.sql)
//  - memoryStore(): Maps (vitest + vite dev, non-persistent)
// Import-only (underscore prefix — never routed).

export function memoryStore() {
  const rows = new Map() // id -> row
  const counters = new Map() // `${keyId}|${window}` -> count
  const usage = new Map() // `${keyId}|${day}|${endpoint}` -> count
  const pub = ({ key_hash, ...rest }) => rest
  return {
    _usage: usage,
    keys: {
      async insert(row) { rows.set(row.id, { ...row }) },
      async getByHash(hash) {
        for (const r of rows.values()) if (r.key_hash === hash) return { ...r }
        return null
      },
      async list(owner) {
        return [...rows.values()].filter((r) => r.owner === owner).map(pub)
      },
      async revoke(id, owner) {
        const r = rows.get(id)
        if (!r || r.owner !== owner) return false
        r.enabled = 0
        return true
      },
      async touch(id, ts) {
        const r = rows.get(id)
        if (r) r.last_used_at = ts
      },
    },
    counters: {
      async bump(keyId, windowStart) {
        const k = `${keyId}|${windowStart}`
        const n = (counters.get(k) || 0) + 1
        counters.set(k, n)
        return n
      },
      async pruneBefore(ts) {
        for (const k of counters.keys()) if (Number(k.split('|')[1]) < ts) counters.delete(k)
      },
    },
    usage: {
      async log(keyId, day, endpoint) {
        const k = `${keyId}|${day}|${endpoint}`
        usage.set(k, (usage.get(k) || 0) + 1)
      },
    },
  }
}

export function d1Store(db) {
  return {
    keys: {
      async insert(r) {
        await db
          .prepare(
            `INSERT INTO api_keys (id, key_hash, key_hint, owner, scopes, rate_limit, expires_at, enabled, created_at, last_used_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(r.id, r.key_hash, r.key_hint, r.owner, r.scopes, r.rate_limit, r.expires_at, r.enabled, r.created_at, r.last_used_at)
          .run()
      },
      async getByHash(hash) {
        return (await db.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).bind(hash).first()) ?? null
      },
      async list(owner) {
        const { results } = await db
          .prepare(
            `SELECT id, key_hint, owner, scopes, rate_limit, expires_at, enabled, created_at, last_used_at
             FROM api_keys WHERE owner = ? ORDER BY created_at DESC`
          )
          .bind(owner)
          .all()
        return results ?? []
      },
      async revoke(id, owner) {
        const r = await db
          .prepare(`UPDATE api_keys SET enabled = 0 WHERE id = ? AND owner = ?`)
          .bind(id, owner)
          .run()
        return (r.meta?.changes ?? 0) > 0
      },
      async touch(id, ts) {
        await db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(ts, id).run()
      },
    },
    counters: {
      async bump(keyId, windowStart) {
        const row = await db
          .prepare(
            `INSERT INTO usage_counters (key_id, window_start, count) VALUES (?,?,1)
             ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
             RETURNING count`
          )
          .bind(keyId, windowStart)
          .first()
        return row?.count ?? 1
      },
      async pruneBefore(ts) {
        await db.prepare(`DELETE FROM usage_counters WHERE window_start < ?`).bind(ts).run()
      },
    },
    usage: {
      async log(keyId, day, endpoint) {
        await db
          .prepare(
            `INSERT INTO usage_log (key_id, day, endpoint, count) VALUES (?,?,?,1)
             ON CONFLICT(key_id, day, endpoint) DO UPDATE SET count = count + 1`
          )
          .bind(keyId, day, endpoint)
          .run()
      },
    },
  }
}

let _devStore = null
export function storeFrom(req) {
  const db = req?.env?.VF_DB
  if (db) return d1Store(db)
  if (!_devStore) _devStore = memoryStore()
  return _devStore
}
```

- [ ] **Step 5: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/_db.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Migration + wrangler binding + adapter + env examples**

`frontend/migrations/0001_vf_gate.sql` — exactly the spec §3 schema:
```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  key_hint TEXT NOT NULL,
  owner TEXT NOT NULL,
  scopes TEXT NOT NULL,
  rate_limit INTEGER NOT NULL DEFAULT 60,
  expires_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE usage_counters (
  key_id TEXT NOT NULL, window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);
CREATE TABLE usage_log (
  key_id TEXT NOT NULL, day TEXT NOT NULL, endpoint TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day, endpoint)
);
```

`frontend/wrangler.jsonc` — add after `"compatibility_flags"`:
```jsonc
  "d1_databases": [
    { "binding": "VF_DB", "database_name": "vf-gate", "database_id": "REPLACED-AFTER-wrangler-d1-create" }
  ]
```
(One-time op cmd, run by the user before deploy: `npx wrangler d1 create vf-gate` then paste the id, then `npx wrangler d1 migrations apply vf-gate --remote`.)

`frontend/api/_pagesAdapter.js` — after the `const req = { ... }` line, add binding passthrough:
```js
    const req = { method: request.method, headers, body, url: request.url, env }
```
(Replace the existing object literal — add `env` as the fifth property. Bindings like `VF_DB` are objects and cannot ride `process.env`.)

Append to `frontend/.dev.vars.example` and `frontend/.env.example`:
```bash
# VF API gate (SEP-10 portal + gateway)
VF_AUTH_SIGNING_KEY=S...        # server SEP-10 signing keypair secret (testnet)
VF_JWT_SECRET=change-me-32-chars-min
VF_HOME_DOMAIN=localhost:5173   # SEP-10 home_domain / web_auth_domain
VF_GLOBAL_DAILY_CAP=5000        # global upstream budget per scope per day
```

- [ ] **Step 7: Full scoped run + commit**

Run: `cd frontend && npx vitest run api/vf` → PASS
```bash
git add frontend/api/vf/_db.js frontend/api/vf/_db.test.js frontend/migrations/0001_vf_gate.sql frontend/wrangler.jsonc frontend/api/_pagesAdapter.js frontend/.dev.vars.example frontend/.env.example
git commit -m "feat(vf-gate): D1-backed key store layer with in-memory twin"
```

---

### Task 2: Keystore (`_keystore.js`)

**Files:**
- Create: `frontend/api/vf/_keystore.js`
- Create: `frontend/api/vf/_keystore.test.js`

**Interfaces:**
- Consumes: store from Task 1 (`keys.insert/getByHash/touch`).
- Produces:
```js
export const SCOPES = ['strategy', 'market', 'tx', 'submit', 'scan']
export async function sha256Hex(text)                       // WebCrypto
export function generateKey(env /* 'test'|'live' */)        // -> plaintext "vf_test_..." (43+ chars)
export async function issueKey(store, { owner, scopes, rateLimit, env, expiresAt })
//   -> { id, key /* plaintext, ONCE */, hint }
export async function verifyKey(store, plaintext, nowMs)
//   -> { ok:true, keyId, scopes:[...], rateLimit } | { ok:false, reason:'unknown'|'revoked'|'expired'|'malformed' }
export async function revokeKey(store, id, owner)           // -> boolean
```

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/_keystore.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { memoryStore } from './_db.js'
import { generateKey, issueKey, verifyKey, revokeKey, sha256Hex, SCOPES } from './_keystore.js'

describe('generateKey', () => {
  it('prefixes by env and uses base62 payload', () => {
    const k = generateKey('test')
    expect(k).toMatch(/^vf_test_[0-9A-Za-z]{40,}$/)
    expect(generateKey('live')).toMatch(/^vf_live_/)
    expect(generateKey('test')).not.toBe(generateKey('test'))
  })
})

describe('issue / verify / revoke', () => {
  it('stores hash + hint, never plaintext', async () => {
    const s = memoryStore()
    const { id, key, hint } = await issueKey(s, {
      owner: 'GAAA', scopes: ['market'], rateLimit: 60, env: 'test', expiresAt: null,
    })
    expect(id).toMatch(/^vfk_/)
    expect(hint).toBe(key.slice(0, 12) + '…')
    const stored = await s.keys.getByHash(await sha256Hex(key))
    expect(stored).not.toBeNull()
    expect(JSON.stringify(stored)).not.toContain(key) // plaintext nowhere at rest
  })
  it('verify: ok with scopes/rateLimit; unknown/revoked/expired/malformed fail', async () => {
    const s = memoryStore()
    const now = Date.now()
    const { id, key } = await issueKey(s, {
      owner: 'GAAA', scopes: ['market', 'tx'], rateLimit: 10, env: 'test',
      expiresAt: Math.floor(now / 1000) + 3600,
    })
    const v = await verifyKey(s, key, now)
    expect(v).toMatchObject({ ok: true, keyId: id, rateLimit: 10 })
    expect(v.scopes).toEqual(['market', 'tx'])
    expect((await verifyKey(s, 'vf_test_notarealkey000000000000000000000000000', now)).reason).toBe('unknown')
    expect((await verifyKey(s, 'sk-wrong-prefix', now)).reason).toBe('malformed')
    expect((await verifyKey(s, key, now + 3601 * 1000 + 1)).reason).toBe('expired')
    await revokeKey(s, id, 'GAAA')
    expect((await verifyKey(s, key, now)).reason).toBe('revoked')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/_keystore.test.js` → FAIL (module missing)

- [ ] **Step 3: Implement `frontend/api/vf/_keystore.js`**

```js
// VF key lifecycle. Keys: vf_<env>_ + base62(32 bytes CSPRNG). At rest: SHA-256 hex only.
// Plain SHA-256 (not argon2): 256-bit random keys are un-bruteforceable; slow hashes
// only add per-request latency.

export const SCOPES = ['strategy', 'market', 'tx', 'submit', 'scan']

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62(bytes) {
  let out = ''
  // rejection-free mapping is fine here: modulo bias over 62 on random bytes is
  // negligible for identifier entropy (still > 190 bits over 32 bytes)
  for (const b of bytes) out += B62[b % 62]
  return out
}

export function generateKey(env) {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `vf_${env}_${base62(bytes)}`
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
  if (typeof plaintext !== 'string' || !/^vf_(test|live)_[0-9A-Za-z]{40,}$/.test(plaintext)) {
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
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/_keystore.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/_keystore.js frontend/api/vf/_keystore.test.js
git commit -m "feat(vf-gate): key issue/verify/revoke with SHA-256 at rest"
```

---

### Task 3: JWT helper (`_jwt.js`)

**Files:**
- Create: `frontend/api/vf/_jwt.js`
- Create: `frontend/api/vf/_jwt.test.js`

**Interfaces:**
- Produces:
```js
export async function signJwt(payload, secret, ttlSec)  // -> compact HS256 JWT, adds iat/exp
export async function verifyJwt(token, secret, nowMs)   // -> payload | null (bad sig/expired/malformed)
```

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/_jwt.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { signJwt, verifyJwt } from './_jwt.js'

describe('HS256 JWT', () => {
  it('sign → verify roundtrip preserves claims', async () => {
    const t = await signJwt({ sub: 'GAAA' }, 'secret-0123456789', 3600)
    expect(t.split('.')).toHaveLength(3)
    const p = await verifyJwt(t, 'secret-0123456789')
    expect(p.sub).toBe('GAAA')
    expect(p.exp - p.iat).toBe(3600)
  })
  it('rejects wrong secret, tamper, expiry, garbage', async () => {
    const t = await signJwt({ sub: 'GAAA' }, 'right-secret-000000', 10)
    expect(await verifyJwt(t, 'wrong-secret-000000')).toBeNull()
    const [h, p, s] = t.split('.')
    expect(await verifyJwt(`${h}.${p}x.${s}`, 'right-secret-000000')).toBeNull()
    expect(await verifyJwt(t, 'right-secret-000000', Date.now() + 11_000)).toBeNull()
    expect(await verifyJwt('not.a.jwt', 'right-secret-000000')).toBeNull()
    expect(await verifyJwt('garbage', 'right-secret-000000')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/_jwt.test.js` → FAIL (module missing)

- [ ] **Step 3: Implement `frontend/api/vf/_jwt.js`**

```js
// Minimal HS256 compact JWT over WebCrypto — no new dependency for one algorithm.

const enc = new TextEncoder()

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uJson = (obj) => b64u(enc.encode(JSON.stringify(obj)))

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
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
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad), (c) => c.charCodeAt(0))
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(`${h}.${p}`))
    if (!ok) return null
    const payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof payload.exp !== 'number' || nowMs / 1000 > payload.exp) return null
    return payload
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/_jwt.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/_jwt.js frontend/api/vf/_jwt.test.js
git commit -m "feat(vf-gate): HS256 JWT helper over WebCrypto"
```

---

### Task 4: SEP-10 challenge/verify (`_sep10.js`)

**Files:**
- Create: `frontend/api/vf/_sep10.js`
- Create: `frontend/api/vf/_sep10.test.js`

**Interfaces:**
- Produces:
```js
export async function buildChallenge({ account, signingSecret, homeDomain, networkPassphrase })
//   -> { transaction /* b64 XDR */, network_passphrase }   (SEP-10 response shape)
export async function verifyChallenge({ signedXdr, signingSecret, homeDomain, networkPassphrase })
//   -> { ok:true, account:'G...' } | { ok:false, error:string }
```
- Notes: uses `WebAuth` from `@stellar/stellar-sdk` (v16). `web_auth_domain` = `homeDomain`. Timeout 300 s (WebAuth default).

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/_sep10.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { Keypair, TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import { buildChallenge, verifyChallenge } from './_sep10.js'

const NET = Networks.TESTNET
const server = Keypair.random()
const client = Keypair.random()
const HOME = 'localhost:5173'

const base = () => ({
  signingSecret: server.secret(),
  homeDomain: HOME,
  networkPassphrase: NET,
})

describe('SEP-10', () => {
  it('challenge is a server-signed tx for the requested account', async () => {
    const { transaction, network_passphrase } = await buildChallenge({ account: client.publicKey(), ...base() })
    expect(network_passphrase).toBe(NET)
    const tx = TransactionBuilder.fromXDR(transaction, NET)
    expect(tx.signatures).toHaveLength(1)
  })
  it('client-signed challenge verifies and yields the account', async () => {
    const { transaction } = await buildChallenge({ account: client.publicKey(), ...base() })
    const tx = TransactionBuilder.fromXDR(transaction, NET)
    tx.sign(client)
    const v = await verifyChallenge({ signedXdr: tx.toXDR(), ...base() })
    expect(v).toEqual({ ok: true, account: client.publicKey() })
  })
  it('rejects a challenge signed by the wrong wallet', async () => {
    const { transaction } = await buildChallenge({ account: client.publicKey(), ...base() })
    const tx = TransactionBuilder.fromXDR(transaction, NET)
    tx.sign(Keypair.random())
    expect((await verifyChallenge({ signedXdr: tx.toXDR(), ...base() })).ok).toBe(false)
  })
  it('rejects an unsigned (server-only) challenge and garbage XDR', async () => {
    const { transaction } = await buildChallenge({ account: client.publicKey(), ...base() })
    expect((await verifyChallenge({ signedXdr: transaction, ...base() })).ok).toBe(false)
    expect((await verifyChallenge({ signedXdr: 'garbage', ...base() })).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/_sep10.test.js` → FAIL (module missing)

- [ ] **Step 3: Implement `frontend/api/vf/_sep10.js`**

```js
// SEP-10 web auth (stateless: the server signature on the challenge makes a nonce
// table unnecessary; replay window = the 300 s challenge timebounds + 1 h JWT).
import { Keypair, WebAuth } from '@stellar/stellar-sdk'

const TIMEOUT_SEC = 300

export async function buildChallenge({ account, signingSecret, homeDomain, networkPassphrase }) {
  const serverKp = Keypair.fromSecret(signingSecret)
  const transaction = WebAuth.buildChallengeTx(
    serverKp,
    account,
    homeDomain,
    TIMEOUT_SEC,
    networkPassphrase,
    homeDomain // web_auth_domain
  )
  return { transaction, network_passphrase: networkPassphrase }
}

export async function verifyChallenge({ signedXdr, signingSecret, homeDomain, networkPassphrase }) {
  try {
    const serverKp = Keypair.fromSecret(signingSecret)
    const { clientAccountID } = WebAuth.readChallengeTx(
      signedXdr,
      serverKp.publicKey(),
      networkPassphrase,
      homeDomain,
      homeDomain
    )
    // Throws unless the client account's signature is present and valid.
    WebAuth.verifyChallengeTxSigners(
      signedXdr,
      serverKp.publicKey(),
      networkPassphrase,
      [clientAccountID],
      homeDomain,
      homeDomain
    )
    return { ok: true, account: clientAccountID }
  } catch (err) {
    return { ok: false, error: err?.message || 'invalid challenge' }
  }
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/_sep10.test.js` → PASS
(If `WebAuth.verifyChallengeTxSigners` name differs in sdk 16, check `node -e "console.log(Object.keys(require('@stellar/stellar-sdk').WebAuth))"` and use the exported signer-verification function — the test defines the required behavior.)

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/_sep10.js frontend/api/vf/_sep10.test.js
git commit -m "feat(vf-gate): SEP-10 challenge build + verification"
```

---

### Task 5: Auth middleware (`_vfauth.js`) — key auth + scope + rate limit + metering + global budget

**Files:**
- Create: `frontend/api/vf/_vfauth.js`
- Create: `frontend/api/vf/_vfauth.test.js`

**Interfaces:**
- Consumes: `verifyKey` (Task 2), store counters/usage (Task 1), `verifyJwt` (Task 3).
- Produces:
```js
export async function requireVfKey(req, res, store, { scope, endpoint, nowMs })
//   -> { keyId, scopes } | null (response already sent: 401/403/429/503)
//   endpoint defaults to scope; handlers pass their route name so usage_log
//   meters per (key, day, endpoint) as the spec requires
export async function requireJwt(req, res)
//   -> { sub } | null (401 sent)  — reads Authorization: Bearer <jwt>, env VF_JWT_SECRET
export const WINDOW_MS = 60_000
```
- Behavior: 401 missing/malformed/unknown/revoked/expired key; 403 scope not granted; per-key fixed window (minute) via `counters.bump` → 429 + `Retry-After`; global budget row `__global:<scope>` per day vs `VF_GLOBAL_DAILY_CAP` (default 5000) → 503; on success `usage.log(keyId, day, scope)` + `keys.touch`.

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/_vfauth.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest'
import { memoryStore } from './_db.js'
import { issueKey } from './_keystore.js'
import { signJwt } from './_jwt.js'
import { requireVfKey, requireJwt } from './_vfauth.js'

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
const reqWith = (auth) => ({ method: 'POST', headers: auth ? { authorization: auth } : {} })

let store, key, now
beforeEach(async () => {
  store = memoryStore()
  now = Date.now()
  process.env.VF_JWT_SECRET = 'test-jwt-secret-0000'
  process.env.VF_GLOBAL_DAILY_CAP = '5000'
  ;({ key } = await issueKey(store, { owner: 'GAAA', scopes: ['market'], rateLimit: 3, env: 'test', expiresAt: null }))
})

describe('requireVfKey', () => {
  it('accepts a valid key with the right scope', async () => {
    const res = mockRes()
    const ctx = await requireVfKey(reqWith(`Bearer ${key}`), res, store, { scope: 'market', nowMs: now })
    expect(ctx).toMatchObject({ scopes: ['market'] })
    expect(res.statusCode).toBe(200)
  })
  it('401 without / with unknown key; 403 wrong scope', async () => {
    let res = mockRes()
    expect(await requireVfKey(reqWith(null), res, store, { scope: 'market', nowMs: now })).toBeNull()
    expect(res.statusCode).toBe(401)
    res = mockRes()
    expect(await requireVfKey(reqWith('Bearer vf_test_' + 'a'.repeat(43)), res, store, { scope: 'market', nowMs: now })).toBeNull()
    expect(res.statusCode).toBe(401)
    res = mockRes()
    expect(await requireVfKey(reqWith(`Bearer ${key}`), res, store, { scope: 'submit', nowMs: now })).toBeNull()
    expect(res.statusCode).toBe(403)
  })
  it('429 past the per-key limit, with Retry-After', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await requireVfKey(reqWith(`Bearer ${key}`), mockRes(), store, { scope: 'market', nowMs: now })).not.toBeNull()
    }
    const res = mockRes()
    expect(await requireVfKey(reqWith(`Bearer ${key}`), res, store, { scope: 'market', nowMs: now })).toBeNull()
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0)
  })
  it('503 when the global daily budget for the scope is spent', async () => {
    process.env.VF_GLOBAL_DAILY_CAP = '2'
    const k2 = (await issueKey(store, { owner: 'GBBB', scopes: ['market'], rateLimit: 100, env: 'test', expiresAt: null })).key
    expect(await requireVfKey(reqWith(`Bearer ${k2}`), mockRes(), store, { scope: 'market', nowMs: now })).not.toBeNull()
    expect(await requireVfKey(reqWith(`Bearer ${k2}`), mockRes(), store, { scope: 'market', nowMs: now })).not.toBeNull()
    const res = mockRes()
    expect(await requireVfKey(reqWith(`Bearer ${k2}`), res, store, { scope: 'market', nowMs: now })).toBeNull()
    expect(res.statusCode).toBe(503)
  })
})

describe('requireJwt', () => {
  it('accepts a valid JWT and returns claims; 401 otherwise', async () => {
    const jwt = await signJwt({ sub: 'GAAA' }, 'test-jwt-secret-0000', 3600)
    const ok = await requireJwt(reqWith(`Bearer ${jwt}`), mockRes())
    expect(ok.sub).toBe('GAAA')
    const res = mockRes()
    expect(await requireJwt(reqWith('Bearer nope'), res)).toBeNull()
    expect(res.statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/_vfauth.test.js` → FAIL (module missing)

- [ ] **Step 3: Implement `frontend/api/vf/_vfauth.js`**

```js
// Gateway auth. The Bearer vf_ key IS the authentication — no Origin requirement
// (third-party servers send no Origin). CORS allow-all on vf endpoints is set by
// the router; abuse is bounded per-key + per-scope-global here.
import { verifyKey } from './_keystore.js'
import { verifyJwt } from './_jwt.js'

export const WINDOW_MS = 60_000

const send = (res, status, obj, headers = {}) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(obj))
  return null
}

const bearer = (req) => {
  const h = req.headers?.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

export async function requireVfKey(req, res, store, { scope, endpoint = scope, nowMs = Date.now() }) {
  const token = bearer(req)
  if (!token) return send(res, 401, { error: 'Missing API key' })
  const v = await verifyKey(store, token, nowMs)
  if (!v.ok) return send(res, 401, { error: 'Invalid API key' }) // reason not echoed
  if (!v.scopes.includes(scope)) return send(res, 403, { error: 'Out of scope' })

  const windowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS
  const count = await store.counters.bump(v.keyId, windowStart)
  if (count > v.rateLimit) {
    const retry = Math.ceil((windowStart + WINDOW_MS - nowMs) / 1000)
    return send(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(retry) })
  }

  const day = new Date(nowMs).toISOString().slice(0, 10)
  const dayStart = Date.parse(day)
  const cap = Number(process.env.VF_GLOBAL_DAILY_CAP || 5000)
  const globalCount = await store.counters.bump(`__global:${scope}`, dayStart)
  if (globalCount > cap) return send(res, 503, { error: 'Daily budget exhausted' })

  await store.usage.log(v.keyId, day, endpoint)
  await store.keys.touch(v.keyId, Math.floor(nowMs / 1000))
  // lazy prune: drop windows older than 2 windows (keeps daily __global rows)
  await store.counters.pruneBefore(windowStart - 2 * WINDOW_MS > dayStart ? dayStart : windowStart - 2 * WINDOW_MS)
  return { keyId: v.keyId, scopes: v.scopes }
}

export async function requireJwt(req, res) {
  const secret = process.env.VF_JWT_SECRET
  if (!secret) return send(res, 503, { configured: false, error: 'Portal auth not configured' })
  const payload = await verifyJwt(bearer(req), secret)
  if (!payload?.sub) return send(res, 401, { error: 'Invalid session' })
  return payload
}
```

**Note (pruneBefore vs daily rows):** the ternary keeps `__global:*` day rows alive: never prune past the current day start. The test suite for Task 1 already covers pruneBefore semantics; the guard here just chooses a safe cutoff.

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/_vfauth.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/_vfauth.js frontend/api/vf/_vfauth.test.js
git commit -m "feat(vf-gate): bearer key auth with scope, rate limit, metering, global budget"
```

---

### Task 6: Router + SEP-10 endpoints + Pages/vite wiring

**Files:**
- Create: `frontend/api/vf/_router.js`
- Create: `frontend/api/vf/auth-challenge.js`
- Create: `frontend/api/vf/auth-token.js`
- Create: `frontend/api/vf/_router.test.js`
- Create: `frontend/functions/api/vf/[[path]].js`
- Modify: `frontend/vite.config.js` (2 lines, one per middleware block)

**Interfaces:**
- Consumes: `buildChallenge`/`verifyChallenge` (Task 4), `signJwt` (Task 3), `applyCors`/`rateLimit` from `frontend/api/_guard.js`.
- Produces:
```js
// _router.js
export function subPath(req)         // '/prices', '/auth/challenge', ... (works vite-mounted AND Pages full-URL)
export default async function vfRouter(req, res)   // dispatch table; 404 {error:'Not found'} otherwise
export const routes = { /* 'GET /auth/challenge': handler, ... */ }  // later tasks REGISTER here
```
- Auth endpoints (SEP-10 §4 of spec):
  - `GET /api/vf/auth/challenge?account=G...` → `{ transaction, network_passphrase }` (400 bad account, 503 unconfigured)
  - `POST /api/vf/auth/token` `{ transaction }` → `{ token }` (401 failed verify)
  - Both: `applyCors` + `_guard.rateLimit` (browser-facing, pre-key).

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/_router.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest'
import { Keypair, TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import vfRouter, { subPath } from './_router.js'
import { verifyJwt } from './_jwt.js'

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
const mk = (method, url, body) => ({
  method, url, body,
  headers: { origin: 'http://localhost:5173', 'x-real-ip': '9.9.9.9' },
})

const server = Keypair.random()
const client = Keypair.random()

beforeEach(() => {
  process.env.ALLOWED_ORIGIN = 'http://localhost:5173'
  process.env.VF_AUTH_SIGNING_KEY = server.secret()
  process.env.VF_JWT_SECRET = 'router-test-secret-00'
  process.env.VF_HOME_DOMAIN = 'localhost:5173'
  process.env.STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET
})

describe('subPath', () => {
  it('handles vite-mounted and full Pages URLs', () => {
    expect(subPath({ url: '/auth/challenge?account=G' })).toBe('/auth/challenge')
    expect(subPath({ url: 'https://x.pages.dev/api/vf/prices?coins=a' })).toBe('/prices')
  })
})

describe('vf router', () => {
  it('404 on unknown route', async () => {
    const res = mockRes()
    await vfRouter(mk('GET', '/nope'), res)
    expect(res.statusCode).toBe(404)
  })
  it('SEP-10 flow: challenge → sign → token → valid JWT', async () => {
    let res = mockRes()
    await vfRouter(mk('GET', `/auth/challenge?account=${client.publicKey()}`), res)
    expect(res.statusCode).toBe(200)
    const { transaction } = JSON.parse(res.body)
    const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET)
    tx.sign(client)
    res = mockRes()
    await vfRouter(mk('POST', '/auth/token', { transaction: tx.toXDR() }), res)
    expect(res.statusCode).toBe(200)
    const { token } = JSON.parse(res.body)
    const claims = await verifyJwt(token, 'router-test-secret-00')
    expect(claims.sub).toBe(client.publicKey())
  })
  it('challenge 400 on bad account, token 401 on unsigned challenge', async () => {
    let res = mockRes()
    await vfRouter(mk('GET', '/auth/challenge?account=not-a-g-address'), res)
    expect(res.statusCode).toBe(400)
    res = mockRes()
    await vfRouter(mk('GET', `/auth/challenge?account=${client.publicKey()}`), res)
    const { transaction } = JSON.parse(res.body)
    res = mockRes()
    await vfRouter(mk('POST', '/auth/token', { transaction }), res)
    expect(res.statusCode).toBe(401)
  })
  it('challenge 503 when VF_AUTH_SIGNING_KEY unset', async () => {
    delete process.env.VF_AUTH_SIGNING_KEY
    const res = mockRes()
    await vfRouter(mk('GET', `/auth/challenge?account=${client.publicKey()}`), res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/_router.test.js` → FAIL (module missing)

- [ ] **Step 3: Implement router + auth endpoints**

`frontend/api/vf/_router.js`:
```js
// Single dispatcher for /api/vf/*. One vite mount + one Pages catch-all wrap this.
// Gateway endpoints authenticate with the Bearer vf_ key (requireVfKey inside each
// handler) — so CORS here is permissive (any browser origin may carry a key).
import authChallenge from './auth-challenge.js'
import authToken from './auth-token.js'

export const routes = {
  'GET /auth/challenge': authChallenge,
  'POST /auth/token': authToken,
  // Tasks 7-11 register: keys, vault-facts, prices, eligibility, build-tx,
  // simulate, submit, scan, strategy
}

export function subPath(req) {
  const pathname = new URL(req.url, 'http://local').pathname
  const i = pathname.indexOf('/api/vf')
  return (i >= 0 ? pathname.slice(i + '/api/vf'.length) : pathname) || '/'
}

export default async function vfRouter(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end('')
  }
  const handler = routes[`${req.method} ${subPath(req)}`]
  if (!handler) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ error: 'Not found' }))
  }
  return handler(req, res)
}
```

`frontend/api/vf/auth-challenge.js`:
```js
import { StrKey } from '@stellar/stellar-sdk'
import { rateLimit } from '../_guard.js'
import { buildChallenge } from './_sep10.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export default async function handler(req, res) {
  if (!rateLimit(req, res, { max: 20, windowMs: 60_000, bucket: 'vf-auth' })) return
  const signingSecret = process.env.VF_AUTH_SIGNING_KEY
  if (!signingSecret) return json(res, 503, { configured: false, error: 'Portal auth not configured' })
  const account = new URL(req.url, 'http://local').searchParams.get('account') || ''
  if (!StrKey.isValidEd25519PublicKey(account)) return json(res, 400, { error: 'Invalid account' })
  const out = await buildChallenge({
    account,
    signingSecret,
    homeDomain: process.env.VF_HOME_DOMAIN || 'localhost:5173',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  })
  json(res, 200, out)
}
```

`frontend/api/vf/auth-token.js`:
```js
import { rateLimit } from '../_guard.js'
import { verifyChallenge } from './_sep10.js'
import { signJwt } from './_jwt.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export default async function handler(req, res) {
  if (!rateLimit(req, res, { max: 20, windowMs: 60_000, bucket: 'vf-auth' })) return
  const signingSecret = process.env.VF_AUTH_SIGNING_KEY
  const jwtSecret = process.env.VF_JWT_SECRET
  if (!signingSecret || !jwtSecret) return json(res, 503, { configured: false, error: 'Portal auth not configured' })
  const signedXdr = req.body?.transaction
  if (typeof signedXdr !== 'string' || !signedXdr) return json(res, 400, { error: 'Missing transaction' })
  const v = await verifyChallenge({
    signedXdr,
    signingSecret,
    homeDomain: process.env.VF_HOME_DOMAIN || 'localhost:5173',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  })
  if (!v.ok) return json(res, 401, { error: 'Challenge verification failed' })
  json(res, 200, { token: await signJwt({ sub: v.account }, jwtSecret, 3600) })
}
```

`frontend/functions/api/vf/[[path]].js`:
```js
// Cloudflare Pages catch-all → /api/vf/* (single wrapper; routing in api/vf/_router.js)
import vfRouter from '../../../api/vf/_router.js'
import { toPagesFunction } from '../../../api/_pagesAdapter.js'

export const onRequest = toPagesFunction(vfRouter)
```

`frontend/vite.config.js` — add ONE line to EACH of the two middleware blocks (dev + preview), importing at top:
```js
import vfRouter from './api/vf/_router.js'
// in both blocks, BEFORE the other /api mounts:
s.middlewares.use('/api/vf', vfRouter)
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/_router.test.js` → PASS
Note: `_guard.rateLimit` state is per-process; the auth tests send ≤ 20 requests so the IP bucket never trips.

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/_router.js frontend/api/vf/auth-challenge.js frontend/api/vf/auth-token.js frontend/api/vf/_router.test.js "frontend/functions/api/vf/[[path]].js" frontend/vite.config.js
git commit -m "feat(vf-gate): /api/vf router, SEP-10 challenge/token endpoints, Pages + vite wiring"
```

---

### Task 7: Key CRUD endpoint (`keys.js`)

**Files:**
- Create: `frontend/api/vf/keys.js`
- Create: `frontend/api/vf/keys.test.js`
- Modify: `frontend/api/vf/_router.js` (register routes)

**Interfaces:**
- Consumes: `requireJwt` (Task 5), `issueKey`/`revokeKey`/`SCOPES` (Task 2), `storeFrom` (Task 1), zod.
- Produces routes: `GET /keys` → `{ keys: [...] }` (no hash); `POST /keys` `{ scopes, env, rateLimit? }` → `{ id, key, hint }`; `DELETE /keys` `{ id }` → `{ revoked: true }`.

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/keys.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest'
import vfRouter from './_router.js'
import { storeFrom } from './_db.js'
import { signJwt } from './_jwt.js'

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
const mk = (method, url, body, jwt) => ({
  method, url, body,
  headers: { 'x-real-ip': '8.8.8.8', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
})

let jwt
beforeEach(async () => {
  process.env.VF_JWT_SECRET = 'keys-test-secret-000'
  jwt = await signJwt({ sub: 'GOWNER' }, 'keys-test-secret-000', 3600)
})

describe('/api/vf/keys', () => {
  it('401 without JWT', async () => {
    const res = mockRes()
    await vfRouter(mk('GET', '/keys'), res)
    expect(res.statusCode).toBe(401)
  })
  it('POST issues a key (plaintext once), GET lists without plaintext/hash, DELETE revokes', async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/keys', { scopes: ['market'], env: 'test' }, jwt), res)
    expect(res.statusCode).toBe(200)
    const issued = JSON.parse(res.body)
    expect(issued.key).toMatch(/^vf_test_/)

    res = mockRes()
    await vfRouter(mk('GET', '/keys', undefined, jwt), res)
    const { keys } = JSON.parse(res.body)
    const mine = keys.find((k) => k.id === issued.id)
    expect(mine.key_hint).toBe(issued.hint)
    expect(res.body).not.toContain(issued.key)
    expect(mine.key_hash).toBeUndefined()

    res = mockRes()
    await vfRouter(mk('DELETE', '/keys', { id: issued.id }, jwt), res)
    expect(JSON.parse(res.body)).toEqual({ revoked: true })
    // revoked key no longer verifies
    const store = storeFrom({})
    const { verifyKey } = await import('./_keystore.js')
    expect((await verifyKey(store, issued.key)).reason).toBe('revoked')
  })
  it('400 on invalid scopes / env / rateLimit', async () => {
    for (const body of [
      { scopes: ['nope'], env: 'test' },
      { scopes: ['market'], env: 'prod' },
      { scopes: ['market'], env: 'test', rateLimit: 0 },
      { scopes: [], env: 'test' },
    ]) {
      const res = mockRes()
      await vfRouter(mk('POST', '/keys', body, jwt), res)
      expect(res.statusCode).toBe(400)
    }
  })
  it("DELETE another owner's key → 404", async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/keys', { scopes: ['market'], env: 'test' }, jwt), res)
    const { id } = JSON.parse(res.body)
    const other = await signJwt({ sub: 'GOTHER' }, 'keys-test-secret-000', 3600)
    res = mockRes()
    await vfRouter(mk('DELETE', '/keys', { id }, other), res)
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/keys.test.js` → FAIL (route 404)

- [ ] **Step 3: Implement `frontend/api/vf/keys.js` + register**

```js
// Key CRUD — JWT-gated (portal session), NOT vf-key-gated.
import { z } from 'zod'
import { storeFrom } from './_db.js'
import { requireJwt } from './_vfauth.js'
import { issueKey, revokeKey, SCOPES } from './_keystore.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

const IssueSchema = z.object({
  scopes: z.array(z.enum(SCOPES)).nonempty(),
  env: z.enum(['test', 'live']),
  rateLimit: z.number().int().min(1).max(600).default(60),
  expiresAt: z.number().int().positive().nullable().default(null),
})

export async function listKeys(req, res) {
  const session = await requireJwt(req, res)
  if (!session) return
  json(res, 200, { keys: await storeFrom(req).keys.list(session.sub) })
}

export async function createKey(req, res) {
  const session = await requireJwt(req, res)
  if (!session) return
  const parsed = IssueSchema.safeParse(req.body ?? {})
  if (!parsed.success) return json(res, 400, { error: 'Invalid key request' })
  const { scopes, env, rateLimit, expiresAt } = parsed.data
  const out = await issueKey(storeFrom(req), { owner: session.sub, scopes, rateLimit, env, expiresAt })
  json(res, 200, out) // { id, key (ONLY time plaintext leaves the server), hint }
}

export async function deleteKey(req, res) {
  const session = await requireJwt(req, res)
  if (!session) return
  const id = req.body?.id
  if (typeof id !== 'string' || !id) return json(res, 400, { error: 'Missing id' })
  const ok = await revokeKey(storeFrom(req), id, session.sub)
  if (!ok) return json(res, 404, { error: 'Key not found' })
  json(res, 200, { revoked: true })
}
```

Register in `_router.js` `routes`:
```js
import { listKeys, createKey, deleteKey } from './keys.js'
// ...
  'GET /keys': listKeys,
  'POST /keys': createKey,
  'DELETE /keys': deleteKey,
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/keys.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/keys.js frontend/api/vf/keys.test.js frontend/api/vf/_router.js
git commit -m "feat(vf-gate): self-serve key CRUD behind SEP-10 session"
```

---

### Task 8: Market endpoints — `vault-facts.js`, `eligibility.js`, `prices.js`

**Files:**
- Create: `frontend/api/vf/vault-facts.js`, `frontend/api/vf/eligibility.js`, `frontend/api/vf/prices.js`
- Create: `frontend/api/vf/market.test.js`
- Modify: `frontend/api/vf/_router.js` (register 3 routes)

**Interfaces:**
- Consumes: `requireVfKey` (Task 5, scope `market`), `storeFrom` (Task 1), `resolve` from `frontend/src/strategy/vaultFacts.js`, `evaluate` from `frontend/src/strategy/eligibilityGate.js` (both pure ESM — server-import them exactly like `frontend/src/vfapi/client.js` does).
- Produces routes: `GET /vault-facts?protocol=blend-usdc`; `POST /eligibility` `{ vault, amount:"1000000", protocol? }` → `{ allow, verdict, reasons }`; `GET /prices?coins=coingecko:stellar,coingecko:usd-coin`.

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/market.test.js`:
```js
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import vfRouter from './_router.js'
import { storeFrom } from './_db.js'
import { issueKey } from './_keystore.js'

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
const mk = (method, url, body, key) => ({
  method, url, body,
  headers: { 'x-real-ip': '7.7.7.7', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

let key
beforeEach(async () => {
  ;({ key } = await issueKey(storeFrom({}), {
    owner: 'GMKT', scopes: ['market'], rateLimit: 100, env: 'test', expiresAt: null,
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('market endpoints', () => {
  it('all three 401 without a key', async () => {
    for (const [m, u] of [['GET', '/vault-facts?protocol=blend-usdc'], ['POST', '/eligibility'], ['GET', '/prices']]) {
      const res = mockRes()
      await vfRouter(mk(m, u), res)
      expect(res.statusCode).toBe(401)
    }
  })
  it('vault-facts returns resolver output', async () => {
    const res = mockRes()
    await vfRouter(mk('GET', '/vault-facts?protocol=blend-usdc', undefined, key), res)
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out).toHaveProperty('protocol')
    expect(out).toHaveProperty('facts')
  })
  it('eligibility evaluates and returns allow/verdict/reasons', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/eligibility', { vault: 'CVAULT', amount: '10000000', protocol: 'blend-usdc' }, key), res)
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(typeof out.allow).toBe('boolean')
    expect(Array.isArray(out.reasons)).toBe(true)
  })
  it('eligibility 400 on non-numeric amount', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/eligibility', { vault: 'CVAULT', amount: 'xx' }, key), res)
    expect(res.statusCode).toBe(400)
  })
  it('prices proxies DeFiLlama and never echoes upstream errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ coins: { 'coingecko:stellar': { price: 0.5 } } }), { status: 200 })))
    let res = mockRes()
    await vfRouter(mk('GET', '/prices?coins=coingecko:stellar', undefined, key), res)
    expect(JSON.parse(res.body).coins['coingecko:stellar'].price).toBe(0.5)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('SECRET-INTERNAL-DETAIL') }))
    res = mockRes()
    await vfRouter(mk('GET', '/prices', undefined, key), res)
    expect(res.statusCode).toBe(502)
    expect(res.body).not.toContain('SECRET-INTERNAL-DETAIL')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/market.test.js` → FAIL (404s)

- [ ] **Step 3: Implement the three handlers + register**

`frontend/api/vf/vault-facts.js`:
```js
import { resolve as resolveVaultFacts } from '../../src/strategy/vaultFacts.js'
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'market' })
  if (!ctx) return
  const protocol = new URL(req.url, 'http://local').searchParams.get('protocol') || 'blend-usdc'
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(resolveVaultFacts(protocol)))
}
```

`frontend/api/vf/eligibility.js`:
```js
import { evaluate } from '../../src/strategy/eligibilityGate.js'
import { resolve as resolveVaultFacts } from '../../src/strategy/vaultFacts.js'
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const bigintSafe = (_, v) => (typeof v === 'bigint' ? v.toString() : v)
const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj, bigintSafe))
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'market', endpoint: 'eligibility' })
  if (!ctx) return
  const { vault, amount, protocol } = req.body ?? {}
  let amt
  try {
    amt = BigInt(amount)
  } catch {
    return json(res, 400, { error: 'Invalid amount' })
  }
  if (typeof vault !== 'string' || !vault) return json(res, 400, { error: 'Missing vault' })
  const { facts } = resolveVaultFacts(protocol || 'blend-usdc')
  const verdict = evaluate({ vault, amount: amt, facts })
  json(res, 200, {
    allow: verdict.eligible ?? false,
    verdict,
    reasons: verdict.reasons ?? [],
  })
}
```
Note: JSON-serialize BigInt fields inside `verdict` if present — if `JSON.stringify` throws in the test, wrap with a replacer: `JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v))`. Apply the replacer in this handler's `json()` regardless (harmless).

`frontend/api/vf/prices.js`:
```js
// DeFiLlama coins API — keyless upstream. https://coins.llama.fi/prices/current/{coins}
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const DEFAULT_COINS = 'coingecko:stellar,coingecko:usd-coin'

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'market' })
  if (!ctx) return
  const coins = new URL(req.url, 'http://local').searchParams.get('coins') || DEFAULT_COINS
  res.setHeader('Content-Type', 'application/json')
  try {
    const upstream = await fetch(
      `https://coins.llama.fi/prices/current/${encodeURIComponent(coins)}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!upstream.ok) throw new Error('bad status')
    res.statusCode = 200
    res.end(JSON.stringify(await upstream.json()))
  } catch {
    res.statusCode = 502
    res.end(JSON.stringify({ error: 'upstream' })) // never leak provider detail
  }
}
```

Register in `_router.js`:
```js
import vaultFacts from './vault-facts.js'
import eligibility from './eligibility.js'
import prices from './prices.js'
// ...
  'GET /vault-facts': vaultFacts,
  'POST /eligibility': eligibility,
  'GET /prices': prices,
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/market.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/vault-facts.js frontend/api/vf/eligibility.js frontend/api/vf/prices.js frontend/api/vf/market.test.js frontend/api/vf/_router.js
git commit -m "feat(vf-gate): market endpoints (vault-facts, eligibility, prices)"
```

---

### Task 9: Tx endpoints — `build-tx.js`, `simulate.js`

**Files:**
- Create: `frontend/api/vf/build-tx.js`, `frontend/api/vf/simulate.js`
- Create: `frontend/api/vf/tx.test.js`
- Modify: `frontend/api/vf/_router.js`

**Interfaces:**
- Consumes: `requireVfKey` (scope `tx`), `@stellar/stellar-sdk` (`rpc.Server`, `Contract`, `TransactionBuilder`, `Address`, `nativeToScVal`, `StrKey`).
- Produces routes:
  - `POST /build-tx` `{ kind:'deposit', from:'G...', amount:'10000000' }` → `{ xdr }` UNSIGNED (vault from `SOROBAN_VAULT_ADDRESS`)
  - `POST /simulate` `{ xdr }` → `{ status, result }` (pass-through of `simulateTransaction` minus internals)
- Both export a `core({ deps })` function so tests inject a fake rpc — the handler builds real deps.

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/tx.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import vfRouter from './_router.js'
import { buildDepositCore } from './build-tx.js'
import { simulateCore } from './simulate.js'
import { storeFrom } from './_db.js'
import { issueKey } from './_keystore.js'

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
const mk = (method, url, body, key) => ({
  method, url, body,
  headers: { 'x-real-ip': '6.6.6.6', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

const user = Keypair.random()
let key
beforeEach(async () => {
  process.env.SOROBAN_VAULT_ADDRESS = 'CCDXZ6BUYXQQ4G4EMAIBBNIPMFYUC5DPWCFV3BAHUTVNTUMIT4EIHHIA'
  process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
  ;({ key } = await issueKey(storeFrom({}), {
    owner: 'GTX', scopes: ['tx'], rateLimit: 100, env: 'test', expiresAt: null,
  }))
})

describe('buildDepositCore', () => {
  it('produces an UNSIGNED prepared deposit tx XDR', async () => {
    const fakeRpc = {
      async getAccount(g) {
        const { Account } = await import('@stellar/stellar-sdk')
        return new Account(g, '1')
      },
      async prepareTransaction(tx) { return tx }, // pass-through: skip live simulation
    }
    const { xdr } = await buildDepositCore({
      from: user.publicKey(), amount: 10000000n,
      vault: process.env.SOROBAN_VAULT_ADDRESS,
      passphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
      rpcServer: fakeRpc,
    })
    const { TransactionBuilder } = await import('@stellar/stellar-sdk')
    const tx = TransactionBuilder.fromXDR(xdr, process.env.STELLAR_NETWORK_PASSPHRASE)
    expect(tx.signatures).toHaveLength(0) // UNSIGNED — non-custodial rule
    expect(tx.operations[0].type).toBe('invokeHostFunction')
  })
})

describe('simulateCore', () => {
  it('returns the sim status without internals', async () => {
    const fakeRpc = { async simulateTransaction() { return { id: 'x', latestLedger: 1, events: [], _parsed: true, error: undefined } } }
    const out = await simulateCore({ xdr: 'AAA', passphrase: process.env.STELLAR_NETWORK_PASSPHRASE, rpcServer: fakeRpc, parse: () => ({}) })
    expect(out.ok).toBe(true)
  })
})

describe('endpoint auth + validation', () => {
  it('401 without key; 403 with wrong-scope key; 400 bad input', async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/build-tx', {}), res)
    expect(res.statusCode).toBe(401)
    const { key: mktKey } = await issueKey(storeFrom({}), { owner: 'GM', scopes: ['market'], rateLimit: 10, env: 'test', expiresAt: null })
    res = mockRes()
    await vfRouter(mk('POST', '/build-tx', {}, mktKey), res)
    expect(res.statusCode).toBe(403)
    res = mockRes()
    await vfRouter(mk('POST', '/build-tx', { kind: 'deposit', from: 'not-a-g', amount: '1' }, key), res)
    expect(res.statusCode).toBe(400)
    res = mockRes()
    await vfRouter(mk('POST', '/simulate', {}, key), res)
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/tx.test.js` → FAIL (modules missing)

- [ ] **Step 3: Implement**

`frontend/api/vf/build-tx.js`:
```js
// Builds an UNSIGNED Soroban vault deposit tx. Non-custodial: signing happens on-device.
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export async function buildDepositCore({ from, amount, vault, passphrase, rpcServer }) {
  const { Contract, TransactionBuilder, Address, nativeToScVal, BASE_FEE } = await import('@stellar/stellar-sdk')
  const account = await rpcServer.getAccount(from)
  const contract = new Contract(vault)
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(contract.call('deposit', new Address(from).toScVal(), nativeToScVal(amount, { type: 'i128' })))
    .setTimeout(300)
    .build()
  const prepared = await rpcServer.prepareTransaction(tx)
  return { xdr: prepared.toXDR() }
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'tx' })
  if (!ctx) return
  const { kind, from, amount } = req.body ?? {}
  const vault = process.env.SOROBAN_VAULT_ADDRESS || ''
  if (!vault) return json(res, 503, { configured: false, error: 'Vault not configured' })
  const { StrKey } = await import('@stellar/stellar-sdk')
  let amt
  try {
    amt = BigInt(amount)
  } catch {
    return json(res, 400, { error: 'Invalid amount' })
  }
  if (kind !== 'deposit' || !StrKey.isValidEd25519PublicKey(from || '') || amt <= 0n) {
    return json(res, 400, { error: 'Invalid build request' })
  }
  try {
    const { rpc } = await import('@stellar/stellar-sdk')
    const rpcServer = new rpc.Server(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org')
    const out = await buildDepositCore({
      from, amount: amt, vault,
      passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
      rpcServer,
    })
    json(res, 200, out)
  } catch {
    json(res, 502, { error: 'upstream' })
  }
}
```

`frontend/api/vf/simulate.js`:
```js
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export async function simulateCore({ xdr, passphrase, rpcServer, parse }) {
  const tx = parse(xdr, passphrase)
  const sim = await rpcServer.simulateTransaction(tx)
  return { ok: !sim.error, error: sim.error ? 'simulation failed' : undefined, latestLedger: sim.latestLedger }
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'tx' })
  if (!ctx) return
  const xdr = req.body?.xdr
  if (typeof xdr !== 'string' || !xdr) return json(res, 400, { error: 'Missing xdr' })
  try {
    const sdk = await import('@stellar/stellar-sdk')
    const rpcServer = new sdk.rpc.Server(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org')
    const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
    const out = await simulateCore({
      xdr, passphrase, rpcServer,
      parse: (x, p) => sdk.TransactionBuilder.fromXDR(x, p),
    })
    json(res, 200, out)
  } catch {
    json(res, 502, { error: 'upstream' })
  }
}
```

Register in `_router.js`:
```js
import buildTx from './build-tx.js'
import simulate from './simulate.js'
// ...
  'POST /build-tx': buildTx,
  'POST /simulate': simulate,
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/tx.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/build-tx.js frontend/api/vf/simulate.js frontend/api/vf/tx.test.js frontend/api/vf/_router.js
git commit -m "feat(vf-gate): unsigned deposit build + simulate endpoints"
```

---

### Task 10: `submit.js` + `scan.js`

**Files:**
- Create: `frontend/api/vf/submit.js`, `frontend/api/vf/scan.js`
- Create: `frontend/api/vf/submit-scan.test.js`
- Modify: `frontend/api/vf/_router.js`

**Interfaces:**
- Consumes: `feeBumpAndSubmit` + `assertVaultDeposit` from `frontend/api/stellar-relay.js` (existing, reviewed); `requireVfKey` scopes `submit` / `scan`; `evaluate` + `resolve` (as Task 8).
- Produces routes:
  - `POST /submit` `{ xdr }` → `{ hash, status, relayer }` — key-authed fee-bump relay, deposit-only (guard inside `feeBumpAndSubmit` via `assertVaultDeposit`)
  - `POST /scan` `{ target, protocol? }` → `{ kind:'account'|'contract'|'invalid', isKnownVault, eligibility? }`
- `submit.js` exports `submitCore({ xdr, deps })` for injection; the default handler builds live deps (mirrors how `stellar-relay.js` does).

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/submit-scan.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import vfRouter from './_router.js'
import { submitCore } from './submit.js'
import { storeFrom } from './_db.js'
import { issueKey } from './_keystore.js'

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
const mk = (method, url, body, key) => ({
  method, url, body,
  headers: { 'x-real-ip': '5.5.5.5', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

let submitKey, scanKey
beforeEach(async () => {
  process.env.STELLAR_RELAYER_SECRET = ''
  process.env.SOROBAN_VAULT_ADDRESS = 'CCDXZ6BUYXQQ4G4EMAIBBNIPMFYUC5DPWCFV3BAHUTVNTUMIT4EIHHIA'
  const s = storeFrom({})
  submitKey = (await issueKey(s, { owner: 'GS', scopes: ['submit'], rateLimit: 50, env: 'test', expiresAt: null })).key
  scanKey = (await issueKey(s, { owner: 'GS', scopes: ['scan'], rateLimit: 50, env: 'test', expiresAt: null })).key
})

describe('/submit', () => {
  it('503 configured:false without relayer secret', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/submit', { xdr: 'AAA' }, submitKey), res)
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toMatchObject({ configured: false })
  })
  it('submitCore delegates to the injected relay fn and returns its result', async () => {
    const relay = vi.fn(async () => ({ hash: 'H', status: 'SUCCESS', relayer: 'GRELAY' }))
    const out = await submitCore({ xdr: 'XDR64', deps: { relay } })
    expect(relay).toHaveBeenCalledWith(expect.objectContaining({ xdr: 'XDR64' }))
    expect(out).toEqual({ hash: 'H', status: 'SUCCESS', relayer: 'GRELAY' })
  })
  it('401 without key', async () => {
    const res = mockRes()
    await vfRouter(mk('POST', '/submit', { xdr: 'AAA' }), res)
    expect(res.statusCode).toBe(401)
  })
})

describe('/scan', () => {
  it('classifies targets and flags the known vault', async () => {
    let res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: process.env.SOROBAN_VAULT_ADDRESS }, scanKey), res)
    let out = JSON.parse(res.body)
    expect(out).toMatchObject({ kind: 'contract', isKnownVault: true })
    expect(out.eligibility).toBeDefined()

    res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: 'GBQMXVTR5HQNRGXPR4ZPBOZR7VQXOQMEQMZWIVLIW2MYBXCP7QO76SVX' }, scanKey), res)
    out = JSON.parse(res.body)
    expect(out).toMatchObject({ kind: 'account', isKnownVault: false })

    res = mockRes()
    await vfRouter(mk('POST', '/scan', { target: 'garbage' }, scanKey), res)
    expect(JSON.parse(res.body).kind).toBe('invalid')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/submit-scan.test.js` → FAIL

- [ ] **Step 3: Implement**

`frontend/api/vf/submit.js`:
```js
// Key-authed gasless relay. Reuses the reviewed relay core (fee-bump + deposit-only
// assertVaultDeposit guard live inside feeBumpAndSubmit). Non-custodial: the XDR is
// already signed on-device; the server only pays the fee.
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

export async function submitCore({ xdr, deps }) {
  return deps.relay({ xdr })
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'submit' })
  if (!ctx) return
  const xdr = req.body?.xdr
  if (typeof xdr !== 'string' || !xdr) return json(res, 400, { error: 'Missing xdr' })
  const secret = process.env.STELLAR_RELAYER_SECRET || ''
  if (!secret) return json(res, 503, { configured: false, error: 'Relay not configured' })
  try {
    const sdk = await import('@stellar/stellar-sdk')
    const { feeBumpAndSubmit } = await import('../stellar-relay.js')
    const rpcServer = new sdk.rpc.Server(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org')
    const out = await submitCore({
      xdr,
      deps: {
        relay: ({ xdr: x }) =>
          feeBumpAndSubmit({
            xdr: x,
            secret,
            passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
            vaultAddr: process.env.SOROBAN_VAULT_ADDRESS || '',
            sdk,
            rpcServer,
          }),
      },
    })
    json(res, 200, out)
  } catch {
    json(res, 502, { error: 'upstream' })
  }
}
```
(Check `feeBumpAndSubmit`'s exact parameter object at `frontend/api/stellar-relay.js:82` before wiring — the docblock lists `{ xdr, secret, passphrase, vaultAddr, sdk, rpcServer }`; if it differs, match the real signature. The injected-deps test pins `submitCore` behavior either way.)

`frontend/api/vf/scan.js`:
```js
// Scan-before-send: StrKey classification + known-vault check + F8 eligibility verdict.
// HONESTY: app-layer verdict only — not on-chain-verifiable.
import { StrKey } from '@stellar/stellar-sdk'
import { evaluate } from '../../src/strategy/eligibilityGate.js'
import { resolve as resolveVaultFacts } from '../../src/strategy/vaultFacts.js'
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const bigintSafe = (_, v) => (typeof v === 'bigint' ? v.toString() : v)

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'scan' })
  if (!ctx) return
  const target = String(req.body?.target || '')
  const protocol = req.body?.protocol || 'blend-usdc'
  const kind = StrKey.isValidEd25519PublicKey(target)
    ? 'account'
    : StrKey.isValidContract(target)
      ? 'contract'
      : 'invalid'
  const isKnownVault = kind === 'contract' && target === (process.env.SOROBAN_VAULT_ADDRESS || '')
  const out = { kind, isKnownVault }
  if (isKnownVault) {
    const { facts } = resolveVaultFacts(protocol)
    out.eligibility = evaluate({ vault: target, amount: 10000000n, facts })
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(out, bigintSafe))
}
```

Register in `_router.js`:
```js
import submit from './submit.js'
import scan from './scan.js'
// ...
  'POST /submit': submit,
  'POST /scan': scan,
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/submit-scan.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/submit.js frontend/api/vf/scan.js frontend/api/vf/submit-scan.test.js frontend/api/vf/_router.js
git commit -m "feat(vf-gate): key-authed deposit relay + scan verdict endpoints"
```

---

### Task 11: `strategy.js` (LLM + fallback)

**Files:**
- Create: `frontend/api/vf/strategy.js`
- Create: `frontend/api/vf/strategy.test.js`
- Modify: `frontend/api/vf/_router.js`

**Interfaces:**
- Consumes: `requireVfKey` scope `strategy`; DeepSeek HTTP API (same URL/model allowlist as `frontend/api/ai.js`); env `DEEPSEEK_API_KEY`, `VF_VAULT_CATALOG` (csv, default `blend-usdc`).
- Produces route `POST /strategy` `{ amountUsd, riskLevel:'low'|'medium'|'high', vaultCount }` →
  `{ allocations:[{protocol, pct}], reasoning, source:'llm'|'fallback' }`
- Exports `equalSplit(protocols, vaultCount)` and `parseLlmPlan(text, protocols)` (pure, tested).

- [ ] **Step 1: Write failing tests**

`frontend/api/vf/strategy.test.js`:
```js
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import vfRouter from './_router.js'
import { equalSplit, parseLlmPlan } from './strategy.js'
import { storeFrom } from './_db.js'
import { issueKey } from './_keystore.js'

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(s) { this.body = s ?? ''; return this },
  }
}
const mk = (body, key) => ({
  method: 'POST', url: '/strategy', body,
  headers: { 'x-real-ip': '4.4.4.4', ...(key ? { authorization: `Bearer ${key}` } : {}) },
})

let key
beforeEach(async () => {
  delete process.env.DEEPSEEK_API_KEY
  process.env.VF_VAULT_CATALOG = 'blend-usdc'
  ;({ key } = await issueKey(storeFrom({}), {
    owner: 'GST', scopes: ['strategy'], rateLimit: 50, env: 'test', expiresAt: null,
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('equalSplit', () => {
  it('splits 100 across min(count, catalog) with integer pcts summing to 100', () => {
    expect(equalSplit(['a', 'b', 'c'], 2)).toEqual([
      { protocol: 'a', pct: 50 },
      { protocol: 'b', pct: 50 },
    ])
    const three = equalSplit(['a', 'b', 'c'], 3)
    expect(three.reduce((s, x) => s + x.pct, 0)).toBe(100)
  })
})

describe('parseLlmPlan', () => {
  it('accepts a valid plan, rejects bad pct sums / unknown protocols / garbage', () => {
    const ok = parseLlmPlan('{"allocations":[{"protocol":"blend-usdc","pct":100}],"reasoning":"r"}', ['blend-usdc'])
    expect(ok.allocations[0].pct).toBe(100)
    expect(parseLlmPlan('{"allocations":[{"protocol":"evil","pct":100}]}', ['blend-usdc'])).toBeNull()
    expect(parseLlmPlan('{"allocations":[{"protocol":"blend-usdc","pct":80}]}', ['blend-usdc'])).toBeNull()
    expect(parseLlmPlan('not json', ['blend-usdc'])).toBeNull()
  })
})

describe('POST /strategy', () => {
  it('falls back to equal split without DEEPSEEK_API_KEY', async () => {
    const res = mockRes()
    await vfRouter(mk({ amountUsd: 100, riskLevel: 'low', vaultCount: 1 }, key), res)
    expect(res.statusCode).toBe(200)
    const out = JSON.parse(res.body)
    expect(out.source).toBe('fallback')
    expect(out.allocations).toEqual([{ protocol: 'blend-usdc', pct: 100 }])
  })
  it('uses the LLM plan when the upstream answers valid JSON', async () => {
    process.env.DEEPSEEK_API_KEY = 'k'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: '{"allocations":[{"protocol":"blend-usdc","pct":100}],"reasoning":"solid"}' } }],
      }), { status: 200 })
    ))
    const res = mockRes()
    await vfRouter(mk({ amountUsd: 100, riskLevel: 'medium', vaultCount: 1 }, key), res)
    const out = JSON.parse(res.body)
    expect(out.source).toBe('llm')
    expect(out.reasoning).toBe('solid')
  })
  it('falls back when the LLM returns garbage', async () => {
    process.env.DEEPSEEK_API_KEY = 'k'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'nonsense' } }] }), { status: 200 })
    ))
    const res = mockRes()
    await vfRouter(mk({ amountUsd: 100, riskLevel: 'high', vaultCount: 1 }, key), res)
    expect(JSON.parse(res.body).source).toBe('fallback')
  })
  it('400 on invalid inputs', async () => {
    const res = mockRes()
    await vfRouter(mk({ amountUsd: -5, riskLevel: 'yolo', vaultCount: 0 }, key), res)
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run api/vf/strategy.test.js` → FAIL

- [ ] **Step 3: Implement `frontend/api/vf/strategy.js`**

```js
// AI allocation strategy. LLM (DeepSeek, server key) with a deterministic equal-split
// fallback — the strategist NEVER blocks the flow (mirrors src/venice.js philosophy).
import { z } from 'zod'
import { storeFrom } from './_db.js'
import { requireVfKey } from './_vfauth.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const MODEL = 'deepseek-v4-flash'

const json = (res, status, obj) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

const InputSchema = z.object({
  amountUsd: z.number().positive(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  vaultCount: z.number().int().min(1).max(10),
})

export function equalSplit(protocols, vaultCount) {
  const picks = protocols.slice(0, Math.max(1, Math.min(vaultCount, protocols.length)))
  const base = Math.floor(100 / picks.length)
  return picks.map((protocol, i) => ({ protocol, pct: i === 0 ? 100 - base * (picks.length - 1) : base }))
}

export function parseLlmPlan(text, protocols) {
  try {
    const obj = JSON.parse(text)
    const allocations = obj?.allocations
    if (!Array.isArray(allocations) || allocations.length === 0) return null
    let sum = 0
    for (const a of allocations) {
      if (!protocols.includes(a.protocol)) return null
      if (typeof a.pct !== 'number' || a.pct <= 0) return null
      sum += a.pct
    }
    if (Math.abs(sum - 100) > 1) return null
    return { allocations, reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '' }
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  const ctx = await requireVfKey(req, res, storeFrom(req), { scope: 'strategy' })
  if (!ctx) return
  const parsed = InputSchema.safeParse(req.body ?? {})
  if (!parsed.success) return json(res, 400, { error: 'Invalid strategy request' })
  const { amountUsd, riskLevel, vaultCount } = parsed.data
  const protocols = (process.env.VF_VAULT_CATALOG || 'blend-usdc').split(',').map((s) => s.trim()).filter(Boolean)

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (apiKey) {
    try {
      const upstream = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          model: MODEL,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are a conservative DeFi allocation strategist. Reply ONLY with JSON: ' +
                '{"allocations":[{"protocol":<string>,"pct":<number>}],"reasoning":<string>} — pcts sum to 100, ' +
                'protocols strictly from the given catalog.',
            },
            {
              role: 'user',
              content: `amountUsd=${amountUsd} riskLevel=${riskLevel} vaultCount=${vaultCount} catalog=${protocols.join(',')}`,
            },
          ],
        }),
      })
      if (upstream.ok) {
        const data = await upstream.json()
        const plan = parseLlmPlan(data?.choices?.[0]?.message?.content ?? '', protocols)
        if (plan) return json(res, 200, { ...plan, source: 'llm' })
      }
    } catch {
      // fall through to the deterministic fallback — never block
    }
  }
  json(res, 200, {
    allocations: equalSplit(protocols, vaultCount),
    reasoning: 'Equal split across the vetted catalog (deterministic fallback).',
    source: 'fallback',
  })
}
```

Register in `_router.js`:
```js
import strategy from './strategy.js'
// ...
  'POST /strategy': strategy,
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run api/vf/strategy.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/api/vf/strategy.js frontend/api/vf/strategy.test.js frontend/api/vf/_router.js
git commit -m "feat(vf-gate): strategy endpoint with LLM plan + deterministic fallback"
```

---

### Task 12: Developer portal page `/developers`

**Files:**
- Create: `frontend/src/developers/DevelopersPage.jsx`
- Create: `frontend/src/developers/DevelopersPage.test.jsx`
- Create: `frontend/src/developers/portalClient.js`
- Create: `frontend/src/developers/portalClient.test.js`
- Modify: `frontend/src/app.jsx` (add lazy route near the other `<Route>` entries at ~line 2248)

**Interfaces:**
- Consumes: `/api/vf/auth/*` + `/api/vf/keys` endpoints; wallet signing.
- Produces `portalClient.js`:
```js
export async function signIn({ account, signChallenge })
//   fetch challenge → const signedXdr = await signChallenge(transaction) → fetch token → returns jwt string
export async function listKeys(jwt)                      // -> [{id, key_hint, scopes, ...}]
export async function createKey(jwt, { scopes, env, rateLimit })  // -> { id, key, hint }
export async function revokeKey(jwt, id)                 // -> true
```
- Wallet signing: FIRST check `frontend/src/wallet.js` for an exported wallets-kit instance/sign helper and reuse it. If none is exported, instantiate `@creit.tech/stellar-wallets-kit` locally in the page:
```js
import { StellarWalletsKit, WalletNetwork, allowAllModules } from '@creit.tech/stellar-wallets-kit'
const kit = new StellarWalletsKit({ network: WalletNetwork.TESTNET, modules: allowAllModules() })
// connect: await kit.openModal({ onWalletSelected: async (o) => { kit.setWallet(o.id) } })
// address: const { address } = await kit.getAddress()
// sign:    const { signedTxXdr } = await kit.signTransaction(xdr, { networkPassphrase })
```

- [ ] **Step 1: Write failing tests**

`frontend/src/developers/portalClient.test.js`:
```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { signIn, listKeys, createKey, revokeKey } from './portalClient.js'

afterEach(() => vi.unstubAllGlobals())

const okJson = (obj) => new Response(JSON.stringify(obj), { status: 200 })

describe('portalClient', () => {
  it('signIn: challenge → wallet sign → token', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push([String(url), opts])
      if (String(url).includes('/auth/challenge')) return okJson({ transaction: 'CHAL_XDR' })
      return okJson({ token: 'JWT123' })
    }))
    const signChallenge = vi.fn(async (xdr) => `${xdr}:signed`)
    const jwt = await signIn({ account: 'GAAA', signChallenge })
    expect(signChallenge).toHaveBeenCalledWith('CHAL_XDR')
    expect(jwt).toBe('JWT123')
    expect(JSON.parse(calls[1][1].body)).toEqual({ transaction: 'CHAL_XDR:signed' })
  })
  it('key CRUD sends the JWT bearer and parses results', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      expect(opts.headers.Authorization).toBe('Bearer J')
      if (opts.method === 'POST') return okJson({ id: 'vfk_1', key: 'vf_test_x', hint: 'vf_test_x…' })
      if (opts.method === 'DELETE') return okJson({ revoked: true })
      return okJson({ keys: [{ id: 'vfk_1' }] })
    }))
    expect((await createKey('J', { scopes: ['market'], env: 'test', rateLimit: 60 })).key).toBe('vf_test_x')
    expect(await listKeys('J')).toEqual([{ id: 'vfk_1' }])
    expect(await revokeKey('J', 'vfk_1')).toBe(true)
  })
  it('throws a readable error on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401 })))
    await expect(listKeys('bad')).rejects.toThrow('Invalid session')
  })
})
```

`frontend/src/developers/DevelopersPage.test.jsx` (jsdom + RTL, both already dev-deps):
```jsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import DevelopersPage from './DevelopersPage.jsx'

vi.mock('./portalClient.js', () => ({
  signIn: vi.fn(async () => 'JWT'),
  listKeys: vi.fn(async () => [
    { id: 'vfk_1', key_hint: 'vf_test_ab12…', scopes: '["market"]', enabled: 1, created_at: 1, last_used_at: null, rate_limit: 60 },
  ]),
  createKey: vi.fn(async () => ({ id: 'vfk_2', key: 'vf_test_PLAINTEXT_ONCE', hint: 'vf_test_PL…' })),
  revokeKey: vi.fn(async () => true),
}))
vi.mock('./walletSign.js', () => ({
  connectWallet: vi.fn(async () => ({ address: 'GAAA', signChallenge: async (x) => x + ':s' })),
}))

afterEach(() => vi.restoreAllMocks())

describe('DevelopersPage', () => {
  it('connect → lists keys → generate shows plaintext once', async () => {
    render(<DevelopersPage />)
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    await waitFor(() => expect(screen.getByText('vf_test_ab12…')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /generate key/i }))
    await waitFor(() => expect(screen.getByText('vf_test_PLAINTEXT_ONCE')).toBeTruthy())
    expect(screen.getByText(/will not be shown again/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/developers` → FAIL (modules missing)

- [ ] **Step 3: Implement**

`frontend/src/developers/portalClient.js`:
```js
// Portal HTTP client — session (JWT) side only. The vf_ API key never touches this module.
const base = '/api/vf'

async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
  return body
}

export async function signIn({ account, signChallenge }) {
  const { transaction } = await jfetch(`${base}/auth/challenge?account=${encodeURIComponent(account)}`)
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
  return (await jfetch(`${base}/keys`, {
    method: 'DELETE',
    headers: authed(jwt),
    body: JSON.stringify({ id }),
  })).revoked
}
```

`frontend/src/developers/walletSign.js` (thin seam so the page is testable):
```js
// Wallet connect + SEP-10 challenge signing. Reuse the app's wallet plumbing if
// src/wallet.js exports a kit/sign helper; otherwise this local kit is the fallback.
import { StellarWalletsKit, WalletNetwork, allowAllModules } from '@creit.tech/stellar-wallets-kit'

let kit
function getKit() {
  if (!kit) kit = new StellarWalletsKit({ network: WalletNetwork.TESTNET, modules: allowAllModules() })
  return kit
}

export async function connectWallet() {
  const k = getKit()
  await new Promise((resolve, reject) =>
    k.openModal({
      onWalletSelected: (option) => {
        k.setWallet(option.id)
        resolve()
      },
      onClosed: () => reject(new Error('Wallet selection cancelled')),
    })
  )
  const { address } = await k.getAddress()
  return {
    address,
    signChallenge: async (xdr) => {
      const { signedTxXdr } = await k.signTransaction(xdr, {
        networkPassphrase: 'Test SDF Network ; September 2015',
      })
      return signedTxXdr
    },
  }
}
```

`frontend/src/developers/DevelopersPage.jsx` — Acid Yield styling: reuse existing design-system classes from DESIGN.md / screens.jsx (dark surface, mono labels, document rows). Structure:
```jsx
import { useState } from 'react'
import { signIn, listKeys, createKey, revokeKey } from './portalClient.js'
import { connectWallet } from './walletSign.js'

const ALL_SCOPES = ['strategy', 'market', 'tx', 'submit', 'scan']

export default function DevelopersPage() {
  const [session, setSession] = useState(null) // { jwt, address }
  const [keys, setKeys] = useState([])
  const [freshKey, setFreshKey] = useState(null) // { key, hint } — show-once modal
  const [scopes, setScopes] = useState(['market', 'scan'])
  const [env, setEnv] = useState('test')
  const [error, setError] = useState('')

  async function onConnect() {
    try {
      setError('')
      const { address, signChallenge } = await connectWallet()
      const jwt = await signIn({ account: address, signChallenge })
      setSession({ jwt, address })
      setKeys(await listKeys(jwt))
    } catch (e) {
      setError(e.message)
    }
  }

  async function onGenerate() {
    try {
      setError('')
      const out = await createKey(session.jwt, { scopes, env, rateLimit: 60 })
      setFreshKey(out)
      setKeys(await listKeys(session.jwt))
    } catch (e) {
      setError(e.message)
    }
  }

  async function onRevoke(id) {
    try {
      await revokeKey(session.jwt, id)
      setKeys(await listKeys(session.jwt))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="developers-page">
      <header>
        <h1>Developers</h1>
        <p>One VF API key unlocks strategy, risk scanning, and gasless deposit relay.</p>
      </header>
      {error && <p role="alert">{error}</p>}

      {!session ? (
        <button onClick={onConnect}>Connect wallet</button>
      ) : (
        <>
          <section aria-label="issue key">
            <fieldset>
              <legend>Scopes</legend>
              {ALL_SCOPES.map((s) => (
                <label key={s}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={() =>
                      setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
                    }
                  />
                  {s}
                </label>
              ))}
            </fieldset>
            <label>
              Environment
              <select value={env} onChange={(e) => setEnv(e.target.value)}>
                <option value="test">test</option>
                <option value="live">live</option>
              </select>
            </label>
            <button onClick={onGenerate} disabled={scopes.length === 0}>
              Generate key
            </button>
          </section>

          <section aria-label="your keys">
            {keys.map((k) => (
              <div className="document-row" key={k.id}>
                <code>{k.key_hint}</code>
                <span>{JSON.parse(k.scopes).join(' · ')}</span>
                <span>{k.enabled ? 'active' : 'revoked'}</span>
                {k.enabled ? <button onClick={() => onRevoke(k.id)}>Revoke</button> : null}
              </div>
            ))}
          </section>
        </>
      )}

      {freshKey && (
        <div role="dialog" aria-label="new api key">
          <p>Copy your key now — it will not be shown again.</p>
          <code>{freshKey.key}</code>
          <button onClick={() => navigator.clipboard.writeText(freshKey.key)}>Copy</button>
          <button onClick={() => setFreshKey(null)}>Done</button>
        </div>
      )}
    </div>
  )
}
```
Style pass: match the surrounding app (check class conventions used by `screens.jsx` / DESIGN.md tokens) — dark `#0e0f0c` surface, acid-lime accents, mono metadata. Follow existing CSS conventions; do not invent a new system.

Route in `frontend/src/app.jsx` — alongside the other routes (~line 2248):
```jsx
const DevelopersPage = lazy(() => import('./developers/DevelopersPage.jsx'))
// ...
<Route path="/developers" element={<DevelopersPage />} />
```
(`lazy` import at the top with the existing lazy imports; wrap in the existing `Suspense` boundary the app already uses for `AgentDashboard`.)

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run src/developers` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/developers frontend/src/app.jsx
git commit -m "feat(vf-gate): /developers portal — SEP-10 sign-in, show-once key issuance"
```

---

### Task 13: `vfClient` HTTP module (wallet-side consumer)

**Files:**
- Create: `frontend/src/vfapi/httpClient.js`
- Create: `frontend/src/vfapi/httpClient.test.js`

**Interfaces:**
- Produces:
```js
export function makeVfClient({ apiKey, base = '/api/vf' })
//   -> { strategy(body), eligibility(body), vaultFacts(protocol), prices(coins),
//        buildTx(body), simulate(xdr), submit(xdr), scan(body) }
// Each method: fetch with Authorization: Bearer <apiKey>, JSON in/out, throws Error(body.error) on non-200.
export function vfClientFromEnv()  // reads import.meta.env.VITE_VF_API_KEY, returns client or null when unset
```
- NOTE: this task creates the client + tests only. Swapping app surfaces onto it happens after wallet-classic Tasks 7-11 land (spec §2 coexistence rule) — do NOT modify `venice.js`/`wallet` files here.

- [ ] **Step 1: Write failing tests**

`frontend/src/vfapi/httpClient.test.js`:
```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeVfClient } from './httpClient.js'

afterEach(() => vi.unstubAllGlobals())

describe('makeVfClient', () => {
  it('sends the Bearer key and parses JSON per method', async () => {
    const seen = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      seen.push([String(url), opts.method || 'GET', opts.headers?.Authorization])
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
    }))
    const c = makeVfClient({ apiKey: 'vf_test_k' })
    await c.prices('coingecko:stellar')
    await c.eligibility({ vault: 'C1', amount: '1' })
    await c.submit('XDR')
    expect(seen).toEqual([
      ['/api/vf/prices?coins=coingecko%3Astellar', 'GET', 'Bearer vf_test_k'],
      ['/api/vf/eligibility', 'POST', 'Bearer vf_test_k'],
      ['/api/vf/submit', 'POST', 'Bearer vf_test_k'],
    ])
  })
  it('throws the server error message on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Out of scope' }), { status: 403 })))
    const c = makeVfClient({ apiKey: 'vf_test_k' })
    await expect(c.scan({ target: 'G' })).rejects.toThrow('Out of scope')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/vfapi/httpClient.test.js` → FAIL

- [ ] **Step 3: Implement `frontend/src/vfapi/httpClient.js`**

```js
// Single-key HTTP client for the VF gateway. Replaces scattered provider calls:
// the wallet build ships ONE env var (VITE_VF_API_KEY) and zero upstream keys.

export function makeVfClient({ apiKey, base = '/api/vf' }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
  async function call(path, { method = 'GET', body } = {}) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const out = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`)
    return out
  }
  return {
    strategy: (body) => call('/strategy', { method: 'POST', body }),
    eligibility: (body) => call('/eligibility', { method: 'POST', body }),
    vaultFacts: (protocol) => call(`/vault-facts?protocol=${encodeURIComponent(protocol)}`),
    prices: (coins) => call(`/prices?coins=${encodeURIComponent(coins)}`),
    buildTx: (body) => call('/build-tx', { method: 'POST', body }),
    simulate: (xdr) => call('/simulate', { method: 'POST', body: { xdr } }),
    submit: (xdr) => call('/submit', { method: 'POST', body: { xdr } }),
    scan: (body) => call('/scan', { method: 'POST', body }),
  }
}

export function vfClientFromEnv() {
  const apiKey = import.meta.env?.VITE_VF_API_KEY
  return apiKey ? makeVfClient({ apiKey }) : null
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd frontend && npx vitest run src/vfapi/httpClient.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/vfapi/httpClient.js frontend/src/vfapi/httpClient.test.js
git commit -m "feat(vf-gate): single-key vfClient for wallet/dev consumers"
```

---

### Task 14: E2E smoke script + full-suite gate

**Files:**
- Create: `frontend/scripts/vf-gate-smoke.mjs`

**Interfaces:**
- Consumes: everything. Runs the WHOLE flow against a live base URL (default `http://localhost:5173`, override `SMOKE_BASE`): SEP-10 with a script-local keypair → JWT → issue key → market calls → 429 loop → revoke → 401.

- [ ] **Step 1: Write `frontend/scripts/vf-gate-smoke.mjs`**

```js
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
```

- [ ] **Step 2: Run the smoke against vite dev**

Terminal A: `cd frontend && npm run dev` (with `VF_AUTH_SIGNING_KEY` + `VF_JWT_SECRET` set in `.env.local`).
Terminal B: `cd frontend && npx tsx scripts/vf-gate-smoke.mjs`
Expected: `VF gate smoke: ALL GREEN` (rate-limit line requires the dev store singleton — memoryStore — which vite's single process provides).

- [ ] **Step 3: Full suite + lint gate**

Run: `cd frontend && npm test` → all green (prior suites + ~40 new)
Run: `cd frontend && npm run lint` → no new errors

- [ ] **Step 4: Commit**

```bash
git add frontend/scripts/vf-gate-smoke.mjs
git commit -m "test(vf-gate): end-to-end smoke — SEP-10, issue, rate limit, revoke"
```

---

## Post-plan (user-run, not tasks)

1. `npx wrangler d1 create vf-gate` → paste `database_id` into `wrangler.jsonc` → `npx wrangler d1 migrations apply vf-gate --remote`.
2. Cloudflare Pages env: set `VF_AUTH_SIGNING_KEY` (fresh testnet keypair — NOT the relayer/deployer), `VF_JWT_SECRET`, `VF_HOME_DOMAIN` (the pages.dev host), keep existing secrets.
3. Deploy preview → run `SMOKE_BASE=https://<preview>.pages.dev npx tsx scripts/vf-gate-smoke.mjs`.
4. Merge decision via superpowers:finishing-a-development-branch.
