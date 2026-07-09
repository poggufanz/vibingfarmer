# VF API Gateway + Developer Key Portal — Design Spec

**Date:** 2026-07-02
**Status:** Approved (brainstorm complete, plan pending)
**Supersedes/extends:** `planning/vf-api-gate.md` (handoff doc) — this spec pulls the portal
("self-serve key page") INTO scope and moves the whole gateway PRE-submission.
**Local only — never commit** (planning-docs rule).

---

## 1. Decisions log

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Key page audience | Self-serve dev portal | Admin-only console; auto-provision per wallet | User decision — composability story: any dev mints a key |
| Timing | Full gateway + portal **pre-submission (15 Jul 2026)** | Post-hackathon (original plan §timing) | User decision; fallback ladder in §10 |
| Portal auth | **SEP-10** wallet sign-in (challenge tx → JWT) | GitHub OAuth, email magic link, no-auth | Stellar-native standard (Active v3.4.1), zero email infra, key bound to G-address, on-brand |
| Build vs buy | **Build-own on D1** (Approach A) | Unkey (B); A+AI Gateway now (C) | Zero vendor at demo time, full control, pitch "all ours"; C = post-hackathon enhancement |
| Storage | **Cloudflare D1** (one binding) | KV (eventual consistency breaks instant revoke), DO (needs separate Worker, overkill) | Verified: Pages Functions support `d1_databases`; relational fits keys+metering; strong consistency for revoke |
| Rate limiting | D1 counter (fixed window/min) | Native Workers rate-limiting binding | Verified: binding NOT in the Pages Functions binding subset |
| Key hashing | Plain SHA-256 at rest | argon2/bcrypt | 256-bit random keys are un-bruteforceable; slow hash adds latency, no security (industry practice) |
| Key checksum | None v1 | GitHub-style CRC32 tail | Checksum serves secret-scanning FP reduction, not security — YAGNI until scanner registration |
| Legacy endpoints | Coexist during transition | Hard swap | `/api/ai` etc. stay live; wallet moves to `vfClient`; legacy removed post-hackathon |

Research basis: deep-research run 2026-07-02 — claims extracted from primary sources
(GitHub eng blog, Confluent docs, Cloudflare docs, SEP-10 repo, Better Auth docs);
adversarial-verify panel failed on session limit → claims labeled **primary-source, unverified-by-panel**.
Cloudflare Pages bindings facts **verified** directly via Cloudflare docs (context7).

---

## 2. Concept & architecture

One `vf_...` key unlocks all VF services. Upstream provider secrets live ONLY in server env.
Gateway keeps the non-custodial rule: analysis + UNSIGNED XDR out; `/submit` only fee-bumps
device-signed XDR; no user secret ever passes through.

```
dev/wallet ──Bearer vf_live_xxx──► /api/vf/*  (Pages Functions, existing project)
                                      │ _vfauth.js: SHA-256(key) → D1 lookup
                                      │ scope check → rate limit → meter (D1)
                                      ├─► upstream clients (secrets in server env)
                                      │     LLM / Tavily / DeFiLlama / price / Soroban RPC
                                      └─► existing modules (strategy/*, stellar/relay)

portal /developers ──SEP-10 challenge+token──► JWT (1 h)
                   ──JWT──► /api/vf/keys  (issue / list / revoke)
```

- Everything inside the existing Pages project. **One new binding: D1** in `wrangler.jsonc`
  (`d1_databases`). `_pagesAdapter` must pass `env`/bindings through to handlers (wiring task).
- New env: `VF_AUTH_SIGNING_KEY` (SEP-10 server keypair secret), `VF_JWT_SECRET`. Existing
  upstream secrets unchanged (`DEEPSEEK_API_KEY`, `TAVILY_API_KEY`, relayer, RPC…).
- No new vendor, no separate Worker.

## 3. Key model + D1 schema

Format: `vf_live_` / `vf_test_` + base62(32 bytes CSPRNG) ≈ 43 chars total.
Prefix = industry convention (GitHub/Stripe/Confluent): env separation, secret-scanner
friendliness, underscore separator (non-Base64, double-click selects whole token).
Plaintext shown exactly once at issuance. Stored: SHA-256 hex only.

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,            -- vfk_xxx (public id, safe to log)
  key_hash TEXT UNIQUE NOT NULL,  -- sha256 hex of full key
  key_hint TEXT NOT NULL,         -- "vf_live_a1b2…" for list display
  owner TEXT NOT NULL,            -- G... address (SEP-10 subject)
  scopes TEXT NOT NULL,           -- JSON array: ["strategy","market","tx","submit","scan"]
  rate_limit INTEGER NOT NULL DEFAULT 60,   -- req/min
  expires_at INTEGER,             -- unix seconds; NULL = no expiry
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE usage_counters (     -- rate-limit windows + global budget rows
  key_id TEXT NOT NULL, window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);
CREATE TABLE usage_log (          -- daily metering for later billing
  key_id TEXT NOT NULL, day TEXT NOT NULL, endpoint TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day, endpoint)
);
```

Logs carry `id` + usage only — never the key (no-secret-in-logs rule).

## 4. Portal `/developers` + SEP-10 auth

Standard SEP-10 v3.4.1, stateless (server signs its own challenge → no nonce table):

1. `GET /api/vf/auth/challenge?account=G...` → server builds challenge tx signed by
   `VF_AUTH_SIGNING_KEY`, timebounds 300 s, manage_data nonce + web_auth_domain.
2. Portal asks wallet (Freighter / VF extension) to sign → `POST /api/vf/auth/token {signed_xdr}`
   → server verifies BOTH signatures + timebounds + domain → JWT HS256, 1 h, `sub` = G-address.
3. JWT authorizes `/api/vf/keys`:
   - **POST** issue `{scopes, env: test|live, rateLimit}` → `{ id, plaintextKeyOnce, hint }`
   - **GET** list → hint, scopes, created_at, last_used_at, status (never hash/plaintext)
   - **DELETE /:id** revoke (sets `enabled=0`). Rotate = revoke + issue new.

UI: route `/developers` in the existing React app, Acid Yield design system (DESIGN.md):
document-row key list, scope checkboxes + test/live toggle on issue, show-once modal with
copy button + "will not be shown again" warning, revoke per row.

## 5. Gateway endpoints

`api/vf/_vfauth.js` middleware (mirrors `_guard.js` style): parse `Authorization: Bearer` →
prefix check → SHA-256 → D1 lookup → `enabled`/`expires_at`/scope check → rate limit →
attach `{ keyId, scopes }`. Failures: 401 (missing/invalid/expired key), 403 (out-of-scope), 429.

| Endpoint | Scope | Wraps |
|---|---|---|
| `POST /api/vf/strategy` | `strategy` | LLM + Tavily + DeFiLlama (existing `venice.js` chain) |
| `POST /api/vf/eligibility` | `market` | `strategy/eligibilityGate.evaluate` |
| `GET  /api/vf/vault-facts` | `market` | `strategy/vaultFacts.resolve` |
| `GET  /api/vf/prices` | `market` | price feed (default: DeFiLlama coins/prices API — keyless; swappable at plan time) |
| `POST /api/vf/build-tx` | `tx` | RPC build → UNSIGNED XDR only |
| `POST /api/vf/simulate` | `tx` | RPC simulate |
| `POST /api/vf/submit` | `submit` | existing relay + `assertVaultDeposit` (deposit-only) |
| `POST /api/vf/scan` | `scan` | riskAgent / F8 verdict |
| `GET/POST/DELETE /api/vf/keys` | JWT (not vf key) | key CRUD |
| `GET/POST /api/vf/auth/*` | public + `_guard` IP limit | SEP-10 challenge/token |

Upstream clients in `api/vf/_upstream/*.js`: read secrets from env, return
`503 {configured:false}` when unset (matches existing BYOK-lockdown pattern). Secrets never
appear in any response body.

## 6. Rate limiting, metering, global budget

One D1 statement per request (fixed window per minute):

```sql
INSERT INTO usage_counters (key_id, window_start, count) VALUES (?, ?, 1)
ON CONFLICT(key_id, window_start) DO UPDATE SET count = count + 1
RETURNING count
```

- `count > rate_limit` → 429 + `Retry-After`.
- Global upstream budget = rows `key_id='__global:llm'` (etc.) per day; cap hit → 503 for all
  keys on that upstream — a leaked key cannot drain provider quota.
- Metering: upsert `usage_log` per (key, day, endpoint).
- Old windows pruned lazily on insert (`DELETE … WHERE window_start < now − 2·window`).
- In-memory `_guard.js` IP limit stays for public endpoints (`/auth/*`).

## 7. Error handling

Consistent envelope `{ error: "..." }`:
- 401 invalid/expired key or bad JWT; 403 out-of-scope; 429 rate/budget (with `Retry-After`);
  503 `{configured:false}` unset upstream or budget-capped upstream.
- Upstream failure → 502 `{ error: "upstream" }` — no provider detail leaked.
- D1 failure → 500 generic; server-side log uses `keyId`, never the key.
- All upstream calls timeout-guarded (existing `venice.js` pattern) — gateway never hangs.

## 8. Security requirements (carried from planning doc, NON-NEGOTIABLE)

1. Upstream secrets server-only; never in client bundle, response, or log.
2. VF keys hashed at rest (SHA-256); plaintext once at issuance.
3. Scoped keys; out-of-scope calls rejected 403.
4. Per-key rate limit + global upstream budget cap.
5. Non-custodial preserved: unsigned XDR out, signing on-device, `/submit` deposit-only
   (`assertVaultDeposit`).
6. No secret in logs (key id + usage only).
7. SEP-10 verification checks BOTH signatures, timebounds, home/web_auth domain (SIWE-class
   replay/phishing checklist).

## 9. Testing

- **Unit (TDD per module):** keystore (issue stores hash not plaintext; verify; revoke),
  `_vfauth` (valid/expired/revoked/out-of-scope/malformed header), rate limit (trips at
  limit+1, resets next window, global budget), SEP-10 verify (valid challenge, wrong
  signature, expired timebounds, wrong domain).
- **Integration per endpoint:** 200 with valid key, 401 without, 403 wrong scope, 429 past
  limit; assert response contains NO upstream secret substrings.
- **D1 in tests:** in-memory stub with the same `prepare/bind/run/first` interface — no
  miniflare; existing vitest setup unchanged.
- **Post-deploy smoke script:** issue test key → `/prices` + `/eligibility` → 200; bad key →
  401; loop to 429.

## 10. Sequencing & risk (13 days to 15 Jul)

Wallet-classic Tasks 7-11 still pending in parallel. Proposed order:
1. Gateway core T1-T4 (keystore, _vfauth, upstream clients, endpoints, rate limit) — ~4 days TDD.
2. Portal page + SEP-10 — ~1.5 days.
3. Client swap (`vfClient` + `VITE_VF_API_KEY`) + smoke — ~1 day.
4. Remaining ~6 days: wallet-classic 7-11 + demo polish.

**Fallback ladder** if time runs short: portal + `/prices` + `/eligibility` + `/scan` alone
already demo the composability story; `/strategy` + `/build-tx` + `/simulate` + `/submit`
can land after. Gateway work touches no wallet files — parallelizable.

## 11. Out of scope (unchanged from planning doc)

- On-chain metered billing / token-gated access (Fradium-style) — design later.
- Multi-tenant orgs, per-endpoint pricing tiers.
- Mainnet upstreams with real funds (testnet/dev-grade until audit).
- CRC32 key checksum; Cloudflare AI Gateway layer (post-hackathon enhancement, Approach C).
- Email/OAuth portal auth.
